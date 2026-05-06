//! `perp-mapping` account: per-slab `viewing_pub_hash → user_idx` table.
//! PRD-36 §5.2.2.
//!
//! One account per slab (per market). Stored as a fixed-size sorted array.
//! Sorted prefix of length `entry_count` enables O(log N) lookup; new
//! entries are inserted at the correct sorted position, preserving the
//! invariant.
//!
//! Closed slots (after `WithdrawCollateral` of the entire balance and the
//! user's exit) keep their entries but flip the `FLAG_CLOSED` bit. Lookup
//! filters them out, allocator can reuse the slot. This avoids shifting the
//! entire suffix on close, at the cost of mapping-table fragmentation if a
//! user opens-and-closes many times. Acceptable until v2 introduces a
//! compaction crank.

use crate::pda::{ViewingPubHash, VIEWING_PUB_HASH_LEN};

/// Maximum unique shielded users per slab. Half percolator's `MAX_ACCOUNTS`
/// medium tier (4096), so the mapping account fits comfortably under
/// 100 KB and rent stays under 0.6 SOL per market. Reconsider if a real
/// market exceeds this.
pub const MAX_ENTRIES: usize = 2048;

/// Bit set in `flags` when the user has exited the slot (closed position +
/// withdrawn all collateral). Closed entries are skipped on lookup; the
/// underlying slab slot is treated as free by the allocator.
pub const FLAG_CLOSED: u16 = 1 << 0;

/// Per-entry size: 32 (hash) + 2 (user_idx) + 2 (flags) + 4 (pad) = 40 B.
/// Padded to 8-byte alignment to keep the array layout predictable.
pub const ENTRY_SIZE: usize = 40;

/// Header size: 1 + 7 (pad) + 32 (slab) + 2 + 2 + 4 (pad) = 48 B.
pub const HEADER_SIZE: usize = 48;

/// Total account size: 48 + 2048 * 40 = 81,968 B ≈ 80 KB.
pub const PERP_MAPPING_ACCOUNT_LEN: usize = HEADER_SIZE + MAX_ENTRIES * ENTRY_SIZE;

/// Outcome of an allocator call.
#[derive(Debug, PartialEq, Eq)]
pub enum AllocateOutcome {
    /// Existing live entry — caller should reuse the slot.
    Existing { user_idx: u16 },
    /// First time: caller must drive percolator's `InitUser` and write the
    /// returned `user_idx` back via `record_init`.
    NewSlotNeeded,
    /// A previously-closed entry can be reused. Caller can either reuse the
    /// `user_idx` (if percolator's slot is also free) or call InitUser
    /// again — the allocator clears the FLAG_CLOSED bit on `record_init`.
    PrevClosed { user_idx: u16 },
}

#[derive(Debug, PartialEq, Eq)]
pub enum MappingError {
    Full,
    NotFound,
    BadDiscriminant,
    SlabMismatch,
    InvariantBroken,
}

/// In-memory view of the mapping account. The on-chain account is stored
/// as a flat byte buffer; helpers here read/write through `&mut [u8]`
/// with size + alignment checks. v1 keeps this simple; the next
/// optimization is bytemuck-zero-copy.
pub struct PerpMapping<'a> {
    bytes: &'a mut [u8],
}

/// Read-only counterpart for lookups during account-not-writable contexts.
pub struct PerpMappingRead<'a> {
    bytes: &'a [u8],
}

impl<'a> PerpMapping<'a> {
    pub fn from_bytes(bytes: &'a mut [u8]) -> Result<Self, MappingError> {
        if bytes.len() != PERP_MAPPING_ACCOUNT_LEN {
            return Err(MappingError::InvariantBroken);
        }
        Ok(Self { bytes })
    }

    pub fn slab(&self) -> [u8; 32] {
        let mut out = [0u8; 32];
        out.copy_from_slice(&self.bytes[8..40]);
        out
    }

    pub fn entry_count(&self) -> u16 {
        u16::from_le_bytes(self.bytes[42..44].try_into().unwrap())
    }

    pub fn next_free_idx_hint(&self) -> u16 {
        u16::from_le_bytes(self.bytes[40..42].try_into().unwrap())
    }

    fn set_entry_count(&mut self, count: u16) {
        self.bytes[42..44].copy_from_slice(&count.to_le_bytes());
    }

    fn set_next_free_idx_hint(&mut self, idx: u16) {
        self.bytes[40..42].copy_from_slice(&idx.to_le_bytes());
    }

    fn entry_offset(idx: usize) -> usize {
        HEADER_SIZE + idx * ENTRY_SIZE
    }

    fn read_entry(&self, idx: usize) -> EntryView {
        let base = Self::entry_offset(idx);
        let mut hash = [0u8; VIEWING_PUB_HASH_LEN];
        hash.copy_from_slice(&self.bytes[base..base + VIEWING_PUB_HASH_LEN]);
        let user_idx = u16::from_le_bytes(
            self.bytes[base + 32..base + 34].try_into().unwrap(),
        );
        let flags = u16::from_le_bytes(
            self.bytes[base + 34..base + 36].try_into().unwrap(),
        );
        EntryView { hash, user_idx, flags }
    }

    fn write_entry(&mut self, idx: usize, entry: &EntryView) {
        let base = Self::entry_offset(idx);
        self.bytes[base..base + VIEWING_PUB_HASH_LEN].copy_from_slice(&entry.hash);
        self.bytes[base + 32..base + 34]
            .copy_from_slice(&entry.user_idx.to_le_bytes());
        self.bytes[base + 34..base + 36]
            .copy_from_slice(&entry.flags.to_le_bytes());
        self.bytes[base + 36..base + 40].fill(0);
    }

    /// Initialize a fresh mapping account. Idempotent: if header.slab is
    /// already set to `slab`, returns Ok without changing anything.
    pub fn initialize(&mut self, slab: &[u8; 32], bump: u8) -> Result<(), MappingError> {
        let existing_slab = self.slab();
        let zero = [0u8; 32];
        if existing_slab == zero {
            // First init.
            self.bytes[0] = bump;
            self.bytes[1..8].fill(0);
            self.bytes[8..40].copy_from_slice(slab);
            self.set_next_free_idx_hint(0);
            self.set_entry_count(0);
            self.bytes[44..48].fill(0);
            Ok(())
        } else if &existing_slab == slab {
            Ok(())
        } else {
            Err(MappingError::SlabMismatch)
        }
    }

    /// Look up `viewing_pub_hash` and decide what the caller should do.
    pub fn allocate(&self, hash: &ViewingPubHash) -> AllocateOutcome {
        match self.binary_search(hash) {
            Ok(pos) => {
                let e = self.read_entry(pos);
                if e.flags & FLAG_CLOSED != 0 {
                    AllocateOutcome::PrevClosed { user_idx: e.user_idx }
                } else {
                    AllocateOutcome::Existing { user_idx: e.user_idx }
                }
            }
            Err(_) => AllocateOutcome::NewSlotNeeded,
        }
    }

    /// Record a freshly-allocated `user_idx` after percolator's `InitUser`
    /// returned. Inserts (or reactivates) the entry, preserving the sorted
    /// invariant.
    pub fn record_init(
        &mut self,
        hash: &ViewingPubHash,
        user_idx: u16,
    ) -> Result<(), MappingError> {
        match self.binary_search(hash) {
            Ok(pos) => {
                // Reactivate a closed entry, or overwrite a stale one.
                let mut e = self.read_entry(pos);
                e.flags &= !FLAG_CLOSED;
                e.user_idx = user_idx;
                self.write_entry(pos, &e);
                Ok(())
            }
            Err(insert_at) => {
                let count = self.entry_count() as usize;
                if count >= MAX_ENTRIES {
                    return Err(MappingError::Full);
                }
                // Shift suffix right by one entry to make room at insert_at.
                for src in (insert_at..count).rev() {
                    let e = self.read_entry(src);
                    self.write_entry(src + 1, &e);
                }
                self.write_entry(insert_at, &EntryView {
                    hash: *hash,
                    user_idx,
                    flags: 0,
                });
                self.set_entry_count((count + 1) as u16);
                self.set_next_free_idx_hint(user_idx.saturating_add(1));
                Ok(())
            }
        }
    }

    /// Mark a user's slot as closed. Invariant: hash MUST exist.
    pub fn record_close(&mut self, hash: &ViewingPubHash) -> Result<u16, MappingError> {
        let pos = self.binary_search(hash).map_err(|_| MappingError::NotFound)?;
        let mut e = self.read_entry(pos);
        e.flags |= FLAG_CLOSED;
        self.write_entry(pos, &e);
        Ok(e.user_idx)
    }

    /// Binary search the sorted prefix. Returns Ok(pos) on hit (live or
    /// closed), Err(insert_at) on miss.
    pub fn binary_search(&self, hash: &ViewingPubHash) -> Result<usize, usize> {
        let count = self.entry_count() as usize;
        let mut lo = 0usize;
        let mut hi = count;
        while lo < hi {
            let mid = lo + (hi - lo) / 2;
            let e = self.read_entry(mid);
            match e.hash.as_slice().cmp(hash.as_slice()) {
                std::cmp::Ordering::Less => lo = mid + 1,
                std::cmp::Ordering::Greater => hi = mid,
                std::cmp::Ordering::Equal => return Ok(mid),
            }
        }
        Err(lo)
    }
}

impl<'a> PerpMappingRead<'a> {
    pub fn from_bytes(bytes: &'a [u8]) -> Result<Self, MappingError> {
        if bytes.len() != PERP_MAPPING_ACCOUNT_LEN {
            return Err(MappingError::InvariantBroken);
        }
        Ok(Self { bytes })
    }

    pub fn lookup(&self, hash: &ViewingPubHash) -> Option<u16> {
        let bytes_view = &self.bytes;
        let count = u16::from_le_bytes(bytes_view[42..44].try_into().unwrap()) as usize;
        let mut lo = 0usize;
        let mut hi = count;
        while lo < hi {
            let mid = lo + (hi - lo) / 2;
            let base = HEADER_SIZE + mid * ENTRY_SIZE;
            let mid_hash = &bytes_view[base..base + VIEWING_PUB_HASH_LEN];
            match mid_hash.cmp(hash.as_slice()) {
                std::cmp::Ordering::Less => lo = mid + 1,
                std::cmp::Ordering::Greater => hi = mid,
                std::cmp::Ordering::Equal => {
                    let flags = u16::from_le_bytes(
                        bytes_view[base + 34..base + 36].try_into().unwrap(),
                    );
                    if flags & FLAG_CLOSED != 0 {
                        return None;
                    }
                    let user_idx = u16::from_le_bytes(
                        bytes_view[base + 32..base + 34].try_into().unwrap(),
                    );
                    return Some(user_idx);
                }
            }
        }
        None
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct EntryView {
    hash: ViewingPubHash,
    user_idx: u16,
    flags: u16,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fresh_buf() -> Vec<u8> {
        vec![0u8; PERP_MAPPING_ACCOUNT_LEN]
    }

    fn slab_pk() -> [u8; 32] {
        let mut s = [0u8; 32];
        for (i, b) in s.iter_mut().enumerate() {
            *b = i as u8;
        }
        s
    }

    fn h(seed: u8) -> ViewingPubHash {
        let mut h = [0u8; 32];
        h[31] = seed;
        h
    }

    #[test]
    fn initialize_idempotent() {
        let mut buf = fresh_buf();
        {
            let mut m = PerpMapping::from_bytes(&mut buf).unwrap();
            m.initialize(&slab_pk(), 254).unwrap();
        }
        {
            let mut m = PerpMapping::from_bytes(&mut buf).unwrap();
            // Second call with same slab is OK
            m.initialize(&slab_pk(), 254).unwrap();
            assert_eq!(m.slab(), slab_pk());
            assert_eq!(m.entry_count(), 0);
        }
    }

    #[test]
    fn initialize_rejects_slab_mismatch() {
        let mut buf = fresh_buf();
        let mut m = PerpMapping::from_bytes(&mut buf).unwrap();
        m.initialize(&slab_pk(), 0).unwrap();
        let mut other = slab_pk();
        other[0] = 0xff;
        assert_eq!(m.initialize(&other, 0), Err(MappingError::SlabMismatch));
    }

    #[test]
    fn allocate_first_returns_new_slot_needed() {
        let mut buf = fresh_buf();
        let mut m = PerpMapping::from_bytes(&mut buf).unwrap();
        m.initialize(&slab_pk(), 0).unwrap();
        assert_eq!(m.allocate(&h(7)), AllocateOutcome::NewSlotNeeded);
    }

    #[test]
    fn record_init_then_allocate_returns_existing() {
        let mut buf = fresh_buf();
        let mut m = PerpMapping::from_bytes(&mut buf).unwrap();
        m.initialize(&slab_pk(), 0).unwrap();
        m.record_init(&h(7), 42).unwrap();
        assert_eq!(m.allocate(&h(7)), AllocateOutcome::Existing { user_idx: 42 });
    }

    #[test]
    fn record_close_marks_closed_and_skips_in_lookup() {
        let mut buf = fresh_buf();
        let mut m = PerpMapping::from_bytes(&mut buf).unwrap();
        m.initialize(&slab_pk(), 0).unwrap();
        m.record_init(&h(7), 42).unwrap();
        let returned = m.record_close(&h(7)).unwrap();
        assert_eq!(returned, 42);
        assert_eq!(m.allocate(&h(7)), AllocateOutcome::PrevClosed { user_idx: 42 });
        // Read-only view returns None for closed entries.
        let read = PerpMappingRead::from_bytes(&buf).unwrap();
        assert_eq!(read.lookup(&h(7)), None);
    }

    #[test]
    fn record_close_unknown_returns_not_found() {
        let mut buf = fresh_buf();
        let mut m = PerpMapping::from_bytes(&mut buf).unwrap();
        m.initialize(&slab_pk(), 0).unwrap();
        assert_eq!(m.record_close(&h(7)), Err(MappingError::NotFound));
    }

    #[test]
    fn many_inserts_remain_sorted() {
        let mut buf = fresh_buf();
        let mut m = PerpMapping::from_bytes(&mut buf).unwrap();
        m.initialize(&slab_pk(), 0).unwrap();
        // Insert in reverse order; verify sorted invariant after each.
        for k in (0u8..20).rev() {
            m.record_init(&h(k), k as u16).unwrap();
            // Walk the prefix and confirm strict ordering.
            let count = m.entry_count() as usize;
            for i in 1..count {
                let prev = m.read_entry(i - 1);
                let cur = m.read_entry(i);
                assert!(
                    prev.hash.as_slice() < cur.hash.as_slice(),
                    "out of order at i={i}: prev={prev:?} cur={cur:?}"
                );
            }
        }
        // Each is findable + correct user_idx
        for k in 0u8..20 {
            assert_eq!(
                m.allocate(&h(k)),
                AllocateOutcome::Existing { user_idx: k as u16 },
            );
        }
    }

    #[test]
    fn full_table_rejects_new_insert() {
        let mut buf = fresh_buf();
        let mut m = PerpMapping::from_bytes(&mut buf).unwrap();
        m.initialize(&slab_pk(), 0).unwrap();
        for k in 0..MAX_ENTRIES {
            // Distinct hash per entry — encode k in last 8 bytes.
            let mut hash = [0u8; 32];
            hash[24..32].copy_from_slice(&(k as u64).to_be_bytes());
            m.record_init(&hash, k as u16).unwrap();
        }
        // One more than the cap.
        let mut overflow_hash = [0u8; 32];
        overflow_hash[24..32].copy_from_slice(&(MAX_ENTRIES as u64).to_be_bytes());
        assert_eq!(
            m.record_init(&overflow_hash, 9999),
            Err(MappingError::Full),
        );
    }

    #[test]
    fn next_free_idx_hint_advances() {
        let mut buf = fresh_buf();
        let mut m = PerpMapping::from_bytes(&mut buf).unwrap();
        m.initialize(&slab_pk(), 0).unwrap();
        m.record_init(&h(1), 0).unwrap();
        assert_eq!(m.next_free_idx_hint(), 1);
        m.record_init(&h(2), 7).unwrap();
        assert_eq!(m.next_free_idx_hint(), 8);
    }

    #[test]
    fn account_size_constant_matches_layout() {
        // Sanity: HEADER_SIZE + MAX_ENTRIES * ENTRY_SIZE == PERP_MAPPING_ACCOUNT_LEN
        assert_eq!(
            HEADER_SIZE + MAX_ENTRIES * ENTRY_SIZE,
            PERP_MAPPING_ACCOUNT_LEN,
        );
    }
}

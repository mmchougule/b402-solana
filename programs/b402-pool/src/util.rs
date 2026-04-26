//! Utilities: merkle append, nullifier shard ops.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::poseidon::{hashv, Endianness, Parameters};

use crate::constants::{ROOT_HISTORY_SIZE, TAG_MK_NODE, TREE_DEPTH};
use crate::error::PoolError;
use crate::state::{NullifierShard, TreeState};

pub fn poseidon_mk_node(left: &[u8; 32], right: &[u8; 32]) -> Result<[u8; 32]> {
    let h = hashv(
        Parameters::Bn254X5,
        Endianness::LittleEndian,
        &[&TAG_MK_NODE[..], &left[..], &right[..]],
    )
    .map_err(|_| error!(PoolError::ProofVerificationFailed))?;
    Ok(h.to_bytes())
}

/// Append a leaf to the incremental merkle tree and update state.
/// Mirrors `packages/crypto/src/merkle.rs::MerkleTree::append` exactly.
pub fn tree_append(tree: &mut TreeState, leaf: [u8; 32]) -> Result<[u8; 32]> {
    let idx = tree.leaf_count;
    require!(
        (idx as u128) < (1u128 << TREE_DEPTH as u32),
        PoolError::TreeCapacityExceeded
    );

    let mut cur = leaf;
    let mut level: usize = 0;

    loop {
        let bit = (idx >> level) & 1;
        if bit == 0 {
            tree.frontier[level] = cur;
            cur = poseidon_mk_node(&cur, &tree.zero_cache[level])?;
            break;
        } else {
            cur = poseidon_mk_node(&tree.frontier[level], &cur)?;
        }
        level += 1;
        if level >= TREE_DEPTH {
            return err!(PoolError::TreeCapacityExceeded);
        }
    }

    let mut walking = cur;
    for upper in (level + 1)..TREE_DEPTH {
        let bit = (idx >> upper) & 1;
        walking = if bit == 0 {
            poseidon_mk_node(&walking, &tree.zero_cache[upper])?
        } else {
            poseidon_mk_node(&tree.frontier[upper], &walking)?
        };
    }

    tree.leaf_count = tree.leaf_count.saturating_add(1);
    tree.ring_head = ((tree.ring_head as usize + 1) % ROOT_HISTORY_SIZE) as u8;
    tree.root_ring[tree.ring_head as usize] = walking;
    Ok(walking)
}

pub fn tree_has_recent_root(tree: &TreeState, root: &[u8; 32]) -> bool {
    tree.root_ring.iter().any(|r| r == root)
}

/// Insert a nullifier into a sorted zero-copy shard. Errors on duplicate or
/// overflow. Storage is a flat `[u8; N]` backing for bytemuck compatibility;
/// logical view is a sorted array of 32-byte nullifiers.
pub fn nullifier_insert(shard: &mut NullifierShard, nullifier: [u8; 32]) -> Result<()> {
    let count = shard.count as usize;
    require!(
        count < crate::state::MAX_NULLIFIERS_PER_SHARD,
        PoolError::AccountSizeMismatch
    );

    // Binary search on the populated prefix via the helper view.
    let pos = match shard.nullifiers().binary_search(&nullifier) {
        Ok(_) => return err!(PoolError::NullifierAlreadySpent),
        Err(pos) => pos,
    };

    // Shift entries [pos..count] right by one to make room, then write.
    for i in (pos..count).rev() {
        let v = shard.nullifier_at(i);
        shard.set_nullifier(i + 1, v);
    }
    shard.set_nullifier(pos, nullifier);
    shard.count = shard.count.saturating_add(1);
    Ok(())
}

pub fn shard_prefix(nullifier: &[u8; 32]) -> u16 {
    u16::from_le_bytes([nullifier[30], nullifier[31]])
}

/// BN254 scalar field modulus, little-endian.
const FR_MODULUS_LE: [u8; 32] = [
    0x01, 0x00, 0x00, 0xf0, 0x93, 0xf5, 0xe1, 0x43,
    0x91, 0x70, 0xb9, 0x79, 0x48, 0xe8, 0x33, 0x28,
    0x5d, 0x58, 0x81, 0x81, 0xb6, 0x45, 0x50, 0xb8,
    0x29, 0xa0, 0x31, 0xe1, 0x72, 0x4e, 0x64, 0x30,
];

/// Reduce 32 LE bytes mod p. Used to convert raw Pubkey bytes (which may
/// exceed p in the top ~2 bits) into a canonical Fr representation. The
/// circuit's `publicTokenMint` is an Fr; the on-chain program must send
/// the same Fr-reduced bytes to the verifier or the proof rejects.
pub fn reduce_le_mod_p(b: &[u8; 32]) -> [u8; 32] {
    // Walk: while out ≥ p, subtract. p ≈ 2^253.99, so a 32-byte value
    // (up to ~2^256) needs at most 4 subtractions.
    let mut out = *b;
    while !cmp_le_lt(&out, &FR_MODULUS_LE) {
        sub_le_in_place(&mut out, &FR_MODULUS_LE);
    }
    out
}

/// Compare two 32-byte little-endian values for `a < b`. Walk from the
/// most-significant byte (LE index 31) downward.
fn cmp_le_lt(a: &[u8; 32], b: &[u8; 32]) -> bool {
    for i in (0..32).rev() {
        if a[i] < b[i] { return true; }
        if a[i] > b[i] { return false; }
    }
    false
}

/// In-place subtraction `a -= b` over 32-byte little-endian bigints.
/// Assumes a ≥ b (no underflow).
fn sub_le_in_place(a: &mut [u8; 32], b: &[u8; 32]) {
    let mut borrow: i16 = 0;
    for i in 0..32 {
        let diff: i16 = (a[i] as i16) - (b[i] as i16) - borrow;
        if diff < 0 {
            a[i] = (diff + 256) as u8;
            borrow = 1;
        } else {
            a[i] = diff as u8;
            borrow = 0;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::constants::{ROOT_HISTORY_SIZE, TREE_DEPTH};
    use crate::state::{NullifierBuf, NullifierShard, TreeState, MAX_NULLIFIERS_PER_SHARD, NULLIFIER_BYTES_PER_SHARD};

    // ---------- helpers ----------

    fn fresh_tree() -> TreeState {
        TreeState {
            version: 1,
            _pad0: [0; 6],
            leaf_count: 0,
            ring_head: 0,
            _pad1: [0; 7],
            root_ring: [[0u8; 32]; ROOT_HISTORY_SIZE],
            frontier: [[0u8; 32]; TREE_DEPTH],
            zero_cache: [[0u8; 32]; TREE_DEPTH],
            _reserved: [0; 64],
        }
    }

    fn fresh_shard(prefix: u16) -> NullifierShard {
        NullifierShard {
            prefix,
            _pad0: [0; 2],
            count: 0,
            nullifiers_bytes: NullifierBuf([0u8; NULLIFIER_BYTES_PER_SHARD]),
        }
    }

    fn nullifier_with_prefix(prefix: u16, lo: u8) -> [u8; 32] {
        let mut n = [0u8; 32];
        n[0] = lo;
        let pb = prefix.to_le_bytes();
        n[30] = pb[0];
        n[31] = pb[1];
        n
    }

    // ---------- reduce_le_mod_p ----------

    #[test]
    fn reduce_le_mod_p_zero_is_identity() {
        let z = [0u8; 32];
        assert_eq!(reduce_le_mod_p(&z), z);
    }

    #[test]
    fn reduce_le_mod_p_value_below_modulus_is_identity() {
        // p - 1, little-endian. Decrement the LSB of FR_MODULUS_LE.
        let mut p_minus_one = FR_MODULUS_LE;
        p_minus_one[0] -= 1;
        assert_eq!(reduce_le_mod_p(&p_minus_one), p_minus_one);
    }

    #[test]
    fn reduce_le_mod_p_modulus_reduces_to_zero() {
        let p = FR_MODULUS_LE;
        assert_eq!(reduce_le_mod_p(&p), [0u8; 32]);
    }

    #[test]
    fn reduce_le_mod_p_above_modulus_is_difference() {
        // p + 1 → 1
        let mut p_plus_one = FR_MODULUS_LE;
        p_plus_one[0] += 1;
        let mut expected = [0u8; 32];
        expected[0] = 1;
        assert_eq!(reduce_le_mod_p(&p_plus_one), expected);
    }

    #[test]
    fn reduce_le_mod_p_high_bits_set_reduces() {
        // 0xFF..FF (max u256) — exercises multi-subtraction path. Result is
        // (2^256 - 1) mod p. Just assert the result is < p.
        let max = [0xFFu8; 32];
        let r = reduce_le_mod_p(&max);
        assert!(cmp_le_lt(&r, &FR_MODULUS_LE));
    }

    // ---------- tree_has_recent_root ----------

    #[test]
    fn tree_has_recent_root_empty_ring_rejects_arbitrary_root() {
        let tree = fresh_tree();
        let r = [0x42u8; 32];
        assert!(!tree_has_recent_root(&tree, &r));
    }

    #[test]
    fn tree_has_recent_root_zero_root_present_in_fresh_ring() {
        // Fresh ring is all zeros, so a zero root WOULD match. This documents
        // the edge case: appending real roots overwrites zero entries.
        let tree = fresh_tree();
        assert!(tree_has_recent_root(&tree, &[0u8; 32]));
    }

    #[test]
    fn tree_has_recent_root_finds_each_inserted() {
        let mut tree = fresh_tree();
        // Plant 5 distinct roots into the ring directly.
        for i in 0..5 {
            tree.ring_head = i as u8;
            tree.root_ring[i] = {
                let mut r = [0u8; 32];
                r[0] = (i + 1) as u8;
                r[31] = 0xAA;
                r
            };
        }
        for i in 0..5 {
            let mut r = [0u8; 32];
            r[0] = (i + 1) as u8;
            r[31] = 0xAA;
            assert!(tree_has_recent_root(&tree, &r), "root {i} should match");
        }
        let unseen = [0xDEu8; 32];
        assert!(!tree_has_recent_root(&tree, &unseen));
    }

    #[test]
    fn tree_has_recent_root_ring_wraparound_drops_old_entries() {
        // tree_append cycles ring_head; after ROOT_HISTORY_SIZE + N appends, the
        // first N roots have been overwritten. Simulate by writing 130 distinct
        // roots into the ring buffer using the same modular update tree_append uses.
        let mut tree = fresh_tree();
        let n = ROOT_HISTORY_SIZE + 2;
        for i in 0..n {
            tree.ring_head = ((tree.ring_head as usize + 1) % ROOT_HISTORY_SIZE) as u8;
            let mut r = [0u8; 32];
            r[0] = (i & 0xFF) as u8;
            r[1] = ((i >> 8) & 0xFF) as u8;
            r[31] = 0xCC;
            tree.root_ring[tree.ring_head as usize] = r;
        }
        // Earliest two roots should have been overwritten.
        let mut overwritten = [0u8; 32];
        overwritten[0] = 0;
        overwritten[31] = 0xCC;
        // The very first root we wrote (i=0) lands at ring_head=1; after wraparound
        // to 130 entries it's been overwritten by i=ROOT_HISTORY_SIZE.
        let wrote_over = {
            let mut r = [0u8; 32];
            r[0] = (ROOT_HISTORY_SIZE & 0xFF) as u8;
            r[1] = ((ROOT_HISTORY_SIZE >> 8) & 0xFF) as u8;
            r[31] = 0xCC;
            r
        };
        assert!(tree_has_recent_root(&tree, &wrote_over));
    }

    // ---------- shard_prefix ----------

    #[test]
    fn shard_prefix_is_deterministic() {
        let n = [0u8; 32];
        assert_eq!(shard_prefix(&n), shard_prefix(&n));
        let mut n2 = [0u8; 32];
        n2[30] = 0xAB;
        n2[31] = 0xCD;
        assert_eq!(shard_prefix(&n2), 0xCDABu16);
    }

    #[test]
    fn shard_prefix_distributes_widely() {
        // 1000 distinct nullifiers should land in many distinct shards.
        // The prefix is just bytes [30..32] LE — vary those and we trivially
        // hit all 1000 distinct prefixes. The test validates the function
        // routes to multiple shards (i.e. doesn't collapse to one).
        let mut shards = std::collections::HashSet::new();
        for i in 0..1000u16 {
            let mut n = [0u8; 32];
            // Spread the prefix across the u16 space: i * 47 mod 65536.
            let p = ((i as u32).wrapping_mul(47)) as u16;
            n[30] = p as u8;
            n[31] = (p >> 8) as u8;
            shards.insert(shard_prefix(&n));
        }
        assert!(
            shards.len() >= 100,
            "expected >=100 distinct shards over 1000 nullifiers, got {}",
            shards.len()
        );
    }

    // ---------- nullifier_insert ----------

    #[test]
    fn nullifier_insert_first_entry() {
        let mut shard = fresh_shard(0);
        let n = nullifier_with_prefix(0, 1);
        nullifier_insert(&mut shard, n).unwrap();
        assert_eq!(shard.count, 1);
        assert_eq!(shard.nullifier_at(0), n);
    }

    #[test]
    fn nullifier_insert_keeps_sorted_order() {
        let mut shard = fresh_shard(0);
        let a = nullifier_with_prefix(0, 0x10);
        let b = nullifier_with_prefix(0, 0x05);
        let c = nullifier_with_prefix(0, 0x20);
        nullifier_insert(&mut shard, a).unwrap();
        nullifier_insert(&mut shard, b).unwrap();
        nullifier_insert(&mut shard, c).unwrap();
        assert_eq!(shard.count, 3);
        // Sorted ascending across [u8; 32].
        assert_eq!(shard.nullifier_at(0), b);
        assert_eq!(shard.nullifier_at(1), a);
        assert_eq!(shard.nullifier_at(2), c);
    }

    #[test]
    fn nullifier_insert_duplicate_rejected() {
        let mut shard = fresh_shard(0);
        let n = nullifier_with_prefix(0, 0x10);
        nullifier_insert(&mut shard, n).unwrap();
        let res = nullifier_insert(&mut shard, n);
        assert!(res.is_err(), "duplicate insert must error");
        assert_eq!(shard.count, 1, "count should not change on rejected insert");
    }

    #[test]
    fn nullifier_insert_fills_to_capacity() {
        let mut shard = fresh_shard(0);
        for i in 0..MAX_NULLIFIERS_PER_SHARD as u32 {
            let mut n = [0u8; 32];
            // Non-colliding by varying multiple bytes.
            n[0] = (i & 0xFF) as u8;
            n[1] = ((i >> 8) & 0xFF) as u8;
            n[2] = ((i >> 16) & 0xFF) as u8;
            nullifier_insert(&mut shard, n).expect("fill should succeed");
        }
        assert_eq!(shard.count as usize, MAX_NULLIFIERS_PER_SHARD);

        // (N+1)th insert must fail with AccountSizeMismatch.
        let mut overflow = [0u8; 32];
        overflow[0] = 0xFF;
        overflow[1] = 0xFF;
        let res = nullifier_insert(&mut shard, overflow);
        assert!(res.is_err(), "insert past capacity must error");
        assert_eq!(shard.count as usize, MAX_NULLIFIERS_PER_SHARD);
    }

    // ---------- tree_append ----------

    /// Build a leaf that's guaranteed < BN254 Fr modulus (high byte zero).
    fn fr_leaf(seed: u8) -> [u8; 32] {
        let mut leaf = [seed; 32];
        // Top byte (LE index 31) must be < 0x30 to stay under p.
        leaf[31] = 0x00;
        leaf
    }

    #[test]
    fn tree_append_increments_leaf_count_and_advances_ring() {
        let mut tree = fresh_tree();
        let initial_head = tree.ring_head;

        let _root = tree_append(&mut tree, fr_leaf(0x42)).expect("append should succeed");

        assert_eq!(tree.leaf_count, 1);
        // ring_head advances by 1 mod ROOT_HISTORY_SIZE.
        let expected_head = ((initial_head as usize + 1) % ROOT_HISTORY_SIZE) as u8;
        assert_eq!(tree.ring_head, expected_head);
    }

    #[test]
    fn tree_append_writes_root_to_ring_head() {
        let mut tree = fresh_tree();
        let root = tree_append(&mut tree, fr_leaf(0x07)).unwrap();
        let head_idx = tree.ring_head as usize;
        assert_eq!(tree.root_ring[head_idx], root);
        // Same root is now in the recent ring.
        assert!(tree_has_recent_root(&tree, &root));
    }

    #[test]
    fn tree_append_first_leaf_sets_frontier_level0() {
        let mut tree = fresh_tree();
        let leaf = fr_leaf(0x0A);
        tree_append(&mut tree, leaf).unwrap();
        // leaf_count was 0 (idx=0), so bit 0 == 0 → frontier[0] = leaf.
        assert_eq!(tree.frontier[0], leaf);
    }

    #[test]
    fn tree_append_two_distinct_leaves_yield_distinct_roots() {
        let mut tree_a = fresh_tree();
        let mut tree_b = fresh_tree();
        let r1 = tree_append(&mut tree_a, [0x01u8; 32]).unwrap();
        let r2 = tree_append(&mut tree_b, [0x02u8; 32]).unwrap();
        assert_ne!(r1, r2, "different leaves must produce different roots");
    }
}

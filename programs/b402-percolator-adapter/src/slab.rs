//! Slab data parsing for b402-percolator-adapter.
//!
//! `percolator-prog` lays out the slab account as:
//!   ```text
//!   [SlabHeader][MarketConfig][pad to ENGINE_ALIGN][RiskEngine][RiskBuffer][gen_table]
//!   ```
//!
//! `RiskEngine` (defined in the upstream `percolator` lib, pulled in as a
//! pinned git dep above) contains the `accounts: [Account; MAX_ACCOUNTS]`
//! table where each entry's `owner: [u8; 32]` is the slot's user pubkey.
//!
//! This module reads two pieces from a slab account at runtime:
//!
//! 1. `MarketConfig.collateral_mint` and `vault_authority_bump` — the
//!    mint we move USDC in, and the bump for percolator's vault PDA.
//! 2. The `Account` table, indexed by `user_idx`, exposing:
//!    - `owner` — to find a freshly-allocated slot post-`InitUser` and
//!      to verify a stale mapping entry's slot still belongs to us
//!    - `position_basis_q` — to compute the close-side `size = -current`
//!    - `capital` — to compute the close-side withdraw amount
//!
//! `SlabHeader` and `MarketConfig` are vendored here as bytemuck-Pod
//! struct definitions because they live in `percolator-prog` (a cdylib)
//! rather than in the `percolator` lib. The vendored types match
//! percolator-prog at the commit pinned in PRD-36 §13. A runtime sanity
//! check on the slab `magic` field (`0x504552434f4c4154` = "PERCOLAT")
//! catches deployment-side drift if the layout changes upstream without
//! us bumping the rev.

use bytemuck::{Pod, Zeroable};
use core::mem::{align_of, offset_of, size_of};
use percolator::{Account, RiskEngine, MAX_ACCOUNTS};

/// Slab magic string. Matches percolator-prog's `pub const MAGIC: u64 = 0x504552434f4c4154`
/// (the on-disk bytes are "TALOCREP" — that's "PERCOLAT" reversed because the
/// integer is stored in native LE byte order; when we read 8 LE bytes from the
/// account back into a u64 we get this same value).
pub const SLAB_MAGIC: u64 = 0x5045_5243_4f4c_4154;

#[derive(Debug, PartialEq, Eq)]
pub enum SlabError {
    BadMagic,
    DataTooShort,
    UserIdxOutOfRange,
    OwnerNotInSlab,
}

// ─── Vendored layout types (mirror percolator-prog at pinned rev) ───────

/// Mirrors `percolator-prog::state::SlabHeader`. 136 bytes at engine
/// commit f6b13f57. Verified live against the on-chain percolator-prog
/// binary via the slice-5 fork run.
#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
struct SlabHeader {
    magic: u64,
    version: u32,
    bump: u8,
    _padding: [u8; 3],
    admin: [u8; 32],
    _reserved: [u8; 24],
    insurance_authority: [u8; 32],
    insurance_operator: [u8; 32],
}

/// Mirrors `percolator-prog::state::MarketConfig` for the fields we need.
/// We define ALL fields in stored order so `size_of::<MarketConfig>()`
/// matches the on-chain size; we only read `collateral_mint`,
/// `vault_pubkey`, and `vault_authority_bump`. Pinned at percolator-prog
/// commit a946e550. The `..._tail` byte block represents the remaining
/// MarketConfig fields we don't read.
#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
struct MarketConfigPrefix {
    collateral_mint: [u8; 32],
    vault_pubkey: [u8; 32],
    index_feed_id: [u8; 32],
    max_staleness_secs: u64,
    conf_filter_bps: u16,
    vault_authority_bump: u8,
    invert: u8,
    unit_scale: u32,
}

const HEADER_LEN: usize = size_of::<SlabHeader>();
const MARKET_CONFIG_LEN: usize = 0x180; // 384 B at percolator-prog with engine f6b13f57 — verified against percolator-prog::state::MarketConfig size_of()
const ENGINE_ALIGN: usize = align_of::<RiskEngine>();
const ENGINE_OFF: usize = align_up(HEADER_LEN + MARKET_CONFIG_LEN, ENGINE_ALIGN);

const fn align_up(x: usize, a: usize) -> usize {
    (x + (a - 1)) & !(a - 1)
}

/// Offset of `RiskEngine.accounts[0]` from the start of the slab account.
const ACCOUNTS_TABLE_OFF: usize = ENGINE_OFF + offset_of!(RiskEngine, accounts);
const ACCOUNT_SIZE: usize = size_of::<Account>();
const ACCOUNT_OWNER_OFF: usize = offset_of!(Account, owner);
const ACCOUNT_POSITION_OFF: usize = offset_of!(Account, position_basis_q);
const ACCOUNT_CAPITAL_OFF: usize = offset_of!(Account, capital);

// Compile-time pinning: if percolator changes Account layout upstream,
// the runtime test `account_layout_pinned_at_a946e550` flags it. We
// don't pin offsets in `const _` here because percolator's `U128`
// newtype alignment makes them non-trivial to derive by hand; the
// test records observed values so drift is visible in `cargo test`.

// ─── Public reads ───────────────────────────────────────────────────────

/// Verify the slab account's magic bytes match percolator's expected
/// value. Returns `BadMagic` on mismatch (deployment-side drift) or
/// `DataTooShort` if the buffer is smaller than `SlabHeader`.
pub fn verify_slab_magic(slab_data: &[u8]) -> Result<(), SlabError> {
    if slab_data.len() < HEADER_LEN {
        return Err(SlabError::DataTooShort);
    }
    let header: &SlabHeader = bytemuck::from_bytes(&slab_data[..HEADER_LEN]);
    if header.magic != SLAB_MAGIC {
        return Err(SlabError::BadMagic);
    }
    Ok(())
}

/// Read the collateral mint from the slab's `MarketConfig`.
pub fn read_collateral_mint(slab_data: &[u8]) -> Result<[u8; 32], SlabError> {
    let cfg = read_market_config(slab_data)?;
    Ok(cfg.collateral_mint)
}

/// Read the percolator vault PDA pubkey from the slab's `MarketConfig`.
pub fn read_vault_pubkey(slab_data: &[u8]) -> Result<[u8; 32], SlabError> {
    let cfg = read_market_config(slab_data)?;
    Ok(cfg.vault_pubkey)
}

/// Read the vault PDA bump from the slab's `MarketConfig`.
pub fn read_vault_authority_bump(slab_data: &[u8]) -> Result<u8, SlabError> {
    let cfg = read_market_config(slab_data)?;
    Ok(cfg.vault_authority_bump)
}

/// Find the slab slot whose `owner` equals the supplied 32-byte pubkey.
/// Returns `OwnerNotInSlab` if no slot matches. Used immediately after
/// `InitUser` to discover the assigned `user_idx` (percolator does not
/// return data) and during the stale-entry guard.
///
/// Cost: linear scan of `MAX_ACCOUNTS` entries. At default 4096, that's
/// 4096 × 32-byte memcmp ≈ 130 KB of byte comparisons. Worst-case CU is
/// well under 200 k on bench-tested SBF builds; well within the 1.4 M
/// per-ix budget after the pool's Groth16 verify (~600 k).
pub fn find_owner_in_slab(
    slab_data: &[u8],
    owner: &[u8; 32],
) -> Result<u16, SlabError> {
    if slab_data.len() < ACCOUNTS_TABLE_OFF + MAX_ACCOUNTS * ACCOUNT_SIZE {
        return Err(SlabError::DataTooShort);
    }
    for idx in 0..MAX_ACCOUNTS {
        let row_off = ACCOUNTS_TABLE_OFF + idx * ACCOUNT_SIZE;
        let owner_slice = &slab_data[row_off + ACCOUNT_OWNER_OFF..row_off + ACCOUNT_OWNER_OFF + 32];
        if owner_slice == owner.as_slice() {
            return Ok(idx as u16);
        }
    }
    Err(SlabError::OwnerNotInSlab)
}

/// Read the position basis (signed fixed-point base quantity) at
/// `slab.accounts[user_idx].position_basis_q`. Used by the close path to
/// compute the flatten-trade size as `-current_position`.
pub fn read_position_basis_q(
    slab_data: &[u8],
    user_idx: u16,
) -> Result<i128, SlabError> {
    let row_off = account_row_offset(slab_data, user_idx)?;
    let bytes = &slab_data[row_off + ACCOUNT_POSITION_OFF..row_off + ACCOUNT_POSITION_OFF + 16];
    Ok(i128::from_le_bytes(bytes.try_into().unwrap()))
}

/// Read the unsigned capital at `slab.accounts[user_idx].capital`. Used
/// by the close path to compute the WithdrawCollateral amount.
pub fn read_capital(
    slab_data: &[u8],
    user_idx: u16,
) -> Result<u128, SlabError> {
    let row_off = account_row_offset(slab_data, user_idx)?;
    let bytes = &slab_data[row_off + ACCOUNT_CAPITAL_OFF..row_off + ACCOUNT_CAPITAL_OFF + 16];
    Ok(u128::from_le_bytes(bytes.try_into().unwrap()))
}

/// Verify the owner stored at `slab.accounts[user_idx].owner` matches the
/// expected pubkey. The handler calls this after looking up `user_idx` in
/// the perp-mapping account but before assuming the slot is still ours
/// (PRD-36 §6.5 #1 — stale-entry race after percolator liquidation).
pub fn verify_owner_at_idx(
    slab_data: &[u8],
    user_idx: u16,
    expected: &[u8; 32],
) -> Result<bool, SlabError> {
    let row_off = account_row_offset(slab_data, user_idx)?;
    let owner_slice =
        &slab_data[row_off + ACCOUNT_OWNER_OFF..row_off + ACCOUNT_OWNER_OFF + 32];
    Ok(owner_slice == expected.as_slice())
}

// ─── private helpers ────────────────────────────────────────────────────

fn read_market_config(slab_data: &[u8]) -> Result<&MarketConfigPrefix, SlabError> {
    if slab_data.len() < HEADER_LEN + size_of::<MarketConfigPrefix>() {
        return Err(SlabError::DataTooShort);
    }
    let cfg_bytes = &slab_data[HEADER_LEN..HEADER_LEN + size_of::<MarketConfigPrefix>()];
    Ok(bytemuck::from_bytes(cfg_bytes))
}

fn account_row_offset(
    slab_data: &[u8],
    user_idx: u16,
) -> Result<usize, SlabError> {
    if user_idx as usize >= MAX_ACCOUNTS {
        return Err(SlabError::UserIdxOutOfRange);
    }
    let row_off = ACCOUNTS_TABLE_OFF + (user_idx as usize) * ACCOUNT_SIZE;
    if slab_data.len() < row_off + ACCOUNT_SIZE {
        return Err(SlabError::DataTooShort);
    }
    Ok(row_off)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Synthetic slab buffer big enough to hold ENGINE_OFF + MAX_ACCOUNTS
    /// rows. We only populate the fields we test against; the rest stays
    /// zero (which is also Pod-valid for Account).
    fn fixture_slab(populate: impl FnOnce(&mut [u8])) -> Vec<u8> {
        let total = ACCOUNTS_TABLE_OFF + MAX_ACCOUNTS * ACCOUNT_SIZE + 1024;
        let mut buf = vec![0u8; total];
        // SlabHeader.magic
        buf[0..8].copy_from_slice(&SLAB_MAGIC.to_le_bytes());
        populate(&mut buf);
        buf
    }

    fn write_market_config(buf: &mut [u8], mint: &[u8; 32], vault: &[u8; 32], bump: u8) {
        let cfg_off = HEADER_LEN;
        buf[cfg_off..cfg_off + 32].copy_from_slice(mint);
        buf[cfg_off + 32..cfg_off + 64].copy_from_slice(vault);
        // skip index_feed_id (32) + max_staleness (8) + conf_filter (2) — total +42
        buf[cfg_off + 32 + 32 + 32 + 8 + 2] = bump;
    }

    fn write_account_owner(buf: &mut [u8], idx: usize, owner: &[u8; 32]) {
        let row_off = ACCOUNTS_TABLE_OFF + idx * ACCOUNT_SIZE;
        buf[row_off + ACCOUNT_OWNER_OFF..row_off + ACCOUNT_OWNER_OFF + 32]
            .copy_from_slice(owner);
    }

    fn write_account_position(buf: &mut [u8], idx: usize, position: i128) {
        let row_off = ACCOUNTS_TABLE_OFF + idx * ACCOUNT_SIZE;
        buf[row_off + ACCOUNT_POSITION_OFF..row_off + ACCOUNT_POSITION_OFF + 16]
            .copy_from_slice(&position.to_le_bytes());
    }

    fn write_account_capital(buf: &mut [u8], idx: usize, capital: u128) {
        let row_off = ACCOUNTS_TABLE_OFF + idx * ACCOUNT_SIZE;
        buf[row_off + ACCOUNT_CAPITAL_OFF..row_off + ACCOUNT_CAPITAL_OFF + 16]
            .copy_from_slice(&capital.to_le_bytes());
    }

    #[test]
    fn magic_pins_to_percolator_prog() {
        // percolator-prog stores `pub const MAGIC: u64 = 0x504552434f4c4154` in
        // native (LE) byte order — the bytes on disk are "TALOCREP" ("PERCOLAT"
        // reversed). When the adapter reads those 8 bytes back as a LE u64 it
        // recovers the same integer 0x504552434f4c4154. So our SLAB_MAGIC must
        // equal that integer, NOT the byte-reversed form.
        assert_eq!(SLAB_MAGIC, 0x5045_5243_4f4c_4154_u64);
        // Bytes-on-disk view: "TALOCREP" (the BE form of "PERCOLAT").
        assert_eq!(&SLAB_MAGIC.to_le_bytes(), b"TALOCREP");
    }

    #[test]
    fn verify_magic_accepts_canonical() {
        let buf = fixture_slab(|_| {});
        verify_slab_magic(&buf).unwrap();
    }

    #[test]
    fn verify_magic_rejects_wrong() {
        let mut buf = fixture_slab(|_| {});
        buf[0] ^= 0xff;
        assert_eq!(verify_slab_magic(&buf), Err(SlabError::BadMagic));
    }

    #[test]
    fn verify_magic_rejects_short() {
        let buf = vec![0u8; 4];
        assert_eq!(verify_slab_magic(&buf), Err(SlabError::DataTooShort));
    }

    #[test]
    fn read_collateral_mint_round_trips() {
        let mint = [0xab; 32];
        let buf = fixture_slab(|b| {
            write_market_config(b, &mint, &[0; 32], 0);
        });
        assert_eq!(read_collateral_mint(&buf).unwrap(), mint);
    }

    #[test]
    fn read_vault_authority_bump_round_trips() {
        let buf = fixture_slab(|b| {
            write_market_config(b, &[0; 32], &[0; 32], 0xfe);
        });
        assert_eq!(read_vault_authority_bump(&buf).unwrap(), 0xfe);
    }

    #[test]
    fn find_owner_returns_slot() {
        let owner = [0x42; 32];
        let buf = fixture_slab(|b| write_account_owner(b, 17, &owner));
        assert_eq!(find_owner_in_slab(&buf, &owner).unwrap(), 17);
    }

    #[test]
    fn find_owner_zero_pubkey_finds_slot_zero() {
        // All slots zero by default; the zero pubkey matches slot 0.
        // Real callers won't pass a zero pubkey — owner_pda is derived
        // from a non-zero viewing_pub_hash. This pins the linear-scan
        // semantics: first match wins.
        let buf = fixture_slab(|_| {});
        assert_eq!(find_owner_in_slab(&buf, &[0u8; 32]).unwrap(), 0);
    }

    #[test]
    fn find_owner_unknown_returns_not_in_slab() {
        let buf = fixture_slab(|b| write_account_owner(b, 0, &[1u8; 32]));
        let unknown = [0xcc; 32];
        assert_eq!(
            find_owner_in_slab(&buf, &unknown),
            Err(SlabError::OwnerNotInSlab),
        );
    }

    #[test]
    fn read_position_round_trips() {
        let buf = fixture_slab(|b| write_account_position(b, 5, -1_500_000_000));
        assert_eq!(read_position_basis_q(&buf, 5).unwrap(), -1_500_000_000);
    }

    #[test]
    fn read_capital_round_trips() {
        let buf = fixture_slab(|b| write_account_capital(b, 5, 999_999_999));
        assert_eq!(read_capital(&buf, 5).unwrap(), 999_999_999);
    }

    #[test]
    fn user_idx_out_of_range_rejected() {
        let buf = fixture_slab(|_| {});
        assert_eq!(
            read_position_basis_q(&buf, MAX_ACCOUNTS as u16),
            Err(SlabError::UserIdxOutOfRange),
        );
    }

    #[test]
    fn verify_owner_at_idx_matches_when_set() {
        let owner = [0x77; 32];
        let buf = fixture_slab(|b| write_account_owner(b, 13, &owner));
        assert!(verify_owner_at_idx(&buf, 13, &owner).unwrap());
        let other = [0x88; 32];
        assert!(!verify_owner_at_idx(&buf, 13, &other).unwrap());
    }

    #[test]
    #[allow(clippy::assertions_on_constants)]
    fn account_layout_pinned_at_f6b13f57() {
        // Pinned values observed against percolator commit f6b13f57 on
        // 2026-05-06. If any upstream change shifts these, every helper
        // in this module reads the wrong bytes — flag loudly here.
        // (clippy: these are const-folded; that's the intent — the
        // test exists so a layout drift surfaces as a compile-time or
        // assertion failure, not a silent miscompute.)
        assert_eq!(ACCOUNT_OWNER_OFF, 264);
        assert_eq!(ACCOUNT_POSITION_OFF, 64);
        assert_eq!(ACCOUNT_CAPITAL_OFF, 0);
        let size_within_envelope = ACCOUNT_SIZE >= 432 && ACCOUNT_SIZE <= 464;
        assert!(
            size_within_envelope,
            "Account size {ACCOUNT_SIZE} drifted outside expected envelope",
        );
    }

    #[test]
    #[allow(clippy::assertions_on_constants)]
    fn engine_off_aligned() {
        assert_eq!(ENGINE_OFF % ENGINE_ALIGN, 0);
        let layout_ok = ENGINE_OFF >= HEADER_LEN + MARKET_CONFIG_LEN;
        assert!(layout_ok);
    }
}

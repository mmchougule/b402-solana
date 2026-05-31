//! PDA derivations for the percolator adapter (PRD-36 §5.2).
//!
//! Three PDAs:
//!   1. `adapter_authority` — owns the adapter's intermediate USDC ATA;
//!      signs the b402 vault → adapter ATA → user ATA flow.
//!   2. `owner_pda` — per-user, derived from `viewing_pub_hash`.
//!      Signs percolator-side ixs (InitUser, DepositCollateral, TradeCpi,
//!      WithdrawCollateral). Set anonymity at percolator's surface is
//!      1-of-N b402 users with this adapter.
//!   3. `perp_mapping` — per-slab, holds the `viewing_pub_hash → user_idx`
//!      table. Owned by this program.

use anchor_lang::prelude::*;

/// `adapter_authority` PDA. Single per-program authority.
pub const SEED_ADAPTER_AUTHORITY: &[u8] = b"adapter";

/// `owner_pda` PDA. Per-user; the second seed segment matches the kamino
/// adapter's domain string format (`"<protocol>-owner"`) so the cross-
/// adapter identity scoping property of PRD-33 §3.2 holds: same user has
/// distinct owner_pdas for kamino vs percolator vs marginfi etc.
pub const SEED_PERP_OWNER: &[u8] = b"perp-owner";

/// `perp_mapping` PDA. Per-slab; one mapping account per market.
pub const SEED_PERP_MAPPING: &[u8] = b"perp-mapping";

/// Domain prefix shared with every b402 PDA.
pub const SEED_B402: &[u8] = b"b402/v1";

/// Length of the viewing_pub_hash (32 B Fr from outSpendingPub).
pub const VIEWING_PUB_HASH_LEN: usize = 32;
pub type ViewingPubHash = [u8; VIEWING_PUB_HASH_LEN];

/// Derive `(adapter_authority, bump)` for this program.
pub fn derive_adapter_authority(program_id: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(
        &[SEED_B402, SEED_ADAPTER_AUTHORITY],
        program_id,
    )
}

/// Derive `(owner_pda, bump)` for a given `viewing_pub_hash`.
pub fn derive_owner_pda(
    program_id: &Pubkey,
    viewing_pub_hash: &ViewingPubHash,
) -> (Pubkey, u8) {
    Pubkey::find_program_address(
        &[SEED_B402, SEED_PERP_OWNER, viewing_pub_hash.as_ref()],
        program_id,
    )
}

/// Derive `(perp_mapping, bump)` for a given slab pubkey.
pub fn derive_perp_mapping(program_id: &Pubkey, slab: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(
        &[SEED_B402, SEED_PERP_MAPPING, slab.as_ref()],
        program_id,
    )
}

/// Build the seed slice for `invoke_signed` as `owner_pda` on a percolator ix.
/// Returns the slice form expected by `solana_program::program::invoke_signed`'s
/// `signers_seeds` parameter (after the bump byte is appended at the call site).
///
/// Caller is responsible for appending `&[bump]` to the returned vec before
/// passing to `invoke_signed`.
pub fn owner_pda_seeds(viewing_pub_hash: &ViewingPubHash) -> [&[u8]; 3] {
    [SEED_B402, SEED_PERP_OWNER, viewing_pub_hash.as_ref()]
}

/// Build the seed slice for `invoke_signed` as `adapter_authority`.
pub fn adapter_authority_seeds() -> [&'static [u8]; 2] {
    [SEED_B402, SEED_ADAPTER_AUTHORITY]
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Stand-in adapter program ID for unit tests. Real `declare_id!`
    /// arrives with the cdylib slice; this just needs to be a deterministic
    /// pubkey so tests are reproducible.
    fn test_program_id() -> Pubkey {
        Pubkey::new_from_array([1u8; 32])
    }

    #[test]
    fn adapter_authority_is_deterministic() {
        let pid = test_program_id();
        let (a, ba) = derive_adapter_authority(&pid);
        let (b, bb) = derive_adapter_authority(&pid);
        assert_eq!(a, b);
        assert_eq!(ba, bb);
    }

    #[test]
    fn owner_pda_changes_with_viewing_pub_hash() {
        let pid = test_program_id();
        let h1: ViewingPubHash = [0u8; 32];
        let mut h2: ViewingPubHash = [0u8; 32];
        h2[0] = 1;
        let (a, _) = derive_owner_pda(&pid, &h1);
        let (b, _) = derive_owner_pda(&pid, &h2);
        assert_ne!(a, b);
    }

    #[test]
    fn owner_pda_changes_with_program_id() {
        // The cross-adapter scoping property of PRD-33 §3.2: same
        // viewing_pub_hash, different adapter program → different
        // owner_pda. Confirms b402-percolator-adapter and
        // b402-kamino-adapter cannot collide identities.
        let pid_a = test_program_id();
        let pid_b: Pubkey = Pubkey::new_from_array([2u8; 32]);
        let h: ViewingPubHash = [42u8; 32];
        let (a, _) = derive_owner_pda(&pid_a, &h);
        let (b, _) = derive_owner_pda(&pid_b, &h);
        assert_ne!(a, b);
    }

    #[test]
    fn perp_mapping_is_per_slab() {
        let pid = test_program_id();
        let slab1 = Pubkey::new_from_array([0xa1; 32]);
        let slab2 = Pubkey::new_from_array([0xa2; 32]);
        let (a, _) = derive_perp_mapping(&pid, &slab1);
        let (b, _) = derive_perp_mapping(&pid, &slab2);
        assert_ne!(a, b);
    }

    #[test]
    fn owner_pda_seeds_construct_pda() {
        let pid = test_program_id();
        let h: ViewingPubHash = [3u8; 32];
        let (expected, bump) = derive_owner_pda(&pid, &h);
        let seeds = owner_pda_seeds(&h);
        // Re-derive via create_program_address to confirm the seed slice
        // matches what find_program_address used.
        let bump_arr = [bump];
        let mut seeds_with_bump: Vec<&[u8]> = seeds.to_vec();
        seeds_with_bump.push(&bump_arr);
        let derived =
            Pubkey::create_program_address(&seeds_with_bump, &pid).unwrap();
        assert_eq!(expected, derived);
    }
}

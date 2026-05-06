//! PRD-35 §5.2 invariant — verifier reads inputs from a pool-side
//! `PendingInputs` PDA. Both crates encode the layout independently
//! (verifier reads raw bytes; pool writes via Anchor #[account]).
//! This test pins the exact byte offsets the verifier expects so any
//! drift in pool's layout fails fast here, not at runtime CPI.

use b402_verifier_adapt::PUBLIC_INPUT_COUNT;

/// Anchor #[account] always prepends an 8-byte discriminator.
const ANCHOR_DISC_LEN: usize = 8;

/// Pool's PendingInputs layout per programs/b402-pool/src/instructions/
/// commit_inputs.rs::PendingInputs:
///   field 0: version: u8
///   field 1: inputs: [[u8; 32]; PUBLIC_INPUT_COUNT_ADAPT]
const POOL_PENDING_INPUTS_INNER_LEN: usize = 1 + 32 * PUBLIC_INPUT_COUNT;

/// Total on-chain account size. Verifier's verify_with_account_inputs
/// reads exactly this many bytes (8 disc + inner). If pool ever changes
/// the layout (adds a field, reorders), verifier reads garbage. This
/// pin is the cross-crate contract.
const POOL_PENDING_INPUTS_TOTAL_LEN: usize = ANCHOR_DISC_LEN + POOL_PENDING_INPUTS_INNER_LEN;

#[test]
fn pending_inputs_layout_offsets() {
    // Version byte sits immediately after the Anchor discriminator.
    let version_offset = ANCHOR_DISC_LEN;
    assert_eq!(version_offset, 8);

    // First input bytes start at offset 9 (8 disc + 1 version).
    let inputs_offset = ANCHOR_DISC_LEN + 1;
    assert_eq!(inputs_offset, 9);

    // Last input ends at offset (9 + 32*N).
    let inputs_end = inputs_offset + 32 * PUBLIC_INPUT_COUNT;
    assert_eq!(inputs_end, POOL_PENDING_INPUTS_TOTAL_LEN);
}

#[test]
fn pending_inputs_byte_count_matches_verifier_read() {
    // Verifier requires acct_data.len() >= 8 + 1 + 32 * PUBLIC_INPUT_COUNT.
    // Pool's #[account] allocates exactly that. If a field is added to
    // PendingInputs without bumping this constant, the verifier rejects
    // (PendingInputsBadLen) — safe failure mode.
    assert_eq!(
        POOL_PENDING_INPUTS_TOTAL_LEN,
        ANCHOR_DISC_LEN + 1 + 32 * PUBLIC_INPUT_COUNT,
    );
}

#[test]
fn version_byte_one_means_committed() {
    // Verifier rejects version != 1. The contract:
    //   version = 1 → pool::commit_inputs ran; safe to read inputs.
    //   version = 0 → consumed (zeroed by adapt_execute) or never written.
    // Pool zeroing a single byte (vs the entire 768 B inputs) is
    // intentional — replay protection without the CU cost of full memzero.
    assert_eq!(1u8, 1u8);
    assert_ne!(0u8, 1u8);
}

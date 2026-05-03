//! b402_verifier_adapt — Groth16 verifier for the ADAPT circuit (Phase 2).
//!
//! Structural clone of `b402_verifier_transact` with the adapt circuit's VK.
//! Separate program ID so the pool can distinguish transact proofs from
//! adapt proofs at the CPI level.
//!
//! VK is generated from the trusted-setup `adapt_verification_key.json` by
//! `circuits/scripts/vk-to-rust.mjs`.

use anchor_lang::prelude::*;
use groth16_solana::groth16::Groth16Verifier;

mod vk;
use vk::ADAPT_VK;

declare_id!("3Y2tyhNSaUiW5AcZcmFGRyTMdnroxHxc5GqFQPcMTZae");

/// Adapt circuit public-input count.
///   Phase 7B (default, current mainnet): 23 — 18 transact-layout + 5 adapt.
///   Phase 9 (`phase_9_dual_note`):       24 — adds outSpendingPub[0] alias
///                                             so the pool can recompute the
///                                             excess commitment in Rust.
/// The two shapes are NOT backward compatible — flipping requires
/// redeploying both this verifier and the matching VK from the Phase 9
/// trusted-setup ceremony. Default off so cargo builds produce the binary
/// that matches the currently-deployed VK.
#[cfg(not(feature = "phase_9_dual_note"))]
pub const PUBLIC_INPUT_COUNT: usize = 23;
#[cfg(feature = "phase_9_dual_note")]
pub const PUBLIC_INPUT_COUNT: usize = 24;

pub fn reverse_endianness(input: &[u8; 32]) -> [u8; 32] {
    let mut out = [0u8; 32];
    for i in 0..32 {
        out[i] = input[31 - i];
    }
    out
}

pub fn verify_proof_be(
    proof_a: &[u8; 64],
    proof_b: &[u8; 128],
    proof_c: &[u8; 64],
    public_inputs_be: &[[u8; 32]; PUBLIC_INPUT_COUNT],
) -> std::result::Result<(), VerifierError> {
    let mut verifier = Groth16Verifier::new(proof_a, proof_b, proof_c, public_inputs_be, &ADAPT_VK)
        .map_err(|_| VerifierError::InvalidProof)?;
    verifier
        .verify()
        .map_err(|_| VerifierError::VerificationFailed)?;
    Ok(())
}

#[program]
pub mod b402_verifier_adapt {
    use super::*;

    /// PRD-03 §2.3 / Phase 7B+ inline-inputs path.
    ///
    /// Instruction data layout:
    ///   data[0]       = 0x01 (discriminator)
    ///   data[1..257]  = proof bytes (256 = A64 || B128 || C64)
    ///   data[257..]   = PUBLIC_INPUT_COUNT public inputs, each 32 bytes LE
    ///
    /// Stays alive alongside `verify_with_account_inputs` (PRD-35) for
    /// callers that don't yet route via the pending-inputs PDA. New
    /// callers should prefer the account-inputs variant — that path
    /// is what unblocks per-user adapters by lifting the v0-tx ceiling.
    pub fn verify(_ctx: Context<Verify>, ix_data: Vec<u8>) -> Result<()> {
        require!(
            ix_data.len() == 1 + 256 + 32 * PUBLIC_INPUT_COUNT,
            VerifierError::InvalidData
        );
        require!(ix_data[0] == 0x01, VerifierError::InvalidData);

        let proof = &ix_data[1..257];
        let inputs_bytes = &ix_data[257..];

        let mut proof_a = [0u8; 64];
        let mut proof_b = [0u8; 128];
        let mut proof_c = [0u8; 64];
        proof_a.copy_from_slice(&proof[0..64]);
        proof_b.copy_from_slice(&proof[64..192]);
        proof_c.copy_from_slice(&proof[192..256]);

        let mut public_inputs: [[u8; 32]; PUBLIC_INPUT_COUNT] = [[0u8; 32]; PUBLIC_INPUT_COUNT];
        for i in 0..PUBLIC_INPUT_COUNT {
            let mut le = [0u8; 32];
            le.copy_from_slice(&inputs_bytes[i * 32..(i + 1) * 32]);
            public_inputs[i] = reverse_endianness(&le);
        }

        verify_proof_be(&proof_a, &proof_b, &proof_c, &public_inputs).map_err(|e| error!(e))?;

        Ok(())
    }

    /// PRD-35 §5.2 — read public inputs from a per-user PDA instead of ix
    /// data. Saves ~700-735 B per call on the message size, lifting the
    /// 1232 B v0-tx cap that today blocks per-user adapters.
    ///
    /// Pre-condition (enforced by caller — pool's `adapt_execute`):
    /// `pool::commit_inputs(spending_pub_le, public_inputs)` was called
    /// in a prior tx, leaving the inputs in `pending_inputs.data`.
    ///
    /// Account-data layout (matches `pool::PendingInputs`):
    ///   bytes[0..8]                  = Anchor account discriminator
    ///   bytes[8]                     = version (1 = committed; 0 = consumed)
    ///   bytes[9..9 + 32 × N]         = N public inputs, 32 B LE each
    /// where N = PUBLIC_INPUT_COUNT.
    ///
    /// Decoupled from pool's Anchor types — verifier reads raw bytes so
    /// the verifier crate doesn't have to depend on the pool crate.
    /// `commit_inputs.rs::PendingInputs::LEN` is the source of truth for
    /// the layout; if it changes both sides update.
    pub fn verify_with_account_inputs(
        ctx: Context<VerifyWithAccountInputs>,
        proof: [u8; 256],
    ) -> Result<()> {
        let acct_data = ctx.accounts.pending_inputs.try_borrow_data()?;
        // 8 (anchor disc) + 1 (version) + 32 × N (inputs)
        require!(
            acct_data.len() >= 8 + 1 + 32 * PUBLIC_INPUT_COUNT,
            VerifierError::PendingInputsBadLen
        );
        require!(acct_data[8] == 1, VerifierError::PendingInputsNotCommitted);

        let mut proof_a = [0u8; 64];
        let mut proof_b = [0u8; 128];
        let mut proof_c = [0u8; 64];
        proof_a.copy_from_slice(&proof[0..64]);
        proof_b.copy_from_slice(&proof[64..192]);
        proof_c.copy_from_slice(&proof[192..256]);

        let mut public_inputs: [[u8; 32]; PUBLIC_INPUT_COUNT] = [[0u8; 32]; PUBLIC_INPUT_COUNT];
        for i in 0..PUBLIC_INPUT_COUNT {
            let off = 8 + 1 + i * 32;
            let mut le = [0u8; 32];
            le.copy_from_slice(&acct_data[off..off + 32]);
            public_inputs[i] = reverse_endianness(&le);
        }

        verify_proof_be(&proof_a, &proof_b, &proof_c, &public_inputs).map_err(|e| error!(e))?;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Verify {}

/// Account list for `verify_with_account_inputs`. The pending_inputs
/// account is verified by the caller (pool) — verifier just reads bytes.
/// Marked `UncheckedAccount` to avoid forcing a cross-crate type
/// dependency on `pool::PendingInputs`.
#[derive(Accounts)]
pub struct VerifyWithAccountInputs<'info> {
    /// CHECK: pool's `adapt_execute` validates that this account is the
    /// canonically-derived pending_inputs PDA owned by the pool program.
    /// Verifier itself doesn't enforce ownership — it would have to take
    /// a cross-crate dep on pool, which we explicitly avoid here.
    pub pending_inputs: UncheckedAccount<'info>,
}

#[error_code]
pub enum VerifierError {
    #[msg("invalid instruction data")]
    InvalidData = 2100,
    #[msg("invalid proof encoding")]
    InvalidProof = 2101,
    #[msg("verification failed")]
    VerificationFailed = 2102,
    #[msg("pending_inputs account too small for the configured public-input count")]
    PendingInputsBadLen = 2103,
    #[msg("pending_inputs account not committed (version != 1) — call commit_inputs first")]
    PendingInputsNotCommitted = 2104,
}

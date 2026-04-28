//! b402_verifier_adapt_v2 — Groth16 verifier for the ADAPT v2 circuit (Phase 3 ABI).
//!
//! Structural clone of `b402_verifier_adapt` with the v2 circuit's VK and an
//! expanded public-input layout (38 inputs vs. 23). Separate program ID so
//! the pool can address the v1 and v2 verifiers independently — both
//! coexist on-chain during the v2 rollout per the additive ABI plan.
//!
//! Public-input layout (38 inputs) is documented in
//! `circuits/adapt_v2.circom` and `programs/b402-pool/src/instructions/adapt_execute_v2.rs`.
//!
//! VK is generated from the trusted-setup `adapt_v2_verification_key.json`
//! by `circuits/scripts/vk-to-rust.mjs`.

use anchor_lang::prelude::*;
use groth16_solana::groth16::Groth16Verifier;

mod vk;
use vk::ADAPT_V2_VK;

declare_id!("DG7Fi75b2jkcUgG5K6Ekgpy7uigYxePPSxSSrdPzLGUd");

/// Adapt v2 circuit has 38 public inputs (PRD-11/12/13/15).
pub const PUBLIC_INPUT_COUNT: usize = 38;

pub fn reverse_endianness(input: &[u8; 32]) -> [u8; 32] {
    let mut out = [0u8; 32];
    for i in 0..32 { out[i] = input[31 - i]; }
    out
}

pub fn verify_proof_be(
    proof_a: &[u8; 64],
    proof_b: &[u8; 128],
    proof_c: &[u8; 64],
    public_inputs_be: &[[u8; 32]; PUBLIC_INPUT_COUNT],
) -> std::result::Result<(), VerifierError> {
    let mut verifier = Groth16Verifier::new(
        proof_a, proof_b, proof_c, public_inputs_be, &ADAPT_V2_VK,
    )
    .map_err(|_| VerifierError::InvalidProof)?;
    verifier.verify().map_err(|_| VerifierError::VerificationFailed)?;
    Ok(())
}

#[program]
pub mod b402_verifier_adapt_v2 {
    use super::*;

    /// Instruction data layout:
    ///   data[0]       = 0x01 (discriminator)
    ///   data[1..257]  = proof bytes (256 = A64 || B128 || C64)
    ///   data[257..]   = 38 public inputs, each 32 bytes LE
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

        verify_proof_be(&proof_a, &proof_b, &proof_c, &public_inputs)
            .map_err(|e| error!(e))?;

        Ok(())
    }
}

#[derive(Accounts)]
pub struct Verify {}

#[error_code]
pub enum VerifierError {
    #[msg("invalid instruction data")]
    InvalidData = 2200,
    #[msg("invalid proof encoding")]
    InvalidProof = 2201,
    #[msg("verification failed")]
    VerificationFailed = 2202,
}

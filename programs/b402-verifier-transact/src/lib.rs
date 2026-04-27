//! b402_verifier_transact — Groth16 verifier for the transact circuit.
//!
//! Wraps `Lightprotocol/groth16-solana`. The verifying key is included from
//! `vk.rs`, generated from the trusted-setup `verification_key.json` by
//! `circuits/scripts/vk-to-rust.mjs`.

use anchor_lang::prelude::*;
use groth16_solana::groth16::Groth16Verifier;

mod vk;
use vk::TRANSACT_VK;

declare_id!("Afjbnv2Ekxa98jjRw33xPPhZabevek2uZxoE75kr6ZrK");

pub const PUBLIC_INPUT_COUNT: usize = 18;

/// Public-input serialization: each field element is 32 bytes in LITTLE-ENDIAN
/// as emitted by the Solana program and matching the wire format used across
/// `packages/crypto` and the TS SDK. `groth16-solana` expects big-endian, so
/// we reverse on the way in.
pub fn reverse_endianness(input: &[u8; 32]) -> [u8; 32] {
    let mut out = [0u8; 32];
    for i in 0..32 {
        out[i] = input[31 - i];
    }
    out
}

/// Core verify routine — pure function, no Solana context required. Used by:
///   - The on-chain `verify` instruction below (converts LE → BE → calls this)
///   - Off-chain Rust tests that consume proof bytes in native BE form
///
/// `public_inputs_be` must already be in big-endian. Returns `Ok(())` on
/// valid proof, `Err(VerifierError::VerificationFailed)` otherwise.
pub fn verify_proof_be(
    proof_a: &[u8; 64],
    proof_b: &[u8; 128],
    proof_c: &[u8; 64],
    public_inputs_be: &[[u8; 32]; PUBLIC_INPUT_COUNT],
) -> std::result::Result<(), VerifierError> {
    let mut verifier =
        Groth16Verifier::new(proof_a, proof_b, proof_c, public_inputs_be, &TRANSACT_VK)
            .map_err(|_| VerifierError::InvalidProof)?;
    verifier
        .verify()
        .map_err(|_| VerifierError::VerificationFailed)?;
    Ok(())
}

#[program]
pub mod b402_verifier_transact {
    use super::*;

    /// Instruction data layout (unified with `b402_pool`'s verifier CPI helper):
    ///   data[0]      = 0x01 (discriminator)
    ///   data[1..257] = proof bytes (256 = A64 || B128 || C64)
    ///   data[257..]  = 16 public inputs, each 32 bytes LE
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

        // Public inputs: arriving LE, convert to BE for groth16-solana.
        let mut public_inputs: [[u8; 32]; PUBLIC_INPUT_COUNT] = [[0u8; 32]; PUBLIC_INPUT_COUNT];
        for i in 0..PUBLIC_INPUT_COUNT {
            let mut le = [0u8; 32];
            le.copy_from_slice(&inputs_bytes[i * 32..(i + 1) * 32]);
            public_inputs[i] = reverse_endianness(&le);
        }

        verify_proof_be(&proof_a, &proof_b, &proof_c, &public_inputs).map_err(|e| error!(e))?;

        Ok(())
    }
}

#[derive(Accounts)]
pub struct Verify {}

#[error_code]
pub enum VerifierError {
    #[msg("invalid instruction data")]
    InvalidData = 2000,
    #[msg("invalid proof encoding")]
    InvalidProof = 2001,
    #[msg("verification failed")]
    VerificationFailed = 2002,
}

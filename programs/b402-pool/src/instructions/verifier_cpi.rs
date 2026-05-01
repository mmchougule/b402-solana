//! CPI helper to the Groth16 verifier program.
//!
//! The verifier is an Anchor #[program] with a `verify(ix_data: Vec<u8>)`
//! entrypoint. On-the-wire, Anchor expects:
//!   [8B discriminator = sha256("global:verify")[0..8]]
//!   [borsh-encoded args = u32 LE length prefix of the Vec<u8>, then bytes]
//!
//! The inner Vec<u8> follows the existing convention:
//!   [0x01][256B proof][16 × 32B public inputs LE]

use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::Instruction;
use anchor_lang::solana_program::program::invoke;

use crate::error::PoolError;

pub const PUBLIC_INPUT_COUNT: usize = 18;
/// Adapt-CPI public-input count. Pairs with `b402_verifier_adapt::PUBLIC_INPUT_COUNT`
/// — both crates must be built with the same `phase_9_dual_note` setting.
///   default (Phase 7B):     23
///   phase_9_dual_note: 24 (adds outSpendingPub[0] alias, post-ceremony)
#[cfg(not(feature = "phase_9_dual_note"))]
pub const PUBLIC_INPUT_COUNT_ADAPT: usize = 23;
#[cfg(feature = "phase_9_dual_note")]
pub const PUBLIC_INPUT_COUNT_ADAPT: usize = 24;

/// sha256("global:verify")[0..8]. Pre-computed to avoid hashing at runtime.
/// Must match the Anchor-generated discriminator for `pub fn verify(...)` in
/// `b402-verifier-transact`. Regenerate if the fn name ever changes.
const VERIFY_DISCRIMINATOR: [u8; 8] = [133, 161, 141, 48, 120, 198, 88, 150];

pub fn invoke_verify_transact<'info>(
    verifier_program: &AccountInfo<'info>,
    proof: &[u8; 256],
    public_inputs: &[[u8; 32]],
) -> Result<()> {
    if public_inputs.len() != PUBLIC_INPUT_COUNT {
        return err!(PoolError::ProofPublicInputMismatch);
    }

    // Build the inner ix_data: [0x01][proof][public_inputs].
    let inner_len = 1 + 256 + 32 * PUBLIC_INPUT_COUNT;
    let mut inner: Vec<u8> = Vec::with_capacity(inner_len);
    inner.push(0x01);
    inner.extend_from_slice(proof);
    for fr in public_inputs.iter() {
        inner.extend_from_slice(fr);
    }

    // Anchor wire format: discriminator || u32 LE length || bytes.
    let mut data: Vec<u8> = Vec::with_capacity(8 + 4 + inner_len);
    data.extend_from_slice(&VERIFY_DISCRIMINATOR);
    data.extend_from_slice(&(inner_len as u32).to_le_bytes());
    data.extend_from_slice(&inner);

    // Anchor requires a `Signer` account in the Verify context (PRD-03 §2.3
    // has a dummy `caller` signer). We pass the pool program's verifier
    // account info — but Anchor requires it to be marked signer. Use
    // `invoke_signed` with an empty signer seeds list will fail if the account
    // isn't signable. Instead: the verifier program doesn't actually USE the
    // signer for anything. So we pass the verifier program itself as the
    // caller account and mark it as a signer in the meta. This is a hack to
    // satisfy Anchor's struct; cleaner v2 verifier has NO Accounts struct.
    // For now, pass the current pool's PDA isn't needed either because we
    // don't invoke_signed; we rely on invoke() with the tx's native signers.
    //
    // Actually simplest: since the verifier doesn't care who signed, we pass
    // the relayer / caller signer from the enclosing tx. But CPI doesn't
    // forward outer signers as signers of the inner call unless the outer
    // accounts include them as signer metas.
    //
    // Workaround for v1: change the verifier to use UncheckedAccount (no
    // Signer requirement). Handled in the verifier program source.

    let ix = Instruction {
        program_id: *verifier_program.key,
        accounts: vec![],
        data,
    };

    invoke(&ix, &[verifier_program.clone()])
        .map_err(|_| error!(PoolError::ProofVerificationFailed))?;
    Ok(())
}

/// Sibling of `invoke_verify_transact` for the adapt verifier. Same wire
/// format — the only difference is `public_inputs.len()` must equal 23.
pub fn invoke_verify_adapt<'info>(
    verifier_program: &AccountInfo<'info>,
    proof: &[u8; 256],
    public_inputs: &[[u8; 32]],
) -> Result<()> {
    if public_inputs.len() != PUBLIC_INPUT_COUNT_ADAPT {
        return err!(PoolError::ProofPublicInputMismatch);
    }

    let inner_len = 1 + 256 + 32 * PUBLIC_INPUT_COUNT_ADAPT;
    let mut inner: Vec<u8> = Vec::with_capacity(inner_len);
    inner.push(0x01);
    inner.extend_from_slice(proof);
    for fr in public_inputs.iter() {
        inner.extend_from_slice(fr);
    }

    let mut data: Vec<u8> = Vec::with_capacity(8 + 4 + inner_len);
    data.extend_from_slice(&VERIFY_DISCRIMINATOR);
    data.extend_from_slice(&(inner_len as u32).to_le_bytes());
    data.extend_from_slice(&inner);

    let ix = Instruction {
        program_id: *verifier_program.key,
        accounts: vec![],
        data,
    };

    invoke(&ix, &[verifier_program.clone()])
        .map_err(|_| error!(PoolError::ProofVerificationFailed))?;
    Ok(())
}

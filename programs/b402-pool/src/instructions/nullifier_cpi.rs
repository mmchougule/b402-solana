//! Phase 7 — pool-to-`b402_nullifier` CPI helper.
//!
//! Replaces the sibling-ix + instructions-sysvar pattern with a direct
//! `solana_program::program::invoke` into `b402_nullifier::create_nullifier`.
//! See `docs/prds/PHASE-7-HANDOFF.md` for the architecture rationale.
//!
//! Wire layout for the inner ix matches what the SDK builds today (see
//! `packages/sdk/src/light-nullifier.ts::buildCreateNullifierIx`):
//!
//! ```text
//!   data:
//!     [0..8)   = sha256("global:create_nullifier")[..8]   (DISCRIMINATOR)
//!     [8..137) = ValidityProof Borsh                      (1 + 32 + 64 + 32)
//!     [137..141) = PackedAddressTreeInfo Borsh            (4 bytes)
//!     [141..142) = output_state_tree_index                (1 byte)
//!     [142..174) = id (the nullifier value)               (32 bytes)
//!
//!   accounts (positional, must match b402_nullifier::CreateNullifier when
//!   that program is built with `--features cpi-only`):
//!     [0]   payer/signer (writable)
//!     [1]   instructions sysvar (Sysvar1nstructions11111…)
//!     [2]   light_system_program
//!     [3]   cpi_authority (b402_nullifier PDA)
//!     [4]   registered_program_pda
//!     [5]   account_compression_authority
//!     [6]   account_compression_program
//!     [7]   system_program
//!     [8]   address_tree (writable)
//!     [9]   output_queue (writable)
//!   = 10 accounts total per nullifier insert.
//! ```
//!
//! The pool does NOT validate the inner accounts — that's b402_nullifier's
//! job (and Light's, transitively). The pool only verifies:
//!   1. `id` (the nullifier) matches what the proof committed to.
//!   2. Discriminator + length sanity (defence-in-depth; b402_nullifier
//!      itself rejects malformed args).

#![cfg(feature = "inline_cpi_nullifier")]

use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program::invoke;

use crate::error::PoolError;

/// Pubkey of the deployed `b402_nullifier` program. MUST match the value
/// in `programs/b402-nullifier/src/lib.rs::declare_id!` and
/// `programs/b402-pool/src/instructions/transact.rs::B402_NULLIFIER_PROGRAM_ID`.
pub use super::transact::B402_NULLIFIER_PROGRAM_ID;

/// Anchor `sha256("global:create_nullifier")[..8]`. Same constant as
/// `util::B402_NULLIFIER_DISCRIMINATOR` — re-exported here for clarity.
pub const CREATE_NULLIFIER_DISCRIMINATOR: [u8; 8] = [171, 144, 50, 154, 87, 170, 57, 66];

/// Inner ix data layout offsets — kept in sync with the SDK builder.
const ID_OFFSET: usize = 8 + 129 + 4 + 1; // 142
const IX_DATA_LEN: usize = ID_OFFSET + 32; // 174

/// Build the create_nullifier ix-data wire form for a pre-fetched
/// (proof, address-tree-info, state-tree-index, id) tuple.
///
/// Caller passes the validity-proof + address-tree-info bytes verbatim; the
/// pool does NOT re-encode them. They were already encoded by the SDK and
/// rode in `args.nullifier_cpi_payloads[i]`.
pub fn build_inner_ix_data(
    raw_proof_and_tree: &[u8],
    nullifier_id: &[u8; 32],
) -> Result<Vec<u8>> {
    // raw_proof_and_tree is the 134 bytes between the discriminator and the
    // id: [proof Borsh 129][tree-info 4][state-tree-index 1].
    require!(
        raw_proof_and_tree.len() == 129 + 4 + 1,
        PoolError::NullifierIxMalformed
    );

    let mut data = Vec::with_capacity(IX_DATA_LEN);
    data.extend_from_slice(&CREATE_NULLIFIER_DISCRIMINATOR);
    data.extend_from_slice(raw_proof_and_tree);
    data.extend_from_slice(nullifier_id);
    debug_assert_eq!(data.len(), IX_DATA_LEN);
    Ok(data)
}

/// CPI into `b402_nullifier::create_nullifier`.
///
/// `nullifier_accounts` is the 10-element list expected by the
/// `cpi-only`-built b402_nullifier `CreateNullifier` accounts struct (in
/// positional order): payer (signer, writable), instructions sysvar,
/// light_system_program, cpi_authority, registered_program_pda,
/// account_compression_authority, account_compression_program, system_program,
/// address_tree (writable), output_queue (writable). The first element MUST
/// be the relayer/payer from the outer tx (already a `Signer<'info>` at the
/// pool level so the signer flag propagates through this CPI).
///
/// The pool forwards these accounts via `remaining_accounts` on the outer
/// ix; callers slice them in via
/// `ctx.remaining_accounts[start..start+ACCT_PER_NULL]` (ACCT_PER_NULL=10
/// in unshield/transact/adapt_execute).
pub fn invoke_create_nullifier<'info>(
    nullifier_program: &AccountInfo<'info>,
    nullifier_accounts: &[AccountInfo<'info>],
    raw_proof_and_tree: &[u8],
    nullifier_id: &[u8; 32],
) -> Result<()> {
    require!(
        nullifier_program.key == &B402_NULLIFIER_PROGRAM_ID,
        PoolError::NullifierIxMalformed
    );

    // Inner account-meta vector: replicate the AccountInfo flags 1:1.
    let metas: Vec<AccountMeta> = nullifier_accounts
        .iter()
        .map(|a| {
            if a.is_writable {
                AccountMeta::new(*a.key, a.is_signer)
            } else {
                AccountMeta::new_readonly(*a.key, a.is_signer)
            }
        })
        .collect();

    let data = build_inner_ix_data(raw_proof_and_tree, nullifier_id)?;
    let ix = Instruction {
        program_id: B402_NULLIFIER_PROGRAM_ID,
        accounts: metas,
        data,
    };

    // Build the AccountInfo slice the runtime needs: program + all metas.
    let mut infos: Vec<AccountInfo<'info>> = Vec::with_capacity(1 + nullifier_accounts.len());
    infos.push(nullifier_program.clone());
    for a in nullifier_accounts {
        infos.push(a.clone());
    }

    invoke(&ix, &infos).map_err(|_| error!(PoolError::NullifierIxMissing))?;
    Ok(())
}

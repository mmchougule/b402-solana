#![allow(unexpected_cfgs)]
#![allow(deprecated)]

//! b402-nullifier — domain-tagged fork of Lightprotocol/nullifier-program.
//!
//! Each call asks Light's address tree V2 to insert a leaf at the address
//! derived from `(b"b402/v1/null", id, address_tree_pubkey, this_program_id)`.
//! If the address already exists, Light's verifier rejects the insert →
//! double-spend caught at the address-tree layer.
//!
//! Differences from upstream:
//!   1. `declare_id!` is the b402-controlled program ID (see
//!      `~/.config/solana/b402_nullifier-keypair.json`).
//!   2. Address-derivation seed is `b"b402/v1/null"` (matches our domain
//!      tag in `packages/shared/src/constants.ts`), not `b"nullifier"`.
//!      Domain-separated from any other Light-built nullifier program in
//!      the same address tree.
//!
//! Note on caller restriction: the cryptographic isolation comes from the
//! address derivation, which hashes our program ID into the result. Only
//! a tx that goes through THIS program can produce addresses in our
//! address space. An arbitrary caller cannot pollute our space.
//!
//! A future hardening would add a CPI-only check (require the call comes
//! from b402_pool's adapter authority PDA). The challenge is that Light's
//! `signer` account here is the fee payer (a real Keypair signature), not
//! a PDA, so a naive `require_keys_eq!` doesn't apply. Tracked as a v2.1
//! follow-up: pass a separate `pool_authority` account, verify it's a PDA
//! signed by b402_pool, gated behind a `cpi-only` Cargo feature.

use anchor_lang::prelude::*;

#[cfg(not(target_os = "solana"))]
pub mod sdk;

use light_sdk::constants::ADDRESS_TREE_V2;
use light_sdk::{
    account::LightAccount,
    address::v2::derive_address,
    cpi::{v2::CpiAccounts, CpiSigner},
    derive_light_cpi_signer,
    instruction::{PackedAddressTreeInfo, ValidityProof},
    LightDiscriminator, PackedAddressTreeInfoExt,
};

declare_id!("2AnRZwWu6CTurZs1yQpqrcJWo4yRYL1xpeV78b2siweq");

pub const LIGHT_CPI_SIGNER: CpiSigner =
    derive_light_cpi_signer!("2AnRZwWu6CTurZs1yQpqrcJWo4yRYL1xpeV78b2siweq");

/// Domain tag bound into every address derived by this program.
/// Mirrors `DomainTags.nullifier = 'b402/v1/null'` in shared/constants.ts.
pub const SEED_NULL: &[u8] = b"b402/v1/null";

/// Phase 7 (`cpi-only`): the only program permitted to CPI `create_nullifier`.
/// Bytes match `programs/b402-pool/src/instructions/transact.rs::B402_NULLIFIER_PROGRAM_ID`'s
/// counterpart (b402_pool's deployed program ID, base58
/// `42a3hsCXtQLWonyxWZosaaCJCweYYKMrvNd25p1Jrt2y`). Pool is the caller, this
/// program is the callee — the constant naming reflects "pool program ID,
/// as seen from b402_nullifier".
#[cfg(feature = "cpi-only")]
pub const B402_POOL_PROGRAM_ID: anchor_lang::solana_program::pubkey::Pubkey =
    anchor_lang::solana_program::pubkey::Pubkey::new_from_array([
        44, 250, 1, 237, 166, 224, 6, 72,
        104, 142, 129, 186, 150, 124, 135, 38,
        147, 149, 9, 35, 207, 145, 230, 13,
        248, 105, 140, 166, 50, 208, 195, 22,
    ]);

#[program]
pub mod b402_nullifier {

    use super::*;
    use light_sdk::cpi::{v2::LightSystemProgramCpi, InvokeLightSystemProgram, LightCpiInstruction};

    /// Creates a rent-free compressed account at the address derived from
    /// `(SEED_NULL, id)` in Light's address tree V2. If the address is
    /// already taken (= same `id` was inserted before), Light's verifier
    /// rejects the insert and the instruction errors out — that's the
    /// double-spend check.
    pub fn create_nullifier<'info>(
        ctx: Context<'_, '_, '_, 'info, CreateNullifier<'info>>,
        proof: ValidityProof,
        address_tree_info: PackedAddressTreeInfo,
        output_state_tree_index: u8,
        id: [u8; 32],
    ) -> Result<()> {
        // Phase 7 (`cpi-only`): refuse all top-level invocations and any CPI
        // whose top-level caller is not b402_pool. Defence-in-depth on top
        // of the address-derivation isolation noted in the file header.
        //
        // We use `get_stack_height()` (Solana runtime) — returns 1 for the
        // top-level ix, ≥ 2 for any CPI. When CPI'd, the instructions sysvar
        // (passed in the `ix_sysvar` account slot) lets us look up the
        // top-level ix's `program_id`.
        #[cfg(feature = "cpi-only")]
        {
            use anchor_lang::solana_program::instruction::get_stack_height;
            use anchor_lang::solana_program::sysvar::instructions::{
                load_current_index_checked, load_instruction_at_checked,
            };
            // Stack height 1 = top-level dispatch. Reject — only CPIs allowed.
            require!(
                get_stack_height() > 1,
                B402NullifierError::DirectCallRejected
            );
            let ix_sysvar = &ctx.accounts.ix_sysvar;
            let current_idx = load_current_index_checked(ix_sysvar)? as usize;
            let outer_ix = load_instruction_at_checked(current_idx, ix_sysvar)?;
            require!(
                outer_ix.program_id == crate::B402_POOL_PROGRAM_ID,
                B402NullifierError::CallerNotB402Pool
            );
        }

        let light_cpi_accounts = CpiAccounts::new(
            ctx.accounts.signer.as_ref(),
            ctx.remaining_accounts,
            crate::LIGHT_CPI_SIGNER,
        );

        let address_tree_pubkey = address_tree_info
            .get_tree_pubkey(&light_cpi_accounts)
            .map_err(|_| ErrorCode::AccountNotEnoughKeys)?;

        if address_tree_pubkey.to_bytes() != ADDRESS_TREE_V2 {
            msg!("address tree pubkey did not match Light's V2 address tree");
            return Err(B402NullifierError::WrongAddressTree.into());
        }

        let (address, address_seed) =
            derive_address(&[SEED_NULL, &id], &address_tree_pubkey, &crate::ID);

        let nullifier_account = LightAccount::<NullifierAccount>::new_init(
            &crate::ID,
            Some(address),
            output_state_tree_index,
        );

        emit!(NullifierInserted {
            id,
            address,
        });

        LightSystemProgramCpi::new_cpi(LIGHT_CPI_SIGNER, proof)
            .with_light_account(nullifier_account)?
            .with_new_addresses(&[address_tree_info
                .into_new_address_params_assigned_packed(address_seed, Some(0))])
            .invoke(light_cpi_accounts)?;

        Ok(())
    }
}

#[derive(Accounts)]
pub struct CreateNullifier<'info> {
    /// Fee payer + Light SDK signer for the inner CPI. Must be a real
    /// signer because Light's system program checks it on the inner CPI.
    #[account(mut)]
    pub signer: Signer<'info>,
    /// Phase 7 (`cpi-only`): instructions sysvar. Pool reads the top-level
    /// ix from this sysvar to confirm the caller program_id is b402_pool.
    /// Required only in `cpi-only` builds — the sibling-ix build does not
    /// have this field, so the deployed v2.1 program ABI is unchanged
    /// (existing SDK builds work against the deployed nullifier program).
    /// CHECK: address constraint enforces the canonical instructions sysvar.
    #[cfg(feature = "cpi-only")]
    #[account(address = anchor_lang::solana_program::sysvar::instructions::ID)]
    pub ix_sysvar: AccountInfo<'info>,
}

#[error_code]
pub enum B402NullifierError {
    #[msg("Address tree pubkey did not match Light's V2 address tree")]
    WrongAddressTree,
    #[msg("create_nullifier may only be invoked via CPI (cpi-only build)")]
    DirectCallRejected,
    #[msg("create_nullifier caller is not b402_pool (cpi-only build)")]
    CallerNotB402Pool,
}

#[event]
pub struct NullifierInserted {
    pub id: [u8; 32],
    pub address: [u8; 32],
}

#[derive(
    Clone,
    Debug,
    Default,
    LightDiscriminator,
    AnchorSerialize,
    AnchorDeserialize,
)]
pub struct NullifierAccount {}

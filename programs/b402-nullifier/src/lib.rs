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
}

#[error_code]
pub enum B402NullifierError {
    #[msg("Address tree pubkey did not match Light's V2 address tree")]
    WrongAddressTree,
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

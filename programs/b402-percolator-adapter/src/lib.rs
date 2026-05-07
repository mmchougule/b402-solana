//! b402_percolator_adapter — Percolator perp adapter for the b402 shielded pool.
//!
//! Per PRD-36 (Option B: shielded user / private positions). Called by
//! b402_pool via CPI after IN-mint USDC has been moved into this adapter's
//! intermediate ATA. The adapter then composes the percolator-prog
//! instruction sequence required by the chosen action (`OpenPosition` /
//! `ClosePosition`) and transfers the resulting OUT-mint USDC back to the
//! pool's `out_vault`.
//!
//! Slice 2 (this commit) ships:
//!   * `cdylib` build target + `declare_id!`
//!   * `Execute<'info>` Anchor account struct (subset that's invariant
//!     across action variants)
//!   * `execute` ix that decodes the action_payload and dispatches to
//!     per-action argument validation (PRD-36 §6.5 #2)
//!   * Manual percolator-prog ix builders (`percolator_ix.rs`) — tag-byte
//!     wire format pinned against percolator-prog source
//!
//! Slice 3 will add the `invoke_signed` plumbing — percolator-side ATA
//! flow, mapping account read/write, stale-entry re-verify (§6.5 #1).

use anchor_lang::prelude::*;
use anchor_spl::token::{Token, TokenAccount};

declare_id!("65NRt6GpeakqXhqvKcN3knohzKEZT37arUyQi3SZwfxv");

pub mod actions;
pub mod cpi;
pub mod error;
pub mod mapping;
pub mod payload;
pub mod pda;
pub mod percolator_ix;
pub mod slab;

pub use error::PercolatorAdapterError;
pub use mapping::{
    AllocateOutcome, MappingError, PerpMapping, PerpMappingRead, FLAG_CLOSED, MAX_ENTRIES,
    PERP_MAPPING_ACCOUNT_LEN,
};
pub use payload::{PayloadDecodeError, PercolatorAction, PAYLOAD_MAX_LEN};
pub use pda::{
    adapter_authority_seeds, derive_adapter_authority, derive_owner_pda,
    derive_perp_mapping, owner_pda_seeds, ViewingPubHash, SEED_ADAPTER_AUTHORITY, SEED_B402,
    SEED_PERP_MAPPING, SEED_PERP_OWNER, VIEWING_PUB_HASH_LEN,
};
pub use percolator_ix::{
    build_deposit_collateral_data, build_init_user_data, build_trade_cpi_data,
    build_withdraw_collateral_data, PERCOLATOR_TAG_DEPOSIT_COLLATERAL,
    PERCOLATOR_TAG_INIT_USER, PERCOLATOR_TAG_TRADE_CPI, PERCOLATOR_TAG_WITHDRAW_COLLATERAL,
};

/// b402_pool program ID. Verified against the on-chain deployment in
/// the existing kamino-adapter (programs/b402-kamino-adapter/src/lib.rs).
/// Used by the cpi-only feature gate.
pub const B402_POOL_PROGRAM_ID: Pubkey =
    anchor_lang::pubkey!("42a3hsCXtQLWonyxWZosaaCJCweYYKMrvNd25p1Jrt2y");

#[program]
pub mod b402_percolator_adapter {
    use super::*;

    /// Decode the action_payload, validate args, and (slice 3+) invoke
    /// the percolator-side ix sequence.
    ///
    /// Slice 2 dispatches to argument validation only — handler-level
    /// CPI work lands on slice 3 once the account-info wiring is
    /// designed to validate the variadic tail (slab, percolator-prog,
    /// matcher, user ATA).
    pub fn execute<'info>(
        _ctx: Context<'_, '_, '_, 'info, Execute<'info>>,
        in_amount: u64,
        _min_out_amount: u64,
        action_payload: Vec<u8>,
    ) -> Result<()> {
        // Top-level dispatch peeks the variant tag from the per-user
        // payload (cheaper than a full Borsh decode); per-action
        // handlers re-decode the payload to extract their own fields
        // alongside the viewing_pub_hash.
        // PRD-33 §6.4 / PRD-36 §6.5 #1: cpi-only enforcement. Without
        // this gate, anyone can call `execute(ClosePosition)` directly
        // with another user's `viewing_pub_hash` (which is public in
        // their action_payload from a prior open) and the adapter
        // would happily sign percolator's WithdrawCollateral as that
        // user's `owner_pda`. `out_vault` has no owner constraint in
        // this Accounts struct, so an attacker passes their own USDC
        // ATA and walks off with the user's collateral. Mirrors the
        // kamino-adapter cpi-only check.
        #[cfg(feature = "cpi-only")]
        let ctx = _ctx;
        #[cfg(feature = "cpi-only")]
        {
            use anchor_lang::solana_program::instruction::get_stack_height;
            use anchor_lang::solana_program::sysvar::instructions::{
                load_current_index_checked, load_instruction_at_checked,
            };
            require!(
                get_stack_height() > 1,
                PercolatorAdapterError::DirectCallRejected
            );
            let ix_sysvar = &ctx.accounts.ix_sysvar;
            let current_idx = load_current_index_checked(ix_sysvar)? as usize;
            let outer_ix = load_instruction_at_checked(current_idx, ix_sysvar)?;
            require!(
                outer_ix.program_id == B402_POOL_PROGRAM_ID,
                PercolatorAdapterError::CallerNotB402Pool
            );
        }

        match actions::peek_variant_tag(&action_payload)
            .map_err(|_| error!(PercolatorAdapterError::InvalidActionPayload))?
        {
            actions::ActionTag::Open => {
                actions::handle_open(&_ctx, in_amount, &action_payload)
            }
            actions::ActionTag::Close => {
                actions::handle_close(&_ctx, in_amount, &action_payload)
            }
        }
    }

    /// Allocate + initialize the per-slab `perp_mapping` PDA.
    ///
    /// One-shot. Caller pays rent. The adapter signs `create_account` as
    /// the PDA via `invoke_signed`, allocating exactly
    /// `PERP_MAPPING_ACCOUNT_LEN` (= 81_968 B) and assigning ownership to
    /// this program. Idempotent: reverts cleanly if already initialized.
    ///
    /// Must be called once per slab before the first `execute(OpenPosition)`
    /// for that slab. The fork harness + slice 4-γ SDK helper invoke this
    /// directly; the production pool's adapt_execute path will fold it into
    /// a lazy-init step (PRD-36 §8 follow-up).
    pub fn init_mapping(ctx: Context<InitMapping>) -> Result<()> {
        use anchor_lang::solana_program::{program::invoke_signed, system_instruction};
        use crate::mapping::PERP_MAPPING_ACCOUNT_LEN;

        let mapping_acc = &ctx.accounts.perp_mapping;
        let payer = &ctx.accounts.payer;
        let slab_key = ctx.accounts.slab.key();
        let bump = ctx.bumps.perp_mapping;

        let seeds: &[&[u8]] = &[
            SEED_B402,
            crate::pda::SEED_PERP_MAPPING,
            slab_key.as_ref(),
            &[bump],
        ];

        let rent = anchor_lang::solana_program::rent::Rent::get()?
            .minimum_balance(PERP_MAPPING_ACCOUNT_LEN);
        let create_ix = system_instruction::create_account(
            payer.key,
            mapping_acc.key,
            rent,
            PERP_MAPPING_ACCOUNT_LEN as u64,
            &crate::ID,
        );
        invoke_signed(
            &create_ix,
            &[
                payer.to_account_info(),
                mapping_acc.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
            &[seeds],
        )?;

        // Header init: zero everything (PerpMapping::from_bytes accepts an
        // all-zero account as "fresh empty"; len + count both 0).
        let mut data = mapping_acc.try_borrow_mut_data()?;
        debug_assert!(data.iter().all(|b| *b == 0));
        // Future: write a layout-version sentinel here so we can rev the
        // mapping format without losing existing accounts. v1 keeps it
        // implicit (all zeros = v1 fresh).
        let _ = &mut *data;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct InitMapping<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: slab pubkey is the seed; no on-chain read here. Layout
    /// validation happens at `execute()` time via the slab MAGIC sentinel.
    pub slab: AccountInfo<'info>,
    /// CHECK: derived + signed via invoke_signed. Will be allocated +
    /// owner-assigned by the create_account CPI. Must NOT pre-exist.
    #[account(
        mut,
        seeds = [SEED_B402, crate::pda::SEED_PERP_MAPPING, slab.key().as_ref()],
        bump,
    )]
    pub perp_mapping: AccountInfo<'info>,
    pub system_program: Program<'info, System>,
}

/// Account struct for `execute`. Variant-specific accounts (slab,
/// percolator-prog, matcher, user's percolator USDC ATA, etc.) flow
/// through `ctx.remaining_accounts` and are validated inside the
/// per-action handler in slice 3.
#[derive(Accounts)]
pub struct Execute<'info> {
    /// CHECK: PDA signer for vault transfers. Seeds checked at runtime.
    /// Mut for parity with the kamino adapter — percolator's `InitUser`
    /// uses the user (= `owner_pda`) as feePayer in some account
    /// roles, and `adapter_authority` may be needed in similar
    /// signer-writable form by future variants.
    #[account(
        mut,
        seeds = [SEED_B402, SEED_ADAPTER_AUTHORITY],
        bump,
    )]
    pub adapter_authority: UncheckedAccount<'info>,

    /// Pool's IN vault (USDC source on Open path).
    #[account(mut)]
    pub in_vault: Account<'info, TokenAccount>,

    /// Pool's OUT vault (USDC destination on Close path).
    #[account(mut)]
    pub out_vault: Account<'info, TokenAccount>,

    /// Adapter scratch USDC ATA owned by `adapter_authority`.
    #[account(
        mut,
        constraint = adapter_in_ta.owner == adapter_authority.key()
            @ PercolatorAdapterError::ScratchAtaOwnerMismatch,
    )]
    pub adapter_in_ta: Account<'info, TokenAccount>,

    /// Adapter scratch USDC ATA owned by `adapter_authority` (post-CPI sweep).
    #[account(
        mut,
        constraint = adapter_out_ta.owner == adapter_authority.key()
            @ PercolatorAdapterError::ScratchAtaOwnerMismatch,
    )]
    pub adapter_out_ta: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,

    /// CPI-only mode: the instructions sysvar lets the adapter walk the
    /// tx's outer ix and verify the caller's program_id matches
    /// `B402_POOL_PROGRAM_ID`.
    /// CHECK: address constraint pins the canonical sysvar pubkey.
    #[cfg(feature = "cpi-only")]
    #[account(address = anchor_lang::solana_program::sysvar::instructions::ID)]
    pub ix_sysvar: AccountInfo<'info>,
}

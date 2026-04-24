//! `adapt_execute_devnet` — Phase 1 pool-side composability path.
//!
//! Exercises the full `adapt_execute` plumbing minus the ZK layer:
//!   1. Adapter registry lookup (program_id + instruction discriminator).
//!   2. Pool signs `in_vault → adapter_in_ta` transfer (in_amount).
//!   3. CPI `adapter.execute` with caller-supplied raw instruction data.
//!   4. Post-CPI balance-delta invariant on `out_vault`.
//!   5. Append caller-supplied output commitment to the tree.
//!
//! What's missing vs. real `adapt_execute` (PRD-04 §3):
//!   - No proof verification. `output_commitment` is trusted from the caller.
//!   - No nullifier burn. Input tokens must already be in `in_vault` (via a
//!     prior `shield` of the input mint).
//!   - No relayer-fee deduction. Fee accounting happens once the adapt
//!     circuit is ready.
//!
//! This handler is gated behind the `adapt-devnet` crate feature. Mainnet
//! builds compile it in (Anchor's `#[program]` macro doesn't respect cfg on
//! individual fns), but the runtime `cfg!` check in `lib.rs` rejects every
//! call when the feature is off. Security property claimed here: **none**.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program::invoke_signed;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use crate::constants::{SEED_CONFIG, SEED_ADAPTERS, SEED_TOKEN, SEED_TREE, SEED_VAULT, VERSION_PREFIX};
use crate::error::PoolError;
use crate::events::CommitmentAppended;
use crate::state::{AdapterRegistry, PoolConfig, TokenConfig, TreeState};
use crate::util;

use super::shield::EncryptedNote;

/// Event emitted on successful devnet adapt. Separate from `CommitmentAppended`
/// so indexers can distinguish "output note from a composed swap" from plain
/// shield/unshield change notes.
#[event]
pub struct AdaptExecutedDevnet {
    pub adapter_program: Pubkey,
    pub in_mint: Pubkey,
    pub out_mint: Pubkey,
    pub in_amount: u64,
    pub out_delta: u64,
    pub min_out_amount: u64,
    pub slot: u64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct AdaptExecuteDevnetArgs {
    /// Amount the pool transfers `in_vault → adapter_in_ta` before calling
    /// the adapter.
    pub in_amount: u64,
    /// Pool's post-CPI delta floor on `out_vault`. Adapter's own slippage
    /// check is opaque to the pool; this is the pool's independent guard.
    pub min_out_amount: u64,
    /// Raw bytes forwarded to the adapter as `Instruction.data`. First 8
    /// bytes are the instruction discriminator, checked against the
    /// adapter's `allowed_instructions` in the registry. Remaining bytes
    /// are the adapter-specific arg layout (Anchor-serialized).
    pub raw_adapter_ix_data: Vec<u8>,
    /// Output commitment to append to the tree. In the real flow this
    /// comes from the circuit's public outputs; here it's trusted.
    pub output_commitment: [u8; 32],
    /// Ciphertext + viewing tag for the output note, emitted in
    /// `CommitmentAppended` for the recipient's scanner.
    pub encrypted_note: EncryptedNote,
}

#[derive(Accounts)]
pub struct AdaptExecuteDevnet<'info> {
    #[account(mut)]
    pub caller: Signer<'info>,

    #[account(
        seeds = [VERSION_PREFIX, SEED_CONFIG],
        bump,
    )]
    pub pool_config: Account<'info, PoolConfig>,

    #[account(
        seeds = [VERSION_PREFIX, SEED_ADAPTERS],
        bump,
    )]
    pub adapter_registry: Account<'info, AdapterRegistry>,

    #[account(
        seeds = [VERSION_PREFIX, SEED_TOKEN, token_config_in.mint.as_ref()],
        bump,
        constraint = token_config_in.enabled @ PoolError::TokenNotWhitelisted,
    )]
    pub token_config_in: Account<'info, TokenConfig>,

    #[account(
        seeds = [VERSION_PREFIX, SEED_TOKEN, token_config_out.mint.as_ref()],
        bump,
        constraint = token_config_out.enabled @ PoolError::TokenNotWhitelisted,
    )]
    pub token_config_out: Account<'info, TokenConfig>,

    #[account(
        mut,
        seeds = [VERSION_PREFIX, SEED_VAULT, token_config_in.mint.as_ref()],
        bump,
        constraint = in_vault.key() == token_config_in.vault @ PoolError::VaultMismatch,
    )]
    pub in_vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        seeds = [VERSION_PREFIX, SEED_VAULT, token_config_out.mint.as_ref()],
        bump,
        constraint = out_vault.key() == token_config_out.vault @ PoolError::VaultMismatch,
    )]
    pub out_vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        seeds = [VERSION_PREFIX, SEED_TREE],
        bump,
    )]
    pub tree_state: AccountLoader<'info, TreeState>,

    /// CHECK: validated against `adapter_registry.adapters[].program_id`.
    pub adapter_program: UncheckedAccount<'info>,

    /// CHECK: adapter's own PDA signer. Seeds / bump checked by the adapter.
    pub adapter_authority: UncheckedAccount<'info>,

    #[account(
        mut,
        constraint = adapter_in_ta.mint == token_config_in.mint @ PoolError::MintMismatch,
        constraint = adapter_in_ta.owner == adapter_authority.key(),
    )]
    pub adapter_in_ta: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = adapter_out_ta.mint == token_config_out.mint @ PoolError::MintMismatch,
        constraint = adapter_out_ta.owner == adapter_authority.key(),
    )]
    pub adapter_out_ta: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

#[inline(never)]
pub fn handler<'info>(
    ctx: Context<'_, '_, '_, 'info, AdaptExecuteDevnet<'info>>,
    args: AdaptExecuteDevnetArgs,
) -> Result<()> {
    let cfg = &ctx.accounts.pool_config;
    require!(!cfg.paused_adapts, PoolError::PoolPaused);

    require!(args.in_amount > 0, PoolError::PublicAmountExclusivity);
    require!(
        args.raw_adapter_ix_data.len() >= 8,
        PoolError::InvalidInstructionData
    );

    // 1. Registry check: adapter_program registered + enabled, and the
    // instruction discriminator we're about to forward is whitelisted.
    let adapter_key = ctx.accounts.adapter_program.key();
    let disc: [u8; 8] = args.raw_adapter_ix_data[0..8].try_into()
        .map_err(|_| error!(PoolError::InvalidInstructionData))?;
    {
        let registry = &ctx.accounts.adapter_registry;
        let info = registry.adapters.iter()
            .find(|a| a.program_id == adapter_key && a.enabled)
            .ok_or(error!(PoolError::AdapterNotRegistered))?;
        let allowed = &info.allowed_instructions[..info.allowed_instruction_count as usize];
        require!(
            allowed.iter().any(|d| *d == disc),
            PoolError::AdapterNotRegistered
        );
    }

    // 2. Pool → adapter_in_ta transfer (pool_config PDA is vault authority).
    let pool_config_info = ctx.accounts.pool_config.to_account_info();
    let signer_seeds: &[&[u8]] = &[VERSION_PREFIX, SEED_CONFIG, &[ctx.bumps.pool_config]];
    let signer = &[signer_seeds];
    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.in_vault.to_account_info(),
                to: ctx.accounts.adapter_in_ta.to_account_info(),
                authority: pool_config_info,
            },
            signer,
        ),
        args.in_amount,
    )?;

    // 3. Pre-snapshot the out_vault balance for the delta invariant.
    ctx.accounts.out_vault.reload()?;
    let pre = ctx.accounts.out_vault.amount;

    // 4. Build + CPI the adapter. Accounts forwarded: named adapter inputs
    // followed by `remaining_accounts` for downstream protocol plumbing.
    let adapter_metas: Vec<AccountMeta> = {
        let mut m = Vec::with_capacity(6 + ctx.remaining_accounts.len());
        m.push(AccountMeta::new_readonly(ctx.accounts.adapter_authority.key(), false));
        m.push(AccountMeta::new(ctx.accounts.in_vault.key(), false));
        m.push(AccountMeta::new(ctx.accounts.out_vault.key(), false));
        m.push(AccountMeta::new(ctx.accounts.adapter_in_ta.key(), false));
        m.push(AccountMeta::new(ctx.accounts.adapter_out_ta.key(), false));
        m.push(AccountMeta::new_readonly(ctx.accounts.token_program.key(), false));
        for a in ctx.remaining_accounts.iter() {
            if a.is_writable {
                m.push(AccountMeta::new(*a.key, a.is_signer));
            } else {
                m.push(AccountMeta::new_readonly(*a.key, a.is_signer));
            }
        }
        m
    };

    let mut adapter_infos: Vec<AccountInfo<'info>> = Vec::with_capacity(6 + ctx.remaining_accounts.len());
    adapter_infos.push(ctx.accounts.adapter_authority.to_account_info());
    adapter_infos.push(ctx.accounts.in_vault.to_account_info());
    adapter_infos.push(ctx.accounts.out_vault.to_account_info());
    adapter_infos.push(ctx.accounts.adapter_in_ta.to_account_info());
    adapter_infos.push(ctx.accounts.adapter_out_ta.to_account_info());
    adapter_infos.push(ctx.accounts.token_program.to_account_info());
    for a in ctx.remaining_accounts.iter() {
        adapter_infos.push(a.clone());
    }

    let ix = Instruction {
        program_id: adapter_key,
        accounts: adapter_metas,
        data: args.raw_adapter_ix_data,
    };
    invoke_signed(&ix, &adapter_infos, signer)
        .map_err(|_| error!(PoolError::AdapterCallReverted))?;

    // 5. Post-delta check.
    ctx.accounts.out_vault.reload()?;
    let post = ctx.accounts.out_vault.amount;
    let delta = post.saturating_sub(pre);
    require!(delta >= args.min_out_amount, PoolError::AdapterReturnedLessThanMin);

    // 6. Append output commitment to the tree.
    let clock = Clock::get()?;
    let (leaf_index, new_root) = {
        let mut tree = ctx.accounts.tree_state.load_mut()?;
        let leaf_index = tree.leaf_count;
        let new_root = util::tree_append(&mut tree, args.output_commitment)?;
        (leaf_index, new_root)
    };

    emit!(CommitmentAppended {
        leaf_index,
        commitment: args.output_commitment,
        ciphertext: args.encrypted_note.ciphertext,
        ephemeral_pub: args.encrypted_note.ephemeral_pub,
        viewing_tag: args.encrypted_note.viewing_tag,
        tree_root_after: new_root,
        slot: clock.slot,
    });

    emit!(AdaptExecutedDevnet {
        adapter_program: adapter_key,
        in_mint: ctx.accounts.token_config_in.mint,
        out_mint: ctx.accounts.token_config_out.mint,
        in_amount: args.in_amount,
        out_delta: delta,
        min_out_amount: args.min_out_amount,
        slot: clock.slot,
    });

    // Prevent the "unused when feature off" warning without actually
    // changing behavior — util is always referenced above.
    let _ = util::tree_has_recent_root;

    Ok(())
}

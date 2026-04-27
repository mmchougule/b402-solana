use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{Mint, Token, TokenAccount};

use crate::constants::{SEED_CONFIG, SEED_TOKEN, SEED_VAULT, VERSION_PREFIX};
use crate::events::TokenWhitelisted;
use crate::state::{PoolConfig, TokenConfig};

#[derive(Accounts)]
pub struct AddTokenConfig<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    // Admin authorization verified at handler level via PoolConfig.admin_multisig.
    // For v1 scaffold, payer must match admin_multisig; full multisig co-signer
    // pattern implemented in admin.rs::ensure_admin.
    pub admin: Signer<'info>,

    #[account(
        seeds = [VERSION_PREFIX, SEED_CONFIG],
        bump,
    )]
    pub pool_config: Account<'info, PoolConfig>,

    #[account(
        init_if_needed,
        payer = payer,
        space = TokenConfig::LEN,
        seeds = [VERSION_PREFIX, SEED_TOKEN, mint.key().as_ref()],
        bump,
    )]
    pub token_config: Account<'info, TokenConfig>,

    pub mint: Account<'info, Mint>,

    #[account(
        init_if_needed,
        payer = payer,
        token::mint = mint,
        token::authority = pool_config,
        seeds = [VERSION_PREFIX, SEED_VAULT, mint.key().as_ref()],
        bump,
    )]
    pub vault: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, Default)]
pub struct AddTokenConfigArgs {
    /// Per-mint TVL cap in smallest units. 0 == no shielding allowed
    /// (fail-closed default; admin must set explicitly via `set_max_tvl`).
    pub max_tvl: u64,
}

pub fn handler(ctx: Context<AddTokenConfig>, args: AddTokenConfigArgs) -> Result<()> {
    super::admin::ensure_admin(&ctx.accounts.pool_config, &ctx.accounts.admin.key())?;

    let clock = Clock::get()?;
    let tc = &mut ctx.accounts.token_config;
    tc.mint = ctx.accounts.mint.key();
    tc.decimals = ctx.accounts.mint.decimals;
    tc.vault = ctx.accounts.vault.key();
    tc.enabled = true;
    tc.added_at_slot = clock.slot;
    tc.max_tvl = args.max_tvl;
    tc._reserved = [0u8; 24];

    emit!(TokenWhitelisted {
        mint: tc.mint,
        decimals: tc.decimals,
        vault: tc.vault,
        slot: clock.slot,
    });

    Ok(())
}

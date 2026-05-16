use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

use crate::constants::{SEED_CONFIG, SEED_TOKEN, SEED_VAULT, VERSION_PREFIX};
use crate::events::TokenWhitelisted;
use crate::state::{PoolConfig, TokenConfig};

// Token-2022 program ID (`TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb`).
// Used to detect Token-2022 mints at registration so we know when to walk
// the extension allowlist. Hardcoded as a `const` because
// `anchor_spl::token_2022::ID` is a `static`, which would require `let`
// inside the handler — we want a free-standing constant.
const TOKEN_2022_PROGRAM_ID: Pubkey = Pubkey::new_from_array([
    0x06, 0xdd, 0xf6, 0xe1, 0xee, 0x75, 0x8f, 0xde, 0x18, 0x42, 0x5d, 0xbc, 0xe4, 0x6c, 0xcd, 0xda,
    0xb6, 0x1a, 0xfc, 0x4d, 0x83, 0xb9, 0x0d, 0x27, 0xfe, 0xbd, 0xf9, 0x28, 0xd8, 0xa1, 0x8b, 0xfc,
]);

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
    pub pool_config: Box<Account<'info, PoolConfig>>,

    #[account(
        init_if_needed,
        payer = payer,
        space = TokenConfig::LEN,
        seeds = [VERSION_PREFIX, SEED_TOKEN, mint.key().as_ref()],
        bump,
    )]
    pub token_config: Box<Account<'info, TokenConfig>>,

    // `InterfaceAccount<Mint>` accepts mints owned by either the classic SPL
    // Token program OR the Token-2022 (Token Extensions) program. The handler
    // inspects raw mint-account data to enforce the extension allowlist for
    // Token-2022 mints (no-op for classic SPL).
    pub mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(
        init_if_needed,
        payer = payer,
        token::mint = mint,
        token::authority = pool_config,
        // `token::token_program = token_program` ties vault creation to whichever
        // token program owns the mint. Anchor's `token::` constraint family is
        // shared between SPL Token + Token-2022 when used with `InterfaceAccount`.
        token::token_program = token_program,
        seeds = [VERSION_PREFIX, SEED_VAULT, mint.key().as_ref()],
        bump,
    )]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,

    pub token_program: Interface<'info, TokenInterface>,
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

    // Enforce the Token-2022 extension allowlist BEFORE writing the config.
    // For classic SPL Token mints this branch is skipped — they have no
    // extension TLV section and the parser would fail on the empty padding.
    let mint_account_info = ctx.accounts.mint.to_account_info();
    if mint_account_info.owner == &TOKEN_2022_PROGRAM_ID {
        let mint_data = mint_account_info.try_borrow_data()?;
        super::token_ext::enforce_extension_allowlist(&mint_data)?;
    }

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

use anchor_lang::prelude::*;
use anchor_lang::system_program;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token_interface::{self, InitializeAccount3, Mint, TokenInterface};

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

    /// Vault token account — PDA-derived, holds shielded balances for this mint.
    /// CHECK: not `InterfaceAccount<TokenAccount>` because `init_if_needed`
    /// inflates `try_accounts` 8 bytes past the BPF 4096-byte stack ceiling
    /// (manifests as "Access violation in stack frame 5" at runtime). Manual
    /// create + initialize_account3 in the handler keeps try_accounts lean
    /// and shifts the rent / init locals into the handler frame.
    /// PDA seeds enforced here; mint + authority + owner-program checked in
    /// the handler before any state is written.
    #[account(
        mut,
        seeds = [VERSION_PREFIX, SEED_VAULT, mint.key().as_ref()],
        bump,
    )]
    pub vault: UncheckedAccount<'info>,

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
    let is_token_2022 = mint_account_info.owner == &TOKEN_2022_PROGRAM_ID;
    if is_token_2022 {
        let mint_data = mint_account_info.try_borrow_data()?;
        super::token_ext::enforce_extension_allowlist(&mint_data)?;
    }

    // Initialize the vault token account if it doesn't exist yet. This logic
    // lives in the handler (not as `init_if_needed` on the Accounts struct)
    // because the macro-generated locals inflate `try_accounts` past BPF's
    // 4096-byte stack frame limit. Doing it here moves those locals into the
    // handler's own frame.
    if ctx.accounts.vault.data_is_empty() {
        // Owner program of the vault MUST match the mint's owner program.
        let owner_program_id = if is_token_2022 {
            TOKEN_2022_PROGRAM_ID
        } else {
            anchor_spl::token::ID
        };
        require_keys_eq!(
            ctx.accounts.token_program.key(),
            owner_program_id,
            crate::error::PoolError::MintMismatch
        );

        // Account size depends on the token program: legacy SPL Token uses
        // 165 bytes (TokenAccount::LEN), Token-2022 uses 170 bytes (base) +
        // any extension state. We only support unextended vault accounts —
        // the pool itself never enables extensions on its vault — so 170 is
        // correct for Token-2022 and 165 for classic SPL.
        let space = if is_token_2022 { 170 } else { 165 };
        let rent_lamports = Rent::get()?.minimum_balance(space);

        let mint_key = ctx.accounts.mint.key();
        let vault_bump = ctx.bumps.vault;
        let signer_seeds: &[&[u8]] = &[
            VERSION_PREFIX,
            SEED_VAULT,
            mint_key.as_ref(),
            std::slice::from_ref(&vault_bump),
        ];
        let signer = &[signer_seeds];

        // 1. system_program::create_account, payer-funded + vault-signed (PDA).
        system_program::create_account(
            CpiContext::new_with_signer(
                ctx.accounts.system_program.to_account_info(),
                system_program::CreateAccount {
                    from: ctx.accounts.payer.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                },
                signer,
            ),
            rent_lamports,
            space as u64,
            ctx.accounts.token_program.key,
        )?;

        // 2. token_interface::initialize_account3 — sets mint + authority on
        // the newly-allocated account. Works against both SPL Token and
        // Token-2022 via the Interface.
        token_interface::initialize_account3(CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            InitializeAccount3 {
                account: ctx.accounts.vault.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                authority: ctx.accounts.pool_config.to_account_info(),
            },
        ))?;
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

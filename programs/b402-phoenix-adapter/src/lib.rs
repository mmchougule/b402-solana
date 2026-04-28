//! b402_phoenix_adapter — Phoenix v1 spot CLOB adapter for the b402 shielded pool.
//!
//! **Phase A scope (PRD-24).** Single action variant: `Swap`. Phoenix v1's
//! `Swap` (instruction tag = 0) is an Immediate-Or-Cancel taker order that
//! requires no Seat, fills against the book at the current slot, and reverts
//! the entire transaction if it cannot satisfy the OrderPacket's match
//! limits. That synchronous, fill-or-revert shape maps cleanly onto the
//! PRD-04 v1 ABI's post-CPI delta check — no shadow PDA, no delta-zero
//! exemption, no two-phase claim. Phase B (`PlaceLimitOrder`, `Cancel*`,
//! `WithdrawFunds`) lives in a separate crate revision once the maker-side
//! infrastructure (PRD-13 + PRD-15) gets its first real consumer.
//!
//! ## ABI (PRD-04 §2)
//!
//! Pool calls `execute(in_amount, min_out_amount, action_payload)` after it
//! has transferred `in_amount` of `in_mint` into `adapter_in_ta`. Adapter:
//!   1. Borsh-decodes `PhoenixAction` from `action_payload`.
//!   2. Forwards the inner Phoenix `Swap` instruction data opaquely to
//!      Phoenix v1, signing as the adapter PDA.
//!   3. Sweeps both `adapter_in_ta` (any unmatched residual) and
//!      `adapter_out_ta` (matched output) back to the pool's vaults.
//!
//! Pool's post-CPI delta check enforces `out_vault.amount >= pre + min_out`.
//! If the book is shallow and Phoenix matches less than `min_out_amount`,
//! the transaction reverts whole — same shape as the Jupiter adapter's
//! slippage failure.
//!
//! ## Why opaque forwarding (vs. a typed OrderPacket field set)
//!
//! Phoenix's `OrderPacket::ImmediateOrCancel` is 100+ bytes of nested Borsh.
//! Re-encoding it inside the program adds zero security — the pool's
//! `keccak(action_payload)` proof binding makes any relayer-side tampering
//! equivalent to a forged proof — and adds a fragile maintenance surface to
//! every Phoenix SDK upgrade. The b402 SDK builds the OrderPacket via
//! `@ellipsis-labs/phoenix-sdk` off-chain; the adapter forwards the bytes
//! verbatim. Same pattern as `b402-jupiter-adapter`'s opaque route forwarding.
//!
//! ## Out of scope for this crate
//!
//! - `PlaceLimitOrder` / `Cancel*` / `WithdrawFunds` (Phase B — needs PRD-13
//!   shadow PDA + PRD-04 §7.1 delta-zero exemption).
//! - Phoenix Rise perpetuals (Phase C — gated on Phoenix publishing a public
//!   CPI surface; `docs.phoenix.trade/sdk/rise` is HTTP-first today).
//! - Mainnet-fork integration test — lives in `examples/phoenix-adapter-fork-swap.ts`
//!   in a follow-up PR; this crate's litesvm test only proves dispatch.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

declare_id!("4CRu4g1wN1WgFoHwqKUpG9apALuWDmvTLoQ5x7SiCppo");

/// Phoenix v1 program ID: PhoeNiXZ8ByJGLkxNfZRnkUfjvmuYqLR89jjFHGqdXY
/// Verified against `Ellipsis-Labs/phoenix-v1` README (2026-04-28).
/// Byte representation is base58-decoded from the address above.
pub const PHOENIX_V1_PROGRAM_ID: Pubkey = Pubkey::new_from_array([
    0x05, 0xd0, 0xea, 0x4f, 0x33, 0x73, 0x70, 0x13, 0xa5, 0x63, 0xe0, 0x93, 0x48, 0xed, 0xb6, 0xf4,
    0x59, 0x3d, 0x91, 0xfc, 0x76, 0x41, 0xf9, 0x24, 0x7c, 0x24, 0x41, 0xa8, 0x42, 0xa1, 0xbb, 0xeb,
]);

/// Phoenix v1 instruction tag for `Swap` (variant 0 in `PhoenixInstruction`).
/// Verified against the upstream `instruction.rs` enum at master (2026-04-28).
pub const PHOENIX_IX_TAG_SWAP: u8 = 0;

#[program]
pub mod b402_phoenix_adapter {
    use super::*;

    /// Execute a Phoenix v1 action.
    ///
    /// `action_payload` Borsh-decodes into [`PhoenixAction`]. For Phase A
    /// only `Swap` is accepted; any other variant is rejected at decode time.
    ///
    /// `remaining_accounts` carry the full Phoenix v1 `Swap` account list
    /// in the published order (see `PHOENIX_SWAP_ACCOUNT_COUNT`):
    ///
    /// | # | Name             | Constraint                                 |
    /// |---|------------------|--------------------------------------------|
    /// | 0 | phoenix_program  | readonly                                   |
    /// | 1 | log_authority    | readonly                                   |
    /// | 2 | market           | writable                                   |
    /// | 3 | trader           | signer (= adapter_authority)               |
    /// | 4 | base_account     | writable (= adapter_in_ta or adapter_out_ta)|
    /// | 5 | quote_account    | writable (= the other adapter scratch ATA) |
    /// | 6 | base_vault       | writable (market PDA)                      |
    /// | 7 | quote_vault      | writable (market PDA)                      |
    /// | 8 | token_program    | readonly                                   |
    pub fn execute(
        ctx: Context<Execute>,
        in_amount: u64,
        min_out_amount: u64,
        action_payload: Vec<u8>,
    ) -> Result<()> {
        // ABI sanity — match Jupiter adapter's pre-flight checks.
        require!(in_amount > 0, PhoenixAdapterError::InvalidAmount);
        require!(
            !action_payload.is_empty(),
            PhoenixAdapterError::InvalidActionPayload
        );
        require!(
            ctx.accounts.adapter_in_ta.amount >= in_amount,
            PhoenixAdapterError::InsufficientInput
        );
        require!(
            ctx.remaining_accounts.len() == PHOENIX_SWAP_ACCOUNT_COUNT,
            PhoenixAdapterError::InvalidRemainingAccounts
        );

        let action = PhoenixAction::try_from_slice(&action_payload)
            .map_err(|_| PhoenixAdapterError::InvalidActionPayload)?;

        match action {
            PhoenixAction::Swap { phoenix_ix_data } => {
                require!(
                    !phoenix_ix_data.is_empty(),
                    PhoenixAdapterError::InvalidActionPayload
                );
                require!(
                    phoenix_ix_data[0] == PHOENIX_IX_TAG_SWAP,
                    PhoenixAdapterError::WrongPhoenixIxTag
                );

                let phoenix_program_account = &ctx.remaining_accounts[0];
                require_keys_eq!(
                    *phoenix_program_account.key,
                    PHOENIX_V1_PROGRAM_ID,
                    PhoenixAdapterError::WrongPhoenixProgramId
                );

                // Snapshot pre-balances on both adapter scratch ATAs. The
                // Swap moves residual input + matched output into them; we
                // sweep the deltas back to pool vaults at the end.
                let pre_in = ctx.accounts.adapter_in_ta.amount;
                let pre_out = ctx.accounts.adapter_out_ta.amount;

                // Build the CPI ix. Forward Phoenix's account list verbatim
                // from remaining_accounts; mark the trader account (index 3)
                // as a signer because the adapter PDA signs via invoke_signed
                // for that role.
                let auth_key = ctx.accounts.adapter_authority.key();
                let metas: Vec<anchor_lang::solana_program::instruction::AccountMeta> = ctx
                    .remaining_accounts
                    .iter()
                    .map(|a| {
                        let is_signer = a.is_signer || *a.key == auth_key;
                        if a.is_writable {
                            anchor_lang::solana_program::instruction::AccountMeta::new(
                                *a.key, is_signer,
                            )
                        } else {
                            anchor_lang::solana_program::instruction::AccountMeta::new_readonly(
                                *a.key, is_signer,
                            )
                        }
                    })
                    .collect();

                let ix = anchor_lang::solana_program::instruction::Instruction {
                    program_id: PHOENIX_V1_PROGRAM_ID,
                    accounts: metas,
                    data: phoenix_ix_data,
                };

                let authority_bump = ctx.bumps.adapter_authority;
                let seeds: &[&[u8]] = &[b"b402/v1", b"adapter", &[authority_bump]];
                let signer_seeds = &[seeds];

                anchor_lang::solana_program::program::invoke_signed(
                    &ix,
                    ctx.remaining_accounts,
                    signer_seeds,
                )
                .map_err(|_| PhoenixAdapterError::PhoenixCpiFailed)?;

                // Sweep both scratch ATAs back. Phoenix's Swap can leave
                // unmatched residual in adapter_in_ta if the book lacked depth.
                let in_ta = &mut ctx.accounts.adapter_in_ta;
                in_ta.reload()?;
                let in_residual = in_ta.amount.saturating_sub(
                    // Anything below pre_in that wasn't pulled out by Phoenix
                    // (impossible under Phoenix's Swap semantics) is treated
                    // as zero-residual.
                    pre_in.saturating_sub(in_amount),
                );
                if in_residual > 0 {
                    let cpi_accounts = Transfer {
                        from: in_ta.to_account_info(),
                        to: ctx.accounts.in_vault.to_account_info(),
                        authority: ctx.accounts.adapter_authority.to_account_info(),
                    };
                    token::transfer(
                        CpiContext::new_with_signer(
                            ctx.accounts.token_program.to_account_info(),
                            cpi_accounts,
                            signer_seeds,
                        ),
                        in_residual,
                    )?;
                }

                let out_ta = &mut ctx.accounts.adapter_out_ta;
                out_ta.reload()?;
                let post_out = out_ta.amount;
                let received = post_out.saturating_sub(pre_out);
                require!(
                    received >= min_out_amount,
                    PhoenixAdapterError::SlippageExceeded
                );

                if received > 0 {
                    let cpi_accounts = Transfer {
                        from: out_ta.to_account_info(),
                        to: ctx.accounts.out_vault.to_account_info(),
                        authority: ctx.accounts.adapter_authority.to_account_info(),
                    };
                    token::transfer(
                        CpiContext::new_with_signer(
                            ctx.accounts.token_program.to_account_info(),
                            cpi_accounts,
                            signer_seeds,
                        ),
                        received,
                    )?;
                }

                Ok(())
            }
        }
    }
}

/// Phoenix v1 `Swap` requires exactly 9 accounts in the published order.
pub const PHOENIX_SWAP_ACCOUNT_COUNT: usize = 9;

/// Action variants exposed by this adapter. Borsh-encoded inside `action_payload`.
///
/// Phase A defines only `Swap`. The enum is kept variant-extensible so Phase B
/// can add `PlaceLimitOrder` / `CancelOrdersById` / `WithdrawFunds` without an
/// ABI rev — each new variant gets a fresh registry row with its own
/// allowed-instruction discriminator.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq, Eq)]
pub enum PhoenixAction {
    /// IOC taker swap. `phoenix_ix_data` is the full Phoenix v1 `Swap`
    /// instruction data: leading tag byte (0x00 = `PHOENIX_IX_TAG_SWAP`) +
    /// Borsh-encoded `OrderPacket::ImmediateOrCancel`. The b402 SDK builds
    /// this off-chain via `@ellipsis-labs/phoenix-sdk`. The adapter does
    /// not parse the OrderPacket — pool's `keccak(action_payload)` proof
    /// binding makes byte-level tampering equivalent to a forged proof.
    Swap { phoenix_ix_data: Vec<u8> },
}

#[derive(Accounts)]
pub struct Execute<'info> {
    /// CHECK: adapter PDA signer. Seeds checked at runtime.
    #[account(
        seeds = [b"b402/v1", b"adapter"],
        bump,
    )]
    pub adapter_authority: UncheckedAccount<'info>,

    /// Pool's input vault — adapter sweeps unmatched residual back here.
    #[account(mut)]
    pub in_vault: Account<'info, TokenAccount>,

    /// Pool's output vault — adapter sweeps matched output here.
    #[account(mut)]
    pub out_vault: Account<'info, TokenAccount>,

    /// Adapter-local scratch input token account. Authority = adapter PDA.
    #[account(
        mut,
        constraint = adapter_in_ta.owner == adapter_authority.key(),
    )]
    pub adapter_in_ta: Account<'info, TokenAccount>,

    /// Adapter-local scratch output token account. Authority = adapter PDA.
    #[account(
        mut,
        constraint = adapter_out_ta.owner == adapter_authority.key(),
    )]
    pub adapter_out_ta: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

#[error_code]
pub enum PhoenixAdapterError {
    #[msg("invalid amount")]
    InvalidAmount = 7000,
    #[msg("invalid action payload")]
    InvalidActionPayload = 7001,
    #[msg("insufficient input in adapter account")]
    InsufficientInput = 7002,
    #[msg("Phoenix CPI failed")]
    PhoenixCpiFailed = 7003,
    #[msg("slippage exceeded")]
    SlippageExceeded = 7004,
    #[msg("invalid number of remaining accounts for Phoenix Swap")]
    InvalidRemainingAccounts = 7005,
    #[msg("remaining_accounts[0] is not the Phoenix v1 program")]
    WrongPhoenixProgramId = 7006,
    #[msg("phoenix_ix_data does not start with PHOENIX_IX_TAG_SWAP")]
    WrongPhoenixIxTag = 7007,
}

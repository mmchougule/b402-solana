//! b402_mock_adapter — TEST/DEVNET adapter for exercising the pool's
//! balance-delta invariant and Phase 1 `adapt_execute_devnet` plumbing.
//!
//! NOT FOR MAINNET. Simulates a DeFi swap by transferring a configurable
//! amount from a pre-funded adapter scratch vault (`adapter_out_ta`) to
//! the pool's `out_vault`, letting us drive both success and failure
//! paths without external protocols.
//!
//! Unified ABI matching `b402-jupiter-adapter`:
//!   - Accounts: [adapter_authority, in_vault, out_vault, adapter_in_ta,
//!                adapter_out_ta, token_program]
//!   - Args:     (in_amount: u64, min_out_amount: u64, action_payload: Vec<u8>)
//!   - PDA seeds: [b"b402/v1", b"adapter"]  (same as every b402 adapter)
//!
//! This lets `adapt_execute_devnet` in the pool forward a uniform shape
//! to any adapter. Real adapters (Jupiter, Kamino, Drift, Orca) use the
//! same layout; only the interpretation of `action_payload` differs.
//!
//! `action_payload` layout for the mock:
//!   [0..8]  = i64 LE `delta` — transfer `min_out + delta` tokens
//!             (negative delta → under-deliver → pool rejects)

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

declare_id!("89kw33YDcbXfiayVNauz599LaDm51EuU8amWydpjYKgp");

#[program]
pub mod b402_mock_adapter {
    use super::*;

    pub fn execute(
        ctx: Context<Execute>,
        in_amount: u64,
        min_out_amount: u64,
        action_payload: Vec<u8>,
    ) -> Result<()> {
        // Sanity: adapter_in_ta should have received `in_amount` from the pool
        // before this CPI. The mock doesn't consume it — real adapters (Jupiter)
        // would swap it for the output mint. We just check it arrived.
        require!(
            ctx.accounts.adapter_in_ta.amount >= in_amount,
            MockError::InsufficientInput
        );

        require!(action_payload.len() == 8, MockError::InvalidPayload);
        let delta = i64::from_le_bytes(action_payload[..8].try_into().unwrap());

        let to_send: u64 = if delta >= 0 {
            min_out_amount.saturating_add(delta as u64)
        } else {
            let abs = (-delta) as u64;
            min_out_amount.checked_sub(abs).ok_or(MockError::Underflow)?
        };

        // Transfer `to_send` from our scratch out_ta to the pool's out_vault.
        let bump = ctx.bumps.adapter_authority;
        let seeds: &[&[u8]] = &[b"b402/v1", b"adapter", &[bump]];
        let signer = &[seeds];

        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.adapter_out_ta.to_account_info(),
                    to: ctx.accounts.out_vault.to_account_info(),
                    authority: ctx.accounts.adapter_authority.to_account_info(),
                },
                signer,
            ),
            to_send,
        )?;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Execute<'info> {
    /// CHECK: adapter PDA signer. Seeds checked at runtime.
    #[account(
        seeds = [b"b402/v1", b"adapter"],
        bump,
    )]
    pub adapter_authority: UncheckedAccount<'info>,

    /// Pool's input vault — mock doesn't touch, kept for ABI parity.
    #[account(mut)]
    pub in_vault: Account<'info, TokenAccount>,

    /// Pool's output vault — mock deposits to here.
    #[account(mut)]
    pub out_vault: Account<'info, TokenAccount>,

    /// Adapter's scratch input TA — pool pre-transfers in_amount here.
    #[account(
        mut,
        constraint = adapter_in_ta.owner == adapter_authority.key(),
    )]
    pub adapter_in_ta: Account<'info, TokenAccount>,

    /// Adapter's scratch output TA — pre-funded with `out_mint` supply.
    /// In real adapters this gets filled by the downstream protocol CPI.
    #[account(
        mut,
        constraint = adapter_out_ta.owner == adapter_authority.key(),
    )]
    pub adapter_out_ta: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

#[error_code]
pub enum MockError {
    #[msg("invalid payload length")]                  InvalidPayload     = 4000,
    #[msg("underflow computing output")]              Underflow          = 4001,
    #[msg("adapter_in_ta has insufficient balance")]  InsufficientInput  = 4002,
}

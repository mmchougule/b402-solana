//! b402_mock_adapter — TEST-ONLY adapter for exercising the pool's
//! balance-delta invariant.
//!
//! NOT FOR MAINNET. Simulates a DeFi swap by transferring a configurable
//! amount from a pre-funded adapter supply vault to a target vault,
//! letting us drive both the "returns exactly min_out" and
//! "returns less than min_out" paths against `check_adapter_delta_mock`.
//!
//! `action_payload` layout:
//!   [0..8]  = i64 LE `delta` — transfer `min_out + delta` tokens
//!             (negative delta → under-deliver → pool rejects)

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

declare_id!("9RsayAuGPpxBrbuDdT5tnxKMKnsL8CSpGKwcrGjKvfHx");

#[program]
pub mod b402_mock_adapter {
    use super::*;

    pub fn execute(
        ctx: Context<Execute>,
        min_out_amount: u64,
        action_payload: Vec<u8>,
    ) -> Result<()> {
        require!(action_payload.len() == 8, MockError::InvalidPayload);
        let delta = i64::from_le_bytes(action_payload[..8].try_into().unwrap());

        let to_send: u64 = if delta >= 0 {
            min_out_amount.saturating_add(delta as u64)
        } else {
            let abs = (-delta) as u64;
            min_out_amount.checked_sub(abs).ok_or(MockError::Underflow)?
        };

        // Transfer from the pre-funded adapter supply vault to the pool's
        // out_vault. Adapter PDA signs for its vault.
        let bump = ctx.bumps.adapter_authority;
        let seeds: &[&[u8]] = &[b"b402-mock-adapter", &[bump]];
        let signer = &[seeds];

        let cpi = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.adapter_supply.to_account_info(),
                to: ctx.accounts.pool_out_vault.to_account_info(),
                authority: ctx.accounts.adapter_authority.to_account_info(),
            },
            signer,
        );
        token::transfer(cpi, to_send)?;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Execute<'info> {
    /// CHECK: adapter PDA signer; owns adapter_supply.
    #[account(
        seeds = [b"b402-mock-adapter"],
        bump,
    )]
    pub adapter_authority: UncheckedAccount<'info>,

    #[account(mut, token::authority = adapter_authority)]
    pub adapter_supply: Account<'info, TokenAccount>,

    #[account(mut)]
    pub pool_out_vault: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

#[error_code]
pub enum MockError {
    #[msg("invalid payload length")] InvalidPayload = 4000,
    #[msg("underflow computing output")] Underflow = 4001,
}

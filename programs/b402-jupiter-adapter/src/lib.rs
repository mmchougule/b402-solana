//! b402_jupiter_adapter — Jupiter V6 swap adapter for the b402 shielded pool.
//!
//! Called by b402_pool via CPI after tokens have been moved into this adapter's
//! input token account. The adapter constructs a Jupiter V6 `route` CPI using
//! the route_plan passed in `action_payload`, then transfers the resulting
//! output tokens back to the pool's output vault.
//!
//! ABI per PRD-04 §2. Post-CPI balance check is performed by the pool — this
//! adapter is trusted only to try hard; it is NOT trusted to report honestly.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

declare_id!("3RHRcbinCmcj8JPBfVxb9FW76oh4r8y21aSx4JFy3yx7");

/// Jupiter V6 program ID: JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4
pub const JUPITER_V6_PROGRAM_ID: Pubkey = Pubkey::new_from_array([
    0x04, 0x79, 0xd5, 0x5b, 0xf2, 0x31, 0xc0, 0x6e, 0xee, 0x74, 0xc5, 0x6e, 0xce, 0x68, 0x15, 0x07,
    0xfd, 0xb1, 0xb2, 0xde, 0xa3, 0xf4, 0x8e, 0x51, 0x02, 0xb1, 0xcd, 0xa2, 0x56, 0xbc, 0x13, 0x8f,
]);

#[program]
pub mod b402_jupiter_adapter {
    use super::*;

    /// Execute a Jupiter swap.
    ///
    /// `action_payload` layout:
    ///   [0..8]      = instruction discriminator we'll forward to Jupiter
    ///   [8..N]      = Jupiter-V6 route instruction data (opaque, forwarded)
    ///
    /// `remaining_accounts` carry all the Jupiter-side accounts the route needs.
    pub fn execute(
        ctx: Context<Execute>,
        in_amount: u64,
        min_out_amount: u64,
        action_payload: Vec<u8>,
    ) -> Result<()> {
        // Sanity.
        require!(in_amount > 0, AdapterError::InvalidAmount);
        require!(action_payload.len() >= 8, AdapterError::InvalidPayload);
        require!(
            ctx.accounts.adapter_in_ta.amount >= in_amount,
            AdapterError::InsufficientInput
        );

        let pre_out = ctx.accounts.adapter_out_ta.amount;

        // Build CPI instruction for Jupiter.
        let accounts_for_cpi: Vec<anchor_lang::solana_program::instruction::AccountMeta> =
            ctx.remaining_accounts.iter().map(|a| {
                if a.is_writable {
                    anchor_lang::solana_program::instruction::AccountMeta::new(*a.key, a.is_signer)
                } else {
                    anchor_lang::solana_program::instruction::AccountMeta::new_readonly(*a.key, a.is_signer)
                }
            }).collect();

        let ix = anchor_lang::solana_program::instruction::Instruction {
            program_id: JUPITER_V6_PROGRAM_ID,
            accounts: accounts_for_cpi,
            data: action_payload.clone(),
        };

        // Invoke with adapter authority as a signer for the source-TA transfer that
        // Jupiter will perform. Adapter is the authority over adapter_in_ta.
        let authority_bump = ctx.bumps.adapter_authority;
        let seeds: &[&[u8]] = &[b"b402/v1", b"adapter", &[authority_bump]];
        let signer_seeds = &[seeds];

        anchor_lang::solana_program::program::invoke_signed(
            &ix,
            ctx.remaining_accounts,
            signer_seeds,
        ).map_err(|_| AdapterError::JupiterCpiFailed)?;

        // Refresh adapter_out_ta and transfer net output to pool's out_vault.
        let out_ta = &mut ctx.accounts.adapter_out_ta;
        out_ta.reload()?;
        let post_out = out_ta.amount;
        let received = post_out.saturating_sub(pre_out);
        require!(received >= min_out_amount, AdapterError::SlippageExceeded);

        // Transfer all of the received amount to pool's out_vault.
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

    /// Pool's input vault (post-transfer from pool to here is via `adapter_in_ta`).
    #[account(mut)]
    pub in_vault: Account<'info, TokenAccount>,

    /// Pool's output vault — adapter deposits net output here.
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
pub enum AdapterError {
    #[msg("invalid amount")]
    InvalidAmount = 3000,
    #[msg("invalid payload")]
    InvalidPayload = 3001,
    #[msg("insufficient input in adapter account")]
    InsufficientInput = 3002,
    #[msg("Jupiter CPI failed")]
    JupiterCpiFailed = 3003,
    #[msg("slippage exceeded")]
    SlippageExceeded = 3004,
}

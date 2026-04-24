//! `check_adapter_delta_mock` — TEST-ONLY stub that exercises the
//! balance-delta invariant of the real `adapt_execute` flow without the
//! ZK/nullifier machinery.
//!
//! TRACK: deferred. See BUILD-STATE.md §"adapt_execute deferred".
//!
//! The full `adapt_execute` (PRD-04) will:
//!   1. Verify an `adapt` circuit proof (transact + action_hash binding).
//!   2. Burn input nullifiers, spend input notes.
//!   3. Snapshot `out_vault.amount`, CPI the adapter, read post-balance.
//!   4. Assert `post - pre >= expected_out_value` or revert.
//!   5. Append output commitment.
//!
//! This stub does only step 3 (the invariant we want to test) with a
//! CPI into an arbitrary adapter program. No proof, no notes, no state
//! change besides what the adapter does. Unsafe for mainnet; never
//! enable without a feature guard.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::Instruction;
use anchor_lang::solana_program::program::invoke;
use anchor_spl::token::TokenAccount;

use crate::error::PoolError;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct CheckAdapterDeltaArgs {
    /// Amount the pool "transfers" to the adapter — unused by the mock,
    /// included to match the unified adapter ABI `execute(in_amount,
    /// min_out, payload)` that real adapters (Jupiter, etc.) expect.
    pub in_amount: u64,
    /// Amount the pool asks the adapter to produce.
    pub expected_out_value: u64,
    /// Opaque payload forwarded to the adapter.
    pub action_payload: Vec<u8>,
}

#[derive(Accounts)]
pub struct CheckAdapterDeltaMock<'info> {
    #[account(mut)]
    pub caller: Signer<'info>,

    /// The vault whose balance delta we measure.
    #[account(mut)]
    pub out_vault: Account<'info, TokenAccount>,

    /// CHECK: the adapter program to invoke. Registry-based validation
    /// happens in the real `adapt_execute`.
    pub adapter_program: UncheckedAccount<'info>,
}

#[inline(never)]
pub fn handler(
    ctx: Context<CheckAdapterDeltaMock>,
    args: CheckAdapterDeltaArgs,
) -> Result<()> {
    // 1. Snapshot pre-balance.
    ctx.accounts.out_vault.reload()?;
    let pre = ctx.accounts.out_vault.amount;

    // 2. Build the adapter instruction. Unified ABI:
    //   execute(in_amount: u64, min_out_amount: u64, action_payload: Vec<u8>)
    //
    // Anchor wire: discriminator || u64 LE || u64 LE || u32 LE len || bytes.
    // Discriminator = sha256("global:execute")[0..8].
    const EXECUTE_DISCRIMINATOR: [u8; 8] = [130, 221, 242, 154, 13, 193, 189, 29];

    let mut data: Vec<u8> = Vec::with_capacity(8 + 8 + 8 + 4 + args.action_payload.len());
    data.extend_from_slice(&EXECUTE_DISCRIMINATOR);
    data.extend_from_slice(&args.in_amount.to_le_bytes());
    data.extend_from_slice(&args.expected_out_value.to_le_bytes());
    data.extend_from_slice(&(args.action_payload.len() as u32).to_le_bytes());
    data.extend_from_slice(&args.action_payload);

    // Forward all remaining accounts to the adapter. Caller arranges them in
    // the exact order the adapter expects.
    let account_metas: Vec<AccountMeta> = ctx.remaining_accounts.iter().map(|a| {
        if a.is_writable {
            AccountMeta::new(*a.key, a.is_signer)
        } else {
            AccountMeta::new_readonly(*a.key, a.is_signer)
        }
    }).collect();

    let ix = Instruction {
        program_id: *ctx.accounts.adapter_program.key,
        accounts: account_metas,
        data,
    };

    invoke(&ix, ctx.remaining_accounts)
        .map_err(|_| error!(PoolError::AdapterCallReverted))?;

    // 3. Post-CPI balance delta check — the invariant.
    ctx.accounts.out_vault.reload()?;
    let post = ctx.accounts.out_vault.amount;
    let delta = post.saturating_sub(pre);

    require!(
        delta >= args.expected_out_value,
        PoolError::AdapterReturnedLessThanMin
    );

    Ok(())
}

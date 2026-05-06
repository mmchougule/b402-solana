//! CPI builders for percolator-prog ixs.
//!
//! Two layers per ix:
//!   1. `build_*_ix` — pure: emits a Solana `Instruction` (program_id +
//!      account metas + ix data). Testable byte-for-byte against
//!      synthetic pubkey fixtures.
//!   2. `invoke_*` — runtime: wraps `build_*_ix` with `invoke_signed`,
//!      passing the `AccountInfo<'info>` array + `owner_pda` signer
//!      seeds. Not unit-testable; covered by surfpool integration in
//!      slice 5.
//!
//! Account-meta order pinned against percolator-prog source — see
//! `percolator-prog/src/percolator.rs` for the corresponding handler.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program::invoke_signed;

use crate::percolator_ix::{
    build_deposit_collateral_data, build_init_user_data, build_trade_cpi_data,
    build_withdraw_collateral_data,
};

// ─── InitUser ───────────────────────────────────────────────────────────

/// Build the `InitUser` ix for a percolator-prog deployment.
///
/// Account layout (mirrors `percolator-prog/src/percolator.rs:5275`):
///   [0] user (signer, writable)         — `owner_pda` for our adapter
///   [1] slab (writable)
///   [2] user_ata (writable)              — owner_pda's USDC ATA on percolator
///   [3] vault (writable)                 — percolator's slab USDC vault PDA
///   [4] token_program
///   [5] clock_sysvar
#[allow(clippy::too_many_arguments)]
pub fn build_init_user_ix(
    percolator_program_id: &Pubkey,
    owner_pda: &Pubkey,
    slab: &Pubkey,
    user_ata: &Pubkey,
    vault: &Pubkey,
    token_program: &Pubkey,
    clock: &Pubkey,
    fee_payment: u64,
) -> Instruction {
    Instruction {
        program_id: *percolator_program_id,
        accounts: vec![
            AccountMeta::new(*owner_pda, true),
            AccountMeta::new(*slab, false),
            AccountMeta::new(*user_ata, false),
            AccountMeta::new(*vault, false),
            AccountMeta::new_readonly(*token_program, false),
            AccountMeta::new_readonly(*clock, false),
        ],
        data: build_init_user_data(fee_payment),
    }
}

#[allow(clippy::too_many_arguments)]
pub fn invoke_init_user<'info>(
    percolator_program: &AccountInfo<'info>,
    owner_pda: &AccountInfo<'info>,
    slab: &AccountInfo<'info>,
    user_ata: &AccountInfo<'info>,
    vault: &AccountInfo<'info>,
    token_program: &AccountInfo<'info>,
    clock: &AccountInfo<'info>,
    fee_payment: u64,
    owner_signer_seeds: &[&[&[u8]]],
) -> Result<()> {
    let ix = build_init_user_ix(
        percolator_program.key,
        owner_pda.key,
        slab.key,
        user_ata.key,
        vault.key,
        token_program.key,
        clock.key,
        fee_payment,
    );
    invoke_signed(
        &ix,
        &[
            owner_pda.clone(),
            slab.clone(),
            user_ata.clone(),
            vault.clone(),
            token_program.clone(),
            clock.clone(),
            percolator_program.clone(),
        ],
        owner_signer_seeds,
    )?;
    Ok(())
}

// ─── DepositCollateral ──────────────────────────────────────────────────

/// `DepositCollateral` shares the 6-account layout of `InitUser`. Only
/// the ix data tag + args differ.
#[allow(clippy::too_many_arguments)]
pub fn build_deposit_collateral_ix(
    percolator_program_id: &Pubkey,
    owner_pda: &Pubkey,
    slab: &Pubkey,
    user_ata: &Pubkey,
    vault: &Pubkey,
    token_program: &Pubkey,
    clock: &Pubkey,
    user_idx: u16,
    amount: u64,
) -> Instruction {
    Instruction {
        program_id: *percolator_program_id,
        accounts: vec![
            AccountMeta::new(*owner_pda, true),
            AccountMeta::new(*slab, false),
            AccountMeta::new(*user_ata, false),
            AccountMeta::new(*vault, false),
            AccountMeta::new_readonly(*token_program, false),
            AccountMeta::new_readonly(*clock, false),
        ],
        data: build_deposit_collateral_data(user_idx, amount),
    }
}

#[allow(clippy::too_many_arguments)]
pub fn invoke_deposit_collateral<'info>(
    percolator_program: &AccountInfo<'info>,
    owner_pda: &AccountInfo<'info>,
    slab: &AccountInfo<'info>,
    user_ata: &AccountInfo<'info>,
    vault: &AccountInfo<'info>,
    token_program: &AccountInfo<'info>,
    clock: &AccountInfo<'info>,
    user_idx: u16,
    amount: u64,
    owner_signer_seeds: &[&[&[u8]]],
) -> Result<()> {
    let ix = build_deposit_collateral_ix(
        percolator_program.key,
        owner_pda.key,
        slab.key,
        user_ata.key,
        vault.key,
        token_program.key,
        clock.key,
        user_idx,
        amount,
    );
    invoke_signed(
        &ix,
        &[
            owner_pda.clone(),
            slab.clone(),
            user_ata.clone(),
            vault.clone(),
            token_program.clone(),
            clock.clone(),
            percolator_program.clone(),
        ],
        owner_signer_seeds,
    )?;
    Ok(())
}

// ─── WithdrawCollateral ─────────────────────────────────────────────────

#[allow(clippy::too_many_arguments)]
pub fn build_withdraw_collateral_ix(
    percolator_program_id: &Pubkey,
    owner_pda: &Pubkey,
    slab: &Pubkey,
    user_ata: &Pubkey,
    vault: &Pubkey,
    token_program: &Pubkey,
    clock: &Pubkey,
    user_idx: u16,
    amount: u64,
) -> Instruction {
    Instruction {
        program_id: *percolator_program_id,
        accounts: vec![
            AccountMeta::new(*owner_pda, true),
            AccountMeta::new(*slab, false),
            AccountMeta::new(*user_ata, false),
            AccountMeta::new(*vault, false),
            AccountMeta::new_readonly(*token_program, false),
            AccountMeta::new_readonly(*clock, false),
        ],
        data: build_withdraw_collateral_data(user_idx, amount),
    }
}

#[allow(clippy::too_many_arguments)]
pub fn invoke_withdraw_collateral<'info>(
    percolator_program: &AccountInfo<'info>,
    owner_pda: &AccountInfo<'info>,
    slab: &AccountInfo<'info>,
    user_ata: &AccountInfo<'info>,
    vault: &AccountInfo<'info>,
    token_program: &AccountInfo<'info>,
    clock: &AccountInfo<'info>,
    user_idx: u16,
    amount: u64,
    owner_signer_seeds: &[&[&[u8]]],
) -> Result<()> {
    let ix = build_withdraw_collateral_ix(
        percolator_program.key,
        owner_pda.key,
        slab.key,
        user_ata.key,
        vault.key,
        token_program.key,
        clock.key,
        user_idx,
        amount,
    );
    invoke_signed(
        &ix,
        &[
            owner_pda.clone(),
            slab.clone(),
            user_ata.clone(),
            vault.clone(),
            token_program.clone(),
            clock.clone(),
            percolator_program.clone(),
        ],
        owner_signer_seeds,
    )?;
    Ok(())
}

// ─── TradeCpi ───────────────────────────────────────────────────────────

/// Build the `TradeCpi` ix.
///
/// Account layout (mirrors `percolator-prog/src/percolator.rs:6610`):
///   [0]  user (signer)              — owner_pda
///   [1]  lp_owner (non-signer)
///   [2]  slab (writable)
///   [3]  clock
///   [4]  oracle
///   [5]  matcher_program
///   [6]  matcher_context (writable)
///   [7]  lp_pda
///   [8..] variadic tail forwarded verbatim to the matcher CPI
#[allow(clippy::too_many_arguments)]
pub fn build_trade_cpi_ix(
    percolator_program_id: &Pubkey,
    owner_pda: &Pubkey,
    lp_owner: &Pubkey,
    slab: &Pubkey,
    clock: &Pubkey,
    oracle: &Pubkey,
    matcher_program: &Pubkey,
    matcher_context: &Pubkey,
    lp_pda: &Pubkey,
    matcher_tail_metas: &[AccountMeta],
    lp_idx: u16,
    user_idx: u16,
    size_e6: i128,
    limit_price_e6: u64,
) -> Instruction {
    let mut accounts = Vec::with_capacity(8 + matcher_tail_metas.len());
    accounts.push(AccountMeta::new(*owner_pda, true));
    accounts.push(AccountMeta::new_readonly(*lp_owner, false));
    accounts.push(AccountMeta::new(*slab, false));
    accounts.push(AccountMeta::new_readonly(*clock, false));
    accounts.push(AccountMeta::new_readonly(*oracle, false));
    accounts.push(AccountMeta::new_readonly(*matcher_program, false));
    accounts.push(AccountMeta::new(*matcher_context, false));
    accounts.push(AccountMeta::new_readonly(*lp_pda, false));
    accounts.extend_from_slice(matcher_tail_metas);
    Instruction {
        program_id: *percolator_program_id,
        accounts,
        data: build_trade_cpi_data(lp_idx, user_idx, size_e6, limit_price_e6),
    }
}

#[allow(clippy::too_many_arguments)]
pub fn invoke_trade_cpi<'info>(
    percolator_program: &AccountInfo<'info>,
    owner_pda: &AccountInfo<'info>,
    lp_owner: &AccountInfo<'info>,
    slab: &AccountInfo<'info>,
    clock: &AccountInfo<'info>,
    oracle: &AccountInfo<'info>,
    matcher_program: &AccountInfo<'info>,
    matcher_context: &AccountInfo<'info>,
    lp_pda: &AccountInfo<'info>,
    matcher_tail: &[AccountInfo<'info>],
    lp_idx: u16,
    user_idx: u16,
    size_e6: i128,
    limit_price_e6: u64,
    owner_signer_seeds: &[&[&[u8]]],
) -> Result<()> {
    // Pass-through metas — preserve signer/writable flags from the
    // outer transaction. The wrapper does NOT interpret the tail; the
    // matcher checks key/owner/signer flags on what it uses.
    let tail_metas: Vec<AccountMeta> = matcher_tail
        .iter()
        .map(|a| {
            if a.is_writable {
                AccountMeta::new(*a.key, a.is_signer)
            } else {
                AccountMeta::new_readonly(*a.key, a.is_signer)
            }
        })
        .collect();
    let ix = build_trade_cpi_ix(
        percolator_program.key,
        owner_pda.key,
        lp_owner.key,
        slab.key,
        clock.key,
        oracle.key,
        matcher_program.key,
        matcher_context.key,
        lp_pda.key,
        &tail_metas,
        lp_idx,
        user_idx,
        size_e6,
        limit_price_e6,
    );
    let mut infos: Vec<AccountInfo<'info>> = Vec::with_capacity(9 + matcher_tail.len());
    infos.push(owner_pda.clone());
    infos.push(lp_owner.clone());
    infos.push(slab.clone());
    infos.push(clock.clone());
    infos.push(oracle.clone());
    infos.push(matcher_program.clone());
    infos.push(matcher_context.clone());
    infos.push(lp_pda.clone());
    for ai in matcher_tail {
        infos.push(ai.clone());
    }
    infos.push(percolator_program.clone());
    invoke_signed(&ix, &infos, owner_signer_seeds)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pk(b: u8) -> Pubkey {
        Pubkey::new_from_array([b; 32])
    }

    fn token_program() -> Pubkey {
        anchor_spl::token::ID
    }

    #[test]
    fn init_user_ix_account_order_and_flags() {
        let ix = build_init_user_ix(
            &pk(1), &pk(2), &pk(3), &pk(4), &pk(5), &token_program(), &pk(7), 100,
        );
        assert_eq!(ix.program_id, pk(1));
        assert_eq!(ix.accounts.len(), 6);
        // [0] owner_pda — signer + writable
        assert_eq!(ix.accounts[0].pubkey, pk(2));
        assert!(ix.accounts[0].is_signer);
        assert!(ix.accounts[0].is_writable);
        // [1] slab — writable, non-signer
        assert!(ix.accounts[1].is_writable);
        assert!(!ix.accounts[1].is_signer);
        // [2] user_ata — writable
        assert!(ix.accounts[2].is_writable);
        // [3] vault — writable
        assert!(ix.accounts[3].is_writable);
        // [4] token_program — readonly
        assert!(!ix.accounts[4].is_writable);
        assert!(!ix.accounts[4].is_signer);
        // [5] clock — readonly
        assert!(!ix.accounts[5].is_writable);
    }

    #[test]
    fn init_user_ix_data_carries_fee_payment() {
        let ix = build_init_user_ix(
            &pk(1), &pk(2), &pk(3), &pk(4), &pk(5), &token_program(), &pk(7), 0xdead_beef,
        );
        // tag 1 + 8B fee_payment LE
        assert_eq!(ix.data[0], 1);
        assert_eq!(&ix.data[1..9], &0xdead_beef_u64.to_le_bytes());
    }

    #[test]
    fn deposit_collateral_ix_shares_layout_with_init_user() {
        let init = build_init_user_ix(
            &pk(1), &pk(2), &pk(3), &pk(4), &pk(5), &token_program(), &pk(7), 0,
        );
        let dep = build_deposit_collateral_ix(
            &pk(1), &pk(2), &pk(3), &pk(4), &pk(5), &token_program(), &pk(7), 0, 0,
        );
        // Same account list (just different ix data).
        assert_eq!(init.accounts, dep.accounts);
    }

    #[test]
    fn withdraw_collateral_ix_account_layout() {
        let ix = build_withdraw_collateral_ix(
            &pk(1), &pk(2), &pk(3), &pk(4), &pk(5), &token_program(), &pk(7), 5, 999,
        );
        assert_eq!(ix.accounts.len(), 6);
        assert_eq!(ix.data[0], 4);
        assert_eq!(&ix.data[1..3], &5u16.to_le_bytes());
        assert_eq!(&ix.data[3..11], &999u64.to_le_bytes());
    }

    #[test]
    fn trade_cpi_ix_account_layout_no_tail() {
        let ix = build_trade_cpi_ix(
            &pk(1),  // percolator_program
            &pk(2),  // owner_pda
            &pk(3),  // lp_owner
            &pk(4),  // slab
            &pk(5),  // clock
            &pk(6),  // oracle
            &pk(7),  // matcher_program
            &pk(8),  // matcher_context
            &pk(9),  // lp_pda
            &[],
            5, 17, 1_500_000, 200_000_000,
        );
        assert_eq!(ix.program_id, pk(1));
        assert_eq!(ix.accounts.len(), 8);
        // Owner is signer + writable
        assert!(ix.accounts[0].is_signer);
        assert!(ix.accounts[0].is_writable);
        // lp_owner non-signer (matcher delegated)
        assert!(!ix.accounts[1].is_signer);
        // slab writable
        assert!(ix.accounts[2].is_writable);
        // matcher_context writable
        assert!(ix.accounts[6].is_writable);
        // others readonly
        assert!(!ix.accounts[3].is_writable);
        assert!(!ix.accounts[4].is_writable);
        assert!(!ix.accounts[5].is_writable);
        assert!(!ix.accounts[7].is_writable);
    }

    #[test]
    fn trade_cpi_ix_extends_with_matcher_tail() {
        let tail = vec![
            AccountMeta::new(pk(20), false),
            AccountMeta::new_readonly(pk(21), false),
        ];
        let ix = build_trade_cpi_ix(
            &pk(1), &pk(2), &pk(3), &pk(4), &pk(5), &pk(6), &pk(7), &pk(8), &pk(9),
            &tail, 0, 0, 1, 0,
        );
        assert_eq!(ix.accounts.len(), 10);
        assert_eq!(ix.accounts[8].pubkey, pk(20));
        assert!(ix.accounts[8].is_writable);
        assert_eq!(ix.accounts[9].pubkey, pk(21));
        assert!(!ix.accounts[9].is_writable);
    }

    #[test]
    fn trade_cpi_ix_data_pin() {
        let ix = build_trade_cpi_ix(
            &pk(1), &pk(2), &pk(3), &pk(4), &pk(5), &pk(6), &pk(7), &pk(8), &pk(9),
            &[], 7, 13, -42_i128, 250_000_000,
        );
        assert_eq!(ix.data[0], 10); // TradeCpi tag
        assert_eq!(&ix.data[1..3], &7u16.to_le_bytes());
        assert_eq!(&ix.data[3..5], &13u16.to_le_bytes());
        assert_eq!(&ix.data[5..21], &(-42_i128).to_le_bytes());
        assert_eq!(&ix.data[21..29], &250_000_000_u64.to_le_bytes());
    }
}

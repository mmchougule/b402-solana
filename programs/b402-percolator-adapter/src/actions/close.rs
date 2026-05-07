//! `ClosePosition` action handler — full implementation (slice 3b).
//!
//! Drives the close path:
//!
//!   1. Decode per-user payload → `(viewing_pub_hash, PercolatorAction)`
//!   2. Validate args (close path: `in_amount == 0`, `lp_idx` in range)
//!   3. Resolve + verify `owner_pda`, mapping PDA
//!   4. Verify slab MAGIC
//!   5. Look up `user_idx` in mapping (must exist as a live entry)
//!   6. Stale-entry guard: `slab.accounts[user_idx].owner == owner_pda`
//!   7. Read current `position_basis_q` from slab. If non-zero, invoke
//!      `TradeCpi { lp_idx, size = -position, limit_price_e6 }` to
//!      flatten through the matcher.
//!   8. Read `capital` from slab (post-PnL). If non-zero, invoke
//!      `WithdrawCollateral { user_idx, amount = capital }`. The
//!      withdraw lands USDC at the user's percolator USDC ATA.
//!   9. Token transfer: user's percolator USDC ATA → `adapter_out_ta`
//!      (signed by `owner_pda`).
//!  10. `mapping.record_close(viewing_pub_hash)` — release the slot
//!      for reuse.
//!
//! Variadic `remaining_accounts` layout matches the open path's
//! `RA_*` constants (re-exported here for callers).

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Transfer};

use crate::actions::open::{
    RA_CLOCK, RA_LP_OWNER, RA_LP_PDA, RA_MAPPING, RA_MATCHER_CONTEXT, RA_MATCHER_PROGRAM,
    RA_MATCHER_TAIL_START, RA_ORACLE, RA_OWNER_PDA, RA_PERCOLATOR_PROGRAM, RA_SLAB,
    RA_SLAB_VAULT, RA_SLAB_VAULT_AUTHORITY, RA_USER_PERCOLATOR_ATA,
};
use crate::actions::validate_lp_idx;
use crate::cpi as percolator_cpi;
use crate::error::PercolatorAdapterError;
use crate::mapping::{PerpMapping, PerpMappingRead};
use crate::payload::{decode_per_user_payload, PercolatorAction};
use crate::pda::{derive_owner_pda, derive_perp_mapping, SEED_B402, SEED_PERP_OWNER};
use crate::slab as slab_mod;
use crate::Execute;

pub fn handle_close<'info>(
    ctx: &Context<'_, '_, '_, 'info, Execute<'info>>,
    in_amount: u64,
    action_payload: &[u8],
) -> Result<()> {
    // 1. Decode + validate
    let (viewing_pub_hash, action) = decode_per_user_payload(action_payload)
        .map_err(|_| error!(PercolatorAdapterError::InvalidActionPayload))?;
    let (lp_idx, limit_price_e6) =
        validate_close_args(&action, in_amount).map_err(|e| error!(e))?;

    // 2. Pull remaining_accounts at pinned offsets
    require!(
        ctx.remaining_accounts.len() >= RA_MATCHER_TAIL_START,
        PercolatorAdapterError::InvalidActionPayload
    );
    let mapping_acc = &ctx.remaining_accounts[RA_MAPPING];
    let owner_pda_acc = &ctx.remaining_accounts[RA_OWNER_PDA];
    let user_pcl_ata = &ctx.remaining_accounts[RA_USER_PERCOLATOR_ATA];
    let slab_acc = &ctx.remaining_accounts[RA_SLAB];
    let slab_vault = &ctx.remaining_accounts[RA_SLAB_VAULT];
    let percolator_program = &ctx.remaining_accounts[RA_PERCOLATOR_PROGRAM];
    let clock = &ctx.remaining_accounts[RA_CLOCK];
    let lp_owner = &ctx.remaining_accounts[RA_LP_OWNER];
    let oracle = &ctx.remaining_accounts[RA_ORACLE];
    let matcher_program = &ctx.remaining_accounts[RA_MATCHER_PROGRAM];
    let matcher_context = &ctx.remaining_accounts[RA_MATCHER_CONTEXT];
    let lp_pda = &ctx.remaining_accounts[RA_LP_PDA];
    let slab_vault_authority = &ctx.remaining_accounts[RA_SLAB_VAULT_AUTHORITY];
    let matcher_tail = if ctx.remaining_accounts.len() > RA_MATCHER_TAIL_START {
        &ctx.remaining_accounts[RA_MATCHER_TAIL_START..]
    } else {
        &[][..]
    };
    let token_program_ai = ctx.accounts.token_program.to_account_info();

    // 3. Verify slab MAGIC
    {
        let slab_data = slab_acc.try_borrow_data()?;
        slab_mod::verify_slab_magic(&slab_data)
            .map_err(|_| error!(PercolatorAdapterError::InvalidActionPayload))?;
    }

    // 4. Resolve + verify owner_pda
    let (expected_owner, owner_bump) = derive_owner_pda(&crate::ID, &viewing_pub_hash);
    require_keys_eq!(
        *owner_pda_acc.key,
        expected_owner,
        PercolatorAdapterError::InvalidActionPayload
    );

    // 5. Resolve + verify mapping PDA
    let (expected_mapping, _mapping_bump) =
        derive_perp_mapping(&crate::ID, slab_acc.key);
    require_keys_eq!(
        *mapping_acc.key,
        expected_mapping,
        PercolatorAdapterError::InvalidActionPayload
    );

    // 6. Look up user_idx in mapping. Must exist as a live entry.
    let user_idx = {
        let mapping_data = mapping_acc.try_borrow_data()?;
        let mapping = PerpMappingRead::from_bytes(&mapping_data)
            .map_err(|_| error!(PercolatorAdapterError::MappingAccountSizeMismatch))?;
        mapping
            .lookup(&viewing_pub_hash)
            .ok_or_else(|| error!(PercolatorAdapterError::MappingEntryNotFound))?
    };

    // 7. Stale-entry guard (PRD-36 §6.5 #1). If percolator's KeeperCrank
    // liquidated and reassigned the slot, we must NOT proceed —
    // submitting Trade/Withdraw signed as `owner_pda` against a slot
    // that's now someone else's would either fail at percolator or
    // (worse) succeed and corrupt the new owner's state. Mark the
    // mapping entry closed and return a clean error.
    let owner_bytes = expected_owner.to_bytes();
    let still_ours = {
        let slab_data = slab_acc.try_borrow_data()?;
        slab_mod::verify_owner_at_idx(&slab_data, user_idx, &owner_bytes)
            .map_err(|_| error!(PercolatorAdapterError::InvalidActionPayload))?
    };
    if !still_ours {
        let mut mapping_data = mapping_acc.try_borrow_mut_data()?;
        let mut mapping = PerpMapping::from_bytes(&mut mapping_data)
            .map_err(|_| error!(PercolatorAdapterError::MappingAccountSizeMismatch))?;
        let _ = mapping.record_close(&viewing_pub_hash);
        return Err(error!(PercolatorAdapterError::MappingEntryNotFound));
    }

    // 8. owner_pda signer seeds for percolator-side calls
    let owner_bump_arr = [owner_bump];
    let owner_seeds: [&[u8]; 4] = [
        SEED_B402,
        SEED_PERP_OWNER,
        viewing_pub_hash.as_ref(),
        owner_bump_arr.as_ref(),
    ];
    let owner_signer_seeds: &[&[&[u8]]] = &[&owner_seeds];

    // 9. Read current position. If non-zero, flatten via TradeCpi.
    let current_position = {
        let slab_data = slab_acc.try_borrow_data()?;
        slab_mod::read_position_basis_q(&slab_data, user_idx)
            .map_err(|_| error!(PercolatorAdapterError::InvalidActionPayload))?
    };
    if current_position != 0 {
        let flatten_size = current_position
            .checked_neg()
            .ok_or_else(|| error!(PercolatorAdapterError::TradeSizeOutOfRange))?;
        percolator_cpi::invoke_trade_cpi(
            percolator_program,
            owner_pda_acc,
            lp_owner,
            slab_acc,
            clock,
            oracle,
            matcher_program,
            matcher_context,
            lp_pda,
            matcher_tail,
            lp_idx,
            user_idx,
            flatten_size,
            limit_price_e6,
            owner_signer_seeds,
        )?;
    }

    // 10. Read capital (post-PnL settlement). If non-zero, withdraw.
    let capital = {
        let slab_data = slab_acc.try_borrow_data()?;
        slab_mod::read_capital(&slab_data, user_idx)
            .map_err(|_| error!(PercolatorAdapterError::InvalidActionPayload))?
    };
    let withdraw_amount: u64 = capital.try_into().unwrap_or(u64::MAX);
    if withdraw_amount > 0 {
        percolator_cpi::invoke_withdraw_collateral(
            percolator_program,
            owner_pda_acc,
            slab_acc,
            slab_vault,
            user_pcl_ata,
            slab_vault_authority,
            &token_program_ai,
            clock,
            // Hyperp markets don't dereference oracle_idx; the slab pubkey
            // is a safe placeholder. Non-Hyperp variants would pass the
            // configured Pyth/Chainlink account here.
            oracle,
            user_idx,
            withdraw_amount,
            owner_signer_seeds,
        )?;
    }

    // 11. Token transfer: user_pcl_ata → adapter_out_ta, signed by
    // owner_pda. (We can't reuse adapter_authority for this — the
    // funds sit at user's percolator-owned ATA, whose authority is
    // owner_pda.)
    if withdraw_amount > 0 {
        let cpi_program = ctx.accounts.token_program.to_account_info();
        let cpi_accounts = Transfer {
            from: user_pcl_ata.clone(),
            to: ctx.accounts.adapter_out_ta.to_account_info(),
            authority: owner_pda_acc.clone(),
        };
        let cpi_ctx =
            CpiContext::new_with_signer(cpi_program, cpi_accounts, owner_signer_seeds);
        token::transfer(cpi_ctx, withdraw_amount)?;
    }

    // 12. Mark mapping entry closed so the slab slot can be reused.
    {
        let mut mapping_data = mapping_acc.try_borrow_mut_data()?;
        let mut mapping = PerpMapping::from_bytes(&mut mapping_data)
            .map_err(|_| error!(PercolatorAdapterError::MappingAccountSizeMismatch))?;
        mapping
            .record_close(&viewing_pub_hash)
            .map_err(|_| error!(PercolatorAdapterError::MappingEntryNotFound))?;
    }

    msg!(
        "[close] user_idx={} flattened_size={} withdrew={} ok",
        user_idx,
        current_position,
        withdraw_amount
    );
    Ok(())
}

/// Validate the `ClosePosition` variant's args. Returns
/// `(lp_idx, limit_price_e6)`.
///
/// Rules:
///   * `in_amount == 0` — Close path must not pull USDC into the adapter
///   * `lp_idx < deployment.MAX_ACCOUNTS`
pub fn validate_close_args(
    action: &PercolatorAction,
    in_amount: u64,
) -> core::result::Result<(u16, u64), PercolatorAdapterError> {
    let (lp_idx, limit_price_e6) = match action {
        PercolatorAction::ClosePosition { lp_idx, limit_price_e6 } => {
            (*lp_idx, *limit_price_e6)
        }
        _ => return Err(PercolatorAdapterError::WrongActionVariant),
    };
    if in_amount != 0 {
        return Err(PercolatorAdapterError::CloseHasNonzeroInput);
    }
    validate_lp_idx(lp_idx)?;
    Ok((lp_idx, limit_price_e6))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ok_close() -> PercolatorAction {
        PercolatorAction::ClosePosition {
            lp_idx: 3,
            limit_price_e6: 199_000_000,
        }
    }

    #[test]
    fn happy_path() {
        assert_eq!(
            validate_close_args(&ok_close(), 0).unwrap(),
            (3, 199_000_000),
        );
    }

    #[test]
    fn rejects_nonzero_input() {
        assert_eq!(
            validate_close_args(&ok_close(), 1),
            Err(PercolatorAdapterError::CloseHasNonzeroInput),
        );
    }

    #[test]
    fn rejects_open_variant() {
        let open = PercolatorAction::OpenPosition {
            lp_idx: 0,
            size_e6: 1,
            limit_price_e6: 0,
            fee_payment_if_init: 0,
        };
        assert_eq!(
            validate_close_args(&open, 0),
            Err(PercolatorAdapterError::WrongActionVariant),
        );
    }

    #[test]
    fn rejects_lp_idx_beyond_max() {
        let bad = PercolatorAction::ClosePosition {
            lp_idx: u16::MAX,
            limit_price_e6: 0,
        };
        assert_eq!(
            validate_close_args(&bad, 0),
            Err(PercolatorAdapterError::InvalidLpIdx),
        );
    }

    #[test]
    fn accepts_zero_limit_price() {
        let close = PercolatorAction::ClosePosition { lp_idx: 0, limit_price_e6: 0 };
        assert!(validate_close_args(&close, 0).is_ok());
    }
}

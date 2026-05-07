//! `OpenPosition` action handler — full implementation (slice 3a-β).
//!
//! Drives the open path:
//!
//!   1. Decode per-user payload → `(viewing_pub_hash, PercolatorAction)`
//!   2. Validate args (PRD-36 §6.5 #2 — codec accepts but handler must
//!      reject percolator-unsafe args)
//!   3. Resolve `owner_pda` from `viewing_pub_hash`; assert the supplied
//!      account matches
//!   4. Verify slab MAGIC (PRD-36 §13 layout-drift sentinel)
//!   5. Read the perp-mapping account; allocate
//!   6. Branch on outcome:
//!        Existing { user_idx } → re-verify
//!          slab.accounts[user_idx].owner == owner_pda (stale-entry
//!          guard, PRD-36 §6.5 #1). On mismatch: `record_close` and
//!          fall through to a fresh InitUser.
//!        NewSlotNeeded / PrevClosed → invoke_signed InitUser, scan the
//!          slab for the assigned user_idx, `record_init` in mapping.
//!   7. Token transfer: `adapter_in_ta` → user's percolator USDC ATA
//!      (signed by `adapter_authority`)
//!   8. invoke_signed DepositCollateral
//!   9. invoke_signed TradeCpi (matcher CPI rides through)
//!
//! Account layout — variadic `remaining_accounts` from the pool:
//!
//! ```text
//!  [ 0] mapping_account (mut)             — our per-slab PDA
//!  [ 1] owner_pda       (mut)             — per-user PDA we sign as
//!  [ 2] user_percolator_ata (mut)         — owned by owner_pda
//!  [ 3] slab            (mut)             — percolator's slab account
//!  [ 4] slab_vault      (mut)             — percolator's USDC vault PDA
//!  [ 5] percolator_program (executable)
//!  [ 6] clock_sysvar
//!  [ 7] lp_owner        (TradeCpi only, non-signer)
//!  [ 8] oracle          (TradeCpi only)
//!  [ 9] matcher_program (TradeCpi only)
//!  [10] matcher_context (TradeCpi only, mut)
//!  [11] lp_pda          (TradeCpi only)
//!  [12] slab_vault_authority           — read in close, ignored in open
//!  [13..] matcher_tail  (TradeCpi only, variadic — forwarded verbatim)
//! ```

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Transfer};

use crate::actions::validate_lp_idx;
use crate::cpi as percolator_cpi;
use crate::error::PercolatorAdapterError;
use crate::mapping::{AllocateOutcome, PerpMapping, PerpMappingRead};
use crate::payload::{decode_per_user_payload, PercolatorAction};
use crate::pda::{
    derive_adapter_authority, derive_owner_pda, derive_perp_mapping,
    SEED_ADAPTER_AUTHORITY, SEED_B402, SEED_PERP_OWNER,
};
use crate::slab as slab_mod;
use crate::Execute;

/// Variadic remaining_accounts offsets — pinned, must match the SDK side
/// (slice 4) one-to-one.
pub const RA_MAPPING: usize = 0;
pub const RA_OWNER_PDA: usize = 1;
pub const RA_USER_PERCOLATOR_ATA: usize = 2;
pub const RA_SLAB: usize = 3;
pub const RA_SLAB_VAULT: usize = 4;
pub const RA_PERCOLATOR_PROGRAM: usize = 5;
pub const RA_CLOCK: usize = 6;
pub const RA_LP_OWNER: usize = 7;
pub const RA_ORACLE: usize = 8;
pub const RA_MATCHER_PROGRAM: usize = 9;
pub const RA_MATCHER_CONTEXT: usize = 10;
pub const RA_LP_PDA: usize = 11;
pub const RA_SLAB_VAULT_AUTHORITY: usize = 12;
pub const RA_MATCHER_TAIL_START: usize = 13;

/// Validate the `OpenPosition` variant's args against percolator-prog's
/// rejection rules (PRD-36 §6.5 #2). Returns the inner field tuple so
/// callers don't have to re-pattern-match.
///
/// Codec accepts these but percolator's runtime rejects:
///   * `size_e6 == 0`
///   * `size_e6 == i128::MIN`
///   * `lp_idx >= deployment.MAX_ACCOUNTS`
///
/// Plus our own:
///   * `in_amount == 0` — no incoherent zero-margin opens
pub fn validate_open_args(
    action: &PercolatorAction,
    in_amount: u64,
) -> core::result::Result<(u16, i128, u64, u64), PercolatorAdapterError> {
    let (lp_idx, size_e6, limit_price_e6, fee_payment_if_init) = match action {
        PercolatorAction::OpenPosition {
            lp_idx,
            size_e6,
            limit_price_e6,
            fee_payment_if_init,
        } => (*lp_idx, *size_e6, *limit_price_e6, *fee_payment_if_init),
        _ => return Err(PercolatorAdapterError::WrongActionVariant),
    };
    if in_amount == 0 {
        return Err(PercolatorAdapterError::ZeroMargin);
    }
    if size_e6 == 0 {
        return Err(PercolatorAdapterError::ZeroTradeSize);
    }
    if size_e6 == i128::MIN {
        return Err(PercolatorAdapterError::TradeSizeOutOfRange);
    }
    validate_lp_idx(lp_idx)?;
    Ok((lp_idx, size_e6, limit_price_e6, fee_payment_if_init))
}

pub fn handle_open<'info>(
    ctx: &Context<'_, '_, '_, 'info, Execute<'info>>,
    in_amount: u64,
    action_payload: &[u8],
) -> Result<()> {
    // 1. Decode + validate
    let (viewing_pub_hash, action) = decode_per_user_payload(action_payload)
        .map_err(|_| error!(PercolatorAdapterError::InvalidActionPayload))?;
    let (lp_idx, size_e6, limit_price_e6, fee_payment_if_init) =
        validate_open_args(&action, in_amount).map_err(|e| error!(e))?;

    // 2. Pull the variadic accounts at pinned offsets
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
    let matcher_tail = if ctx.remaining_accounts.len() > RA_MATCHER_TAIL_START {
        &ctx.remaining_accounts[RA_MATCHER_TAIL_START..]
    } else {
        &[][..]
    };
    let token_program_ai = ctx.accounts.token_program.to_account_info();

    // 3. Verify slab MAGIC (deployment-side layout-drift sentinel)
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

    // 6. owner_pda signer seeds — used for InitUser / Deposit / Trade /
    // Withdraw. Lifetime-bound to this stack frame.
    let owner_bump_arr = [owner_bump];
    let owner_seeds: [&[u8]; 4] = [
        SEED_B402,
        SEED_PERP_OWNER,
        viewing_pub_hash.as_ref(),
        owner_bump_arr.as_ref(),
    ];
    let owner_signer_seeds: &[&[&[u8]]] = &[&owner_seeds];

    // 7. Mapping read → outcome
    let outcome = {
        let mapping_data = mapping_acc.try_borrow_data()?;
        let mapping = PerpMappingRead::from_bytes(&mapping_data)
            .map_err(|_| error!(PercolatorAdapterError::MappingAccountSizeMismatch))?;
        match mapping.lookup(&viewing_pub_hash) {
            Some(user_idx) => AllocateOutcome::Existing { user_idx },
            None => AllocateOutcome::NewSlotNeeded,
        }
    };

    // 8. Token transfer adapter_in_ta → user's percolator USDC ATA, signed
    // by adapter_authority. MUST happen before allocate_fresh_slot —
    // percolator's `InitUser` ix immediately transfers `fee_payment_if_init`
    // from `user_pcl_ata` to slab_vault, so the ATA needs to be funded
    // first. Total transfer = `in_amount`; subsequent CPIs draw from this
    // running balance (InitUser → fee_payment_if_init, DepositCollateral
    // → remainder).
    let (_auth_pubkey, auth_bump) = derive_adapter_authority(&crate::ID);
    let auth_bump_arr = [auth_bump];
    let auth_seeds: [&[u8]; 3] = [
        SEED_B402,
        SEED_ADAPTER_AUTHORITY,
        auth_bump_arr.as_ref(),
    ];
    let auth_signer_seeds: &[&[&[u8]]] = &[&auth_seeds];
    {
        let cpi_program = ctx.accounts.token_program.to_account_info();
        let cpi_accounts = Transfer {
            from: ctx.accounts.adapter_in_ta.to_account_info(),
            to: user_pcl_ata.clone(),
            authority: ctx.accounts.adapter_authority.to_account_info(),
        };
        let cpi_ctx =
            CpiContext::new_with_signer(cpi_program, cpi_accounts, auth_signer_seeds);
        token::transfer(cpi_ctx, in_amount)?;
    }

    // 9. Resolve user_idx + capital remaining for DepositCollateral.
    //   - Existing slot (still ours): no InitUser, full `in_amount` available.
    //   - New slot / stale-entry recovery: `allocate_fresh_slot` invokes
    //     percolator's InitUser, which transfers `fee_payment_if_init`
    //     from user_pcl_ata to slab_vault and credits
    //     `(fee_payment_if_init - new_account_fee)` as engine capital.
    //     DepositCollateral then drains the rest.
    let (user_idx, deposit_amount) = match outcome {
        AllocateOutcome::Existing { user_idx } => {
            // Stale-entry guard (PRD-36 §6.5 #1).
            let owner_bytes = expected_owner.to_bytes();
            let still_ours = {
                let slab_data = slab_acc.try_borrow_data()?;
                slab_mod::verify_owner_at_idx(&slab_data, user_idx, &owner_bytes)
                    .map_err(|_| error!(PercolatorAdapterError::InvalidActionPayload))?
            };
            if still_ours {
                (user_idx, in_amount)
            } else {
                // Slot was reassigned. Mark closed in mapping, allocate fresh.
                {
                    let mut mapping_data = mapping_acc.try_borrow_mut_data()?;
                    let mut mapping = PerpMapping::from_bytes(&mut mapping_data)
                        .map_err(|_| {
                            error!(PercolatorAdapterError::MappingAccountSizeMismatch)
                        })?;
                    let _ = mapping.record_close(&viewing_pub_hash);
                }
                let idx = allocate_fresh_slot(
                    percolator_program,
                    owner_pda_acc,
                    slab_acc,
                    user_pcl_ata,
                    slab_vault,
                    &token_program_ai,
                    clock,
                    fee_payment_if_init,
                    owner_signer_seeds,
                    mapping_acc,
                    &viewing_pub_hash,
                    &expected_owner,
                )?;
                (
                    idx,
                    in_amount.checked_sub(fee_payment_if_init)
                        .ok_or(error!(PercolatorAdapterError::ZeroMargin))?,
                )
            }
        }
        AllocateOutcome::NewSlotNeeded | AllocateOutcome::PrevClosed { .. } => {
            let idx = allocate_fresh_slot(
                percolator_program,
                owner_pda_acc,
                slab_acc,
                user_pcl_ata,
                slab_vault,
                &token_program_ai,
                clock,
                fee_payment_if_init,
                owner_signer_seeds,
                mapping_acc,
                &viewing_pub_hash,
                &expected_owner,
            )?;
            (
                idx,
                in_amount.checked_sub(fee_payment_if_init)
                    .ok_or(error!(PercolatorAdapterError::ZeroMargin))?,
            )
        }
    };

    // 10. DepositCollateral with the post-fee remainder.
    percolator_cpi::invoke_deposit_collateral(
        percolator_program,
        owner_pda_acc,
        slab_acc,
        user_pcl_ata,
        slab_vault,
        &token_program_ai,
        clock,
        user_idx,
        deposit_amount,
        owner_signer_seeds,
    )?;

    // 11. TradeCpi (opens the position)
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
        size_e6,
        limit_price_e6,
        owner_signer_seeds,
    )?;

    msg!(
        "[open] user_idx={} principal={} size={} lp={} ok",
        user_idx,
        in_amount,
        size_e6,
        lp_idx
    );
    Ok(())
}

/// Run InitUser, scan the slab for the assigned user_idx, record it.
#[allow(clippy::too_many_arguments)]
fn allocate_fresh_slot<'info>(
    percolator_program: &AccountInfo<'info>,
    owner_pda_acc: &AccountInfo<'info>,
    slab_acc: &AccountInfo<'info>,
    user_pcl_ata: &AccountInfo<'info>,
    slab_vault: &AccountInfo<'info>,
    token_program: &AccountInfo<'info>,
    clock: &AccountInfo<'info>,
    fee_payment: u64,
    owner_signer_seeds: &[&[&[u8]]],
    mapping_acc: &AccountInfo<'info>,
    viewing_pub_hash: &[u8; 32],
    expected_owner: &Pubkey,
) -> Result<u16> {
    // 1. invoke percolator's InitUser as owner_pda
    percolator_cpi::invoke_init_user(
        percolator_program,
        owner_pda_acc,
        slab_acc,
        user_pcl_ata,
        slab_vault,
        token_program,
        clock,
        fee_payment,
        owner_signer_seeds,
    )?;

    // 2. Discover the assigned user_idx via slab scan. percolator does
    // not return data; the slot owned by `expected_owner` post-InitUser
    // is the one we just claimed.
    let owner_bytes = expected_owner.to_bytes();
    let user_idx = {
        let slab_data = slab_acc.try_borrow_data()?;
        slab_mod::find_owner_in_slab(&slab_data, &owner_bytes)
            .map_err(|_| error!(PercolatorAdapterError::InvalidActionPayload))?
    };

    // 3. Record the (viewing_pub_hash → user_idx) mapping
    {
        let mut mapping_data = mapping_acc.try_borrow_mut_data()?;
        let mut mapping = PerpMapping::from_bytes(&mut mapping_data)
            .map_err(|_| error!(PercolatorAdapterError::MappingAccountSizeMismatch))?;
        mapping
            .record_init(viewing_pub_hash, user_idx)
            .map_err(|_| error!(PercolatorAdapterError::MappingLiveEntryMismatch))?;
    }

    Ok(user_idx)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::payload::PercolatorAction;

    fn ok_open() -> PercolatorAction {
        PercolatorAction::OpenPosition {
            lp_idx: 7,
            size_e6: 1_500_000,
            limit_price_e6: 200_000_000,
            fee_payment_if_init: 0,
        }
    }

    #[test]
    fn happy_path_validator() {
        assert_eq!(
            validate_open_args(&ok_open(), 1_000_000).unwrap(),
            (7, 1_500_000, 200_000_000, 0),
        );
    }

    #[test]
    fn rejects_zero_margin_validator() {
        assert_eq!(
            validate_open_args(&ok_open(), 0),
            Err(PercolatorAdapterError::ZeroMargin),
        );
    }

    #[test]
    fn rejects_zero_size_validator() {
        let bad = PercolatorAction::OpenPosition {
            lp_idx: 7,
            size_e6: 0,
            limit_price_e6: 200_000_000,
            fee_payment_if_init: 0,
        };
        assert_eq!(
            validate_open_args(&bad, 1_000),
            Err(PercolatorAdapterError::ZeroTradeSize),
        );
    }

    #[test]
    fn rejects_i128_min_size_validator() {
        let bad = PercolatorAction::OpenPosition {
            lp_idx: 7,
            size_e6: i128::MIN,
            limit_price_e6: 200_000_000,
            fee_payment_if_init: 0,
        };
        assert_eq!(
            validate_open_args(&bad, 1_000),
            Err(PercolatorAdapterError::TradeSizeOutOfRange),
        );
    }

    #[test]
    fn rejects_lp_idx_beyond_max_validator() {
        let bad = PercolatorAction::OpenPosition {
            lp_idx: u16::MAX,
            size_e6: 1,
            limit_price_e6: 0,
            fee_payment_if_init: 0,
        };
        assert_eq!(
            validate_open_args(&bad, 1_000),
            Err(PercolatorAdapterError::InvalidLpIdx),
        );
    }

    #[test]
    fn accepts_negative_size_short_position_validator() {
        let short = PercolatorAction::OpenPosition {
            lp_idx: 0,
            size_e6: -1_000_000,
            limit_price_e6: 0,
            fee_payment_if_init: 0,
        };
        assert!(validate_open_args(&short, 1_000).is_ok());
    }

    #[test]
    fn rejects_close_variant_validator() {
        let close = PercolatorAction::ClosePosition { lp_idx: 0, limit_price_e6: 0 };
        assert_eq!(
            validate_open_args(&close, 1_000),
            Err(PercolatorAdapterError::WrongActionVariant),
        );
    }

    #[test]
    fn ra_offsets_pinned() {
        // Pin the variadic remaining_accounts layout so any drift here
        // breaks the SDK side (slice 4) loudly via a failing build.
        assert_eq!(RA_MAPPING, 0);
        assert_eq!(RA_OWNER_PDA, 1);
        assert_eq!(RA_USER_PERCOLATOR_ATA, 2);
        assert_eq!(RA_SLAB, 3);
        assert_eq!(RA_SLAB_VAULT, 4);
        assert_eq!(RA_PERCOLATOR_PROGRAM, 5);
        assert_eq!(RA_CLOCK, 6);
        assert_eq!(RA_LP_OWNER, 7);
        assert_eq!(RA_ORACLE, 8);
        assert_eq!(RA_MATCHER_PROGRAM, 9);
        assert_eq!(RA_MATCHER_CONTEXT, 10);
        assert_eq!(RA_LP_PDA, 11);
        assert_eq!(RA_SLAB_VAULT_AUTHORITY, 12);
        assert_eq!(RA_MATCHER_TAIL_START, 13);
    }
}

//! `OpenPosition` action handler — argument validation slice (slice 2).
//!
//! The full handler (slice 3) will:
//!   1. Resolve `owner_pda` from `viewing_pub_hash`
//!   2. Look up `user_idx` from the perp-mapping account
//!   3. If new: `invoke_signed` percolator's `InitUser`, then read back the
//!      assigned `user_idx`, then `mapping.record_init`
//!   4. Verify `slab.accounts[user_idx].owner == owner_pda` (stale-entry
//!      guard, PRD-36 §6.5 #1)
//!   5. Transfer `in_amount` from `adapter_in_ta` to `owner_pda`'s
//!      percolator USDC ATA
//!   6. `invoke_signed` percolator's `DepositCollateral`
//!   7. `invoke_signed` percolator's `TradeCpi`
//!
//! Slice 2 implements only step (0): reject percolator-unsafe args
//! before any account-info or CPI work happens.

use crate::actions::validate_lp_idx;
use crate::error::PercolatorAdapterError;
use crate::payload::PercolatorAction;

/// Validate the `OpenPosition` variant's args against percolator-prog's
/// rejection rules (PRD-36 §6.5 #2). Idempotent on success: returns
/// the inner field tuple so callers don't have to re-pattern-match.
///
/// Codec accepts these but percolator's runtime rejects:
///   * `size_e6 == 0` — `percolator-prog` returns `InvalidInstructionData`
///   * `size_e6 == i128::MIN` — no positive counterpart
///   * `lp_idx >= deployment.MAX_ACCOUNTS`
///
/// Plus our own:
///   * `in_amount == 0` — pool guarantees nonzero on Open path; we
///     defensively reject (zero would mean "open a position without
///     posting margin", which is incoherent regardless)
pub fn validate_open_args(
    action: &PercolatorAction,
    in_amount: u64,
) -> Result<(u16, i128, u64, u64), PercolatorAdapterError> {
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

#[cfg(test)]
mod tests {
    use super::*;

    fn ok_open() -> PercolatorAction {
        PercolatorAction::OpenPosition {
            lp_idx: 7,
            size_e6: 1_500_000,
            limit_price_e6: 200_000_000,
            fee_payment_if_init: 0,
        }
    }

    #[test]
    fn happy_path() {
        assert_eq!(
            validate_open_args(&ok_open(), 1_000_000).unwrap(),
            (7, 1_500_000, 200_000_000, 0),
        );
    }

    #[test]
    fn rejects_zero_margin() {
        assert_eq!(
            validate_open_args(&ok_open(), 0),
            Err(PercolatorAdapterError::ZeroMargin),
        );
    }

    #[test]
    fn rejects_zero_size() {
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
    fn rejects_i128_min_size() {
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
    fn rejects_lp_idx_beyond_max() {
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
    fn accepts_negative_size_short_position() {
        let short = PercolatorAction::OpenPosition {
            lp_idx: 0,
            size_e6: -1_000_000,
            limit_price_e6: 0,
            fee_payment_if_init: 0,
        };
        assert!(validate_open_args(&short, 1_000).is_ok());
    }

    #[test]
    fn rejects_close_variant() {
        let close = PercolatorAction::ClosePosition { limit_price_e6: 0 };
        assert_eq!(
            validate_open_args(&close, 1_000),
            Err(PercolatorAdapterError::WrongActionVariant),
        );
    }
}

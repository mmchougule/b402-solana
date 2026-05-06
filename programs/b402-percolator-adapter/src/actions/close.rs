//! `ClosePosition` action handler — argument validation slice (slice 2).
//!
//! The full handler (slice 3) will:
//!   1. Look up `user_idx` from the perp-mapping account; require it exists
//!   2. Verify `slab.accounts[user_idx].owner == owner_pda`
//!   3. Read current position size from percolator's slab
//!   4. `invoke_signed` percolator's `TradeCpi` with `size = -current_size`
//!      to flatten
//!   5. `invoke_signed` percolator's `WithdrawCollateral` with `amount =
//!      slab.accounts[user_idx].collateral` (post-PnL settlement)
//!   6. Transfer recovered USDC to the pool's out-vault
//!   7. `mapping.record_close` so the slab slot can be reused
//!
//! Slice 2 implements only step (0): the close path doesn't move USDC
//! into the adapter, so `in_amount` MUST be zero. The action is otherwise
//! parameter-light — only `limit_price_e6` (the close-side slippage bound).

use crate::error::PercolatorAdapterError;
use crate::payload::PercolatorAction;

/// Validate the `ClosePosition` variant's args. Returns the inner
/// `limit_price_e6`.
///
/// Rules:
///   * `in_amount == 0` — Close path must not pull USDC into the adapter
///   * `min_out` may be any value; the pool checks the floor post-CPI
pub fn validate_close_args(
    action: &PercolatorAction,
    in_amount: u64,
) -> Result<u64, PercolatorAdapterError> {
    let limit_price_e6 = match action {
        PercolatorAction::ClosePosition { limit_price_e6 } => *limit_price_e6,
        _ => return Err(PercolatorAdapterError::WrongActionVariant),
    };
    if in_amount != 0 {
        return Err(PercolatorAdapterError::CloseHasNonzeroInput);
    }
    Ok(limit_price_e6)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn happy_path() {
        let close = PercolatorAction::ClosePosition { limit_price_e6: 199_000_000 };
        assert_eq!(validate_close_args(&close, 0).unwrap(), 199_000_000);
    }

    #[test]
    fn rejects_nonzero_input() {
        let close = PercolatorAction::ClosePosition { limit_price_e6: 0 };
        assert_eq!(
            validate_close_args(&close, 1),
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
    fn accepts_zero_limit_price() {
        let close = PercolatorAction::ClosePosition { limit_price_e6: 0 };
        assert!(validate_close_args(&close, 0).is_ok());
    }
}

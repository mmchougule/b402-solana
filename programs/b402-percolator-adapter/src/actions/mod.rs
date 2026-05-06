//! Per-action handlers. Slice 2 ships handler-level argument validation
//! (PRD-36 §6.5 #2 — codec accepts but handler must reject); the
//! `invoke_signed` plumbing for `InitUser` / `DepositCollateral` /
//! `TradeCpi` / `WithdrawCollateral` lands in slice 3 with the actual
//! account-info wiring.

pub mod close;
pub mod open;

pub use close::validate_close_args;
pub use open::validate_open_args;

use crate::error::PercolatorAdapterError;

/// Per-deployment maximum slab account count. Mirrors percolator's
/// `MAX_ACCOUNTS` for the `medium` feature tier (the size the b402 v1
/// percolator adapter targets). If a slab is deployed with a different
/// tier (e.g. `small=256` or default `4096`), update via env constant or
/// move to runtime check that reads slab header. v1 keeps it simple.
pub const PERCOLATOR_MAX_ACCOUNTS_DEFAULT: u16 = 1024;

/// Validate that an `lp_idx` falls in the slab's account-table range.
/// Returns `InvalidLpIdx` for anything beyond the deployment cap.
pub fn validate_lp_idx(lp_idx: u16) -> Result<(), PercolatorAdapterError> {
    if lp_idx >= PERCOLATOR_MAX_ACCOUNTS_DEFAULT {
        return Err(PercolatorAdapterError::InvalidLpIdx);
    }
    Ok(())
}

//! Per-action handlers + shared dispatch helpers.

pub mod close;
pub mod open;

pub use close::{handle_close, validate_close_args};
pub use open::{handle_open, validate_open_args};

use crate::error::PercolatorAdapterError;
use crate::payload::{tag, VIEWING_PUB_HASH_PREFIX_LEN};

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

/// Variant tag of the inner `PercolatorAction`. Used by `execute()` to
/// dispatch without paying the cost of decoding the entire payload twice
/// (once at the top level, once inside each handler).
#[derive(Debug, PartialEq, Eq)]
pub enum ActionTag {
    Open,
    Close,
}

/// Read just the variant discriminant from a per-user payload without a
/// full Borsh decode. Returns `InvalidActionPayload` if the payload is
/// shorter than `[viewing_pub_hash (32B), discriminant (1B)]` or the
/// discriminant doesn't match a known variant.
pub fn peek_variant_tag(action_payload: &[u8]) -> Result<ActionTag, PercolatorAdapterError> {
    if action_payload.len() <= VIEWING_PUB_HASH_PREFIX_LEN {
        return Err(PercolatorAdapterError::InvalidActionPayload);
    }
    let disc = action_payload[VIEWING_PUB_HASH_PREFIX_LEN];
    match disc {
        x if x == tag::OPEN_POSITION => Ok(ActionTag::Open),
        x if x == tag::CLOSE_POSITION => Ok(ActionTag::Close),
        _ => Err(PercolatorAdapterError::InvalidActionPayload),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::payload::{encode_per_user_payload, PercolatorAction};

    fn open_payload() -> Vec<u8> {
        encode_per_user_payload(
            &[1u8; 32],
            &PercolatorAction::OpenPosition {
                lp_idx: 0,
                size_e6: 1,
                limit_price_e6: 0,
                fee_payment_if_init: 0,
            },
        )
    }

    fn close_payload() -> Vec<u8> {
        encode_per_user_payload(
            &[2u8; 32],
            &PercolatorAction::ClosePosition { limit_price_e6: 0 },
        )
    }

    #[test]
    fn peek_open_variant() {
        assert_eq!(peek_variant_tag(&open_payload()).unwrap(), ActionTag::Open);
    }

    #[test]
    fn peek_close_variant() {
        assert_eq!(peek_variant_tag(&close_payload()).unwrap(), ActionTag::Close);
    }

    #[test]
    fn peek_rejects_short() {
        let bytes = vec![0u8; 32];
        assert_eq!(
            peek_variant_tag(&bytes),
            Err(PercolatorAdapterError::InvalidActionPayload),
        );
    }

    #[test]
    fn peek_rejects_unknown_discriminant() {
        let mut bytes = vec![0u8; 33];
        bytes[32] = 0xff;
        assert_eq!(
            peek_variant_tag(&bytes),
            Err(PercolatorAdapterError::InvalidActionPayload),
        );
    }
}

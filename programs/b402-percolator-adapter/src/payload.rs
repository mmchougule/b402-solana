//! Borsh-serialized adapter action payload (PRD-36 §5.3).
//!
//! The pool calls the adapter with `action_payload: Vec<u8>` carrying a
//! Borsh-encoded `PercolatorAction`. Two variants for v1: `OpenPosition`
//! and `ClosePosition`. Adapter dispatches on the variant.
//!
//! Size budget: `MAX_ACTION_PAYLOAD = 350` (from `@b402ai/solana` SDK).
//! Both variants encode well under that.

use anchor_lang::prelude::*;

/// The action enum carried in `adapt_execute.action_payload`.
///
/// Borsh-encoded as `[discriminant_u8, variant_fields...]`. v1 supports
/// two variants; new variants must append (never reorder) to preserve
/// wire compatibility for existing on-chain proofs that bound an older
/// payload's keccak.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq, Eq)]
pub enum PercolatorAction {
    /// Open (or top up the slot for) a perp position.
    ///
    /// On first call for this `viewing_pub_hash` against the target slab,
    /// the adapter calls `InitUser { fee_payment_if_init }` to claim a
    /// slab slot, then `DepositCollateral { in_amount }` (where in_amount
    /// is the proof-bound margin), then `TradeCpi { lp_idx, size_e6,
    /// limit_price_e6 }` to open the position.
    ///
    /// Subsequent calls (slot already claimed) skip InitUser and reuse
    /// the existing `user_idx` from the perp-mapping account, after
    /// re-verifying that `slab.accounts[user_idx].owner == owner_pda`
    /// (stale-entry race guard — slot may have been liquidated and
    /// reassigned by percolator's KeeperCrank since our last touch).
    ///
    /// Codec accepts but the action handler MUST reject:
    ///   - `size_e6 == 0` (percolator-prog rejects with InvalidInstructionData)
    ///   - `size_e6 == i128::MIN` (no positive counterpart — engine rejects)
    ///   - `lp_idx >= percolator::MAX_ACCOUNTS` for the deployment tier
    ///   - `lp_idx == user_idx` (percolator-prog rejects)
    OpenPosition {
        lp_idx: u16,
        size_e6: i128,
        limit_price_e6: u64,
        /// fee_payment passed to `InitUser` only on the first call.
        /// Ignored on subsequent calls. Set to 0 if the slot already exists.
        fee_payment_if_init: u64,
    },
    /// Close the user's existing position, withdraw all collateral, and
    /// return the proceeds to the pool's out-vault.
    ///
    /// The adapter:
    ///   1. Reads `user_idx` from the perp-mapping account
    ///   2. Reads current position size from percolator's slab
    ///   3. Submits `TradeCpi { size = -current_size, limit_price_e6 }`
    ///      to flatten
    ///   4. Submits `WithdrawCollateral { user_idx, amount = all }`
    ///   5. Transfers the recovered USDC to the pool's out-vault
    ClosePosition {
        limit_price_e6: u64,
    },
}

/// Hard cap on the encoded payload length. Matches the pool's
/// `MAX_ACTION_PAYLOAD = 350`. Both v1 variants encode in < 64 bytes,
/// leaving headroom for future variants.
pub const PAYLOAD_MAX_LEN: usize = 350;

/// Discriminant tags. Stable wire format; never reorder.
pub mod tag {
    pub const OPEN_POSITION: u8 = 0;
    pub const CLOSE_POSITION: u8 = 1;
}

impl PercolatorAction {
    /// Decode + validate. Returns `Err` on:
    ///   - empty input
    ///   - unknown discriminant
    ///   - truncated payload (Borsh deserialize fails)
    ///   - extra trailing bytes
    pub fn try_decode(bytes: &[u8]) -> core::result::Result<Self, PayloadDecodeError> {
        if bytes.is_empty() {
            return Err(PayloadDecodeError::Empty);
        }
        if bytes.len() > PAYLOAD_MAX_LEN {
            return Err(PayloadDecodeError::TooLarge);
        }
        let mut cursor = bytes;
        let action = Self::deserialize(&mut cursor)
            .map_err(|_| PayloadDecodeError::Truncated)?;
        if !cursor.is_empty() {
            return Err(PayloadDecodeError::TrailingBytes);
        }
        Ok(action)
    }

    /// Encode. Always succeeds for valid variants.
    pub fn encode(&self) -> Vec<u8> {
        let mut buf = Vec::with_capacity(64);
        self.serialize(&mut buf).expect("borsh encode infallible");
        buf
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum PayloadDecodeError {
    Empty,
    TooLarge,
    Truncated,
    TrailingBytes,
    UnknownDiscriminant(u8),
}

#[cfg(test)]
mod tests {
    use super::*;

    fn open_sample() -> PercolatorAction {
        PercolatorAction::OpenPosition {
            lp_idx: 7,
            size_e6: 1_500_000i128,
            limit_price_e6: 200_000_000,
            fee_payment_if_init: 100_000,
        }
    }

    fn close_sample() -> PercolatorAction {
        PercolatorAction::ClosePosition { limit_price_e6: 199_000_000 }
    }

    #[test]
    fn open_position_roundtrip() {
        let a = open_sample();
        let bytes = a.encode();
        // discriminant + u16 + i128 + u64 + u64 = 1 + 2 + 16 + 8 + 8 = 35
        assert_eq!(bytes.len(), 35);
        assert_eq!(bytes[0], tag::OPEN_POSITION);
        assert_eq!(PercolatorAction::try_decode(&bytes).unwrap(), a);
    }

    #[test]
    fn close_position_roundtrip() {
        let a = close_sample();
        let bytes = a.encode();
        // discriminant + u64 = 1 + 8 = 9
        assert_eq!(bytes.len(), 9);
        assert_eq!(bytes[0], tag::CLOSE_POSITION);
        assert_eq!(PercolatorAction::try_decode(&bytes).unwrap(), a);
    }

    #[test]
    fn empty_input_rejected() {
        assert_eq!(PercolatorAction::try_decode(&[]), Err(PayloadDecodeError::Empty));
    }

    #[test]
    fn truncated_open_rejected() {
        let bytes = open_sample().encode();
        for cut in 1..bytes.len() {
            assert_eq!(
                PercolatorAction::try_decode(&bytes[..cut]),
                Err(PayloadDecodeError::Truncated),
                "expected Truncated at cut={cut}",
            );
        }
    }

    #[test]
    fn trailing_bytes_rejected() {
        let mut bytes = close_sample().encode();
        bytes.push(0xff);
        assert_eq!(
            PercolatorAction::try_decode(&bytes),
            Err(PayloadDecodeError::TrailingBytes),
        );
    }

    #[test]
    fn oversized_payload_rejected() {
        let bytes = vec![0u8; PAYLOAD_MAX_LEN + 1];
        assert_eq!(
            PercolatorAction::try_decode(&bytes),
            Err(PayloadDecodeError::TooLarge),
        );
    }

    #[test]
    fn unknown_discriminant_truncates() {
        // Borsh treats unknown enum variants as a deserialization failure.
        // We surface that as `Truncated` to keep the error surface small.
        let bytes = [0xff_u8, 0, 0];
        assert_eq!(
            PercolatorAction::try_decode(&bytes),
            Err(PayloadDecodeError::Truncated),
        );
    }

    #[test]
    fn open_lp_idx_max_roundtrip() {
        let a = PercolatorAction::OpenPosition {
            lp_idx: u16::MAX,
            size_e6: i128::MAX,
            limit_price_e6: u64::MAX,
            fee_payment_if_init: u64::MAX,
        };
        let bytes = a.encode();
        assert_eq!(PercolatorAction::try_decode(&bytes).unwrap(), a);
    }

    #[test]
    fn open_negative_size_roundtrip() {
        // Short positions: size_e6 < 0
        let a = PercolatorAction::OpenPosition {
            lp_idx: 0,
            size_e6: -1_000_000i128,
            limit_price_e6: 100_000_000,
            fee_payment_if_init: 0,
        };
        let bytes = a.encode();
        assert_eq!(PercolatorAction::try_decode(&bytes).unwrap(), a);
    }
}

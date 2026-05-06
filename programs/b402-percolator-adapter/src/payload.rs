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
    ///   3. If position != 0, submits `TradeCpi { lp_idx,
    ///      size = -current_size, limit_price_e6 }` to flatten
    ///   4. Reads current capital (post-PnL) from slab
    ///   5. If capital > 0, submits `WithdrawCollateral { user_idx,
    ///      amount = capital }`
    ///   6. Transfers the recovered USDC to the pool's out-vault
    ///
    /// `lp_idx` selects which LP the close-side trade routes through
    /// (matcher CPI). The user picks; doesn't need to match the LP
    /// they opened with.
    ClosePosition {
        lp_idx: u16,
        limit_price_e6: u64,
    },
}

/// Hard cap on the encoded payload length. Matches the pool's
/// `MAX_ACTION_PAYLOAD = 350`. Both v1 variants encode in < 64 bytes,
/// leaving headroom for future variants.
pub const PAYLOAD_MAX_LEN: usize = 350;

/// Length of the `viewing_pub_hash` prefix the pool prepends to
/// stateful adapters' action payloads (PRD-33 §6.1, mirrors
/// `b402_kamino_adapter::decode_per_user_payload`). The pool fills it
/// from `pi.out_spending_pub` (Phase-9 public input). Verified by the
/// proof, so handler code can trust the bytes match the user's
/// shielded identity.
pub const VIEWING_PUB_HASH_PREFIX_LEN: usize = 32;

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

/// Split a stateful-adapter action payload into its `viewing_pub_hash`
/// prefix and the inner `PercolatorAction`.
///
/// Wire format: `[viewing_pub_hash: [u8; 32], borsh(PercolatorAction)]`.
/// The pool prepends the hash for adapters whose `adapter_registry`
/// entry has `stateful_adapter = true`. Mirrors
/// `b402_kamino_adapter::decode_per_user_payload`.
///
/// Errors:
///   * `Empty` if `bytes.len() <= 32` (need at least 33 B)
///   * `TooLarge` if oversized per the pool's hard cap
///   * `Truncated` / `TrailingBytes` propagate from inner Borsh decode
pub fn decode_per_user_payload(
    bytes: &[u8],
) -> core::result::Result<([u8; 32], PercolatorAction), PayloadDecodeError> {
    if bytes.len() <= VIEWING_PUB_HASH_PREFIX_LEN {
        return Err(PayloadDecodeError::Empty);
    }
    if bytes.len() > PAYLOAD_MAX_LEN {
        return Err(PayloadDecodeError::TooLarge);
    }
    let mut viewing_pub_hash = [0u8; VIEWING_PUB_HASH_PREFIX_LEN];
    viewing_pub_hash.copy_from_slice(&bytes[..VIEWING_PUB_HASH_PREFIX_LEN]);
    let action = PercolatorAction::try_decode(&bytes[VIEWING_PUB_HASH_PREFIX_LEN..])?;
    Ok((viewing_pub_hash, action))
}

/// Helper: build a stateful-adapter payload by prepending the
/// `viewing_pub_hash` to a Borsh-encoded `PercolatorAction`. Used by
/// the SDK side (slice 4) and by tests.
pub fn encode_per_user_payload(
    viewing_pub_hash: &[u8; 32],
    action: &PercolatorAction,
) -> Vec<u8> {
    let inner = action.encode();
    let mut buf = Vec::with_capacity(VIEWING_PUB_HASH_PREFIX_LEN + inner.len());
    buf.extend_from_slice(viewing_pub_hash);
    buf.extend_from_slice(&inner);
    buf
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
        PercolatorAction::ClosePosition {
            lp_idx: 3,
            limit_price_e6: 199_000_000,
        }
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
        // discriminant + u16 + u64 = 1 + 2 + 8 = 11
        assert_eq!(bytes.len(), 11);
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

    // ─── per-user payload tests ───
    #[test]
    fn per_user_payload_roundtrip() {
        let hash = [7u8; 32];
        let inner = open_sample();
        let bytes = encode_per_user_payload(&hash, &inner);
        let (decoded_hash, decoded_action) = decode_per_user_payload(&bytes).unwrap();
        assert_eq!(decoded_hash, hash);
        assert_eq!(decoded_action, inner);
    }

    #[test]
    fn per_user_payload_close_roundtrip() {
        let hash = [0xab; 32];
        let inner = close_sample();
        let bytes = encode_per_user_payload(&hash, &inner);
        let (h, a) = decode_per_user_payload(&bytes).unwrap();
        assert_eq!(h, hash);
        assert_eq!(a, inner);
    }

    #[test]
    fn per_user_payload_rejects_only_prefix() {
        // 32 bytes is exactly the prefix; missing inner action.
        let bytes = vec![0u8; 32];
        assert_eq!(decode_per_user_payload(&bytes), Err(PayloadDecodeError::Empty));
    }

    #[test]
    fn per_user_payload_rejects_short_prefix() {
        // 16 bytes: less than even the prefix.
        let bytes = vec![0u8; 16];
        assert_eq!(decode_per_user_payload(&bytes), Err(PayloadDecodeError::Empty));
    }

    #[test]
    fn per_user_payload_rejects_truncated_inner() {
        let hash = [1u8; 32];
        let mut bytes = encode_per_user_payload(&hash, &open_sample());
        bytes.truncate(33); // prefix + only the discriminant byte
        assert_eq!(
            decode_per_user_payload(&bytes),
            Err(PayloadDecodeError::Truncated),
        );
    }

    #[test]
    fn per_user_payload_rejects_oversized() {
        let bytes = vec![0u8; PAYLOAD_MAX_LEN + 1];
        assert_eq!(
            decode_per_user_payload(&bytes),
            Err(PayloadDecodeError::TooLarge),
        );
    }

    #[test]
    fn per_user_prefix_pinned_to_32() {
        // Pin: any drift here breaks pool ↔ adapter wire compat.
        assert_eq!(VIEWING_PUB_HASH_PREFIX_LEN, 32);
    }
}

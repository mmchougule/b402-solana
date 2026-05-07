//! Manual percolator-prog instruction-data builders.
//!
//! `percolator-prog` is a raw `solana-program 1.18` program (no Anchor),
//! so its ix data is decoded as `[tag: u8, ...args_le]`. Tags verified
//! against `~/development/ai/percolator-prog/src/percolator.rs:1786`
//! (the `Instruction::decode` match block).
//!
//! v1 of the b402 adapter uses four ixs:
//!
//! | Tag | Variant            | Wire shape (after tag)                       | Bytes |
//! |-----|--------------------|----------------------------------------------|-------|
//! | 1   | InitUser           | fee_payment: u64 LE                          | 8     |
//! | 3   | DepositCollateral  | user_idx: u16 LE, amount: u64 LE             | 10    |
//! | 4   | WithdrawCollateral | user_idx: u16 LE, amount: u64 LE             | 10    |
//! | 10  | TradeCpi           | lp_idx: u16, user_idx: u16, size: i128, lim: u64 | 28 |
//!
//! All multi-byte fields are little-endian — Solana's standard. No
//! padding between fields. Tag 9 is `TopUpInsurance`, NOT TradeCpi —
//! the wire-format tag and the source-order enum index diverge from
//! tag=5 onward.

/// Tag byte for the percolator-prog `InitUser` ix.
pub const PERCOLATOR_TAG_INIT_USER: u8 = 1;
/// Tag byte for the percolator-prog `DepositCollateral` ix.
pub const PERCOLATOR_TAG_DEPOSIT_COLLATERAL: u8 = 3;
/// Tag byte for the percolator-prog `WithdrawCollateral` ix.
pub const PERCOLATOR_TAG_WITHDRAW_COLLATERAL: u8 = 4;
/// Tag byte for the percolator-prog `TradeCpi` ix.
///
/// Note: the enum's source-declaration order has `TradeCpi` at index 9,
/// but percolator's runtime decode block assigns this variant tag 10.
/// (Index 9 in the decode block is `TopUpInsurance`.) The wire format
/// follows decode-block order; we pin tag 10.
pub const PERCOLATOR_TAG_TRADE_CPI: u8 = 10;

/// Build the ix-data byte slice for `Instruction::InitUser { fee_payment }`.
pub fn build_init_user_data(fee_payment: u64) -> Vec<u8> {
    let mut buf = Vec::with_capacity(9);
    buf.push(PERCOLATOR_TAG_INIT_USER);
    buf.extend_from_slice(&fee_payment.to_le_bytes());
    buf
}

/// Build the ix-data byte slice for `Instruction::DepositCollateral`.
pub fn build_deposit_collateral_data(user_idx: u16, amount: u64) -> Vec<u8> {
    let mut buf = Vec::with_capacity(11);
    buf.push(PERCOLATOR_TAG_DEPOSIT_COLLATERAL);
    buf.extend_from_slice(&user_idx.to_le_bytes());
    buf.extend_from_slice(&amount.to_le_bytes());
    buf
}

/// Build the ix-data byte slice for `Instruction::WithdrawCollateral`.
pub fn build_withdraw_collateral_data(user_idx: u16, amount: u64) -> Vec<u8> {
    let mut buf = Vec::with_capacity(11);
    buf.push(PERCOLATOR_TAG_WITHDRAW_COLLATERAL);
    buf.extend_from_slice(&user_idx.to_le_bytes());
    buf.extend_from_slice(&amount.to_le_bytes());
    buf
}

/// Build the ix-data byte slice for `Instruction::TradeCpi`.
pub fn build_trade_cpi_data(
    lp_idx: u16,
    user_idx: u16,
    size: i128,
    limit_price_e6: u64,
) -> Vec<u8> {
    let mut buf = Vec::with_capacity(29);
    buf.push(PERCOLATOR_TAG_TRADE_CPI);
    buf.extend_from_slice(&lp_idx.to_le_bytes());
    buf.extend_from_slice(&user_idx.to_le_bytes());
    buf.extend_from_slice(&size.to_le_bytes());
    buf.extend_from_slice(&limit_price_e6.to_le_bytes());
    buf
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Re-derive percolator's read_u16 / read_u64 / read_i128 inline so
    /// we test that what we write is what their decoder will read.
    /// Mirrors `percolator-prog/src/percolator.rs` byte semantics.
    fn read_u16_le(buf: &[u8], at: usize) -> u16 {
        u16::from_le_bytes(buf[at..at + 2].try_into().unwrap())
    }
    fn read_u64_le(buf: &[u8], at: usize) -> u64 {
        u64::from_le_bytes(buf[at..at + 8].try_into().unwrap())
    }
    fn read_i128_le(buf: &[u8], at: usize) -> i128 {
        i128::from_le_bytes(buf[at..at + 16].try_into().unwrap())
    }

    #[test]
    fn init_user_wire_shape() {
        let data = build_init_user_data(0xdead_beef);
        assert_eq!(data.len(), 9);
        assert_eq!(data[0], PERCOLATOR_TAG_INIT_USER);
        assert_eq!(read_u64_le(&data, 1), 0xdead_beef);
    }

    #[test]
    fn init_user_zero_fee_round_trip() {
        let data = build_init_user_data(0);
        assert_eq!(data, &[1u8, 0, 0, 0, 0, 0, 0, 0, 0]);
    }

    #[test]
    fn deposit_collateral_wire_shape() {
        let data = build_deposit_collateral_data(7, 1_000_000);
        assert_eq!(data.len(), 11);
        assert_eq!(data[0], PERCOLATOR_TAG_DEPOSIT_COLLATERAL);
        assert_eq!(read_u16_le(&data, 1), 7);
        assert_eq!(read_u64_le(&data, 3), 1_000_000);
    }

    #[test]
    fn deposit_collateral_max_values() {
        let data = build_deposit_collateral_data(u16::MAX, u64::MAX);
        assert_eq!(read_u16_le(&data, 1), u16::MAX);
        assert_eq!(read_u64_le(&data, 3), u64::MAX);
    }

    #[test]
    fn withdraw_collateral_wire_shape() {
        let data = build_withdraw_collateral_data(42, 999);
        assert_eq!(data.len(), 11);
        assert_eq!(data[0], PERCOLATOR_TAG_WITHDRAW_COLLATERAL);
        assert_eq!(read_u16_le(&data, 1), 42);
        assert_eq!(read_u64_le(&data, 3), 999);
    }

    #[test]
    fn withdraw_and_deposit_share_layout_but_differ_only_in_tag() {
        let dep = build_deposit_collateral_data(5, 100);
        let wd = build_withdraw_collateral_data(5, 100);
        assert_eq!(dep.len(), wd.len());
        assert_ne!(dep[0], wd[0]);
        assert_eq!(&dep[1..], &wd[1..]);
    }

    #[test]
    fn trade_cpi_wire_shape() {
        let data = build_trade_cpi_data(3, 17, 1_500_000, 200_000_000);
        assert_eq!(data.len(), 29);
        assert_eq!(data[0], PERCOLATOR_TAG_TRADE_CPI);
        assert_eq!(read_u16_le(&data, 1), 3);
        assert_eq!(read_u16_le(&data, 3), 17);
        assert_eq!(read_i128_le(&data, 5), 1_500_000);
        assert_eq!(read_u64_le(&data, 21), 200_000_000);
    }

    #[test]
    fn trade_cpi_negative_size_round_trips() {
        // Short positions encode as negative size_e6.
        let data = build_trade_cpi_data(0, 0, -1_000_000_000_000_000_000_i128, 0);
        assert_eq!(read_i128_le(&data, 5), -1_000_000_000_000_000_000_i128);
    }

    #[test]
    fn trade_cpi_extremes_round_trip() {
        let data = build_trade_cpi_data(u16::MAX, u16::MAX, i128::MAX, u64::MAX);
        assert_eq!(read_u16_le(&data, 1), u16::MAX);
        assert_eq!(read_u16_le(&data, 3), u16::MAX);
        assert_eq!(read_i128_le(&data, 5), i128::MAX);
        assert_eq!(read_u64_le(&data, 21), u64::MAX);
    }

    #[test]
    fn tags_are_distinct() {
        let tags = [
            PERCOLATOR_TAG_INIT_USER,
            PERCOLATOR_TAG_DEPOSIT_COLLATERAL,
            PERCOLATOR_TAG_WITHDRAW_COLLATERAL,
            PERCOLATOR_TAG_TRADE_CPI,
        ];
        for (i, &a) in tags.iter().enumerate() {
            for &b in &tags[i + 1..] {
                assert_ne!(a, b, "tag collision: {a} == {b}");
            }
        }
    }

    #[test]
    fn tag_values_pinned() {
        // Pin against percolator-prog source — drift here means
        // percolator's wire format changed without us noticing.
        assert_eq!(PERCOLATOR_TAG_INIT_USER, 1);
        assert_eq!(PERCOLATOR_TAG_DEPOSIT_COLLATERAL, 3);
        assert_eq!(PERCOLATOR_TAG_WITHDRAW_COLLATERAL, 4);
        assert_eq!(PERCOLATOR_TAG_TRADE_CPI, 10);
    }
}

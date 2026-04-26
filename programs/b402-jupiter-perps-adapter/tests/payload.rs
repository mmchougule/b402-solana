//! TDD scaffold for the Jupiter Perps adapter payload type.
//!
//! These tests assert Borsh round-trip semantics for every variant of
//! `JupPerpsAction`. They go GREEN as soon as the payload type is in place —
//! and stay green once the handler ships, since the wire format is the same.
//! They guard against accidental layout changes in future revisions.
//!
//! Handler-side tests live in `tests/onchain/tests/jup_perps_*.rs` (against
//! a Jupiter Perps clone on a mainnet-fork validator) — added when the impl
//! lands.

use anchor_lang::prelude::*;
use anchor_lang::AnchorDeserialize;
use anchor_lang::AnchorSerialize;
use b402_jupiter_perps_adapter::JupPerpsAction;

fn fixed_pubkey(seed: u8) -> Pubkey {
    Pubkey::new_from_array([seed; 32])
}

#[test]
fn open_position_round_trips() {
    let action = JupPerpsAction::OpenPosition {
        market_index: 1,
        side: 0,
        collateral_amount: 1_000_000,
        size_usd: 5_000_000,
        slippage_bps: 50,
    };
    let bytes = action.try_to_vec().unwrap();
    let decoded = JupPerpsAction::try_from_slice(&bytes).unwrap();
    assert_eq!(action, decoded);
}

#[test]
fn increase_position_round_trips() {
    let action = JupPerpsAction::IncreasePosition {
        position: fixed_pubkey(0xB1),
        collateral_delta: 250_000,
        size_delta_usd: 1_000_000,
        slippage_bps: 75,
    };
    let bytes = action.try_to_vec().unwrap();
    let decoded = JupPerpsAction::try_from_slice(&bytes).unwrap();
    assert_eq!(action, decoded);
}

#[test]
fn decrease_position_round_trips() {
    let action = JupPerpsAction::DecreasePosition {
        position: fixed_pubkey(0xB2),
        collateral_delta: 100_000,
        size_delta_usd: 500_000,
        slippage_bps: 50,
    };
    let bytes = action.try_to_vec().unwrap();
    let decoded = JupPerpsAction::try_from_slice(&bytes).unwrap();
    assert_eq!(action, decoded);
}

#[test]
fn close_position_round_trips() {
    let action = JupPerpsAction::ClosePosition {
        position: fixed_pubkey(0xB3),
        slippage_bps: 100,
    };
    let bytes = action.try_to_vec().unwrap();
    let decoded = JupPerpsAction::try_from_slice(&bytes).unwrap();
    assert_eq!(action, decoded);
}

#[test]
fn liquidate_guardrail_round_trips() {
    let action = JupPerpsAction::LiquidateGuardrail {
        position: fixed_pubkey(0xB4),
        max_health_factor_bps: 1100,
    };
    let bytes = action.try_to_vec().unwrap();
    let decoded = JupPerpsAction::try_from_slice(&bytes).unwrap();
    assert_eq!(action, decoded);
}

#[test]
fn variants_are_discriminator_distinct() {
    // Borsh enums prefix with a u8 discriminator. Confirm each variant
    // gets a unique tag — guards against silent reordering of the enum.
    let op = JupPerpsAction::OpenPosition {
        market_index: 0,
        side: 0,
        collateral_amount: 0,
        size_usd: 0,
        slippage_bps: 0,
    }
    .try_to_vec()
    .unwrap()[0];
    let ip = JupPerpsAction::IncreasePosition {
        position: Pubkey::default(),
        collateral_delta: 0,
        size_delta_usd: 0,
        slippage_bps: 0,
    }
    .try_to_vec()
    .unwrap()[0];
    let dp = JupPerpsAction::DecreasePosition {
        position: Pubkey::default(),
        collateral_delta: 0,
        size_delta_usd: 0,
        slippage_bps: 0,
    }
    .try_to_vec()
    .unwrap()[0];
    let cp = JupPerpsAction::ClosePosition {
        position: Pubkey::default(),
        slippage_bps: 0,
    }
    .try_to_vec()
    .unwrap()[0];
    let lg = JupPerpsAction::LiquidateGuardrail {
        position: Pubkey::default(),
        max_health_factor_bps: 0,
    }
    .try_to_vec()
    .unwrap()[0];

    let tags = [op, ip, dp, cp, lg];
    for (i, ti) in tags.iter().enumerate() {
        for (j, tj) in tags.iter().enumerate() {
            if i != j {
                assert_ne!(
                    ti, tj,
                    "variant {i} and {j} share Borsh tag {ti}; reorder = wire-format change"
                );
            }
        }
    }
}

#[test]
fn open_position_payload_size_is_stable() {
    // 1 disc + 2 market_index + 1 side + 8 collateral_amount + 8 size_usd + 2 slippage_bps = 22 bytes.
    let bytes = JupPerpsAction::OpenPosition {
        market_index: 0,
        side: 0,
        collateral_amount: 0,
        size_usd: 0,
        slippage_bps: 0,
    }
    .try_to_vec()
    .unwrap();
    assert_eq!(bytes.len(), 22);
}

#[test]
fn close_position_payload_size_is_stable() {
    // 1 disc + 32 position + 2 slippage_bps = 35 bytes.
    let bytes = JupPerpsAction::ClosePosition {
        position: Pubkey::default(),
        slippage_bps: 0,
    }
    .try_to_vec()
    .unwrap();
    assert_eq!(bytes.len(), 35);
}

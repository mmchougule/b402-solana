//! TDD scaffold for the Adrena adapter payload type.
//!
//! These tests assert Borsh round-trip semantics for every variant of
//! `AdrenaAction`. They go GREEN as soon as the payload type is in place —
//! and stay green once the handler ships, since the wire format is the same.
//! They guard against accidental layout changes in future revisions.
//!
//! Handler-side tests live in `tests/onchain/tests/adrena_*.rs` (against an
//! Adrena-program clone on a mainnet-fork validator) — added when the impl
//! lands.

use anchor_lang::prelude::*;
use anchor_lang::AnchorDeserialize;
use anchor_lang::AnchorSerialize;
use b402_adrena_adapter::AdrenaAction;

fn fixed_pubkey(seed: u8) -> Pubkey {
    Pubkey::new_from_array([seed; 32])
}

#[test]
fn open_position_round_trips() {
    let action = AdrenaAction::OpenPosition {
        custody: fixed_pubkey(0xA1),
        side: 0,
        collateral_amount: 1_000_000,
        size_usd: 5_000_000,
        slippage_bps: 50,
    };
    let bytes = action.try_to_vec().unwrap();
    let decoded = AdrenaAction::try_from_slice(&bytes).unwrap();
    assert_eq!(action, decoded);
}

#[test]
fn increase_position_round_trips() {
    let action = AdrenaAction::IncreasePosition {
        position: fixed_pubkey(0xA2),
        collateral_delta: 250_000,
        size_delta_usd: 1_000_000,
        slippage_bps: 75,
    };
    let bytes = action.try_to_vec().unwrap();
    let decoded = AdrenaAction::try_from_slice(&bytes).unwrap();
    assert_eq!(action, decoded);
}

#[test]
fn decrease_position_round_trips() {
    let action = AdrenaAction::DecreasePosition {
        position: fixed_pubkey(0xA3),
        collateral_delta: 100_000,
        size_delta_usd: 500_000,
        slippage_bps: 50,
    };
    let bytes = action.try_to_vec().unwrap();
    let decoded = AdrenaAction::try_from_slice(&bytes).unwrap();
    assert_eq!(action, decoded);
}

#[test]
fn close_position_round_trips() {
    let action = AdrenaAction::ClosePosition {
        position: fixed_pubkey(0xA4),
        slippage_bps: 100,
    };
    let bytes = action.try_to_vec().unwrap();
    let decoded = AdrenaAction::try_from_slice(&bytes).unwrap();
    assert_eq!(action, decoded);
}

#[test]
fn liquidate_guardrail_round_trips() {
    let action = AdrenaAction::LiquidateGuardrail {
        position: fixed_pubkey(0xA5),
        max_health_factor_bps: 1100,
    };
    let bytes = action.try_to_vec().unwrap();
    let decoded = AdrenaAction::try_from_slice(&bytes).unwrap();
    assert_eq!(action, decoded);
}

#[test]
fn variants_are_discriminator_distinct() {
    // Borsh enums prefix with a u8 discriminator. Confirm each variant
    // gets a unique tag — guards against silent reordering of the enum.
    let op = AdrenaAction::OpenPosition {
        custody: Pubkey::default(),
        side: 0,
        collateral_amount: 0,
        size_usd: 0,
        slippage_bps: 0,
    }
    .try_to_vec()
    .unwrap()[0];
    let ip = AdrenaAction::IncreasePosition {
        position: Pubkey::default(),
        collateral_delta: 0,
        size_delta_usd: 0,
        slippage_bps: 0,
    }
    .try_to_vec()
    .unwrap()[0];
    let dp = AdrenaAction::DecreasePosition {
        position: Pubkey::default(),
        collateral_delta: 0,
        size_delta_usd: 0,
        slippage_bps: 0,
    }
    .try_to_vec()
    .unwrap()[0];
    let cp = AdrenaAction::ClosePosition {
        position: Pubkey::default(),
        slippage_bps: 0,
    }
    .try_to_vec()
    .unwrap()[0];
    let lg = AdrenaAction::LiquidateGuardrail {
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
    // 1 disc + 32 custody + 1 side + 8 collateral_amount + 8 size_usd + 2 slippage_bps = 52 bytes.
    let bytes = AdrenaAction::OpenPosition {
        custody: Pubkey::default(),
        side: 0,
        collateral_amount: 0,
        size_usd: 0,
        slippage_bps: 0,
    }
    .try_to_vec()
    .unwrap();
    assert_eq!(bytes.len(), 52);
}

#[test]
fn close_position_payload_size_is_stable() {
    // 1 disc + 32 position + 2 slippage_bps = 35 bytes.
    let bytes = AdrenaAction::ClosePosition {
        position: Pubkey::default(),
        slippage_bps: 0,
    }
    .try_to_vec()
    .unwrap();
    assert_eq!(bytes.len(), 35);
}

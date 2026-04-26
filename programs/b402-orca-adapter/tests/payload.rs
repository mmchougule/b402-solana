//! TDD scaffold for the Orca whirlpool adapter payload type.
//!
//! These tests assert Borsh round-trip semantics for every variant of
//! `OrcaAction`. They go GREEN as soon as the payload type is in place —
//! and stay green once the handler ships, since the wire format is the
//! same. They guard against accidental layout changes in future revisions.
//!
//! Handler-side tests live in `tests/onchain/tests/orca_*.rs` (against a
//! Whirlpool clone on a mainnet-fork validator) — added when the impl lands.

use anchor_lang::prelude::*;
use anchor_lang::AnchorDeserialize;
use anchor_lang::AnchorSerialize;
use b402_orca_adapter::OrcaAction;

fn fixed_pubkey(seed: u8) -> Pubkey {
    Pubkey::new_from_array([seed; 32])
}

#[test]
fn open_position_round_trips() {
    let action = OrcaAction::OpenPosition {
        whirlpool: fixed_pubkey(0xA1),
        tick_lower: -443584,
        tick_upper: 443584,
    };
    let bytes = action.try_to_vec().unwrap();
    let decoded = OrcaAction::try_from_slice(&bytes).unwrap();
    assert_eq!(action, decoded);
}

#[test]
fn increase_liquidity_round_trips() {
    let action = OrcaAction::IncreaseLiquidity {
        position: fixed_pubkey(0xA2),
        liquidity_amount: 12_345_678_901_234_567_890u128,
        token_max_a: 1_000_000,
        token_max_b: 2_000_000,
    };
    let bytes = action.try_to_vec().unwrap();
    let decoded = OrcaAction::try_from_slice(&bytes).unwrap();
    assert_eq!(action, decoded);
}

#[test]
fn decrease_liquidity_round_trips() {
    let action = OrcaAction::DecreaseLiquidity {
        position: fixed_pubkey(0xA3),
        liquidity_amount: 500_000_000_000u128,
        token_min_a: 950_000,
        token_min_b: 1_900_000,
    };
    let bytes = action.try_to_vec().unwrap();
    let decoded = OrcaAction::try_from_slice(&bytes).unwrap();
    assert_eq!(action, decoded);
}

#[test]
fn collect_fees_round_trips() {
    let action = OrcaAction::CollectFees {
        position: fixed_pubkey(0xA4),
    };
    let bytes = action.try_to_vec().unwrap();
    let decoded = OrcaAction::try_from_slice(&bytes).unwrap();
    assert_eq!(action, decoded);
}

#[test]
fn close_position_round_trips() {
    let action = OrcaAction::ClosePosition {
        position: fixed_pubkey(0xA5),
    };
    let bytes = action.try_to_vec().unwrap();
    let decoded = OrcaAction::try_from_slice(&bytes).unwrap();
    assert_eq!(action, decoded);
}

#[test]
fn variants_are_discriminator_distinct() {
    // Borsh enums prefix with a u8 discriminator. Confirm each variant
    // gets a unique tag — guards against silent reordering of the enum.
    let op = OrcaAction::OpenPosition {
        whirlpool: Pubkey::default(),
        tick_lower: 0,
        tick_upper: 0,
    }
    .try_to_vec()
    .unwrap()[0];
    let il = OrcaAction::IncreaseLiquidity {
        position: Pubkey::default(),
        liquidity_amount: 0,
        token_max_a: 0,
        token_max_b: 0,
    }
    .try_to_vec()
    .unwrap()[0];
    let dl = OrcaAction::DecreaseLiquidity {
        position: Pubkey::default(),
        liquidity_amount: 0,
        token_min_a: 0,
        token_min_b: 0,
    }
    .try_to_vec()
    .unwrap()[0];
    let cf = OrcaAction::CollectFees {
        position: Pubkey::default(),
    }
    .try_to_vec()
    .unwrap()[0];
    let cp = OrcaAction::ClosePosition {
        position: Pubkey::default(),
    }
    .try_to_vec()
    .unwrap()[0];

    let tags = [op, il, dl, cf, cp];
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
    // 1 disc + 32 whirlpool + 4 tick_lower + 4 tick_upper = 41 bytes.
    let bytes = OrcaAction::OpenPosition {
        whirlpool: Pubkey::default(),
        tick_lower: 0,
        tick_upper: 0,
    }
    .try_to_vec()
    .unwrap();
    assert_eq!(bytes.len(), 41);
}

#[test]
fn increase_liquidity_payload_size_is_stable() {
    // 1 disc + 32 position + 16 liquidity_amount + 8 token_max_a + 8 token_max_b = 65 bytes.
    let bytes = OrcaAction::IncreaseLiquidity {
        position: Pubkey::default(),
        liquidity_amount: 0,
        token_max_a: 0,
        token_max_b: 0,
    }
    .try_to_vec()
    .unwrap();
    assert_eq!(bytes.len(), 65);
}

#[test]
fn collect_fees_payload_size_is_stable() {
    // 1 disc + 32 position = 33 bytes.
    let bytes = OrcaAction::CollectFees {
        position: Pubkey::default(),
    }
    .try_to_vec()
    .unwrap();
    assert_eq!(bytes.len(), 33);
}

//! TDD scaffold for the Kamino adapter payload type.
//!
//! These tests assert Borsh round-trip semantics for every variant of
//! `KaminoAction`. They go GREEN as soon as the payload type is in place —
//! and stay green once the handler ships, since the wire format is the
//! same. They guard against accidental layout changes in future revisions.
//!
//! Handler-side tests live in `tests/onchain/tests/kamino_*.rs` (against
//! a Kamino-program clone on a mainnet-fork validator) — added when the
//! impl lands.

use anchor_lang::prelude::*;
use anchor_lang::AnchorDeserialize;
use anchor_lang::AnchorSerialize;
use b402_kamino_adapter::KaminoAction;

fn fixed_pubkey(seed: u8) -> Pubkey {
    Pubkey::new_from_array([seed; 32])
}

#[test]
fn deposit_round_trips() {
    let action = KaminoAction::Deposit {
        reserve: fixed_pubkey(0xAA),
        in_amount: 1_000_000,
        min_kt_out: 950_000,
    };
    let bytes = action.try_to_vec().unwrap();
    let decoded = KaminoAction::try_from_slice(&bytes).unwrap();
    assert_eq!(action, decoded);
}

#[test]
fn withdraw_round_trips() {
    let action = KaminoAction::Withdraw {
        reserve: fixed_pubkey(0xBB),
        kt_in: 950_000,
        min_underlying_out: 1_000_000,
    };
    let bytes = action.try_to_vec().unwrap();
    let decoded = KaminoAction::try_from_slice(&bytes).unwrap();
    assert_eq!(action, decoded);
}

#[test]
fn borrow_round_trips() {
    let action = KaminoAction::Borrow {
        reserve: fixed_pubkey(0xCC),
        amount_out: 500_000,
        max_collateral_used_bps: 7500,
    };
    let bytes = action.try_to_vec().unwrap();
    let decoded = KaminoAction::try_from_slice(&bytes).unwrap();
    assert_eq!(action, decoded);
}

#[test]
fn repay_round_trips() {
    let action = KaminoAction::Repay {
        reserve: fixed_pubkey(0xDD),
        amount_in: 500_000,
    };
    let bytes = action.try_to_vec().unwrap();
    let decoded = KaminoAction::try_from_slice(&bytes).unwrap();
    assert_eq!(action, decoded);
}

#[test]
fn variants_are_discriminator_distinct() {
    // Borsh enums prefix with a u8 discriminator. Confirm each variant
    // gets a unique tag — guards against silent reordering of the enum.
    let d = KaminoAction::Deposit {
        reserve: Pubkey::default(),
        in_amount: 0,
        min_kt_out: 0,
    }
    .try_to_vec()
    .unwrap()[0];
    let w = KaminoAction::Withdraw {
        reserve: Pubkey::default(),
        kt_in: 0,
        min_underlying_out: 0,
    }
    .try_to_vec()
    .unwrap()[0];
    let b = KaminoAction::Borrow {
        reserve: Pubkey::default(),
        amount_out: 0,
        max_collateral_used_bps: 0,
    }
    .try_to_vec()
    .unwrap()[0];
    let r = KaminoAction::Repay {
        reserve: Pubkey::default(),
        amount_in: 0,
    }
    .try_to_vec()
    .unwrap()[0];

    let tags = [d, w, b, r];
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
fn deposit_payload_size_is_stable() {
    // 1 disc + 32 reserve + 8 in_amount + 8 min_kt_out = 49 bytes.
    let bytes = KaminoAction::Deposit {
        reserve: Pubkey::default(),
        in_amount: 0,
        min_kt_out: 0,
    }
    .try_to_vec()
    .unwrap();
    assert_eq!(bytes.len(), 49);
}

#[test]
fn borrow_payload_size_is_stable() {
    // 1 disc + 32 reserve + 8 amount_out + 2 max_collateral_used_bps = 43 bytes.
    let bytes = KaminoAction::Borrow {
        reserve: Pubkey::default(),
        amount_out: 0,
        max_collateral_used_bps: 0,
    }
    .try_to_vec()
    .unwrap();
    assert_eq!(bytes.len(), 43);
}

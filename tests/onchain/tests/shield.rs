//! Shield end-to-end tests on litesvm.

use b402_onchain_tests::{
    fixtures::ShieldFixture,
    harness::Harness,
    shield_ix::{send_shield, ShieldArgs},
};

fn setup_valid() -> (Harness, ShieldFixture) {
    let fx = ShieldFixture::load();
    let mint = fx.token_mint_pubkey();
    (Harness::setup(mint, 100), fx)
}

#[test]
fn shield_succeeds_with_valid_proof() {
    let (mut h, fx) = setup_valid();
    let args = ShieldArgs::from_fixture(&fx, &h.mint);
    send_shield(&mut h, args).expect("valid shield must succeed");

    assert_eq!(h.vault_balance(), 100, "vault should hold 100");
    assert_eq!(h.depositor_balance(), 0, "depositor should be empty");
    assert_eq!(h.tree_leaf_count(), 1, "tree should have 1 leaf");
}

#[test]
fn shield_rejects_tampered_proof_bytes() {
    let (mut h, fx) = setup_valid();
    let mut args = ShieldArgs::from_fixture(&fx, &h.mint);

    // Flip a single byte of proof_a.
    args.proof[0] ^= 0x01;

    let result = send_shield(&mut h, args);
    assert!(result.is_err(), "tampered proof must fail");
    assert_eq!(h.vault_balance(), 0);
    assert_eq!(h.tree_leaf_count(), 0);
}

#[test]
fn shield_rejects_tampered_merkle_root() {
    let (mut h, fx) = setup_valid();
    let mut args = ShieldArgs::from_fixture(&fx, &h.mint);

    // Change merkle_root to a value not in the root ring — pool rejects
    // BEFORE the verifier CPI (cheap path).
    args.public_inputs.merkle_root[0] ^= 0xff;

    let result = send_shield(&mut h, args);
    assert!(result.is_err(), "unknown root must be rejected");
    assert_eq!(h.vault_balance(), 0);
}

#[test]
fn shield_rejects_mint_mismatch() {
    let (mut h, fx) = setup_valid();
    let mut args = ShieldArgs::from_fixture(&fx, &h.mint);

    // Tamper public_token_mint so it doesn't match token_config.mint.
    args.public_inputs.public_token_mint[0] ^= 0x01;

    let result = send_shield(&mut h, args);
    assert!(result.is_err(), "mint mismatch must be rejected");
}

#[test]
fn shield_rejects_nonzero_nullifier_on_shield() {
    let (mut h, fx) = setup_valid();
    let mut args = ShieldArgs::from_fixture(&fx, &h.mint);

    // Shield requires both nullifiers to be zero (no input notes spent).
    args.public_inputs.nullifier[0][0] = 0x42;

    let result = send_shield(&mut h, args);
    assert!(result.is_err(), "non-zero nullifier on shield must be rejected");
}

#[test]
fn shield_rejects_fee_on_shield() {
    let (mut h, fx) = setup_valid();
    let mut args = ShieldArgs::from_fixture(&fx, &h.mint);

    // Per PRD-03 §4.3 the shield handler requires relayer_fee == 0.
    args.public_inputs.relayer_fee = 1;

    let result = send_shield(&mut h, args);
    assert!(result.is_err(), "relayer_fee != 0 on shield must be rejected");
}

#[test]
fn shield_rejects_wrong_public_amount() {
    let (mut h, fx) = setup_valid();
    let mut args = ShieldArgs::from_fixture(&fx, &h.mint);

    // Circuit committed to amount=100; lying about it breaks verifier.
    args.public_inputs.public_amount_in = 99;

    let result = send_shield(&mut h, args);
    assert!(result.is_err(), "wrong public_amount_in must fail verification");
}

#[test]
fn two_distinct_shields_advance_the_tree() {
    let fx = ShieldFixture::load();
    let fx_alt = ShieldFixture::load_named("shield_alt.json");
    let mint = fx.token_mint_pubkey();

    // The second shield must use the *same mint* as the first — both fixtures
    // committed to publicTokenMint = 111n = [111, 0, ..., 0].
    assert_eq!(fx.token_mint_pubkey(), fx_alt.token_mint_pubkey());

    let mut h = Harness::setup(mint, 200);

    // Build both argument sets up front so we don't re-borrow `h` while it's mut-borrowed.
    let args_1 = ShieldArgs::from_fixture(&fx, &h.mint);
    let args_2 = ShieldArgs::from_fixture(&fx_alt, &h.mint);
    assert_ne!(
        args_1.public_inputs.commitment_out[0],
        args_2.public_inputs.commitment_out[0],
        "fixtures should produce different commitments",
    );

    // Shield #1.
    send_shield(&mut h, args_1).expect("shield 1");
    assert_eq!(h.vault_balance(), 100);
    assert_eq!(h.tree_leaf_count(), 1);

    // The alt fixture's merkle_root is still the empty-tree root, which is in
    // the ring (position 0 initially, position 1 after the first shield). The
    // root ring has 64 slots, so it's well within freshness.
    send_shield(&mut h, args_2).expect("shield 2");
    assert_eq!(h.vault_balance(), 200, "vault holds both shields");
    assert_eq!(h.depositor_balance(), 0, "depositor drained");
    assert_eq!(h.tree_leaf_count(), 2, "tree should advance to leaf_count 2");
}

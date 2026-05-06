//! PRD-33 Phase 33.2 — per-user obligation payload + PDA tests.
//!
//! Stateful adapters (Kamino, Drift, Marginfi) consume an action_payload that
//! carries the user's `viewing_pub_hash` as its leading 32 bytes followed by
//! the original `KaminoAction` Borsh encoding. This file pins:
//!
//!   1. The decoder layout: `action_payload[0..32] = viewing_pub_hash`,
//!      `action_payload[32..] = Borsh(KaminoAction)`.
//!   2. The per-user `owner_pda` derivation = PDA(["b402/v1",
//!      "adapter-owner", viewing_pub_hash], adapter_program_id).
//!   3. Three distinct `viewing_pub_hash`es produce three distinct
//!      `owner_pda`s — the entire isolation argument hangs on this property.
//!   4. `decode_per_user_payload` rejects payloads shorter than 32 bytes
//!      (defence-in-depth so a stateful-adapter dispatch on a malformed
//!      payload fails cleanly instead of panicking on slice OOB).
//!
//! Handler-side wiring (deposit/withdraw using the per-user PDA as Kamino's
//! obligation owner) is exercised by tests/v2/e2e/v2_fork_lend_per_user.test.ts
//! against the cloned mainnet klend bytecode.

use anchor_lang::prelude::*;
use anchor_lang::AnchorSerialize;
use b402_kamino_adapter::{
    decode_per_user_payload, derive_owner_pda, KaminoAction, ID as ADAPTER_ID,
};

fn fixed_pubkey(seed: u8) -> Pubkey {
    Pubkey::new_from_array([seed; 32])
}

fn fixed_hash(seed: u8) -> [u8; 32] {
    [seed; 32]
}

#[test]
fn decode_per_user_payload_extracts_hash_and_inner_action() {
    let viewing_pub_hash = fixed_hash(0xA1);
    let inner = KaminoAction::Deposit {
        reserve: fixed_pubkey(0xAA),
        in_amount: 1_000_000,
        min_kt_out: 950_000,
    };
    let inner_bytes = inner.try_to_vec().unwrap();

    let mut wire = Vec::with_capacity(32 + inner_bytes.len());
    wire.extend_from_slice(&viewing_pub_hash);
    wire.extend_from_slice(&inner_bytes);

    let (extracted_hash, decoded_action) = decode_per_user_payload(&wire).unwrap();
    assert_eq!(extracted_hash, viewing_pub_hash);
    assert_eq!(decoded_action, inner);
}

#[test]
fn decode_per_user_payload_rejects_short_payload() {
    // 31 bytes — one short of the 32 B viewing_pub_hash prefix.
    let too_short = vec![0u8; 31];
    assert!(
        decode_per_user_payload(&too_short).is_err(),
        "must reject payloads shorter than 32 B viewing_pub_hash prefix",
    );
}

#[test]
fn decode_per_user_payload_rejects_missing_inner_action() {
    // Exactly 32 B — just the viewing_pub_hash, no KaminoAction body.
    let only_hash = vec![0u8; 32];
    assert!(
        decode_per_user_payload(&only_hash).is_err(),
        "must reject payloads with no KaminoAction body after the prefix",
    );
}

#[test]
fn derive_owner_pda_is_deterministic() {
    let h = fixed_hash(0x11);
    let (a, b1) = derive_owner_pda(&ADAPTER_ID, &h);
    let (a2, b2) = derive_owner_pda(&ADAPTER_ID, &h);
    assert_eq!(a, a2, "same hash → same PDA");
    assert_eq!(b1, b2, "same hash → same bump");
}

#[test]
fn three_distinct_users_get_three_distinct_owner_pdas() {
    let alice_hash = fixed_hash(0xA1);
    let bob_hash = fixed_hash(0xB2);
    let carol_hash = fixed_hash(0xC3);

    let (alice_pda, _) = derive_owner_pda(&ADAPTER_ID, &alice_hash);
    let (bob_pda, _) = derive_owner_pda(&ADAPTER_ID, &bob_hash);
    let (carol_pda, _) = derive_owner_pda(&ADAPTER_ID, &carol_hash);

    assert_ne!(alice_pda, bob_pda, "alice ≠ bob owner_pda");
    assert_ne!(bob_pda, carol_pda, "bob ≠ carol owner_pda");
    assert_ne!(alice_pda, carol_pda, "alice ≠ carol owner_pda");
}

#[test]
fn owner_pda_changes_with_one_bit_flip() {
    let mut h = fixed_hash(0x22);
    let (orig_pda, _) = derive_owner_pda(&ADAPTER_ID, &h);
    // Flip a single bit in the viewing_pub_hash.
    h[0] ^= 0x01;
    let (perturbed_pda, _) = derive_owner_pda(&ADAPTER_ID, &h);
    assert_ne!(orig_pda, perturbed_pda);
}

#[test]
fn owner_pda_seeds_match_prd_33_section_3_2() {
    // PRD-33 §3.2 pins the seed list. If anyone reorders these seeds the
    // SDK-derived owner_pda diverges from the on-chain derivation and every
    // per-user deposit dies with `KaminoCpiFailed` (signer seeds wrong).
    // Pinning the exact byte representation here makes that drift loud.
    let h = fixed_hash(0x33);
    let (expected_pda, expected_bump) = Pubkey::find_program_address(
        &[b"b402/v1", b"adapter-owner", h.as_ref()],
        &ADAPTER_ID,
    );
    let (actual_pda, actual_bump) = derive_owner_pda(&ADAPTER_ID, &h);
    assert_eq!(actual_pda, expected_pda);
    assert_eq!(actual_bump, expected_bump);
}

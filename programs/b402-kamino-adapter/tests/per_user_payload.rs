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

/// Mainnet USDC for the per-mint PDA tests below — any 32-byte pubkey
/// works, USDC is just a stable choice.
const USDC_MINT_BYTES: [u8; 32] = [
    198, 250, 122, 243, 190, 219, 173, 58, 61, 101, 243, 106, 171, 201, 116, 49,
    177, 187, 228, 194, 210, 246, 224, 228, 124, 166, 2, 3, 69, 47, 93, 97,
];

#[test]
fn derive_owner_pda_is_deterministic() {
    let h = fixed_hash(0x11);
    let mint = Pubkey::new_from_array(USDC_MINT_BYTES);
    let (a, b1) = derive_owner_pda(&ADAPTER_ID, &h, &mint);
    let (a2, b2) = derive_owner_pda(&ADAPTER_ID, &h, &mint);
    assert_eq!(a, a2, "same hash + mint → same PDA");
    assert_eq!(b1, b2, "same hash + mint → same bump");
}

#[test]
fn three_distinct_users_get_three_distinct_owner_pdas() {
    let mint = Pubkey::new_from_array(USDC_MINT_BYTES);
    let alice_hash = fixed_hash(0xA1);
    let bob_hash = fixed_hash(0xB2);
    let carol_hash = fixed_hash(0xC3);

    let (alice_pda, _) = derive_owner_pda(&ADAPTER_ID, &alice_hash, &mint);
    let (bob_pda, _) = derive_owner_pda(&ADAPTER_ID, &bob_hash, &mint);
    let (carol_pda, _) = derive_owner_pda(&ADAPTER_ID, &carol_hash, &mint);

    assert_ne!(alice_pda, bob_pda, "alice ≠ bob owner_pda");
    assert_ne!(bob_pda, carol_pda, "bob ≠ carol owner_pda");
    assert_ne!(alice_pda, carol_pda, "alice ≠ carol owner_pda");
}

#[test]
fn same_user_different_mints_get_different_pdas() {
    // Per-(viewing_key, mint) derivation: a single user lending USDC and
    // SOL must end up with TWO independent Kamino obligations. Without
    // this, refresh_obligation has to walk both reserves on every op and
    // positions can't be redeemed independently.
    let h = fixed_hash(0x44);
    let usdc_mint = Pubkey::new_from_array(USDC_MINT_BYTES);
    let sol_mint = Pubkey::new_from_array([
        6, 155, 136, 87, 254, 171, 129, 132, 251, 104, 127, 99, 70, 24, 192,
        53, 218, 196, 57, 220, 26, 235, 59, 85, 152, 160, 240, 0, 0, 0, 0, 1,
    ]);
    let (usdc_pda, _) = derive_owner_pda(&ADAPTER_ID, &h, &usdc_mint);
    let (sol_pda, _) = derive_owner_pda(&ADAPTER_ID, &h, &sol_mint);
    assert_ne!(usdc_pda, sol_pda, "same user, different mint → distinct PDA");
}

#[test]
fn owner_pda_changes_with_one_bit_flip() {
    let mint = Pubkey::new_from_array(USDC_MINT_BYTES);
    let mut h = fixed_hash(0x22);
    let (orig_pda, _) = derive_owner_pda(&ADAPTER_ID, &h, &mint);
    // Flip a single bit in the viewing_pub_hash.
    h[0] ^= 0x01;
    let (perturbed_pda, _) = derive_owner_pda(&ADAPTER_ID, &h, &mint);
    assert_ne!(orig_pda, perturbed_pda);
}

#[test]
fn owner_pda_seeds_match_extended_layout() {
    // Pinned seed list: ["b402/v1", "adapter-owner", viewing_pub_hash, mint].
    // SDK derivation must match byte-for-byte or every per-user deposit
    // dies with KaminoCpiFailed (signer seeds wrong).
    let h = fixed_hash(0x33);
    let mint = Pubkey::new_from_array(USDC_MINT_BYTES);
    let (expected_pda, expected_bump) = Pubkey::find_program_address(
        &[b"b402/v1", b"adapter-owner", h.as_ref(), mint.as_ref()],
        &ADAPTER_ID,
    );
    let (actual_pda, actual_bump) = derive_owner_pda(&ADAPTER_ID, &h, &mint);
    assert_eq!(actual_pda, expected_pda);
    assert_eq!(actual_bump, expected_bump);
}

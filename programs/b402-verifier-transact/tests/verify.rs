//! Integration test — exercises `verify_proof_be` with a real proof produced
//! by `circuits/scripts/gen-test-proof.mjs`.
//!
//! The fixture at `circuits/build/test_artifacts/shield_valid.json` is
//! generated from the throwaway-ceremony zkey + the compiled transact.wasm.
//! Regenerate after any circuit or VK change:
//!
//!   cd circuits && node scripts/gen-test-proof.mjs

use b402_verifier_transact::{verify_proof_be, PUBLIC_INPUT_COUNT};
use serde::Deserialize;

const FIXTURE_PATH: &str = "../../circuits/build/test_artifacts/shield_valid.json";

#[derive(Deserialize)]
struct Fixture {
    proof_a_be: String,
    proof_b_be: String,
    proof_c_be: String,
    public_inputs_be: Vec<String>,
}

fn load_fixture() -> (Vec<u8>, Vec<u8>, Vec<u8>, Vec<[u8; 32]>) {
    let raw = std::fs::read_to_string(FIXTURE_PATH)
        .unwrap_or_else(|_| panic!(
            "missing fixture {FIXTURE_PATH}; run `cd circuits && node scripts/gen-test-proof.mjs`",
        ));
    let f: Fixture = serde_json::from_str(&raw).expect("fixture json parse");
    let a = hex::decode(&f.proof_a_be).unwrap();
    let b = hex::decode(&f.proof_b_be).unwrap();
    let c = hex::decode(&f.proof_c_be).unwrap();
    let pi: Vec<[u8; 32]> = f.public_inputs_be.iter().map(|h| {
        let v = hex::decode(h).unwrap();
        let mut arr = [0u8; 32];
        arr.copy_from_slice(&v);
        arr
    }).collect();
    (a, b, c, pi)
}

#[test]
fn valid_proof_verifies() {
    let (a, b, c, pi) = load_fixture();
    assert_eq!(a.len(), 64);
    assert_eq!(b.len(), 128);
    assert_eq!(c.len(), 64);
    assert_eq!(pi.len(), PUBLIC_INPUT_COUNT);

    let mut pa = [0u8; 64]; pa.copy_from_slice(&a);
    let mut pb = [0u8; 128]; pb.copy_from_slice(&b);
    let mut pc = [0u8; 64]; pc.copy_from_slice(&c);
    let mut pis = [[0u8; 32]; PUBLIC_INPUT_COUNT];
    for i in 0..PUBLIC_INPUT_COUNT { pis[i] = pi[i]; }

    verify_proof_be(&pa, &pb, &pc, &pis).expect("valid proof must verify");
}

#[test]
fn tampered_public_inputs_rejected() {
    let (a, b, c, pi) = load_fixture();

    let mut pa = [0u8; 64]; pa.copy_from_slice(&a);
    let mut pb = [0u8; 128]; pb.copy_from_slice(&b);
    let mut pc = [0u8; 64]; pc.copy_from_slice(&c);
    let mut pis = [[0u8; 32]; PUBLIC_INPUT_COUNT];
    for i in 0..PUBLIC_INPUT_COUNT { pis[i] = pi[i]; }

    // Flip the first bit of merkleRoot (public input 0).
    pis[0][31] ^= 0x01;

    let r = verify_proof_be(&pa, &pb, &pc, &pis);
    assert!(r.is_err(), "tampered public inputs must be rejected");
}

#[test]
fn tampered_proof_rejected() {
    let (a, b, c, pi) = load_fixture();

    let mut pa = [0u8; 64]; pa.copy_from_slice(&a);
    let mut pb = [0u8; 128]; pb.copy_from_slice(&b);
    let mut pc = [0u8; 64]; pc.copy_from_slice(&c);
    let mut pis = [[0u8; 32]; PUBLIC_INPUT_COUNT];
    for i in 0..PUBLIC_INPUT_COUNT { pis[i] = pi[i]; }

    // Flip a byte in proof A.
    pa[0] ^= 0x01;

    let r = verify_proof_be(&pa, &pb, &pc, &pis);
    assert!(r.is_err(), "tampered proof must be rejected");
}

/// Helper: load fixture, mutate a single public-input byte, assert verify fails.
/// Public-input layout (BE here, LE on chain) per `programs/b402-pool/src/instructions/transact.rs`:
///   0  merkle_root        5  public_amount_in   10 root_bind         15 spend_key_pub_tag
///   1  nullifier[0]       6  public_amount_out  11 recipient_bind    16 fee_bind_tag
///   2  nullifier[1]       7  public_token_mint  12 commit_tag        17 recipient_bind_tag
///   3  commitment_out[0]  8  relayer_fee        13 nullifier_tag
///   4  commitment_out[1]  9  relayer_fee_bind   14 mk_node_tag
fn assert_tamper_rejected(idx: usize, byte: usize, mask: u8, what: &str) {
    let (a, b, c, pi) = load_fixture();
    let mut pa = [0u8; 64]; pa.copy_from_slice(&a);
    let mut pb = [0u8; 128]; pb.copy_from_slice(&b);
    let mut pc = [0u8; 64]; pc.copy_from_slice(&c);
    let mut pis = [[0u8; 32]; PUBLIC_INPUT_COUNT];
    for i in 0..PUBLIC_INPUT_COUNT { pis[i] = pi[i]; }

    pis[idx][byte] ^= mask;

    let r = verify_proof_be(&pa, &pb, &pc, &pis);
    assert!(r.is_err(), "tampered {what} (pi[{idx}]) must be rejected");
}

#[test]
fn tampered_root_bind_rejected() {
    // pi[10] = root_bind. Binds the merkle_root into the proof so a relayer
    // can't substitute a fresher root + replay an old proof.
    assert_tamper_rejected(10, 31, 0x01, "root_bind");
}

#[test]
fn tampered_recipient_bind_rejected() {
    // pi[11] = recipient_bind = Poseidon_3(tag, ownerLow, ownerHigh).
    // Tampering = redirect-funds attack from a malicious relayer.
    assert_tamper_rejected(11, 31, 0x01, "recipient_bind");
}

#[test]
fn tampered_relayer_fee_bind_rejected() {
    // pi[9] = relayer_fee_bind. Binds (fee, recipient) into the proof so the
    // relayer can't inflate its fee or redirect it to a different ATA.
    assert_tamper_rejected(9, 31, 0x01, "relayer_fee_bind");
}

#[test]
fn tampered_nullifier_rejected() {
    // pi[1] = nullifier[0]. The double-spend guard — flipping a bit yields
    // an unconsumed nullifier and the proof must reject (else replay attack).
    assert_tamper_rejected(1, 31, 0x01, "nullifier[0]");
}

#[test]
fn tampered_commitment_out_rejected() {
    // pi[3] = commitment_out[0]. Output note commitment is bound to the
    // input notes' value via the circuit — tampering breaks the binding.
    assert_tamper_rejected(3, 31, 0x01, "commitment_out[0]");
}

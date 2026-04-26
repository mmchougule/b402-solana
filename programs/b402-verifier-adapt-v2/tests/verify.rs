//! Integration test — exercises `verify_proof_be` against a real adapt v2
//! proof produced by `circuits/scripts/gen-test-proof-adapt-v2.mjs`.
//!
//! Tests are gated on the fixture file existing — RED until the v2 ceremony
//! runs and the fixture is generated.

use b402_verifier_adapt_v2::{verify_proof_be, PUBLIC_INPUT_COUNT};
use serde::Deserialize;

const FIXTURE_PATH: &str = "../../circuits/build/test_artifacts/adapt_v2_valid.json";

#[derive(Deserialize)]
struct Fixture {
    proof_a_be: String,
    proof_b_be: String,
    proof_c_be: String,
    public_inputs_be: Vec<String>,
}

fn try_load_fixture() -> Option<(Vec<u8>, Vec<u8>, Vec<u8>, Vec<[u8; 32]>)> {
    let raw = std::fs::read_to_string(FIXTURE_PATH).ok()?;
    let f: Fixture = serde_json::from_str(&raw).ok()?;
    let a = hex::decode(&f.proof_a_be).ok()?;
    let b = hex::decode(&f.proof_b_be).ok()?;
    let c = hex::decode(&f.proof_c_be).ok()?;
    let pi: Vec<[u8; 32]> = f.public_inputs_be.iter().filter_map(|h| {
        let v = hex::decode(h).ok()?;
        if v.len() != 32 { return None; }
        let mut arr = [0u8; 32];
        arr.copy_from_slice(&v);
        Some(arr)
    }).collect();
    if pi.len() != PUBLIC_INPUT_COUNT { return None; }
    Some((a, b, c, pi))
}

fn load_or_skip() -> Option<(Vec<u8>, Vec<u8>, Vec<u8>, Vec<[u8; 32]>)> {
    let f = try_load_fixture();
    if f.is_none() {
        eprintln!(
            "skipping: missing fixture {FIXTURE_PATH}; run \
             `bash circuits/scripts/compile-adapt-v2.sh && \
              bash circuits/scripts/throwaway-ceremony-adapt-v2.sh && \
              node circuits/scripts/vk-to-rust.mjs circuits/build/ceremony/adapt_v2_verification_key.json programs/b402-verifier-adapt-v2/src/vk.rs ADAPT_V2_VK && \
              node circuits/scripts/gen-test-proof-adapt-v2.mjs`",
        );
    }
    f
}

#[test]
fn valid_adapt_v2_proof_verifies() {
    let Some((a, b, c, pi)) = load_or_skip() else { return; };
    assert_eq!(a.len(), 64);
    assert_eq!(b.len(), 128);
    assert_eq!(c.len(), 64);
    assert_eq!(pi.len(), PUBLIC_INPUT_COUNT, "adapt v2 must have 38 public inputs");

    let mut pa = [0u8; 64]; pa.copy_from_slice(&a);
    let mut pb = [0u8; 128]; pb.copy_from_slice(&b);
    let mut pc = [0u8; 64]; pc.copy_from_slice(&c);
    let mut pis = [[0u8; 32]; PUBLIC_INPUT_COUNT];
    for i in 0..PUBLIC_INPUT_COUNT { pis[i] = pi[i]; }

    verify_proof_be(&pa, &pb, &pc, &pis).expect("valid adapt v2 proof must verify");
}

#[test]
fn tampered_action_hash_rejected() {
    // Public input 26 = actionHash (PRD-12 keystone). Tampering must reject.
    let Some((a, b, c, pi)) = load_or_skip() else { return; };

    let mut pa = [0u8; 64]; pa.copy_from_slice(&a);
    let mut pb = [0u8; 128]; pb.copy_from_slice(&b);
    let mut pc = [0u8; 64]; pc.copy_from_slice(&c);
    let mut pis = [[0u8; 32]; PUBLIC_INPUT_COUNT];
    for i in 0..PUBLIC_INPUT_COUNT { pis[i] = pi[i]; }

    pis[26][31] ^= 0x01;

    let r = verify_proof_be(&pa, &pb, &pc, &pis);
    assert!(r.is_err(), "tampered v2 actionHash must be rejected");
}

#[test]
fn tampered_adapter_id_rejected() {
    // Public input 25 = adapterId. Binds proof to a specific adapter program.
    let Some((a, b, c, pi)) = load_or_skip() else { return; };

    let mut pa = [0u8; 64]; pa.copy_from_slice(&a);
    let mut pb = [0u8; 128]; pb.copy_from_slice(&b);
    let mut pc = [0u8; 64]; pc.copy_from_slice(&c);
    let mut pis = [[0u8; 32]; PUBLIC_INPUT_COUNT];
    for i in 0..PUBLIC_INPUT_COUNT { pis[i] = pi[i]; }

    pis[25][31] ^= 0x01;

    let r = verify_proof_be(&pa, &pb, &pc, &pis);
    assert!(r.is_err(), "tampered v2 adapterId must be rejected");
}

#[test]
fn tampered_accounts_hash_rejected() {
    // Public input 34 = accountsHash (NEW for v2 per PRD-12). The pool
    // recomputes keccak over the canonical AccountMeta list it forwards;
    // a flipped bit here = a relayer who tried to swap a single account.
    let Some((a, b, c, pi)) = load_or_skip() else { return; };

    let mut pa = [0u8; 64]; pa.copy_from_slice(&a);
    let mut pb = [0u8; 128]; pb.copy_from_slice(&b);
    let mut pc = [0u8; 64]; pc.copy_from_slice(&c);
    let mut pis = [[0u8; 32]; PUBLIC_INPUT_COUNT];
    for i in 0..PUBLIC_INPUT_COUNT { pis[i] = pi[i]; }

    pis[34][31] ^= 0x01;

    let r = verify_proof_be(&pa, &pb, &pc, &pis);
    assert!(r.is_err(), "tampered v2 accountsHash must be rejected");
}

#[test]
fn tampered_proof_rejected() {
    let Some((a, b, c, pi)) = load_or_skip() else { return; };

    let mut pa = [0u8; 64]; pa.copy_from_slice(&a);
    let mut pb = [0u8; 128]; pb.copy_from_slice(&b);
    let mut pc = [0u8; 64]; pc.copy_from_slice(&c);
    let mut pis = [[0u8; 32]; PUBLIC_INPUT_COUNT];
    for i in 0..PUBLIC_INPUT_COUNT { pis[i] = pi[i]; }

    pa[0] ^= 0x01;

    let r = verify_proof_be(&pa, &pb, &pc, &pis);
    assert!(r.is_err(), "tampered v2 proof must be rejected");
}

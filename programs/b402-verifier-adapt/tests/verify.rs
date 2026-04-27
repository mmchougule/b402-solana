//! Integration test — exercises `verify_proof_be` against a real adapt proof
//! produced by `circuits/scripts/gen-test-proof-adapt.mjs`.

use b402_verifier_adapt::{verify_proof_be, PUBLIC_INPUT_COUNT};
use serde::Deserialize;

const FIXTURE_PATH: &str = "../../circuits/build/test_artifacts/adapt_valid.json";

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
            "missing fixture {FIXTURE_PATH}; run `cd circuits && node scripts/gen-test-proof-adapt.mjs`",
        ));
    let f: Fixture = serde_json::from_str(&raw).expect("fixture json parse");
    let a = hex::decode(&f.proof_a_be).unwrap();
    let b = hex::decode(&f.proof_b_be).unwrap();
    let c = hex::decode(&f.proof_c_be).unwrap();
    let pi: Vec<[u8; 32]> = f
        .public_inputs_be
        .iter()
        .map(|h| {
            let v = hex::decode(h).unwrap();
            let mut arr = [0u8; 32];
            arr.copy_from_slice(&v);
            arr
        })
        .collect();
    (a, b, c, pi)
}

#[test]
fn valid_adapt_proof_verifies() {
    let (a, b, c, pi) = load_fixture();
    assert_eq!(a.len(), 64);
    assert_eq!(b.len(), 128);
    assert_eq!(c.len(), 64);
    assert_eq!(
        pi.len(),
        PUBLIC_INPUT_COUNT,
        "adapt must have 23 public inputs"
    );

    let mut pa = [0u8; 64];
    pa.copy_from_slice(&a);
    let mut pb = [0u8; 128];
    pb.copy_from_slice(&b);
    let mut pc = [0u8; 64];
    pc.copy_from_slice(&c);
    let mut pis = [[0u8; 32]; PUBLIC_INPUT_COUNT];
    for i in 0..PUBLIC_INPUT_COUNT {
        pis[i] = pi[i];
    }

    verify_proof_be(&pa, &pb, &pc, &pis).expect("valid adapt proof must verify");
}

#[test]
fn tampered_adapter_id_rejected() {
    // Flip a bit in public input 18 (adapterId). The proof MUST be rejected —
    // this is the binding that prevents a proof generated for adapter X from
    // being replayed against adapter Y.
    let (a, b, c, pi) = load_fixture();

    let mut pa = [0u8; 64];
    pa.copy_from_slice(&a);
    let mut pb = [0u8; 128];
    pb.copy_from_slice(&b);
    let mut pc = [0u8; 64];
    pc.copy_from_slice(&c);
    let mut pis = [[0u8; 32]; PUBLIC_INPUT_COUNT];
    for i in 0..PUBLIC_INPUT_COUNT {
        pis[i] = pi[i];
    }

    pis[18][31] ^= 0x01;

    let r = verify_proof_be(&pa, &pb, &pc, &pis);
    assert!(r.is_err(), "tampered adapterId must be rejected");
}

#[test]
fn tampered_expected_out_mint_rejected() {
    // Flip a bit in public input 21 (expectedOutMint). Proof bound the
    // output commitment's mint to this value; tampering must be caught.
    let (a, b, c, pi) = load_fixture();

    let mut pa = [0u8; 64];
    pa.copy_from_slice(&a);
    let mut pb = [0u8; 128];
    pb.copy_from_slice(&b);
    let mut pc = [0u8; 64];
    pc.copy_from_slice(&c);
    let mut pis = [[0u8; 32]; PUBLIC_INPUT_COUNT];
    for i in 0..PUBLIC_INPUT_COUNT {
        pis[i] = pi[i];
    }

    pis[21][31] ^= 0x01;

    let r = verify_proof_be(&pa, &pb, &pc, &pis);
    assert!(r.is_err(), "tampered expectedOutMint must be rejected");
}

#[test]
fn tampered_action_hash_rejected() {
    // Flip a bit in public input 19 (actionHash). Binds action_payload +
    // expectedOutMint. Tampering = replay or payload swap attack.
    let (a, b, c, pi) = load_fixture();

    let mut pa = [0u8; 64];
    pa.copy_from_slice(&a);
    let mut pb = [0u8; 128];
    pb.copy_from_slice(&b);
    let mut pc = [0u8; 64];
    pc.copy_from_slice(&c);
    let mut pis = [[0u8; 32]; PUBLIC_INPUT_COUNT];
    for i in 0..PUBLIC_INPUT_COUNT {
        pis[i] = pi[i];
    }

    pis[19][31] ^= 0x01;

    let r = verify_proof_be(&pa, &pb, &pc, &pis);
    assert!(r.is_err(), "tampered actionHash must be rejected");
}

#[test]
fn tampered_proof_rejected() {
    let (a, b, c, pi) = load_fixture();

    let mut pa = [0u8; 64];
    pa.copy_from_slice(&a);
    let mut pb = [0u8; 128];
    pb.copy_from_slice(&b);
    let mut pc = [0u8; 64];
    pc.copy_from_slice(&c);
    let mut pis = [[0u8; 32]; PUBLIC_INPUT_COUNT];
    for i in 0..PUBLIC_INPUT_COUNT {
        pis[i] = pi[i];
    }

    pa[0] ^= 0x01;

    let r = verify_proof_be(&pa, &pb, &pc, &pis);
    assert!(r.is_err(), "tampered proof must be rejected");
}

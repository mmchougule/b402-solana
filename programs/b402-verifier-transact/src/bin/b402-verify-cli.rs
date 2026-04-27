//! Verify-CLI — stdin-driven wrapper around `verify_proof_be`.
//!
//! Lets TS tests (or any outside caller) exercise the on-chain verifier code
//! path without running a Solana validator. Used by
//! `packages/prover/tests/verifier-integration.test.ts`.
//!
//! stdin format:
//!   line 1  = proof hex (256 bytes → 512 hex chars)
//!   lines 2..17 = 16 public inputs, each 32-byte hex (64 chars) in LE
//!
//! stdout:
//!   "OK"      on successful verify
//!   "FAIL: <msg>" on any failure

use std::io::Read;

use b402_verifier_transact::{reverse_endianness, verify_proof_be, PUBLIC_INPUT_COUNT};

fn decode_hex(s: &str) -> Vec<u8> {
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).expect("bad hex"))
        .collect()
}

fn main() {
    let mut input = String::new();
    std::io::stdin()
        .read_to_string(&mut input)
        .expect("read stdin");
    let lines: Vec<&str> = input.lines().collect();
    if lines.len() != 1 + PUBLIC_INPUT_COUNT {
        println!(
            "FAIL: expected {} lines, got {}",
            1 + PUBLIC_INPUT_COUNT,
            lines.len()
        );
        std::process::exit(1);
    }

    let proof = decode_hex(lines[0]);
    if proof.len() != 256 {
        println!("FAIL: proof length {} ≠ 256", proof.len());
        std::process::exit(1);
    }

    let mut proof_a = [0u8; 64];
    let mut proof_b = [0u8; 128];
    let mut proof_c = [0u8; 64];
    proof_a.copy_from_slice(&proof[0..64]);
    proof_b.copy_from_slice(&proof[64..192]);
    proof_c.copy_from_slice(&proof[192..256]);

    // Public inputs come LE; convert to BE per the on-chain contract.
    let mut pubs_be: [[u8; 32]; PUBLIC_INPUT_COUNT] = [[0u8; 32]; PUBLIC_INPUT_COUNT];
    for i in 0..PUBLIC_INPUT_COUNT {
        let v = decode_hex(lines[i + 1]);
        if v.len() != 32 {
            println!("FAIL: pi[{}] length {} ≠ 32", i, v.len());
            std::process::exit(1);
        }
        let mut le = [0u8; 32];
        le.copy_from_slice(&v);
        pubs_be[i] = reverse_endianness(&le);
    }

    match verify_proof_be(&proof_a, &proof_b, &proof_c, &pubs_be) {
        Ok(()) => println!("OK"),
        Err(e) => {
            println!("FAIL: {:?}", e);
            std::process::exit(2);
        }
    }
}

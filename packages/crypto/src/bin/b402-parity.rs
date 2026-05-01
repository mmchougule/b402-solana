//! Parity binary — exposes crypto primitives via stdin/args for the TS parity
//! tests (`circuits/tests/parity.test.ts`) to cross-check.
//!
//! Usage:
//!   b402-parity poseidon-tagged <tag> <inputs...>
//!   b402-parity commitment <tokenMint> <value> <random> <spendingPub>
//!   b402-parity nullifier <spendingPriv> <leafIndex>
//!   b402-parity spending-pub <spendingPriv>
//!   b402-parity merkle-empty-root
//!   b402-parity merkle-append <leaf1> <leaf2> ...
//!
//! Every output is the decimal representation of an Fr as a BigUint string,
//! matching `bigint.toString()` on the TS side.

use std::env;
use std::process::exit;


use b402_crypto::{
    domain::DomainTag,
    merkle::MerkleTree,
    poseidon::{self},
    Fr,
};

fn parse_fr(s: &str) -> Fr {
    // Accept decimal BigUint strings, same as TS bigint.
    let n: num_bigint::BigUint = s.parse().expect("bad decimal");
    let bytes = n.to_bytes_le();
    let mut buf = [0u8; 32];
    let len = bytes.len().min(32);
    buf[..len].copy_from_slice(&bytes[..len]);
    Fr::from_le_bytes_reduced(&buf)
}

fn fr_to_decimal(fr: Fr) -> String {
    let le = fr.to_le_bytes();
    let n = num_bigint::BigUint::from_bytes_le(&le);
    n.to_string()
}

fn tag_from_name(name: &str) -> DomainTag {
    match name {
        "commit" => DomainTag::Commit,
        "nullifier" => DomainTag::Nullifier,
        "mk-node" => DomainTag::MerkleNode,
        "mk-zero" => DomainTag::MerkleZero,
        "spend-key-pub" => DomainTag::SpendKeyPub,
        "fee-bind" => DomainTag::FeeBind,
        "root-bind" => DomainTag::RootBind,
        "adapt-bind" => DomainTag::AdaptBind,
        "view-tag" => DomainTag::ViewTag,
        other => {
            eprintln!("unknown tag: {other}");
            exit(1);
        }
    }
}

fn main() {
    let args: Vec<String> = env::args().skip(1).collect();
    if args.is_empty() {
        eprintln!("usage: b402-parity <cmd> ...");
        exit(2);
    }

    match args[0].as_str() {
        "poseidon-tagged" => {
            let tag = tag_from_name(&args[1]);
            let inputs: Vec<Fr> = args[2..].iter().map(|s| parse_fr(s)).collect();
            let out = poseidon::poseidon_tagged(tag, &inputs).expect("poseidon");
            println!("{}", fr_to_decimal(out));
        }
        "commitment" => {
            let t = parse_fr(&args[1]);
            let v: u64 = args[2].parse().expect("bad value");
            let r = parse_fr(&args[3]);
            let sp = parse_fr(&args[4]);
            let out = poseidon::commitment(t, v, r, sp).expect("poseidon");
            println!("{}", fr_to_decimal(out));
        }
        "nullifier" => {
            let sp = parse_fr(&args[1]);
            let li: u64 = args[2].parse().expect("bad leafIndex");
            let out = poseidon::nullifier(sp, li).expect("poseidon");
            println!("{}", fr_to_decimal(out));
        }
        "spending-pub" => {
            let sp = parse_fr(&args[1]);
            let out = poseidon::spending_pub(sp).expect("poseidon");
            println!("{}", fr_to_decimal(out));
        }
        "merkle-empty-root" => {
            let tree = MerkleTree::new_client();
            println!("{}", fr_to_decimal(tree.root));
        }
        "merkle-append" => {
            let mut tree = MerkleTree::new_client();
            for leaf_s in args.iter().skip(1) {
                let leaf = parse_fr(leaf_s);
                tree.append(leaf);
            }
            println!("{}", fr_to_decimal(tree.root));
        }
        other => {
            eprintln!("unknown cmd: {other}");
            exit(2);
        }
    }

    // Ensure we don't emit trailing debug info.
    let _ = <Fr as From<_>>::from(ark_bn254::Fr::from(0u64));
}

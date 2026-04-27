//! b402 shielded-pool cryptographic primitives.
//!
//! Implements the specification in `docs/prds/PRD-02-crypto-spec.md`. Every
//! primitive here has a TypeScript parity implementation in `packages/sdk`
//! and a Circom constraint in `circuits/`. All three must produce identical
//! outputs on the test vectors in `tests/vectors.json`.

#![deny(unsafe_code)]

pub mod domain;
pub mod fr;
pub mod merkle;
pub mod note;
pub mod poseidon;

pub use domain::DomainTag;
pub use fr::Fr;
pub use merkle::{MerkleProof, MerkleTree, TREE_DEPTH};
pub use note::{Commitment, Note, Nullifier};

pub const TREE_ROOT_HISTORY: usize = 64;

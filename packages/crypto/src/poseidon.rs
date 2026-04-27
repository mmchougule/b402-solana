//! Poseidon hash over BN254, per PRD-02 §1.1.
//!
//! Parameters: x^5 S-box, circomlib-compatible round constants and MDS.
//! We delegate to `light-poseidon` which implements circomlib's poseidon
//! with the BN254 scalar field. Any deviation from circomlib's output is
//! a bug in `light-poseidon` and must be caught by the parity tests in
//! `tests/parity/`.

use ark_bn254::Fr as ArkFr;
use ark_ff::PrimeField;
use light_poseidon::{Poseidon, PoseidonBytesHasher, PoseidonError};

use crate::domain::DomainTag;
use crate::Fr;

#[derive(Debug, thiserror::Error)]
pub enum HashError {
    #[error("poseidon error: {0:?}")]
    Poseidon(PoseidonError),
    #[error("unsupported arity {0}")]
    UnsupportedArity(usize),
}

impl From<PoseidonError> for HashError {
    fn from(e: PoseidonError) -> Self {
        Self::Poseidon(e)
    }
}

/// Hash `k` field elements with a raw Poseidon of width `k+1`.
/// Used internally; most call sites want the domain-tagged variants below.
fn poseidon_raw(inputs: &[Fr]) -> Result<Fr, HashError> {
    let arity = inputs.len();
    if !matches!(arity, 1 | 2 | 3 | 4 | 5) {
        return Err(HashError::UnsupportedArity(arity));
    }
    let mut hasher = Poseidon::<ArkFr>::new_circom(arity)?;
    let bytes: Vec<[u8; 32]> = inputs.iter().map(|f| f.to_le_bytes()).collect();
    let refs: Vec<&[u8]> = bytes.iter().map(|b| b.as_slice()).collect();
    let out = hasher.hash_bytes_le(&refs)?;
    let fr = ArkFr::from_le_bytes_mod_order(&out);
    Ok(Fr(fr))
}

/// Domain-tagged hash: prepends the tag as the first input.
/// The circuit does the same, ensuring parity.
pub fn poseidon_tagged(tag: DomainTag, inputs: &[Fr]) -> Result<Fr, HashError> {
    let mut all = Vec::with_capacity(inputs.len() + 1);
    all.push(tag.to_fr());
    all.extend_from_slice(inputs);
    poseidon_raw(&all)
}

pub fn commitment(
    token_mint: Fr,
    value: u64,
    random: Fr,
    spending_pub: Fr,
) -> Result<Fr, HashError> {
    poseidon_tagged(
        DomainTag::Commit,
        &[token_mint, Fr::from_u64(value), random, spending_pub],
    )
}

pub fn nullifier(spending_priv: Fr, leaf_index: u64) -> Result<Fr, HashError> {
    poseidon_tagged(
        DomainTag::Nullifier,
        &[spending_priv, Fr::from_u64(leaf_index)],
    )
}

pub fn merkle_node(left: Fr, right: Fr) -> Result<Fr, HashError> {
    poseidon_tagged(DomainTag::MerkleNode, &[left, right])
}

pub fn merkle_zero_seed() -> Result<Fr, HashError> {
    // zero[0] = Poseidon_1 of domain tag (single-input Poseidon with tag only)
    poseidon_tagged(DomainTag::MerkleZero, &[])
}

pub fn spending_pub(spending_priv: Fr) -> Result<Fr, HashError> {
    poseidon_tagged(DomainTag::SpendKeyPub, &[spending_priv])
}

pub fn fee_bind(recipient_as_fr: Fr, fee: u64) -> Result<Fr, HashError> {
    poseidon_tagged(DomainTag::FeeBind, &[recipient_as_fr, Fr::from_u64(fee)])
}

pub fn adapt_bind(action_keccak_as_fr: Fr, expected_out_mint: Fr) -> Result<Fr, HashError> {
    poseidon_tagged(
        DomainTag::AdaptBind,
        &[action_keccak_as_fr, expected_out_mint],
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn commitment_is_deterministic() {
        let t = Fr::from_u64(42);
        let r = Fr::from_u64(1337);
        let p = Fr::from_u64(9999);
        let c1 = commitment(t, 1_000_000, r, p).unwrap();
        let c2 = commitment(t, 1_000_000, r, p).unwrap();
        assert_eq!(c1, c2);
    }

    #[test]
    fn commitment_depends_on_every_input() {
        let t = Fr::from_u64(42);
        let r = Fr::from_u64(1337);
        let p = Fr::from_u64(9999);
        let base = commitment(t, 1_000_000, r, p).unwrap();

        assert_ne!(base, commitment(Fr::from_u64(43), 1_000_000, r, p).unwrap());
        assert_ne!(base, commitment(t, 1_000_001, r, p).unwrap());
        assert_ne!(
            base,
            commitment(t, 1_000_000, Fr::from_u64(1338), p).unwrap()
        );
        assert_ne!(
            base,
            commitment(t, 1_000_000, r, Fr::from_u64(10000)).unwrap()
        );
    }

    #[test]
    fn nullifier_unlinkable_to_commitment() {
        // Informal: knowing nullifier cannot recover spending_priv without
        // exhaustive search. This is Poseidon one-wayness; we just sanity
        // that nullifier differs from commitment materially.
        let sp = Fr::from_u64(7);
        let n = nullifier(sp, 0).unwrap();
        let c = commitment(Fr::from_u64(1), 1, Fr::from_u64(2), sp).unwrap();
        assert_ne!(n, c);
    }

    #[test]
    fn domain_tags_disambiguate() {
        // Poseidon_2(commit-tag, x, y) must differ from Poseidon_2(null-tag, x, y)
        let x = Fr::from_u64(1);
        let y = Fr::from_u64(2);
        let a = poseidon_tagged(DomainTag::Commit, &[x, y]).unwrap();
        let b = poseidon_tagged(DomainTag::Nullifier, &[x, y]).unwrap();
        assert_ne!(a, b);
    }
}

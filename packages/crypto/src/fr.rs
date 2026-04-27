//! BN254 scalar field element wrapper.
//!
//! Canonical on-wire encoding: 32-byte little-endian, canonical (`x < p`).

use ark_bn254::Fr as ArkFr;
use ark_ff::{AdditiveGroup, BigInteger, PrimeField, Zero};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub struct Fr(pub ArkFr);

#[derive(Debug, thiserror::Error)]
pub enum FrError {
    #[error("value not canonical (>= field modulus)")]
    NonCanonical,
    #[error("invalid length: expected 32 bytes")]
    InvalidLength,
}

impl Fr {
    pub const ZERO: Self = Self(<ArkFr as AdditiveGroup>::ZERO);

    /// Canonical decode: rejects values ≥ p.
    pub fn from_le_bytes(bytes: &[u8]) -> Result<Self, FrError> {
        if bytes.len() != 32 {
            return Err(FrError::InvalidLength);
        }
        // Manual canonical check: interpret bytes as LE integer and compare
        // against modulus. ark's PrimeField::from_le_bytes_mod_order silently
        // reduces; we want rejection.
        //
        // Build a BigInt-compatible comparison by checking the integer
        // directly via `from_random_bytes` isn't correct either — it also
        // reduces. Cleanest path: do the comparison ourselves.
        // Canonical iff bytes, interpreted LE, is strictly < modulus.
        // Walk from most-significant byte (LE index 31) downward.
        let modulus_le = ArkFr::MODULUS.to_bytes_le();
        let mut is_canonical = false;
        for i in (0..32).rev() {
            match bytes[i].cmp(&modulus_le[i]) {
                std::cmp::Ordering::Less => {
                    is_canonical = true;
                    break;
                }
                std::cmp::Ordering::Greater => {
                    is_canonical = false;
                    break;
                }
                std::cmp::Ordering::Equal => continue,
            }
        }
        if !is_canonical {
            return Err(FrError::NonCanonical);
        }
        Ok(Self(ArkFr::from_le_bytes_mod_order(bytes)))
    }

    pub fn from_le_bytes_reduced(bytes: &[u8]) -> Self {
        Self(ArkFr::from_le_bytes_mod_order(bytes))
    }

    pub fn to_le_bytes(&self) -> [u8; 32] {
        let mut out = [0u8; 32];
        let bi = self.0.into_bigint();
        let b = bi.to_bytes_le();
        out[..b.len()].copy_from_slice(&b);
        out
    }

    pub fn from_u64(v: u64) -> Self {
        Self(ArkFr::from(v))
    }

    pub fn is_zero(&self) -> bool {
        self.0.is_zero()
    }

    /// Encode a UTF-8 string of length ≤ 31 as a single Fr by interpreting the
    /// bytes as a big-endian integer, then reducing mod p. Used for domain
    /// tags per PRD-02 §1.2.
    pub fn from_tag(tag: &str) -> Self {
        assert!(tag.len() <= 31, "domain tag must be ≤ 31 bytes");
        let mut be = [0u8; 32];
        be[32 - tag.len()..].copy_from_slice(tag.as_bytes());
        let mut le = [0u8; 32];
        for i in 0..32 {
            le[i] = be[31 - i];
        }
        Self::from_le_bytes_reduced(&le)
    }
}

impl From<ArkFr> for Fr {
    fn from(x: ArkFr) -> Self {
        Self(x)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zero_roundtrip() {
        let z = Fr::ZERO;
        assert_eq!(z.to_le_bytes(), [0u8; 32]);
        assert_eq!(Fr::from_le_bytes(&[0u8; 32]).unwrap(), z);
    }

    #[test]
    fn u64_encodes_as_le() {
        let one = Fr::from_u64(1);
        let mut expected = [0u8; 32];
        expected[0] = 1;
        assert_eq!(one.to_le_bytes(), expected);
    }

    #[test]
    fn tag_is_deterministic() {
        let a = Fr::from_tag("b402/v1/commit");
        let b = Fr::from_tag("b402/v1/commit");
        assert_eq!(a, b);
    }

    #[test]
    fn different_tags_differ() {
        let a = Fr::from_tag("b402/v1/commit");
        let b = Fr::from_tag("b402/v1/null");
        assert_ne!(a, b);
    }

    #[test]
    fn rejects_non_canonical() {
        // p - 1 (canonical, largest valid Fr)
        // BN254 Fr modulus = 21888242871839275222246405745257275088548364400416034343698204186575808495617
        // Modulus in LE bytes:
        //   0x01, 0x00, 0x00, 0xf0, 0x93, 0xf5, 0xe1, 0x43,
        //   0x91, 0x70, 0xb9, 0x79, 0x48, 0xe8, 0x33, 0x28,
        //   0x5d, 0x58, 0x81, 0x81, 0xb6, 0x45, 0x50, 0xb8,
        //   0x29, 0xa0, 0x31, 0xe1, 0x72, 0x4e, 0x64, 0x30
        let p_minus_1 = [
            0x00, 0x00, 0x00, 0xf0, 0x93, 0xf5, 0xe1, 0x43, 0x91, 0x70, 0xb9, 0x79, 0x48, 0xe8,
            0x33, 0x28, 0x5d, 0x58, 0x81, 0x81, 0xb6, 0x45, 0x50, 0xb8, 0x29, 0xa0, 0x31, 0xe1,
            0x72, 0x4e, 0x64, 0x30,
        ];
        // p itself — should be rejected.
        let p = [
            0x01, 0x00, 0x00, 0xf0, 0x93, 0xf5, 0xe1, 0x43, 0x91, 0x70, 0xb9, 0x79, 0x48, 0xe8,
            0x33, 0x28, 0x5d, 0x58, 0x81, 0x81, 0xb6, 0x45, 0x50, 0xb8, 0x29, 0xa0, 0x31, 0xe1,
            0x72, 0x4e, 0x64, 0x30,
        ];
        assert!(
            Fr::from_le_bytes(&p_minus_1).is_ok(),
            "p-1 should be canonical"
        );
        assert!(
            Fr::from_le_bytes(&p).is_err(),
            "p itself should be rejected"
        );
    }
}

//! Shielded notes per PRD-02 §3.

use crate::{poseidon, Fr};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Note {
    pub token_mint: Fr, // mint pubkey reduced mod p
    pub value: u64,
    pub random: Fr,
    pub spending_pub: Fr,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Commitment(pub Fr);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Nullifier(pub Fr);

impl Note {
    pub fn commitment(&self) -> Commitment {
        Commitment(
            poseidon::commitment(self.token_mint, self.value, self.random, self.spending_pub)
                .expect("poseidon"),
        )
    }

    pub fn nullifier(&self, spending_priv: Fr, leaf_index: u64) -> Nullifier {
        // Sanity: spending_priv must match spending_pub. Not enforced here
        // (circuit does it); SDK callers are trusted to provide correct key.
        let _ = spending_priv;
        Nullifier(poseidon::nullifier(spending_priv, leaf_index).expect("poseidon"))
    }
}

impl Commitment {
    pub fn to_bytes(self) -> [u8; 32] {
        self.0.to_le_bytes()
    }
}

impl Nullifier {
    pub fn to_bytes(self) -> [u8; 32] {
        self.0.to_le_bytes()
    }

    /// 16-bit prefix used for shard routing per PRD-03 §3.3.
    pub fn shard_prefix(&self) -> u16 {
        let b = self.0.to_le_bytes();
        // High 16 bits when interpreted as LE. Take the top 2 bytes.
        u16::from_le_bytes([b[30], b[31]])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn commitment_deterministic() {
        let n = Note {
            token_mint: Fr::from_u64(1),
            value: 100,
            random: Fr::from_u64(2),
            spending_pub: Fr::from_u64(3),
        };
        assert_eq!(n.commitment(), n.commitment());
    }

    #[test]
    fn nullifier_differs_by_index() {
        let n = Note {
            token_mint: Fr::from_u64(1),
            value: 100,
            random: Fr::from_u64(2),
            spending_pub: Fr::from_u64(3),
        };
        let sp = Fr::from_u64(99);
        assert_ne!(n.nullifier(sp, 0).to_bytes(), n.nullifier(sp, 1).to_bytes());
    }
}

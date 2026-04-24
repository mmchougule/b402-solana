//! Load the pre-generated shield proof fixture.

use serde::Deserialize;
use std::path::PathBuf;

#[derive(Deserialize)]
pub struct ShieldFixture {
    pub proof_a_be: String,
    pub proof_b_be: String,
    pub proof_c_be: String,
    pub public_inputs_be: Vec<String>,
    pub public_decimals: Vec<String>,
}

impl ShieldFixture {
    pub fn load() -> Self {
        Self::load_named("shield_valid.json")
    }

    pub fn load_named(filename: &str) -> Self {
        let p = super::workspace_root()
            .join("circuits/build/test_artifacts")
            .join(filename);
        let raw = std::fs::read_to_string(&p).unwrap_or_else(|_| panic!(
            "missing fixture {}; run: cd circuits && node scripts/gen-test-proof.mjs <scenario>",
            p.display(),
        ));
        serde_json::from_str(&raw).unwrap()
    }

    pub fn proof_bytes(&self) -> Vec<u8> {
        let mut v = Vec::with_capacity(256);
        v.extend_from_slice(&hex::decode(&self.proof_a_be).unwrap());
        v.extend_from_slice(&hex::decode(&self.proof_b_be).unwrap());
        v.extend_from_slice(&hex::decode(&self.proof_c_be).unwrap());
        assert_eq!(v.len(), 256);
        v
    }

    /// Public inputs in the WIRE format the pool program expects: 32-byte LE per field.
    /// Fixture stores BE; convert here.
    pub fn public_inputs_le(&self) -> Vec<[u8; 32]> {
        self.public_inputs_be.iter().map(|h| {
            let be = hex::decode(h).unwrap();
            let mut le = [0u8; 32];
            for i in 0..32 { le[i] = be[31 - i]; }
            le
        }).collect()
    }

    /// The `publicTokenMint` public input as a 32-byte LE-interpreted Pubkey.
    /// This is what the pool handler compares against `token_config.mint`.
    pub fn token_mint_pubkey(&self) -> solana_pubkey::Pubkey {
        // Public input index 7 = publicTokenMint (see PRD-02 §6.2).
        let pi = self.public_inputs_le();
        solana_pubkey::Pubkey::new_from_array(pi[7])
    }

    /// Recipient-owner pubkey the unshield fixture commits to. MUST be the
    /// owner of the `recipient_token_account` in on-chain tests, or the
    /// pool's recipient_bind check will reject. Mirrors `TEST_RECIPIENT_BYTES`
    /// in `circuits/scripts/gen-test-proof.mjs`.
    pub fn test_recipient_pubkey() -> solana_pubkey::Pubkey {
        solana_pubkey::Pubkey::new_from_array([
            0xa1, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8,
            0xb1, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8,
            0xc1, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8,
            0xd1, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8,
        ])
    }

    pub fn artifacts_path() -> PathBuf {
        super::workspace_root().join("circuits/build/test_artifacts")
    }
}

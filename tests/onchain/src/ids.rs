//! Program IDs — must match `declare_id!` in each crate.

use solana_pubkey::Pubkey;
use std::str::FromStr;

pub fn b402_pool() -> Pubkey {
    Pubkey::from_str("42a3hsCXtQLWonyxWZosaaCJCweYYKMrvNd25p1Jrt2y").unwrap()
}

pub fn b402_verifier_transact() -> Pubkey {
    Pubkey::from_str("Afjbnv2Ekxa98jjRw33xPPhZabevek2uZxoE75kr6ZrK").unwrap()
}

pub fn b402_jupiter_adapter() -> Pubkey {
    Pubkey::from_str("3RHRcbinCmcj8JPBfVxb9FW76oh4r8y21aSx4JFy3yx7").unwrap()
}

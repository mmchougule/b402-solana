//! Program IDs — must match `declare_id!` in each crate.

use solana_pubkey::Pubkey;
use std::str::FromStr;

pub fn b402_pool() -> Pubkey {
    Pubkey::from_str("2vMTGvSCobE7HfVvdSHsmVNzCFmbYdc3TsQwekUwcusy").unwrap()
}

pub fn b402_verifier_transact() -> Pubkey {
    Pubkey::from_str("G6AycE529UPg1hib72A5A7Yf8eZRx9uFmDZQYMSYhEC7").unwrap()
}

pub fn b402_jupiter_adapter() -> Pubkey {
    Pubkey::from_str("2FLQngd2Z1cqN7q4BU8vxDm2WNxXLwGDT3FYubQrFncg").unwrap()
}

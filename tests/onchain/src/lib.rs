//! Helpers shared by the on-chain integration tests.
//!
//! Everything here runs on the HOST (not SBF). We load the three b402 programs
//! as compiled .so files and drive them via litesvm's in-process Solana VM.
//!
//! By construction, this exercises EXACTLY the bytecode that would ship on
//! mainnet — same verifier, same pool logic, same byte layouts.

pub mod discriminator;
pub mod fixtures;
pub mod harness;
pub mod ids;
pub mod mint;
pub mod shield_ix;
pub mod unshield_ix;

use std::path::PathBuf;

pub fn workspace_root() -> PathBuf {
    let here = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    // tests/onchain/Cargo.toml → ../../
    here.parent().unwrap().parent().unwrap().to_path_buf()
}

pub fn deploy_dir() -> PathBuf {
    workspace_root().join("target/deploy")
}

pub fn program_path(name: &str) -> PathBuf {
    deploy_dir().join(format!("{name}.so"))
}

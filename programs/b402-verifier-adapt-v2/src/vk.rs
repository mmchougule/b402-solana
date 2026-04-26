//! PLACEHOLDER — replaced after the v2 ceremony runs.
//!
//! Produced manually so the crate compiles before `circuits/scripts/throwaway-ceremony-adapt-v2.sh`
//! is executed. After the ceremony, run:
//!   node circuits/scripts/vk-to-rust.mjs \
//!     circuits/build/ceremony/adapt_v2_verification_key.json \
//!     programs/b402-verifier-adapt-v2/src/vk.rs \
//!     ADAPT_V2_VK
//! to overwrite this file with the real VK.
//!
//! IMPORTANT: this placeholder will fail every proof. Tests that depend on
//! a real proof are gated on the existence of `circuits/build/test_artifacts/adapt_v2_valid.json`
//! and skip otherwise.
//!
//! Format is groth16-solana's `Groth16Verifyingkey`. IC has 39 entries =
//! 38 public inputs + 1 constant term.

use groth16_solana::groth16::Groth16Verifyingkey;

pub const VK_ALPHA_G1: [u8; 64] = [0u8; 64];

pub const VK_BETA_G2: [u8; 128] = [0u8; 128];

pub const VK_GAMMA_G2: [u8; 128] = [0u8; 128];

pub const VK_DELTA_G2: [u8; 128] = [0u8; 128];

pub const VK_IC: [[u8; 64]; 39] = [
    [0u8; 64], [0u8; 64], [0u8; 64], [0u8; 64], [0u8; 64],
    [0u8; 64], [0u8; 64], [0u8; 64], [0u8; 64], [0u8; 64],
    [0u8; 64], [0u8; 64], [0u8; 64], [0u8; 64], [0u8; 64],
    [0u8; 64], [0u8; 64], [0u8; 64], [0u8; 64], [0u8; 64],
    [0u8; 64], [0u8; 64], [0u8; 64], [0u8; 64], [0u8; 64],
    [0u8; 64], [0u8; 64], [0u8; 64], [0u8; 64], [0u8; 64],
    [0u8; 64], [0u8; 64], [0u8; 64], [0u8; 64], [0u8; 64],
    [0u8; 64], [0u8; 64], [0u8; 64], [0u8; 64],
];

pub const ADAPT_V2_VK: Groth16Verifyingkey = Groth16Verifyingkey {
    nr_pubinputs: 38,
    vk_alpha_g1: VK_ALPHA_G1,
    vk_beta_g2: VK_BETA_G2,
    vk_gamme_g2: VK_GAMMA_G2,
    vk_delta_g2: VK_DELTA_G2,
    vk_ic: &VK_IC,
};

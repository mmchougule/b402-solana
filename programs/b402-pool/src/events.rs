//! On-chain events per PRD-03 §6. SDK indexers consume these to reconstruct
//! the merkle tree and discover owned notes.

use anchor_lang::prelude::*;

#[event]
pub struct PoolInitialized {
    pub admin_multisig: Pubkey,
    pub admin_threshold: u8,
    pub slot: u64,
}

#[event]
pub struct TokenWhitelisted {
    pub mint: Pubkey,
    pub decimals: u8,
    pub vault: Pubkey,
    pub slot: u64,
}

#[event]
pub struct CommitmentAppended {
    pub leaf_index: u64,
    pub commitment: [u8; 32],
    pub ciphertext: [u8; 89],
    pub ephemeral_pub: [u8; 32],
    pub viewing_tag: [u8; 2],
    pub tree_root_after: [u8; 32],
    pub slot: u64,
}

#[event]
pub struct NullifierSpent {
    pub nullifier: [u8; 32],
    pub shard: u16,
    pub slot: u64,
}

#[event]
pub struct ShieldExecuted {
    pub mint: Pubkey,
    pub amount: u64,
    pub slot: u64,
}

#[event]
pub struct UnshieldExecuted {
    pub mint: Pubkey,
    pub recipient: Pubkey,
    pub amount: u64,
    pub relayer_fee: u64,
    pub slot: u64,
}

#[event]
pub struct AdapterRegistered {
    pub adapter_id: [u8; 32],
    pub program_id: Pubkey,
    pub slot: u64,
}

#[event]
pub struct PoolPauseChanged {
    pub flag: u8,              // 0 shields, 1 transacts, 2 adapts
    pub paused: bool,
    pub slot: u64,
}

#[event]
pub struct AdaptExecuted {
    pub adapter_program: Pubkey,
    pub in_mint: Pubkey,
    pub out_mint: Pubkey,
    pub public_amount_in: u64,
    pub out_delta: u64,
    pub expected_out_value: u64,
    pub relayer_fee: u64,
    pub slot: u64,
}

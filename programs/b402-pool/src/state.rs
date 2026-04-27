//! Pool state accounts per PRD-03 §3.4.
//!
//! `TreeState` and `NullifierShard` are `#[account(zero_copy)]` so that
//! Anchor's `AccountLoader` reads their fields directly from account data
//! without memcpying the struct onto the caller's stack. Without this,
//! the Anchor-generated instruction dispatcher would blow BPF's 4 KiB
//! stack limit on `transact` and `unshield` (each pulls tree + 2 shards).

use crate::constants::{ROOT_HISTORY_SIZE, TREE_DEPTH};
use anchor_lang::prelude::*;

/// Small account, Borsh-serialized is fine.
#[account]
pub struct PoolConfig {
    pub version: u16,
    pub admin_multisig: Pubkey,
    pub admin_threshold: u8,
    pub paused_shields: bool,
    pub paused_transacts: bool,
    pub paused_adapts: bool,
    pub upgrade_authority_revoked: bool,
    pub deployed_slot: u64,
    pub verifier_transact: Pubkey,
    pub verifier_adapt: Pubkey,
    pub verifier_disclose: Pubkey,
    /// Admin-settable share of the relayer-fee paid out by `adapt_execute_v2`
    /// that gets routed to the treasury. Capped at `PROTOCOL_FEE_SHARE_BPS_MAX`
    /// (2500 = 25%) by the `set_protocol_fee_share` handler so admin can't
    /// rug. Default 0 — protocol-fee-free at deploy.
    pub protocol_fee_share_bps: u16,
    /// Carved from the original `_reserved[u8; 96]` so PoolConfig length stays
    /// byte-identical (8 + 2 + 32 + 1 + 1 + 1 + 1 + 1 + 8 + 32 + 32 + 32 + 2 + 94 = 247).
    pub _reserved: [u8; 94],
}
impl PoolConfig {
    pub const LEN: usize = 8 + 2 + 32 + 1 + 1 + 1 + 1 + 1 + 8 + 32 + 32 + 32 + 2 + 94;
}

/// Hard cap on `protocol_fee_share_bps`. The admin handler enforces this.
/// 25% of the relayer-fee is the upper bound; no instruction can set higher.
pub const PROTOCOL_FEE_SHARE_BPS_MAX: u16 = 2_500;

/// Small account.
#[account]
pub struct TokenConfig {
    pub mint: Pubkey,
    pub decimals: u8,
    pub vault: Pubkey,
    pub enabled: bool,
    pub added_at_slot: u64,
    /// Hard cap on per-mint pool TVL (smallest units, e.g. 100_000_000_000 for
    /// 100k USDC at 6 decimals). Shield is rejected if `vault.amount + amount > max_tvl`.
    /// Carved from the original `_reserved[u8; 32]` so account layout stays the
    /// same total size (8 + 32 + 1 + 32 + 1 + 8 + 8 + 24 = 114).
    /// Zero means "no shielding allowed" (fail-closed default).
    pub max_tvl: u64,
    pub _reserved: [u8; 24],
}
impl TokenConfig {
    pub const LEN: usize = 8 + 32 + 1 + 32 + 1 + 8 + 8 + 24;
}

/// Large account — zero-copy.
#[account(zero_copy)]
#[repr(C)]
pub struct TreeState {
    pub version: u16,
    pub _pad0: [u8; 6], // align to 8
    pub leaf_count: u64,
    pub ring_head: u8,
    pub _pad1: [u8; 7],
    pub root_ring: [[u8; 32]; ROOT_HISTORY_SIZE], // 2048
    pub frontier: [[u8; 32]; TREE_DEPTH],         // 832
    pub zero_cache: [[u8; 32]; TREE_DEPTH],       // 832
    pub _reserved: [u8; 64],
}
impl TreeState {
    // 8 (discriminator) + struct contents. With #[repr(C)] + zero_copy:
    pub const LEN: usize = 8
        + 2
        + 6
        + 8
        + 1
        + 7
        + (32 * ROOT_HISTORY_SIZE)
        + (32 * TREE_DEPTH)
        + (32 * TREE_DEPTH)
        + 64;
}

/// Fixed-capacity nullifier shard — zero-copy.
///
/// Each shard holds up to `MAX_NULLIFIERS_PER_SHARD` sorted nullifiers.
/// The shard key space is 16-bit prefix → 65,536 shards.
///
/// Size constraint: Solana's `MAX_PERMITTED_DATA_INCREASE = 10,240` caps the
/// account size that can be created from a CPI (which is what
/// `init_if_needed` in `transact`/`unshield` does). We therefore size each
/// shard to fit under 10 KiB:
///   8 (disc) + 2 (prefix) + 2 (pad) + 4 (count) + 320·32 = 10,256 ... use 300.
///
/// Capacity across all shards: 65,536 × 300 = ~19.6M nullifiers. At saturation
/// of v1, shard-resize-to-larger becomes a followup upgrade via a dedicated
/// top-level instruction (which is not bounded by the 10 KiB CPI cap).
pub const MAX_NULLIFIERS_PER_SHARD: usize = 300;
pub const NULLIFIER_BYTES_PER_SHARD: usize = MAX_NULLIFIERS_PER_SHARD * 32;

/// Newtype wrapper so we can manually implement `Pod` + `Zeroable` for an
/// arbitrarily-sized byte buffer. bytemuck's derive macros only auto-impl
/// those traits for a fixed set of array sizes.
#[derive(Copy, Clone)]
#[repr(C)]
pub struct NullifierBuf(pub [u8; NULLIFIER_BYTES_PER_SHARD]);

// SAFETY: NullifierBuf is a plain `[u8; N]` — all byte patterns are valid
// and it contains no padding or indirection.
unsafe impl bytemuck::Zeroable for NullifierBuf {}
unsafe impl bytemuck::Pod for NullifierBuf {}

#[account(zero_copy)]
#[repr(C)]
pub struct NullifierShard {
    pub prefix: u16,
    pub _pad0: [u8; 2],
    pub count: u32,
    pub nullifiers_bytes: NullifierBuf,
}
impl NullifierShard {
    pub const LEN: usize = 8 + 2 + 2 + 4 + NULLIFIER_BYTES_PER_SHARD;

    /// View the nullifiers as a slice of 32-byte arrays. Panics if `count`
    /// exceeds capacity (should be unreachable given `util::nullifier_insert`
    /// guards on insert).
    pub fn nullifiers(&self) -> &[[u8; 32]] {
        let count = self.count as usize;
        debug_assert!(count <= MAX_NULLIFIERS_PER_SHARD);
        bytemuck::cast_slice(&self.nullifiers_bytes.0[..count * 32])
    }

    pub fn nullifier_at(&self, idx: usize) -> [u8; 32] {
        let off = idx * 32;
        let mut out = [0u8; 32];
        out.copy_from_slice(&self.nullifiers_bytes.0[off..off + 32]);
        out
    }

    pub fn set_nullifier(&mut self, idx: usize, value: [u8; 32]) {
        let off = idx * 32;
        self.nullifiers_bytes.0[off..off + 32].copy_from_slice(&value);
    }
}

/// Small account — Borsh.
#[account]
pub struct AdapterRegistry {
    pub version: u16,
    pub count: u16,
    pub adapters: Vec<AdapterInfo>,
}
impl AdapterRegistry {
    pub const BASE_LEN: usize = 8 + 2 + 2 + 4;
    pub fn size_for_capacity(cap: usize) -> usize {
        Self::BASE_LEN + (cap * AdapterInfo::LEN)
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct AdapterInfo {
    pub adapter_id: [u8; 32],
    pub program_id: Pubkey,
    pub enabled: bool,
    pub allowed_instruction_count: u8,
    pub allowed_instructions: [[u8; 8]; 8],
}
impl AdapterInfo {
    pub const LEN: usize = 32 + 32 + 1 + 1 + (8 * 8);
}

#[account]
pub struct TreasuryConfig {
    pub treasury_pubkey: Pubkey,
    pub _reserved: [u8; 32],
}
impl TreasuryConfig {
    pub const LEN: usize = 8 + 32 + 32;
}

//! Utilities: merkle append, nullifier shard ops.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::poseidon::{hashv, Endianness, Parameters};

use crate::constants::{ROOT_HISTORY_SIZE, TAG_MK_NODE, TREE_DEPTH};
use crate::error::PoolError;
use crate::state::{NullifierShard, TreeState};

pub fn poseidon_mk_node(left: &[u8; 32], right: &[u8; 32]) -> Result<[u8; 32]> {
    let h = hashv(
        Parameters::Bn254X5,
        Endianness::LittleEndian,
        &[&TAG_MK_NODE[..], &left[..], &right[..]],
    )
    .map_err(|_| error!(PoolError::ProofVerificationFailed))?;
    Ok(h.to_bytes())
}

/// Append a leaf to the incremental merkle tree and update state.
/// Mirrors `packages/crypto/src/merkle.rs::MerkleTree::append` exactly.
pub fn tree_append(tree: &mut TreeState, leaf: [u8; 32]) -> Result<[u8; 32]> {
    let idx = tree.leaf_count;
    require!(
        (idx as u128) < (1u128 << TREE_DEPTH as u32),
        PoolError::TreeCapacityExceeded
    );

    let mut cur = leaf;
    let mut level: usize = 0;

    loop {
        let bit = (idx >> level) & 1;
        if bit == 0 {
            tree.frontier[level] = cur;
            cur = poseidon_mk_node(&cur, &tree.zero_cache[level])?;
            break;
        } else {
            cur = poseidon_mk_node(&tree.frontier[level], &cur)?;
        }
        level += 1;
        if level >= TREE_DEPTH {
            return err!(PoolError::TreeCapacityExceeded);
        }
    }

    let mut walking = cur;
    for upper in (level + 1)..TREE_DEPTH {
        let bit = (idx >> upper) & 1;
        walking = if bit == 0 {
            poseidon_mk_node(&walking, &tree.zero_cache[upper])?
        } else {
            poseidon_mk_node(&tree.frontier[upper], &walking)?
        };
    }

    tree.leaf_count = tree.leaf_count.saturating_add(1);
    tree.ring_head = ((tree.ring_head as usize + 1) % ROOT_HISTORY_SIZE) as u8;
    tree.root_ring[tree.ring_head as usize] = walking;
    Ok(walking)
}

pub fn tree_has_recent_root(tree: &TreeState, root: &[u8; 32]) -> bool {
    tree.root_ring.iter().any(|r| r == root)
}

/// Insert a nullifier into a sorted zero-copy shard. Errors on duplicate or
/// overflow. Storage is a flat `[u8; N]` backing for bytemuck compatibility;
/// logical view is a sorted array of 32-byte nullifiers.
pub fn nullifier_insert(shard: &mut NullifierShard, nullifier: [u8; 32]) -> Result<()> {
    let count = shard.count as usize;
    require!(
        count < crate::state::MAX_NULLIFIERS_PER_SHARD,
        PoolError::AccountSizeMismatch
    );

    // Binary search on the populated prefix via the helper view.
    let pos = match shard.nullifiers().binary_search(&nullifier) {
        Ok(_) => return err!(PoolError::NullifierAlreadySpent),
        Err(pos) => pos,
    };

    // Shift entries [pos..count] right by one to make room, then write.
    for i in (pos..count).rev() {
        let v = shard.nullifier_at(i);
        shard.set_nullifier(i + 1, v);
    }
    shard.set_nullifier(pos, nullifier);
    shard.count = shard.count.saturating_add(1);
    Ok(())
}

pub fn shard_prefix(nullifier: &[u8; 32]) -> u16 {
    u16::from_le_bytes([nullifier[30], nullifier[31]])
}

/// BN254 scalar field modulus, little-endian.
const FR_MODULUS_LE: [u8; 32] = [
    0x01, 0x00, 0x00, 0xf0, 0x93, 0xf5, 0xe1, 0x43,
    0x91, 0x70, 0xb9, 0x79, 0x48, 0xe8, 0x33, 0x28,
    0x5d, 0x58, 0x81, 0x81, 0xb6, 0x45, 0x50, 0xb8,
    0x29, 0xa0, 0x31, 0xe1, 0x72, 0x4e, 0x64, 0x30,
];

/// Reduce 32 LE bytes mod p. Used to convert raw Pubkey bytes (which may
/// exceed p in the top ~2 bits) into a canonical Fr representation. The
/// circuit's `publicTokenMint` is an Fr; the on-chain program must send
/// the same Fr-reduced bytes to the verifier or the proof rejects.
pub fn reduce_le_mod_p(b: &[u8; 32]) -> [u8; 32] {
    // Walk: while out ≥ p, subtract. p ≈ 2^253.99, so a 32-byte value
    // (up to ~2^256) needs at most 4 subtractions.
    let mut out = *b;
    while !cmp_le_lt(&out, &FR_MODULUS_LE) {
        sub_le_in_place(&mut out, &FR_MODULUS_LE);
    }
    out
}

/// Compare two 32-byte little-endian values for `a < b`. Walk from the
/// most-significant byte (LE index 31) downward.
fn cmp_le_lt(a: &[u8; 32], b: &[u8; 32]) -> bool {
    for i in (0..32).rev() {
        if a[i] < b[i] { return true; }
        if a[i] > b[i] { return false; }
    }
    false
}

/// In-place subtraction `a -= b` over 32-byte little-endian bigints.
/// Assumes a ≥ b (no underflow).
fn sub_le_in_place(a: &mut [u8; 32], b: &[u8; 32]) {
    let mut borrow: i16 = 0;
    for i in 0..32 {
        let diff: i16 = (a[i] as i16) - (b[i] as i16) - borrow;
        if diff < 0 {
            a[i] = (diff + 256) as u8;
            borrow = 1;
        } else {
            a[i] = diff as u8;
            borrow = 0;
        }
    }
}

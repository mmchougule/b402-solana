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

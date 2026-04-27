//! Incremental Merkle Tree, depth 26, Poseidon-hashed, append-only.
//! Specified in PRD-02 §5.

use crate::poseidon;
use crate::Fr;

pub const TREE_DEPTH: usize = 26;

/// Precomputed zero subtree values, level 0..TREE_DEPTH inclusive.
/// `zero_cache[0]` = leaf-level empty.
/// `zero_cache[d+1]` = Poseidon(merkle-node-tag, zero_cache[d], zero_cache[d])
pub fn compute_zero_cache() -> [Fr; TREE_DEPTH + 1] {
    let mut cache = [Fr::ZERO; TREE_DEPTH + 1];
    cache[0] = poseidon::merkle_zero_seed().expect("zero seed");
    for d in 0..TREE_DEPTH {
        cache[d + 1] = poseidon::merkle_node(cache[d], cache[d]).expect("zero compute");
    }
    cache
}

/// In-memory incremental merkle tree. The on-chain pool state stores only
/// root_ring + frontier + leaf_count (see PRD-03 §3.4); this struct includes
/// the frontier and tracks what's needed for proof generation, so the SDK
/// uses it with leaf data replayed from chain logs.
#[derive(Clone, Debug)]
pub struct MerkleTree {
    pub leaf_count: u64,
    pub frontier: [Fr; TREE_DEPTH],
    pub zero_cache: [Fr; TREE_DEPTH + 1],
    pub root: Fr,
    /// For proof generation, a client mode keeps the full leaf array. On-chain
    /// program obviously does not; constructed with `on_chain_mode = true` to
    /// elide leaves.
    pub leaves: Option<Vec<Fr>>,
}

#[derive(Clone, Debug)]
pub struct MerkleProof {
    pub leaf: Fr,
    pub leaf_index: u64,
    pub siblings: [Fr; TREE_DEPTH],
    pub path_bits: [bool; TREE_DEPTH],
    pub root: Fr,
}

impl MerkleTree {
    pub fn new_client() -> Self {
        let zc = compute_zero_cache();
        Self {
            leaf_count: 0,
            frontier: [Fr::ZERO; TREE_DEPTH],
            zero_cache: zc,
            root: zc[TREE_DEPTH],
            leaves: Some(Vec::new()),
        }
    }

    pub fn new_on_chain() -> Self {
        let zc = compute_zero_cache();
        Self {
            leaf_count: 0,
            frontier: [Fr::ZERO; TREE_DEPTH],
            zero_cache: zc,
            root: zc[TREE_DEPTH],
            leaves: None,
        }
    }

    /// Append a leaf. Returns the new root and the leaf's index.
    /// Implements PRD-02 §5.4 exactly.
    pub fn append(&mut self, leaf: Fr) -> (u64, Fr) {
        let idx = self.leaf_count;
        if let Some(leaves) = self.leaves.as_mut() {
            leaves.push(leaf);
        }

        let mut cur = leaf;
        for level in 0..TREE_DEPTH {
            let bit = (idx >> level) & 1;
            if bit == 0 {
                // We're the left child. Record into frontier, combine with zero-subtree on the right.
                self.frontier[level] = cur;
                cur = poseidon::merkle_node(cur, self.zero_cache[level]).expect("poseidon");
                break_at_level(level, idx);
                // Still need to compute up to root — upper levels unchanged structurally but root recomputes.
                // Continue without breaking because frontier[level] was set; but higher-level frontiers
                // already reflect prior appends, so we must still walk up combining frontier[l] with zero.
                let mut walking = cur;
                for upper in (level + 1)..TREE_DEPTH {
                    let upper_bit = (idx >> upper) & 1;
                    walking = if upper_bit == 0 {
                        poseidon::merkle_node(walking, self.zero_cache[upper]).expect("poseidon")
                    } else {
                        poseidon::merkle_node(self.frontier[upper], walking).expect("poseidon")
                    };
                }
                self.root = walking;
                self.leaf_count += 1;
                return (idx, self.root);
            } else {
                // We're a right child at this level. Combine left=frontier, right=cur, walk up.
                cur = poseidon::merkle_node(self.frontier[level], cur).expect("poseidon");
            }
        }
        // Tree full (idx == 2^26). Should never happen in practice; panic for safety.
        panic!("merkle tree capacity exceeded");
    }

    /// Generate a proof for a leaf at `index`. Requires client mode (leaves stored).
    pub fn prove(&self, index: u64) -> Option<MerkleProof> {
        let leaves = self.leaves.as_ref()?;
        if index >= self.leaf_count {
            return None;
        }
        let leaf = leaves[index as usize];

        // Build level-by-level.
        let mut level_nodes: Vec<Fr> = leaves.clone();
        let mut path_bits = [false; TREE_DEPTH];
        let mut siblings = [Fr::ZERO; TREE_DEPTH];
        let mut idx = index;

        for level in 0..TREE_DEPTH {
            let is_right = (idx & 1) == 1;
            path_bits[level] = is_right;

            let sibling_idx = if is_right { idx - 1 } else { idx + 1 };
            siblings[level] = if (sibling_idx as usize) < level_nodes.len() {
                level_nodes[sibling_idx as usize]
            } else {
                self.zero_cache[level]
            };

            // Compute next level by pairing.
            let mut next = Vec::with_capacity((level_nodes.len() + 1) / 2);
            for i in (0..level_nodes.len()).step_by(2) {
                let l = level_nodes[i];
                let r = if i + 1 < level_nodes.len() {
                    level_nodes[i + 1]
                } else {
                    self.zero_cache[level]
                };
                next.push(poseidon::merkle_node(l, r).expect("poseidon"));
            }
            level_nodes = next;
            idx >>= 1;
        }

        Some(MerkleProof {
            leaf,
            leaf_index: index,
            siblings,
            path_bits,
            root: level_nodes
                .first()
                .copied()
                .unwrap_or(self.zero_cache[TREE_DEPTH]),
        })
    }
}

impl MerkleProof {
    pub fn verify(&self) -> bool {
        let mut cur = self.leaf;
        for level in 0..TREE_DEPTH {
            cur = if self.path_bits[level] {
                poseidon::merkle_node(self.siblings[level], cur).expect("poseidon")
            } else {
                poseidon::merkle_node(cur, self.siblings[level]).expect("poseidon")
            };
        }
        cur == self.root
    }
}

// Helper to silence a clippy warning; keeps the function signature above readable.
#[inline(always)]
fn break_at_level(_level: usize, _idx: u64) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_tree_root_stable() {
        let t = MerkleTree::new_client();
        let zc = compute_zero_cache();
        assert_eq!(t.root, zc[TREE_DEPTH]);
    }

    #[test]
    fn append_one_produces_consistent_root() {
        let mut t = MerkleTree::new_client();
        let (idx, root_after) = t.append(Fr::from_u64(0x1234));
        assert_eq!(idx, 0);
        assert_eq!(t.leaf_count, 1);
        assert_ne!(root_after, compute_zero_cache()[TREE_DEPTH]);
    }

    #[test]
    fn proof_roundtrip_single_leaf() {
        let mut t = MerkleTree::new_client();
        t.append(Fr::from_u64(42));
        let p = t.prove(0).unwrap();
        assert!(p.verify());
        assert_eq!(p.root, t.root);
    }

    #[test]
    fn proof_roundtrip_many_leaves() {
        let mut t = MerkleTree::new_client();
        for i in 0..17u64 {
            t.append(Fr::from_u64(i));
        }
        for i in 0..17u64 {
            let p = t.prove(i).unwrap();
            assert!(p.verify(), "proof at index {} failed", i);
            assert_eq!(p.root, t.root);
        }
    }

    #[test]
    fn tampered_proof_rejected() {
        let mut t = MerkleTree::new_client();
        t.append(Fr::from_u64(42));
        t.append(Fr::from_u64(43));
        let mut p = t.prove(1).unwrap();
        p.siblings[0] = Fr::from_u64(999);
        assert!(!p.verify());
    }
}

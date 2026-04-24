/**
 * Client-side incremental Merkle tree. Mirrors Rust `MerkleTree` and matches
 * on-chain `tree_append` bit-for-bit. Parity tests in `tests/parity/` verify.
 */

import { TREE_DEPTH } from '@b402ai/solana-shared';
import { merkleNodeHash, merkleZeroSeed } from './poseidon.js';

/**
 * Compute the depth-26 zero subtree cache. Index `i` is the hash of the
 * empty subtree of height `i`. `zeroCache[0]` = leaf-level zero;
 * `zeroCache[TREE_DEPTH]` = empty-tree root.
 */
export async function buildZeroCache(depth = TREE_DEPTH): Promise<bigint[]> {
  const cache: bigint[] = [await merkleZeroSeed()];
  for (let i = 0; i < depth; i++) {
    cache.push(await merkleNodeHash(cache[i], cache[i]));
  }
  return cache;
}

/** Convert a 32-byte LE buffer to bigint. */
function leToBig(b: Uint8Array): bigint {
  let v = 0n;
  for (let i = b.length - 1; i >= 0; i--) v = (v << 8n) | BigInt(b[i]);
  return v;
}

/**
 * Derive the merkle proof for the **most recently appended** leaf using the
 * on-chain frontier + zero cache — no scan needed.
 *
 * Valid only if the proof is for leaf_index = leafCount - 1. For older leaves
 * we need full history (use Scanner).
 *
 * Path rule for the most-recent leaf at idx = N:
 *   At level L, bit L of N:
 *     = 0 → our subtree is a left child; right sibling = zero_cache[L]
 *     = 1 → our subtree is a right child; left sibling = frontier[L]
 *           (frontier[L] was set by some earlier append; our append didn't
 *            touch levels below `lowest_zero_bit(N)` so frontier[L] is still
 *            the "left sibling" along our path)
 */
export function proveMostRecentLeaf(
  leaf: bigint,
  leafIndex: bigint,
  root: bigint,
  frontierLe: Uint8Array[],
  zeroCacheLe: Uint8Array[],
  depth = TREE_DEPTH,
): MerkleProof {
  if (leafIndex < 0n) throw new Error('leafIndex must be ≥ 0');
  if (frontierLe.length !== depth) throw new Error(`frontier length ${frontierLe.length} != ${depth}`);
  if (zeroCacheLe.length < depth) throw new Error('zero cache too short');

  const siblings: bigint[] = [];
  const pathBits: number[] = [];
  for (let lvl = 0; lvl < depth; lvl++) {
    const bit = Number((leafIndex >> BigInt(lvl)) & 1n);
    pathBits.push(bit);
    siblings.push(bit === 1 ? leToBig(frontierLe[lvl]) : leToBig(zeroCacheLe[lvl]));
  }
  return { leaf, leafIndex, siblings, pathBits, root };
}

export interface MerkleProof {
  leaf: bigint;
  leafIndex: bigint;
  siblings: bigint[];
  pathBits: number[];
  root: bigint;
}

export class ClientMerkleTree {
  leafCount = 0n;
  frontier: bigint[];
  zeroCache: bigint[] = [];
  root = 0n;
  leaves: bigint[] = [];
  readonly depth: number;
  private _initialized = false;

  constructor(depth = TREE_DEPTH) {
    this.depth = depth;
    this.frontier = new Array(depth).fill(0n);
  }

  async init(): Promise<void> {
    if (this._initialized) return;
    this.zeroCache.push(await merkleZeroSeed());
    for (let i = 0; i < this.depth; i++) {
      this.zeroCache.push(await merkleNodeHash(this.zeroCache[i], this.zeroCache[i]));
    }
    this.root = this.zeroCache[this.depth];
    this._initialized = true;
  }

  async append(leaf: bigint): Promise<{ index: bigint; root: bigint }> {
    if (!this._initialized) throw new Error('tree not initialized');
    const index = this.leafCount;
    this.leaves.push(leaf);

    let cur = leaf;
    let level = 0;
    while (((index >> BigInt(level)) & 1n) === 1n) {
      cur = await merkleNodeHash(this.frontier[level], cur);
      level++;
      if (level >= this.depth) throw new Error('tree capacity exceeded');
    }
    this.frontier[level] = cur;
    cur = await merkleNodeHash(cur, this.zeroCache[level]);

    let walking = cur;
    for (let u = level + 1; u < this.depth; u++) {
      const bit = (index >> BigInt(u)) & 1n;
      walking =
        bit === 0n
          ? await merkleNodeHash(walking, this.zeroCache[u])
          : await merkleNodeHash(this.frontier[u], walking);
    }
    this.root = walking;
    this.leafCount++;
    return { index, root: this.root };
  }

  async prove(index: bigint): Promise<MerkleProof> {
    if (!this._initialized) throw new Error('tree not initialized');
    if (index >= this.leafCount) throw new Error('index out of range');
    const leaf = this.leaves[Number(index)];
    const siblings: bigint[] = [];
    const pathBits: number[] = [];

    let levelNodes = [...this.leaves];
    let idx = index;
    for (let level = 0; level < this.depth; level++) {
      const isRight = (idx & 1n) === 1n;
      pathBits.push(isRight ? 1 : 0);
      const sibIdx = isRight ? idx - 1n : idx + 1n;
      const sib = sibIdx < BigInt(levelNodes.length) ? levelNodes[Number(sibIdx)] : this.zeroCache[level];
      siblings.push(sib);

      const next: bigint[] = [];
      for (let i = 0; i < levelNodes.length; i += 2) {
        const l = levelNodes[i];
        const r = i + 1 < levelNodes.length ? levelNodes[i + 1] : this.zeroCache[level];
        next.push(await merkleNodeHash(l, r));
      }
      levelNodes = next;
      idx = idx >> 1n;
    }

    return {
      leaf,
      leafIndex: index,
      siblings,
      pathBits,
      root: levelNodes[0] ?? this.zeroCache[this.depth],
    };
  }
}

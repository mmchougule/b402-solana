/**
 * Test helpers — parity computations, test-vector generation, circom_tester wrapper.
 *
 * Every circom circuit under `circuits/lib/` has a corresponding spec function
 * here. Tests assert that (a) the circom circuit produces a witness matching
 * the spec, and (b) the spec matches the Rust `b402-crypto` crate (parity
 * tests live in `tests/parity/`).
 */

// @ts-expect-error - no types for circomlibjs
import { buildPoseidon } from 'circomlibjs';
// @ts-expect-error - no types for circom_tester
import { wasm as wasmTester } from 'circom_tester';
import path from 'node:path';

type Fr = bigint;

// BN254 scalar field modulus
export const P: Fr = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

let _poseidon: any | null = null;
export async function getPoseidon() {
  if (!_poseidon) _poseidon = await buildPoseidon();
  return _poseidon;
}

export const DomainTags = {
  commit:         'b402/v1/commit',
  nullifier:      'b402/v1/null',
  mkNode:         'b402/v1/mk-node',
  mkZero:         'b402/v1/mk-zero',
  spendKeyPub:    'b402/v1/spend-key-pub',
  feeBind:        'b402/v1/fee-bind',
  rootBind:       'b402/v1/root-bind',
  adaptBind:      'b402/v1/adapt-bind',
  recipientBind:  'b402/v1/recipient-bind',
} as const;

/** Encode an ASCII string ≤ 31 bytes as an Fr via BE interpretation, reduced mod p. */
export function tagToFr(tag: string): Fr {
  if (tag.length > 31) throw new Error(`tag too long: ${tag.length}`);
  let acc = 0n;
  for (let i = 0; i < tag.length; i++) {
    acc = (acc << 8n) | BigInt(tag.charCodeAt(i));
  }
  return acc % P;
}

/** Hash k Fr inputs with Poseidon_{k+1}. */
export async function poseidon(...inputs: Fr[]): Promise<Fr> {
  const p = await getPoseidon();
  const h = p(inputs.map(x => p.F.e(x.toString())));
  return BigInt(p.F.toString(h));
}

/** Domain-tagged poseidon: prepend tag as first input. */
export async function poseidonTagged(tag: keyof typeof DomainTags, ...inputs: Fr[]): Promise<Fr> {
  return poseidon(tagToFr(DomainTags[tag]), ...inputs);
}

export async function commitment(
  tokenMint: Fr,
  value: bigint,
  random: Fr,
  spendingPub: Fr,
): Promise<Fr> {
  return poseidonTagged('commit', tokenMint, value, random, spendingPub);
}

export async function nullifier(spendingPriv: Fr, leafIndex: bigint): Promise<Fr> {
  return poseidonTagged('nullifier', spendingPriv, leafIndex);
}

export async function spendingPub(spendingPriv: Fr): Promise<Fr> {
  return poseidonTagged('spendKeyPub', spendingPriv);
}

export async function merkleNode(left: Fr, right: Fr): Promise<Fr> {
  return poseidonTagged('mkNode', left, right);
}

export async function merkleZeroSeed(): Promise<Fr> {
  return poseidonTagged('mkZero');
}

/** Load a compiled circom circuit for witness-level testing. */
export async function loadCircuit(circomRelativePath: string) {
  const abs = path.resolve(__dirname, '..', circomRelativePath);
  return await wasmTester(abs, {
    include: [path.resolve(__dirname, '..', 'node_modules')],
  });
}

/** Build the depth-26 zero cache. */
export async function computeZeroCache(depth = 26): Promise<Fr[]> {
  const cache: Fr[] = [await merkleZeroSeed()];
  for (let i = 0; i < depth; i++) {
    cache.push(await merkleNode(cache[i], cache[i]));
  }
  return cache;
}

/** Simple client-side Merkle tree mirroring packages/crypto merkle.rs. */
export class ClientMerkleTree {
  leafCount = 0n;
  frontier: Fr[];
  zeroCache: Fr[] = [];
  root: Fr = 0n;
  leaves: Fr[] = [];
  depth: number;

  constructor(depth = 26) {
    this.depth = depth;
    this.frontier = Array(depth).fill(0n);
  }

  async init() {
    this.zeroCache = await computeZeroCache(this.depth);
    this.root = this.zeroCache[this.depth];
  }

  async append(leaf: Fr): Promise<{ index: bigint; root: Fr }> {
    const index = this.leafCount;
    this.leaves.push(leaf);

    // Find the lowest-zero bit of index — that's where we break.
    let cur = leaf;
    let level = 0;
    while ((index >> BigInt(level)) & 1n) {
      cur = await merkleNode(this.frontier[level], cur);
      level++;
    }
    this.frontier[level] = cur;

    // Now compute root by walking up, combining frontier or zero as appropriate.
    let walking = cur;
    let upper = level + 1;
    // First step above `level`: our `cur` pairs with zero on the right.
    if (upper <= this.depth) {
      walking = await merkleNode(walking, this.zeroCache[level]);
    }
    for (let u = upper; u < this.depth; u++) {
      const bit = (index >> BigInt(u)) & 1n;
      walking = bit === 0n
        ? await merkleNode(walking, this.zeroCache[u])
        : await merkleNode(this.frontier[u], walking);
    }

    this.root = walking;
    this.leafCount++;
    return { index, root: this.root };
  }

  async prove(index: bigint): Promise<{ leaf: Fr; siblings: Fr[]; pathBits: number[]; root: Fr }> {
    if (index >= this.leafCount) throw new Error('index out of range');
    const leaf = this.leaves[Number(index)];
    const siblings: Fr[] = [];
    const pathBits: number[] = [];

    let levelNodes: Fr[] = [...this.leaves];
    let idx = index;

    for (let level = 0; level < this.depth; level++) {
      const isRight = (idx & 1n) === 1n;
      pathBits.push(isRight ? 1 : 0);
      const sibIdx = isRight ? idx - 1n : idx + 1n;
      const sib = sibIdx < BigInt(levelNodes.length)
        ? levelNodes[Number(sibIdx)]
        : this.zeroCache[level];
      siblings.push(sib);

      const next: Fr[] = [];
      for (let i = 0; i < levelNodes.length; i += 2) {
        const l = levelNodes[i];
        const r = i + 1 < levelNodes.length ? levelNodes[i + 1] : this.zeroCache[level];
        next.push(await merkleNode(l, r));
      }
      levelNodes = next;
      idx = idx >> 1n;
    }

    return { leaf, siblings, pathBits, root: levelNodes[0] ?? this.zeroCache[this.depth] };
  }
}

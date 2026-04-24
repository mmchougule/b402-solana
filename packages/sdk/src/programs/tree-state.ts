/**
 * Decode the on-chain `TreeState` zero-copy account.
 *
 * Layout (from `programs/b402-pool/src/state.rs::TreeState`):
 *   [0..8]    Anchor discriminator (8B)
 *   [8..10]   version (u16)
 *   [10..16]  pad0
 *   [16..24]  leaf_count (u64 LE)
 *   [24..25]  ring_head (u8)
 *   [25..32]  pad1
 *   [32..32+64*32]   root_ring (64 × 32B)
 *   [...] frontier (26 × 32B)
 *   [...] zero_cache (26 × 32B)
 *   [...] _reserved (64B)
 *
 * ROOT_HISTORY_SIZE = 128 per the post-review hardening.
 */

import { Connection, PublicKey } from '@solana/web3.js';

const HEADER_OFFSET = 8;        // Anchor discriminator
const ROOT_RING_SIZE = 128;     // matches ROOT_HISTORY_SIZE in constants.rs
const TREE_DEPTH = 26;

export interface TreeStateView {
  version: number;
  leafCount: bigint;
  ringHead: number;
  /** All roots in the ring buffer, oldest to newest by index (NOT by recency). */
  rootRing: Uint8Array[];
  frontier: Uint8Array[];
  zeroCache: Uint8Array[];
  /** The most recent root according to ringHead. */
  currentRoot: Uint8Array;
}

export function decodeTreeState(data: Uint8Array): TreeStateView {
  if (data.length < HEADER_OFFSET) throw new Error('account too small');
  let off = HEADER_OFFSET;

  const version = data[off] | (data[off + 1] << 8);
  off += 2 + 6; // u16 + pad0

  const leafCount = readU64Le(data, off);
  off += 8;

  const ringHead = data[off];
  off += 1 + 7; // u8 + pad1

  const rootRing: Uint8Array[] = [];
  for (let i = 0; i < ROOT_RING_SIZE; i++) {
    rootRing.push(data.slice(off, off + 32));
    off += 32;
  }

  const frontier: Uint8Array[] = [];
  for (let i = 0; i < TREE_DEPTH; i++) {
    frontier.push(data.slice(off, off + 32));
    off += 32;
  }

  const zeroCache: Uint8Array[] = [];
  for (let i = 0; i < TREE_DEPTH; i++) {
    zeroCache.push(data.slice(off, off + 32));
    off += 32;
  }

  return {
    version,
    leafCount,
    ringHead,
    rootRing,
    frontier,
    zeroCache,
    currentRoot: rootRing[ringHead],
  };
}

export async function fetchTreeState(connection: Connection, pda: PublicKey): Promise<TreeStateView> {
  const acct = await connection.getAccountInfo(pda);
  if (!acct) throw new Error(`tree state account not found at ${pda.toBase58()}`);
  return decodeTreeState(acct.data);
}

function readU64Le(buf: Uint8Array, off: number): bigint {
  let v = 0n;
  for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(buf[off + i]);
  return v;
}

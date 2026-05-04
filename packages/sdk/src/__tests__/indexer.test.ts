/**
 * Unit tests for B402Indexer + SDK fallback wiring. The indexer is a
 * convenience oracle, not a trust root, so the verifyOnChainRoot guard
 * needs to actually catch the cases where the indexer returns a root
 * that doesn't match the on-chain TreeState. These tests don't exercise
 * the full e2e (that lives in tests/v2/e2e/); they pin the contract.
 */

import { describe, it, expect } from 'vitest';
import { Connection, PublicKey } from '@solana/web3.js';
import { B402Indexer } from '../indexer.js';

const POOL_ID = new PublicKey('42a3hsCXtQLWonyxWZosaaCJCweYYKMrvNd25p1Jrt2y');

// Minimal Connection-shaped stub. We only need getAccountInfo for the
// on-chain root check + nothing else.
function stubConn(treeAcc: { data: Uint8Array } | null): Connection {
  return {
    getAccountInfo: async () => treeAcc,
  } as unknown as Connection;
}

// Build a fake TreeState account with a given currentRoot byte sequence.
// Layout from packages/sdk/src/programs/tree-state.ts:
//   [0..8]   discriminator (any 8 bytes)
//   [8..10]  version (u16)
//   [10..16] pad
//   [16..24] leaf_count (u64 LE)
//   [24..25] ring_head (u8)
//   [25..32] pad
//   [32..32+128*32]  root_ring (128 × 32B)
//   ...
// The decoder picks the root at ring index `ring_head - 1` as currentRoot.
// For the test we put the root at ring_head=1 so the slot we write is
// position 0 (since currentRoot = rootRing[(head-1+128) % 128]).
function makeTreeAccount(currentRootHex: string): { data: Uint8Array } {
  const buf = new Uint8Array(32 + 128 * 32 + 26 * 32 + 26 * 32 + 64);
  // disc bytes 0..8 — irrelevant
  // version = 1 at [8..10]
  buf[8] = 1;
  // leaf_count at [16..24] — say 5 leaves
  buf[16] = 5;
  // ring_head at [24] = 1
  buf[24] = 1;
  // root_ring[0] = currentRoot (32 LE bytes from hex)
  for (let i = 0; i < 32; i++) {
    buf[32 + i] = parseInt(currentRootHex.slice(i * 2, i * 2 + 2), 16);
  }
  return { data: buf };
}

// Stub global fetch with a controllable body. Vitest's fetch isolation:
// we save/restore globalThis.fetch in each test.
function withMockFetch<T>(
  responder: (url: string) => unknown,
  body: () => Promise<T>,
): Promise<T> {
  const orig = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    const data = responder(url);
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => data,
    } as Response;
  }) as typeof fetch;
  return body().finally(() => {
    globalThis.fetch = orig;
  });
}

const FAKE_ROOT_HEX =
  'd8d558274666830e18ff02a5360d186252f7612b4e61fc7001677e5762d32104';
const FAKE_LEAF_HEX =
  'dffb4d9ae3bc9a70801ce2054ffa3d840b0a1e198a26366031d887c451cbe20a';
const FAKE_SIBLINGS = Array.from({ length: 26 }, (_, i) =>
  i.toString(16).padStart(64, '0'),
);
const FAKE_PATH_BITS = Array.from({ length: 26 }, () => 0);

describe('B402Indexer', () => {
  it('proveLeaf accepts proof when indexer root matches on-chain', async () => {
    const idx = new B402Indexer({
      url: 'http://idx.example',
      connection: stubConn(makeTreeAccount(FAKE_ROOT_HEX)),
      poolProgramId: POOL_ID,
    });
    await withMockFetch(
      () => ({
        leafIndex: '3',
        leaf: FAKE_LEAF_HEX,
        siblings: FAKE_SIBLINGS,
        pathBits: FAKE_PATH_BITS,
        root: FAKE_ROOT_HEX,
      }),
      async () => {
        const proof = await idx.proveLeaf(3n);
        expect(proof.leafIndex).toBe(3n);
        expect(proof.siblings).toHaveLength(26);
        expect(proof.pathBits).toEqual(FAKE_PATH_BITS);
        expect(typeof proof.leaf).toBe('bigint');
        expect(typeof proof.root).toBe('bigint');
      },
    );
  });

  it('proveLeaf REJECTS proof when indexer-claimed root is unknown to TreeState', async () => {
    const idx = new B402Indexer({
      url: 'http://idx.example',
      connection: stubConn(makeTreeAccount(FAKE_ROOT_HEX)),
      poolProgramId: POOL_ID,
    });
    const tamperedRoot = 'a'.repeat(64); // not in the ring
    await withMockFetch(
      () => ({
        leafIndex: '3',
        leaf: FAKE_LEAF_HEX,
        siblings: FAKE_SIBLINGS,
        pathBits: FAKE_PATH_BITS,
        root: tamperedRoot,
      }),
      async () => {
        await expect(idx.proveLeaf(3n)).rejects.toThrow(
          /not found in on-chain TreeState/,
        );
      },
    );
  });

  it('proveLeaf rejects when indexer returns wrong leafIndex', async () => {
    const idx = new B402Indexer({
      url: 'http://idx.example',
      connection: stubConn(makeTreeAccount(FAKE_ROOT_HEX)),
      poolProgramId: POOL_ID,
    });
    await withMockFetch(
      () => ({
        leafIndex: '7', // we asked for 3
        leaf: FAKE_LEAF_HEX,
        siblings: FAKE_SIBLINGS,
        pathBits: FAKE_PATH_BITS,
        root: FAKE_ROOT_HEX,
      }),
      async () => {
        await expect(idx.proveLeaf(3n)).rejects.toThrow(
          /returned leafIndex 7 for request 3/,
        );
      },
    );
  });

  it('isSpent returns the spent flag from the response', async () => {
    const idx = new B402Indexer({
      url: 'http://idx.example',
      connection: stubConn(null),
      poolProgramId: POOL_ID,
      verifyOnChainRoot: false,
    });
    await withMockFetch(
      () => ({ nullifier: '00'.repeat(32), spent: true, slot: 100, signature: 'abc' }),
      async () => {
        expect(await idx.isSpent(0n)).toBe(true);
      },
    );
  });

  it('verifyOnChainRoot=false skips the on-chain check', async () => {
    // Use a stub connection that would error if called — proves we skipped.
    const conn = {
      getAccountInfo: async () => {
        throw new Error('connection should not be called when verifyOnChainRoot=false');
      },
    } as unknown as Connection;
    const idx = new B402Indexer({
      url: 'http://idx.example',
      connection: conn,
      poolProgramId: POOL_ID,
      verifyOnChainRoot: false,
    });
    await withMockFetch(
      () => ({
        leafIndex: '0',
        leaf: FAKE_LEAF_HEX,
        siblings: FAKE_SIBLINGS,
        pathBits: FAKE_PATH_BITS,
        root: 'a'.repeat(64), // would fail the on-chain check if it ran
      }),
      async () => {
        const proof = await idx.proveLeaf(0n);
        expect(proof.leafIndex).toBe(0n);
      },
    );
  });
});

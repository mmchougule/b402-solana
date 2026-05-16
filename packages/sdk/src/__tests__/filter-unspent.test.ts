/**
 * Unit tests for B402Solana._filterUnspent — the spent-set cross-check
 * that holdings() / balance() / status() run before returning notes.
 *
 * Probe path: Light Protocol's batch ADDRESS tree (not state tree), via
 * Photon's `getMultipleNewAddressProofs`. Returns proofs for unspent
 * addresses; THROWS with "already exists" for addresses already in the
 * tree. This is the same primitive `getValidityProofForNullifier` uses
 * at swap time, so picker decisions stay consistent with the relayer.
 *
 * `getCompressedAccount` (state tree) is the wrong primitive here —
 * nullifier insertions go to the address tree as uniqueness markers,
 * not the state tree as account data. This test exists in part to lock
 * that distinction in place.
 */

import { describe, it, expect, vi } from 'vitest';
import { Keypair } from '@solana/web3.js';
import type { SpendableNote } from '@b402ai/solana-shared';
import { B402Solana } from '../b402.js';

function mkNote(commitment: bigint, leafIndex: bigint, value: bigint): SpendableNote {
  return {
    tokenMint: 100n,
    value,
    random: 0n,
    spendingPub: 0n,
    commitment,
    leafIndex,
    spendingPriv: 0n,
    encryptedBytes: new Uint8Array(89),
    ephemeralPub: new Uint8Array(32),
    viewingTag: new Uint8Array(2),
  };
}

function buildSdkWithPhotonMock(spentByCallIdx: Set<number>) {
  const sdk = new B402Solana({ cluster: 'devnet', keypair: Keypair.generate() });
  // @ts-expect-error private
  sdk._wallet = { spendingPriv: 1n };
  const markSpent = vi.fn();
  // @ts-expect-error private
  sdk._notes = { markSpent };
  const callIdx = { v: 0 };
  // @ts-expect-error inject
  sdk._photonRpc = {
    getMultipleNewAddressProofs: vi.fn(async () => {
      const idx = callIdx.v++;
      if (spentByCallIdx.has(idx)) {
        throw new Error('Validation Error: Address abc... already exists');
      }
      return [{ root: new Uint8Array(32), nextIndex: 0, lowAddress: new Uint8Array(32) }];
    }),
  };
  return { sdk, markSpent };
}

describe('B402Solana._filterUnspent (address-tree probe)', () => {
  it('drops notes whose nullifier address Photon says is already in the tree', async () => {
    const { sdk, markSpent } = buildSdkWithPhotonMock(new Set([0])); // first call → "already exists"
    const notes = [
      mkNote(101n, 10n, 50n),
      mkNote(102n, 11n, 75n),
      mkNote(103n, 12n, 25n),
    ];
    // @ts-expect-error
    const out: SpendableNote[] = await sdk._filterUnspent(notes);
    expect(out.map((n) => n.commitment).sort()).toEqual([102n, 103n]);
    expect(markSpent).toHaveBeenCalledWith(101n);
    expect(markSpent).toHaveBeenCalledTimes(1);
  });

  it('keeps all notes when the probe returns proofs (none spent)', async () => {
    const { sdk } = buildSdkWithPhotonMock(new Set());
    const notes = [mkNote(101n, 10n, 50n), mkNote(102n, 11n, 75n)];
    // @ts-expect-error
    const out = await sdk._filterUnspent(notes);
    expect(out.length).toBe(2);
  });

  it('returns all notes when wallet is not initialised', async () => {
    const sdk = new B402Solana({ cluster: 'devnet', keypair: Keypair.generate() });
    const notes = [mkNote(101n, 10n, 50n)];
    // @ts-expect-error
    const out = await sdk._filterUnspent(notes);
    expect(out).toEqual(notes);
  });

  it('caches per-leafIndex so repeated calls do not re-probe Photon', async () => {
    const { sdk } = buildSdkWithPhotonMock(new Set());
    const notes = [mkNote(101n, 10n, 50n), mkNote(102n, 11n, 75n)];
    // @ts-expect-error
    await sdk._filterUnspent(notes);
    // @ts-expect-error
    await sdk._filterUnspent(notes);
    // @ts-expect-error inject
    expect(sdk._photonRpc.getMultipleNewAddressProofs).toHaveBeenCalledTimes(2);
  });

  it('keeps the note on transient Photon errors (NOT "already exists")', async () => {
    const sdk = new B402Solana({ cluster: 'devnet', keypair: Keypair.generate() });
    // @ts-expect-error
    sdk._wallet = { spendingPriv: 1n };
    // @ts-expect-error
    sdk._notes = { markSpent: vi.fn() };
    // @ts-expect-error
    sdk._photonRpc = {
      getMultipleNewAddressProofs: vi.fn(async () => { throw new Error('Helius 503: Service Unavailable'); }),
    };
    const notes = [mkNote(101n, 10n, 50n)];
    // @ts-expect-error
    const out = await sdk._filterUnspent(notes);
    expect(out).toEqual(notes);
  });

  it('marks note spent ONLY on "already exists" error, not other errors', async () => {
    const { sdk, markSpent } = buildSdkWithPhotonMock(new Set([0]));
    const notes = [mkNote(101n, 10n, 50n)];
    // @ts-expect-error
    await sdk._filterUnspent(notes);
    expect(markSpent).toHaveBeenCalledTimes(1);
    expect(markSpent).toHaveBeenCalledWith(101n);
  });
});

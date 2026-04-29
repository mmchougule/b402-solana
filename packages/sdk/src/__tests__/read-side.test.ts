/**
 * Unit tests for the NoteStore primitives that back balance / holdings.
 *
 * Drives the NoteStore directly with synthetic SpendableNote inserts to
 * keep the test self-contained — no Solana RPC, no real proofs. Covers:
 *
 *   - getAllSpendable returns every unspent note across mints
 *   - getAllSpendable excludes notes whose commitment is in spentNullifiers
 *   - getSpendable still filters by mint (regression guard)
 */

import { describe, it, expect } from 'vitest';
import type { Connection, PublicKey } from '@solana/web3.js';
import { NoteStore } from '../note-store.js';
import type { Wallet } from '../wallet.js';
import type { SpendableNote } from '@b402ai/solana-shared';

function note(commitment: bigint, mint: bigint, value: bigint): SpendableNote {
  return {
    tokenMint: mint,
    value,
    random: 0n,
    spendingPub: 0n,
    commitment,
    leafIndex: commitment,
    spendingPriv: 0n,
    encryptedBytes: new Uint8Array(89),
    ephemeralPub: new Uint8Array(32),
    viewingTag: new Uint8Array(2),
  };
}

function buildStore(): NoteStore {
  const fakeConn = {} as Connection;
  const fakePk = {} as PublicKey;
  const fakeWallet = {} as Wallet;
  return new NoteStore({ connection: fakeConn, poolProgramId: fakePk, wallet: fakeWallet });
}

describe('NoteStore read-side', () => {
  it('getAllSpendable returns every unspent note across mints', () => {
    const store = buildStore();
    // @ts-expect-error reach into private map for test seeding
    store.notesByCommitment.set('1', note(1n, 100n, 50n));
    // @ts-expect-error
    store.notesByCommitment.set('2', note(2n, 200n, 75n));
    // @ts-expect-error
    store.notesByCommitment.set('3', note(3n, 100n, 25n));

    const all = store.getAllSpendable();
    expect(all).toHaveLength(3);
    expect(all.map((n) => n.value).sort()).toEqual([25n, 50n, 75n]);
  });

  it('getAllSpendable excludes notes whose commitment is marked spent', () => {
    const store = buildStore();
    // @ts-expect-error
    store.notesByCommitment.set('1', note(1n, 100n, 50n));
    // @ts-expect-error
    store.notesByCommitment.set('2', note(2n, 100n, 75n));
    // @ts-expect-error treat commitment as the nullifier-key for this test
    store.spentNullifiers.add('1');

    const all = store.getAllSpendable();
    expect(all).toHaveLength(1);
    expect(all[0].value).toBe(75n);
  });

  it('getSpendable still filters by mint', () => {
    const store = buildStore();
    // @ts-expect-error
    store.notesByCommitment.set('1', note(1n, 100n, 50n));
    // @ts-expect-error
    store.notesByCommitment.set('2', note(2n, 200n, 75n));

    expect(store.getSpendable(100n)).toHaveLength(1);
    expect(store.getSpendable(200n)).toHaveLength(1);
    expect(store.getSpendable(999n)).toHaveLength(0);
  });

  it('getSpendableSince returns only notes past the cursor, sorted', () => {
    const store = buildStore();
    const mkNote = (leaf: bigint, mint: bigint): SpendableNote => ({
      ...note(leaf, mint, 1n),
      leafIndex: leaf,
    });
    // @ts-expect-error
    store.notesByCommitment.set('a', mkNote(5n, 100n));
    // @ts-expect-error
    store.notesByCommitment.set('b', mkNote(2n, 100n));
    // @ts-expect-error
    store.notesByCommitment.set('c', mkNote(8n, 200n));
    // @ts-expect-error
    store.notesByCommitment.set('d', mkNote(3n, 100n));

    expect(store.getSpendableSince(3n).map((n) => n.leafIndex)).toEqual([5n, 8n]);
    expect(store.getSpendableSince(-1n).map((n) => n.leafIndex)).toEqual([2n, 3n, 5n, 8n]);
    expect(store.getSpendableSince(3n, 100n).map((n) => n.leafIndex)).toEqual([5n]);
  });

  it('getSpendableSince excludes spent notes', () => {
    const store = buildStore();
    // @ts-expect-error
    store.notesByCommitment.set('a', { ...note(5n, 100n, 1n), leafIndex: 5n });
    // @ts-expect-error
    store.notesByCommitment.set('b', { ...note(7n, 100n, 1n), leafIndex: 7n });
    // @ts-expect-error
    store.spentNullifiers.add('5');

    expect(store.getSpendableSince(-1n).map((n) => n.leafIndex)).toEqual([7n]);
  });
});

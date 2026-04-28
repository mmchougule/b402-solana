/**
 * Persistence round-trip — survive a restart.
 *
 * Drives NoteStore directly: insert a synthetic note, build a brand-new
 * NoteStore against the same dir + viewing pub, hydrate, assert the note
 * came back with bigints intact.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Connection, PublicKey } from '@solana/web3.js';
import { NoteStore } from '../note-store.js';
import type { Wallet } from '../wallet.js';
import type { SpendableNote } from '@b402ai/solana-shared';

function fakeWallet(viewingPub: Uint8Array): Wallet {
  return {
    seed: new Uint8Array(32),
    spendingPriv: 1n,
    spendingPub: 2n,
    viewingPriv: new Uint8Array(32),
    viewingPub,
  };
}

function fakeNote(commitment: bigint, mint: bigint, value: bigint): SpendableNote {
  return {
    tokenMint: mint,
    value,
    random: 1234n,
    spendingPub: 2n,
    spendingPriv: 1n,
    commitment,
    leafIndex: commitment,
    encryptedBytes: new Uint8Array([1, 2, 3, 4]),
    ephemeralPub: new Uint8Array([5, 6]),
    viewingTag: new Uint8Array([7, 8]),
  };
}

describe('NoteStore persistence', () => {
  it('round-trips notes + spent nullifiers across a fresh process', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'note-store-persist-'));
    const viewingPub = new Uint8Array(32).fill(0xab);
    const wallet = fakeWallet(viewingPub);
    const fakeConn = {} as Connection;
    const fakePk = {} as PublicKey;

    try {
      // Process 1: write
      const a = new NoteStore({
        connection: fakeConn, poolProgramId: fakePk, wallet,
        persist: { dir: tmp },
      });
      a.insertNote(fakeNote(100n, 999n, 50n));
      a.insertNote(fakeNote(200n, 999n, 75n));
      a.markSpent(100n);

      // Process 2: hydrate
      const b = new NoteStore({
        connection: fakeConn, poolProgramId: fakePk, wallet,
        persist: { dir: tmp },
      });
      // Trigger _hydrate (would normally happen in start()).
      // @ts-expect-error reach into private for test
      b._hydrate();

      const all = b.getAllSpendable();
      // commitment 100 was marked spent → only 200 remains spendable
      expect(all).toHaveLength(1);
      expect(all[0].commitment).toBe(200n);
      expect(all[0].value).toBe(75n);
      expect(all[0].random).toBe(1234n);
      expect(Array.from(all[0].encryptedBytes)).toEqual([1, 2, 3, 4]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('first run with no prior file is silent + empty', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'note-store-persist-'));
    const viewingPub = new Uint8Array(32).fill(0xcd);
    try {
      const s = new NoteStore({
        connection: {} as Connection,
        poolProgramId: {} as PublicKey,
        wallet: fakeWallet(viewingPub),
        persist: { dir: tmp },
      });
      // @ts-expect-error
      s._hydrate();
      expect(s.getAllSpendable()).toEqual([]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('persistence file is per-viewing-pub (multi-wallet coexistence)', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'note-store-persist-'));
    const aliceView = new Uint8Array(32).fill(0x01);
    const bobView = new Uint8Array(32).fill(0x02);
    try {
      const alice = new NoteStore({
        connection: {} as Connection, poolProgramId: {} as PublicKey,
        wallet: fakeWallet(aliceView), persist: { dir: tmp },
      });
      const bob = new NoteStore({
        connection: {} as Connection, poolProgramId: {} as PublicKey,
        wallet: fakeWallet(bobView), persist: { dir: tmp },
      });

      alice.insertNote(fakeNote(1n, 100n, 10n));
      bob.insertNote(fakeNote(2n, 100n, 20n));

      const files = fs.readdirSync(tmp).sort();
      expect(files).toHaveLength(2);
      // each file named after the viewing pub hex
      expect(files[0]).toMatch(/^[0-9a-f]{64}\.json$/);
      expect(files[1]).toMatch(/^[0-9a-f]{64}\.json$/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

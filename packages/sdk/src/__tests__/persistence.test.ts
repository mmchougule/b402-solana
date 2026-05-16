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

/**
 * Pluggable persistence — the `{ load, save }` shape lets consumers (bots,
 * browsers) plug their own storage. Same snapshot JSON shape as the
 * filesystem path; the SDK is storage-agnostic.
 */
describe('NoteStore persistence (pluggable adapter)', () => {
  function makeMemoryAdapter() {
    let blob: string | null = null;
    const saveCalls: string[] = [];
    return {
      load: async () => blob,
      save: async (data: string) => { blob = data; saveCalls.push(data); },
      _peek: () => blob,
      _saveCalls: () => saveCalls,
    };
  }

  it('save callback fires after insertNote and markSpent', async () => {
    const adapter = makeMemoryAdapter();
    const view = new Uint8Array(32).fill(0xaa);
    const store = new NoteStore({
      connection: {} as Connection, poolProgramId: {} as PublicKey,
      wallet: fakeWallet(view),
      persist: { load: adapter.load, save: adapter.save },
    });

    store.insertNote(fakeNote(1n, 100n, 50n));
    // _persist is fire-and-forget; flush microtasks so saves run
    await new Promise((r) => setTimeout(r, 0));
    expect(adapter._saveCalls().length).toBeGreaterThan(0);

    store.markSpent(1n);
    await new Promise((r) => setTimeout(r, 0));
    const last = JSON.parse(adapter._peek()!);
    expect(last.spentNullifiers).toContain('1');
  });

  it('load callback hydrates state on start() / _hydrate()', async () => {
    const adapter = makeMemoryAdapter();
    const view = new Uint8Array(32).fill(0xbb);

    // Process 1: write some state
    const a = new NoteStore({
      connection: {} as Connection, poolProgramId: {} as PublicKey,
      wallet: fakeWallet(view),
      persist: { load: adapter.load, save: adapter.save },
    });
    a.insertNote(fakeNote(10n, 100n, 25n));
    a.insertNote(fakeNote(20n, 100n, 30n));
    a.markSpent(10n);
    await new Promise((r) => setTimeout(r, 0));

    // Process 2: hydrate from adapter
    const b = new NoteStore({
      connection: {} as Connection, poolProgramId: {} as PublicKey,
      wallet: fakeWallet(view),
      persist: { load: adapter.load, save: adapter.save },
    });
    // @ts-expect-error
    await b._hydrate();

    const all = b.getAllSpendable();
    expect(all).toHaveLength(1);
    expect(all[0].commitment).toBe(20n);
  });

  it('load() returning null leaves the store empty (first-run case)', async () => {
    const view = new Uint8Array(32).fill(0xcc);
    const store = new NoteStore({
      connection: {} as Connection, poolProgramId: {} as PublicKey,
      wallet: fakeWallet(view),
      persist: { load: async () => null, save: async () => {} },
    });
    // @ts-expect-error
    await store._hydrate();
    expect(store.getAllSpendable()).toEqual([]);
  });

  it('save() throwing does not crash NoteStore', async () => {
    const view = new Uint8Array(32).fill(0xdd);
    let saveCalled = 0;
    const store = new NoteStore({
      connection: {} as Connection, poolProgramId: {} as PublicKey,
      wallet: fakeWallet(view),
      persist: {
        load: async () => null,
        save: async () => { saveCalled++; throw new Error('postgres down'); },
      },
    });
    expect(() => store.insertNote(fakeNote(7n, 100n, 5n))).not.toThrow();
    await new Promise((r) => setTimeout(r, 5));
    expect(saveCalled).toBeGreaterThan(0);
    // store still works in-memory
    expect(store.getAllSpendable()).toHaveLength(1);
  });

  it('serializes saves so a rapid insertNote+markSpent never clobbers the spent marker', async () => {
    // Regression test for the integration-test failure: insertNote() and
    // markSpent() both call _persist(). If save() is fire-and-forget the
    // DB callbacks can complete out of order — older snapshot wins, spent
    // marker lost. The single-flight queue must guarantee last-mutation-wins.
    const view = new Uint8Array(32).fill(0xff);
    let saveCount = 0;
    const completionDelays = [40, 5]; // first save takes longer than the second
    const stored: { raw: string | null } = { raw: null };
    const store = new NoteStore({
      connection: {} as Connection, poolProgramId: {} as PublicKey,
      wallet: fakeWallet(view),
      persist: {
        load: async () => null,
        save: async (raw: string) => {
          const idx = saveCount++;
          await new Promise((r) => setTimeout(r, completionDelays[idx] ?? 0));
          stored.raw = raw;
        },
      },
    });
    store.insertNote(fakeNote(50n, 100n, 10n));
    store.markSpent(50n); // immediately after — was racing in the old impl
    // @ts-expect-error
    await store.flushPersistence();
    const final = JSON.parse(stored.raw!);
    expect(final.spentNullifiers).toContain('50');
  });

  it('snapshot JSON is identical between filesystem and pluggable paths', async () => {
    const view = new Uint8Array(32).fill(0xee);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'note-store-persist-'));
    try {
      const fsStore = new NoteStore({
        connection: {} as Connection, poolProgramId: {} as PublicKey,
        wallet: fakeWallet(view), persist: { dir: tmp },
      });
      const adapter = makeMemoryAdapter();
      const pgStore = new NoteStore({
        connection: {} as Connection, poolProgramId: {} as PublicKey,
        wallet: fakeWallet(view),
        persist: { load: adapter.load, save: adapter.save },
      });

      for (const s of [fsStore, pgStore]) {
        s.insertNote(fakeNote(1n, 100n, 50n));
        s.insertNote(fakeNote(2n, 100n, 75n));
        s.markSpent(1n);
      }
      await new Promise((r) => setTimeout(r, 5));

      const files = fs.readdirSync(tmp);
      const fsBlob = JSON.parse(fs.readFileSync(path.join(tmp, files[0]), 'utf8'));
      const pgBlob = JSON.parse(adapter._peek()!);
      expect(pgBlob).toEqual(fsBlob);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

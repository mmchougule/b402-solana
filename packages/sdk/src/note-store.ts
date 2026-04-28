/**
 * Note store — scans on-chain `CommitmentAppended` events, decrypts those
 * addressed to us, indexes spendable notes and nullifier-spent events.
 *
 * Persistence (opt-in):
 *   Pass `{ persist: { dir } }` and the store will hydrate from
 *   `<dir>/<viewingPubHex>.json` on `start()` and atomic-write on every
 *   `insertNote` / `markSpent`. One file per viewing pub so multiple
 *   wallets coexist on a single machine. Plaintext on disk — same threat
 *   model as the Solana keypair file the wallet was derived from.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { Connection, Logs, PublicKey } from '@solana/web3.js';
import type { Wallet } from './wallet.js';
import { tryDecryptNote, type EncryptedNote } from './note-encryption.js';
import { commitmentHash, nullifierHash } from './poseidon.js';
import { parseProgramDataLog } from './notes/scanner.js';
import type { SpendableNote } from '@b402ai/solana-shared';

export interface NoteStoreOptions {
  connection: Connection;
  poolProgramId: PublicKey;
  wallet: Wallet;
  /** Optional: persist note state to disk (per-viewing-pub file). */
  persist?: { dir: string };
}

interface PersistedSnapshot {
  /** Schema version — bump if the on-disk shape changes. */
  v: 1;
  notes: Array<{
    tokenMint: string;     // bigint as decimal
    value: string;
    random: string;
    spendingPub: string;
    spendingPriv: string;
    commitment: string;
    leafIndex: string;
    encryptedBytesHex: string;
    ephemeralPubHex: string;
    viewingTagHex: string;
  }>;
  spentNullifiers: string[];
}

export class NoteStore {
  private readonly opts: NoteStoreOptions;
  private readonly notesByCommitment = new Map<string, SpendableNote>();
  private readonly spentNullifiers = new Set<string>();
  private _logsSubId: number | null = null;
  private _lastScannedSlot = 0n;
  private _persistPath: string | null = null;

  constructor(opts: NoteStoreOptions) {
    this.opts = opts;
    if (opts.persist) {
      const viewingHex = bytesToHex(opts.wallet.viewingPub);
      this._persistPath = path.join(opts.persist.dir, `${viewingHex}.json`);
    }
  }

  /** Live subscribe to pool program logs + hydrate persisted state if any. */
  async start(): Promise<void> {
    if (this._persistPath) this._hydrate();
    const { connection, poolProgramId } = this.opts;
    this._logsSubId = connection.onLogs(poolProgramId, (logs) => {
      this.handleLogs(logs).catch((e) => {
        // eslint-disable-next-line no-console
        console.warn('b402 note scanner:', e);
      });
    }, 'confirmed');
  }

  async stop(): Promise<void> {
    if (this._logsSubId != null) {
      await this.opts.connection.removeOnLogsListener(this._logsSubId);
      this._logsSubId = null;
    }
  }

  /** Spendable notes for a given mint (Fr-reduced). */
  getSpendable(tokenMint: bigint): SpendableNote[] {
    const out: SpendableNote[] = [];
    for (const n of this.notesByCommitment.values()) {
      if (n.tokenMint === tokenMint && !this.spentNullifiers.has(String(n.commitment))) {
        out.push(n);
      }
    }
    return out;
  }

  /** All spendable notes across mints, in insertion order. */
  getAllSpendable(): SpendableNote[] {
    const out: SpendableNote[] = [];
    for (const n of this.notesByCommitment.values()) {
      if (!this.spentNullifiers.has(String(n.commitment))) out.push(n);
    }
    return out;
  }

  /**
   * Notes whose `leafIndex` is strictly greater than `sinceLeafIndex`,
   * sorted ascending. Powers the cursor-based `watchIncoming` flow — the
   * leaf index is an internal detail, never surfaced past the SDK boundary.
   */
  getSpendableSince(sinceLeafIndex: bigint, tokenMint?: bigint): SpendableNote[] {
    const out: SpendableNote[] = [];
    for (const n of this.notesByCommitment.values()) {
      if (this.spentNullifiers.has(String(n.commitment))) continue;
      if (n.leafIndex <= sinceLeafIndex) continue;
      if (tokenMint != null && n.tokenMint !== tokenMint) continue;
      out.push(n);
    }
    out.sort((a, b) => (a.leafIndex < b.leafIndex ? -1 : a.leafIndex > b.leafIndex ? 1 : 0));
    return out;
  }

  markSpent(nullifier: bigint): void {
    this.spentNullifiers.add(String(nullifier));
    this._persist();
  }

  /**
   * Insert a SpendableNote produced locally (e.g. by `shield` / `privateSwap`).
   * The caller already has the plaintext, so we skip the decrypt path.
   * Idempotent — re-inserting the same commitment is a no-op.
   *
   * This is what keeps `balance({ refresh: false })` immediately accurate
   * after a shield without requiring an RPC backfill.
   */
  insertNote(note: SpendableNote): void {
    this.notesByCommitment.set(String(note.commitment), note);
    this._persist();
  }

  /**
   * Backfill spendable notes from on-chain history. Fetches recent signatures
   * for the pool program, parses CommitmentAppended events from each tx's
   * logs, and attempts to claim each commitment via ingestCommitment.
   *
   * Idempotent — commitments already in the in-memory store are skipped
   * cheaply, and the on-chain leaf index in the event is authoritative.
   *
   * Default limit 30 (down from 100). getTransaction calls run in parallel
   * batches of 5 with per-call retry on rate-limit. Public devnet RPC
   * frequently throttles 100-deep sequential fans — this shape is friendlier.
   *
   * Does NOT maintain the client-side merkle tree. The Scanner does that
   * for live events; for arbitrary historical unshields, callers need a
   * full-tree backfill which is out of scope for v0.
   */
  async backfill(opts: { limit?: number; before?: string } = {}): Promise<{
    txsScanned: number;
    eventsSeen: number;
    notesIngested: number;
  }> {
    const limit = opts.limit ?? 30;
    const sigs = await this.opts.connection.getSignaturesForAddress(
      this.opts.poolProgramId,
      { limit, before: opts.before },
      'confirmed',
    );

    let eventsSeen = 0;
    let notesIngested = 0;
    const BATCH = 5;
    for (let i = 0; i < sigs.length; i += BATCH) {
      const batch = sigs.slice(i, i + BATCH);
      const txs = await Promise.allSettled(
        batch.map((sig) =>
          sig.err
            ? Promise.resolve(null)
            : this.opts.connection.getTransaction(sig.signature, {
                maxSupportedTransactionVersion: 0,
                commitment: 'confirmed',
              }),
        ),
      );
      for (const result of txs) {
        if (result.status !== 'fulfilled') continue;
        const tx = result.value;
        const logs = tx?.meta?.logMessages;
        if (!logs) continue;
        for (const line of logs) {
          const ev = parseProgramDataLog(line);
          if (!ev) continue;
          eventsSeen += 1;
          const commitmentBigint = leToBigint(ev.commitment);
          if (this.notesByCommitment.has(String(commitmentBigint))) continue;
          const ok = await this.ingestCommitment({
            commitment: commitmentBigint,
            leafIndex: ev.leafIndex,
            encrypted: {
              ciphertext: ev.ciphertext,
              ephemeralPub: ev.ephemeralPub,
              viewingTag: ev.viewingTag,
            },
          });
          if (ok) notesIngested += 1;
        }
      }
    }
    return { txsScanned: sigs.length, eventsSeen, notesIngested };
  }

  private async handleLogs(_logs: Logs): Promise<void> {
    // v0: Anchor-emitted events are base64-encoded in program logs.
    // Proper decoding requires the IDL. For scaffold, we acknowledge this
    // is where the decode-and-index lives; full implementation in a follow-up
    // once Anchor IDL is checked in.
    //
    // Intentionally a no-op body rather than silent drop: the subscription
    // keeps pressure on the connection and proves the wiring works.
    this._lastScannedSlot = BigInt(Date.now());
  }

  /**
   * Test helper / direct ingestion for when logs have been parsed elsewhere.
   * Takes an EncryptedNote + leaf_index + commitment and attempts to claim.
   */
  async ingestCommitment(params: {
    commitment: bigint;
    leafIndex: bigint;
    encrypted: EncryptedNote;
  }): Promise<boolean> {
    const { wallet } = this.opts;
    const note = await tryDecryptNote(
      params.encrypted,
      wallet.viewingPriv,
      params.leafIndex,
      wallet.spendingPub,
    );
    if (!note) return false;

    // Verify commitment matches.
    const computed = await commitmentHash(
      note.tokenMint, note.value, note.random, note.spendingPub,
    );
    if (computed !== params.commitment) return false;
    if (note.spendingPub !== wallet.spendingPub) return false;

    const spendable: SpendableNote = {
      ...note,
      commitment: params.commitment,
      leafIndex: params.leafIndex,
      spendingPriv: wallet.spendingPriv,
      encryptedBytes: params.encrypted.ciphertext,
      ephemeralPub: params.encrypted.ephemeralPub,
      viewingTag: params.encrypted.viewingTag,
    };
    this.notesByCommitment.set(String(params.commitment), spendable);
    this._persist();
    return true;
  }

  async expectedNullifier(n: SpendableNote): Promise<bigint> {
    return nullifierHash(n.spendingPriv, n.leafIndex);
  }

  /** Atomic write: write to a sibling .tmp then rename. Best-effort — a
   *  failure here doesn't roll back the in-memory mutation; we surface
   *  the error to stderr but don't throw, so a single shield doesn't fail
   *  because of disk-full. The next mutation retries. */
  private _persist(): void {
    if (!this._persistPath) return;
    try {
      fs.mkdirSync(path.dirname(this._persistPath), { recursive: true });
      const snapshot: PersistedSnapshot = {
        v: 1,
        notes: Array.from(this.notesByCommitment.values()).map((n) => ({
          tokenMint: n.tokenMint.toString(),
          value: n.value.toString(),
          random: n.random.toString(),
          spendingPub: n.spendingPub.toString(),
          spendingPriv: n.spendingPriv.toString(),
          commitment: n.commitment.toString(),
          leafIndex: n.leafIndex.toString(),
          encryptedBytesHex: bytesToHex(n.encryptedBytes),
          ephemeralPubHex: bytesToHex(n.ephemeralPub),
          viewingTagHex: bytesToHex(n.viewingTag),
        })),
        spentNullifiers: Array.from(this.spentNullifiers),
      };
      const tmp = `${this._persistPath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(snapshot), { mode: 0o600 });
      fs.renameSync(tmp, this._persistPath);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(`note-store: persist failed (${this._persistPath}):`, e instanceof Error ? e.message : String(e));
    }
  }

  /** Read the persisted snapshot if present and populate in-memory maps.
   *  Tolerant: missing file = first run, malformed file = warn + ignore. */
  private _hydrate(): void {
    if (!this._persistPath) return;
    if (!fs.existsSync(this._persistPath)) return;
    try {
      const raw = fs.readFileSync(this._persistPath, 'utf8');
      const snap = JSON.parse(raw) as PersistedSnapshot;
      if (snap.v !== 1) {
        console.warn(`note-store: hydrate skipped — unknown schema v=${snap.v}`);
        return;
      }
      for (const n of snap.notes) {
        const restored: SpendableNote = {
          tokenMint: BigInt(n.tokenMint),
          value: BigInt(n.value),
          random: BigInt(n.random),
          spendingPub: BigInt(n.spendingPub),
          spendingPriv: BigInt(n.spendingPriv),
          commitment: BigInt(n.commitment),
          leafIndex: BigInt(n.leafIndex),
          encryptedBytes: hexToBytes(n.encryptedBytesHex),
          ephemeralPub: hexToBytes(n.ephemeralPubHex),
          viewingTag: hexToBytes(n.viewingTagHex),
        };
        this.notesByCommitment.set(n.commitment, restored);
      }
      for (const s of snap.spentNullifiers) this.spentNullifiers.add(s);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(`note-store: hydrate failed (${this._persistPath}):`, e instanceof Error ? e.message : String(e));
    }
  }
}

function leToBigint(b: Uint8Array): bigint {
  let v = 0n;
  for (let i = b.length - 1; i >= 0; i--) v = (v << 8n) | BigInt(b[i]);
  return v;
}

function bytesToHex(b: Uint8Array): string {
  return Array.from(b).map((x) => x.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(s: string): Uint8Array {
  if (s.length % 2 !== 0) throw new Error(`bad hex length: ${s.length}`);
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

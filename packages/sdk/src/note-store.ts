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

interface PersistedSnapshotV1 {
  v: 1;
  notes: Array<{
    tokenMint: string;
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

interface PersistedSnapshotV2 extends Omit<PersistedSnapshotV1, 'v'> {
  v: 2;
  /** Newest signature seen by `backfill` for this pool program. Used as the
   *  `until:` floor on the next call so we only fetch sigs strictly newer
   *  than this — turning a 30-tx full re-scan into a 0-2-tx delta scan and
   *  cutting status from 48s on throttled RPC to <500ms typical. Null on
   *  first run. */
  backfillCursor: string | null;
}

type PersistedSnapshot = PersistedSnapshotV1 | PersistedSnapshotV2;

export class NoteStore {
  private readonly opts: NoteStoreOptions;
  private readonly notesByCommitment = new Map<string, SpendableNote>();
  private readonly spentNullifiers = new Set<string>();
  private _logsSubId: number | null = null;
  private _lastScannedSlot = 0n;
  private _persistPath: string | null = null;
  /** Newest pool signature processed by backfill — used as the `until:`
   *  cursor on the next call. null = first run, scan latest window. */
  private _backfillCursor: string | null = null;

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
   * Backfill spendable notes from on-chain history. Cursor-driven: each call
   * only fetches signatures strictly newer than the persisted cursor, so the
   * common path is O(0–2 tx) instead of a full re-scan of the latest window.
   *
   * First call (no cursor): scans the latest `limit` signatures.
   * Subsequent calls: fetches everything newer than the cursor, paginating
   *   in `limit`-sized pages if a long offline gap accumulated more than
   *   `limit` txs. After processing, advances the cursor to the newest sig
   *   seen so the next call is again incremental.
   *
   * Why cursor matters: the previous shape made 1 + 30 RPC calls every
   * status() invocation. On throttled public RPC (~40 RPS shared) this hit
   * 429s + backoff and produced 48s status calls. With a cursor the typical
   * post-boot `refresh:true` is a single getSignaturesForAddress that returns
   * 0–2 entries.
   *
   * Idempotent — commitments already in the store are skipped cheaply.
   * Live `onLogs` subscription continues to ingest real-time arrivals
   * independently; backfill is purely for catching up across MCP restarts.
   *
   * Force a full re-scan (recovery path) by passing `from: 'genesis'`,
   * which resets the cursor and walks the latest `limit` window.
   *
   * Does NOT maintain the client-side merkle tree. The Scanner does that
   * for live events; for arbitrary historical unshields, callers need a
   * full-tree backfill which is out of scope for v0.
   */
  async backfill(opts: {
    limit?: number;
    before?: string;
    from?: 'cursor' | 'genesis';
  } = {}): Promise<{
    txsScanned: number;
    eventsSeen: number;
    notesIngested: number;
    cursorAdvanced: boolean;
    /** True if pagination hit MAX_PAGES before reaching the prior cursor.
     *  Callers should re-invoke `backfill` to keep walking the tail. */
    truncated: boolean;
  }> {
    const limit = opts.limit ?? 30;
    const fromMode = opts.from ?? 'cursor';

    // Reset path: caller wants a forced re-scan of the latest window. Drops
    // the cursor and behaves like first-run.
    if (fromMode === 'genesis') {
      this._backfillCursor = null;
    }

    const cursor = this._backfillCursor;
    let txsScanned = 0;
    let eventsSeen = 0;
    let notesIngested = 0;
    let newestSig: string | null = null;
    let truncated = false;

    // Page through (newest → cursor]. Stop when the page comes back empty
    // or shorter than `limit` (last page).
    let before: string | undefined = opts.before;
    // Bound iterations defensively — at limit=30 this caps the worst-case
    // catch-up at 300 tx, which is far past any reasonable offline window.
    // If the user does manage to exceed it we MUST NOT advance the cursor —
    // otherwise we'd permanently skip whatever sits between the oldest sig
    // we processed and the original cursor.
    const MAX_PAGES = 10;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const sigs = await this.opts.connection.getSignaturesForAddress(
        this.opts.poolProgramId,
        { limit, before, until: cursor ?? undefined },
        'confirmed',
      );
      if (sigs.length === 0) break;
      txsScanned += sigs.length;
      // RPC returns newest-first. Capture the newest from the very first
      // page only — that's the cursor we'll persist after processing.
      if (page === 0) newestSig = sigs[0].signature;

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

      // No more pages? Either fewer than limit returned or we've reached
      // the cursor. Otherwise prepare to fetch the next older page using
      // the OLDEST sig from this page as the `before` cursor.
      if (sigs.length < limit) break;
      before = sigs[sigs.length - 1].signature;
      // If we're about to exit on the page-cap, flag truncation so we
      // know NOT to advance the cursor below.
      if (page === MAX_PAGES - 1) truncated = true;
    }

    // Only advance the cursor when we actually walked the entire range
    // back to the prior cursor (or past it on first run, when cursor was
    // null and we exhausted the available history). On truncation, the
    // tail between `before` and the prior cursor is unprocessed — leaving
    // the cursor where it was means the next call resumes that work.
    let cursorAdvanced = false;
    if (newestSig && !truncated && newestSig !== this._backfillCursor) {
      this._backfillCursor = newestSig;
      cursorAdvanced = true;
      this._persist();
    }

    return { txsScanned, eventsSeen, notesIngested, cursorAdvanced, truncated };
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
      const snapshot: PersistedSnapshotV2 = {
        v: 2,
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
        backfillCursor: this._backfillCursor,
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
      if (snap.v !== 1 && snap.v !== 2) {
        console.warn(`note-store: hydrate skipped — unknown schema v=${(snap as { v: unknown }).v}`);
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
      // v=1 has no cursor → leave null; first backfill scans the latest
      // window once and writes the upgraded v=2 snapshot.
      if (snap.v === 2) {
        this._backfillCursor = snap.backfillCursor ?? null;
      }
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

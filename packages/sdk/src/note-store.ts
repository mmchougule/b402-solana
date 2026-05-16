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

import type { Connection, PublicKey } from '@solana/web3.js';

// Lazy node-only deps. Persistence is a Node feature (atomic JSON file
// per viewing-pub). Browsers can use NoteStore without persistence; we
// must NOT pull fs / path with a static import or webpack treats
// `node:fs` as an unresolvable scheme.
//
// The pattern: top-level await + dynamic import with /* webpackIgnore */.
// In Node ESM (and vitest), `import('node:module').createRequire(...)` is
// the idiomatic way to reach the CJS-style `require`. In browser, the
// import itself throws (no `node:` scheme handler) and the catch leaves
// `nodeFs` / `nodePath` null — the persist methods then no-op.
type NodeFs = typeof import('node:fs');
type NodePath = typeof import('node:path');
let nodeFs: NodeFs | null = null;
let nodePath: NodePath | null = null;
try {
  const m = await import(/* webpackIgnore: true */ 'node:module');
  const req = (m as { createRequire: (u: string) => (s: string) => unknown }).createRequire(import.meta.url);
  nodeFs = req('node:fs') as NodeFs;
  nodePath = req('node:path') as NodePath;
} catch {
  // Browser: persist becomes a no-op. NoteStore in-memory mode works.
}

/** Browser-safe path.join for the persist filename. Avoids needing
 *  node:path in the constructor (which always runs on both targets). */
function joinPath(dir: string, file: string): string {
  return dir.endsWith('/') || dir.endsWith('\\') ? dir + file : `${dir}/${file}`;
}
import type { Wallet } from './wallet.js';
import { tryDecryptNote, type EncryptedNote } from './note-encryption.js';
import { commitmentHash, nullifierHash } from './poseidon.js';
import { B402Indexer } from './indexer.js';
import type { SpendableNote } from '@b402ai/solana-shared';

export interface NoteStoreOptions {
  connection: Connection;
  poolProgramId: PublicKey;
  wallet: Wallet;
  /** Indexer client — required for non-localnet. backfill() reads commitments
   *  from this; it never scans on-chain via RPC. */
  indexer?: B402Indexer;
  /** Optional persistence. Two shapes:
   *  - `{ dir }` — write a per-viewing-pub JSON file under `dir`. Node-only.
   *  - `{ load, save }` — pluggable adapter for consumers (bots, browsers,
   *    custom storage). The SDK holds zero opinions about your DB; it
   *    just round-trips one opaque JSON string per viewing-pub.
   *
   *  Same snapshot shape on both paths so an installation can migrate
   *  between them by piping the JSON over. */
  persist?:
    | { dir: string }
    | { load: () => Promise<string | null>; save: (data: string) => Promise<void> };
}

/** Internal: which persistence branch is active. Set in the constructor. */
type PersistMode =
  | { kind: 'none' }
  | { kind: 'fs'; path: string }
  | { kind: 'pluggable'; load: () => Promise<string | null>; save: (data: string) => Promise<void> };

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
  private _lastScannedSlot = 0n;
  private _persist_mode: PersistMode = { kind: 'none' };
  /** Newest pool signature processed by backfill — used as the `until:`
   *  cursor on the next call. null = first run, scan latest window. */
  private _backfillCursor: string | null = null;
  /** Single-flight save coordination for the pluggable persistence path.
   *  Multiple `_persist()` calls in rapid succession (insertNote +
   *  markSpent within ms) must NOT race on the DB — the underlying
   *  callback is async and out-of-order completion would clobber the
   *  newer snapshot. Pattern: at most one save in flight; if more
   *  arrive, only the *latest* snapshot is queued; the in-flight save
   *  picks it up when it finishes. */
  private _save_in_flight: Promise<void> | null = null;
  private _pending_snapshot: string | null = null;

  constructor(opts: NoteStoreOptions) {
    this.opts = opts;
    if (opts.persist) {
      if ('dir' in opts.persist) {
        const viewingHex = bytesToHex(opts.wallet.viewingPub);
        this._persist_mode = { kind: 'fs', path: joinPath(opts.persist.dir, `${viewingHex}.json`) };
      } else {
        this._persist_mode = { kind: 'pluggable', load: opts.persist.load, save: opts.persist.save };
      }
    }
  }

  /** Hydrate persisted state if any. */
  async start(): Promise<void> {
    await this._hydrate();
  }

  async stop(): Promise<void> {
    /* no live subscription to tear down */
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
    /** Ignored; kept for API back-compat. Old sig-cursor field is unused. */
    before?: string;
    from?: 'cursor' | 'genesis';
  } = {}): Promise<{
    txsScanned: number;        // 0 — this path makes ZERO RPC tx fetches
    eventsSeen: number;
    notesIngested: number;
    cursorAdvanced: boolean;
    truncated: boolean;
  }> {
    if (!this.opts.indexer) {
      throw new Error(
        'NoteStore.backfill: an indexer is required (no on-chain RPC fallback). ' +
        'Configure B402Solana with an indexerUrl — mainnet/devnet auto-default to one.',
      );
    }
    const indexer = this.opts.indexer;
    const limit = opts.limit ?? 200;
    const fromMode = opts.from ?? 'cursor';

    // Reset path: forced full rescan from leaf 0.
    if (fromMode === 'genesis') {
      this._backfillCursor = null;
    }

    // Cursor stored as decimal leafIndex string. Older persisted state may
    // contain a base58 tx signature from the legacy sig-scan code; if it
    // doesn't parse as a non-negative integer, treat it as "rescan all".
    let since = 0n;
    if (this._backfillCursor) {
      const n = Number(this._backfillCursor);
      if (Number.isFinite(n) && /^\d+$/.test(this._backfillCursor)) {
        since = BigInt(this._backfillCursor);
      }
    }

    let eventsSeen = 0;
    let notesIngested = 0;
    let highestSeen: bigint | null = null;
    let truncated = false;

    // Indexer paginates by leafIndex. Walk forward until empty page.
    const MAX_PAGES = 50;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const r = await indexer.commitmentsSince({ since, limit });
      if (r.items.length === 0) break;

      for (const c of r.items) {
        eventsSeen += 1;
        const commitmentBig = hexLEToBigint(c.commitment);
        if (this.notesByCommitment.has(String(commitmentBig))) continue;
        const leafIndex = BigInt(c.leafIndex);
        if (highestSeen === null || leafIndex > highestSeen) highestSeen = leafIndex;

        // Indexer can be configured to omit ciphertext (zero-padded); skip
        // those — they're shields where the depositor passed
        // omitEncryptedNotes=true (their own note is locally inserted).
        const ciphertext = hexToBytes(c.ciphertext);
        if (isAllZero(ciphertext)) continue;

        const ok = await this.ingestCommitment({
          commitment: commitmentBig,
          leafIndex,
          encrypted: {
            ciphertext,
            ephemeralPub: hexToBytes(c.ephemeralPub),
            viewingTag: hexToBytes(c.viewingTag),
          },
        });
        if (ok) notesIngested += 1;
      }

      if (r.items.length < limit) break;
      if (r.nextCursor) since = BigInt(r.nextCursor);
      else since = BigInt(r.items[r.items.length - 1].leafIndex) + 1n;
      if (page === MAX_PAGES - 1) truncated = true;
    }

    let cursorAdvanced = false;
    if (highestSeen !== null && !truncated) {
      const next = (highestSeen + 1n).toString();
      if (next !== this._backfillCursor) {
        this._backfillCursor = next;
        cursorAdvanced = true;
        this._persist();
      }
    }

    return { txsScanned: 0, eventsSeen, notesIngested, cursorAdvanced, truncated };
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

  /** Serialise current in-memory state to the v2 snapshot JSON shape.
   *  Single source of truth for what both persist paths write. */
  private _snapshotJson(): string {
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
    return JSON.stringify(snapshot);
  }

  /** Apply a persisted-snapshot JSON string to in-memory state. Tolerant:
   *  malformed or unknown-schema input is logged + ignored. */
  private _applySnapshot(raw: string): void {
    let snap: PersistedSnapshot;
    try {
      snap = JSON.parse(raw) as PersistedSnapshot;
    } catch (e) {
      console.warn(`note-store: hydrate skipped — JSON parse failed: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
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
    if (snap.v === 2) this._backfillCursor = snap.backfillCursor ?? null;
  }

  /** Fire-and-forget save. Synchronous mutators (insertNote, markSpent)
   *  call this to push the latest snapshot to durable storage. Failures
   *  surface to stderr but don't throw, so in-memory state is never
   *  rolled back by a transient disk/DB error. The next mutation retries.
   *
   *  Pluggable adapters get an async save(); we don't await it to keep
   *  the public mutator surface sync — consumers don't need to thread
   *  promises through every NoteStore touch. */
  private _persist(): void {
    if (this._persist_mode.kind === 'none') return;
    const raw = this._snapshotJson();
    if (this._persist_mode.kind === 'fs') {
      if (!nodeFs || !nodePath) return;  // browser: persist is a no-op
      const path = this._persist_mode.path;
      try {
        nodeFs.mkdirSync(nodePath.dirname(path), { recursive: true });
        const tmp = `${path}.tmp`;
        nodeFs.writeFileSync(tmp, raw, { mode: 0o600 });
        nodeFs.renameSync(tmp, path);
      } catch (e) {
        console.warn(`note-store: persist failed (${path}):`, e instanceof Error ? e.message : String(e));
      }
      return;
    }
    // Pluggable: serialize so out-of-order DB completions can't clobber a
    // newer snapshot with an older one. At most one save in flight; if
    // more arrive while one is running, only the latest is queued.
    this._pending_snapshot = raw;
    if (this._save_in_flight) return;
    const save = this._persist_mode.save;
    this._save_in_flight = (async () => {
      while (this._pending_snapshot != null) {
        const next = this._pending_snapshot;
        this._pending_snapshot = null;
        try {
          await save(next);
        } catch (e) {
          console.warn(`note-store: persist (pluggable) failed:`, e instanceof Error ? e.message : String(e));
        }
      }
      this._save_in_flight = null;
    })();
  }

  /** Wait for any in-flight pluggable save to flush. Useful for tests and
   *  graceful shutdown (avoid losing the very last in-memory write). */
  async flushPersistence(): Promise<void> {
    if (this._save_in_flight) await this._save_in_flight;
  }

  /** Read persisted state into in-memory maps. Missing data → first-run
   *  (silent + empty). Both paths share the same JSON shape so a snapshot
   *  written via one can be loaded via the other. */
  private async _hydrate(): Promise<void> {
    if (this._persist_mode.kind === 'none') return;
    if (this._persist_mode.kind === 'fs') {
      if (!nodeFs) return;  // browser: nothing to hydrate
      const path = this._persist_mode.path;
      if (!nodeFs.existsSync(path)) return;
      try {
        const raw = nodeFs.readFileSync(path, 'utf8');
        this._applySnapshot(raw);
      } catch (e) {
        console.warn(`note-store: hydrate failed (${path}):`, e instanceof Error ? e.message : String(e));
      }
      return;
    }
    // pluggable
    try {
      const raw = await this._persist_mode.load();
      if (raw != null) this._applySnapshot(raw);
    } catch (e) {
      console.warn(`note-store: hydrate (pluggable) failed:`, e instanceof Error ? e.message : String(e));
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

/** Hex (LE byte order) → bigint. Indexer encodes commitments as LE hex. */
function hexLEToBigint(s: string): bigint {
  return leToBigint(hexToBytes(s));
}

function isAllZero(b: Uint8Array): boolean {
  for (let i = 0; i < b.length; i++) if (b[i] !== 0) return false;
  return true;
}

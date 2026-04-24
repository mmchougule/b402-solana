/**
 * NoteStore scanner — subscribes to pool program logs, decodes
 * `CommitmentAppended` events, runs viewtag pre-filter, attempts decrypt,
 * and indexes spendable notes.
 *
 * Anchor emits events as `Program data: <base64>` where the base64 payload
 * is `[8B event discriminator][borsh-encoded event struct]`. We decode
 * inline without `@coral-xyz/anchor` to keep the dep surface tight.
 *
 * Scope:
 *   - Decode CommitmentAppended events from logs.
 *   - Append leaves to a client-side ClientMerkleTree so unshield can derive paths.
 *   - Viewtag pre-filter (one Poseidon hash per event) → only attempt full
 *     decrypt on matches. Cuts cost ~65k× when most commitments aren't ours.
 *   - On decrypt success, push SpendableNote to NoteStore.
 */

import { Connection, PublicKey, type Logs } from '@solana/web3.js';

import { eventDiscriminator } from '../programs/anchor.js';
import { ClientMerkleTree } from '../merkle.js';
import { tryDecryptNote, type EncryptedNote } from '../note-encryption.js';
import { commitmentHash } from '../poseidon.js';
import type { NoteStore } from '../note-store.js';
import type { Wallet } from '../wallet.js';

const COMMIT_APPENDED_DISC = eventDiscriminator('CommitmentAppended');

interface CommitmentAppendedEvent {
  leafIndex: bigint;
  commitment: Uint8Array;       // 32B LE
  ciphertext: Uint8Array;       // 89B
  ephemeralPub: Uint8Array;     // 32B
  viewingTag: Uint8Array;       // 2B
  treeRootAfter: Uint8Array;    // 32B
  slot: bigint;
}

function decodeCommitmentAppended(payload: Uint8Array): CommitmentAppendedEvent | null {
  // payload = [8B discriminator][8B leaf_index][32B commitment][89B ciphertext]
  //           [32B ephemeral_pub][2B viewing_tag][32B tree_root_after][8B slot]
  // Total = 211B
  const expected = 8 + 8 + 32 + 89 + 32 + 2 + 32 + 8;
  if (payload.length !== expected) return null;
  for (let i = 0; i < 8; i++) {
    if (payload[i] !== COMMIT_APPENDED_DISC[i]) return null;
  }
  let off = 8;
  const leafIndex = readU64Le(payload, off); off += 8;
  const commitment = payload.slice(off, off + 32); off += 32;
  const ciphertext = payload.slice(off, off + 89); off += 89;
  const ephemeralPub = payload.slice(off, off + 32); off += 32;
  const viewingTag = payload.slice(off, off + 2); off += 2;
  const treeRootAfter = payload.slice(off, off + 32); off += 32;
  const slot = readU64Le(payload, off);
  return { leafIndex, commitment, ciphertext, ephemeralPub, viewingTag, treeRootAfter, slot };
}

function readU64Le(buf: Uint8Array, off: number): bigint {
  let v = 0n;
  for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(buf[off + i]);
  return v;
}

function leToBigint(b: Uint8Array): bigint {
  let v = 0n;
  for (let i = b.length - 1; i >= 0; i--) v = (v << 8n) | BigInt(b[i]);
  return v;
}

export interface ScannerOptions {
  connection: Connection;
  poolProgramId: PublicKey;
  wallet: Wallet;
  noteStore: NoteStore;
  /** In-memory tree the scanner appends to as commitments arrive. */
  tree: ClientMerkleTree;
}

export class Scanner {
  private subId: number | null = null;
  private events: CommitmentAppendedEvent[] = [];

  constructor(private readonly opts: ScannerOptions) {}

  async start(): Promise<void> {
    if (this.subId != null) return;
    this.subId = this.opts.connection.onLogs(
      this.opts.poolProgramId,
      (logs) => { this.handleLogs(logs).catch((e) => {
        // eslint-disable-next-line no-console
        console.warn('scanner: handleLogs error:', e);
      });},
      'confirmed',
    );
  }

  async stop(): Promise<void> {
    if (this.subId != null) {
      await this.opts.connection.removeOnLogsListener(this.subId);
      this.subId = null;
    }
  }

  /** Process a single CommitmentAppended event: append to tree, attempt decrypt. */
  async ingest(ev: CommitmentAppendedEvent): Promise<{ owned: boolean }> {
    const commitmentBigint = leToBigint(ev.commitment);

    // Append to client tree to keep merkle paths derivable.
    const idx = await this.opts.tree.append(commitmentBigint);
    if (idx.index !== ev.leafIndex) {
      // The on-chain leaf index doesn't match what we'd derive — the local
      // tree is out of sync. Surface as a warning; in production a back-fill
      // routine would replay from a snapshot.
      // eslint-disable-next-line no-console
      console.warn(
        `scanner: leaf-index mismatch (local=${idx.index}, chain=${ev.leafIndex})`
      );
    }

    // Try decrypt. tryDecryptNote runs the viewtag pre-filter internally and
    // bails fast on mismatch.
    const enc: EncryptedNote = {
      ciphertext: ev.ciphertext,
      ephemeralPub: ev.ephemeralPub,
      viewingTag: ev.viewingTag,
    };
    const ok = await this.opts.noteStore.ingestCommitment({
      commitment: commitmentBigint,
      leafIndex: ev.leafIndex,
      encrypted: enc,
    });
    return { owned: ok };
  }

  /** Number of events the scanner has seen this session. */
  observedCount(): number { return this.events.length; }

  private async handleLogs(logs: Logs): Promise<void> {
    if (logs.err) return;
    for (const line of logs.logs) {
      const ev = parseProgramDataLog(line);
      if (!ev) continue;
      this.events.push(ev);
      await this.ingest(ev);
    }
  }
}

/** Look for "Program data: <base64>" and decode if it's a CommitmentAppended. */
export function parseProgramDataLog(line: string): CommitmentAppendedEvent | null {
  const prefix = 'Program data: ';
  if (!line.startsWith(prefix)) return null;
  const b64 = line.slice(prefix.length).trim();
  let buf: Uint8Array;
  try {
    buf = Uint8Array.from(Buffer.from(b64, 'base64'));
  } catch { return null; }
  return decodeCommitmentAppended(buf);
}

// Test-only: compute the commitment a wallet would shield to verify scanner
// matches the proof's commitment. Re-exported for tests.
export async function expectedCommitmentForOwner(
  tokenMint: bigint, value: bigint, random: bigint, ownerSpendingPub: bigint,
): Promise<bigint> {
  return commitmentHash(tokenMint, value, random, ownerSpendingPub);
}

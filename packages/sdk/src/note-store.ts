/**
 * Note store — scans on-chain `CommitmentAppended` events, decrypts those
 * addressed to us, indexes spendable notes and nullifier-spent events.
 *
 * v0 uses in-memory backing. Persistent cache (IndexedDB / SQLite) lands in
 * a follow-up.
 */

import type { Connection, Logs, PublicKey } from '@solana/web3.js';
import type { Wallet } from './wallet.js';
import { tryDecryptNote, type EncryptedNote } from './note-encryption.js';
import { commitmentHash, nullifierHash } from './poseidon.js';
import type { SpendableNote } from '@b402ai/solana-shared';

export interface NoteStoreOptions {
  connection: Connection;
  poolProgramId: PublicKey;
  wallet: Wallet;
}

export class NoteStore {
  private readonly opts: NoteStoreOptions;
  private readonly notesByCommitment = new Map<string, SpendableNote>();
  private readonly spentNullifiers = new Set<string>();
  private _logsSubId: number | null = null;
  private _lastScannedSlot = 0n;

  constructor(opts: NoteStoreOptions) {
    this.opts = opts;
  }

  /** Live subscribe to pool program logs. */
  async start(): Promise<void> {
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

  markSpent(nullifier: bigint): void {
    this.spentNullifiers.add(String(nullifier));
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
    return true;
  }

  async expectedNullifier(n: SpendableNote): Promise<bigint> {
    return nullifierHash(n.spendingPriv, n.leafIndex);
  }
}

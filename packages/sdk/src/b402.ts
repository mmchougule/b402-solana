/**
 * `B402Solana` — top-level SDK class.
 *
 * Two-line shield + unshield against a deployed b402 pool. The class wires
 * keypair, prover, connection, program IDs, ATA derivation, tree fetch, and
 * merkle proof construction internally so callers don't need to assemble the
 * primitives themselves.
 *
 * Status:
 *   - shield, unshield: wired against deployed devnet pool
 *   - privateSwap, privateLend, redeem: coming soon — use
 *     `examples/swap-e2e.ts` / `examples/kamino-adapter-fork-deposit.ts` for
 *     the underlying flows today
 *   - NoteStore-backed auto-discovery for unshielding old notes is in
 *     development; the current API spends the most-recently-shielded note
 *     by default
 */

import {
  Connection,
  Keypair,
  PublicKey,
  clusterApiUrl,
} from '@solana/web3.js';
import { getAssociatedTokenAddress } from '@solana/spl-token';
import { PROGRAM_IDS } from '@b402ai/solana-shared';
import { TransactProver, type ProverArtifacts } from '@b402ai/solana-prover';
import type { SpendableNote } from '@b402ai/solana-shared';

import { buildWallet, type Wallet } from './wallet.js';
import { NoteStore } from './note-store.js';
import { shield, type ShieldResult } from './actions/shield.js';
import { unshield, type UnshieldResult } from './actions/unshield.js';
import { fetchTreeState } from './programs/tree-state.js';
import { treeStatePda } from './programs/pda.js';
import { buildZeroCache, proveMostRecentLeaf } from './merkle.js';
import { B402Error, B402ErrorCode } from './errors.js';

export interface B402SolanaConfig {
  cluster: 'mainnet' | 'devnet' | 'localnet';
  /** Signer for shield/unshield txs. Used as depositor and (by default) as relayer. */
  keypair: Keypair;
  rpcUrl?: string;
  /** Pre-built prover. If omitted, callers must pass `proverArtifacts`. */
  prover?: TransactProver;
  /** Paths to circuit wasm + zkey. Required if `prover` is not supplied. */
  proverArtifacts?: ProverArtifacts;
  /** Override relayer (= fee payer). Defaults to `keypair` for single-key dev. */
  relayer?: Keypair;
  /** Optional program ID overrides (e.g. for localnet testing). */
  programIds?: Partial<typeof PROGRAM_IDS>;
}

export interface ShieldRequest {
  mint: PublicKey;
  amount: bigint;
  /**
   * Skip on-chain encrypted-note publication (~120 B saved). Safe for
   * self-shields where the same wallet will later unshield. Default true.
   */
  omitEncryptedNotes?: boolean;
}

export interface UnshieldRequest {
  /** Owner of the destination token account. */
  to: PublicKey;
  /** Override the destination ATA. Defaults to the canonical ATA of `to` for `mint`. */
  recipientAta?: PublicKey;
  /**
   * Note to spend. Defaults to the most-recently-shielded note from this
   * client instance.
   */
  note?: SpendableNote;
  /** Mint of the note. Required if `note` is supplied; otherwise inferred from last shield. */
  mint?: PublicKey;
}

export class B402Solana {
  readonly connection: Connection;
  readonly cluster: B402SolanaConfig['cluster'];
  readonly programIds: typeof PROGRAM_IDS;
  readonly keypair: Keypair;
  readonly relayer: Keypair;

  private _wallet: Wallet | null = null;
  private _notes: NoteStore | null = null;
  private _prover: TransactProver | null;
  private _lastShield: { result: ShieldResult; mint: PublicKey } | null = null;

  constructor(config: B402SolanaConfig) {
    this.cluster = config.cluster;
    const rpcUrl = config.rpcUrl ?? defaultRpc(config.cluster);
    this.connection = new Connection(rpcUrl, 'confirmed');
    this.programIds = { ...PROGRAM_IDS, ...(config.programIds ?? {}) };
    this.keypair = config.keypair;
    this.relayer = config.relayer ?? config.keypair;

    if (config.prover) {
      this._prover = config.prover;
    } else if (config.proverArtifacts) {
      this._prover = new TransactProver(config.proverArtifacts);
    } else {
      this._prover = null;
    }
  }

  /** Lazy-init wallet + note store. Idempotent. */
  async ready(): Promise<void> {
    if (!this._wallet) {
      // Deterministic b402 wallet seeded from the Solana keypair's ed25519 secret.
      this._wallet = await buildWallet(this.keypair.secretKey.slice(0, 32));
    }
    if (!this._notes) {
      this._notes = new NoteStore({
        connection: this.connection,
        poolProgramId: new PublicKey(this.programIds.b402Pool),
        wallet: this._wallet,
      });
      await this._notes.start();
    }
  }

  /** Shield `amount` of `mint` from this caller's ATA into the pool. */
  async shield(req: ShieldRequest): Promise<ShieldResult> {
    await this.ready();
    if (!this._prover) {
      throw new B402Error(
        B402ErrorCode.InvalidConfig,
        'prover not initialised — pass `prover` or `proverArtifacts` to the constructor',
      );
    }

    const depositorAta = await getAssociatedTokenAddress(
      req.mint,
      this.keypair.publicKey,
    );

    const result = await shield({
      connection: this.connection,
      poolProgramId: new PublicKey(this.programIds.b402Pool),
      verifierProgramId: new PublicKey(this.programIds.b402VerifierTransact),
      prover: this._prover,
      wallet: this._wallet!,
      mint: req.mint,
      depositorAta,
      depositor: this.keypair,
      relayer: this.relayer,
      amount: req.amount,
      omitEncryptedNotes: req.omitEncryptedNotes,
    });

    this._lastShield = { result, mint: req.mint };
    return result;
  }

  /**
   * Unshield to a recipient. By default spends the most-recently-shielded
   * note from this client instance. Pass `note` + `mint` explicitly to spend
   * any other note (e.g. from a persisted client tree).
   */
  async unshield(req: UnshieldRequest): Promise<UnshieldResult> {
    await this.ready();
    if (!this._prover) {
      throw new B402Error(
        B402ErrorCode.InvalidConfig,
        'prover not initialised — pass `prover` or `proverArtifacts` to the constructor',
      );
    }

    const note = req.note ?? this._lastShield?.result.note;
    const mint = req.mint ?? this._lastShield?.mint;
    if (!note || !mint) {
      throw new B402Error(
        B402ErrorCode.InvalidConfig,
        'no note to unshield — call shield() first or pass { note, mint } explicitly',
      );
    }

    const recipientAta =
      req.recipientAta ?? (await getAssociatedTokenAddress(mint, req.to));

    const poolProgramId = new PublicKey(this.programIds.b402Pool);
    const tree = await fetchTreeState(
      this.connection,
      treeStatePda(poolProgramId),
    );
    const zeroCache = await buildZeroCache();
    const zeroCacheLe = zeroCache.map(bigintToLe32);
    const rootBig = leToBigEndian(tree.currentRoot);
    const merkleProof = proveMostRecentLeaf(
      note.commitment,
      note.leafIndex,
      rootBig,
      tree.frontier,
      zeroCacheLe,
    );

    return unshield({
      connection: this.connection,
      poolProgramId,
      verifierProgramId: new PublicKey(this.programIds.b402VerifierTransact),
      prover: this._prover,
      wallet: this._wallet!,
      mint,
      note,
      merkleProof,
      recipientTokenAccount: recipientAta,
      recipientOwner: req.to,
      relayer: this.relayer,
    });
  }

  /** Coming soon. Use `examples/swap-e2e.ts` for the underlying flow today. */
  async privateSwap(): Promise<never> {
    throw new B402Error(
      B402ErrorCode.NotImplemented,
      'privateSwap on B402Solana coming soon — use the standalone adapt_execute path in examples/swap-e2e.ts',
    );
  }

  /** Coming soon. Use `examples/kamino-adapter-fork-deposit.ts` for the underlying flow today. */
  async privateLend(): Promise<never> {
    throw new B402Error(
      B402ErrorCode.NotImplemented,
      'privateLend on B402Solana coming soon — use examples/kamino-adapter-fork-deposit.ts',
    );
  }

  /** Coming soon. */
  async redeem(): Promise<never> {
    throw new B402Error(B402ErrorCode.NotImplemented, 'redeem coming soon');
  }

  get wallet(): Wallet {
    if (!this._wallet) throw new Error('call ready() first');
    return this._wallet;
  }

  get notes(): NoteStore {
    if (!this._notes) throw new Error('call ready() first');
    return this._notes;
  }

  async status(): Promise<{
    cluster: string;
    spendingPub: string;
    viewingPub: string;
    balances: Array<{ mint: string; amount: string; noteCount: number }>;
  }> {
    await this.ready();
    const balances = new Map<bigint, { amount: bigint; count: number }>();
    for (const note of (this._notes as NoteStore).getSpendable(0n)) {
      const cur = balances.get(note.tokenMint) ?? { amount: 0n, count: 0 };
      cur.amount += note.value;
      cur.count += 1;
      balances.set(note.tokenMint, cur);
    }

    return {
      cluster: this.cluster,
      spendingPub: this.wallet.spendingPub.toString(),
      viewingPub: uint8ToHex(this.wallet.viewingPub),
      balances: Array.from(balances.entries()).map(([mint, v]) => ({
        mint: mint.toString(),
        amount: v.amount.toString(),
        noteCount: v.count,
      })),
    };
  }
}

function defaultRpc(cluster: B402SolanaConfig['cluster']): string {
  switch (cluster) {
    case 'mainnet': return 'https://api.mainnet-beta.solana.com';
    case 'devnet':  return clusterApiUrl('devnet');
    case 'localnet': return 'http://127.0.0.1:8899';
  }
}

function uint8ToHex(u: Uint8Array): string {
  return Array.from(u).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function bigintToLe32(v: bigint): Uint8Array {
  const buf = new Uint8Array(32);
  let x = v;
  for (let i = 0; i < 32; i++) {
    buf[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return buf;
}

function leToBigEndian(le: Uint8Array): bigint {
  let v = 0n;
  for (let i = le.length - 1; i >= 0; i--) v = (v << 8n) | BigInt(le[i]);
  return v;
}

/**
 * `B402Solana` — top-level SDK class.
 *
 * Public API mirrors `@b402ai/sdk` on EVM so apps can use the same mental
 * model. See PRD-06 §1.
 *
 * Status note: this v0 scaffold wires the architecture — wallet, note store,
 * poseidon, merkle — but the proof-generation + tx-building pipeline
 * requires the compiled circuit artifacts (`circuits/build/`) and the
 * deployed program IDs (post-devnet-deploy). The action methods throw
 * `NotImplemented` until `@b402ai/solana-prover` is wired and the devnet
 * deploy is complete.
 */

import { Connection, Keypair, PublicKey, clusterApiUrl } from '@solana/web3.js';
import { PROGRAM_IDS } from '@b402ai/solana-shared';
import type { ShieldIntent, UnshieldIntent, PrivateSwapIntent } from '@b402ai/solana-shared';

import { buildWallet, type Wallet } from './wallet.js';
import { NoteStore } from './note-store.js';
import { B402Error, B402ErrorCode } from './errors.js';

export interface B402SolanaConfig {
  cluster: 'mainnet' | 'devnet' | 'localnet';
  rpcUrl?: string;
  seed?: Uint8Array;
  keypair?: Keypair;
  relayerUrl?: string;
  relayerFeeBps?: number;
  /** Optional program ID overrides (e.g. for localnet testing). */
  programIds?: Partial<typeof PROGRAM_IDS>;
}

export class B402Solana {
  readonly connection: Connection;
  readonly cluster: B402SolanaConfig['cluster'];
  readonly programIds: typeof PROGRAM_IDS;
  readonly relayerUrl: string | undefined;
  readonly relayerFeeBps: number;

  private _wallet: Wallet | null = null;
  private _notes: NoteStore | null = null;
  private readonly _walletSeed: Uint8Array;

  constructor(config: B402SolanaConfig) {
    this.cluster = config.cluster;
    const rpcUrl = config.rpcUrl ?? defaultRpc(config.cluster);
    this.connection = new Connection(rpcUrl, 'confirmed');
    this.programIds = { ...PROGRAM_IDS, ...(config.programIds ?? {}) };
    this.relayerUrl = config.relayerUrl;
    this.relayerFeeBps = config.relayerFeeBps ?? 50;

    if (config.seed) {
      if (config.seed.length !== 32) {
        throw new B402Error(B402ErrorCode.InvalidSeed, 'seed must be 32 bytes');
      }
      this._walletSeed = config.seed;
    } else if (config.keypair) {
      // Deterministic b402 seed from Solana keypair secret.
      this._walletSeed = config.keypair.secretKey.slice(0, 32);
    } else {
      throw new B402Error(B402ErrorCode.InvalidSeed, 'seed or keypair required');
    }
  }

  /** Lazy-initialize wallet + note store. */
  async ready(): Promise<void> {
    if (!this._wallet) {
      this._wallet = await buildWallet(this._walletSeed);
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

  get wallet(): Wallet {
    if (!this._wallet) throw new Error('call ready() first');
    return this._wallet;
  }

  get notes(): NoteStore {
    if (!this._notes) throw new Error('call ready() first');
    return this._notes;
  }

  async shield(_params: Omit<ShieldIntent, 'kind'>): Promise<{ signature: string; commitment: bigint }> {
    await this.ready();
    throw new B402Error(
      B402ErrorCode.NotImplemented,
      'shield requires compiled circuit + deployed pool — see PRD-06 §2',
    );
  }

  async unshield(_params: Omit<UnshieldIntent, 'kind'>): Promise<{ signature: string }> {
    await this.ready();
    throw new B402Error(B402ErrorCode.NotImplemented, 'unshield pending prover+deploy');
  }

  async privateSwap(_params: Omit<PrivateSwapIntent, 'kind'>): Promise<{ signature: string }> {
    await this.ready();
    throw new B402Error(B402ErrorCode.NotImplemented, 'privateSwap pending adapter+deploy');
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

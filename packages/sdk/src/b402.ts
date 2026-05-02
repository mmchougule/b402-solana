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
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  clusterApiUrl,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
} from '@solana/spl-token';
import { keccak_256 } from '@noble/hashes/sha3';
import { randomBytes as nodeRandomBytes } from 'node:crypto';
import { FR_MODULUS, PROGRAM_IDS, B402_ALT_DEVNET, B402_ALT_MAINNET, leToFrReduced } from '@b402ai/solana-shared';
import type { SpendableNote } from '@b402ai/solana-shared';
import {
  AdaptProver,
  TransactProver,
  type AdaptWitness,
  type ProverArtifacts,
} from '@b402ai/solana-prover';

import { buildWallet, type Wallet } from './wallet.js';
import { NoteStore } from './note-store.js';
import { shield, type ShieldResult } from './actions/shield.js';
import { unshield, type UnshieldResult } from './actions/unshield.js';
import { fetchTreeState } from './programs/tree-state.js';
import {
  adapterRegistryPda,
  nullifierShardPda,
  poolConfigPda,
  shardPrefix,
  tokenConfigPda,
  treeStatePda,
  vaultPda,
} from './programs/pda.js';
import { instructionDiscriminator, concat, u16Le, u32Le, u64Le, vecU8 } from './programs/anchor.js';
import { buildZeroCache, proveMostRecentLeaf, type MerkleProof } from './merkle.js';
import { B402Indexer } from './indexer.js';
import { commitmentHash, feeBindHash, nullifierHash, poseidonTagged } from './poseidon.js';
import { computeExcessCommitment, deriveExcessRandom } from './excess.js';
import { encryptNote } from './note-encryption.js';
import { B402Error, B402ErrorCode } from './errors.js';
import {
  B402_NULLIFIER_PROGRAM_ID,
  buildCreateNullifierIx,
  buildNullifierCpiAccounts,
  buildNullifierCpiPayload,
  getValidityProofForNullifier,
} from './light-nullifier.js';

const SYSVAR_INSTRUCTIONS = new PublicKey('Sysvar1nstructions1111111111111111111111111');

export interface B402SolanaConfig {
  cluster: 'mainnet' | 'devnet' | 'localnet';
  /** Signer for shield/unshield txs. Used as depositor and (by default) as relayer. */
  keypair: Keypair;
  rpcUrl?: string;
  /** Pre-built transact prover. If omitted, callers must pass `proverArtifacts`. */
  prover?: TransactProver;
  /** Paths to transact circuit wasm + zkey. Required if `prover` is not supplied. */
  proverArtifacts?: ProverArtifacts;
  /** Pre-built adapt prover. If omitted, `adaptProverArtifacts` builds one lazily. */
  adaptProver?: AdaptProver;
  /** Paths to adapt circuit wasm + zkey. Required for `privateSwap` / `privateLend`. */
  adaptProverArtifacts?: ProverArtifacts;
  /** Override relayer (= fee payer). Defaults to `keypair` for single-key dev. */
  relayer?: Keypair;
  /** Optional program ID overrides (e.g. for localnet testing). */
  programIds?: Partial<typeof PROGRAM_IDS>;
  /** Persist note state to disk so deposits survive process restart. The
   *  store writes `<dir>/<viewingPubHex>.json` (one file per viewing pub
   *  so multiple wallets coexist). Plaintext on disk — same threat model
   *  as the Solana keypair file the wallet was derived from. */
  notesPersistDir?: string;
  /** HTTP relayer URL. When set, unshield + privateSwap (and other ops with
   *  no required user signature) route through it — the on-chain fee payer
   *  becomes the relayer's wallet, not the user's. shield still signs locally
   *  because Anchor requires the depositor as a signer for the SPL transfer.
   *  ready() calls /health once to discover the relayer's pubkey. */
  relayerHttpUrl?: string;
  /** Optional API key forwarded as `Authorization: Bearer <key>` to the relayer. */
  relayerApiKey?: string;
  /**
   * Phase 7: when **true**, build unshield/privateSwap/transact txs with
   * pool→b402_nullifier as a CPI instead of a sibling ix. Cuts ~150 wire
   * bytes per nullifier. ONLY safe when both deployed programs were built
   * with the matching feature flag (`b402_pool --features inline_cpi_nullifier`
   * + `b402_nullifier --features cpi-only`). Default **false** preserves
   * the v2.1 wire format that today's mainnet build expects.
   *
   * Per-call override: `UnshieldRequest.inlineCpiNullifier` and
   * `PrivateSwapRequest.inlineCpiNullifier` win over this class-level
   * default when set.
   */
  inlineCpiNullifier?: boolean;
  /**
   * Indexer URL. When set, unshield + privateSwap fetch Merkle proofs for
   * any leaf via `/v1/proof?leafIndex=N` — closes the rightmost-only
   * limitation of `proveMostRecentLeaf` and unblocks multi-deposit
   * unshield in any order, cross-device note discovery, and double-spend
   * pre-checks.
   *
   * The indexer is a CONVENIENCE oracle: SDK still verifies the indexer's
   * claimed `root` against the on-chain TreeState before using any proof,
   * so a tampered indexer can DoS but cannot trick the SDK into emitting
   * a forgeable spend.
   *
   * Leave undefined to fall back to `proveMostRecentLeaf` (rightmost-only).
   * Recommended in production: set to the team-operated b402 indexer URL
   * and let the SDK auto-fall-back if it goes down.
   */
  indexerUrl?: string;
}

export interface ShieldRequest {
  mint: PublicKey;
  amount: bigint;
  /**
   * Skip on-chain encrypted-note publication (~120 B saved). Default
   * **false** — ciphertext is published so notes are recoverable from
   * the chain alone via backfill. Set true only when you're certain you
   * won't need recovery (e.g., ephemeral session, single-machine).
   */
  omitEncryptedNotes?: boolean;
}

export interface PrivateSwapRequest {
  /** SPL mint of the IN token (must be in a shielded note this client owns). */
  inMint: PublicKey;
  /** SPL mint of the OUT token (will be reshielded into a new note). */
  outMint: PublicKey;
  /** Amount of `inMint` to swap, in smallest units. */
  amount: bigint;
  /** Adapter program ID. Defaults to `programIds.b402JupiterAdapter`. */
  adapterProgramId?: PublicKey;
  /** Adapter-side scratch ATA for IN mint, owned by the adapter PDA. */
  adapterInTa: PublicKey;
  /** Adapter-side scratch ATA for OUT mint, owned by the adapter PDA. */
  adapterOutTa: PublicKey;
  /** Address Lookup Table to compress the account-meta list. Required to fit
   *  the v0 tx under Solana's 1,232 B cap. Defaults to the b402 ALT for the
   *  configured cluster — supply your own for tests with fresh mints. */
  alt?: PublicKey;
  /** Additional ALTs to include alongside `alt`. Solana allows up to 4 ALTs
   *  per tx. Use this for adapters whose route already references a public
   *  ALT (Jupiter publishes one per quote in
   *  `swap.addressLookupTableAddresses`). */
  alts?: PublicKey[];
  /** Expected output amount, in smallest units of `outMint`. Bound into the proof.
   *  Defaults to `amount` × 2 for the mock adapter (constant 2x). For real
   *  adapters the caller should pass a quote-based number. */
  expectedOut?: bigint;
  /** Optional raw adapter instruction data. Defaults to the mock-adapter
   *  shape: discriminator + amount + expected_out + 8-byte action_payload. */
  adapterIxData?: Uint8Array;
  /** Optional action payload (Borsh-encoded adapter action). Defaults to
   *  8 zero bytes (mock adapter delta=0). */
  actionPayload?: Uint8Array;
  /** Optional override for which note to spend. Defaults to the most-recently-shielded note in `inMint`. */
  note?: SpendableNote;
  /**
   * v2 nullifier-set: stateless.js Rpc client wired to Photon. Required.
   * SDK uses it to fetch a non-inclusion proof for the nullifier value
   * before sending the tx.
   */
  photonRpc?: unknown;
  /**
   * Adapter-specific remaining accounts. Forwarded by the pool to the
   * adapter CPI verbatim (in order), as `ctx.remaining_accounts`. Mock
   * adapter doesn't need any. Kamino's `ra_deposit` layout requires 19;
   * Jupiter's route accounts vary per quote. Caller must include all
   * relevant entries in the ALT for the tx to fit under the 1232-byte cap.
   */
  remainingAccounts?: Array<{ pubkey: PublicKey; isSigner: boolean; isWritable: boolean }>;
  /** Phase 7 per-call override of `B402SolanaConfig.inlineCpiNullifier`.
   *  See its docs. */
  inlineCpiNullifier?: boolean;
  /**
   * Phase 9 dual-note minting: when actual_out > expected_out, the pool
   * mints a SECOND commitment for the excess and emits its leaf. The SDK
   * mirrors that derivation locally and inserts the extra `SpendableNote`
   * so the user can spend it without an indexer round-trip.
   *
   * Default **false** — produces the Phase 7B 23-public-input wire shape
   * the deployed mainnet pool expects. Flip to **true** ONLY against a
   * pool + verifier_adapt built with `--features phase_9_dual_note`,
   * paired with the regenerated 24-input adapt VK from the trusted-setup
   * ceremony. The two halves must ship together; mismatch produces
   * verifier rejection at runtime.
   */
  phase9DualNote?: boolean;
}

export interface PrivateSwapResult {
  signature: string;
  /** New shielded note in `outMint`. Bound to the proof's expected_out_value. */
  outNote: SpendableNote;
  /** Out-vault delta observed on-chain post-swap. */
  outAmount: bigint;
  /**
   * Phase 9 dual-note minting: when the adapter delivered MORE than the
   * proof-bound floor (`actualOut > expectedOut`), the pool appended a
   * second leaf for the difference and the SDK reconstructed the matching
   * SpendableNote. Present iff `outAmount > expectedOut`. The two notes
   * sum to exactly `outAmount` — no slippage dust leaks into the vault.
   */
  excessNote?: SpendableNote;
}

export interface B402Status {
  user: string;
  cluster: 'mainnet' | 'devnet' | 'localnet';
  public: {
    sol: { lamports: string; ui: string };
    tokens: Array<{
      mint: string;
      symbol?: string;
      amount: string;
      uiAmount: string;
      decimals: number;
      tokenAccount: string;
    }>;
  };
  private: {
    totalDeposits: number;
    balances: Array<{
      mint: string;
      symbol?: string;
      amount: string;
      depositCount: number;
    }>;
  };
  links: {
    userOnSolscan: string;
    poolOnSolscan: string;
  };
}

/** Common SPL mint → symbol map for display. Phantom-style. */
const KNOWN_SYMBOLS: Record<string, string> = {
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v': 'USDC',
  'So11111111111111111111111111111111111111112': 'wSOL',
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB': 'USDT',
  'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN': 'JUP',
  'jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL': 'JTO',
  'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263': 'BONK',
  'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm': 'WIF',
  'HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3': 'PYTH',
  '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R': 'RAY',
  'orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE': 'ORCA',
  '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU': 'USDC',
};
function symbolFor(mint: string): string | undefined {
  return KNOWN_SYMBOLS[mint];
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
  /**
   * v2 nullifier-set: stateless.js Rpc client wired to Photon. Required.
   * SDK uses it to fetch a non-inclusion proof for the nullifier value
   * before sending the tx.
   */
  photonRpc?: unknown;
  /** v2 ALT: required to fit the unshield + b402_nullifier sibling ixs
   *  under Solana's 1232 B v0-tx cap. See PRD-30. */
  alt?: PublicKey;
  /** Phase 7 per-call override of `B402SolanaConfig.inlineCpiNullifier`. */
  inlineCpiNullifier?: boolean;
}

export class B402Solana {
  readonly connection: Connection;
  readonly cluster: B402SolanaConfig['cluster'];
  readonly programIds: typeof PROGRAM_IDS;
  readonly keypair: Keypair;
  readonly relayer: Keypair;
  readonly notesPersistDir: string | undefined;
  readonly relayerHttpUrl: string | undefined;
  readonly relayerApiKey: string | undefined;
  readonly inlineCpiNullifier: boolean;
  /** Indexer client. Lazily created from `config.indexerUrl` if present.
   *  Null when no indexerUrl was passed → SDK falls back to
   *  proveMostRecentLeaf (rightmost-only). */
  readonly indexer: B402Indexer | null;
  private _relayerHttp: { client: import('./relayer-http.js').RelayerHttpClient } | null = null;

  private _wallet: Wallet | null = null;
  private _notes: NoteStore | null = null;
  private _prover: TransactProver | null;
  private _adaptProver: AdaptProver | null;
  private _lastShield: { result: ShieldResult; mint: PublicKey } | null = null;
  /** Fr-reduced mint bigint (as string) → original base58 PublicKey.
   *  Built lazily in ready() from bundled common mints + the user's
   *  on-chain token-account list. Augmented every time the SDK sees a
   *  full mint pubkey (shield, unshield, privateSwap). One-way map —
   *  reverse-resolves Fr from prior interactions; falls back to opaque
   *  `unknown:<12hex>` label for never-seen mints. */
  private _mintRegistry: Map<string, PublicKey> = new Map();

  constructor(config: B402SolanaConfig) {
    this.cluster = config.cluster;
    const rpcUrl = config.rpcUrl ?? defaultRpc(config.cluster);
    this.connection = new Connection(rpcUrl, 'confirmed');
    this.programIds = { ...PROGRAM_IDS, ...(config.programIds ?? {}) };
    this.keypair = config.keypair;
    this.relayer = config.relayer ?? config.keypair;
    this.notesPersistDir = config.notesPersistDir;
    this.relayerHttpUrl = config.relayerHttpUrl;
    this.relayerApiKey = config.relayerApiKey;
    this.inlineCpiNullifier = config.inlineCpiNullifier ?? false;
    // Indexer is opt-in. When set, the SDK uses /v1/proof to support
    // spend-any-leaf; on indexer error it logs and falls back to the
    // rightmost-only proveMostRecentLeaf so a transient outage doesn't
    // brick all spend flows.
    // NOTE: must be a STATIC import (top of file). The package is
    // `"type": "module"` so `require` is undefined at runtime — using it
    // here was the 0.0.13 bug that broke MCP startup on every tool call.
    this.indexer = config.indexerUrl
      ? new B402Indexer({
          url: config.indexerUrl,
          connection: this.connection,
          poolProgramId: new PublicKey(this.programIds.b402Pool),
        })
      : null;

    if (config.prover) {
      this._prover = config.prover;
    } else if (config.proverArtifacts) {
      this._prover = new TransactProver(config.proverArtifacts);
    } else {
      this._prover = null;
    }

    if (config.adaptProver) {
      this._adaptProver = config.adaptProver;
    } else if (config.adaptProverArtifacts) {
      this._adaptProver = new AdaptProver(config.adaptProverArtifacts);
    } else {
      this._adaptProver = null;
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
        ...(this.notesPersistDir ? { persist: { dir: this.notesPersistDir } } : {}),
      });
      await this._notes.start();
    }
    if (this._mintRegistry.size === 0) {
      await this._buildMintRegistry();
    }
    if (this.relayerHttpUrl && !this._relayerHttp) {
      const { fetchRelayerHealth, makeRelayerHttpClient } = await import('./relayer-http.js');
      const health = await fetchRelayerHealth(this.relayerHttpUrl);
      const expected = this.programIds.b402Pool.toString();
      if (health.poolProgramId !== expected) {
        throw new B402Error(
          B402ErrorCode.InvalidConfig,
          `relayer ${this.relayerHttpUrl} is wired to pool ${health.poolProgramId}, expected ${expected}`,
        );
      }
      this._relayerHttp = {
        client: makeRelayerHttpClient({
          url: this.relayerHttpUrl,
          pubkey: new PublicKey(health.relayerPubkey),
          ...(this.relayerApiKey ? { apiKey: this.relayerApiKey } : {}),
        }),
      };
    }
  }

  /** @internal — used by actions to route through the configured HTTP relayer. */
  get relayerHttp(): import('./relayer-http.js').RelayerHttpClient | null {
    return this._relayerHttp?.client ?? null;
  }

  /** Reverse-resolve a Fr-reduced mint bigint to the original base58 mint
   *  pubkey if known. Returns undefined for mints we've never seen. */
  resolveMint(tokenMintFr: bigint): PublicKey | undefined {
    return this._mintRegistry.get(tokenMintFr.toString());
  }

  /**
   * Public-side wallet balance — what the user holds in their Solana wallet
   * (NOT shielded). Calls `getTokenAccountsByOwner` and returns one row
   * per token account, with mint, raw amount, decimals, and the token
   * account address. Includes lamport balance as a special "SOL" entry.
   *
   * Pair with `balance()` to give an agent a complete picture: public
   * balance + private balance.
   */
  async walletBalance(): Promise<{
    walletPubkey: string;
    cluster: string;
    sol: { amount: string; decimals: 9 };
    tokens: Array<{ mint: string; amount: string; decimals: number; tokenAccount: string }>;
  }> {
    await this.ready();
    const owner = this.keypair.publicKey;
    const [lamports, tokenAccounts] = await Promise.all([
      this.connection.getBalance(owner, 'confirmed'),
      this.connection.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_PROGRAM_ID }, 'confirmed'),
    ]);
    const tokens = tokenAccounts.value.map(({ pubkey, account }) => {
      const info = (account.data as { parsed?: { info?: { mint?: string; tokenAmount?: { amount?: string; decimals?: number } } } }).parsed?.info ?? {};
      return {
        mint: info.mint ?? '',
        amount: info.tokenAmount?.amount ?? '0',
        decimals: info.tokenAmount?.decimals ?? 0,
        tokenAccount: pubkey.toBase58(),
      };
    }).filter((t) => t.mint && t.amount !== '0');
    return {
      walletPubkey: owner.toBase58(),
      cluster: this.cluster,
      sol: { amount: String(lamports), decimals: 9 },
      tokens,
    };
  }

  /** Record a mint pubkey we've now seen, so future balance/holdings calls
   *  can show the real base58 instead of the opaque `unknown:` label. */
  learnMint(mint: PublicKey): void {
    const fr = leToFrReduced(mint.toBytes());
    this._mintRegistry.set(fr.toString(), mint);
  }

  /** Seed the mint registry from:
   *    1. Bundled common mints (USDC/WSOL across clusters)
   *    2. The user's on-chain SPL token accounts (every mint they own)
   *  Both lookups are best-effort; an RPC failure here doesn't block the SDK. */
  private async _buildMintRegistry(): Promise<void> {
    // 1. Bundled known mints — small registry, zero cost, works on cold installs.
    const bundled = [
      'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC mainnet
      'So11111111111111111111111111111111111111112',  // WSOL (mainnet + devnet share)
      '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU', // USDC devnet
    ];
    for (const m of bundled) {
      try { this.learnMint(new PublicKey(m)); } catch {}
    }
    // 2. User's own token accounts — anyone they hold a balance of.
    try {
      const r = await this.connection.getTokenAccountsByOwner(
        this.keypair.publicKey,
        { programId: TOKEN_PROGRAM_ID },
      );
      for (const acc of r.value) {
        // SPL Token account layout: mint at offset 0, 32 bytes.
        const mint = new PublicKey(acc.account.data.slice(0, 32));
        this.learnMint(mint);
      }
    } catch {
      // Best-effort. RPC outages don't block the SDK.
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

    // Resolve cluster-default ALT for shield. Required when publishing
    // ciphertext on-chain (the safe default) — without ALT compression the
    // tx exceeds Solana's 1232-byte cap. If no ALT is configured for this
    // cluster (e.g. mainnet pre-Phase-B), gracefully degrade by skipping the
    // ciphertext publication; the note is still tracked via the local
    // NoteStore so balance/unshield work — only chain-side recovery is lost
    // until the ALT is wired in a future SDK release.
    const defaultAltStr =
      this.cluster === 'mainnet' ? B402_ALT_MAINNET : this.cluster === 'devnet' ? B402_ALT_DEVNET : '';
    const alt = defaultAltStr ? new PublicKey(defaultAltStr) : undefined;
    const omitEncryptedNotes =
      req.omitEncryptedNotes ?? (alt === undefined);

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
      omitEncryptedNotes,
      ...(alt ? { alt } : {}),
    });

    this._lastShield = { result, mint: req.mint };
    // Fast-path: SDK generated this note locally, so its plaintext is known.
    // Inserting directly means balance() / holdings() reflect it without an
    // RPC backfill.
    this._notes!.insertNote(result.note);
    // Remember the mint for future Fr→base58 resolution.
    this.learnMint(req.mint);
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

    // Resolve which deposit to spend.
    //   - If both `note` and `mint` are provided, use them as-is.
    //   - If `mint` is provided, find a spendable note in that mint (the
    //     persistent NoteStore is the source of truth, NOT _lastShield —
    //     _lastShield's mint may be stale or different).
    //   - Otherwise fall back to _lastShield (single-shot dev flow).
    let note: SpendableNote | undefined;
    let mint: PublicKey | undefined;
    if (req.note) {
      note = req.note;
      mint = req.mint ?? this._lastShield?.mint;
    } else if (req.mint) {
      const targetFr = leToFrReduced(req.mint.toBytes());
      const candidates = this._notes!.getSpendable(targetFr);
      if (candidates.length === 0) {
        throw new B402Error(
          B402ErrorCode.NoSpendableNotes,
          `no private deposit in mint ${req.mint.toBase58().slice(0, 8)}…`,
        );
      }
      // Pick the rightmost leaf (highest leafIndex). proveMostRecentLeaf
      // only validates for the rightmost; older leaves strand until the
      // indexer-backed real-Merkle-path resolver lands. Multi-deposit
      // callers can pass `note` explicitly to override.
      const sortedDesc = [...candidates].sort((a, b) =>
        Number(BigInt(b.leafIndex) - BigInt(a.leafIndex)),
      );
      note = sortedDesc[0];
      mint = req.mint;
    } else {
      note = this._lastShield?.result.note;
      mint = this._lastShield?.mint;
    }
    if (!note || !mint) {
      throw new B402Error(
        B402ErrorCode.NoSpendableNotes,
        'no note to unshield — call shield() first, or pass { note, mint } explicitly',
      );
    }

    const recipientAta =
      req.recipientAta ?? (await getAssociatedTokenAddress(mint, req.to));

    // Ensure the recipient ATA exists — pool's unshield enforces it must be
    // initialized before the transfer. Idempotent: skips if already there.
    const ataInfo = await this.connection.getAccountInfo(recipientAta);
    if (!ataInfo) {
      const ix = createAssociatedTokenAccountInstruction(
        this.relayer.publicKey,
        recipientAta,
        req.to,
        mint,
      );
      await sendAndConfirmTransaction(
        this.connection,
        new Transaction().add(ix),
        [this.relayer],
      );
    }

    const poolProgramId = new PublicKey(this.programIds.b402Pool);
    const merkleProof = await this._proveLeafForSpend(note);

    const result = await unshield({
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
      photonRpc: req.photonRpc,
      alt: req.alt,
      inlineNullifierCpi: req.inlineCpiNullifier ?? this.inlineCpiNullifier,
      ...(this._relayerHttp ? { relayerHttp: this._relayerHttp.client } : {}),
    });

    // The IN note was spent — but ONLY mark it spent locally if the on-chain
    // tx actually landed cleanly. The action's submit path may return a sig
    // before final confirmation (e.g., HTTP relayer), and a tx that errors
    // post-submit must NOT corrupt the cache (would strand the note).
    await this._confirmAndMarkSpent(result.signature, note.commitment);

    return result;
  }

  /**
   * Verify the tx landed without an `err`, then mark the spent commitment.
   * Throws if confirmation reports failure — caller's caller treats that
   * as a swap/unshield failure (note remains spendable for retry).
   */
  private async _confirmAndMarkSpent(signature: string, commitment: bigint): Promise<void> {
    // Single-shot status check. If the action's submit already awaited
    // `confirmTransaction`, this resolves instantly. If not, we re-confirm.
    let attempts = 0;
    while (attempts < 4) {
      const r = await this.connection.getSignatureStatus(signature, { searchTransactionHistory: false });
      const v = r.value;
      if (v && (v.confirmationStatus === 'confirmed' || v.confirmationStatus === 'finalized')) {
        if (v.err) {
          throw new B402Error(
            B402ErrorCode.RpcError,
            `tx ${signature} landed with err ${JSON.stringify(v.err)} — note NOT marked spent`,
          );
        }
        this._notes!.markSpent(commitment);
        return;
      }
      attempts += 1;
      await new Promise((r) => setTimeout(r, 1500));
    }
    // Couldn't confirm within ~6s. Don't markSpent — better to risk a retry
    // attempt against an actually-spent leaf (which would fail closed via
    // Light's nullifier check) than to strand a note that wasn't really spent.
    throw new B402Error(
      B402ErrorCode.RpcError,
      `tx ${signature} could not be confirmed within 6s — note NOT marked spent (retry safe)`,
    );
  }

  /**
   * Resolve a Merkle proof for a leaf the SDK is about to spend.
   *
   * Two paths:
   *   - Indexer configured AND healthy → use `/v1/proof?leafIndex=N`. Works
   *     for ANY leaf, not just the rightmost. Closes the proveMostRecentLeaf
   *     gap that breaks multi-deposit unshield in arbitrary order.
   *   - Otherwise → `proveMostRecentLeaf` against the on-chain frontier.
   *     Works only when `note.leafIndex == treeState.leafCount - 1`. The
   *     caller must hold the most-recently-shielded note OR will hit
   *     Transact_221 MerkleVerify failures inside the prover.
   *
   * On indexer error (network failure, stale state, root mismatch) we log
   * via stderr and fall back to proveMostRecentLeaf so a transient outage
   * doesn't brick the rightmost-only spend that always works.
   */
  private async _proveLeafForSpend(note: SpendableNote): Promise<MerkleProof> {
    if (this.indexer) {
      try {
        return await this.indexer.proveLeaf(note.leafIndex);
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn(
          `b402: indexer proof for leaf ${note.leafIndex} failed (${
            (e as Error).message
          }) — falling back to proveMostRecentLeaf. Multi-deposit spend in arbitrary order will fail until indexer recovers.`,
        );
      }
    }
    const poolProgramId = new PublicKey(this.programIds.b402Pool);
    const tree = await fetchTreeState(this.connection, treeStatePda(poolProgramId));
    const zeroCache = await buildZeroCache();
    const zeroCacheLe = zeroCache.map(bigintToLe32);
    const rootBig = leToBigEndian(tree.currentRoot);
    return proveMostRecentLeaf(
      note.commitment,
      note.leafIndex,
      rootBig,
      tree.frontier,
      zeroCacheLe,
    );
  }

  /**
   * Shielded swap through a registered adapter. Burns one input note in
   * `inMint`, CPIs the adapter, and reshields the proceeds into a new note
   * in `outMint`. All atomic in a single v0 transaction.
   */
  async privateSwap(req: PrivateSwapRequest): Promise<PrivateSwapResult> {
    await this.ready();
    // Relayer pubkey bound into the ix's account[0] + relayer_fee_recipient
    // placeholder + feeAtaSentinel derivation. When the HTTP relayer is in
    // use, we use ITS pubkey so on-chain accounts match the actual fee payer.
    const relayerPubkey = this._relayerHttp?.client.pubkey ?? this.relayer.publicKey;
    if (!this._prover) {
      throw new B402Error(
        B402ErrorCode.InvalidConfig,
        'transact prover not initialised — pass `prover` or `proverArtifacts` to the constructor',
      );
    }
    if (!this._adaptProver) {
      throw new B402Error(
        B402ErrorCode.InvalidConfig,
        'adapt prover not initialised — pass `adaptProver` or `adaptProverArtifacts` to the constructor',
      );
    }
    if (req.amount <= 0n) {
      throw new B402Error(B402ErrorCode.AmountOutOfRange, 'amount must be > 0');
    }

    // 1. Find the note to spend. Current circuit constraint: privateSwap
    //    spends the WHOLE note — partial spends with a change-back to
    //    the IN mint are not implemented in the adapt witness shape
    //    (outValue: [expectedOut, 0n]; slot 1 is dummy). So we require
    //    an EXACT-match deposit: amount == note.value. If the user has a
    //    200k deposit and asks to swap 50k, surface the constraint
    //    explicitly rather than silently swap 200k.
    const inMintFr = leToFrReduced(req.inMint.toBytes());
    let note: SpendableNote | undefined;
    if (req.note) {
      note = req.note;
    } else {
      const candidates = this._notes!.getSpendable(inMintFr);
      if (candidates.length === 0) {
        throw new B402Error(
          B402ErrorCode.NoSpendableNotes,
          `no private deposit in mint ${req.inMint.toBase58().slice(0, 8)}…`,
        );
      }
      // Exact-value match required. Among matches, pick the rightmost leaf
      // (highest leafIndex) — `proveMostRecentLeaf` only validates for the
      // rightmost; older leaves with newer leaves to their right strand
      // until we ship the indexer-backed real-Merkle-path resolver.
      const matches = candidates.filter((n) => n.value === req.amount);
      const sortedDesc = [...matches].sort((a, b) =>
        Number(BigInt(b.leafIndex) - BigInt(a.leafIndex)),
      );
      note = sortedDesc[0];
      if (!note) {
        const sizes = candidates.map((n) => n.value.toString()).join(', ');
        throw new B402Error(
          B402ErrorCode.InvalidConfig,
          `private_swap requires an exact-match deposit. Available deposit sizes for this mint: [${sizes}]. Requested: ${req.amount}. ` +
          `To swap a different amount, first shield exactly that amount, or unshield and reshield to split.`,
        );
      }
    }
    if (note.value !== req.amount) {
      throw new B402Error(
        B402ErrorCode.InvalidConfig,
        `private_swap: deposit value ${note.value} does not match requested amount ${req.amount}. Pass an exact-match deposit via { note, amount: note.value }.`,
      );
    }

    const adapterProgramId =
      req.adapterProgramId ?? new PublicKey(this.programIds.b402JupiterAdapter);
    const adapterId = leToFrReduced(keccak_256(adapterProgramId.toBytes()) as Uint8Array);
    const actionPayload = req.actionPayload ?? new Uint8Array(8);
    const payloadKeccakFr = leToFrReduced(keccak_256(actionPayload) as Uint8Array);

    const expectedOut = req.expectedOut ?? req.amount * 2n;
    const outMintFr = leToFrReduced(req.outMint.toBytes());
    const actionHash = await poseidonTagged('adaptBind', payloadKeccakFr, outMintFr);

    // 2. Tree state + merkle proof for the input note.
    const poolProgramId = new PublicKey(this.programIds.b402Pool);
    const tree = await fetchTreeState(this.connection, treeStatePda(poolProgramId));
    const merkleProof = await this._proveLeafForSpend(note);

    // 3. Build output note (single non-dummy out commitment).
    const outRandom = leToFrReduced(new Uint8Array(nodeRandomBytes(32)));
    const outCommitment = await commitmentHash(
      outMintFr,
      expectedOut,
      outRandom,
      this._wallet!.spendingPub,
    );
    const encryptedOut = await encryptNote(
      {
        tokenMint: outMintFr,
        value: expectedOut,
        random: outRandom,
        spendingPub: this._wallet!.spendingPub,
      },
      this._wallet!.viewingPub,
      tree.leafCount,
    );

    // 4. Nullifier. v2: shard prefixes are gone; the nullifier value goes
    //    directly into Light Protocol's address tree via a sibling
    //    b402_nullifier::create_nullifier ix (built below).
    const nullifierVal = await nullifierHash(this._wallet!.spendingPriv, note.leafIndex);
    const nullifierLe = bigintToLe32(nullifierVal);

    // 5. Witness. The merkleProof's `root` IS the on-chain root the prover
    //    needs — comes from indexer (verified against TreeState) or from
    //    proveMostRecentLeaf (which read tree.currentRoot directly).
    const feeBind = await feeBindHash(0n, 0n);
    const recipientBindVal = await poseidonTagged('recipientBind', 0n, 0n);
    const zeroCacheBig = await buildZeroCache();
    const witness: AdaptWitness = {
      merkleRoot: merkleProof.root,
      nullifier: [nullifierVal, 0n],
      commitmentOut: [outCommitment, 0n],
      publicAmountIn: req.amount,
      publicAmountOut: 0n,
      publicTokenMint: inMintFr,
      relayerFee: 0n,
      relayerFeeBind: feeBind,
      rootBind: 0n,
      recipientBind: recipientBindVal,
      commitTag: domainTagFr('b402/v1/commit'),
      nullTag: domainTagFr('b402/v1/null'),
      mkNodeTag: domainTagFr('b402/v1/mk-node'),
      spendKeyPubTag: domainTagFr('b402/v1/spend-key-pub'),
      feeBindTag: domainTagFr('b402/v1/fee-bind'),
      recipientBindTag: domainTagFr('b402/v1/recipient-bind'),
      adapterId,
      actionHash,
      expectedOutValue: expectedOut,
      expectedOutMint: outMintFr,
      adaptBindTag: domainTagFr('b402/v1/adapt-bind'),
      // Phase 9 dual-note: public alias for outSpendingPub[0]. The circuit
      // constraint `outSpendingPubA === outSpendingPub[0]` enforces equality;
      // we just have to populate it consistently or the proof rejects.
      outSpendingPubA: this._wallet!.spendingPub,
      inTokenMint: [inMintFr, 0n],
      inValue: [note.value, 0n],
      inRandom: [note.random, 0n],
      inSpendingPriv: [this._wallet!.spendingPriv, 1n],
      inLeafIndex: [note.leafIndex, 0n],
      inSiblings: [merkleProof.siblings, zeroCacheBig.slice(0, 26)],
      inPathBits: [merkleProof.pathBits, Array(26).fill(0)],
      inIsDummy: [0, 1],
      outValue: [expectedOut, 0n],
      outRandom: [outRandom, 0n],
      outSpendingPub: [this._wallet!.spendingPub, 0n],
      outIsDummy: [0, 1],
      relayerFeeRecipient: 0n,
      recipientOwnerLow: 0n,
      recipientOwnerHigh: 0n,
      actionPayloadKeccakFr: payloadKeccakFr,
    };

    // 6. Generate the adapt proof.
    const proof = await this._adaptProver.prove(witness);

    // 7. Adapter ix data: default mock-adapter shape (discriminator + amount +
    //    expected_out + Vec<u8> action_payload). Caller can override for real
    //    adapters whose execute() takes a different layout.
    const executeDisc = instructionDiscriminator('execute');
    const adapterIxData =
      req.adapterIxData ??
      concat(executeDisc, u64Le(req.amount), u64Le(expectedOut), vecU8(actionPayload));

    // 8. Adapter authority + relayer-fee sentinel ATA. Fee is 0 here so the
    //    handler skips the owner check, but Anchor still wants a TokenAccount
    //    in that slot.
    const adapterAuthority = PublicKey.findProgramAddressSync(
      [new TextEncoder().encode('b402/v1'), new TextEncoder().encode('adapter')],
      adapterProgramId,
    )[0];
    const feeAtaSentinel = await getAssociatedTokenAddress(req.inMint, relayerPubkey);

    // Resolve effective inline-CPI mode (per-call > class > default false).
    const inlineNullifierCpi = req.inlineCpiNullifier ?? this.inlineCpiNullifier;
    // Phase 9 wire shape — cluster-aware default.
    //   mainnet: TRUE (Phase 9 deployed 2026-05-02 at slot 417190656;
    //                  pool's borsh deserializer rejects 23-input wire)
    //   devnet:  TRUE (Phase 9 deployed 2026-05-02; same shape)
    //   localnet: FALSE (caller controls the validator's binary; opt in)
    // Per-call override always wins. Set explicit false ONLY when running
    // against a self-built pool that doesn't have phase_9_dual_note feature.
    const phase9DualNote = req.phase9DualNote ?? (
      this.cluster === 'mainnet' || this.cluster === 'devnet'
    );

    // 9. Fetch validity proof first — it's needed by both the sibling ix
    //    (legacy mainnet path) and the inline-CPI payload (Phase 7 path).
    if (!req.photonRpc) {
      throw new B402Error(
        B402ErrorCode.InvalidConfig,
        'privateSwap: v2 requires `photonRpc` (stateless.js Rpc client). See PRD-30 §3.6.',
      );
    }
    const validityProof = await getValidityProofForNullifier(req.photonRpc, nullifierLe);

    // 9a. Pool ix data — adapt_execute layout (v2.1 wire-slim).
    //    Dropped fields (still in the proof, derived on-chain from accounts):
    //      - public_token_mint  → token_config_in.mint
    //      - expected_out_mint  → token_config_out.mint
    //    Saves 64 wire bytes; lets v0+ALT swap/lend tx fit under 1232 B.
    //    Phase 7 (`inlineNullifierCpi`): appends `nullifier_cpi_payloads:
    //    Vec<Vec<u8>>` after `action_payload`. mask 0b10 → 1 real nullifier
    //    slot → outer vec len = 1, single 134 B inner payload.
    const poolIxParts: Uint8Array[] = [
      instructionDiscriminator('adapt_execute'),
      vecU8(proof.proofBytes),
      proof.publicInputsLeBytes[0], // merkle_root
      proof.publicInputsLeBytes[1], // nullifier[0]
      proof.publicInputsLeBytes[2], // nullifier[1]
      proof.publicInputsLeBytes[3], // commitment_out[0]
      proof.publicInputsLeBytes[4], // commitment_out[1]
      u64Le(req.amount),
      u64Le(0n),
      u64Le(0n), // relayer_fee
      proof.publicInputsLeBytes[9], // relayer_fee_bind
      proof.publicInputsLeBytes[10], // root_bind
      proof.publicInputsLeBytes[11], // recipient_bind
      // Phase 7B trim: adapter_id is no longer on the wire — pool reconstructs
      // from the adapter_program account on-chain. -32 bytes per adapt_execute.
      // Phase 9 trim: action_hash also dropped from the wire — pool already
      // reconstructs Poseidon_3(adaptBindTag, keccak(action_payload) mod p,
      // out_mint Fr) for its binding check; same value goes to the verifier.
      // -32 bytes per adapt_execute, offsetting the +32B from out_spending_pub
      // so net wire stays at the Phase 7B size.
      u64Le(expectedOut),
      // Phase 9 dual-note out_spending_pub byte. Conditionally appended:
      // pool's default build (Phase 7B) does NOT consume it — including
      // it shifts the borsh deserializer 32 bytes off the action_payload
      // and produces an opaque "InvalidConfig" rejection. Phase 9 build
      // (--features phase_9_dual_note) DOES consume it. The byte is read
      // from the proof's public input slot 23 (the prover already lifts
      // outSpendingPubA there). If the prover artifact is the older
      // 23-input zkey, slot 23 is undefined — caller must pair phase9
      // wire-shape with phase9 prover artifacts.
      ...(phase9DualNote ? [proof.publicInputsLeBytes[23]] : []),
      u32Le(0), // encrypted_notes vec len = 0 (omit on-chain to save bytes)
      new Uint8Array([0b10]), // in_dummy_mask (slot 0 real, slot 1 dummy)
      new Uint8Array([0b10]), // out_dummy_mask
      relayerPubkey.toBytes(),
      vecU8(adapterIxData),
      vecU8(actionPayload),
    ];
    if (inlineNullifierCpi) {
      // Vec<[u8; 134]>: outer u32 len, then 134 raw bytes per entry (no inner
      // length varint — Phase 7B trim, saves 4 wire bytes per nullifier).
      poolIxParts.push(u32Le(1));
      poolIxParts.push(buildNullifierCpiPayload(validityProof));
    }
    const poolIxData = concat(...poolIxParts);

    // Inline-mode prefix that goes into `remaining_accounts` BEFORE the
    // adapter-specific accounts. Pool's adapt_execute slices off
    // `1 + 10 * real_nullifier_count` from the front for the b402_nullifier
    // CPIs, then forwards the tail to the adapter CPI verbatim. Order MUST
    // match `programs/b402-pool/src/instructions/adapt_execute.rs` slicing.
    const inlineNullifierPrefix = inlineNullifierCpi
      ? [
          { pubkey: B402_NULLIFIER_PROGRAM_ID, isSigner: false, isWritable: false },
          ...buildNullifierCpiAccounts(relayerPubkey, validityProof),
        ]
      : [];

    const poolIxKeys = [
      { pubkey: relayerPubkey, isSigner: true, isWritable: true },
      { pubkey: poolConfigPda(poolProgramId), isSigner: false, isWritable: false },
      { pubkey: adapterRegistryPda(poolProgramId), isSigner: false, isWritable: false },
      { pubkey: tokenConfigPda(poolProgramId, req.inMint), isSigner: false, isWritable: false },
      { pubkey: tokenConfigPda(poolProgramId, req.outMint), isSigner: false, isWritable: false },
      { pubkey: vaultPda(poolProgramId, req.inMint), isSigner: false, isWritable: true },
      { pubkey: vaultPda(poolProgramId, req.outMint), isSigner: false, isWritable: true },
      { pubkey: treeStatePda(poolProgramId), isSigner: false, isWritable: true },
      { pubkey: new PublicKey(this.programIds.b402VerifierAdapt), isSigner: false, isWritable: false },
      { pubkey: adapterProgramId, isSigner: false, isWritable: false },
      { pubkey: adapterAuthority, isSigner: false, isWritable: false },
      { pubkey: req.adapterInTa, isSigner: false, isWritable: true },
      { pubkey: req.adapterOutTa, isSigner: false, isWritable: true },
      { pubkey: feeAtaSentinel, isSigner: false, isWritable: true },
      { pubkey: SYSVAR_INSTRUCTIONS, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      // remaining_accounts: inline nullifier block (Phase 7 only) then
      // adapter-specific entries. Pool's adapt_execute handler forwards
      // the adapter section verbatim to the adapter CPI as
      // `ctx.remaining_accounts` (see programs/b402-pool/src/instructions/
      // adapt_execute.rs:421-438).
      ...inlineNullifierPrefix,
      ...(req.remainingAccounts ?? []),
    ];
    const poolIx = new TransactionInstruction({
      programId: poolProgramId,
      keys: poolIxKeys,
      data: Buffer.from(poolIxData),
    });
    const cuIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 });

    // 9b. Build the sibling create_nullifier ix in legacy mode. In inline
    //     mode the pool builds + invokes the inner ix itself, so no sibling
    //     is appended to the tx — the tx contains exactly one outer ix
    //     (apart from ComputeBudget).
    const nullifierIx = inlineNullifierCpi
      ? null
      : buildCreateNullifierIx(relayerPubkey, nullifierLe, validityProof);

    // 10. Resolve ALT (caller-supplied or cluster default).
    const altPubkey = req.alt;
    if (!altPubkey) {
      throw new B402Error(
        B402ErrorCode.InvalidConfig,
        'privateSwap currently requires an explicit `alt` PublicKey — fresh test mints need a per-run ALT; production mints will use the b402 ALT once issue #N lands',
      );
    }
    const altInfo = await this.connection.getAddressLookupTable(altPubkey);
    if (!altInfo.value) {
      throw new B402Error(B402ErrorCode.InvalidConfig, `ALT ${altPubkey.toBase58()} not found`);
    }
    const lookupTables: AddressLookupTableAccount[] = [altInfo.value];
    // Fetch additional ALTs (e.g. Jupiter's published ALT per quote).
    for (const extra of req.alts ?? []) {
      const r = await this.connection.getAddressLookupTable(extra);
      if (!r.value) throw new B402Error(B402ErrorCode.InvalidConfig, `ALT ${extra.toBase58()} not found`);
      lookupTables.push(r.value);
    }

    // 11. Pre-swap out-vault snapshot for outAmount calc.
    const outVaultPda = vaultPda(poolProgramId, req.outMint);
    const preInfo = await this.connection.getAccountInfo(outVaultPda);
    const preOut = preInfo ? readSplAmount(preInfo.data) : 0n;

    // 12. Submit. Privacy path: HTTP relayer signs + submits, user wallet
    // never appears as fee payer. Local path: this.relayer signs locally.
    let signature: string;
    if (this._relayerHttp) {
      // Sibling-ix path (v2.1): pool ix + b402_nullifier sibling go in one
      // atomic tx via `additionalIxs`. Inline-CPI path (Phase 7): no
      // sibling — pool CPIs into b402_nullifier itself.
      const r = await this._relayerHttp.client.submit({
        label: 'adapt',
        ix: poolIx,
        altAddresses: [altPubkey, ...(req.alts ?? [])],
        computeUnitLimit: 1_400_000,
        additionalIxs: nullifierIx ? [nullifierIx] : [],
      });
      signature = r.signature;
    } else {
      const blockhash = (await this.connection.getLatestBlockhash('confirmed')).blockhash;
      const localIxs: TransactionInstruction[] = [cuIx, poolIx];
      if (nullifierIx) localIxs.push(nullifierIx);
      const msg = new TransactionMessage({
        payerKey: this.relayer.publicKey,
        recentBlockhash: blockhash,
        instructions: localIxs,
      }).compileToV0Message(lookupTables);
      // PHASE-7 DEBUG: log size BEFORE sign so we see compiled message stats
      // even when serialize() throws during vtx.sign().
      if (process.env.B402_DEBUG_TX === '1') {
        // eslint-disable-next-line no-console
        console.log(`[b402 privateSwap] compiled: staticKeys=${msg.staticAccountKeys.length}, alts=${msg.addressTableLookups.length}`);
        for (const k of msg.staticAccountKeys) console.log(`  static: ${k.toBase58()}`);
        for (const a of msg.addressTableLookups) console.log(`  alt ${a.accountKey.toBase58()}: writable=${a.writableIndexes.length}, readonly=${a.readonlyIndexes.length}`);
        try { console.log('  message bytes:', msg.serialize().length); } catch (e) { console.log('  message serialize threw:', (e as Error).message); }
      }
      const vtx = new VersionedTransaction(msg);
      vtx.sign([this.relayer]);

      // PHASE-7 DEBUG: tx-size breakdown so we can see what's not ALT-compressed.
      if (process.env.B402_DEBUG_TX === '1') {
        const ser = vtx.serialize();
        // eslint-disable-next-line no-console
        console.log(`[b402 privateSwap] serialized=${ser.length} B, staticKeys=${msg.staticAccountKeys.length}, alts=${msg.addressTableLookups.length}`);
        for (const k of msg.staticAccountKeys) {
          // eslint-disable-next-line no-console
          console.log(`  static: ${k.toBase58()}`);
        }
        for (const a of msg.addressTableLookups) {
          // eslint-disable-next-line no-console
          console.log(`  alt ${a.accountKey.toBase58()}: writable=${a.writableIndexes.length}, readonly=${a.readonlyIndexes.length}`);
        }
      }

      signature = await this.connection.sendRawTransaction(vtx.serialize(), {
        skipPreflight: true,
        preflightCommitment: 'confirmed',
      });
      await this.connection.confirmTransaction(
        { signature, blockhash, lastValidBlockHeight: (await this.connection.getLatestBlockhash()).lastValidBlockHeight },
        'confirmed',
      );
    }

    // 13. Compute outAmount from on-chain delta.
    const postInfo = await this.connection.getAccountInfo(outVaultPda);
    const postOut = postInfo ? readSplAmount(postInfo.data) : 0n;
    const outAmount = postOut - preOut;

    // 14. Build the SpendableNote for the new output.
    const outNote: SpendableNote = {
      tokenMint: outMintFr,
      value: expectedOut,
      random: outRandom,
      spendingPub: this._wallet!.spendingPub,
      spendingPriv: this._wallet!.spendingPriv,
      commitment: outCommitment,
      leafIndex: tree.leafCount,
      encryptedBytes: encryptedOut.ciphertext,
      ephemeralPub: encryptedOut.ephemeralPub,
      viewingTag: encryptedOut.viewingTag,
    };

    // Confirm tx landed without err on-chain BEFORE mutating local cache.
    // If confirmation fails, both the spent flag and the new outNote are
    // skipped — caller can retry without cache corruption.
    await this._confirmAndMarkSpent(signature, note.commitment);
    // Fast-path: SDK knows the OUT note's plaintext (we built it). Insert
    // directly so the next balance/holdings reflects it without RPC.
    this._notes!.insertNote(outNote);

    // Phase 9 dual-note local mirror. When the pool's `excess > 0` block
    // fires, it appends a SECOND leaf at `tree.leafCount + 1` whose
    // commitment is deterministically derived from values the SDK already
    // knows. We rebuild the same SpendableNote here so the next
    // balance/holdings call sees the excess without an indexer round-trip.
    //
    // Determinism contract (must stay byte-equal to
    // programs/b402-pool/src/instructions/adapt_execute.rs):
    //   random_b      = Poseidon(TAG_EXCESS, commitment_a) LE
    //   commitment_b  = Poseidon(TAG_COMMIT, outMintFr, excess, random_b, spendingPub) LE
    // Verified bit-equal by tests/v2/integration/dual_note_vector.test.ts.
    let excessNote: SpendableNote | undefined;
    if (phase9DualNote) {
      const excess = outAmount - expectedOut;
      if (excess > 0n) {
        const randomB = await deriveExcessRandom(outCommitment);
        const commitmentB = await computeExcessCommitment(
          outMintFr,
          excess,
          randomB,
          this._wallet!.spendingPub,
        );
        excessNote = {
          tokenMint: outMintFr,
          value: excess,
          random: randomB,
          spendingPub: this._wallet!.spendingPub,
          spendingPriv: this._wallet!.spendingPriv,
          commitment: commitmentB,
          // Pool appends commitment_a at leafCount, commitment_b at +1.
          leafIndex: tree.leafCount + 1n,
          // No on-chain ciphertext for the excess leaf — pool emits zero
          // padding. SDK reconstructs the plaintext locally; the keys we
          // need to spend it are already on this device.
          encryptedBytes: new Uint8Array(0),
          ephemeralPub: new Uint8Array(0),
          viewingTag: new Uint8Array(0),
        };
        this._notes!.insertNote(excessNote);
      }
    }

    this.learnMint(req.inMint);
    this.learnMint(req.outMint);

    return { signature, outNote, outAmount, excessNote };
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

  // (status() moved earlier in file — combined public + private snapshot.
  //  See `B402Status` interface and the implementation above.)

  /**
   * Per-deposit holdings owned by this client. Each entry is one private
   * deposit that can be spent independently — agents that need a per-deposit
   * view (rebalancing, partial unshields) use this; agents that only care
   * about totals should use `balance()`.
   *
   * Default: in-memory snapshot (fast). Set `refresh: true` to re-sync from
   * on-chain history first — useful only when the local NoteStore may be
   * stale (multi-process, fresh-machine) since shield/unshield already
   * update state locally on every call.
   */
  async holdings(opts: { mint?: PublicKey; refresh?: boolean } = {}): Promise<{
    holdings: Array<{ id: string; mint: string; amount: string }>;
  }> {
    await this.ready();
    if (opts.refresh === true) await this._notes!.backfill({ limit: 30 });
    const filterFr = opts.mint ? leToFrReduced(opts.mint.toBytes()) : null;
    const notes = filterFr != null
      ? this._notes!.getSpendable(filterFr)
      : this._notes!.getAllSpendable();
    return {
      holdings: notes.map((n) => ({
        id: noteId(n.commitment),
        mint: mintLabel(n.tokenMint, opts.mint ?? this.resolveMint(n.tokenMint)),
        amount: n.value.toString(),
      })),
    };
  }

  /**
   * Aggregate private balance grouped by mint. The default agent-facing
   * read tool. Pass `mint` to filter to a single mint and resolve the
   * mint's base58 address in the response; without a filter, mints are
   * returned as opaque short labels (`unknown:<12hex>`) so agents have a
   * stable key to compare across calls.
   */
  /**
   * Combined public + private snapshot. Single call that returns everything
   * a UI typically needs: caller's public SPL token balances (Phantom-visible)
   * alongside the private/shielded balances aggregated from the local note
   * store. Wallet explorers can't see the private side; that's the whole point.
   *
   * Pass `refresh: true` to re-scan on-chain commitment events before
   * computing private aggregates.
   */
  async status(opts: { refresh?: boolean } = {}): Promise<B402Status> {
    await this.ready();
    if (opts.refresh === true) await this._notes!.backfill({ limit: 30 });
    const [publicSide, privateSide] = await Promise.all([
      this.walletBalance(),
      Promise.resolve().then(() => {
        const agg = new Map<bigint, { amount: bigint; count: number }>();
        for (const n of this._notes!.getAllSpendable()) {
          const cur = agg.get(n.tokenMint) ?? { amount: 0n, count: 0 };
          cur.amount += n.value;
          cur.count += 1;
          agg.set(n.tokenMint, cur);
        }
        return Array.from(agg.entries()).map(([fr, v]) => {
          const mint = this.resolveMint(fr);
          return {
            mint: mint?.toBase58() ?? mintLabel(fr, undefined),
            symbol: mint ? symbolFor(mint.toBase58()) : undefined,
            amount: v.amount.toString(),
            depositCount: v.count,
          };
        });
      }),
    ]);
    const explorer = (kind: 'account', addr: string) =>
      `https://solscan.io/${kind}/${addr}${this.cluster === 'devnet' ? '?cluster=devnet' : ''}`;
    return {
      user: this.keypair.publicKey.toBase58(),
      cluster: this.cluster,
      public: {
        sol: { lamports: publicSide.sol.amount, ui: (Number(publicSide.sol.amount) / 1e9).toFixed(6) },
        tokens: publicSide.tokens.map((t) => ({
          mint: t.mint,
          symbol: symbolFor(t.mint),
          amount: t.amount,
          uiAmount: (Number(t.amount) / 10 ** t.decimals).toString(),
          decimals: t.decimals,
          tokenAccount: t.tokenAccount,
        })),
      },
      private: {
        totalDeposits: privateSide.reduce((a, b) => a + b.depositCount, 0),
        balances: privateSide,
      },
      links: {
        userOnSolscan: explorer('account', this.keypair.publicKey.toBase58()),
        poolOnSolscan: explorer('account', this.programIds.b402Pool.toString()),
      },
    };
  }

  async balance(opts: { mint?: PublicKey; refresh?: boolean } = {}): Promise<{
    balances: Array<{ mint: string; amount: string; depositCount: number }>;
  }> {
    await this.ready();
    if (opts.refresh === true) await this._notes!.backfill({ limit: 30 });
    const filterFr = opts.mint ? leToFrReduced(opts.mint.toBytes()) : null;
    const agg = new Map<bigint, { amount: bigint; count: number }>();
    const notes = filterFr != null
      ? this._notes!.getSpendable(filterFr)
      : this._notes!.getAllSpendable();
    for (const n of notes) {
      const cur = agg.get(n.tokenMint) ?? { amount: 0n, count: 0 };
      cur.amount += n.value;
      cur.count += 1;
      agg.set(n.tokenMint, cur);
    }
    return {
      balances: Array.from(agg.entries()).map(([fr, v]) => ({
        mint: mintLabel(fr, opts.mint ?? this.resolveMint(fr)),
        amount: v.amount.toString(),
        depositCount: v.count,
      })),
    };
  }

  /**
   * Poll for newly-arrived private deposits since a cursor. The cursor is
   * an opaque token returned by previous calls — pass it back unchanged on
   * each iteration. Omit it (or pass `undefined`) on the first call to read
   * everything from the start.
   *
   * The SDK's live note subscription pushes new arrivals into the in-memory
   * store as they land on-chain, so polling every few seconds gives an
   * agent a near-real-time stream of incoming deposits without running a
   * subscription protocol.
   *
   * Output is JSON-friendly with no ZK plumbing exposed.
   */
  async watchIncoming(opts: {
    cursor?: string;
    mint?: PublicKey;
    refresh?: boolean;
  } = {}): Promise<{
    incoming: Array<{ id: string; mint: string; amount: string; receivedAt: number }>;
    cursor: string;
  }> {
    await this.ready();
    if (opts.refresh === true) await this._notes!.backfill({ limit: 30 });
    const since = decodeCursor(opts.cursor);
    const filterFr = opts.mint ? leToFrReduced(opts.mint.toBytes()) : undefined;
    const fresh = this._notes!.getSpendableSince(since, filterFr);
    let max = since;
    for (const n of fresh) if (n.leafIndex > max) max = n.leafIndex;
    const now = Date.now();
    return {
      incoming: fresh.map((n) => ({
        id: noteId(n.commitment),
        mint: mintLabel(n.tokenMint, opts.mint ?? this.resolveMint(n.tokenMint)),
        amount: n.value.toString(),
        receivedAt: now,
      })),
      cursor: encodeCursor(max),
    };
  }

  /**
   * Quote a swap via Jupiter Lite API (`https://lite-api.jup.ag/swap/v1`).
   * Public, no auth. Useful for an agent to predict the OUT amount + slippage
   * before committing to a `privateSwap` call.
   *
   * The quote is an off-chain estimate; actual on-chain execution may differ
   * by up to `slippageBps`. Mainnet routes only — Jupiter does not index
   * devnet liquidity.
   */
  async quoteSwap(opts: {
    inMint: PublicKey;
    outMint: PublicKey;
    amount: bigint;
    slippageBps?: number;
  }): Promise<{
    inMint: string;
    outMint: string;
    inAmount: string;
    outAmount: string;
    otherAmountThreshold: string;
    slippageBps: number;
    priceImpactPct: string;
    routeHops: number;
    contextSlot?: number;
  }> {
    const slippageBps = opts.slippageBps ?? 50;
    const url = new URL('https://lite-api.jup.ag/swap/v1/quote');
    url.searchParams.set('inputMint', opts.inMint.toBase58());
    url.searchParams.set('outputMint', opts.outMint.toBase58());
    url.searchParams.set('amount', opts.amount.toString());
    url.searchParams.set('slippageBps', String(slippageBps));

    const resp = await fetch(url, { headers: { accept: 'application/json' } });
    if (!resp.ok) {
      throw new B402Error(
        B402ErrorCode.InvalidConfig,
        `Jupiter quote failed: ${resp.status} ${resp.statusText}`,
      );
    }
    const q = (await resp.json()) as {
      inputMint: string;
      outputMint: string;
      inAmount: string;
      outAmount: string;
      otherAmountThreshold: string;
      slippageBps: number;
      priceImpactPct: string;
      routePlan: unknown[];
      contextSlot?: number;
    };
    return {
      inMint: q.inputMint,
      outMint: q.outputMint,
      inAmount: q.inAmount,
      outAmount: q.outAmount,
      otherAmountThreshold: q.otherAmountThreshold,
      slippageBps: q.slippageBps,
      priceImpactPct: q.priceImpactPct,
      routeHops: Array.isArray(q.routePlan) ? q.routePlan.length : 0,
      contextSlot: q.contextSlot,
    };
  }

  /**
   * @internal Re-sync from on-chain history. Most agents should use
   * `balance({ refresh: true })` or `holdings({ refresh: true })` instead;
   * this is exposed for advanced cases that want explicit cursor control.
   */
  async refresh(opts: { limit?: number; before?: string } = {}): Promise<{
    txsScanned: number;
    eventsSeen: number;
    depositsIngested: number;
  }> {
    await this.ready();
    const r = await this._notes!.backfill({ limit: opts.limit ?? 100, before: opts.before });
    return {
      txsScanned: r.txsScanned,
      eventsSeen: r.eventsSeen,
      depositsIngested: r.notesIngested,
    };
  }
}

/** Opaque public ID for a private deposit. First 16 hex chars of the
 *  commitment — stable across calls, doesn't reveal anything spendable. */
function noteId(commitment: bigint): string {
  return commitment.toString(16).padStart(64, '0').slice(0, 16);
}

/** Encode an internal cursor (currently a leaf index) into an opaque base64url
 *  token. Versioned so the encoding can change without breaking clients. */
function encodeCursor(leafIndex: bigint): string {
  const payload = JSON.stringify({ v: 1, l: leafIndex.toString() });
  return Buffer.from(payload, 'utf8').toString('base64url');
}

/** Decode an opaque cursor token back into an internal leaf index. Treats
 *  missing/malformed cursors as "from the beginning". */
function decodeCursor(cursor: string | undefined): bigint {
  if (!cursor) return -1n;
  try {
    const obj = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { v?: number; l?: string };
    if (obj.v !== 1 || typeof obj.l !== 'string') return -1n;
    return BigInt(obj.l);
  } catch {
    return -1n;
  }
}

/** Resolve a Fr-reduced mint value to a human-readable label. If the caller
 *  knows the mint pubkey (passed via opts.mint), return its base58. Otherwise
 *  emit a stable opaque short label so the agent has SOMETHING to use as a key
 *  across calls. */
function mintLabel(tokenMintFr: bigint, knownMint: PublicKey | undefined): string {
  if (knownMint) return knownMint.toBase58();
  const hex = tokenMintFr.toString(16).padStart(64, '0').slice(0, 12);
  return `unknown:${hex}`;
}

function defaultRpc(cluster: B402SolanaConfig['cluster']): string {
  switch (cluster) {
    case 'mainnet': return 'https://api.mainnet-beta.solana.com';
    case 'devnet':  return clusterApiUrl('devnet');
    case 'localnet': return 'http://127.0.0.1:8899';
  }
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

/** Domain-tag UTF-8 → big-endian-as-int → mod p (matches packages/crypto). */
function domainTagFr(tag: string): bigint {
  let acc = 0n;
  for (let i = 0; i < tag.length; i++) acc = (acc << 8n) | BigInt(tag.charCodeAt(i));
  return acc % FR_MODULUS;
}

/** SPL Token-account amount lives at bytes [64..72] little-endian u64. */
function readSplAmount(data: Buffer | Uint8Array): bigint {
  const buf = data instanceof Buffer ? data : Buffer.from(data);
  return buf.readBigUInt64LE(64);
}

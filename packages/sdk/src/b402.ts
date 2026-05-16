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
import { tokenProgramOf } from './programs/token-program.js';
import { keccak_256 } from '@noble/hashes/sha3';
// Browser-safe randomBytes. crypto.getRandomValues is in WebCrypto (browser
// AND Node 18+ via globalThis.crypto), so we don't need node:crypto here.
function nodeRandomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  // globalThis.crypto exists in browsers, workers, and Node 18+.
  (globalThis.crypto as Crypto).getRandomValues(out);
  return out;
}

/**
 * Poll for tx confirmation via getSignatureStatuses. Avoids the
 * signatureSubscribe WebSocket that confirmTransaction opens, which
 * keeps the Node event loop alive past the user's last `await` and
 * makes short scripts hang on exit.
 */
async function pollConfirm(
  conn: Connection,
  sig: string,
  timeoutMs: number,
): Promise<void> {
  const start = Date.now();
  let interval = 1500;
  while (Date.now() - start < timeoutMs) {
    const r = await conn.getSignatureStatuses([sig], { searchTransactionHistory: false });
    const s = r.value[0];
    if (s?.confirmationStatus === 'confirmed' || s?.confirmationStatus === 'finalized') {
      if (s.err) throw new Error(`tx ${sig} landed with err ${JSON.stringify(s.err)}`);
      return;
    }
    await new Promise((res) => setTimeout(res, interval));
    interval = Math.min(interval * 1.2, 4000);
  }
  throw new Error(`tx ${sig} not confirmed within ${timeoutMs}ms`);
}
import { FR_MODULUS, PROGRAM_IDS, B402_ALT_DEVNET, B402_ALT_MAINNET, leToFrReduced } from '@b402ai/solana-shared';
import type { SpendableNote } from '@b402ai/solana-shared';
import {
  AdaptProver,
  TransactProver,
  type AdaptWitness,
  type ProverArtifacts,
} from '@b402ai/solana-prover';

import { buildWallet, type Wallet } from './wallet.js';
import { KeypairSigner, type B402Signer } from './signer.js';
import { derivePendingInputsPda } from './commit-inputs.js';
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
import * as nodeOs from 'os';
import * as nodePath from 'path';
import {
  B402_NULLIFIER_PROGRAM_ID,
  buildCreateNullifierIx,
  buildNullifierCpiAccounts,
  buildNullifierCpiPayload,
  deriveNullifierAddress,
  getValidityProofForNullifier,
} from './light-nullifier.js';

const SYSVAR_INSTRUCTIONS = new PublicKey('Sysvar1nstructions1111111111111111111111111');

export interface B402SolanaConfig {
  cluster: 'mainnet' | 'devnet' | 'localnet';
  /** Solana keypair owning the seed (legacy path: Node, MCP, tests). The
   *  SDK wraps it as a KeypairSigner internally. Pass this OR `signer`,
   *  not both. */
  keypair?: Keypair;
  /** B402Signer abstraction (browser path with WalletAdapterSigner, or any
   *  custom impl). When passed, on-chain signing routes through
   *  `signer.signTransaction` and the wallet seed comes from
   *  `signer.getSeed()`. Pass this OR `keypair`, not both. */
  signer?: B402Signer;
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
  /** Pluggable note persistence for consumers that don't want filesystem
   *  (bots → Postgres, browsers → IndexedDB, etc.). Mutually exclusive
   *  with `notesPersistDir`; if both are set, this wins. The SDK
   *  round-trips one opaque JSON string per viewing-pub; storage is
   *  fully under your control. Async save errors are caught + logged,
   *  in-memory state is never rolled back. */
  notesPersistence?: {
    load: () => Promise<string | null>;
    save: (data: string) => Promise<void>;
  };
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
  /** PRD-35 per-call switch for the 2-tx commit-then-verify flow.
   *  When true:
   *    1. SDK builds + submits a `pool::commit_inputs` tx that writes the
   *       Phase 9 24×32 B public inputs into a per-user PDA.
   *    2. SDK then submits the `pool::adapt_execute` tx which references
   *       the PDA; the verifier reads inputs from acct.data instead of
   *       carrying them inline.
   *  Saves ~700-735 B on the adapt_execute tx — lifts the v0-tx 1232 B
   *  ceiling that today blocks per-user adapters at scale.
   *  Pool MUST be built with `--features prd_35_pending_inputs` for this
   *  to work (default off in current mainnet pool). */
  pendingInputsMode?: boolean;
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
  /** Active signer abstraction. Always present; KeypairSigner under the
   *  legacy `keypair` config, WalletAdapterSigner (or other) under
   *  `signer` config. */
  readonly signer: B402Signer;
  /** Legacy back-compat accessor. Returns the underlying Solana Keypair
   *  ONLY when the SDK was constructed with `keypair: Keypair` (i.e. the
   *  KeypairSigner path). Returns null for any other Signer impl
   *  (browser, hardware-wallet, custom relayer-backed). */
  readonly keypair: Keypair | null;
  /** Local relayer Keypair. Null only when constructed with a non-Keypair
   *  signer (browser) AND no `relayer` was passed AND no `relayerHttpUrl`
   *  is configured — i.e. read-only mode. Tx-submitting methods guard
   *  this with a clear error. */
  readonly relayer: Keypair | null;
  readonly notesPersistDir: string | undefined;
  readonly notesPersistence: B402SolanaConfig['notesPersistence'] | undefined;
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

  /** Per-leafIndex cache of spent-check results. Short TTL so rapid
   *  re-renders (Wallet → Buy picker → Sell picker within seconds) don't
   *  hammer Photon, while still catching spends that happen between
   *  views. Keyed by leafIndex decimal string (leafIndex is bigint). */
  private _spentCache: Map<string, { spent: boolean; at: number }> = new Map();
  /** Lazily-created Photon (stateless.js) RPC client used by
   *  `_filterUnspent`. Reuses `this.connection.rpcEndpoint` — Helius and
   *  other Photon-compat providers co-locate the indexer on the same URL. */
  private _photonRpc: unknown | null = null;

  constructor(config: B402SolanaConfig) {
    this.cluster = config.cluster;
    const rpcUrl = config.rpcUrl ?? defaultRpc(config.cluster);
    this.connection = new Connection(rpcUrl, 'confirmed');
    this.programIds = { ...PROGRAM_IDS, ...(config.programIds ?? {}) };

    if (config.keypair && config.signer) {
      throw new Error(
        'B402Solana: pass `keypair` OR `signer`, not both. Use `signer: new KeypairSigner(kp)` to be explicit, or stick with the legacy `keypair` field.',
      );
    }
    if (!config.keypair && !config.signer) {
      throw new Error(
        'B402Solana: must pass either `keypair: Keypair` (Node/MCP) or `signer: B402Signer` (browser, see WalletAdapterSigner.fromAdapter).',
      );
    }
    if (config.signer) {
      this.signer = config.signer;
      // Preserve back-compat accessor: only Keypair-backed signers expose
      // the underlying Keypair via `b402.keypair`. Browser-derived signers
      // by design do NOT have one.
      this.keypair = config.signer instanceof KeypairSigner
        ? (config.signer as KeypairSigner).keypair
        : null;
    } else {
      // config.keypair is set per the check above.
      this.keypair = config.keypair!;
      this.signer = new KeypairSigner(config.keypair!);
    }
    // Relayer is the on-chain fee payer for shield/unshield self-submit
    // paths AND the local commit_inputs tx in PRD-35's pendingInputsMode.
    // When the user is a Keypair we default to them; otherwise the caller
    // configures `relayer` explicitly (Node) or `relayerHttpUrl` (browser
    // — hosted relayer pays fees, no local Keypair needed). Construction
    // tolerates an absent relayer so a read-only SDK (status, holdings,
    // balance — operations that don't submit txs) works in browsers
    // without a relayer keypair. Methods that submit txs check
    // `this.relayer != null` and throw with a clear error pointing to
    // the missing config.
    this.relayer = config.relayer ?? this.keypair ?? null;
    // Default note-store persistence to ~/.b402ai/notes/<cluster>/ so the
    // backfill cursor survives across runs — turning the typical refresh
    // call from O(30 RPC calls) into O(1). Pass `notesPersistDir: ''` to
    // disable (e.g. ephemeral CI). Skipped in non-Node envs where `os` is
    // unavailable.
    // Pluggable persistence wins over filesystem if both are set — bots
    // that wire Postgres don't want a stray ~/.b402ai/notes file mirror.
    this.notesPersistence = config.notesPersistence;
    if (config.notesPersistence) {
      this.notesPersistDir = undefined;
    } else if (config.notesPersistDir !== undefined) {
      this.notesPersistDir = config.notesPersistDir || undefined;
    } else {
      try {
        this.notesPersistDir = nodePath.join(nodeOs.homedir(), '.b402ai', 'notes', config.cluster);
      } catch {
        this.notesPersistDir = undefined;
      }
    }
    // Cluster-aware defaults so app devs don't have to configure a
    // relayer to do their first private op. Override via config or pass
    // empty string to disable. Public-tier API key (5 req/min) ships
    // baked in — same key the MCP server defaults to.
    const clusterDefaultRelayerUrl: Record<typeof config.cluster, string | undefined> = {
      mainnet: 'https://b402-solana-relayer-mainnet-62092339396.us-central1.run.app',
      devnet:  'https://b402-solana-relayer-devnet-62092339396.us-central1.run.app',
      localnet: undefined,
    };
    const clusterDefaultApiKey: Record<typeof config.cluster, string | undefined> = {
      mainnet: 'kp_53d31f4d4b758ea2',
      devnet:  'kp_8a28d0e86074cde3',
      localnet: undefined,
    };
    this.relayerHttpUrl = config.relayerHttpUrl === '' ? undefined
      : (config.relayerHttpUrl ?? clusterDefaultRelayerUrl[config.cluster]);
    this.relayerApiKey = config.relayerApiKey === '' ? undefined
      : (config.relayerApiKey ?? clusterDefaultApiKey[config.cluster]);
    // Phase 7B mainnet pool requires inline-CPI mode; default ON for
    // mainnet/devnet so the first call works, override only for local
    // bench-style configurations.
    this.inlineCpiNullifier = config.inlineCpiNullifier ?? (config.cluster !== 'localnet');
    // Indexer is opt-in. When set, the SDK uses /v1/proof to support
    // spend-any-leaf; on indexer error it logs and falls back to the
    // rightmost-only proveMostRecentLeaf so a transient outage doesn't
    // brick all spend flows.
    // NOTE: must be a STATIC import (top of file). The package is
    // `"type": "module"` so `require` is undefined at runtime — using it
    // here was the 0.0.13 bug that broke MCP startup on every tool call.
    // Default indexer URL by cluster — gives `proveMostRecentLeaf`
    // fallback the indexer-backed real-Merkle-path resolver, so older
    // (non-rightmost) notes are spendable. Override with empty string.
    const clusterDefaultIndexerUrl: Record<typeof config.cluster, string | undefined> = {
      mainnet: 'https://b402-solana-indexer-api-62092339396.us-central1.run.app',
      devnet: undefined, // no devnet indexer deployed yet
      localnet: undefined,
    };
    const indexerUrl = config.indexerUrl === '' ? undefined
      : (config.indexerUrl ?? clusterDefaultIndexerUrl[config.cluster]);
    this.indexer = indexerUrl
      ? new B402Indexer({
          url: indexerUrl,
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

  /**
   * Lazily resolve circuit artifacts. Called by methods that actually need
   * a prover (shield, privateSwap). Read-only methods (balance, holdings)
   * don't trigger the fetch — and unit tests that just exercise wallet
   * setup never hit the network.
   */
  private async _ensureProvers(): Promise<void> {
    if (this._prover && this._adaptProver) return;
    const { resolveAllCircuits } = await import('./circuits.js');
    const c = await resolveAllCircuits();
    if (!this._prover) this._prover = new TransactProver(c.transact);
    if (!this._adaptProver) this._adaptProver = new AdaptProver(c.adapt);
  }

  /** Lazy-init wallet + note store. Idempotent. */
  async ready(): Promise<void> {
    if (!this._wallet) {
      // Deterministic b402 wallet seeded from the active signer. For
      // KeypairSigner this is `keypair.secretKey[0..32]` (preserves
      // pre-0.0.18 derivation). For WalletAdapterSigner this is
      // sha256(adapter.signMessage(canonicalMsg))[0..32] — see signer.ts.
      this._wallet = await buildWallet(this.signer.getSeed());
    }
    if (!this._notes) {
      this._notes = new NoteStore({
        connection: this.connection,
        poolProgramId: new PublicKey(this.programIds.b402Pool),
        wallet: this._wallet,
        ...(this.indexer ? { indexer: this.indexer } : {}),
        ...(this.notesPersistence
          ? { persist: { load: this.notesPersistence.load, save: this.notesPersistence.save } }
          : this.notesPersistDir
            ? { persist: { dir: this.notesPersistDir } }
            : {}),
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
    const owner = this.signer.publicKey;
    // Enumerate ATAs across BOTH classic SPL and Token-2022. Without the
    // Token-2022 query, pump.fun token balances stay invisible to the
    // walletBalance() caller.
    const { TOKEN_2022_PROGRAM_ID } = await import('@solana/spl-token');
    const [lamports, classicTokens, tk2022Tokens] = await Promise.all([
      this.connection.getBalance(owner, 'confirmed'),
      this.connection.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_PROGRAM_ID }, 'confirmed'),
      this.connection.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_2022_PROGRAM_ID }, 'confirmed'),
    ]);
    const flatten = (rs: typeof classicTokens) => rs.value.map(({ pubkey, account }) => {
      const info = (account.data as { parsed?: { info?: { mint?: string; tokenAmount?: { amount?: string; decimals?: number } } } }).parsed?.info ?? {};
      return {
        mint: info.mint ?? '',
        amount: info.tokenAmount?.amount ?? '0',
        decimals: info.tokenAmount?.decimals ?? 0,
        tokenAccount: pubkey.toBase58(),
      };
    });
    const tokens = [...flatten(classicTokens), ...flatten(tk2022Tokens)]
      .filter((t) => t.mint && t.amount !== '0');
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
    //    Query BOTH classic SPL and Token-2022 ATAs so pump.fun / Token-2022
    //    mints land in the registry the same way classic mints do.
    try {
      const { TOKEN_2022_PROGRAM_ID } = await import('@solana/spl-token');
      const [classic, tk2022] = await Promise.all([
        this.connection.getTokenAccountsByOwner(
          this.signer.publicKey,
          { programId: TOKEN_PROGRAM_ID },
        ),
        this.connection.getTokenAccountsByOwner(
          this.signer.publicKey,
          { programId: TOKEN_2022_PROGRAM_ID },
        ),
      ]);
      for (const acc of [...classic.value, ...tk2022.value]) {
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
    await this._ensureProvers();
    if (!this._prover) {
      throw new B402Error(
        B402ErrorCode.InvalidConfig,
        'prover not initialised — pass `prover` or `proverArtifacts` to the constructor',
      );
    }

    // Detect Token-2022 vs classic SPL once; ATAs differ between the two
    // (different program seeds), so passing the wrong token program ID here
    // hands back a non-existent address.
    const mintTokenProgram = await tokenProgramOf(this.connection, req.mint);
    const depositorAta = await getAssociatedTokenAddress(
      req.mint,
      this.signer.publicKey,
      false,
      mintTokenProgram,
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
      depositor: this.signer,
      relayer: this._requireRelayer('shield'),
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

    // Wait until the indexer reflects this shield. Otherwise a follow-up
    // swap/lend that does `proveLeaf` for the new commitment hits a
    // 404 and falls through to proveMostRecentLeaf — which then fails
    // because on-chain TreeState may not have advanced through the user's
    // RPC yet either. Bounded poll so a slow indexer doesn't hang the
    // shield call indefinitely.
    if (this.indexer) {
      const target = BigInt(result.note.leafIndex);
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        try {
          const s = await this.indexer.state();
          if (BigInt(s.leafCount) > target) break;
        } catch {
          // ignore — try again
        }
        await new Promise((r) => setTimeout(r, 1500));
      }
    }
    return result;
  }

  /**
   * Unshield to a recipient. By default spends the most-recently-shielded
   * note from this client instance. Pass `note` + `mint` explicitly to spend
   * any other note (e.g. from a persisted client tree).
   */
  async unshield(req: UnshieldRequest): Promise<UnshieldResult> {
    await this.ready();
    await this._ensureProvers();
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

    // Token-2022 ATAs are derived using the Token-2022 program in the
    // PDA seeds — passing TOKEN_PROGRAM_ID for a Token-2022 mint hands back
    // a non-existent address.
    const mintTokenProgram = await tokenProgramOf(this.connection, mint);
    const recipientAta =
      req.recipientAta ?? (await getAssociatedTokenAddress(
        mint,
        req.to,
        false,
        mintTokenProgram,
      ));

    // Ensure the recipient ATA exists — pool's unshield enforces it must be
    // initialized before the transfer. Idempotent: skips if already there.
    const ataInfo = await this.connection.getAccountInfo(recipientAta);
    if (!ataInfo) {
      const relayer = this._requireRelayer('unshield: ATA initialization');
      const ix = createAssociatedTokenAccountInstruction(
        relayer.publicKey,
        recipientAta,
        req.to,
        mint,
        mintTokenProgram,
      );
      await sendAndConfirmTransaction(
        this.connection,
        new Transaction().add(ix),
        [relayer],
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
      relayer: this._requireRelayer('unshield'),
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
    await this._ensureProvers();
    // Relayer pubkey bound into the ix's account[0] + relayer_fee_recipient
    // placeholder + feeAtaSentinel derivation. When the HTTP relayer is in
    // use, we use ITS pubkey so on-chain accounts match the actual fee payer.
    const relayerPubkey = this._relayerHttp?.client.pubkey
      ?? this._requireRelayer('privateSwap').publicKey;
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
      let candidates = this._notes!.getSpendable(inMintFr);
      if (candidates.length === 0) {
        throw new B402Error(
          B402ErrorCode.NoSpendableNotes,
          `no private deposit in mint ${req.inMint.toBase58().slice(0, 8)}…`,
        );
      }
      // Cross-check the value-matching candidates against the indexer's
      // spent set. Local `markSpent` only fires after a SDK-orchestrated tx
      // confirms; notes spent in a prior session (or by a different SDK
      // instance with the same viewing key) look spendable locally but the
      // nullifier is already on chain. We probe ONLY notes whose value
      // matches `req.amount` (those are the actual candidates the picker
      // below will choose from), in newest-first order, and stop as soon
      // as we find an unspent one — keeps it to ~1 HTTP call in the happy
      // path.
      if (this.indexer) {
        const matchValue = candidates
          .filter((n) => n.value === req.amount)
          .sort((a, b) => Number(BigInt(b.leafIndex) - BigInt(a.leafIndex)));
        for (const n of matchValue) {
          try {
            const nh = await nullifierHash(this._wallet!.spendingPriv, n.leafIndex);
            if (await this.indexer.isSpent(nh)) {
              this._notes!.markSpent(n.commitment);
              continue;
            }
            note = n;
            break;
          } catch {
            // Indexer transient failure: fall through, picker below decides.
            break;
          }
        }
      }
      // Fall-through picker (no indexer, or indexer probe didn't pick).
      // Exact-value match required. Among matches, pick the rightmost leaf
      // (highest leafIndex) — `proveMostRecentLeaf` only validates for the
      // rightmost; older leaves with newer leaves to their right strand
      // until we ship the indexer-backed real-Merkle-path resolver.
      if (!note) {
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

    // PRD-35 §5.4 — 2-tx commit-then-verify orchestration. When the
    // caller opts into pendingInputsMode, we land a `pool::commit_inputs`
    // tx FIRST that writes the 24×32 B public inputs into a per-user
    // PDA. The follow-up adapt_execute then carries only the proof
    // inline; the verifier reads inputs from the PDA. Saves ~700-735 B
    // on the heavyweight tx, lifting the v0-tx 1232 B ceiling that
    // today blocks per-user adapters at scale.
    if (req.pendingInputsMode) {
      const { buildCommitInputsIx, derivePendingInputsPda } = await import('./commit-inputs.js');
      const spendingPubLe = bigintToLe32(this._wallet!.spendingPub);
      const inputs = proof.publicInputsLeBytes.map((b) => new Uint8Array(b));

      // Idempotency: if a prior attempt already wrote the same inputs to
      // the per-user pending_inputs PDA, skip submitting a fresh commit
      // tx. Saves ~$0.0009 + the round-trip latency, and avoids a redundant
      // tx racing the previous one through Helius (where ws confirms can
      // lag the chain by 30+ s under load).
      // PDA layout: 8 (anchor disc) + 1 (version) + 32 × N (inputs) + ...
      const [pendingPda] = derivePendingInputsPda(
        new PublicKey(this.programIds.b402Pool),
        spendingPubLe,
      );
      const existing = await this.connection.getAccountInfo(pendingPda, 'confirmed');
      const expectedBytes = new Uint8Array(inputs.length * 32);
      for (let i = 0; i < inputs.length; i++) expectedBytes.set(inputs[i], i * 32);
      const PENDING_INPUTS_HEADER = 8 + 1; // disc + version byte
      const alreadyCommitted =
        existing &&
        existing.data.length >= PENDING_INPUTS_HEADER + expectedBytes.length &&
        existing.data[8] === 1 && // version flag — pool sets to 1 on commit
        Buffer.from(existing.data).subarray(
          PENDING_INPUTS_HEADER,
          PENDING_INPUTS_HEADER + expectedBytes.length,
        ).equals(Buffer.from(expectedBytes));

      if (alreadyCommitted) {
        // Skip the commit tx entirely; adapt_execute_v2 below reads the
        // PDA we already wrote.
      } else {
      const commitIx = buildCommitInputsIx({
        poolProgramId: new PublicKey(this.programIds.b402Pool),
        spendingPubLe,
        inputs,
        relayer: relayerPubkey,
      });
      // Two paths:
      //   - HTTP relayer wired → submit via /relay/pool-ix (relayer signs
      //     + pays gas, user wallet stays off-chain). This is the privacy
      //     path; needs relayer ≥ v0.0.3 (POST /relay/pool-ix endpoint).
      //   - No HTTP relayer → self-submit with local relayer keypair.
      //     Caller's wallet pays gas; only useful for dev / e2e.
      if (this._relayerHttp) {
        await this._relayerHttp.client.submit({
          label: 'pool-ix',
          ix: commitIx,
          altAddresses: [],
          computeUnitLimit: 200_000,
        });
      } else {
        // Self-submit fallback. Local relayer pays.
        const commitBh = await this.connection.getLatestBlockhash('confirmed');
        const commitMsg = new TransactionMessage({
          payerKey: relayerPubkey,
          recentBlockhash: commitBh.blockhash,
          instructions: [commitIx],
        }).compileToV0Message();
        const commitVtx = new VersionedTransaction(commitMsg);
        commitVtx.sign([this._requireRelayer('privateSwap (commit_inputs tx 1)')]);
        const csig = await this.connection.sendRawTransaction(commitVtx.serialize(), {
          skipPreflight: false,
          preflightCommitment: 'confirmed',
        });
        // Poll-based — see comment in actions/shield.ts on why we avoid
        // confirmTransaction's WebSocket subscription.
        await pollConfirm(this.connection, csig, 90_000);
      }
      } // end else (alreadyCommitted check)
    }

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
    // Detect IN and OUT mint token programs independently. Pool's
    // AdaptExecute now carries both `token_program` (IN-side) and
    // `token_program_out` (OUT-side), so cross-program swaps work end-to-end
    // (pump.fun Token-2022 ↔ classic SPL wSOL, USDC, etc.). For same-program
    // swaps, both slots resolve to the same program — no behavioral change.
    const inMintTokenProgram = await tokenProgramOf(this.connection, req.inMint);
    const outMintTokenProgram = await tokenProgramOf(this.connection, req.outMint);
    const feeAtaSentinel = await getAssociatedTokenAddress(
      req.inMint,
      relayerPubkey,
      false,
      inMintTokenProgram,
    );

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
    // PRD-35.9 — when pendingInputsMode is on, dispatch to
    // `adapt_execute_v2` which DROPS the entire AdaptPublicInputs
    // sub-struct (~320 B savings) — pool reads pi from the per-user
    // pending_inputs PDA instead. The rest of the args is identical to
    // v1 minus the public_inputs block.
    const poolIxParts: Uint8Array[] = req.pendingInputsMode
      ? [
          instructionDiscriminator('adapt_execute_v2'),
          vecU8(proof.proofBytes),
          // No public_inputs — read from PDA in pool::handler_v2.
          u32Le(0), // encrypted_notes vec len = 0
          new Uint8Array([0b10]), // in_dummy_mask
          new Uint8Array([0b10]), // out_dummy_mask
          relayerPubkey.toBytes(),
          vecU8(adapterIxData),
          vecU8(actionPayload),
        ]
      : [
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
          // (--features phase_9_dual_note) DOES consume it.
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
      // `mint_in` slot added in the Token-2022 migration — required by the
      // pool's new `transfer_checked` CPI on the in_vault → adapter_in_ta
      // and in_vault → relayer_fee_ta transfers. Slot order matches pool's
      // `AdaptExecute<'info>` after `out_vault`, before `tree_state`.
      { pubkey: req.inMint, isSigner: false, isWritable: false },
      // `mint_out` slot — pool forwards this to the adapter so the OUT-side
      // transfer (adapter_out_ta → out_vault) can use `transfer_checked`
      // with the correct decimals. Slot order matches pool's
      // `AdaptExecute<'info>` immediately after `mint_in`.
      { pubkey: req.outMint, isSigner: false, isWritable: false },
      { pubkey: treeStatePda(poolProgramId), isSigner: false, isWritable: true },
      { pubkey: new PublicKey(this.programIds.b402VerifierAdapt), isSigner: false, isWritable: false },
      { pubkey: adapterProgramId, isSigner: false, isWritable: false },
      // adapter_authority MUST be writable: per-user adapters (Kamino's
      // per_user_obligation build) use it as Kamino's `obligationOwner` /
      // feePayer for init_user_metadata + init_obligation, which Anchor
      // role-3 requires writable. Privilege can't escalate inside a CPI,
      // so the outer slot has to start writable. Read-only is safe for
      // adapters that don't init Kamino accounts (Jupiter, mock), but
      // we standardise on writable here so per-user adapters work.
      { pubkey: adapterAuthority, isSigner: false, isWritable: true },
      { pubkey: req.adapterInTa, isSigner: false, isWritable: true },
      { pubkey: req.adapterOutTa, isSigner: false, isWritable: true },
      { pubkey: feeAtaSentinel, isSigner: false, isWritable: true },
      { pubkey: SYSVAR_INSTRUCTIONS, isSigner: false, isWritable: false },
      // PRD-35 — pending_inputs PDA, only when mode is enabled.
      // Pool's AdaptExecute Anchor account list places `pending_inputs`
      // BETWEEN instructions_sysvar and token_program when the
      // prd_35_pending_inputs feature is on. SDK must match that order.
      ...(req.pendingInputsMode
        ? [{
            pubkey: derivePendingInputsPda(
              new PublicKey(this.programIds.b402Pool),
              bigintToLe32(this._wallet!.spendingPub),
            )[0],
            isSigner: false,
            isWritable: true,
          }]
        : []),
      // Pool's `token_program` slot is `Interface<TokenInterface>` —
      // must reflect the program that owns `in_vault` (i.e. the IN mint's
      // owner program). Pool uses it for the in_vault → adapter_in_ta
      // transfer_checked CPI.
      { pubkey: inMintTokenProgram, isSigner: false, isWritable: false },
      // `token_program_out` slot — addresses the OUT vault's owning program.
      // Pool forwards this to the adapter so adapter_out_ta → out_vault uses
      // the correct token program when IN and OUT live on different programs
      // (Token-2022 pump.fun mint → classic SPL wSOL, or vice versa). For
      // same-program swaps this equals `inMintTokenProgram`.
      { pubkey: outMintTokenProgram, isSigner: false, isWritable: false },
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
      // Self-submit path. Need a local relayer keypair; throws clearly
      // if the SDK was constructed without one.
      const localRelayer = this._requireRelayer('privateSwap (self-submit path)');
      // Single getLatestBlockhash — pair the blockhash with its
      // lastValidBlockHeight from the same response for confirmTransaction.
      const bh = await this.connection.getLatestBlockhash('confirmed');
      const localIxs: TransactionInstruction[] = [cuIx, poolIx];
      if (nullifierIx) localIxs.push(nullifierIx);
      const msg = new TransactionMessage({
        payerKey: localRelayer.publicKey,
        recentBlockhash: bh.blockhash,
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
      vtx.sign([localRelayer]);

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
      await pollConfirm(this.connection, signature, 90_000);
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

  /**
   * Atomic private swap with auto-routing. Burns a shielded note in
   * `inMint`, routes through Jupiter (Phoenix-direct on mainnet), and
   * reshields the proceeds into a new note in `outMint`. Hosted relayer
   * pays gas — caller wallet stays off-chain.
   *
   * Minimal call shape:
   * ```
   * const r = await b402.swap({ inMint: USDC, outMint: SOL, amount: 1_000_000n });
   * ```
   *
   * On mainnet this fetches a Jupiter quote, builds the adapter ix data
   * + remaining_accounts from the quote, and calls `privateSwap` under
   * the hood. On devnet falls through to the constant-rate mock adapter.
   *
   * Note value constraint: caller must hold a shielded note in `inMint`
   * with value EXACTLY equal to `amount`. The SDK selects it
   * automatically (most-recent leaf wins on ties).
   */
  async swap(req: {
    inMint: PublicKey;
    outMint: PublicKey;
    amount: bigint;
    /** Slippage tolerance in basis points. Default 30 (0.3%). */
    slippageBps?: number;
    /** Override expected OUT amount. Default: derived from Jupiter quote
     *  with `slippageBps` applied as the floor. */
    expectedOut?: bigint;
    /** DEX allowlist for Jupiter routing. Default Phoenix (smallest
     *  account count, fits the 1232 B tx cap reliably). */
    dexes?: string;
  }): Promise<PrivateSwapResult> {
    await this.ready();

    const { fetchJupiterRoute } = await import('./jupiter-route.js');
    const { B402_ALT_MAINNET, B402_ALT_DEVNET } = await import('@b402ai/solana-shared');
    const { getAssociatedTokenAddress } = await import('@solana/spl-token');
    const { createRpc } = await import('@lightprotocol/stateless.js');

    const adapterProgramId = new PublicKey(
      this.cluster === 'mainnet'
        ? this.programIds.b402JupiterAdapter
        : this.programIds.b402MockAdapter,
    );
    const adapterAuthority = PublicKey.findProgramAddressSync(
      [new TextEncoder().encode('b402/v1'), new TextEncoder().encode('adapter')],
      adapterProgramId,
    )[0];
    // ATA seeds differ between classic SPL Token and Token-2022. Pass the
    // owning program for each mint so adapter scratch ATAs resolve to the
    // address the adapter program will create / re-use.
    const inMintTokenProgram = await tokenProgramOf(this.connection, req.inMint);
    const outMintTokenProgram = await tokenProgramOf(this.connection, req.outMint);
    const adapterInTa = await getAssociatedTokenAddress(
      req.inMint, adapterAuthority, true, inMintTokenProgram,
    );
    const adapterOutTa = await getAssociatedTokenAddress(
      req.outMint, adapterAuthority, true, outMintTokenProgram,
    );

    const altStr =
      this.cluster === 'mainnet' ? B402_ALT_MAINNET :
      this.cluster === 'devnet' ? B402_ALT_DEVNET : '';
    if (!altStr) {
      throw new Error(`b402.swap: no canonical Address Lookup Table for cluster ${this.cluster}. Use the lower-level privateSwap() and pass alt explicitly.`);
    }
    const alt = new PublicKey(altStr);

    const photonRpc = createRpc(this.connection.rpcEndpoint, this.connection.rpcEndpoint);

    let expectedOut = req.expectedOut;
    let adapterIxData: Uint8Array | undefined;
    let actionPayload: Uint8Array | undefined;
    let remainingAccounts: Array<{ pubkey: PublicKey; isSigner: boolean; isWritable: boolean }> | undefined;
    let extraAlts: PublicKey[] = [];

    if (this.cluster === 'mainnet') {
      const slippageBps = req.slippageBps ?? 30;
      const route = await fetchJupiterRoute({
        inMint: req.inMint,
        outMint: req.outMint,
        amount: req.amount,
        slippageBps,
        userPublicKey: adapterAuthority,
        ...(req.dexes !== undefined ? { dexes: req.dexes } : {}),
      });
      const jupIxData = new Uint8Array(Buffer.from(route.swap.swapInstruction.data, 'base64'));
      const u32Le = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n, 0); return b; };
      const u64Le = (v: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(v, 0); return b; };
      adapterIxData = new Uint8Array(Buffer.concat([
        Buffer.from(instructionDiscriminator('execute')),
        u64Le(req.amount), u64Le(0n),
        u32Le(jupIxData.length), jupIxData,
      ]));
      actionPayload = jupIxData;
      remainingAccounts = route.swap.swapInstruction.accounts.map((a) => ({
        pubkey: new PublicKey(a.pubkey), isSigner: false, isWritable: a.isWritable,
      }));
      extraAlts = (route.swap.addressLookupTableAddresses ?? []).map((s) => new PublicKey(s));
      // Pool enforces actual_out >= expected_out. Use Jupiter's
      // otherAmountThreshold (= outAmount × (1 − slippageBps/10000)).
      expectedOut = expectedOut ?? BigInt(route.quote.otherAmountThreshold ?? route.quote.outAmount);
    }

    return this.privateSwap({
      inMint: req.inMint,
      outMint: req.outMint,
      amount: req.amount,
      adapterProgramId,
      adapterInTa,
      adapterOutTa,
      alt,
      photonRpc,
      ...(expectedOut !== undefined ? { expectedOut } : {}),
      ...(adapterIxData !== undefined ? { adapterIxData } : {}),
      ...(actionPayload !== undefined ? { actionPayload } : {}),
      ...(remainingAccounts !== undefined ? { remainingAccounts } : {}),
      ...(extraAlts.length > 0 ? { alts: extraAlts } : {}),
      // Phase 9 mainnet pool requires both. Legacy paths only for devnet
      // mock adapter and historical testing.
      phase9DualNote: this.cluster === 'mainnet',
      pendingInputsMode: this.cluster === 'mainnet',
    });
  }

  /**
   * Atomic private lend into a Kamino V2 reserve. Auto-discovers the
   * deepest reserve for `mint` across all 182 mainnet LendingMarkets,
   * derives per-(viewing key, mint) Kamino obligation, runs the deposit
   * + voucher mint in one tx. Pass `market` to pin a specific one
   * (e.g. JLP-only).
   *
   * Minimal call shape:
   * ```
   * const r = await b402.lend({ mint: USDC, amount: 1_000_000n });
   * ```
   *
   * First call per (viewing key, mint) tuple incurs ~0.04 SOL one-time
   * Kamino UserMetadata + Obligation rent (refundable on close).
   * Subsequent lends in that reserve cost only the relayer's tx fees.
   *
   * Mainnet only. Devnet has no Kamino reserves.
   */
  async lend(req: {
    mint: PublicKey;
    amount: bigint;
    /** Pin a specific Kamino LendingMarket. If unset, the deepest
     *  reserve (by available + borrowed total supply) wins. */
    market?: PublicKey;
  }): Promise<PrivateSwapResult> {
    if (this.cluster !== 'mainnet') {
      throw new B402Error(B402ErrorCode.InvalidConfig,
        `b402.lend is mainnet-only (current cluster: ${this.cluster}). Kamino reserves don't exist on devnet/localnet.`);
    }
    await this.ready();
    await this.status({ refresh: true });
    const admin = this._requireRelayer('b402.lend (Kamino setup txs)');
    const { pickBestKaminoReserveByMint } = await import('./kamino-discover.js');
    const km = await import('./kamino-mainnet.js');
    const { createRpc } = await import('@lightprotocol/stateless.js');

    const picked = await pickBestKaminoReserveByMint(
      this.connection, req.mint,
      req.market ? { market: req.market } : {},
    );
    if (!picked) throw new B402Error(B402ErrorCode.InvalidConfig,
      `no Kamino reserve found for mint ${req.mint.toBase58()}${req.market ? ` in market ${req.market.toBase58()}` : ''}`);

    const reserveAddr = picked.best.address;
    const market = picked.best.market;
    const reserve = km.parseReserve(picked.best.data, market);
    const outMint = reserve.collateralMint;
    const perUser = km.deriveAllPerUser(this._wallet!.spendingPub, reserve, market);
    const adapterAuthority = km.adapterAuthorityPda();

    const { adapterInTa, adapterOutTa } = await km.ensureAdapterScratchAtas({
      conn: this.connection, admin, adapterAuthority,
      inMint: req.mint, outMint,
    });
    await km.ensurePerUserSetup({
      conn: this.connection, admin, perUser, reserve, adapterAuthority,
    });

    const { derivePendingInputsPda } = await import('./commit-inputs.js');
    const [pendingInputsPda] = derivePendingInputsPda(
      new PublicKey(this.programIds.b402Pool),
      perUser.ownerPda.toBuffer(),
    );
    const altPubkey = await km.ensureAlt({
      conn: this.connection, admin, market, reserveAddr, reserve, perUser,
      pendingInputsPda, adapterAuthority, adapterInTa, adapterOutTa, outMint,
      poolHelpers: { poolConfigPda, adapterRegistryPda, treeStatePda, tokenConfigPda, vaultPda },
    });

    const actionPayload = km.buildDepositPayload(reserveAddr, req.amount);
    const adapterIxData = km.buildAdapterIxData(req.amount, 0n, actionPayload);
    const remainingAccounts = km.buildDepositRemainingAccounts({ market, reserveAddr, reserve, perUser });
    const photonRpc = createRpc(this.connection.rpcEndpoint, this.connection.rpcEndpoint);

    return this.privateLend({
      inMint: req.mint, outMint, amount: req.amount,
      adapterProgramId: km.KAMINO_ADAPTER,
      adapterInTa, adapterOutTa,
      alt: altPubkey, photonRpc,
      expectedOut: req.amount,
      adapterIxData, actionPayload, remainingAccounts,
      phase9DualNote: true, pendingInputsMode: true,
    });
  }

  /**
   * Atomic private redeem from a Kamino V2 reserve. Burns a voucher
   * commitment minted by `b402.lend()` and reshields the underlying.
   * Auto-finds the matching voucher in the local note store; pass
   * `leafIndex` to pick a specific one.
   *
   * Mainnet only.
   */
  async redeem(req: {
    /** Underlying mint (the one you lent). Voucher mint is the reserve's
     *  collateral mint, derived from the discovered reserve. */
    mint: PublicKey;
    /** Pin a specific Kamino LendingMarket — must match the one used at
     *  lend time. */
    market?: PublicKey;
    /** Optional Merkle leaf index of the voucher to burn. Default:
     *  most-recent voucher in the SDK note store. */
    leafIndex?: number;
  }): Promise<PrivateSwapResult> {
    if (this.cluster !== 'mainnet') {
      throw new B402Error(B402ErrorCode.InvalidConfig,
        `b402.redeem is mainnet-only (current cluster: ${this.cluster}).`);
    }
    await this.ready();
    await this.status({ refresh: true });
    const admin = this._requireRelayer('b402.redeem (Kamino setup txs)');
    const { pickBestKaminoReserveByMint } = await import('./kamino-discover.js');
    const km = await import('./kamino-mainnet.js');
    const { createRpc } = await import('@lightprotocol/stateless.js');
    const { getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction } =
      await import('@solana/spl-token');
    const { Transaction } = await import('@solana/web3.js');

    const picked = await pickBestKaminoReserveByMint(
      this.connection, req.mint,
      req.market ? { market: req.market } : {},
    );
    if (!picked) throw new B402Error(B402ErrorCode.InvalidConfig,
      `no Kamino reserve found for mint ${req.mint.toBase58()}`);

    const reserveAddr = picked.best.address;
    const market = picked.best.market;
    const reserve = km.parseReserve(picked.best.data, market);
    const outMint = reserve.collateralMint; // voucher mint (input for redeem)
    const perUser = km.deriveAllPerUser(this._wallet!.spendingPub, reserve, market);
    const adapterAuthority = km.adapterAuthorityPda();

    // Reverse adapter scratch ATAs: voucher in, underlying out.
    const { adapterInTa: wAdapterInTa, adapterOutTa: wAdapterOutTa } =
      await km.ensureAdapterScratchAtas({
        conn: this.connection, admin, adapterAuthority,
        inMint: outMint, outMint: req.mint,
      });
    await km.ensurePerUserSetup({
      conn: this.connection, admin, perUser, reserve, adapterAuthority,
    });

    // The pool's adapt_execute requires fee_ata_sentinel = relayer's ATA
    // for the IN mint. For redeem, IN mint is the voucher (collateral).
    // Pre-create idempotently — anyone can pay rent for a relayer-owned ATA.
    const relayerPubkey = this._relayerHttp?.client.pubkey ?? admin.publicKey;
    const relayerVoucherAta = getAssociatedTokenAddressSync(outMint, relayerPubkey, true);
    const existing = await this.connection.getAccountInfo(relayerVoucherAta);
    if (!existing) {
      const tx = new Transaction().add(
        createAssociatedTokenAccountIdempotentInstruction(
          admin.publicKey, relayerVoucherAta, relayerPubkey, outMint,
        ),
      );
      const bh = await this.connection.getLatestBlockhash('confirmed');
      tx.recentBlockhash = bh.blockhash;
      tx.feePayer = admin.publicKey;
      tx.sign(admin);
      const sig = await this.connection.sendRawTransaction(tx.serialize(), {
        skipPreflight: false, preflightCommitment: 'confirmed',
      });
      // Poll for confirm without WS subs.
      const start = Date.now();
      let interval = 2000;
      while (Date.now() - start < 90_000) {
        const r = await this.connection.getSignatureStatuses([sig], { searchTransactionHistory: false });
        const s = r.value[0];
        if (s?.confirmationStatus === 'confirmed' || s?.confirmationStatus === 'finalized') break;
        if (s?.err) throw new Error(`relayer voucher ATA tx failed: ${JSON.stringify(s.err)}`);
        await new Promise((r) => setTimeout(r, interval));
        interval = Math.min(interval * 1.2, 5000);
      }
    }

    const { derivePendingInputsPda } = await import('./commit-inputs.js');
    const [pendingInputsPda] = derivePendingInputsPda(
      new PublicKey(this.programIds.b402Pool),
      perUser.ownerPda.toBuffer(),
    );
    const altPubkey = await km.ensureAlt({
      conn: this.connection, admin, market, reserveAddr, reserve, perUser,
      pendingInputsPda, adapterAuthority,
      adapterInTa: wAdapterInTa, adapterOutTa: wAdapterOutTa, outMint: req.mint,
      poolHelpers: { poolConfigPda, adapterRegistryPda, treeStatePda, tokenConfigPda, vaultPda },
    });

    // Pick the voucher note to burn.
    const { leToFrReduced } = await import('@b402ai/solana-shared');
    const voucherMintFr = leToFrReduced(outMint.toBytes());
    const vouchers = this._notes!.getSpendable(voucherMintFr);
    if (vouchers.length === 0) {
      throw new B402Error(B402ErrorCode.NoSpendableNotes,
        `no voucher notes for ${outMint.toBase58().slice(0, 8)}… — call b402.lend first or wait for the lend tx to finalize`);
    }
    let redeemNote = vouchers[0];
    if (req.leafIndex !== undefined) {
      const target = req.leafIndex;
      const found = vouchers.find((n) => Number(n.leafIndex) === target);
      if (!found) throw new B402Error(B402ErrorCode.InvalidConfig,
        `leafIndex ${target} not in voucher notes`);
      redeemNote = found;
    } else {
      const sorted = [...vouchers].sort((a, b) =>
        Number(BigInt(b.leafIndex) - BigInt(a.leafIndex)));
      redeemNote = sorted[0];
    }
    const ktIn = redeemNote.value;

    const actionPayload = km.buildWithdrawPayload(reserveAddr, ktIn);
    const adapterIxData = km.buildAdapterIxData(ktIn, 0n, actionPayload);
    const remainingAccounts = km.buildWithdrawRemainingAccounts({ market, reserveAddr, reserve, perUser });
    const photonRpc = createRpc(this.connection.rpcEndpoint, this.connection.rpcEndpoint);

    return this.privateRedeem({
      inMint: outMint, outMint: req.mint, amount: ktIn, note: redeemNote,
      adapterProgramId: km.KAMINO_ADAPTER,
      adapterInTa: wAdapterInTa, adapterOutTa: wAdapterOutTa,
      alt: altPubkey, photonRpc,
      expectedOut: 0n,
      adapterIxData, actionPayload, remainingAccounts,
      phase9DualNote: true, pendingInputsMode: true,
    });
  }

  /**
   * Lend underlying tokens into a registered yield protocol via its
   * adapter. Low-level: caller supplies adapter wiring. Use `b402.lend()`
   * for Kamino with auto-discovery + auto-setup.
   */
  async privateLend(req: PrivateSwapRequest): Promise<PrivateSwapResult> {
    return this.privateSwap(req);
  }

  /**
   * Redeem receipt tokens for the underlying via a registered lending
   * adapter. Mechanically a `privateSwap`: burns the receipt-token note
   * created by `privateLend`, CPIs the adapter with a Withdraw action,
   * and reshields the underlying proceeds.
   *
   * For Kamino, see `buildKaminoWithdrawIx` in `@b402ai/solana/kamino`.
   */
  async privateRedeem(req: PrivateSwapRequest): Promise<PrivateSwapResult> {
    return this.privateSwap(req);
  }

  get wallet(): Wallet {
    if (!this._wallet) throw new Error('call ready() first');
    return this._wallet;
  }

  /**
   * Resolve the local relayer Keypair, throwing a clear error if the SDK
   * was constructed without one. Used by every code path that submits
   * a tx via raw RPC. Browser callers should configure `relayerHttpUrl`
   * instead — those code paths route through the hosted relayer service
   * and never call this helper.
   */
  private _requireRelayer(opName: string): Keypair {
    if (!this.relayer) {
      throw new Error(
        `${opName} needs a local relayer Keypair. Either pass \`relayer: Keypair\` to B402Solana, \`keypair: Keypair\` (legacy — used as relayer fallback), or configure \`relayerHttpUrl\` (browser; the hosted relayer pays fees and the SDK skips the local-submit path).`,
      );
    }
    return this.relayer;
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
  /**
   * Cross-check `notes` against the on-chain nullifier set and drop any
   * that are already spent. Local `markSpent` only fires when the SDK
   * itself orchestrated the spend — notes spent in a prior process, by a
   * different SDK instance with the same viewing key, or by the relayer
   * outside this client all look spendable locally. Without this probe,
   * those notes leak into pickers and the swap then fails with
   * `Address ... already exists` from Photon at proof-fetch time.
   *
   * **Probe path: Light Protocol's batch address tree, via Photon's
   * `getMultipleNewAddressProofs`.** This is the same tree
   * `getValidityProofForNullifier` reads at swap time — `getCompressedAccount`
   * would NOT work here because nullifier insertions live in the address
   * tree (uniqueness index), not the state tree (account data store). For
   * each note we derive the nullifier compressed-account address with the
   * same helper the swap path uses, then ask Photon for a non-inclusion
   * proof. Proof returned ⇒ address absent ⇒ note unspent. Throws with
   * `already exists` ⇒ address present ⇒ note spent.
   *
   * Probes in parallel with a 30s per-leaf cache so back-to-back picker
   * renders don't refan the same queries. Photon transient failures are
   * non-fatal: we fall back to keeping the note (the swap-time probe
   * still catches it) rather than blocking the UI on an outage.
   */
  private async _filterUnspent(notes: SpendableNote[]): Promise<SpendableNote[]> {
    if (notes.length === 0) return notes;
    if (!this._wallet) return notes;
    const now = Date.now();
    const TTL_MS = 30_000;
    // Lazy-create the Photon RPC from the same endpoint the swap path uses.
    if (!this._photonRpc) {
      try {
        const { createRpc } = await import('@lightprotocol/stateless.js');
        this._photonRpc = createRpc(this.connection.rpcEndpoint, this.connection.rpcEndpoint);
      } catch {
        return notes;
      }
    }
    const rpc: any = this._photonRpc;
    const { bn } = await import('@lightprotocol/stateless.js');
    const checks = await Promise.all(
      notes.map(async (n) => {
        const key = n.leafIndex.toString();
        const cached = this._spentCache.get(key);
        if (cached && now - cached.at < TTL_MS) return { n, spent: cached.spent };
        try {
          const nh = await nullifierHash(this._wallet!.spendingPriv, n.leafIndex);
          const nhLe = bigintToLe32(nh);
          const address = deriveNullifierAddress(nhLe);
          // getMultipleNewAddressProofs returns non-inclusion proofs from
          // the batch address tree. Success ⇒ address absent ⇒ unspent.
          // Throws with "already exists" ⇒ address present ⇒ spent.
          await rpc.getMultipleNewAddressProofs([bn(address.toBytes())]);
          this._spentCache.set(key, { spent: false, at: now });
          return { n, spent: false };
        } catch (e: any) {
          const msg = String(e?.message ?? e);
          if (/already exists/i.test(msg)) {
            this._spentCache.set(key, { spent: true, at: now });
            this._notes!.markSpent(n.commitment);
            return { n, spent: true };
          }
          // Transient Photon error — keep the note; swap-time probe catches.
          return { n, spent: false };
        }
      }),
    );
    return checks.filter((c) => !c.spent).map((c) => c.n);
  }

  async holdings(opts: { mint?: PublicKey; refresh?: boolean } = {}): Promise<{
    holdings: Array<{ id: string; mint: string; amount: string }>;
  }> {
    await this.ready();
    if (opts.refresh === true) await this._notes!.backfill({ limit: 30 });
    const filterFr = opts.mint ? leToFrReduced(opts.mint.toBytes()) : null;
    const local = filterFr != null
      ? this._notes!.getSpendable(filterFr)
      : this._notes!.getAllSpendable();
    const notes = await this._filterUnspent(local);
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
      (async () => {
        const local = this._notes!.getAllSpendable();
        const notes = await this._filterUnspent(local);
        const agg = new Map<bigint, { amount: bigint; count: number }>();
        for (const n of notes) {
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
      })(),
    ]);
    const explorer = (kind: 'account', addr: string) =>
      `https://solscan.io/${kind}/${addr}${this.cluster === 'devnet' ? '?cluster=devnet' : ''}`;
    return {
      user: this.signer.publicKey.toBase58(),
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
        userOnSolscan: explorer('account', this.signer.publicKey.toBase58()),
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
    const local = filterFr != null
      ? this._notes!.getSpendable(filterFr)
      : this._notes!.getAllSpendable();
    const notes = await this._filterUnspent(local);
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
    // Match the route restrictions used by privateSwap's internal Jupiter
    // call — otherwise an agent gets a best-route quote then a Phoenix-direct
    // execution and sees a phantom "16% slippage" gap. Drop these once the
    // multi-DEX ALT extender ships (Phase 8).
    url.searchParams.set('onlyDirectRoutes', 'true');
    url.searchParams.set('dexes', 'Phoenix');

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

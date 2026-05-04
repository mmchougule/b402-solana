/**
 * B402Signer — abstracts the two distinct signing roles the SDK needs:
 *
 *   1. Solana on-chain signing (shield / unshield only). The user's wallet
 *      is the token-account authority for those public deposits/withdrawals
 *      and must sign the tx itself.
 *   2. b402 wallet seed derivation. Spending + viewing keys live entirely
 *      off-chain, derived from a 32-byte seed. The seed source can be a
 *      Solana Keypair's secret bytes (Node / MCP path) or a deterministic
 *      Phantom signMessage result (browser path) — see WalletAdapterSigner.
 *
 * Private operations (privateSwap, privateLend, ...) never need the Solana
 * signTransaction path: the relayer is the on-chain payer, and the b402
 * wallet — derived from getSeed() — proves its own authority via the
 * spending key inside the zk-proof.
 */

import { Keypair, PublicKey, VersionedTransaction, Transaction } from '@solana/web3.js';
import { sha256 } from '@noble/hashes/sha256';

/**
 * The exact bytes Phantom (or any Solana wallet adapter) is asked to sign
 * for browser-side seed derivation. CHANGING THIS STRING SILENTLY
 * INVALIDATES EVERY EXISTING USER WALLET — there is no recovery path other
 * than re-shielding under the new derivation. Treat as a versioned
 * protocol constant.
 */
export const B402_SIGNER_DERIVATION_MESSAGE = 'b402-solana wallet derivation v1';

export interface B402Signer {
  /** Pubkey for Solana on-chain operations. */
  readonly publicKey: PublicKey;

  /** Sign a Solana versioned tx (shield / unshield). Private operations
      route through the relayer and do not call this. */
  signTransaction<T extends VersionedTransaction | Transaction>(tx: T): Promise<T>;

  /** 32-byte seed for buildWallet(). Stable for the lifetime of the signer
      and for any future signer derived from the same source (same Keypair
      secretKey, or same wallet replaying the same canonical derivation
      signature). */
  getSeed(): Uint8Array;
}

/** Type guard. Cheap structural check — anything that walks like a Signer. */
export function isB402Signer(x: unknown): x is B402Signer {
  if (!x || typeof x !== 'object') return false;
  const o = x as Record<string, unknown>;
  return (
    o.publicKey instanceof PublicKey &&
    typeof o.signTransaction === 'function' &&
    typeof o.getSeed === 'function'
  );
}

/**
 * Wraps a Solana Keypair for environments where the entire keypair is
 * already in process (Node, MCP, tests). Seed = secretKey[0..32]: the
 * exact derivation the SDK has used since pre-0.0.18, so existing wallets
 * remain identical.
 */
export class KeypairSigner implements B402Signer {
  readonly publicKey: PublicKey;
  /** The underlying Keypair. Exposed for legacy callers that need the
   *  full secret (e.g. `b402.keypair` back-compat accessor). */
  readonly keypair: Keypair;
  constructor(kp: Keypair) {
    this.publicKey = kp.publicKey;
    this.keypair = kp;
  }
  private get kp(): Keypair { return this.keypair; }

  async signTransaction<T extends VersionedTransaction | Transaction>(tx: T): Promise<T> {
    // VersionedTransaction.sign takes an array of Signers; legacy
    // Transaction.sign takes varargs. Both have a `.sign` method, so we
    // must dispatch on the actual class. instanceof works because we
    // import the constructors (not just the types) from web3.js.
    if (tx instanceof VersionedTransaction) {
      tx.sign([this.kp]);
    } else if (tx instanceof Transaction) {
      tx.partialSign(this.kp);
    } else {
      throw new Error('KeypairSigner: unsupported transaction shape');
    }
    return tx;
  }

  getSeed(): Uint8Array {
    return this.kp.secretKey.slice(0, 32);
  }
}

/**
 * Minimal contract a Solana wallet adapter (Phantom, Solflare, Backpack)
 * must satisfy for browser-side derivation. We accept whatever exposes
 * these three properties so the SDK doesn't depend on a specific adapter
 * package — any of @solana/wallet-adapter-*, @wallet-standard/*, or a
 * plain hand-rolled object with these methods works.
 */
export interface WalletAdapterLike {
  publicKey: PublicKey | null;
  signMessage?(message: Uint8Array): Promise<Uint8Array>;
  signTransaction?<T extends VersionedTransaction | Transaction>(tx: T): Promise<T>;
}

/**
 * Browser path. Asks the adapter to sign B402_SIGNER_DERIVATION_MESSAGE
 * once, then sha256s the result down to a 32-byte seed which feeds
 * buildWallet(). The raw signature itself is not retained; only the
 * derived seed lives on the instance.
 *
 * Re-deriving (e.g. on page reload) re-prompts the adapter; same wallet +
 * same canonical message → same signature → same seed → same b402 wallet.
 * No localStorage of secrets, no server custody, no smart-wallet primitive.
 */
export class WalletAdapterSigner implements B402Signer {
  readonly publicKey: PublicKey;

  private constructor(
    private readonly adapter: WalletAdapterLike,
    private readonly seed: Uint8Array,
  ) {
    if (!adapter.publicKey) throw new Error('WalletAdapterSigner: adapter.publicKey is null');
    this.publicKey = adapter.publicKey;
  }

  static async fromAdapter(adapter: WalletAdapterLike): Promise<WalletAdapterSigner> {
    if (!adapter.publicKey) {
      throw new Error('WalletAdapterSigner: adapter.publicKey is null — connect the wallet first');
    }
    if (typeof adapter.signMessage !== 'function') {
      throw new Error(
        'WalletAdapterSigner: adapter does not support signMessage — Phantom / Solflare / Backpack do; some hardware wallets may not',
      );
    }
    const msg = new TextEncoder().encode(B402_SIGNER_DERIVATION_MESSAGE);
    const sig = await adapter.signMessage(msg);
    const seed = sha256(sig).slice(0, 32);
    return new WalletAdapterSigner(adapter, seed);
  }

  async signTransaction<T extends VersionedTransaction | Transaction>(tx: T): Promise<T> {
    if (typeof this.adapter.signTransaction !== 'function') {
      throw new Error(
        'WalletAdapterSigner: adapter does not support signTransaction — required for shield / unshield',
      );
    }
    return this.adapter.signTransaction(tx);
  }

  getSeed(): Uint8Array {
    return this.seed;
  }
}

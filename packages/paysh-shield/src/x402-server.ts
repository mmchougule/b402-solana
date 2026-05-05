import {
  PublicKey,
  VersionedTransaction,
  Transaction,
  type Connection,
} from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';

import { parseUsdcTransfersToIngress } from './parse.js';
import type { PaymentPayload } from './x402.js';

export interface VerifyOpts {
  connection: Connection;
  /** SPL mint we'll accept payment in. */
  mint: PublicKey;
  /** Operator wallet pubkey (the `payTo` advertised in 402). */
  payTo: PublicKey;
  /** Required USDC amount in smallest units (the value advertised in 402). */
  expectedAmount: bigint;
}

export type VerifyResult =
  | { ok: true; txSig: string; amount: bigint; payerPubkey: string }
  | { ok: false; status: 400 | 402 | 502; error: string };

/**
 * Verify that the supplied PaymentPayload settles a USDC transfer of at
 * least `expectedAmount` to `getAssociatedTokenAddressSync(mint, payTo)`.
 *
 * Behaviour:
 *   1. Deserialize the tx (supports v0 and legacy).
 *   2. If the tx already has a signature on chain, skip submission.
 *      Otherwise sendRawTransaction.
 *   3. Wait for confirmed state (up to ~30s).
 *   4. Fetch the parsed tx and run parseUsdcTransfersToIngress against
 *      the expected ingress ATA. Pass iff at least one transfer matches
 *      and the matched amount is >= expectedAmount.
 *
 * Status codes returned on failure:
 *   400 — payload was structurally invalid (wrong tx encoding etc.)
 *   402 — tx settled but the on-chain transfer didn't match the requirement
 *   502 — chain-side flake we couldn't recover from in time
 */
export async function verifyPayment(
  payload: PaymentPayload,
  opts: VerifyOpts,
): Promise<VerifyResult> {
  const ingressAta = getAssociatedTokenAddressSync(opts.mint, opts.payTo);

  let raw: Buffer;
  try {
    raw = Buffer.from(payload.payload.transaction, 'base64');
  } catch {
    return { ok: false, status: 400, error: 'transaction is not base64' };
  }

  const tx = decodeTx(raw);
  if (!tx) return { ok: false, status: 400, error: 'transaction not deserializable' };

  // Try to read the signature off the tx so we can detect "already submitted".
  const txSig = readPrimarySignature(tx);

  let confirmedSig: string | null = null;
  if (txSig) {
    const status = await opts.connection.getSignatureStatus(txSig, {
      searchTransactionHistory: false,
    });
    if (status.value?.confirmationStatus === 'confirmed' || status.value?.confirmationStatus === 'finalized') {
      confirmedSig = txSig;
    }
  }
  if (!confirmedSig) {
    try {
      confirmedSig = await opts.connection.sendRawTransaction(raw, {
        skipPreflight: false,
        maxRetries: 3,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // "already processed" is fine — the tx landed before we got here.
      if (txSig && /already processed|AlreadyProcessed/i.test(msg)) {
        confirmedSig = txSig;
      } else {
        return { ok: false, status: 502, error: `sendRawTransaction: ${msg}` };
      }
    }
    try {
      await opts.connection.confirmTransaction(confirmedSig, 'confirmed');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, status: 502, error: `confirmTransaction: ${msg}` };
    }
  }

  const parsed = await opts.connection.getParsedTransaction(confirmedSig, {
    commitment: 'confirmed',
    maxSupportedTransactionVersion: 0,
  });
  if (!parsed) return { ok: false, status: 502, error: 'tx not retrievable post-confirm' };
  if (parsed.meta?.err) return { ok: false, status: 402, error: 'on-chain tx failed' };

  const obs = parseUsdcTransfersToIngress(
    parsed as unknown as Parameters<typeof parseUsdcTransfersToIngress>[0],
    ingressAta.toBase58(),
  );
  const match = obs.find((o) => BigInt(o.amount) >= opts.expectedAmount);
  if (!match) {
    return {
      ok: false,
      status: 402,
      error: `no matching SPL transfer ≥ ${opts.expectedAmount} to ${ingressAta.toBase58()}`,
    };
  }
  return { ok: true, txSig: confirmedSig, amount: BigInt(match.amount), payerPubkey: match.payerPubkey };
}

function decodeTx(raw: Buffer): VersionedTransaction | Transaction | null {
  try {
    return VersionedTransaction.deserialize(raw);
  } catch {
    /* fall through */
  }
  try {
    return Transaction.from(raw);
  } catch {
    return null;
  }
}

function readPrimarySignature(tx: VersionedTransaction | Transaction): string | null {
  if (tx instanceof VersionedTransaction) {
    const sig = tx.signatures[0];
    if (!sig || sig.every((b) => b === 0)) return null;
    return base58Encode(sig);
  }
  // Legacy
  const first = tx.signatures[0];
  if (!first?.signature) return null;
  return base58Encode(new Uint8Array(first.signature));
}

// Tiny self-contained base58 encoder so this module doesn't pull `bs58`.
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58Encode(bytes: Uint8Array): string {
  if (bytes.length === 0) return '';
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  let n = 0n;
  for (const b of bytes) n = (n << 8n) + BigInt(b);
  let s = '';
  while (n > 0n) {
    const r = n % 58n;
    n /= 58n;
    s = ALPHABET[Number(r)] + s;
  }
  for (let i = 0; i < zeros; i++) s = '1' + s;
  return s;
}

/**
 * Wallet — seed-derived spending + viewing keys per PRD-02 §2.
 *
 * Spending key lives in BN254 Fr (for cheap in-circuit auth).
 * Viewing key lives in X25519 (for ECDH note encryption).
 * They are derived from the same 32-byte seed but via different KDFs.
 */

import { sha512 } from '@noble/hashes/sha512';
import { x25519 } from '@noble/curves/ed25519';
import { FR_MODULUS, leToFrReduced } from '@b402ai/solana-shared';
import { spendingPub as derivePub } from './poseidon.js';

const TEXT = new TextEncoder();

export interface Wallet {
  seed: Uint8Array;
  spendingPriv: bigint;
  spendingPub: bigint;
  viewingPriv: Uint8Array;   // 32 bytes, X25519 scalar
  viewingPub: Uint8Array;    // 32 bytes
}

/** Build a wallet from a 32-byte seed. */
export async function buildWallet(seed: Uint8Array): Promise<Wallet> {
  if (seed.length !== 32) throw new Error('seed must be 32 bytes');

  // Spending: Fr(seed || "b402/v1/spend-key") reduced mod p.
  // We hash to get uniform 64 bytes then reduce.
  const spendHash = sha512(
    concat(TEXT.encode('b402/v1/spend-key'), seed),
  );
  // Take first 32 bytes as LE, reduce mod p.
  const spendingPriv = leToFrReduced(spendHash.slice(0, 32));
  const spendingPubVal = await derivePub(spendingPriv);

  // Viewing: X25519 scalar derived from sha512("b402/v1/view-key" || seed)[0..32],
  // clamped per RFC 7748.
  const viewRaw = sha512(concat(TEXT.encode('b402/v1/view-key'), seed)).slice(0, 32);
  const viewingPriv = clampX25519(viewRaw);
  const viewingPub = x25519.getPublicKey(viewingPriv);

  return {
    seed,
    spendingPriv,
    spendingPub: spendingPubVal,
    viewingPriv,
    viewingPub,
  };
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/** RFC 7748 X25519 clamping. */
function clampX25519(raw: Uint8Array): Uint8Array {
  if (raw.length !== 32) throw new Error('X25519 scalar must be 32 bytes');
  const out = new Uint8Array(raw);
  out[0] &= 248;
  out[31] &= 127;
  out[31] |= 64;
  return out;
}

// Export for tests / external modules that want their own derivations.
export { FR_MODULUS };

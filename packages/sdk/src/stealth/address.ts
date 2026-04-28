/**
 * Stealth-address encoding for b402-solana wallets.
 *
 * Format:  bech32(HRP, [version_byte || spendingPub_LE32 || viewingPub32])
 *   - HRP:                "b402sol"  (distinct from any EVM-sibling HRP because
 *                          spending key here is BN254 Fr and viewing key is
 *                          X25519, not secp256k1)
 *   - version_byte:        0x00 = v0 (only version currently defined)
 *   - spendingPub_LE32:    frToLe(wallet.spendingPub) — canonical, < FR_MODULUS
 *   - viewingPub32:        wallet.viewingPub  — raw X25519 pub
 *
 * Total payload: 1 + 32 + 32 = 65 bytes.
 *
 * Decoding rejects:
 *   - wrong HRP
 *   - wrong version byte
 *   - non-canonical spending key (>= FR_MODULUS)
 *   - any bech32 checksum failure (handled by @scure/base)
 *   - wrong payload length
 */

import { bech32 } from '@scure/base';
import { frToLe, leToFr } from '@b402ai/solana-shared';
import { B402Error, B402ErrorCode } from '../errors.js';

export const STEALTH_ADDRESS_HRP = 'b402sol';
export const STEALTH_ADDRESS_VERSION = 0x00;
const PAYLOAD_LEN = 1 + 32 + 32;

// bech32 strings are bounded by the underlying spec (max 90 chars for BIP-173).
// Our payload is 65 bytes → ~104 5-bit groups + HRP + checksum, which exceeds the
// 90-char default. @scure/base accepts a custom limit; we pin a generous one.
const BECH32_LIMIT = 256;

export interface StealthAddressParts {
  spendingPub: bigint;
  viewingPub: Uint8Array;
}

/** Encode a (spendingPub, viewingPub) pair as a `b402sol1…` bech32 string. */
export function encodeStealthAddress(spendingPub: bigint, viewingPub: Uint8Array): string {
  if (viewingPub.length !== 32) {
    throw new B402Error(
      B402ErrorCode.InvalidRecipient,
      `viewingPub must be 32 bytes, got ${viewingPub.length}`,
    );
  }
  let spendBytes: Uint8Array;
  try {
    // frToLe rejects out-of-range / negative.
    spendBytes = frToLe(spendingPub);
  } catch (e) {
    throw new B402Error(
      B402ErrorCode.InvalidRecipient,
      `invalid spendingPub: ${(e as Error).message}`,
    );
  }

  const payload = new Uint8Array(PAYLOAD_LEN);
  payload[0] = STEALTH_ADDRESS_VERSION;
  payload.set(spendBytes, 1);
  payload.set(viewingPub, 33);

  const words = bech32.toWords(payload);
  return bech32.encode(STEALTH_ADDRESS_HRP, words, BECH32_LIMIT);
}

/** Decode a `b402sol1…` string back into (spendingPub, viewingPub). */
export function decodeStealthAddress(s: string): StealthAddressParts {
  let prefix: string;
  let words: number[];
  try {
    // @scure/base's bech32.decode types require a literal-checked
    // `${string}1${string}` shape; we narrow at runtime via the decode itself,
    // which throws if the '1' separator is missing.
    ({ prefix, words } = bech32.decode(s as `${string}1${string}`, BECH32_LIMIT));
  } catch (e) {
    throw new B402Error(
      B402ErrorCode.InvalidRecipient,
      `bech32 decode failed: ${(e as Error).message}`,
    );
  }
  if (prefix !== STEALTH_ADDRESS_HRP) {
    throw new B402Error(
      B402ErrorCode.InvalidRecipient,
      `wrong HRP: expected '${STEALTH_ADDRESS_HRP}', got '${prefix}'`,
    );
  }
  const payload = bech32.fromWords(words);
  if (payload.length !== PAYLOAD_LEN) {
    throw new B402Error(
      B402ErrorCode.InvalidRecipient,
      `payload length: expected ${PAYLOAD_LEN}, got ${payload.length}`,
    );
  }
  const version = payload[0];
  if (version !== STEALTH_ADDRESS_VERSION) {
    throw new B402Error(
      B402ErrorCode.InvalidRecipient,
      `unknown stealth-address version: 0x${version.toString(16)}`,
    );
  }
  let spendingPub: bigint;
  try {
    spendingPub = leToFr(Uint8Array.from(payload.subarray(1, 33)));
  } catch (e) {
    throw new B402Error(
      B402ErrorCode.InvalidRecipient,
      `non-canonical spending key: ${(e as Error).message}`,
    );
  }
  const viewingPub = Uint8Array.from(payload.subarray(33, 65));
  return { spendingPub, viewingPub };
}

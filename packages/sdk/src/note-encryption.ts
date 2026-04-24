/**
 * Note encryption per PRD-02 §1.3 and §4.
 *
 * Flow:
 *   ephPriv ← random X25519 scalar
 *   sharedSecret ← X25519(ephPriv, recipientViewingPub)
 *   encryptKey ← HKDF-SHA256(sharedSecret, salt = "b402-note-enc-v1")
 *   ciphertext ← ChaCha20-Poly1305(encryptKey, nonce = leafIndex || 0x00_00_00_00)
 *   viewingTag ← first 2 bytes of Poseidon_2("b402/v1/viewtag", sharedSecret_as_field)
 */

import { x25519 } from '@noble/curves/ed25519';
import { chacha20poly1305 } from '@noble/ciphers/chacha';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha256';
import { randomBytes } from '@noble/hashes/utils';
import { FR_MODULUS, frToLe, leToFrReduced } from '@b402ai/solana-shared';
import type { Note } from '@b402ai/solana-shared';
import { poseidonTagged } from './poseidon.js';

const AAD = new TextEncoder().encode('b402-note-v1');
const HKDF_SALT = new TextEncoder().encode('b402-note-enc-v1');

export interface EncryptedNote {
  ciphertext: Uint8Array;    // 89 bytes
  ephemeralPub: Uint8Array;  // 32 bytes
  viewingTag: Uint8Array;    // 2 bytes
}

/** Serialize a Note to 73 cleartext bytes. */
function serializeNote(n: Note): Uint8Array {
  // [8] value u64 LE
  // [32] random Fr LE
  // [32] tokenMint Fr LE
  // [1] version = 1
  const out = new Uint8Array(73);
  const dv = new DataView(out.buffer);
  dv.setBigUint64(0, n.value, true);
  out.set(frToLe(n.random), 8);
  out.set(frToLe(n.tokenMint), 40);
  out[72] = 1;
  return out;
}

export function deserializeNote(plaintext: Uint8Array, spendingPub: bigint): Note {
  if (plaintext.length !== 73) throw new Error('bad plaintext length');
  const dv = new DataView(plaintext.buffer, plaintext.byteOffset, plaintext.byteLength);
  const value = dv.getBigUint64(0, true);
  const random = bytesToFr(plaintext.slice(8, 40));
  const tokenMint = bytesToFr(plaintext.slice(40, 72));
  const version = plaintext[72];
  if (version !== 1) throw new Error('unknown note version');
  return { value, random, tokenMint, spendingPub };
}

function bytesToFr(b: Uint8Array): bigint {
  let v = 0n;
  for (let i = 31; i >= 0; i--) v = (v << 8n) | BigInt(b[i]);
  if (v >= FR_MODULUS) throw new Error('decoded Fr non-canonical');
  return v;
}

function nonceForIndex(leafIndex: bigint): Uint8Array {
  if (leafIndex < 0n || leafIndex >= (1n << 64n)) throw new Error('leafIndex out of range');
  const nonce = new Uint8Array(12);
  const dv = new DataView(nonce.buffer);
  dv.setBigUint64(0, leafIndex, true);
  return nonce;
}

export async function encryptNote(
  note: Note,
  recipientViewingPub: Uint8Array,
  leafIndex: bigint,
): Promise<EncryptedNote> {
  const ephPriv = randomBytes(32);
  // X25519 requires clamped scalars.
  ephPriv[0] &= 248;
  ephPriv[31] &= 127;
  ephPriv[31] |= 64;

  const ephPub = x25519.getPublicKey(ephPriv);
  const shared = x25519.getSharedSecret(ephPriv, recipientViewingPub);

  const key = hkdf(sha256, shared, HKDF_SALT, new Uint8Array(), 32);
  const nonce = nonceForIndex(leafIndex);
  const cipher = chacha20poly1305(key, nonce, AAD);
  const plaintext = serializeNote(note);
  const ciphertext = cipher.encrypt(plaintext);
  if (ciphertext.length !== 89) throw new Error(`bad ciphertext length ${ciphertext.length}`);

  const sharedFr = leToFrReduced(shared);
  const tagFull = await poseidonTagged('viewTag', sharedFr);
  const tagBytes = frToLe(tagFull);
  const viewingTag = tagBytes.slice(0, 2);

  return { ciphertext, ephemeralPub: ephPub, viewingTag };
}

export async function tryDecryptNote(
  enc: EncryptedNote,
  myViewingPriv: Uint8Array,
  leafIndex: bigint,
  mySpendingPub: bigint,
): Promise<Note | null> {
  // Fast path: viewing tag check.
  const shared = x25519.getSharedSecret(myViewingPriv, enc.ephemeralPub);
  const sharedFr = leToFrReduced(shared);
  const tagFull = await poseidonTagged('viewTag', sharedFr);
  const candidateTag = frToLe(tagFull).slice(0, 2);
  if (candidateTag[0] !== enc.viewingTag[0] || candidateTag[1] !== enc.viewingTag[1]) {
    return null;
  }

  // Decrypt.
  const key = hkdf(sha256, shared, HKDF_SALT, new Uint8Array(), 32);
  const nonce = nonceForIndex(leafIndex);
  const cipher = chacha20poly1305(key, nonce, AAD);
  try {
    const plaintext = cipher.decrypt(enc.ciphertext);
    const note = deserializeNote(plaintext, mySpendingPub);
    return note;
  } catch {
    return null;
  }
}

/** Canonical encodings — MUST match Rust `b402-crypto` and Circom circuits. */

import { FR_MODULUS, DomainTags, type DomainTagName } from './constants.js';

/** Encode a bigint < p as a 32-byte LE buffer. Throws on overflow. */
export function frToLe(x: bigint): Uint8Array {
  if (x < 0n || x >= FR_MODULUS) throw new Error(`Fr out of range: ${x}`);
  const out = new Uint8Array(32);
  let v = x;
  for (let i = 0; i < 32; i++) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

/** Decode a 32-byte LE buffer as a bigint. Rejects non-canonical (>= p). */
export function leToFr(b: Uint8Array): bigint {
  if (b.length !== 32) throw new Error('expected 32 bytes');
  let v = 0n;
  for (let i = 31; i >= 0; i--) v = (v << 8n) | BigInt(b[i]);
  if (v >= FR_MODULUS) throw new Error('non-canonical Fr');
  return v;
}

/** Reduce 32 raw bytes mod p (used for encoding pubkeys as Fr). */
export function leToFrReduced(b: Uint8Array): bigint {
  if (b.length !== 32) throw new Error('expected 32 bytes');
  let v = 0n;
  for (let i = 31; i >= 0; i--) v = (v << 8n) | BigInt(b[i]);
  return v % FR_MODULUS;
}

/** Encode a domain-tag string as Fr via BE byte interpretation. */
export function tagToFr(tag: string): bigint {
  if (tag.length > 31) throw new Error(`tag too long: ${tag.length}`);
  let acc = 0n;
  for (let i = 0; i < tag.length; i++) acc = (acc << 8n) | BigInt(tag.charCodeAt(i));
  return acc % FR_MODULUS;
}

export function domainTag(name: DomainTagName): bigint {
  return tagToFr(DomainTags[name]);
}

export function u64ToFrLe(v: bigint): Uint8Array {
  if (v < 0n || v >= (1n << 64n)) throw new Error('u64 out of range');
  return frToLe(v);
}

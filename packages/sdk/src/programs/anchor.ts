/**
 * Minimal Anchor wire-format helpers — instruction discriminator + Borsh encoding.
 * No `@coral-xyz/anchor` dep; this is just `sha256("global:<name>")[..8]` plus
 * trivial buffer assembly for fixed-shape args.
 */

import { sha256 } from '@noble/hashes/sha256';

export function instructionDiscriminator(name: string): Uint8Array {
  const h = sha256(new TextEncoder().encode(`global:${name}`));
  return h.slice(0, 8);
}

export function eventDiscriminator(name: string): Uint8Array {
  const h = sha256(new TextEncoder().encode(`event:${name}`));
  return h.slice(0, 8);
}

/** Concatenate Uint8Arrays. */
export function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/** u32 LE encoding (Borsh Vec length prefix). */
export function u32Le(v: number): Uint8Array {
  const buf = new Uint8Array(4);
  buf[0] = v & 0xff;
  buf[1] = (v >> 8) & 0xff;
  buf[2] = (v >> 16) & 0xff;
  buf[3] = (v >>> 24) & 0xff;
  return buf;
}

/** u16 LE encoding. */
export function u16Le(v: number): Uint8Array {
  const buf = new Uint8Array(2);
  buf[0] = v & 0xff;
  buf[1] = (v >> 8) & 0xff;
  return buf;
}

/** u64 LE encoding (8 bytes). */
export function u64Le(v: bigint): Uint8Array {
  if (v < 0n || v >= (1n << 64n)) throw new Error('u64 out of range');
  const buf = new Uint8Array(8);
  let x = v;
  for (let i = 0; i < 8; i++) {
    buf[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return buf;
}

/** Borsh Vec<u8>: u32 LE length || bytes. */
export function vecU8(bytes: Uint8Array): Uint8Array {
  return concat(u32Le(bytes.length), bytes);
}

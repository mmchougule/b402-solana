/**
 * Request validation for relay endpoints.
 *
 * Schema validation is zod (zero-trust on user input). Field semantics:
 *
 *   ixData       — base64 of the full Anchor instruction data (discriminator
 *                  + Borsh args). Relayer never re-encodes; it forwards bytes
 *                  verbatim, so the proof's bound public inputs stay intact.
 *   accountKeys  — explicit AccountMeta list. Relayer trusts the client's
 *                  `isSigner`/`isWritable` flags but always overrides the
 *                  fee-payer (first key) with its own pubkey when the client
 *                  marked it as signer + writable, OR injects relayer as
 *                  account[0] if missing.
 *   altAddresses — base58 pubkeys of AddressLookupTables to compile into
 *                  the v0 message (required for adapt_execute under 1232 B).
 *
 * Fee floor: pool's TransactPublicInputs / AdaptPublicInputs both place
 * `relayer_fee: u64` at the same byte offset relative to the start of the
 * args struct (after the 8-byte discriminator + 4-byte vec-len + 256-byte
 * proof + 5×32 commit/null bytes + 2×8 amount fields + 32 mint pubkey).
 *
 *   8  (disc)
 * + 4  (proof len)
 * + 256 (proof)
 * + 32 (merkle_root)
 * + 32 (nullifier[0])
 * + 32 (nullifier[1])
 * + 32 (commitment_out[0])
 * + 32 (commitment_out[1])
 * + 8  (public_amount_in)
 * + 8  (public_amount_out)
 * + 32 (public_token_mint)
 * = 476  → relayer_fee u64 LE starts here for shield/transact/unshield/adapt_execute.
 *
 * The fee floor is enforced server-side; we extract directly from the bytes
 * the user submitted so the value we check is the one the proof binds.
 */

import { z } from 'zod';
import { PublicKey } from '@solana/web3.js';

export const RELAYER_FEE_OFFSET = 476;

export const AccountMetaSchema = z.object({
  pubkey: z.string().min(32).max(44),
  isSigner: z.boolean(),
  isWritable: z.boolean(),
});

const Base64String = z
  .string()
  .min(1)
  .max(2_000_000) // hard ceiling so a giant body can't exhaust memory before length checks
  .regex(/^[A-Za-z0-9+/]+={0,2}$/, 'must be base64');

export const RelayRequestSchema = z.object({
  ixData: Base64String,
  accountKeys: z.array(AccountMetaSchema).min(1).max(64),
  altAddresses: z.array(z.string().min(32).max(44)).max(8).optional(),
  computeUnitLimit: z.number().int().positive().max(1_400_000).optional(),
  /** Optional second signer (rare — most ops use relayer-only). */
  userSignature: Base64String.optional(),
  userPubkey: z.string().min(32).max(44).optional(),
});

export type RelayRequest = z.infer<typeof RelayRequestSchema>;
export type AccountMetaInput = z.infer<typeof AccountMetaSchema>;

/** Decode a base64 ixData payload. Throws on malformed input. */
export function decodeIxData(b64: string): Uint8Array {
  return Uint8Array.from(Buffer.from(b64, 'base64'));
}

/** Read u64 LE at offset. */
export function readU64Le(bytes: Uint8Array, offset: number): bigint {
  if (offset + 8 > bytes.length) {
    throw new Error(`u64 read out of bounds: offset=${offset} len=${bytes.length}`);
  }
  let v = 0n;
  for (let i = 0; i < 8; i++) {
    v |= BigInt(bytes[offset + i]!) << BigInt(8 * i);
  }
  return v;
}

/**
 * Extract relayer_fee at the known offset for shield/transact/unshield/adapt_execute.
 *
 * Returns null when the buffer is too short to contain the field — callers
 * treat this as "could not validate, reject".
 */
export function extractRelayerFee(ixData: Uint8Array): bigint | null {
  if (ixData.length < RELAYER_FEE_OFFSET + 8) return null;
  return readU64Le(ixData, RELAYER_FEE_OFFSET);
}

/** True if `key` is in the allowlist (PublicKey equality). */
export function isAllowedProgram(key: PublicKey, allowlist: PublicKey[]): boolean {
  for (const a of allowlist) if (a.equals(key)) return true;
  return false;
}

/**
 * Sanity bounds on the deserialised request. Called after zod parses the
 * envelope. Pulls the relayer-bound fee and asserts the structural minimums
 * we always expect. Does NOT verify the proof — the on-chain handler does.
 */
export function structuralChecks(req: RelayRequest, opts: {
  /** Min bytes for the smallest valid op (shield with no encrypted notes ≈ 500). */
  minIxDataLen: number;
  /** Cap on raw ix-data bytes to short-circuit obvious abuse. */
  maxIxDataLen: number;
}): { ixData: Uint8Array; accountKeys: AccountMetaInput[] } {
  const ixData = decodeIxData(req.ixData);
  if (ixData.length < opts.minIxDataLen) {
    throw new Error(`ixData too short: ${ixData.length} < ${opts.minIxDataLen}`);
  }
  if (ixData.length > opts.maxIxDataLen) {
    throw new Error(`ixData too long: ${ixData.length} > ${opts.maxIxDataLen}`);
  }
  return { ixData, accountKeys: req.accountKeys };
}

/**
 * Zod schemas for tool inputs.
 *
 * `.describe()` strings on every field — the agent uses these as natural-
 * language hints when deciding how to call a tool.
 */

import { PublicKey } from '@solana/web3.js';
import { z } from 'zod';

const Base58Pubkey = z
  .string()
  .min(32)
  .max(44)
  .refine((s) => {
    try {
      // eslint-disable-next-line no-new
      new PublicKey(s);
      return true;
    } catch {
      return false;
    }
  }, { message: 'invalid base58 pubkey' });

const U64String = z
  .string()
  .regex(/^\d+$/u, 'amount must be a non-negative integer (no decimals — use smallest units)');

export const shieldInput = z
  .object({
    mint: Base58Pubkey.describe('SPL mint pubkey of the token to shield (e.g. USDC mainnet mint)'),
    amount: U64String.describe('Amount in smallest units. For USDC (6 decimals), 1_000_000 = 1 USDC'),
  })
  .strict();

export const unshieldInput = z
  .object({
    to: Base58Pubkey.describe('Owner pubkey of the destination token account (the recipient)'),
    mint: Base58Pubkey.describe('Mint of the note being unshielded'),
  })
  .strict();

export const privateSwapInput = z
  .object({
    inMint: Base58Pubkey.describe('Mint of the IN token (a shielded note in this mint must already exist for the caller)'),
    outMint: Base58Pubkey.describe('Mint of the OUT token'),
    amount: U64String.describe('Amount of inMint to swap, in smallest units'),
    adapterProgramId: Base58Pubkey.describe('Program ID of the adapter handling the swap'),
    adapterInTa: Base58Pubkey.describe('Adapter-side scratch ATA for IN mint'),
    adapterOutTa: Base58Pubkey.describe('Adapter-side scratch ATA for OUT mint'),
    alt: Base58Pubkey.describe('Address Lookup Table that compresses the v0 tx account list'),
  })
  .strict();

export const statusInput = z.object({}).strict();

export type ShieldInput = z.infer<typeof shieldInput>;
export type UnshieldInput = z.infer<typeof unshieldInput>;
export type PrivateSwapInput = z.infer<typeof privateSwapInput>;
export type StatusInput = z.infer<typeof statusInput>;

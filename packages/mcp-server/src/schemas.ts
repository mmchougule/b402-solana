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

export const holdingsInput = z
  .object({
    mint: Base58Pubkey.optional().describe('Optional mint to filter by. Without a filter, mints are returned as opaque short labels so agents have a stable key to compare across calls.'),
    refresh: z.boolean().optional().describe('Re-sync from on-chain history before reading. Default true. Set false for a fast in-memory snapshot.'),
  })
  .strict();

export const balanceInput = z
  .object({
    mint: Base58Pubkey.optional().describe('Optional mint to filter by. With a filter, the response resolves the mint base58.'),
    refresh: z.boolean().optional().describe('Re-sync from on-chain history before reading. Default true.'),
  })
  .strict();

export const quoteSwapInput = z
  .object({
    inMint: Base58Pubkey.describe('SPL mint of the IN token'),
    outMint: Base58Pubkey.describe('SPL mint of the OUT token'),
    amount: U64String.describe('Amount of inMint to swap, in smallest units'),
    slippageBps: z.number().int().nonnegative().max(10000).optional().describe('Acceptable slippage in basis points. Default 50 (0.5%).'),
  })
  .strict();

export type ShieldInput = z.infer<typeof shieldInput>;
export type UnshieldInput = z.infer<typeof unshieldInput>;
export type PrivateSwapInput = z.infer<typeof privateSwapInput>;
export type StatusInput = z.infer<typeof statusInput>;
export type HoldingsInput = z.infer<typeof holdingsInput>;
export type BalanceInput = z.infer<typeof balanceInput>;
export type QuoteSwapInput = z.infer<typeof quoteSwapInput>;

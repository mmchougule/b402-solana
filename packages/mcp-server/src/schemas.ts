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
    inMint: Base58Pubkey.describe('Mint of the IN token (a private deposit in this mint must already exist for the caller)'),
    outMint: Base58Pubkey.describe('Mint of the OUT token'),
    amount: U64String.describe('Amount of inMint to swap, in smallest units'),
    slippageBps: z.number().int().nonnegative().max(10000).optional().describe('Slippage tolerance in basis points (1 bps = 0.01%). Default 30 (0.3%). Pool mints the output note at the slippage FLOOR (quote.outAmount × (1 − slippageBps/10000)); on-chain delivery may exceed the floor, with the difference held as shared vault dust until Phase 9 dual-note minting ships. So slippageBps == max per-swap cost the user pays. Lower = less cost but higher revert rate on volatile markets.'),
    adapterProgramId: Base58Pubkey.optional().describe('Override adapter program. Defaults to Jupiter (mainnet) or mock (devnet).'),
    adapterInTa: Base58Pubkey.optional().describe('Override adapter IN scratch ATA. Auto-derived from the adapter PDA + IN mint when omitted.'),
    adapterOutTa: Base58Pubkey.optional().describe('Override adapter OUT scratch ATA. Auto-derived from the adapter PDA + OUT mint when omitted.'),
    alt: Base58Pubkey.optional().describe('Override Address Lookup Table. Defaults to the canonical b402 ALT for the configured cluster.'),
    expectedOut: U64String.optional().describe('Override expected OUT amount (smallest units). On mainnet auto-resolved from a Jupiter quote with slippageBps applied.'),
  })
  .strict();

export const statusInput = z
  .object({
    refresh: z.boolean().optional().describe('Re-sync from on-chain history before reading. Default false (cursor-driven fast path; the persistent NoteStore already mirrors every shield/unshield/swap this client made). Set true only when notes may have arrived from another machine — under that flag we still only fetch sigs newer than the persisted cursor.'),
  })
  .strict();

export const walletBalanceInput = z.object({}).strict();

export const holdingsInput = z
  .object({
    mint: Base58Pubkey.optional().describe('Optional mint to filter by. Without a filter, mints are returned as opaque short labels so agents have a stable key to compare across calls.'),
    refresh: z.boolean().optional().describe('Re-sync from on-chain history before reading. Default false (fast in-memory snapshot, since shield/unshield already update local state). Set true only when local state may be stale.'),
  })
  .strict();

export const balanceInput = z
  .object({
    mint: Base58Pubkey.optional().describe('Optional mint to filter by. With a filter, the response resolves the mint base58.'),
    refresh: z.boolean().optional().describe('Re-sync from on-chain history before reading. Default false. Set true only when local state may be stale.'),
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

export const watchIncomingInput = z
  .object({
    cursor: z.string().optional().describe('Opaque cursor returned by a previous call. Omit on first call to read from the start.'),
    mint: Base58Pubkey.optional().describe('Optional mint filter; with a filter, the response resolves the mint to its base58 address.'),
    refresh: z.boolean().optional().describe('Re-sync from on-chain history before reading. Default false. Set true only when local state may be stale.'),
  })
  .strict();

export const privateLendInput = z
  .object({
    amount: U64String.describe('Amount to lend in raw units (smallest token denomination). E.g. for USDC (6 decimals), 1000000 = 1.00 USDC; for SOL (9 decimals), 1000000000 = 1.00 SOL. Caller must hold a spendable shielded note ≥ this amount in `mint`.'),
    mint: Base58Pubkey.optional().describe('SPL mint to lend. Default USDC mainnet (EPjFWdd5...). Pass any mint Kamino supports (SOL, JitoSOL, USDT, BONK, etc.) — the reserve is discovered on-chain via `pickBestKaminoReserveByMint`.'),
    market: Base58Pubkey.optional().describe('Pin a specific Kamino LendingMarket. Without this, the reserve with the largest available_amount across all markets wins; the alternates are returned in the response.'),
    leafIndex: z.number().int().nonnegative().optional().describe('Optional Merkle leaf index of the specific note to spend. Omit to auto-pick (exact-amount match → most-recent fallback).'),
  })
  .strict();

export const privateRedeemInput = z
  .object({
    mint: Base58Pubkey.optional().describe('Underlying mint of the position to redeem. Default USDC mainnet. Must match the mint that was lent.'),
    market: Base58Pubkey.optional().describe('Pin a specific Kamino LendingMarket (matching the one used at lend time). Without this, the deepest reserve for the mint is used.'),
    leafIndex: z.number().int().nonnegative().optional().describe('Optional Merkle leaf index of the specific voucher note to burn. Omit to use the most-recent.'),
  })
  .strict();

export type ShieldInput = z.infer<typeof shieldInput>;
export type UnshieldInput = z.infer<typeof unshieldInput>;
export type PrivateSwapInput = z.infer<typeof privateSwapInput>;
export type StatusInput = z.infer<typeof statusInput>;
export type WalletBalanceInput = z.infer<typeof walletBalanceInput>;
export type HoldingsInput = z.infer<typeof holdingsInput>;
export type BalanceInput = z.infer<typeof balanceInput>;
export type QuoteSwapInput = z.infer<typeof quoteSwapInput>;
export type WatchIncomingInput = z.infer<typeof watchIncomingInput>;
export type PrivateLendInput = z.infer<typeof privateLendInput>;
export type PrivateRedeemInput = z.infer<typeof privateRedeemInput>;

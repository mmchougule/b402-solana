import { PublicKey } from '@solana/web3.js';
import type { B402Context } from '../context.js';
import type { QuoteSwapInput } from '../schemas.js';

export async function handleQuoteSwap(
  ctx: B402Context,
  input: QuoteSwapInput,
): Promise<{
  cluster: string;
  inMint: string;
  outMint: string;
  inAmount: string;
  outAmount: string;
  otherAmountThreshold: string;
  slippageBps: number;
  priceImpactPct: string;
  routeHops: number;
  contextSlot?: number;
}> {
  const q = await ctx.b402.quoteSwap({
    inMint: new PublicKey(input.inMint),
    outMint: new PublicKey(input.outMint),
    amount: BigInt(input.amount),
    slippageBps: input.slippageBps,
  });
  return { cluster: ctx.cluster, ...q };
}

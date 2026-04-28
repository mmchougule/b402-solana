import { PublicKey } from '@solana/web3.js';
import type { B402Context } from '../context.js';
import type { HoldingsInput } from '../schemas.js';

export async function handleHoldings(
  ctx: B402Context,
  input: HoldingsInput,
): Promise<{
  cluster: string;
  holdings: Array<{ id: string; mint: string; amount: string }>;
}> {
  const r = await ctx.b402.holdings({
    mint: input.mint ? new PublicKey(input.mint) : undefined,
    refresh: input.refresh,
  });
  return { cluster: ctx.cluster, holdings: r.holdings };
}

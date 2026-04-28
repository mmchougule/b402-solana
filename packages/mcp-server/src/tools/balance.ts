import { PublicKey } from '@solana/web3.js';
import type { B402Context } from '../context.js';
import type { BalanceInput } from '../schemas.js';

export async function handleBalance(
  ctx: B402Context,
  input: BalanceInput,
): Promise<{
  cluster: string;
  balances: Array<{ mint: string; amount: string; depositCount: number }>;
}> {
  const r = await ctx.b402.balance({
    mint: input.mint ? new PublicKey(input.mint) : undefined,
    refresh: input.refresh,
  });
  return { cluster: ctx.cluster, balances: r.balances };
}

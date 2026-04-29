import type { B402Context } from '../context.js';

export async function handleWalletBalance(
  ctx: B402Context,
): Promise<{
  cluster: string;
  walletPubkey: string;
  sol: { amount: string; decimals: 9 };
  tokens: Array<{ mint: string; amount: string; decimals: number; tokenAccount: string }>;
}> {
  return ctx.b402.walletBalance();
}

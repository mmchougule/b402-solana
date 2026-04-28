import type { B402Context } from '../context.js';

export async function handleStatus(ctx: B402Context): Promise<{
  cluster: string;
  walletPubkey: string;
  balances: Array<{ mint: string; amount: string; depositCount: number }>;
}> {
  return ctx.b402.status();
}

import type { B402Context } from '../context.js';

export async function handleStatus(ctx: B402Context): Promise<{
  cluster: string;
  spendingPub: string;
  viewingPub: string;
  walletPubkey: string;
  balances: Array<{ mint: string; amount: string; noteCount: number }>;
}> {
  const status = await ctx.b402.status();
  return {
    cluster: status.cluster,
    spendingPub: status.spendingPub,
    viewingPub: status.viewingPub,
    walletPubkey: ctx.b402.keypair.publicKey.toBase58(),
    balances: status.balances,
  };
}

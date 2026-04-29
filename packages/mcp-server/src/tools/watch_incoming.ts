import { PublicKey } from '@solana/web3.js';
import type { B402Context } from '../context.js';
import type { WatchIncomingInput } from '../schemas.js';

export async function handleWatchIncoming(
  ctx: B402Context,
  input: WatchIncomingInput,
): Promise<{
  cluster: string;
  incoming: Array<{ id: string; mint: string; amount: string; receivedAt: number }>;
  cursor: string;
}> {
  const r = await ctx.b402.watchIncoming({
    cursor: input.cursor,
    mint: input.mint ? new PublicKey(input.mint) : undefined,
    refresh: input.refresh,
  });
  return { cluster: ctx.cluster, ...r };
}

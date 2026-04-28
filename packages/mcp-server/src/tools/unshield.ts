import { PublicKey } from '@solana/web3.js';
import type { B402Context } from '../context.js';
import type { UnshieldInput } from '../schemas.js';

export async function handleUnshield(
  ctx: B402Context,
  input: UnshieldInput,
): Promise<{
  signature: string;
  cluster: string;
}> {
  const result = await ctx.b402.unshield({
    to: new PublicKey(input.to),
    mint: new PublicKey(input.mint),
  });
  return {
    signature: result.signature,
    cluster: ctx.cluster,
  };
}

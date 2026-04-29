import { PublicKey } from '@solana/web3.js';
import type { B402Context } from '../context.js';
import type { ShieldInput } from '../schemas.js';

export async function handleShield(
  ctx: B402Context,
  input: ShieldInput,
): Promise<{
  signature: string;
  commitment: string;
  leafIndex: string;
  cluster: string;
}> {
  const result = await ctx.b402.shield({
    mint: new PublicKey(input.mint),
    amount: BigInt(input.amount),
  });
  return {
    signature: result.signature,
    commitment: result.commitment.toString(),
    leafIndex: result.leafIndex.toString(),
    cluster: ctx.cluster,
  };
}

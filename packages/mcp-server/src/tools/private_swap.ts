import { PublicKey } from '@solana/web3.js';
import type { B402Context } from '../context.js';
import type { PrivateSwapInput } from '../schemas.js';

export async function handlePrivateSwap(
  ctx: B402Context,
  input: PrivateSwapInput,
): Promise<{
  signature: string;
  outAmount: string;
  outCommitment: string;
  outLeafIndex: string;
  cluster: string;
}> {
  const result = await ctx.b402.privateSwap({
    inMint: new PublicKey(input.inMint),
    outMint: new PublicKey(input.outMint),
    amount: BigInt(input.amount),
    adapterProgramId: new PublicKey(input.adapterProgramId),
    adapterInTa: new PublicKey(input.adapterInTa),
    adapterOutTa: new PublicKey(input.adapterOutTa),
    alt: new PublicKey(input.alt),
  });
  return {
    signature: result.signature,
    outAmount: result.outAmount.toString(),
    outCommitment: result.outNote.commitment.toString(),
    outLeafIndex: result.outNote.leafIndex.toString(),
    cluster: ctx.cluster,
  };
}

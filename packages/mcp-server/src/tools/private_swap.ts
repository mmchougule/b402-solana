import { PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddress } from '@solana/spl-token';
import { PROGRAM_IDS, B402_ALT_DEVNET, B402_ALT_MAINNET } from '@b402ai/solana-shared';
import type { B402Context } from '../context.js';
import type { PrivateSwapInput } from '../schemas.js';

/**
 * Auto-resolves adapter / ALT / scratch ATAs / expectedOut from the configured
 * cluster so an agent only has to pass {inMint, outMint, amount}.
 *
 * - mainnet → Jupiter adapter, mainnet ALT, expectedOut from a Jupiter quote
 *   (slippageBps applied)
 * - devnet → mock adapter, devnet ALT, expectedOut defaults to amount * 2n
 *   (the SDK default — the deployed devnet mock adapter is constant-rate)
 *
 * Adapter scratch ATAs are derived from the adapter program's
 * `[b402/v1, adapter]` PDA + the corresponding mint, matching the convention
 * used by the deployed adapters on devnet (see examples/sdk-quick-swap.ts).
 */
export async function handlePrivateSwap(
  ctx: B402Context,
  input: PrivateSwapInput,
): Promise<{
  signature: string;
  outAmount: string;
  outDepositId: string;
  cluster: string;
}> {
  const cluster = ctx.cluster;
  const inMint = new PublicKey(input.inMint);
  const outMint = new PublicKey(input.outMint);
  const amount = BigInt(input.amount);

  const adapterProgramId = input.adapterProgramId
    ? new PublicKey(input.adapterProgramId)
    : new PublicKey(
        cluster === 'mainnet' ? PROGRAM_IDS.b402JupiterAdapter : PROGRAM_IDS.b402MockAdapter,
      );

  const adapterAuthority = PublicKey.findProgramAddressSync(
    [new TextEncoder().encode('b402/v1'), new TextEncoder().encode('adapter')],
    adapterProgramId,
  )[0];

  const adapterInTa = input.adapterInTa
    ? new PublicKey(input.adapterInTa)
    : await getAssociatedTokenAddress(inMint, adapterAuthority, true);

  const adapterOutTa = input.adapterOutTa
    ? new PublicKey(input.adapterOutTa)
    : await getAssociatedTokenAddress(outMint, adapterAuthority, true);

  const altStr =
    input.alt ?? (cluster === 'mainnet' ? B402_ALT_MAINNET : B402_ALT_DEVNET);
  if (!altStr) {
    throw new Error(
      `no Address Lookup Table configured for ${cluster}. Set B402_ALT_${cluster.toUpperCase()} in the SDK constants or pass alt explicitly.`,
    );
  }
  const alt = new PublicKey(altStr);

  let expectedOut: bigint | undefined;
  if (input.expectedOut) {
    expectedOut = BigInt(input.expectedOut);
  } else if (cluster === 'mainnet') {
    const slippageBps = input.slippageBps ?? 50;
    const q = await ctx.b402.quoteSwap({ inMint, outMint, amount, slippageBps });
    expectedOut = BigInt(q.otherAmountThreshold);
  }
  // On devnet without an explicit expectedOut, fall through — SDK defaults to
  // amount * 2n which matches the mock adapter's behaviour.

  const result = await ctx.b402.privateSwap({
    inMint,
    outMint,
    amount,
    adapterProgramId,
    adapterInTa,
    adapterOutTa,
    alt,
    ...(expectedOut !== undefined ? { expectedOut } : {}),
  });

  return {
    signature: result.signature,
    outAmount: result.outAmount.toString(),
    outDepositId: result.outNote.commitment.toString(16).padStart(64, '0').slice(0, 16),
    cluster,
  };
}

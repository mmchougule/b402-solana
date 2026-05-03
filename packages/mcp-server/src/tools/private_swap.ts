import { PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddress } from '@solana/spl-token';
import { PROGRAM_IDS, B402_ALT_DEVNET, B402_ALT_MAINNET } from '@b402ai/solana-shared';
import { instructionDiscriminator } from '@b402ai/solana';
import { createRpc } from '@lightprotocol/stateless.js';
import type { B402Context } from '../context.js';
import type { PrivateSwapInput } from '../schemas.js';

/**
 * Auto-resolves adapter / ALT / scratch ATAs / Jupiter route / expectedOut /
 * Photon RPC from the configured cluster so an agent only has to pass
 * {inMint, outMint, amount}.
 *
 * - mainnet → Jupiter adapter, fetches a Jupiter Phoenix-direct route,
 *   computes adapterIxData + remainingAccounts + alts inline.
 * - devnet → mock adapter, no Jupiter call (mock adapter is constant-rate).
 */
export async function handlePrivateSwap(
  ctx: B402Context,
  input: PrivateSwapInput,
): Promise<{
  signature: string;
  outAmount: string;
  outDepositId: string;
  excessOutAmount?: string;
  excessDepositId?: string;
  expectedOut?: string;
  slippageBps?: number;
  routeHops?: number;
  quoteOutAmount?: string;
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

  // Photon RPC — required for v2 nullifier address-tree non-inclusion proof.
  // Defaults to the same RPC URL (Helius mainnet has Photon co-located).
  const photonUrl = process.env.B402_PHOTON_RPC_URL ?? ctx.rpcUrl;
  const photonRpc = createRpc(ctx.rpcUrl, photonUrl);

  // ── mainnet: fetch real Jupiter route ──────────────────────────────────────
  let expectedOut: bigint | undefined;
  let adapterIxData: Uint8Array | undefined;
  let actionPayload: Uint8Array | undefined;
  let remainingAccounts: Array<{ pubkey: PublicKey; isSigner: boolean; isWritable: boolean }> | undefined;
  let extraAlts: PublicKey[] = [];
  let routeSlippageBps: number | undefined;
  let routeHops: number | undefined;
  let quoteOutAmount: bigint | undefined;

  if (cluster === 'mainnet' && adapterProgramId.equals(new PublicKey(PROGRAM_IDS.b402JupiterAdapter))) {
    // Default 30 bps. Pool currently mints output note at the slippage floor
    // (= quote.outAmount × (1 − slippageBps/10000)). The actual on-chain
    // delivery is at or above that floor; the difference accumulates as
    // shared vault dust, NOT credited to the user. So slippageBps caps the
    // per-swap "cost" the user pays. Phase 9 (dual-note minting) will mint
    // a second commitment for the excess, eliminating this loss entirely.
    // For now: 30 bps = ~0.3% max cost per swap.
    const slippageBps = input.slippageBps ?? 30;
    const route = await fetchJupiterRoute({
      inMint, outMint, amount, slippageBps, adapterAuthority,
    });
    const jupIxData = new Uint8Array(Buffer.from(route.swap.swapInstruction.data, 'base64'));
    const u32Le = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n, 0); return b; };
    const u64Le = (v: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(v, 0); return b; };
    adapterIxData = new Uint8Array(Buffer.concat([
      Buffer.from(instructionDiscriminator('execute')),
      u64Le(amount), u64Le(0n),
      u32Le(jupIxData.length), jupIxData,
    ]));
    actionPayload = jupIxData;
    remainingAccounts = route.swap.swapInstruction.accounts.map((a: any) => ({
      pubkey: new PublicKey(a.pubkey), isSigner: false, isWritable: a.isWritable,
    }));
    extraAlts = (route.swap.addressLookupTableAddresses ?? []).map((s: string) => new PublicKey(s));
    // Bind expected_out_value to slippage floor — pool enforces actual >= expected.
    expectedOut = BigInt(route.quote.otherAmountThreshold ?? route.quote.outAmount);
    routeSlippageBps = slippageBps;
    routeHops = Array.isArray(route.quote.routePlan) ? route.quote.routePlan.length : undefined;
    quoteOutAmount = BigInt(route.quote.outAmount ?? '0');
  } else if (input.expectedOut) {
    expectedOut = BigInt(input.expectedOut);
  }
  // (devnet mock adapter falls through — SDK default expectedOut = amount * 2n)

  const result = await ctx.b402.privateSwap({
    inMint,
    outMint,
    amount,
    adapterProgramId,
    adapterInTa,
    adapterOutTa,
    alt,
    photonRpc,
    ...(expectedOut !== undefined ? { expectedOut } : {}),
    ...(adapterIxData !== undefined ? { adapterIxData } : {}),
    ...(actionPayload !== undefined ? { actionPayload } : {}),
    ...(remainingAccounts !== undefined ? { remainingAccounts } : {}),
    ...(extraAlts.length > 0 ? { alts: extraAlts } : {}),
  });

  const excess = result.excessNote;
  return {
    signature: result.signature,
    outAmount: result.outAmount.toString(),
    outDepositId: result.outNote.commitment.toString(16).padStart(64, '0').slice(0, 16),
    ...(excess
      ? {
          excessOutAmount: (result.outAmount - (expectedOut ?? 0n)).toString(),
          excessDepositId: excess.commitment.toString(16).padStart(64, '0').slice(0, 16),
        }
      : {}),
    ...(expectedOut !== undefined ? { expectedOut: expectedOut.toString() } : {}),
    ...(routeSlippageBps !== undefined ? { slippageBps: routeSlippageBps } : {}),
    ...(routeHops !== undefined ? { routeHops } : {}),
    ...(quoteOutAmount !== undefined ? { quoteOutAmount: quoteOutAmount.toString() } : {}),
    cluster,
  };
}

/**
 * Fetch a Jupiter Phoenix-direct quote + swap instructions. Phoenix gives the
 * smallest swap-ix account count for SOL/USDC, which is what we need to fit
 * Phase 7B's 1232-byte tx cap. Other DEXes may require a per-call ALT
 * extension (Phase 8: per-call ALT auto-builder).
 */
async function fetchJupiterRoute(args: {
  inMint: PublicKey; outMint: PublicKey; amount: bigint;
  slippageBps: number; adapterAuthority: PublicKey;
}): Promise<{ quote: any; swap: any }> {
  const { inMint, outMint, amount, slippageBps, adapterAuthority } = args;
  const url = `https://lite-api.jup.ag/swap/v1/quote?inputMint=${inMint.toBase58()}` +
    `&outputMint=${outMint.toBase58()}&amount=${amount}` +
    `&slippageBps=${slippageBps}&onlyDirectRoutes=true&dexes=Phoenix`;
  const q = await (await fetch(url)).json() as any;
  if (!q.outAmount) {
    throw new Error(
      `no Phoenix route ${inMint.toBase58().slice(0,4)}→${outMint.toBase58().slice(0,4)} ` +
      `for ${amount}. Phase 8 will add multi-DEX routing; for now Phoenix-only.`,
    );
  }
  const swapBody = {
    quoteResponse: q,
    userPublicKey: adapterAuthority.toBase58(),
    wrapAndUnwrapSol: false,
    useSharedAccounts: false,
  };
  const s = await (await fetch('https://lite-api.jup.ag/swap/v1/swap-instructions', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(swapBody),
  })).json() as any;
  if (!s.swapInstruction) throw new Error(`Jupiter swap-instructions failed: ${JSON.stringify(s)}`);
  return { quote: q, swap: s };
}

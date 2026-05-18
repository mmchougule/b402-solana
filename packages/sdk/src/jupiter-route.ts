/**
 * Jupiter route fetcher used by `B402Solana.swap()`. Self-contained — no
 * SDK-specific deps so it can be used standalone if a caller wants to
 * pre-fetch a route and then construct a custom `privateSwap` ix.
 *
 * Routes go through Jupiter Lite API. Defaults to Phoenix-only direct
 * routes because Phoenix has the smallest swap-ix account count for
 * SOL/USDC, which fits the v0-tx 1232 B cap without per-call ALT
 * extension. Override `dexes` for other venues.
 */

import { PublicKey } from '@solana/web3.js';

export interface JupiterRouteRequest {
  inMint: PublicKey;
  outMint: PublicKey;
  amount: bigint;
  /** Slippage in basis points. 30 = 0.3%. */
  slippageBps: number;
  /** Pubkey Jupiter binds the swap to. For b402 this is the adapter
   *  authority PDA so the swap proceeds end up in the adapter scratch
   *  ATA owned by that PDA. */
  userPublicKey: PublicKey;
  /** Comma-separated DEX allowlist, e.g. "Phoenix" or "Phoenix,Raydium".
   *  Default Phoenix. Pass `undefined` to allow all integrated DEXes
   *  (route plan may exceed v0-tx cap). */
  dexes?: string;
  /** Whether to limit Jupiter to single-hop routes. Default true (multi-hop
   *  blows past tx-size cap on most pairs). */
  onlyDirectRoutes?: boolean;
  /** Jupiter's tx-size pre-filter — only returns routes whose total account
   *  count is ≤ this number. Useful for wrapped-in-pool swaps where we add
   *  pool/adapter/nullifier overhead on top of Jupiter's route. Defaults to
   *  the Jupiter API default (64). Set to ~40 for routes that go through
   *  b402's adapt_execute + create_nullifier sibling-ix (those add ~20-25
   *  accounts of overhead before ALT compaction). */
  maxAccounts?: number;
}

export interface JupiterRouteResponse {
  /** Raw Jupiter quote response (route plan, expected amounts, etc.). */
  quote: {
    outAmount: string;
    otherAmountThreshold?: string;
    routePlan?: unknown[];
    [k: string]: unknown;
  };
  /** Raw Jupiter swap-instructions response. */
  swap: {
    swapInstruction: {
      data: string; // base64
      accounts: Array<{ pubkey: string; isSigner: boolean; isWritable: boolean }>;
    };
    addressLookupTableAddresses?: string[];
    [k: string]: unknown;
  };
}

/** Two-step Jupiter request: GET /quote → POST /swap-instructions. */
export async function fetchJupiterRoute(
  req: JupiterRouteRequest,
): Promise<JupiterRouteResponse> {
  // Defaults aligned with what Jupiter's web UI uses: multi-hop allowed, no
  // dex filter. The old `onlyDirectRoutes=true` + `dexes='Phoenix'` defaults
  // worked for early demos with USDC↔SOL but reject every multi-hop token
  // (PUMP, HYPE, JTO, RENDER, PYTH, KALSHI — all route via Quantum / GoonFi /
  // SolFi / HumidiFi via multi-hop). Callers can still narrow via `dexes`.
  const onlyDirect = req.onlyDirectRoutes ?? false;
  // Empty / undefined `dexes` → OMIT the param entirely. Sending `dexes=`
  // makes Jupiter interpret it as "no DEX allowed" → NO-ROUTE.
  const dexesParam = (req.dexes && req.dexes.length > 0)
    ? `&dexes=${encodeURIComponent(req.dexes)}`
    : '';
  const maxAccountsParam = req.maxAccounts !== undefined
    ? `&maxAccounts=${req.maxAccounts}`
    : '';
  const url =
    `https://lite-api.jup.ag/swap/v1/quote?inputMint=${req.inMint.toBase58()}` +
    `&outputMint=${req.outMint.toBase58()}` +
    `&amount=${req.amount}` +
    `&slippageBps=${req.slippageBps}` +
    `&onlyDirectRoutes=${onlyDirect ? 'true' : 'false'}` +
    dexesParam +
    maxAccountsParam;
  const quoteRes = await fetch(url);
  if (!quoteRes.ok) throw new Error(`Jupiter quote ${quoteRes.status}: ${await quoteRes.text().catch(() => '')}`);
  const quote = (await quoteRes.json()) as JupiterRouteResponse['quote'];
  if (!quote.outAmount) {
    throw new Error(
      `no Jupiter route ${req.inMint.toBase58().slice(0, 4)}→${req.outMint.toBase58().slice(0, 4)} ` +
      `for ${req.amount} via dexes=[${req.dexes ?? '(none — multi-hop allowed)'}] (onlyDirect=${onlyDirect}). Try widening dexes or disabling direct-only.`,
    );
  }
  const swapBody = {
    quoteResponse: quote,
    userPublicKey: req.userPublicKey.toBase58(),
    wrapAndUnwrapSol: false,
    useSharedAccounts: false,
  };
  const swapRes = await fetch('https://lite-api.jup.ag/swap/v1/swap-instructions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(swapBody),
  });
  if (!swapRes.ok) throw new Error(`Jupiter swap-instructions ${swapRes.status}`);
  const swap = (await swapRes.json()) as JupiterRouteResponse['swap'];
  if (!swap.swapInstruction) throw new Error(`Jupiter swap-instructions returned no swapInstruction: ${JSON.stringify(swap)}`);
  return { quote, swap };
}

/**
 * Minimal x402 wire types + builders for the provider side.
 *
 * The shapes mirror what pay.sh's catalog snapshots and what the
 * Coinbase x402 reference uses. Verified empirically in the spike
 * (PHASE-11 §2). We deliberately implement only the slice this demo
 * needs:
 *   - server emits a 402 with `accepts: [...]`
 *   - client retries with `X-PAYMENT: <base64 PaymentPayload>`
 *   - server decodes, settles, serves
 *
 * Schemes we understand: `exact` only. Networks: arbitrary CAIP-2
 * strings; we don't gate on them here so a provider can declare
 * mainnet + devnet alongside each other and let the client pick.
 */

/** Subset of CAIP-2 strings used in the x402 / pay.sh ecosystem. */
export type Network =
  | `solana:${string}`
  | `eip155:${string | number}`;

export interface PaymentRequirement {
  scheme: 'exact';
  network: Network;
  /** Currency code. `"usdc"` is the only one supported at present. */
  asset: 'usdc';
  /** Wallet pubkey (Solana) or 0x address (EVM) the payment must arrive at. */
  payTo: string;
  /** Amount in the asset's smallest unit, as a string (u64-safe). */
  amount: string;
  /** Soft expiry. Default 300 (matches pay.sh defaults). */
  maxTimeoutSeconds?: number;
  /** Free-form scheme-specific payload. Empty {} for `exact`. */
  extra?: Record<string, unknown>;
  /** Human-readable; surfaced in client UIs. */
  description?: string;
  /** The resource being paid for (e.g. the request URL). */
  resource?: string;
  /** MIME type of the resource the server will return. */
  mimeType?: string;
}

export interface PaymentRequiredBody {
  x402Version: 1;
  accepts: PaymentRequirement[];
  /** Short error string surfaced in the 402 response. */
  error: string;
}

export interface PaymentPayload {
  x402Version: 1;
  scheme: 'exact';
  network: Network;
  payload: {
    /** Base64 of the fully-signed Solana VersionedTransaction or legacy Transaction. */
    transaction: string;
  };
}

/** Build the JSON body the server returns with HTTP 402. */
export function buildPaymentRequired(
  accepts: PaymentRequirement[],
  error = 'Payment required',
): PaymentRequiredBody {
  if (accepts.length === 0) {
    throw new Error('buildPaymentRequired: at least one accepts entry required');
  }
  return { x402Version: 1, accepts: accepts.map(normalize), error };
}

function normalize(p: PaymentRequirement): PaymentRequirement {
  return {
    scheme: p.scheme,
    network: p.network,
    asset: p.asset,
    payTo: p.payTo,
    amount: p.amount,
    maxTimeoutSeconds: p.maxTimeoutSeconds ?? 300,
    extra: p.extra ?? {},
    ...(p.description !== undefined ? { description: p.description } : {}),
    ...(p.resource !== undefined ? { resource: p.resource } : {}),
    ...(p.mimeType !== undefined ? { mimeType: p.mimeType } : {}),
  };
}

/**
 * Decode the value of an `X-PAYMENT` header into a typed `PaymentPayload`.
 *
 * Validation:
 *   - base64-decodable
 *   - JSON-parseable
 *   - x402Version === 1
 *   - scheme === 'exact'
 *   - network is non-empty string
 *   - payload.transaction is non-empty base64 string
 *
 * Anything else throws — callers should catch and return 400.
 */
export function decodePaymentHeader(header: string): PaymentPayload {
  if (!header) throw new Error('x402: empty X-PAYMENT header');
  let decoded: string;
  try {
    decoded = Buffer.from(header, 'base64').toString('utf8');
  } catch {
    throw new Error('x402: X-PAYMENT is not valid base64');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded);
  } catch {
    throw new Error('x402: X-PAYMENT body is not valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('x402: X-PAYMENT body must be an object');
  }
  const p = parsed as Record<string, unknown>;
  if (p.x402Version !== 1) {
    throw new Error(`x402: unsupported x402Version ${String(p.x402Version)}`);
  }
  if (p.scheme !== 'exact') {
    throw new Error(`x402: scheme '${String(p.scheme)}' not supported (expected 'exact')`);
  }
  if (typeof p.network !== 'string' || p.network.length === 0) {
    throw new Error('x402: network missing');
  }
  const inner = p.payload as Record<string, unknown> | undefined;
  if (!inner || typeof inner.transaction !== 'string' || inner.transaction.length === 0) {
    throw new Error('x402: payload.transaction missing');
  }
  return {
    x402Version: 1,
    scheme: 'exact',
    network: p.network as Network,
    payload: { transaction: inner.transaction },
  };
}

/** Encode a PaymentPayload back into an X-PAYMENT header value. Useful for clients. */
export function encodePaymentHeader(p: PaymentPayload): string {
  return Buffer.from(JSON.stringify(p), 'utf8').toString('base64');
}

/** CAIP-2 network strings for the Solana clusters the b402 pool is deployed on. */
export const SOLANA_NETWORKS = {
  mainnet: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp' as Network,
  /** Devnet's CAIP-2 prefix (genesis hash short form). Known constant. */
  devnet: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1' as Network,
} as const;

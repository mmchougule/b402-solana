/**
 * paysh-send — private USDC transfer over x402.
 *
 * Endpoints:
 *   GET  /healthz       — liveness probe
 *   GET  /openapi.json  — static OpenAPI 3.1 spec
 *   GET  /              — service summary
 *   POST /send          — x402-gated; pay (principal + fee) USDC, receive
 *                         principal at recipient. Fee schedule mirrors the
 *                         EVM-side b402 deployment: 0.05 USDC base plus
 *                         0.05% (<$1k), 0.08% (<$10k), 0.10% (>=$10k).
 *
 * Flow on POST /send:
 *   1. Body { to, amount } → 402 with payTo + total = amount + fee
 *   2. Client retries with X-PAYMENT (signed SPL transfer of total)
 *   3. Server verifies the payment landed
 *   4. Server shields `principal` (fee stays as plain USDC at operator ATA)
 *   5. Server unshields `principal` to `to` via the hosted relayer (so the
 *      operator's wallet does not appear on the spend tx)
 *   6. Returns { paymentSig, shieldSig, unshieldSig, recipient, principal, fee }
 *
 * Concurrency: shield + unshield use the SDK's internal note state, which
 * is not safe under concurrent calls. Requests are serialized by an
 * in-process mutex. Throughput ≈ 1 / (proof_gen + confirm) ≈ 1 / 5s.
 */

import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import {
  getAssociatedTokenAddressSync,
  getOrCreateAssociatedTokenAccount,
} from '@solana/spl-token';
import { createRpc } from '@lightprotocol/stateless.js';

import { B402Solana } from '@b402ai/solana';
import { B402_ALT_MAINNET, B402_ALT_DEVNET } from '@b402ai/solana-shared';
import {
  buildPaymentRequired,
  decodePaymentHeader,
  verifyPayment,
  SOLANA_NETWORKS,
  type Network,
  type PaymentPayload,
  type PaymentRequirement,
} from '@b402ai/paysh-shield';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── config ──────────────────────────────────────────────────────────
const CLUSTER = (process.env.CLUSTER ?? 'mainnet') as 'mainnet' | 'devnet';
const RPC_URL = requireEnv('RPC_URL', 'Photon-enabled provider (Helius/Triton)');
const KEYPAIR_BASE64 = requireEnv(
  'B402_OPERATOR_KEYPAIR_BASE64',
  'base64(<keypair-json-array>)',
);
const USDC_MINT = new PublicKey(
  process.env.B402_USDC_MINT ??
    (CLUSTER === 'mainnet'
      ? 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
      : '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'),
);
const PORT = Number(process.env.PORT ?? 8080);
const HOST = process.env.HOST ?? '0.0.0.0';
const NETWORK: Network =
  CLUSTER === 'mainnet' ? SOLANA_NETWORKS.mainnet : SOLANA_NETWORKS.devnet;
// Hosted relayer defaults from packages/mcp-server/src/context.ts.
const RELAYER_HTTP_URL =
  process.env.B402_RELAYER_HTTP_URL ??
  (CLUSTER === 'mainnet'
    ? 'https://b402-solana-relayer-mainnet-62092339396.us-central1.run.app'
    : 'https://b402-solana-relayer-devnet-62092339396.us-central1.run.app');
const RELAYER_API_KEY =
  process.env.B402_RELAYER_API_KEY ??
  (CLUSTER === 'mainnet' ? 'kp_53d31f4d4b758ea2' : 'kp_8a28d0e86074cde3');
const ALT = new PublicKey(CLUSTER === 'mainnet' ? B402_ALT_MAINNET : B402_ALT_DEVNET);
const CIRCUITS =
  process.env.B402_CIRCUITS_ROOT ??
  path.resolve(__dirname, '../../../circuits/build');

// Fee schedule, in USDC smallest units (USDC has 6 decimals).
const FEE_BASE_MICRO = 50_000n;       // 0.05 USDC
const TIER_1K_MICRO = 1_000_000_000n;  // 1,000 USDC
const TIER_10K_MICRO = 10_000_000_000n; // 10,000 USDC
const BPS_DENOM = 10_000n;
function calcFee(principal: bigint): bigint {
  let bps: bigint;
  if (principal < TIER_1K_MICRO) bps = 5n;
  else if (principal < TIER_10K_MICRO) bps = 8n;
  else bps = 10n;
  return FEE_BASE_MICRO + (principal * bps) / BPS_DENOM;
}

const MIN_PRINCIPAL_MICRO = 10_000n;        // 0.01 USDC
const MAX_PRINCIPAL_MICRO = 100_000_000_000n; // 100,000 USDC

async function main(): Promise<void> {
  const operator = Keypair.fromSecretKey(
    new Uint8Array(JSON.parse(Buffer.from(KEYPAIR_BASE64, 'base64').toString('utf8'))),
  );
  const conn = new Connection(RPC_URL, 'confirmed');
  const ata = getAssociatedTokenAddressSync(USDC_MINT, operator.publicKey);

  console.log(`[boot] cluster=${CLUSTER}`);
  console.log(`[boot] operator=${operator.publicKey.toBase58()}`);
  console.log(`[boot] ata=${ata.toBase58()}`);
  console.log(`[boot] relayer=${RELAYER_HTTP_URL}`);

  await getOrCreateAssociatedTokenAccount(conn, operator, USDC_MINT, operator.publicKey);

  const b402 = new B402Solana({
    cluster: CLUSTER === 'mainnet' ? 'mainnet' : 'devnet',
    rpcUrl: RPC_URL,
    keypair: operator,
    proverArtifacts: {
      wasmPath: path.join(CIRCUITS, 'transact_js/transact.wasm'),
      zkeyPath: path.join(CIRCUITS, 'ceremony/transact_final.zkey'),
    },
    relayerHttpUrl: RELAYER_HTTP_URL,
    relayerApiKey: RELAYER_API_KEY,
  });
  await b402.ready();
  const photonRpc = createRpc(RPC_URL, RPC_URL);
  console.log(`[boot] b402 ready, photon wired`);

  const openapi = buildOpenApi();
  const mutex = new Mutex();

  const server = http.createServer((req, res) => {
    void route(req, res, {
      conn, b402, photonRpc, operator, ata, openapi, mutex,
    }).catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[err] ${req.method} ${req.url}: ${msg}`);
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ error: msg }));
      }
    });
  });
  server.listen(PORT, HOST, () => console.log(`[boot] listening on http://${HOST}:${PORT}`));

  const stop = async (signal: string) => {
    console.log(`[shutdown] ${signal}`);
    server.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void stop('SIGINT'));
  process.on('SIGTERM', () => void stop('SIGTERM'));
}

interface RouteCtx {
  conn: Connection;
  b402: B402Solana;
  photonRpc: ReturnType<typeof createRpc>;
  operator: Keypair;
  ata: PublicKey;
  openapi: object;
  mutex: Mutex;
}

async function route(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: RouteCtx,
): Promise<void> {
  if (req.method === 'GET' && req.url === '/healthz') {
    return jsonRes(res, 200, { ok: true });
  }
  if (req.method === 'GET' && req.url === '/openapi.json') {
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.setHeader('cache-control', 'public, max-age=300');
    res.end(JSON.stringify(ctx.openapi));
    return;
  }
  if (req.method === 'GET' && req.url === '/') {
    return jsonRes(res, 200, {
      service: 'paysh-send',
      description: 'Private USDC transfer over x402.',
      endpoints: { send: 'POST /send', spec: 'GET /openapi.json', health: 'GET /healthz' },
      operator: ctx.operator.publicKey.toBase58(),
    });
  }
  if (req.method === 'POST' && req.url === '/send') {
    return handleSend(req, res, ctx);
  }
  jsonRes(res, 404, { error: 'not found' });
}

async function handleSend(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: RouteCtx,
): Promise<void> {
  const raw = await readBody(req);
  let to: PublicKey;
  let principal: bigint;
  try {
    const j = JSON.parse(raw || '{}') as { to?: string; amount?: string };
    if (typeof j.to !== 'string' || typeof j.amount !== 'string') {
      throw new Error('expected { "to": "<base58>", "amount": "<u64-string>" }');
    }
    to = new PublicKey(j.to);
    principal = BigInt(j.amount);
  } catch (err) {
    return jsonRes(res, 400, { error: err instanceof Error ? err.message : String(err) });
  }
  if (principal < MIN_PRINCIPAL_MICRO) {
    return jsonRes(res, 400, {
      error: `amount below minimum (${MIN_PRINCIPAL_MICRO.toString()} micro-USDC = 0.01 USDC)`,
    });
  }
  if (principal > MAX_PRINCIPAL_MICRO) {
    return jsonRes(res, 400, {
      error: `amount above maximum (${MAX_PRINCIPAL_MICRO.toString()} micro-USDC).`,
    });
  }

  const fee = calcFee(principal);
  const total = principal + fee;
  const requirement: PaymentRequirement = {
    scheme: 'exact',
    network: NETWORK,
    asset: 'usdc',
    payTo: ctx.operator.publicKey.toBase58(),
    amount: total.toString(),
    description: `Private USDC transfer of ${formatUsdc(principal)} to ${to.toBase58().slice(0, 8)}…; fee ${formatUsdc(fee)}`,
    extra: {
      recipient: to.toBase58(),
      principal: principal.toString(),
      fee: fee.toString(),
    },
  };

  const xpay = req.headers['x-payment'];
  if (typeof xpay !== 'string' || !xpay) {
    return jsonRes(res, 402, buildPaymentRequired([requirement]));
  }

  let payload: PaymentPayload;
  try {
    payload = decodePaymentHeader(xpay);
  } catch (err) {
    return jsonRes(res, 400, { error: err instanceof Error ? err.message : String(err) });
  }

  const verify = await verifyPayment(payload, {
    connection: ctx.conn,
    mint: USDC_MINT,
    payTo: ctx.operator.publicKey,
    expectedAmount: total,
  });
  if (!verify.ok) {
    return jsonRes(res, verify.status, { error: verify.error });
  }

  const release = await ctx.mutex.lock();
  try {
    console.log(`[send] payment ok ${verify.txSig.slice(0, 12)}… principal=${principal} fee=${fee}`);
    const shieldRes = await ctx.b402.shield({ mint: USDC_MINT, amount: principal });
    console.log(`[send] shielded ${shieldRes.signature.slice(0, 12)}… commitment=0x${shieldRes.commitment.toString(16)}`);
    const unshieldRes = await ctx.b402.unshield({
      to,
      mint: USDC_MINT,
      photonRpc: ctx.photonRpc,
      alt: ALT,
      inlineCpiNullifier: true,
    });
    console.log(`[send] unshielded ${unshieldRes.signature.slice(0, 12)}… → ${to.toBase58().slice(0, 12)}…`);
    return jsonRes(res, 200, {
      paymentSig: verify.txSig,
      shieldSig: shieldRes.signature,
      unshieldSig: unshieldRes.signature,
      recipient: to.toBase58(),
      principal: principal.toString(),
      fee: fee.toString(),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[send] FAILED post-payment ${verify.txSig}: ${msg}`);
    return jsonRes(res, 502, {
      error: `payment received but processing failed: ${msg}`,
      paymentSig: verify.txSig,
      recipient: to.toBase58(),
      principal: principal.toString(),
    });
  } finally {
    release();
  }
}

function buildOpenApi(): object {
  return {
    openapi: '3.1.0',
    info: {
      title: 'paysh-send',
      version: '0.0.1',
      description:
        'Private USDC transfer over x402. Pay (principal + fee) USDC; ' +
        'recipient receives principal with no on-chain link to payer. ' +
        'Routed through the b402 shielded pool on Solana.',
    },
    servers: [{ url: '/' }],
    paths: {
      '/send': {
        post: {
          summary: 'Send USDC privately to a recipient',
          description:
            'Two-shot x402 flow. First request returns 402 with the total ' +
            'price (principal + fee). Retry with X-PAYMENT header (base64 ' +
            'PaymentPayload) to settle.',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['to', 'amount'],
                  properties: {
                    to: { type: 'string', description: 'Recipient base58 pubkey.' },
                    amount: {
                      type: 'string',
                      description: 'Principal in USDC smallest units (1_000_000 = 1 USDC).',
                    },
                  },
                },
              },
            },
          },
          responses: {
            '200': {
              description: 'Transfer settled.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      paymentSig: { type: 'string' },
                      shieldSig: { type: 'string' },
                      unshieldSig: { type: 'string' },
                      recipient: { type: 'string' },
                      principal: { type: 'string' },
                      fee: { type: 'string' },
                    },
                  },
                },
              },
            },
            '402': { description: 'Payment required (x402).' },
            '400': { description: 'Bad request body.' },
            '502': { description: 'Payment received but settle/unshield failed.' },
          },
        },
      },
    },
  };
}

class Mutex {
  private chain: Promise<void> = Promise.resolve();
  async lock(): Promise<() => void> {
    let release: () => void = () => {};
    const next = new Promise<void>((res) => { release = res; });
    const previous = this.chain;
    this.chain = previous.then(() => next);
    await previous;
    return release;
  }
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (c) => {
      total += (c as Buffer).length;
      if (total > 8192) reject(new Error('body too large'));
      else chunks.push(c as Buffer);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function jsonRes(res: http.ServerResponse, status: number, body: object): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
}

function formatUsdc(micro: bigint): string {
  const whole = micro / 1_000_000n;
  const frac = micro % 1_000_000n;
  return `${whole.toString()}.${frac.toString().padStart(6, '0')} USDC`;
}

function requireEnv(name: string, hint = ''): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required. ${hint}`.trim());
  return v;
}

main().catch((err) => {
  console.error('[fatal]', err instanceof Error ? err.message : err);
  process.exit(1);
});

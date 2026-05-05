/**
 * paysh demo server — deployable single-process HTTP + bridge.
 *
 * Endpoints:
 *   GET /healthz          — liveness probe
 *   GET /openapi.json     — static OpenAPI 3.1 spec
 *   GET /weather/{city}   — x402-gated, 0.001 USDC per call
 *
 * Bridge auto-shields every USDC transfer that lands at the operator's
 * USDC ATA into a b402-solana shielded note.
 */

import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import {
  getAssociatedTokenAddressSync,
  getOrCreateAssociatedTokenAccount,
} from '@solana/spl-token';

import { B402Solana } from '@b402ai/solana';
import {
  PayshBridge,
  buildPaymentRequired,
  decodePaymentHeader,
  makeSdkShieldFn,
  verifyPayment,
  SOLANA_NETWORKS,
  type Network,
  type PaymentPayload,
  type PaymentRequirement,
} from '@b402ai/paysh-bridge';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── config ──────────────────────────────────────────────────────────
const CLUSTER = (process.env.CLUSTER ?? 'mainnet') as 'mainnet' | 'devnet';
const RPC_URL = requireEnv('RPC_URL', 'Photon-enabled provider (Helius/Triton)');
const KEYPAIR_BASE64 = requireEnv(
  'B402_OPERATOR_KEYPAIR_BASE64',
  'base64(<keypair-json-array>) for the operator wallet',
);
const USDC_MINT = new PublicKey(
  process.env.B402_USDC_MINT ??
    (CLUSTER === 'mainnet'
      ? 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
      : '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'),
);
const PORT = Number(process.env.PORT ?? 8080);
const HOST = process.env.HOST ?? '0.0.0.0';
const PRICE_AMOUNT = '1000'; // 0.001 USDC in smallest units
const NETWORK: Network =
  CLUSTER === 'mainnet' ? SOLANA_NETWORKS.mainnet : SOLANA_NETWORKS.devnet;

// Circuits are baked into the image at /app/circuits at deploy time.
// During local `pnpm dev`, fall back to the workspace's circuits/build.
const CIRCUITS =
  process.env.B402_CIRCUITS_ROOT ??
  path.resolve(__dirname, '../../../circuits/build');

async function main(): Promise<void> {
  const operator = Keypair.fromSecretKey(
    new Uint8Array(JSON.parse(Buffer.from(KEYPAIR_BASE64, 'base64').toString('utf8'))),
  );
  const conn = new Connection(RPC_URL, 'confirmed');
  const ata = getAssociatedTokenAddressSync(USDC_MINT, operator.publicKey);

  console.log(`[boot] cluster=${CLUSTER}`);
  console.log(`[boot] operator=${operator.publicKey.toBase58()}`);
  console.log(`[boot] ata=${ata.toBase58()}`);

  // Ensure the ATA exists so SPL transfers from payers don't fail.
  await getOrCreateAssociatedTokenAccount(conn, operator, USDC_MINT, operator.publicKey);

  const b402 = new B402Solana({
    cluster: CLUSTER === 'mainnet' ? 'mainnet' : 'devnet',
    rpcUrl: RPC_URL,
    keypair: operator,
    proverArtifacts: {
      wasmPath: path.join(CIRCUITS, 'transact_js/transact.wasm'),
      zkeyPath: path.join(CIRCUITS, 'ceremony/transact_final.zkey'),
    },
  });

  const bridge = new PayshBridge({
    connection: conn,
    ingressOwner: operator.publicKey,
    ingressAta: ata,
    shield: makeSdkShieldFn(b402, USDC_MINT),
    tickIntervalMs: 30_000,
  });
  bridge.on((evt) => {
    if (evt.name === 'shielded') {
      console.log(`[bridge] shielded ${evt.txSig.slice(0, 12)}… → ${evt.commitment?.slice(0, 18)}…`);
    } else if (evt.name === 'failed') {
      console.error(`[bridge] FAILED ${evt.txSig}: ${evt.error}`);
    }
  });
  await bridge.start();
  console.log(`[boot] bridge subscribed to onLogs`);

  const requirement: PaymentRequirement = {
    scheme: 'exact',
    network: NETWORK,
    asset: 'usdc',
    payTo: operator.publicKey.toBase58(),
    amount: PRICE_AMOUNT,
    description: 'Private weather query — 0.001 USDC',
    mimeType: 'application/json',
  };

  const openapi = buildOpenApi(requirement);

  const server = http.createServer((req, res) => {
    void route(req, res, conn, requirement, USDC_MINT, operator.publicKey, openapi).catch(
      (err) => {
        const msg = err instanceof Error ? err.message : String(err);
        res.statusCode = 500;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ error: msg }));
      },
    );
  });
  server.listen(PORT, HOST, () => {
    console.log(`[boot] listening on http://${HOST}:${PORT}`);
  });

  const stop = async (signal: string) => {
    console.log(`[shutdown] ${signal}`);
    server.close();
    await bridge.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void stop('SIGINT'));
  process.on('SIGTERM', () => void stop('SIGTERM'));
}

async function route(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  conn: Connection,
  requirement: PaymentRequirement,
  mint: PublicKey,
  payTo: PublicKey,
  openapi: object,
): Promise<void> {
  if (req.method === 'GET' && req.url === '/healthz') {
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (req.method === 'GET' && req.url === '/openapi.json') {
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.setHeader('cache-control', 'public, max-age=300');
    res.end(JSON.stringify(openapi));
    return;
  }
  if (req.method !== 'GET' || !req.url?.startsWith('/weather/')) {
    res.statusCode = 404;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ error: 'not found' }));
    return;
  }
  const xpay = req.headers['x-payment'];
  if (!xpay || typeof xpay !== 'string') {
    res.statusCode = 402;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(buildPaymentRequired([requirement])));
    return;
  }
  let payload: PaymentPayload;
  try {
    payload = decodePaymentHeader(xpay);
  } catch (err) {
    res.statusCode = 400;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
    return;
  }
  const result = await verifyPayment(payload, {
    connection: conn,
    mint,
    payTo,
    expectedAmount: BigInt(requirement.amount),
  });
  if (!result.ok) {
    res.statusCode = result.status;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ error: result.error }));
    return;
  }
  const city = decodeURIComponent(req.url.split('/').pop() ?? '');
  res.statusCode = 200;
  res.setHeader('content-type', 'application/json');
  res.end(
    JSON.stringify({
      city,
      tempC: 22,
      paid: { txSig: result.txSig, amount: result.amount.toString() },
    }),
  );
}

function buildOpenApi(req: PaymentRequirement): object {
  return {
    openapi: '3.1.0',
    info: {
      title: 'paysh-demo-server',
      version: '0.0.1',
      description:
        'x402-gated weather demo backed by the b402 shielded pool. ' +
        'Payments to payTo auto-shield into a private balance.',
    },
    servers: [{ url: '/' }],
    paths: {
      '/weather/{city}': {
        get: {
          summary: 'Get weather for a city',
          description: 'Returns a JSON weather payload. Priced via x402.',
          parameters: [
            {
              name: 'city',
              in: 'path',
              required: true,
              schema: { type: 'string' },
            },
          ],
          responses: {
            '200': {
              description: 'Weather data',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      city: { type: 'string' },
                      tempC: { type: 'number' },
                      paid: {
                        type: 'object',
                        properties: {
                          txSig: { type: 'string' },
                          amount: { type: 'string' },
                        },
                      },
                    },
                  },
                },
              },
            },
            '402': {
              description: 'Payment required (x402)',
              content: {
                'application/json': {
                  schema: { type: 'object' },
                },
              },
            },
          },
          'x-payment': {
            scheme: req.scheme,
            network: req.network,
            asset: req.asset,
            amount: req.amount,
            payTo: req.payTo,
          },
        },
      },
    },
  };
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

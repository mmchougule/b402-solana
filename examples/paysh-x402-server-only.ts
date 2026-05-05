/**
 * Standalone x402-protected HTTP server, no in-process payer.
 *
 * Runs a real `paysh-bridge` against devnet so external clients (the
 * `pay` CLI, `curl`, anything that speaks x402) can hit it and pay.
 *
 * Use this to verify wire-format compatibility against the reference
 * `pay --sandbox curl` client, before publishing to pay-skills.
 *
 * Run:
 *   RPC_URL=https://devnet.helius-rpc.com/?api-key=<key> \
 *   PORT=4402 \
 *   pnpm --filter @b402ai/solana-examples paysh-x402-server
 */

import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import {
  Connection, Keypair, PublicKey, SystemProgram,
  Transaction, TransactionInstruction, ComputeBudgetProgram,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  getOrCreateAssociatedTokenAccount,
} from '@solana/spl-token';

import {
  B402Solana,
  instructionDiscriminator,
  poolConfigPda,
  tokenConfigPda,
  vaultPda,
} from '@b402ai/solana';
import {
  PayshBridge,
  buildPaymentRequired,
  decodePaymentHeader,
  makeSdkShieldFn,
  verifyPayment,
  SOLANA_NETWORKS,
  type PaymentPayload,
  type PaymentRequirement,
} from '@b402ai/paysh-bridge';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
function requireEnv(name: string, hint = ''): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required. ${hint}`.trim());
  return v;
}
const RPC_URL = requireEnv('RPC_URL', 'Use a Photon-enabled provider (Helius/Triton).');
const USDC_MINT = new PublicKey(
  process.env.B402_USDC_MINT ?? '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
);
const POOL_ID = new PublicKey('42a3hsCXtQLWonyxWZosaaCJCweYYKMrvNd25p1Jrt2y');
const CIRCUITS = path.resolve(__dirname, '../circuits/build');
const PORT = Number(process.env.PORT ?? 4402);

async function main(): Promise<void> {
  const operator = Keypair.fromSecretKey(
    new Uint8Array(JSON.parse(fs.readFileSync(path.join(os.homedir(), '.config/solana/id.json'), 'utf8'))),
  );
  const conn = new Connection(RPC_URL, 'confirmed');
  const ata = getAssociatedTokenAddressSync(USDC_MINT, operator.publicKey);

  await getOrCreateAssociatedTokenAccount(conn, operator, USDC_MINT, operator.publicKey);
  if (!(await conn.getAccountInfo(tokenConfigPda(POOL_ID, USDC_MINT)))) {
    await addTokenConfig(conn, operator, USDC_MINT);
  }

  const b402 = new B402Solana({
    cluster: 'devnet', rpcUrl: RPC_URL, keypair: operator,
    proverArtifacts: {
      wasmPath: path.join(CIRCUITS, 'transact_js/transact.wasm'),
      zkeyPath: path.join(CIRCUITS, 'ceremony/transact_final.zkey'),
    },
  });
  const bridge = new PayshBridge({
    connection: conn, ingressOwner: operator.publicKey, ingressAta: ata,
    shield: makeSdkShieldFn(b402, USDC_MINT), tickIntervalMs: 0,
  });
  bridge.on((e) => {
    if (e.name === 'shielded') console.log(`[bridge] shielded ${e.txSig.slice(0, 12)}… → ${e.commitment?.slice(0, 18)}…`);
    if (e.name === 'failed')   console.log(`[bridge] FAILED ${e.txSig}: ${e.error}`);
  });
  await bridge.start();

  const requirement: PaymentRequirement = {
    scheme: 'exact',
    network: SOLANA_NETWORKS.devnet,
    asset: 'usdc',
    payTo: operator.publicKey.toBase58(),
    amount: '1000', // 0.001 USDC
    description: 'Private weather query — 0.001 USDC',
    mimeType: 'application/json',
  };

  const server = http.createServer((req, res) => {
    void handle(req, res, conn, requirement, USDC_MINT, operator.publicKey).catch((err) => {
      res.statusCode = 500;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
    });
  });
  await new Promise<void>((r) => server.listen(PORT, '0.0.0.0', () => r()));

  console.log(`x402 server up`);
  console.log(`  url       http://127.0.0.1:${PORT}/weather/Tokyo`);
  console.log(`  payTo     ${operator.publicKey.toBase58()}`);
  console.log(`  network   ${SOLANA_NETWORKS.devnet}`);
  console.log(`  mint      ${USDC_MINT.toBase58()} (devnet USDC)`);
  console.log(`  amount    1000 micro-USDC (0.001 USDC)`);
  console.log(`\nhit me with:`);
  console.log(`  curl -i http://127.0.0.1:${PORT}/weather/Tokyo`);
  console.log(`  pay --sandbox curl http://127.0.0.1:${PORT}/weather/Tokyo`);
  console.log(`  pay curl http://127.0.0.1:${PORT}/weather/Tokyo   # uses real account`);

  const stop = async () => {
    server.close();
    await bridge.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void stop());
  process.on('SIGTERM', () => void stop());
}

async function handle(
  req: http.IncomingMessage, res: http.ServerResponse,
  conn: Connection, requirement: PaymentRequirement,
  mint: PublicKey, payTo: PublicKey,
): Promise<void> {
  // Log every incoming request so we can see exactly what `pay` sends.
  const headers = Object.fromEntries(
    Object.entries(req.headers).filter(([k]) =>
      k.toLowerCase().startsWith('x-') || k === 'user-agent' || k === 'accept',
    ),
  );
  console.log(`\n[req] ${req.method} ${req.url}`);
  console.log(`[req] headers: ${JSON.stringify(headers)}`);

  if (req.method !== 'GET' || !req.url?.startsWith('/weather/')) {
    res.statusCode = 404;
    res.end();
    return;
  }
  const xpay = req.headers['x-payment'];
  if (!xpay || typeof xpay !== 'string') {
    res.statusCode = 402;
    res.setHeader('content-type', 'application/json');
    const body = JSON.stringify(buildPaymentRequired([requirement]));
    console.log(`[res] 402: ${body}`);
    res.end(body);
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
  console.log(`[req] X-PAYMENT decoded: scheme=${payload.scheme} network=${payload.network}`);

  const result = await verifyPayment(payload, {
    connection: conn, mint, payTo,
    expectedAmount: BigInt(requirement.amount),
  });
  if (!result.ok) {
    res.statusCode = result.status;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ error: result.error }));
    console.log(`[res] ${result.status}: ${result.error}`);
    return;
  }
  res.statusCode = 200;
  res.setHeader('content-type', 'application/json');
  const body = JSON.stringify({
    city: req.url.split('/').pop(),
    tempC: 22,
    paid: { txSig: result.txSig, amount: result.amount.toString() },
  });
  res.end(body);
  console.log(`[res] 200: settled tx ${result.txSig}`);
}

async function addTokenConfig(c: Connection, admin: Keypair, mint: PublicKey): Promise<void> {
  const maxTvl = Buffer.alloc(8);
  maxTvl.writeBigUInt64LE(0xFFFFFFFFFFFFFFFFn, 0);
  const data = Buffer.concat([Buffer.from(instructionDiscriminator('add_token_config')), maxTvl]);
  const ix = new TransactionInstruction({
    programId: POOL_ID,
    keys: [
      { pubkey: admin.publicKey,                      isSigner: true,  isWritable: true  },
      { pubkey: admin.publicKey,                      isSigner: true,  isWritable: false },
      { pubkey: poolConfigPda(POOL_ID),               isSigner: false, isWritable: false },
      { pubkey: tokenConfigPda(POOL_ID, mint),        isSigner: false, isWritable: true  },
      { pubkey: mint,                                 isSigner: false, isWritable: false },
      { pubkey: vaultPda(POOL_ID, mint),              isSigner: false, isWritable: true  },
      { pubkey: TOKEN_PROGRAM_ID,                     isSigner: false, isWritable: false },
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID,          isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId,              isSigner: false, isWritable: false },
      { pubkey: new PublicKey('SysvarRent111111111111111111111111111111111'), isSigner: false, isWritable: false },
    ],
    data,
  });
  const cu = ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 });
  await sendAndConfirmTransaction(c, new Transaction().add(cu, ix), [admin]);
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });

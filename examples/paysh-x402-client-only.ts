/**
 * Client-only x402 payer for an already-deployed paysh-shield server.
 *
 * Use this to verify a deployed paysh-demo-server end-to-end:
 *   1. GET <url> — receive 402 + accepts[]
 *   2. Build a signed USDC SPL transfer to the advertised payTo
 *   3. Retry with X-PAYMENT header
 *   4. Print the resource response
 *
 * The server's bridge will independently shield the payment via its
 * onLogs subscription; tail Railway logs (or wherever you deploy) to
 * see the shielded event.
 *
 * Run:
 *   B402_SERVER_URL=https://<host>/weather/Tokyo \
 *   RPC_URL=https://mainnet.helius-rpc.com/?api-key=<key> \
 *   B402_PAYER_KEYPAIR_PATH=/path/to/payer.json \
 *   pnpm --filter @b402ai/solana-examples paysh-x402-client
 */

import fs from 'node:fs';
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import {
  createTransferInstruction,
  getAssociatedTokenAddress,
} from '@solana/spl-token';
import { encodePaymentHeader, type PaymentRequirement } from '@b402ai/paysh-shield';

const SERVER_URL = requireEnv('B402_SERVER_URL', 'e.g. https://your-host/weather/Tokyo');
const RPC_URL = requireEnv('RPC_URL', 'Photon-enabled provider');
const PAYER_KEYPAIR_PATH = requireEnv('B402_PAYER_KEYPAIR_PATH');

async function main(): Promise<void> {
  const payer = Keypair.fromSecretKey(
    new Uint8Array(JSON.parse(fs.readFileSync(PAYER_KEYPAIR_PATH, 'utf8'))),
  );
  const conn = new Connection(RPC_URL, 'confirmed');
  console.log(`payer ${payer.publicKey.toBase58()}`);
  console.log(`url   ${SERVER_URL}\n`);

  // 1. 402 challenge
  console.log('[client] GET (no payment)');
  const r1 = await fetch(SERVER_URL);
  if (r1.status !== 402) throw new Error(`expected 402, got ${r1.status}: ${await r1.text()}`);
  const challenge = (await r1.json()) as { accepts: PaymentRequirement[] };
  const accept = challenge.accepts[0];
  if (!accept) throw new Error('no accepts entry in 402 challenge');
  console.log(`         402 ← payTo=${accept.payTo} amount=${accept.amount} ${accept.asset} (${accept.network})`);

  // 2. Build + sign payment
  const mint = new PublicKey(
    accept.network === 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'
      ? 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
      : '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
  );
  const payTo = new PublicKey(accept.payTo);
  const amount = BigInt(accept.amount);

  const payerAta = await getAssociatedTokenAddress(mint, payer.publicKey);
  const operatorAta = await getAssociatedTokenAddress(mint, payTo);

  const transferIx = createTransferInstruction(payerAta, operatorAta, payer.publicKey, amount);
  const cu = ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 });
  const blockhash = (await conn.getLatestBlockhash('confirmed')).blockhash;
  const msg = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: blockhash,
    instructions: [cu, transferIx],
  }).compileToV0Message();
  const vtx = new VersionedTransaction(msg);
  vtx.sign([payer]);
  const txBase64 = Buffer.from(vtx.serialize()).toString('base64');
  console.log(`[client] signed tx (${txBase64.length} b64 chars)`);

  // 3. Retry with X-PAYMENT
  const headerVal = encodePaymentHeader({
    x402Version: 1,
    scheme: 'exact',
    network: accept.network,
    payload: { transaction: txBase64 },
  });
  console.log('[client] GET with X-PAYMENT header');
  const t0 = Date.now();
  const r2 = await fetch(SERVER_URL, { headers: { 'X-PAYMENT': headerVal } });
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  if (r2.status !== 200) {
    throw new Error(`expected 200, got ${r2.status} in ${elapsed}s: ${await r2.text()}`);
  }
  const body = await r2.text();
  console.log(`         200 in ${elapsed}s ← ${body}`);

  const parsed = JSON.parse(body);
  if (parsed.paid?.txSig) {
    console.log(`\nexplorer: https://explorer.solana.com/tx/${parsed.paid.txSig}?cluster=mainnet`);
  }
}

function requireEnv(name: string, hint = ''): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required. ${hint}`.trim());
  return v;
}

main().catch((e) => { console.error('\n❌', e instanceof Error ? e.message : e); process.exit(1); });

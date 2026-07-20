/**
 * Client for paysh-send — pay private USDC transfers via x402.
 *
 * Flow:
 *   1. POST {to, amount} → 402 with total = amount + fee
 *   2. Sign SPL transfer of total to advertised payTo
 *   3. POST again with X-PAYMENT header
 *   4. Receive 200 with paymentSig + shieldSig + unshieldSig
 *
 * Run:
 *   B402_SERVER_URL=https://<host>/send \
 *   RPC_URL=https://mainnet.helius-rpc.com/?api-key=<key> \
 *   B402_PAYER_KEYPAIR_PATH=/path/to/payer.json \
 *   B402_RECIPIENT=<base58> \
 *   B402_AMOUNT=100000 \
 *   pnpm --filter @b402ai/solana-examples paysh-send-client
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

const SERVER_URL = requireEnv('B402_SERVER_URL', 'e.g. https://your-host/send');
const RPC_URL = requireEnv('RPC_URL');
const PAYER_KEYPAIR_PATH = requireEnv('B402_PAYER_KEYPAIR_PATH');
const RECIPIENT = requireEnv('B402_RECIPIENT', 'recipient base58 pubkey');
const AMOUNT = requireEnv('B402_AMOUNT', 'principal in USDC smallest units');

async function main(): Promise<void> {
  const payer = Keypair.fromSecretKey(
    new Uint8Array(JSON.parse(fs.readFileSync(PAYER_KEYPAIR_PATH, 'utf8'))),
  );
  const conn = new Connection(RPC_URL, 'confirmed');
  console.log(`payer     ${payer.publicKey.toBase58()}`);
  console.log(`recipient ${RECIPIENT}`);
  console.log(`amount    ${AMOUNT} micro-USDC`);
  console.log(`url       ${SERVER_URL}\n`);

  const body = JSON.stringify({ to: RECIPIENT, amount: AMOUNT });

  // 1. POST to get 402
  console.log('[client] POST (no payment)');
  const r1 = await fetch(SERVER_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });
  if (r1.status !== 402) {
    throw new Error(`expected 402, got ${r1.status}: ${await r1.text()}`);
  }
  const challenge = (await r1.json()) as { accepts: PaymentRequirement[] };
  const accept = challenge.accepts[0];
  if (!accept) throw new Error('no accepts entry');
  const total = BigInt(accept.amount);
  const fee = total - BigInt(AMOUNT);
  console.log(`         402 ← payTo=${accept.payTo.slice(0, 8)}… total=${total} (principal+fee=${AMOUNT}+${fee})`);

  // 2. Sign payment
  const mint = new PublicKey(
    accept.network === 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'
      ? 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
      : '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
  );
  const payTo = new PublicKey(accept.payTo);
  const payerAta = await getAssociatedTokenAddress(mint, payer.publicKey);
  const operatorAta = await getAssociatedTokenAddress(mint, payTo);
  const transferIx = createTransferInstruction(payerAta, operatorAta, payer.publicKey, total);
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

  // 3. Retry with X-PAYMENT
  const headerVal = encodePaymentHeader({
    x402Version: 1,
    scheme: 'exact',
    network: accept.network,
    payload: { transaction: txBase64 },
  });
  console.log('[client] POST with X-PAYMENT');
  const t0 = Date.now();
  const r2 = await fetch(SERVER_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-PAYMENT': headerVal },
    body,
  });
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  if (r2.status !== 200) {
    throw new Error(`expected 200, got ${r2.status} in ${elapsed}s: ${await r2.text()}`);
  }
  const result = await r2.json();
  console.log(`         200 in ${elapsed}s\n`);
  console.log(`paymentSig  ${result.paymentSig}`);
  console.log(`shieldSig   ${result.shieldSig}`);
  console.log(`unshieldSig ${result.unshieldSig}`);
  console.log(`recipient   ${result.recipient}`);
  console.log(`principal   ${result.principal}`);
  console.log(`fee         ${result.fee}`);
  const cluster = accept.network === 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp' ? 'mainnet' : 'devnet';
  console.log(`\nexplorer:`);
  console.log(`  payment  https://explorer.solana.com/tx/${result.paymentSig}?cluster=${cluster}`);
  console.log(`  shield   https://explorer.solana.com/tx/${result.shieldSig}?cluster=${cluster}`);
  console.log(`  unshield https://explorer.solana.com/tx/${result.unshieldSig}?cluster=${cluster}`);
}

function requireEnv(name: string, hint = ''): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required. ${hint}`.trim());
  return v;
}

main().catch((e) => { console.error('\n❌', e instanceof Error ? e.message : e); process.exit(1); });

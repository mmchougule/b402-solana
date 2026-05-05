/**
 * pay.sh Private Receivables — REAL-USDC + x402 HTTP server end-to-end.
 *
 * What this demonstrates:
 *   - An operator runs an actual HTTP server with a metered endpoint.
 *   - The server returns HTTP 402 with x402 `accepts[]` listing the
 *     operator's payTo wallet, network = solana devnet, asset = usdc.
 *   - A separate "payer" keypair (= a second wallet you control) signs a
 *     real USDC SPL transfer to the operator's ingress ATA, base64-encodes
 *     it as a PaymentPayload, and retries with `X-PAYMENT: <base64>`.
 *   - The server decodes, submits, confirms, and verifies the on-chain
 *     transfer matches the challenge. On match: 200 + JSON resource.
 *   - In parallel, PayshShield's WS subscription detects the same tx
 *     and invokes B402Solana.shield(), producing a Poseidon commitment
 *     in the on-chain Merkle tree. The operator's main wallet does NOT
 *     receive the USDC; it lands as a shielded note.
 *   - The operator unshields to a fresh recipient. The recipient has
 *     zero on-chain history connecting back to the payer.
 *
 * Prerequisites (devnet defaults):
 *   - ~/.config/solana/id.json funded with ≥ 0.3 devnet SOL (operator)
 *   - B402_PAYER_KEYPAIR_PATH set to a second keypair file
 *       └ funded with ≥ 0.05 devnet SOL
 *       └ funded with ≥ 0.001 devnet USDC at mint
 *         4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU
 *         (Circle devnet faucet: https://faucet.circle.com/?tab=devnet)
 *   - RPC_URL pointing at a Photon-enabled provider (Helius/Triton).
 *     Required for the SDK's unshield (validity proof for the v2 nullifier
 *     set lives in the Light Protocol indexer).
 *
 * Run:
 *   RPC_URL=https://devnet.helius-rpc.com/?api-key=<key> \
 *   B402_PAYER_KEYPAIR_PATH=/path/to/payer.json \
 *   pnpm --filter @b402ai/solana-examples paysh-x402
 *
 * Override (mainnet, real money):
 *   CLUSTER=mainnet \
 *   B402_USDC_MINT=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v \
 *   RPC_URL=https://mainnet.helius-rpc.com/?api-key=<key> \
 *   ...
 */

import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import {
  AddressLookupTableProgram,
  ComputeBudgetProgram,
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID,
  createTransferInstruction,
  getAssociatedTokenAddress,
  getAssociatedTokenAddressSync,
  getOrCreateAssociatedTokenAccount,
} from '@solana/spl-token';
import { createRpc } from '@lightprotocol/stateless.js';
import { B402_ALT_DEVNET, B402_ALT_MAINNET } from '@b402ai/solana-shared';

import {
  B402Solana,
  instructionDiscriminator,
  poolConfigPda,
  tokenConfigPda,
  vaultPda,
} from '@b402ai/solana';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID as SPL_TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { TransactionInstruction } from '@solana/web3.js';
import {
  PayshShield,
  buildPaymentRequired,
  decodePaymentHeader,
  encodePaymentHeader,
  makeSdkShieldFn,
  verifyPayment,
  SOLANA_NETWORKS,
  type ShieldEvent,
  type Network,
  type PaymentPayload,
  type PaymentRequirement,
} from '@b402ai/paysh-shield';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── config ──────────────────────────────────────────────────────────
const CLUSTER = (process.env.CLUSTER ?? 'devnet') as 'devnet' | 'mainnet';
const RPC_URL = requireEnv(
  'RPC_URL',
  'Use a Photon-enabled provider (Helius/Triton).\n' +
    '  devnet:  RPC_URL=https://devnet.helius-rpc.com/?api-key=<key>\n' +
    '  mainnet: RPC_URL=https://mainnet.helius-rpc.com/?api-key=<key>',
);
const USDC_MINT = new PublicKey(
  process.env.B402_USDC_MINT ??
    (CLUSTER === 'devnet'
      ? '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'
      : 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'),
);
const POOL_ID = new PublicKey('42a3hsCXtQLWonyxWZosaaCJCweYYKMrvNd25p1Jrt2y');
const CIRCUITS = path.resolve(__dirname, '../circuits/build');

// 1000 micro-USDC = 0.001 USDC (= $0.001). Tiny on purpose.
const PRICE_AMOUNT = 1000n;
const PRICE_LABEL = '0.001 USDC';
const NETWORK: Network =
  CLUSTER === 'devnet' ? SOLANA_NETWORKS.devnet : SOLANA_NETWORKS.mainnet;

async function main(): Promise<void> {
  console.log('━━━ pay.sh Private Receivables — real-USDC x402 e2e ━━━\n');
  console.log(`cluster: ${CLUSTER}`);
  console.log(`rpc:     ${redact(RPC_URL)}`);
  console.log(`mint:    ${USDC_MINT.toBase58()}`);

  // ── load operator keypair (the receiver) ──────────────────────────
  const operator = loadKeypair(
    process.env.B402_OPERATOR_KEYPAIR_PATH ??
      path.join(os.homedir(), '.config/solana/id.json'),
  );
  // ── load payer keypair (the customer) ─────────────────────────────
  const payerPath = process.env.B402_PAYER_KEYPAIR_PATH;
  if (!payerPath) {
    throw new Error(
      'B402_PAYER_KEYPAIR_PATH is required. Generate one with `solana-keygen new -o /tmp/payer.json` ' +
        'and fund it: send a tiny amount of devnet SOL from your operator wallet, then ' +
        'go to https://faucet.circle.com/?tab=devnet to fund it with devnet USDC.',
    );
  }
  const payer = loadKeypair(payerPath);

  const conn = new Connection(RPC_URL, 'confirmed');

  console.log(`\noperator ${operator.publicKey.toBase58()}`);
  console.log(`payer    ${payer.publicKey.toBase58()}`);

  // ── balance preflight ─────────────────────────────────────────────
  await preflightBalances(conn, operator, payer);

  // ── derive ingress ATA + check it ─────────────────────────────────
  const operatorAta = getAssociatedTokenAddressSync(USDC_MINT, operator.publicKey);
  // Ensure the operator's USDC ATA exists so the SPL transfer doesn't fail.
  // Idempotent.
  await getOrCreateAssociatedTokenAccount(conn, operator, USDC_MINT, operator.publicKey);
  console.log(`\noperator USDC ATA  ${operatorAta.toBase58()} (this is what payers transfer to)`);

  // Pool's `token_config` for this mint must be initialized before the
  // shield ix can run. The operator is the pool admin on devnet — register
  // once if missing. Idempotent: skip if already there.
  const tcPda = tokenConfigPda(POOL_ID, USDC_MINT);
  const tcInfo = await conn.getAccountInfo(tcPda);
  if (!tcInfo) {
    console.log('  token_config not yet registered for this mint — registering once…');
    await addTokenConfig(conn, operator, USDC_MINT);
    console.log('  ✓ registered');
  }

  // ── B402Solana + shield ───────────────────────────────────────────
  const b402 = new B402Solana({
    cluster: CLUSTER === 'mainnet' ? 'mainnet' : 'devnet',
    rpcUrl: RPC_URL,
    keypair: operator,
    proverArtifacts: {
      wasmPath: path.join(CIRCUITS, 'transact_js/transact.wasm'),
      zkeyPath: path.join(CIRCUITS, 'ceremony/transact_final.zkey'),
    },
  });

  const shield = new PayshShield({
    connection: conn,
    ingressOwner: operator.publicKey,
    ingressAta: operatorAta,
    shield: makeSdkShieldFn(b402, USDC_MINT),
    tickIntervalMs: 0,
  });
  const shielded = new Promise<ShieldEvent>((resolve, reject) => {
    shield.on((e) => {
      if (e.name === 'shielded') resolve(e);
      else if (e.name === 'failed') reject(new Error(`shield failed: ${e.error}`));
    });
  });
  await shield.start();
  console.log(`shield started; payTo = ${shield.payTo()}`);

  // ── HTTP server: x402-protected /weather/:city ────────────────────
  const requirement: PaymentRequirement = {
    scheme: 'exact',
    network: NETWORK,
    asset: 'usdc',
    payTo: operator.publicKey.toBase58(),
    amount: PRICE_AMOUNT.toString(),
    description: `Private weather query — ${PRICE_LABEL}`,
    mimeType: 'application/json',
  };

  const server = http.createServer((req, res) => {
    void handleRequest(req, res, conn, requirement, USDC_MINT, operator.publicKey).catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      res.statusCode = 500;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ error: msg }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  const url = `http://127.0.0.1:${port}/weather/Tokyo`;
  console.log(`\nx402 server up at ${url}`);

  try {
    // ── client side: 402 → pay → 200 ──────────────────────────────
    console.log('\n[client] GET ' + url);
    const r1 = await fetchJson(url);
    if (r1.status !== 402) throw new Error(`expected 402, got ${r1.status}`);
    const challenge = JSON.parse(r1.body);
    const accept = challenge.accepts[0] as PaymentRequirement;
    console.log(`[client] received 402 — payTo=${accept.payTo} amount=${accept.amount} ${accept.asset}`);

    console.log('[client] building signed USDC SPL transfer…');
    const signedTxBase64 = await buildSignedPaymentTx(
      conn,
      payer,
      operator.publicKey,
      USDC_MINT,
      BigInt(accept.amount),
    );
    const paymentPayload: PaymentPayload = {
      x402Version: 1,
      scheme: 'exact',
      network: accept.network as Network,
      payload: { transaction: signedTxBase64 },
    };
    console.log('[client] retrying with X-PAYMENT header…');
    const r2 = await fetchJson(url, {
      headers: { 'X-PAYMENT': encodePaymentHeader(paymentPayload) },
    });
    if (r2.status !== 200) {
      throw new Error(`expected 200, got ${r2.status}: ${r2.body}`);
    }
    console.log(`[client] received 200 — body: ${r2.body}`);

    // ── wait for the shield to land (real Groth16 proof on chain) ────
    console.log('\nwaiting for the shield to land (Groth16 + Merkle append)…');
    const t0 = Date.now();
    const evt = await Promise.race([
      shielded,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('timeout: shield did not land within 90s')), 90_000),
      ),
    ]);
    console.log(`  ✓ shielded in ${(Date.now() - t0) / 1000}s`);
    console.log(`    txSig      ${evt.txSig}`);
    console.log(`    commitment ${evt.commitment}`);
    console.log(`    https://explorer.solana.com/tx/${evt.txSig}?cluster=${CLUSTER}`);

    // ── operator's unshield to a fresh recipient ──────────────────
    const recipient = Keypair.generate();
    console.log(`\nfresh recipient ${recipient.publicKey.toBase58()}`);
    // Mainnet has a published ALT carrying the static infra accounts —
    // use it. Devnet's published ALT was built for a fresh-mint demo so
    // doesn't cover real USDC; we build per-call there.
    let alt: PublicKey;
    if (CLUSTER === 'mainnet' && B402_ALT_MAINNET) {
      alt = new PublicKey(B402_ALT_MAINNET);
      console.log(`[operator] using published ALT ${alt.toBase58().slice(0, 12)}…`);
    } else {
      console.log('[operator] building per-call ALT…');
      const recipientAta = getAssociatedTokenAddressSync(USDC_MINT, recipient.publicKey);
      alt = await buildUnshieldAlt(conn, operator, USDC_MINT, recipientAta);
    }
    void B402_ALT_DEVNET;

    console.log('[operator] unshield…');
    const photonRpc = createRpc(RPC_URL, process.env.B402_PHOTON_RPC_URL ?? RPC_URL);
    // Both deployed pools take the inline-CPI nullifier wire shape on the
    // current build. Toggleable via env in case a future deployment differs.
    const inlineCpiNullifier =
      process.env.B402_INLINE_CPI_NULLIFIER === '0' ? false : true;
    const unshieldRes = await b402.unshield({
      to: recipient.publicKey,
      mint: USDC_MINT,
      photonRpc,
      alt,
      inlineCpiNullifier,
    });
    console.log(`  ✓ unshield tx ${unshieldRes.signature}`);
    console.log(`    https://explorer.solana.com/tx/${unshieldRes.signature}?cluster=${CLUSTER}`);

    // ── summary ───────────────────────────────────────────────────
    console.log('\n━━━ privacy summary ━━━');
    console.log(`payer     → operator ATA  visible: ${truncSig(evt.txSig)}`);
    console.log(`shielded  → fresh wallet  visible: ${truncSig(unshieldRes.signature)}`);
    console.log('   the only on-chain link is payer→ingress (necessarily visible).');
    console.log('   the recipient wallet has no edge to the payer. ✓');
    console.log('   the operator\'s public balance never increased — payment lives as a');
    console.log('   shielded commitment until the operator chooses where it lands.');
  } finally {
    server.close();
    await shield.stop();
  }
}

// ─── HTTP handler ────────────────────────────────────────────────────
async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  conn: Connection,
  requirement: PaymentRequirement,
  mint: PublicKey,
  payTo: PublicKey,
): Promise<void> {
  if (req.method !== 'GET' || !req.url?.startsWith('/weather/')) {
    res.statusCode = 404;
    res.end();
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

  // Resource served. Hard-coded weather for the demo.
  const city = req.url.split('/').pop() ?? 'Unknown';
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

// ─── helpers ─────────────────────────────────────────────────────────
function requireEnv(name: string, hint = ''): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required. ${hint}`.trim());
  return v;
}

function loadKeypair(p: string): Keypair {
  const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  return Keypair.fromSecretKey(new Uint8Array(raw));
}

async function preflightBalances(
  conn: Connection,
  operator: Keypair,
  payer: Keypair,
): Promise<void> {
  const [opSol, payerSol] = await Promise.all([
    conn.getBalance(operator.publicKey),
    conn.getBalance(payer.publicKey),
  ]);
  console.log(`  operator SOL ${(opSol / LAMPORTS_PER_SOL).toFixed(3)}`);
  console.log(`  payer    SOL ${(payerSol / LAMPORTS_PER_SOL).toFixed(3)}`);
  if (opSol < 0.05 * LAMPORTS_PER_SOL) {
    throw new Error('operator wallet needs ≥ 0.05 SOL (proof + ALT rent)');
  }
  if (payerSol < 0.005 * LAMPORTS_PER_SOL) {
    throw new Error(
      `payer wallet needs ≥ 0.005 SOL for tx fees. Send some from the operator: \n` +
        `  solana transfer ${payer.publicKey.toBase58()} 0.01 --allow-unfunded-recipient`,
    );
  }
  // Check payer has USDC.
  const payerAta = getAssociatedTokenAddressSync(USDC_MINT, payer.publicKey);
  const ai = await conn.getParsedAccountInfo(payerAta);
  const usdc =
    (ai.value?.data && 'parsed' in ai.value.data
      ? (ai.value.data as { parsed?: { info?: { tokenAmount?: { amount?: string } } } }).parsed
          ?.info?.tokenAmount?.amount
      : undefined) ?? '0';
  console.log(`  payer    USDC ${usdc} (smallest units)`);
  if (BigInt(usdc) < PRICE_AMOUNT) {
    throw new Error(
      `payer needs ≥ ${PRICE_AMOUNT} micro-USDC at ${USDC_MINT.toBase58()}.\n` +
        `  ${
          CLUSTER === 'devnet'
            ? `Faucet: https://faucet.circle.com/?tab=devnet&address=${payer.publicKey.toBase58()}`
            : `Buy USDC and send to ${payer.publicKey.toBase58()}`
        }`,
    );
  }
}

async function buildSignedPaymentTx(
  conn: Connection,
  payer: Keypair,
  operatorOwner: PublicKey,
  mint: PublicKey,
  amount: bigint,
): Promise<string> {
  const payerAta = await getAssociatedTokenAddress(mint, payer.publicKey);
  const operatorAta = await getAssociatedTokenAddress(mint, operatorOwner);
  const transferIx = createTransferInstruction(
    payerAta,
    operatorAta,
    payer.publicKey,
    amount,
  );
  const cu = ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 });
  const blockhash = (await conn.getLatestBlockhash('confirmed')).blockhash;
  const msg = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: blockhash,
    instructions: [cu, transferIx],
  }).compileToV0Message();
  const vtx = new VersionedTransaction(msg);
  vtx.sign([payer]);
  return Buffer.from(vtx.serialize()).toString('base64');
}

interface FetchResult { status: number; body: string }
async function fetchJson(url: string, opts: { headers?: Record<string, string> } = {}): Promise<FetchResult> {
  const r = await fetch(url, { headers: opts.headers ?? {} });
  return { status: r.status, body: await r.text() };
}

function truncSig(s: string): string {
  return s.length > 16 ? `${s.slice(0, 12)}…${s.slice(-4)}` : s;
}

function redact(rpc: string): string {
  return rpc.replace(/api[-_]?key=([^&]+)/i, 'api-key=***');
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
      { pubkey: SPL_TOKEN_PROGRAM_ID,                 isSigner: false, isWritable: false },
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID,          isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId,              isSigner: false, isWritable: false },
      { pubkey: new PublicKey('SysvarRent111111111111111111111111111111111'), isSigner: false, isWritable: false },
    ],
    data,
  });
  const cu = ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 });
  await sendAndConfirmTransaction(c, new Transaction().add(cu, ix), [admin]);
}

async function buildUnshieldAlt(
  c: Connection, payer: Keypair, mint: PublicKey, recipientAta: PublicKey,
): Promise<PublicKey> {
  const NULLIFIER_ID = new PublicKey('2AnRZwWu6CTurZs1yQpqrcJWo4yRYL1xpeV78b2siweq');
  const VERIFIER_T_ID = new PublicKey('Afjbnv2Ekxa98jjRw33xPPhZabevek2uZxoE75kr6ZrK');
  const SYSVAR_INSTRUCTIONS = new PublicKey('Sysvar1nstructions1111111111111111111111111');
  const COMPUTE_BUDGET = new PublicKey('ComputeBudget111111111111111111111111111111');
  const VPREFIX = Buffer.from('b402/v1');
  const seedPda = (...seeds: Buffer[]) =>
    PublicKey.findProgramAddressSync(seeds, POOL_ID)[0];
  const NULLIFIER_CPI = PublicKey.findProgramAddressSync(
    [Buffer.from('cpi_authority')],
    NULLIFIER_ID,
  )[0];
  const slot = (await c.getSlot('finalized')) - 1;
  const [createIx, alt] = AddressLookupTableProgram.createLookupTable({
    authority: payer.publicKey, payer: payer.publicKey, recentSlot: slot,
  });
  await sendAndConfirmTransaction(c, new Transaction().add(createIx), [payer]);
  const ext = AddressLookupTableProgram.extendLookupTable({
    payer: payer.publicKey, authority: payer.publicKey, lookupTable: alt,
    addresses: [
      new PublicKey('SySTEM1eSU2p4BGQfQpimFEWWSC1XDFeun3Nqzz3rT7'),
      new PublicKey('compr6CUsB5m2jS4Y3831ztGSTnDpnKJTKS95d64XVq'),
      new PublicKey('35hkDgaAKwMCaxRz2ocSZ6NaUrtKkyNqU6c4RV3tYJRh'),
      new PublicKey('HwXnGK3tPkkVY6P439H2p68AxpeuWXd5PcrAxFpbmfbA'),
      new PublicKey('amt2kaJA14v3urZbZvnc5v2np8jqvc4Z8zDep5wbtzx'),
      new PublicKey('oq5oh5ZR3yGomuQgFduNDzjtGvVWfDRGLuDVjv9a96P'),
      NULLIFIER_ID, NULLIFIER_CPI,
      POOL_ID,
      seedPda(VPREFIX, Buffer.from('config')),
      seedPda(VPREFIX, Buffer.from('tree')),
      seedPda(VPREFIX, Buffer.from('treasury')),
      seedPda(VPREFIX, Buffer.from('token'), mint.toBuffer()),
      seedPda(VPREFIX, Buffer.from('vault'), mint.toBuffer()),
      VERIFIER_T_ID,
      SYSVAR_INSTRUCTIONS, COMPUTE_BUDGET,
      TOKEN_PROGRAM_ID, SystemProgram.programId,
      recipientAta,
    ],
  });
  await sendAndConfirmTransaction(c, new Transaction().add(ext), [payer]);
  await new Promise((r) => setTimeout(r, 3000));
  return alt;
}

main().then(
  () => process.exit(0),
  (e) => { console.error('\n❌', e instanceof Error ? e.message : e); process.exit(1); },
);

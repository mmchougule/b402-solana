#!/usr/bin/env tsx
/**
 * Private DCA — runs N USDC -> SOL swaps through the b402 shielded
 * pool. Each iter calls `b402.swap()` which the hosted relayer signs.
 * On mainnet the user wallet does not appear in any of the N swap txs.
 *
 *   pnpm exec tsx cli.ts --iters 8 --interval 90 --amount 1.0
 *
 * Setup (one-shot per run):
 *   - load or generate the user keypair (apps/private-dca/.wallets/private-dca.json)
 *   - require enough USDC + SOL for the seed shield + tx rent
 *   - shield iters * amount USDC into the pool (single wallet -> pool linkage)
 *   - then loop N private swaps. Relayer pays gas for each swap.
 *
 * Output:
 *   - results/private-<ts>.json with per-iter sigs + timing
 *   - stdout logs each sig + explorer URL
 *
 * Env:
 *   B402_RPC_URL              Helius mainnet RPC URL (required)
 *   B402_DCA_PRIVATE_KEYPAIR  optional override path
 *   B402_DCA_SKIP_SHIELD=1    reuse an existing shielded note instead of
 *                             shielding the full DCA budget up front
 */
import { B402Solana } from '@b402ai/solana';
import { Connection, PublicKey } from '@solana/web3.js';
import { getAccount, getAssociatedTokenAddress } from '@solana/spl-token';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runDcaLoop } from './lib/dca-loop.js';
import { loadOrCreateKeypair } from './lib/keypair.js';
import { parseFlags, intFlag, floatFlag, strFlag } from './lib/args.js';
import { explorerLink, type RunSide, type ComparisonConfig } from './lib/comparison.js';
import { verifyPrivateTx } from './lib/wallet-isolation.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = path.join(__dirname, 'results');

const HOSTED_RELAYER = '7f6gRiX56dMQGrPERNBKuzFsvagFTM1U4LMAAN9rsiNM';
const USDC = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const SOL  = new PublicKey('So11111111111111111111111111111111111111112');

function nowIso(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  const iters = intFlag(flags, 'iters', 8);
  const intervalS = intFlag(flags, 'interval', 90);
  const amountUi = floatFlag(flags, 'amount', 1.0);
  const dexes = strFlag(flags, 'dexes', 'Phoenix,Raydium');
  const skipShield = process.env.B402_DCA_SKIP_SHIELD === '1';

  const rpcUrl = process.env.B402_RPC_URL;
  if (!rpcUrl) {
    console.error('B402_RPC_URL required (Helius mainnet, e.g. https://mainnet.helius-rpc.com/?api-key=...).');
    process.exit(1);
  }

  const amountUnits = BigInt(Math.round(amountUi * 1e6));
  if (amountUnits <= 0n) throw new Error('amount must be > 0');

  const totalNeededUnits = amountUnits * BigInt(iters);

  const { keypair, path: kpPath, freshlyCreated } = loadOrCreateKeypair('private');
  console.log('--- private DCA ---');
  console.log(`user wallet   ${keypair.publicKey.toBase58()}`);
  console.log(`keypair file  ${kpPath}${freshlyCreated ? '  (freshly generated — fund this before re-running)' : ''}`);
  console.log(`iters         ${iters}`);
  console.log(`interval      ${intervalS}s`);
  console.log(`amount/iter   ${amountUi} USDC (${amountUnits} units)`);
  console.log(`total USDC    ${(Number(totalNeededUnits) / 1e6).toFixed(6)}`);
  console.log(`dexes         ${dexes}`);
  console.log(`relayer       ${HOSTED_RELAYER} (hosted)`);

  if (freshlyCreated) {
    console.error('\nFresh wallet generated. Fund it with USDC + a little SOL, then re-run.');
    process.exit(2);
  }

  // Sanity-check balances before doing any work.
  const conn = new Connection(rpcUrl, 'confirmed');
  const sol = await conn.getBalance(keypair.publicKey);
  console.log(`SOL balance   ${(sol / 1e9).toFixed(6)} SOL`);
  if (sol < 5_000_000) {
    throw new Error('user wallet needs at least ~0.005 SOL for the shield tx fee + rent');
  }

  const userUsdcAta = await getAssociatedTokenAddress(USDC, keypair.publicKey);
  let usdcUiBalance = 0n;
  try {
    const acct = await getAccount(conn, userUsdcAta);
    usdcUiBalance = acct.amount;
  } catch {
    /* missing ATA → 0 balance */
  }
  console.log(`USDC balance  ${(Number(usdcUiBalance) / 1e6).toFixed(6)} USDC`);

  if (!skipShield && usdcUiBalance < totalNeededUnits) {
    throw new Error(
      `insufficient USDC: need ${(Number(totalNeededUnits) / 1e6).toFixed(6)}, ` +
      `have ${(Number(usdcUiBalance) / 1e6).toFixed(6)}. Top up the wallet or run with ` +
      `B402_DCA_SKIP_SHIELD=1 to use an existing shielded note.`,
    );
  }

  const b402 = new B402Solana({
    cluster: 'mainnet',
    rpcUrl,
    keypair,
  });
  await b402.ready();

  const setupSigs: string[] = [];
  if (!skipShield) {
    console.log(`\n▶ shielding ${totalNeededUnits} USDC raw (= ${iters} swaps of ${amountUi}) ...`);
    const sh = await b402.shield({ mint: USDC, amount: totalNeededUnits, omitEncryptedNotes: true });
    console.log(`  shield sig: ${sh.signature}`);
    setupSigs.push(sh.signature);
    // Let the indexer settle before the first private swap.
    await new Promise((r) => setTimeout(r, 5000));
  } else {
    console.log('\n▶ B402_DCA_SKIP_SHIELD=1 — refreshing local note store from chain');
    await b402.status({ refresh: true });
  }

  console.log(`\n▶ starting DCA loop — ${iters} swaps × ${amountUi} USDC -> SOL, ${intervalS}s spacing`);
  const startWall = Date.now();
  const result = await runDcaLoop({
    iters,
    intervalMs: intervalS * 1000,
    executeOnce: async (i) => {
      const t0 = Date.now();
      console.log(`\n[${i + 1}/${iters}] private swap ${amountUi} USDC -> SOL ...`);
      const r = await b402.swap({
        inMint: USDC,
        outMint: SOL,
        amount: amountUnits,
        dexes,
      });
      const dt = Date.now() - t0;
      console.log(`  sig: ${r.signature}`);
      console.log(`  out: ${r.outAmount} lamports SOL (${(Number(r.outAmount) / 1e9).toFixed(6)} SOL) — ${dt}ms`);
      console.log(`  ${explorerLink(r.signature, 'mainnet')}`);
      return r.signature;
    },
    onIter: (ev) => {
      if (ev.warning) console.warn(`  warn: ${ev.warning}`);
    },
  });
  const totalWallMs = Date.now() - startWall;

  console.log(`\n--- DCA loop done — ${result.signatures.length}/${iters} sigs in ${(totalWallMs / 1000).toFixed(1)}s ---`);
  if (result.errors.length) {
    for (const e of result.errors) console.error(`  iter ${e.index} failed: ${e.message}`);
  }

  // Verify the privacy property on every produced tx.
  console.log('\n▶ verifying wallet isolation against on-chain tx state ...');
  const checks = [];
  for (const sig of result.signatures) {
    const c = await verifyPrivateTx({
      conn, signature: sig, userWallet: keypair.publicKey, expectedRelayer: HOSTED_RELAYER,
    });
    checks.push(c);
    if (!c.passed) {
      console.error(`  FAIL ${sig}: ${c.reason}`);
    } else {
      console.log(`  ok   ${sig}: signer[0]=${c.signer0.slice(0, 8)}... user_in_keys=${c.userInAccountKeys}`);
    }
  }
  const allPassed = checks.every((c) => c.passed);
  console.log(`\nwallet-isolation: ${allPassed ? 'PASS' : 'FAIL'} (${checks.filter((c) => c.passed).length}/${checks.length})`);

  // Write the private-side artifact. The combined comparison artifact
  // is produced by render-comparison.ts which consumes both halves.
  if (!fs.existsSync(RESULTS_DIR)) fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const ts = nowIso();
  const config: ComparisonConfig = {
    in_mint: USDC.toBase58(),
    out_mint: SOL.toBase58(),
    amount_units: amountUnits.toString(),
    amount_ui: amountUi.toString(),
    iters,
    interval_s: intervalS,
    cluster: 'mainnet',
    timestamp_utc: new Date().toISOString(),
  };
  const side: RunSide = {
    user_wallet: keypair.publicKey.toBase58(),
    relayer_wallet: HOSTED_RELAYER,
    tx_hashes: result.signatures,
    explorer_links: result.signatures.map((s) => explorerLink(s, 'mainnet')),
    per_swap_ms: result.perIterMs,
    setup_tx_hashes: setupSigs,
    setup_explorer_links: setupSigs.map((s) => explorerLink(s, 'mainnet')),
    notes: [
      ...result.warnings,
      ...result.errors.map((e) => `iter ${e.index} failed: ${e.message}`),
      `wallet_isolation_pass=${allPassed} (${checks.filter((c) => c.passed).length}/${checks.length})`,
    ],
  };
  const outPath = path.join(RESULTS_DIR, `private-${ts}.json`);
  fs.writeFileSync(outPath, JSON.stringify({ config, run: side, checks }, null, 2));
  console.log(`\nwrote ${outPath}`);
}

main().then(() => process.exit(0)).catch((e) => {
  console.error('\nFAIL', e instanceof Error ? e.stack : e);
  process.exit(1);
});

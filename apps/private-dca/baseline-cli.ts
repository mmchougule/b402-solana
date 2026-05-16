#!/usr/bin/env tsx
/**
 * Public-baseline DCA. Same shape as cli.ts but the wallet signs
 * every Jupiter swap itself — no shielded pool, no relayer. This is
 * the side-by-side proof of "wallet -> all N swaps" linkage.
 *
 *   pnpm exec tsx baseline-cli.ts --iters 8 --interval 90 --amount 1.0
 *
 * Env:
 *   B402_RPC_URL              Helius mainnet RPC URL (required)
 *   B402_DCA_PUBLIC_KEYPAIR   optional override path
 */
import { Connection, PublicKey } from '@solana/web3.js';
import { getAccount, getAssociatedTokenAddress } from '@solana/spl-token';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runDcaLoop } from './lib/dca-loop.js';
import { loadOrCreateKeypair } from './lib/keypair.js';
import { parseFlags, intFlag, floatFlag } from './lib/args.js';
import { publicSwap } from './lib/public-jupiter.js';
import { explorerLink, type RunSide, type ComparisonConfig } from './lib/comparison.js';
import { verifyBaselineTx } from './lib/wallet-isolation.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = path.join(__dirname, 'results');

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

  const rpcUrl = process.env.B402_RPC_URL;
  if (!rpcUrl) {
    console.error('B402_RPC_URL required (Helius mainnet).');
    process.exit(1);
  }

  const amountUnits = BigInt(Math.round(amountUi * 1e6));
  if (amountUnits <= 0n) throw new Error('amount must be > 0');

  const { keypair, path: kpPath, freshlyCreated } = loadOrCreateKeypair('public');
  console.log('--- public baseline DCA ---');
  console.log(`user wallet   ${keypair.publicKey.toBase58()}`);
  console.log(`keypair file  ${kpPath}${freshlyCreated ? '  (freshly generated — fund this before re-running)' : ''}`);
  console.log(`iters         ${iters}`);
  console.log(`interval      ${intervalS}s`);
  console.log(`amount/iter   ${amountUi} USDC (${amountUnits} units)`);

  if (freshlyCreated) {
    console.error('\nFresh wallet generated. Fund it with USDC + a little SOL, then re-run.');
    process.exit(2);
  }

  const conn = new Connection(rpcUrl, 'confirmed');
  const sol = await conn.getBalance(keypair.publicKey);
  console.log(`SOL balance   ${(sol / 1e9).toFixed(6)} SOL`);
  if (sol < 10_000_000) {
    throw new Error('public baseline wallet needs at least ~0.01 SOL for tx fees + wSOL rent across iters');
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

  const totalNeeded = amountUnits * BigInt(iters);
  if (usdcUiBalance < totalNeeded) {
    throw new Error(
      `insufficient USDC: need ${(Number(totalNeeded) / 1e6).toFixed(6)}, ` +
      `have ${(Number(usdcUiBalance) / 1e6).toFixed(6)}.`,
    );
  }

  console.log(`\n▶ starting baseline loop — ${iters} swaps × ${amountUi} USDC -> SOL, ${intervalS}s spacing`);
  const startWall = Date.now();
  const result = await runDcaLoop({
    iters,
    intervalMs: intervalS * 1000,
    executeOnce: async (i) => {
      const t0 = Date.now();
      console.log(`\n[${i + 1}/${iters}] public Jupiter swap ${amountUi} USDC -> SOL ...`);
      const r = await publicSwap({
        conn, user: keypair, inMint: USDC.toBase58(), outMint: SOL.toBase58(),
        amountUnits, slippageBps: 50,
      });
      const dt = Date.now() - t0;
      console.log(`  sig: ${r.signature}`);
      console.log(`  out: ${r.outAmount} lamports SOL — ${dt}ms`);
      console.log(`  ${explorerLink(r.signature, 'mainnet')}`);
      return r.signature;
    },
    onIter: (ev) => {
      if (ev.warning) console.warn(`  warn: ${ev.warning}`);
    },
  });
  const totalWallMs = Date.now() - startWall;
  console.log(`\n--- baseline loop done — ${result.signatures.length}/${iters} sigs in ${(totalWallMs / 1000).toFixed(1)}s ---`);
  if (result.errors.length) {
    for (const e of result.errors) console.error(`  iter ${e.index} failed: ${e.message}`);
  }

  // Verify the baseline-property: signer[0] == user on every tx.
  console.log('\n▶ verifying baseline linkage (signer[0] == user) on every tx ...');
  const checks = [];
  for (const sig of result.signatures) {
    const c = await verifyBaselineTx({ conn, signature: sig, userWallet: keypair.publicKey });
    checks.push(c);
    if (!c.passed) console.error(`  FAIL ${sig}: ${c.reason}`);
    else console.log(`  ok   ${sig}: signer[0]=${c.signer0.slice(0, 8)}...`);
  }
  const allPassed = checks.every((c) => c.passed);
  console.log(`\nbaseline-linkage: ${allPassed ? 'PASS' : 'FAIL'} (${checks.filter((c) => c.passed).length}/${checks.length})`);

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
    wallet: keypair.publicKey.toBase58(),
    tx_hashes: result.signatures,
    explorer_links: result.signatures.map((s) => explorerLink(s, 'mainnet')),
    per_swap_ms: result.perIterMs,
    notes: [
      ...result.warnings,
      ...result.errors.map((e) => `iter ${e.index} failed: ${e.message}`),
      `baseline_linkage_pass=${allPassed} (${checks.filter((c) => c.passed).length}/${checks.length})`,
    ],
  };
  const outPath = path.join(RESULTS_DIR, `public-${ts}.json`);
  fs.writeFileSync(outPath, JSON.stringify({ config, run: side, checks }, null, 2));
  console.log(`\nwrote ${outPath}`);
}

main().then(() => process.exit(0)).catch((e) => {
  console.error('\nFAIL', e instanceof Error ? e.stack : e);
  process.exit(1);
});

/**
 * Fetch a real Jupiter V6 quote + swap-instructions from mainnet, dump
 * everything we need to (a) clone into a test validator and (b) feed into
 * `privateSwap` in the SDK.
 *
 * Usage:
 *   tsx ops/jup-quote.ts \
 *     --in  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v   # USDC
 *     --out So11111111111111111111111111111111111111112    # wSOL
 *     --amount 1000000                                     # 1.0 USDC (6 decimals)
 *     --caller <your-pubkey>
 *     --out-file /tmp/jup-route.json
 *
 * Output: /tmp/jup-route.json with:
 *   - quote response
 *   - swap-instructions response (setup ixs, swap ix, cleanup, ALT addresses)
 *   - Accounts deduped into a `clone` list for solana-test-validator flags.
 */

import fs from 'node:fs';
import { Connection, PublicKey } from '@solana/web3.js';

const JUP_API = 'https://lite-api.jup.ag';
const MAINNET_RPC = process.env.MAINNET_RPC ?? 'https://api.mainnet-beta.solana.com';

/**
 * Built-in programs included in every solana-test-validator. Cloning them
 * fails (they're not accessible via RPC as upgradeable programs) and is
 * unnecessary because the validator already ships with them.
 */
const BUILTIN_PROGRAMS = new Set<string>([
  '11111111111111111111111111111111',                          // System
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',              // SPL Token v1
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',              // SPL Token 2022
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',              // SPL Associated Token
  'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr',              // Memo v1
  'Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo',              // Memo v1 alt
  'ComputeBudget111111111111111111111111111111',                // ComputeBudget
  'AddressLookupTab1e1111111111111111111111111',                // AddressLookupTable
  'BPFLoader1111111111111111111111111111111111',                // legacy BPF Loader
  'BPFLoader2111111111111111111111111111111111',                // BPF Loader 2
  'BPFLoaderUpgradeab1e11111111111111111111111',                // BPF Upgradeable Loader
  'Sysvar1nstructions1111111111111111111111111',                // Sysvar
  'SysvarC1ock11111111111111111111111111111111',                // Sysvar Clock
  'SysvarRent111111111111111111111111111111111',                // Sysvar Rent
]);

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (!k.startsWith('--')) continue;
    out[k.slice(2)] = argv[i + 1] ?? 'true';
    i++;
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const inMint = args.in;
  const outMint = args.out;
  const amount = args.amount;
  const caller = args.caller;
  const outFile = args['out-file'] ?? '/tmp/jup-route.json';
  const slippageBps = args.slippage ?? '50';

  if (!inMint || !outMint || !amount || !caller) {
    console.error('required: --in <mint> --out <mint> --amount <u64> --caller <pubkey> [--slippage 50] [--out-file /tmp/jup-route.json]');
    process.exit(1);
  }
  // Basic pubkey validation.
  new PublicKey(inMint); new PublicKey(outMint); new PublicKey(caller);

  // 1. Quote.
  const quoteUrl = `${JUP_API}/swap/v1/quote?inputMint=${inMint}&outputMint=${outMint}&amount=${amount}&slippageBps=${slippageBps}&onlyDirectRoutes=true&asLegacyTransaction=false`;
  console.log(`▶ GET ${quoteUrl}`);
  const quoteRes = await fetch(quoteUrl);
  if (!quoteRes.ok) throw new Error(`quote: ${quoteRes.status} ${await quoteRes.text()}`);
  const quote = await quoteRes.json();
  console.log(`  route: ${quote.routePlan?.length ?? 0}-hop, outAmount=${quote.outAmount}, priceImpactPct=${quote.priceImpactPct}`);

  // 2. Swap-instructions.
  const swapBody = {
    quoteResponse: quote,
    userPublicKey: caller,
    wrapAndUnwrapSol: false,
    useSharedAccounts: false,
    useTokenLedger: false,
  };
  const swapRes = await fetch(`${JUP_API}/swap/v1/swap-instructions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(swapBody),
  });
  if (!swapRes.ok) throw new Error(`swap-instructions: ${swapRes.status} ${await swapRes.text()}`);
  const swap = await swapRes.json();

  // 3. Dedupe accounts we need to clone.
  const toClone = new Set<string>();
  const collect = (ix: any) => {
    if (!ix) return;
    toClone.add(ix.programId);
    for (const k of ix.accounts ?? []) toClone.add(k.pubkey);
  };
  for (const ix of swap.setupInstructions ?? []) collect(ix);
  collect(swap.swapInstruction);
  collect(swap.cleanupInstruction);
  for (const alt of swap.addressLookupTableAddresses ?? []) toClone.add(alt);

  const cloneList = Array.from(toClone).sort();
  console.log(`▶ ${cloneList.length} unique accounts referenced`);

  // 4. Classify each account: is it an executable program?
  // solana-test-validator needs --clone-upgradeable-program for programs,
  // --maybe-clone for everything else. Batch the getAccountInfo calls.
  console.log(`▶ classifying accounts against mainnet RPC…`);
  const conn = new Connection(MAINNET_RPC, 'confirmed');
  const pubkeys = cloneList.map(a => new PublicKey(a));
  const infos: Array<{ executable: boolean } | null> = [];
  for (let i = 0; i < pubkeys.length; i += 50) {
    const batch = pubkeys.slice(i, i + 50);
    const res = await conn.getMultipleAccountsInfo(batch, { commitment: 'confirmed' });
    for (const acct of res) infos.push(acct ? { executable: acct.executable } : null);
  }

  const programs: string[] = [];
  const data: string[] = [];
  let skippedBuiltin = 0;
  for (let i = 0; i < cloneList.length; i++) {
    const a = cloneList[i];
    if (BUILTIN_PROGRAMS.has(a)) { skippedBuiltin++; continue; }
    const info = infos[i];
    if (info?.executable) programs.push(a);
    else data.push(a);
  }
  console.log(`  ${programs.length} program(s), ${data.length} data account(s), ${skippedBuiltin} built-in(s) skipped`);

  fs.writeFileSync(outFile, JSON.stringify({
    quote,
    swap,
    clone: cloneList,
    programs,
    data,
  }, null, 2));
  console.log(`▶ wrote ${outFile}`);

  // 5. Emit solana-test-validator flags.
  const flags: string[] = [];
  for (const p of programs) flags.push(`--clone-upgradeable-program ${p}`);
  for (const a of data) flags.push(`--maybe-clone ${a}`);
  console.log('\n▶ fork flags:\n');
  console.log(flags.join(' \\\n  '));
}

main().catch((e) => { console.error(e); process.exit(1); });

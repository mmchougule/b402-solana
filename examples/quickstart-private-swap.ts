/**
 * Private swap on Solana mainnet using @b402ai/solana — full end-to-end.
 *
 * What "private swap" means here:
 *   - Public USDC sits in your normal wallet (visible on chain).
 *   - `shield` moves USDC into a shielded pool. The deposit is recorded
 *     as a commitment in a Light Protocol address tree; on-chain, the
 *     amount is visible (you put 0.05 USDC into the pool) but the
 *     ownership is bound to a Poseidon-hashed viewing key, not your
 *     wallet address.
 *   - `swap` spends a shielded note (USDC) → routes through Jupiter
 *     (Phoenix-direct fill) → mints a fresh shielded note (SOL).
 *     The hosted relayer signs and pays gas, so the swap tx does NOT
 *     reference your wallet at all. Sender → recipient unlinkability
 *     is the property — outside observers can't link the SOL output to
 *     your USDC deposit.
 *   - `unshield` (not shown) would later move the SOL out to ANY
 *     public address — including one different from the depositor.
 *
 * Visible on chain: amount, adapter program, Phoenix fill venue.
 * Hidden: depositor identity, recipient identity, note linkage.
 *
 * Prereqs:
 *   - Solana CLI keypair at ~/.config/solana/id.json with ≥0.05 USDC and a few cents of SOL
 *   - Helius mainnet RPC URL:
 *       export B402_RPC_URL='https://mainnet.helius-rpc.com/?api-key=<your-key>'
 *
 * Run:
 *   pnpm exec node --experimental-strip-types examples/quickstart-private-swap.ts
 *
 * Total wall-clock: ~15s (shield ~5s + swap ~10s).
 */
import { Keypair, PublicKey } from '@solana/web3.js';
import { B402Solana } from '@b402ai/solana';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const RPC_URL = process.env.B402_RPC_URL;
if (!RPC_URL) {
  console.error('B402_RPC_URL required (mainnet, with api-key=<…>).');
  process.exit(1);
}

const KEYPAIR_PATH = process.env.B402_KEYPAIR_PATH ?? path.join(os.homedir(), '.config/solana/id.json');
const keypair = Keypair.fromSecretKey(
  new Uint8Array(JSON.parse(fs.readFileSync(KEYPAIR_PATH, 'utf8'))),
);

const USDC = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const SOL  = new PublicKey('So11111111111111111111111111111111111111112');
// 0.05 USDC (6 decimals). Bump for larger swaps.
const AMOUNT = 50_000n;

async function main(): Promise<void> {
  const b402 = new B402Solana({
    cluster: 'mainnet',
    rpcUrl: RPC_URL!,
    keypair,
  });
  await b402.ready();

  // Step 1 — shield: public USDC → shielded note in the b402 pool.
  // Your wallet signs this (Anchor SPL transfer), so this single tx
  // links your wallet to the deposit amount. Subsequent ops (swap,
  // unshield, lend) don't.
  // Set B402_SKIP_SHIELD=1 to swap an existing shielded note instead.
  if (process.env.B402_SKIP_SHIELD !== '1') {
    console.log(`▶ shield ${AMOUNT} USDC raw (~$${Number(AMOUNT) / 1e6}) into the b402 pool`);
    const shield = await b402.shield({ mint: USDC, amount: AMOUNT });
    console.log(`  shield sig: ${shield.signature}`);
  } else {
    console.log(`▶ skipping shield — refreshing local note store from chain`);
    await b402.status({ refresh: true });
  }

  // Step 2 — private swap: shielded USDC note → shielded SOL note.
  // Hosted relayer signs + pays gas, your wallet does not appear on
  // this tx. Routing handled automatically — Jupiter quote, Phoenix
  // fill, ALT, adapter wiring all derived inside the SDK.
  console.log(`▶ private swap ${AMOUNT} USDC → SOL (relayer signs, your wallet stays off-chain)`);
  const swap = await b402.swap({
    inMint: USDC,
    outMint: SOL,
    amount: AMOUNT,
    // Default DEX is Phoenix (smallest account count). Smaller swaps
    // (~$0.05 and below) tend not to route through Phoenix's lot floor;
    // widen here to AMM venues that route any size.
    dexes: 'Phoenix,Raydium',
  });
  console.log(`  swap sig:  ${swap.signature}`);
  console.log(`  out:       ${swap.outAmount} lamports SOL (= ${(Number(swap.outAmount) / 1e9).toFixed(6)} SOL)`);

  // Step 3 — sanity: read your shielded balance to see the new SOL note.
  // This is local-only (reads SDK note store, no RPC call).
  const wsolBalance = await b402.balance({ mint: SOL });
  console.log(`▶ shielded SOL balance: ${wsolBalance.balances[0]?.amount ?? '0'} lamports`);
  console.log(`  → that SOL note can later be unshielded to ANY public address — including one different from your wallet, breaking the sender→recipient link.`);
}

main().then(() => process.exit(0)).catch((e) => {
  console.error('\n❌', e.message ?? e);
  process.exit(1);
});

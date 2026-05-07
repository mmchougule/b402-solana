/**
 * Private lend + redeem on Solana mainnet using @b402ai/solana.
 *
 *   shield  → public USDC → shielded note (your wallet signs, one-time)
 *   lend    → shielded USDC → Kamino reserve (auto-discovered), mint a voucher
 *   redeem  → burn the voucher → shielded underlying
 *
 * Env:
 *   B402_RPC_URL           required, Helius/Triton mainnet endpoint
 *   B402_AMOUNT            optional, raw USDC amount (6 decimals). Default 50_000 = 0.05 USDC
 *   B402_SKIP_SHIELD=1     skip step 1, reuse an existing shielded note
 *   B402_KEYPAIR_PATH      optional, defaults to ~/.config/solana/id.json
 *
 * Run: pnpm exec node --experimental-strip-types examples/quickstart-private-lend.ts
 */
import { Keypair, PublicKey } from '@solana/web3.js';
import { B402Solana } from '@b402ai/solana';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const RPC = process.env.B402_RPC_URL;
if (!RPC) throw new Error('set B402_RPC_URL to a mainnet endpoint');

const KEYPAIR_PATH = process.env.B402_KEYPAIR_PATH
  ?? path.join(os.homedir(), '.config', 'solana', 'id.json');
const keypair = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(fs.readFileSync(KEYPAIR_PATH, 'utf8'))),
);

const USDC = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const AMOUNT = BigInt(process.env.B402_AMOUNT ?? '50000');

const b402 = new B402Solana({
  cluster: 'mainnet',
  rpcUrl: RPC,
  keypair,
});

await b402.ready();

if (!process.env.B402_SKIP_SHIELD) {
  const sh = await b402.shield({ mint: USDC, amount: AMOUNT });
  console.log('shield', sh.signature);
}

const lend = await b402.lend({ mint: USDC, amount: AMOUNT });
console.log('lend', lend.signature, 'voucher', lend.outAmount.toString());

await new Promise((r) => setTimeout(r, 4000));

const redeem = await b402.redeem({ mint: USDC });
console.log('redeem', redeem.signature, 'underlying', redeem.outAmount.toString());

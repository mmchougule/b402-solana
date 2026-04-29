/**
 * b402-agent template.
 *
 * Runs an honest demo loop against b402's devnet pool:
 *   1. shield 1 token (USDC by default) into a private balance
 *   2. watch_incoming for ~10s, polling for new private deposits
 *   3. unshield back to the same wallet
 *
 * Each step prints a real Solana Explorer URL.
 *
 * Customise: drop in your own logic between the shield and unshield calls
 * (private_swap, lend, etc.). See https://github.com/mmchougule/b402-solana
 * for adapter examples.
 */

import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Keypair, PublicKey } from '@solana/web3.js';
import { B402Solana } from '@b402ai/solana';

function mustEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`required env ${name} not set — copy .env.example to .env and fill it in`);
  return v;
}

function explorerTx(sig: string, cluster: string): string {
  const c = cluster === 'mainnet' ? '' : `?cluster=${cluster}`;
  return `https://explorer.solana.com/tx/${sig}${c}`;
}

async function main() {
  const cluster = (process.env.B402_CLUSTER ?? 'devnet') as 'mainnet' | 'devnet' | 'localnet';
  if (cluster !== 'devnet' && cluster !== 'mainnet' && cluster !== 'localnet') {
    throw new Error(`B402_CLUSTER must be devnet|mainnet|localnet`);
  }

  const rpcUrl = mustEnv('B402_RPC_URL');
  const keypairPath = path.resolve(
    process.env.B402_KEYPAIR_PATH ?? path.join(os.homedir(), '.config/solana/id.json'),
  );
  if (!fs.existsSync(keypairPath)) {
    throw new Error(`keypair not found at ${keypairPath} — run 'solana-keygen new' or set B402_KEYPAIR_PATH`);
  }
  const keypair = Keypair.fromSecretKey(
    new Uint8Array(JSON.parse(fs.readFileSync(keypairPath, 'utf8'))),
  );

  const circuitsRoot = path.resolve(mustEnv('B402_CIRCUITS_ROOT'));
  const wasmPath = path.join(circuitsRoot, 'transact_js/transact.wasm');
  const zkeyPath = path.join(circuitsRoot, 'ceremony/transact_final.zkey');
  for (const p of [wasmPath, zkeyPath]) {
    if (!fs.existsSync(p)) {
      throw new Error(`prover artifact missing: ${p}\n  → clone b402-solana repo and point B402_CIRCUITS_ROOT at its circuits/build/`);
    }
  }

  const tokenMint = new PublicKey(mustEnv('B402_TOKEN_MINT'));

  console.log(`b402-agent — cluster=${cluster} wallet=${keypair.publicKey.toBase58()}`);

  const b402 = new B402Solana({
    cluster,
    rpcUrl,
    keypair,
    proverArtifacts: { wasmPath, zkeyPath },
  });
  await b402.ready();

  console.log('\n[1/3] shielding 1 unit (in smallest units) of token …');
  const shielded = await b402.shield({ mint: tokenMint, amount: 1n });
  console.log(`      sig: ${explorerTx(shielded.signature, cluster)}`);
  console.log(`      deposit id: ${shielded.commitment.toString().slice(0, 16)}`);

  console.log('\n[2/3] watch_incoming loop — polling for new deposits (5 × 2s) …');
  let cursor: string | undefined;
  for (let i = 0; i < 5; i++) {
    const r = await b402.watchIncoming({ cursor });
    cursor = r.cursor;
    if (r.incoming.length) {
      for (const d of r.incoming) {
        console.log(`      new deposit  id=${d.id}  amount=${d.amount}  mint=${d.mint}`);
      }
    } else {
      console.log(`      poll ${i + 1}/5: no new deposits`);
    }
    await new Promise((r) => setTimeout(r, 2_000));
  }

  console.log('\n[3/3] unshielding back to the same wallet …');
  const unshielded = await b402.unshield({ to: keypair.publicKey });
  console.log(`      sig: ${explorerTx(unshielded.signature, cluster)}`);

  console.log('\n✓ done — each step is a real on-chain transaction. Customise this loop to build your private agent.');
}

main().catch((e) => {
  console.error(`\n✗ failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});

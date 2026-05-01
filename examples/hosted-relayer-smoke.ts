/**
 * Hosted relayer multi-ix smoke — proves the hosted Cloud Run relayer
 * accepts the v2 b402_nullifier sibling ix via `additionalIxs` and lands
 * a real unshield on mainnet.
 *
 * Pre: a cached note in ~/.config/b402-solana/notes/mainnet/ + the
 * default mainnet API key embedded in @b402ai/solana-mcp.
 * Post: tx signature, signer[0] = relayer, user wallet absent.
 */

import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { B402Solana } from '@b402ai/solana';
import { createRpc } from '@lightprotocol/stateless.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CIRCUITS = path.resolve(__dirname, '../circuits/build');
const RELAYER_URL = 'https://b402-solana-relayer-mainnet-62092339396.us-central1.run.app';
const RELAYER_API_KEY = 'kp_53d31f4d4b758ea2';
const USDC_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const B402_ALT = new PublicKey('3TSPLsa8aM5Xg9n8EHMuV5SK85RuMP96veFjv4BVrK9f');

function loadKp(p: string): Keypair {
  return Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(p, 'utf8'))));
}

async function main() {
  const RPC_URL = process.env.RPC_URL ?? 'https://api.mainnet-beta.solana.com';
  const user = loadKp(path.join(os.homedir(), '.config/solana/id.json'));
  const conn = new Connection(RPC_URL, 'confirmed');

  console.log('user        ', user.publicKey.toBase58());
  console.log('relayer URL ', RELAYER_URL);

  const b402 = new B402Solana({
    cluster: 'mainnet',
    rpcUrl: RPC_URL,
    keypair: user,
    relayerHttpUrl: RELAYER_URL,
    relayerApiKey: RELAYER_API_KEY,
    notesPersistDir: path.join(os.homedir(), '.config/b402-solana/notes/mainnet'),
    proverArtifacts: {
      wasmPath: path.join(CIRCUITS, 'transact_js/transact.wasm'),
      zkeyPath: path.join(CIRCUITS, 'ceremony/transact_final.zkey'),
    },
  });

  await b402.ready();

  console.log('\nshield 0.5 USDC');
  const shieldRes = await b402.shield({ mint: USDC_MINT, amount: 500_000n, omitEncryptedNotes: true });
  console.log('shield sig', shieldRes.signature);
  console.log('https://explorer.solana.com/tx/' + shieldRes.signature);

  // Wait for the shielded leaf to be visible to the indexer.
  await new Promise((r) => setTimeout(r, 5000));

  const recipient = Keypair.generate();
  console.log('\nunshield to', recipient.publicKey.toBase58());
  const photonRpc = createRpc(RPC_URL, RPC_URL);
  const res = await b402.unshield({ to: recipient.publicKey, mint: USDC_MINT, photonRpc, alt: B402_ALT });
  console.log('sig', res.signature);
  console.log('https://explorer.solana.com/tx/' + res.signature);

  await new Promise((r) => setTimeout(r, 4000));
  const tx = await conn.getTransaction(res.signature, {
    maxSupportedTransactionVersion: 0, commitment: 'confirmed',
  });
  if (!tx) throw new Error('tx not found');
  const keys = tx.transaction.message.staticAccountKeys.map((k) => k.toBase58());
  console.log('signer[0]:           ', keys[0]);
  console.log('user wallet present: ', keys.includes(user.publicKey.toBase58()));
  if (keys.includes(user.publicKey.toBase58())) {
    throw new Error('PRIVACY FAIL: user pubkey in unshield tx');
  }
  console.log('\nOK — hosted relayer accepted multi-ix submission');
}

main().then(() => process.exit(0), (e) => {
  console.error(e instanceof Error ? e.stack : e); process.exit(1);
});

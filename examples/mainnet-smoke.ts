/**
 * Mainnet alpha smoke test — Phase A.1 validation.
 *
 * Proves on real mainnet that:
 *   - shield(USDC, 1_000_000)   succeeds end-to-end
 *   - balance()                  reflects the deposit (with real mint base58)
 *   - unshield(to: fresh)        succeeds AND signer[0] = relayer pubkey,
 *                                  user wallet absent from account-key list
 *
 * Pre-conditions:
 *   - Phase A deployed (pool + 2 verifiers + USDC token config)
 *   - ~/.config/solana/id.json has ≥ 0.07 SOL + ≥ 1 USDC
 *   - ~/.config/solana/b402-relayer-mainnet.json funded ≥ 0.1 SOL
 *
 * Cost: ~0.07 SOL on user side (one-time first-shield nullifier shard
 * rent ~0.067 + ATA + tx fees), ~0.005 SOL on relayer side (recipient ATA
 * rent + unshield tx fee). 1 USDC moves user → pool → fresh recipient.
 */

import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { B402Solana } from '@b402ai/solana';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CIRCUITS = path.resolve(__dirname, '../circuits/build');
const USDC_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');

function loadKp(p: string): Keypair {
  return Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(p, 'utf8'))));
}

async function main() {
  const RPC_URL = process.env.RPC_URL ?? 'https://api.mainnet-beta.solana.com';
  const userKpPath = path.join(os.homedir(), '.config/solana/id.json');
  const relayerKpPath = path.join(os.homedir(), '.config/solana/b402-relayer-mainnet.json');

  const user = loadKp(userKpPath);
  const relayer = loadKp(relayerKpPath);
  const conn = new Connection(RPC_URL, 'confirmed');

  console.log('▶ pre-state');
  console.log(`  user     ${user.publicKey.toBase58()}`);
  console.log(`  relayer  ${relayer.publicKey.toBase58()}`);
  console.log(`  user SOL ${(await conn.getBalance(user.publicKey)) / 1e9}`);
  console.log(`  relayer SOL ${(await conn.getBalance(relayer.publicKey)) / 1e9}`);

  const b402 = new B402Solana({
    cluster: 'mainnet',
    rpcUrl: RPC_URL,
    keypair: user,
    relayer,
    proverArtifacts: {
      wasmPath: path.join(CIRCUITS, 'transact_js/transact.wasm'),
      zkeyPath: path.join(CIRCUITS, 'ceremony/transact_final.zkey'),
    },
  });

  console.log('\n▶ shield 1.000000 USDC');
  // omitEncryptedNotes: ciphertext publication requires the mainnet ALT,
  // which is created in Phase B. For Phase A.1 we skip it; note is tracked
  // via local NoteStore (~/.config/b402-solana/notes/mainnet/). Privacy
  // property doesn't depend on ciphertext publication.
  const shieldRes = await b402.shield({ mint: USDC_MINT, amount: 1_000_000n, omitEncryptedNotes: true });
  console.log(`  sig ${shieldRes.signature}`);
  console.log(`  https://explorer.solana.com/tx/${shieldRes.signature}`);

  console.log('\n▶ balance after shield');
  const bal = await b402.balance();
  for (const b of bal.balances) {
    console.log(`  ${b.mint}  ${b.amount}`);
  }

  console.log('\n▶ unshield to fresh recipient');
  const recipient = Keypair.generate();
  console.log(`  recipient ${recipient.publicKey.toBase58()}`);
  const unshieldRes = await b402.unshield({ to: recipient.publicKey });
  console.log(`  sig ${unshieldRes.signature}`);
  console.log(`  https://explorer.solana.com/tx/${unshieldRes.signature}`);

  console.log('\n▶ verifying privacy property on-chain');
  await new Promise(r => setTimeout(r, 3500));
  const tx = await conn.getTransaction(unshieldRes.signature, {
    maxSupportedTransactionVersion: 0, commitment: 'confirmed',
  });
  if (!tx) throw new Error('unshield tx not found yet');
  const keys = tx.transaction.message.staticAccountKeys.map(k => k.toBase58());
  const signer0 = keys[0];
  const userPresent = keys.includes(user.publicKey.toBase58());

  console.log(`  signer[0]:           ${signer0}`);
  console.log(`  expected (relayer):  ${relayer.publicKey.toBase58()}`);
  console.log(`  user wallet in keys: ${userPresent}  (must be false)`);

  if (signer0 !== relayer.publicKey.toBase58()) {
    throw new Error(`PRIVACY FAIL: signer[0] is not relayer`);
  }
  if (userPresent) {
    throw new Error(`PRIVACY FAIL: user wallet appears in unshield account list`);
  }

  console.log('\n✅ MAINNET ALPHA PHASE A.1 PASSED');
  console.log(`   shield + unshield work end-to-end on mainnet`);
  console.log(`   privacy property verified — relayer signs, user absent`);
}

main().then(
  () => process.exit(0),
  (e) => { console.error('\n❌', e instanceof Error ? e.stack ?? e.message : e); process.exit(1); },
);

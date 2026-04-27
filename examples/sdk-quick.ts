/**
 * Minimal integration example using the simple SDK API.
 *
 * Two-line shield + unshield against the deployed devnet pool. Compare to
 * `e2e.ts` (which calls the underlying primitives directly) — this is the
 * recommended path for app integrators.
 *
 * Run:
 *   RPC_URL=https://api.devnet.solana.com pnpm --filter=@b402ai/solana-examples sdk-quick
 *
 * Requires:
 *   - ~/.config/solana/id.json funded on devnet (≥ 0.5 SOL)
 *   - circuits/build/transact_js/transact.wasm (committed)
 *   - circuits/build/ceremony/transact_final.zkey (committed)
 */

import { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { createMint, getOrCreateAssociatedTokenAccount, mintTo } from '@solana/spl-token';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

import { B402Solana, instructionDiscriminator, poolConfigPda, tokenConfigPda, vaultPda } from '@b402ai/solana';
import {
  ComputeBudgetProgram, SystemProgram, Transaction, TransactionInstruction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from '@solana/spl-token';

const RPC_URL = process.env.RPC_URL ?? 'https://api.devnet.solana.com';
const POOL_ID = new PublicKey('42a3hsCXtQLWonyxWZosaaCJCweYYKMrvNd25p1Jrt2y');
const CIRCUITS = path.resolve(__dirname, '../circuits/build');

async function main() {
  // --- Setup: load funded CLI keypair, mint a fresh test token ---
  const adminKey = JSON.parse(
    fs.readFileSync(path.join(os.homedir(), '.config/solana/id.json'), 'utf8'),
  );
  const keypair = Keypair.fromSecretKey(new Uint8Array(adminKey));

  const conn = new Connection(RPC_URL, 'confirmed');
  console.log(`▶ wallet ${keypair.publicKey.toBase58()}`);
  const balance = await conn.getBalance(keypair.publicKey);
  console.log(`  balance ${(balance / LAMPORTS_PER_SOL).toFixed(3)} SOL`);

  const mint = await createMint(conn, keypair, keypair.publicKey, null, 6);
  console.log(`▶ created test mint ${mint.toBase58()}`);
  const ata = await getOrCreateAssociatedTokenAccount(conn, keypair, mint, keypair.publicKey);
  await mintTo(conn, keypair, mint, ata.address, keypair, 100);
  await addTokenConfig(conn, keypair, mint);
  console.log(`  100 minted to ATA, token_config registered`);

  // --- The whole SDK integration: 4 lines ---
  const b402 = new B402Solana({
    cluster: 'devnet',
    rpcUrl: RPC_URL,
    keypair,
    proverArtifacts: {
      wasmPath: path.join(CIRCUITS, 'transact_js/transact.wasm'),
      zkeyPath: path.join(CIRCUITS, 'ceremony/transact_final.zkey'),
    },
  });

  const shieldRes = await b402.shield({ mint, amount: 100n });
  console.log(`▶ shield ${shieldRes.signature}`);

  const recipient = Keypair.generate();
  const unshieldRes = await b402.unshield({ to: recipient.publicKey });
  console.log(`▶ unshield ${unshieldRes.signature} → ${recipient.publicKey.toBase58()}`);

  console.log(`\n✅ shield + unshield via the simple SDK API`);
}

// --- One ad-hoc helper: register the test mint with the pool. Real apps don't
// do this; only required because we created a fresh mint for the demo. ---
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
      { pubkey: TOKEN_PROGRAM_ID,                     isSigner: false, isWritable: false },
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID,          isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId,              isSigner: false, isWritable: false },
      { pubkey: new PublicKey('SysvarRent111111111111111111111111111111111'), isSigner: false, isWritable: false },
    ],
    data,
  });
  const cu = ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 });
  await sendAndConfirmTransaction(c, new Transaction().add(cu, ix), [admin]);
}

main().then(
  () => process.exit(0),
  (e) => { console.error('\n❌', e); process.exit(1); },
);

/**
 * register-mint-devnet — admin one-shot to allow-list an SPL mint for shielding
 * on the deployed devnet b402 pool.
 *
 * Usage:
 *   tsx examples/register-mint-devnet.ts <mint-base58> [more-mints...]
 *
 * Pre-conditions:
 *   - You must be the pool's admin_multisig (the keypair that initialised the
 *     pool). On devnet that's `~/.config/solana/id.json` for the original
 *     deployer.
 *   - ~0.01 SOL on devnet for fees + token_config rent.
 *
 * Idempotent — re-running for an already-registered mint is a no-op.
 */

import {
  ComputeBudgetProgram, Connection, Keypair, PublicKey, SystemProgram,
  Transaction, TransactionInstruction, sendAndConfirmTransaction,
} from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from '@solana/spl-token';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  instructionDiscriminator, poolConfigPda, tokenConfigPda, vaultPda,
} from '@b402ai/solana';

const RPC_URL = process.env.RPC_URL ?? 'https://api.devnet.solana.com';
const POOL_ID = new PublicKey('42a3hsCXtQLWonyxWZosaaCJCweYYKMrvNd25p1Jrt2y');
const SYSVAR_RENT = new PublicKey('SysvarRent111111111111111111111111111111111');

async function addTokenConfig(c: Connection, admin: Keypair, mint: PublicKey): Promise<'registered' | 'already'> {
  const tokenConfig = tokenConfigPda(POOL_ID, mint);
  const existing = await c.getAccountInfo(tokenConfig);
  if (existing) return 'already';

  // Set max TVL to u64::MAX (no per-mint TVL cap on devnet).
  const maxTvl = Buffer.alloc(8);
  maxTvl.writeBigUInt64LE(0xFFFFFFFFFFFFFFFFn, 0);
  const data = Buffer.concat([
    Buffer.from(instructionDiscriminator('add_token_config')),
    maxTvl,
  ]);

  const ix = new TransactionInstruction({
    programId: POOL_ID,
    keys: [
      { pubkey: admin.publicKey,                  isSigner: true,  isWritable: true  },
      { pubkey: admin.publicKey,                  isSigner: true,  isWritable: false },
      { pubkey: poolConfigPda(POOL_ID),           isSigner: false, isWritable: false },
      { pubkey: tokenConfig,                      isSigner: false, isWritable: true  },
      { pubkey: mint,                             isSigner: false, isWritable: false },
      { pubkey: vaultPda(POOL_ID, mint),          isSigner: false, isWritable: true  },
      { pubkey: TOKEN_PROGRAM_ID,                 isSigner: false, isWritable: false },
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID,      isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId,          isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT,                      isSigner: false, isWritable: false },
    ],
    data,
  });

  const cu = ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 });
  const sig = await sendAndConfirmTransaction(c, new Transaction().add(cu, ix), [admin], {
    commitment: 'confirmed',
  });
  console.log(`  registered → https://explorer.solana.com/tx/${sig}?cluster=devnet`);
  return 'registered';
}

async function main() {
  const mintArgs = process.argv.slice(2);
  if (mintArgs.length === 0) {
    console.error('usage: tsx examples/register-mint-devnet.ts <mint-base58> [more-mints...]');
    process.exit(1);
  }
  const mints = mintArgs.map((s) => new PublicKey(s));

  const connection = new Connection(RPC_URL, 'confirmed');
  const adminPath = process.env.ADMIN_KEYPAIR ?? path.join(os.homedir(), '.config/solana/id.json');
  const admin = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(adminPath, 'utf8'))));
  console.log(`admin: ${admin.publicKey.toBase58()} (must match pool admin_multisig)`);
  console.log(`rpc:   ${RPC_URL}`);
  console.log();

  for (const mint of mints) {
    console.log(`mint ${mint.toBase58()}:`);
    const result = await addTokenConfig(connection, admin, mint);
    console.log(`  ${result === 'already' ? 'already registered' : 'OK'}`);
  }
}

main().catch((e) => {
  console.error(`failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});

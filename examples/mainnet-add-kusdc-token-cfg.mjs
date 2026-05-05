/**
 * One-off: add the kUSDC token config to the mainnet pool. Required so
 * the pool will accept privateLend (USDC -> kUSDC) and privateRedeem
 * (kUSDC -> USDC) txs through the kamino-adapter.
 *
 * Usage: pnpm exec node ./mainnet-add-kusdc-token-cfg.mjs
 *
 * Idempotent — exits early if cfg already exists.
 */
import {
  Connection, PublicKey, Keypair, SystemProgram,
  Transaction, TransactionInstruction, ComputeBudgetProgram,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from '@solana/spl-token';
import {
  instructionDiscriminator, poolConfigPda, tokenConfigPda, vaultPda,
} from '@b402ai/solana';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const RPC = 'https://mainnet.helius-rpc.com/?api-key=1a565ed2-0587-4701-9867-1665ac67864d';
const POOL = new PublicKey('42a3hsCXtQLWonyxWZosaaCJCweYYKMrvNd25p1Jrt2y');
const KUSDC = new PublicKey('B8V6WVjPxW1UGwVDfxH2d2r8SyT4cqn7dQRK6XneVa7D');
const SYSVAR_RENT = new PublicKey('SysvarRent111111111111111111111111111111111');

const conn = new Connection(RPC, 'confirmed');
const admin = Keypair.fromSecretKey(
  new Uint8Array(JSON.parse(fs.readFileSync(path.join(os.homedir(), '.config/solana/id.json'), 'utf8'))),
);
console.log('admin:', admin.publicKey.toBase58());

const cfgPda = tokenConfigPda(POOL, KUSDC);
const existing = await conn.getAccountInfo(cfgPda);
if (existing) {
  console.log(`token_cfg ${cfgPda.toBase58()} already exists (len=${existing.data.length}) — done.`);
  process.exit(0);
}

// max u64 TVL cap (matches existing USDC config pattern in sdk-quick.ts)
const maxTvl = Buffer.alloc(8);
maxTvl.writeBigUInt64LE(0xFFFFFFFFFFFFFFFFn, 0);
const data = Buffer.concat([
  Buffer.from(instructionDiscriminator('add_token_config')),
  maxTvl,
]);

const ix = new TransactionInstruction({
  programId: POOL,
  keys: [
    { pubkey: admin.publicKey, isSigner: true, isWritable: true },
    { pubkey: admin.publicKey, isSigner: true, isWritable: false },
    { pubkey: poolConfigPda(POOL), isSigner: false, isWritable: false },
    { pubkey: cfgPda, isSigner: false, isWritable: true },
    { pubkey: KUSDC, isSigner: false, isWritable: false },
    { pubkey: vaultPda(POOL, KUSDC), isSigner: false, isWritable: true },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: SYSVAR_RENT, isSigner: false, isWritable: false },
  ],
  data,
});
const cu = ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 });
const sig = await sendAndConfirmTransaction(
  conn,
  new Transaction().add(cu, ix),
  [admin],
  { commitment: 'confirmed' },
);
console.log('✓ kUSDC token_cfg added');
console.log('  cfg PDA:', cfgPda.toBase58());
console.log('  vault PDA:', vaultPda(POOL, KUSDC).toBase58());
console.log('  sig:', sig);

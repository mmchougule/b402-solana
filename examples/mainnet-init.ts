/**
 * Mainnet alpha bootstrap. Idempotent — safe to re-run.
 *
 * Run AFTER `./ops/mainnet-deploy.sh --execute`. Steps:
 *   1. init_pool (skip if already initialised)
 *   2. set_verifier(Adapt, VERIFIER_A_ID)
 *   3. add_token_config for USDC (cap: 100,000 USDC)
 *   4. add_token_config for wSOL (cap: 300 wSOL)
 *   5. register_adapter for Jupiter v6 (execute discriminator)
 *   6. register_adapter for Kamino lend  (execute discriminator)
 *
 * TVL caps are conservative for alpha. Adjust later via `set_max_tvl(mint, n)`.
 *
 * Env (driven by ops/mainnet-init.sh):
 *   RPC_URL          (default: https://api.mainnet-beta.solana.com)
 *   ADMIN_KEYPAIR    (default: ~/.config/solana/id.json)
 *   POOL_ID, VERIFIER_T_ID, VERIFIER_A_ID, JUP_ADAPTER_ID,
 *   KAMINO_ADAPTER_ID, USDC, WSOL, JUP_V6
 */

import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import {
  instructionDiscriminator,
  poolConfigPda,
  treeStatePda,
  adapterRegistryPda,
  treasuryPda,
  tokenConfigPda,
  vaultPda,
} from '@b402ai/solana';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const RPC_URL  = process.env.RPC_URL ?? 'https://api.mainnet-beta.solana.com';
const POOL_ID  = new PublicKey(process.env.POOL_ID  ?? '42a3hsCXtQLWonyxWZosaaCJCweYYKMrvNd25p1Jrt2y');
const VERIFIER_T_ID    = new PublicKey(process.env.VERIFIER_T_ID    ?? 'Afjbnv2Ekxa98jjRw33xPPhZabevek2uZxoE75kr6ZrK');
const VERIFIER_A_ID    = new PublicKey(process.env.VERIFIER_A_ID    ?? '3Y2tyhNSaUiW5AcZcmFGRyTMdnroxHxc5GqFQPcMTZae');
const JUP_ADAPTER_ID   = new PublicKey(process.env.JUP_ADAPTER_ID   ?? '3RHRcbinCmcj8JPBfVxb9FW76oh4r8y21aSx4JFy3yx7');
const KAMINO_ADAPTER_ID = new PublicKey(process.env.KAMINO_ADAPTER_ID ?? '2enwFgcGKJDqruHpCtvmhtxe3DYcV3k72VTvoGcdt2rX');
const USDC = new PublicKey(process.env.USDC ?? 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const WSOL = new PublicKey(process.env.WSOL ?? 'So11111111111111111111111111111111111111112');

// Conservative alpha caps. Adjustable via set_max_tvl post-deploy.
// Per-mint cap = max TVL the pool can hold of that token, NOT a market-cap
// rejection. Caps verified against on-chain mint supply + plain SPL-Token
// owner check. All Token-2022 + transfer-hook mints are excluded.
const USDC_CAP = 100_000n        * 10n ** 6n;  // 100k USDC
const WSOL_CAP = 300n            * 10n ** 9n;  // 300 wSOL  (~$50k @ $170/SOL)
const USDT_CAP = 100_000n        * 10n ** 6n;  // 100k USDT
const JUP_CAP  = 2_000_000n      * 10n ** 6n;  // 2M JUP    (~$1.6M @ $0.80)
const JTO_CAP  = 500_000n        * 10n ** 9n;  // 500k JTO  (~$1M @ $2)
const BONK_CAP = 100_000_000_000n * 10n ** 5n; // 100B BONK (~$2M @ $0.00002)
const WIF_CAP  = 1_000_000n      * 10n ** 6n;  // 1M WIF    (~$3M @ $3)
const PYTH_CAP = 3_000_000n      * 10n ** 6n;  // 3M PYTH   (~$1M @ $0.30)
const RAY_CAP  = 500_000n        * 10n ** 6n;  // 500k RAY  (~$1M @ $2)
const ORCA_CAP = 500_000n        * 10n ** 6n;  // 500k ORCA (~$1.5M @ $3)

// Top-10 Solana token mints for v2.1 alpha. All verified plain SPL Token
// (not Token-2022) with on-chain supply matching publicly known issuance.
const TOP_TOKENS = [
  { mint: USDC, label: 'USDC', cap: USDC_CAP },
  { mint: WSOL, label: 'wSOL', cap: WSOL_CAP },
  { mint: new PublicKey('Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'), label: 'USDT', cap: USDT_CAP },
  { mint: new PublicKey('JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN'), label: 'JUP',  cap: JUP_CAP  },
  { mint: new PublicKey('jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL'), label: 'JTO',  cap: JTO_CAP  },
  { mint: new PublicKey('DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263'), label: 'BONK', cap: BONK_CAP },
  { mint: new PublicKey('EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm'), label: 'WIF',  cap: WIF_CAP  },
  { mint: new PublicKey('HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3'), label: 'PYTH', cap: PYTH_CAP },
  { mint: new PublicKey('4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R'), label: 'RAY',  cap: RAY_CAP  },
  { mint: new PublicKey('orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE'), label: 'ORCA', cap: ORCA_CAP },
];

const SYSVAR_RENT_PUBKEY = new PublicKey('SysvarRent111111111111111111111111111111111');

function loadAdmin(): Keypair {
  const p = process.env.ADMIN_KEYPAIR ?? path.join(os.homedir(), '.config/solana/id.json');
  return Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(p, 'utf8'))));
}

async function ensureInitPool(c: Connection, admin: Keypair): Promise<void> {
  const cfg = await c.getAccountInfo(poolConfigPda(POOL_ID));
  if (cfg) {
    console.log('▶ pool already initialised — skipping init_pool');
    return;
  }
  const data = Buffer.concat([
    Buffer.from(instructionDiscriminator('init_pool')),
    admin.publicKey.toBuffer(),    // admin_multisig
    Buffer.from([1]),               // admin_threshold
    VERIFIER_T_ID.toBuffer(),       // verifier_transact
    VERIFIER_A_ID.toBuffer(),       // verifier_adapt
    VERIFIER_T_ID.toBuffer(),       // verifier_disclose (placeholder; never used in alpha)
    admin.publicKey.toBuffer(),     // treasury_pubkey
  ]);
  const ix = new TransactionInstruction({
    programId: POOL_ID,
    keys: [
      { pubkey: admin.publicKey,             isSigner: true,  isWritable: true  },
      { pubkey: poolConfigPda(POOL_ID),      isSigner: false, isWritable: true  },
      { pubkey: treeStatePda(POOL_ID),       isSigner: false, isWritable: true  },
      { pubkey: adapterRegistryPda(POOL_ID), isSigner: false, isWritable: true  },
      { pubkey: treasuryPda(POOL_ID),        isSigner: false, isWritable: true  },
      { pubkey: SystemProgram.programId,     isSigner: false, isWritable: false },
    ],
    data,
  });
  const cu = ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 });
  const sig = await sendAndConfirmTransaction(c, new Transaction().add(cu, ix), [admin]);
  console.log(`  init_pool sig = ${sig}`);
}

async function ensureSetAdaptVerifier(c: Connection, admin: Keypair): Promise<void> {
  // VerifierKind { Transact=0, Adapt=1, Disclose=2 } — set Adapt explicitly so this
  // is a no-op when init already wrote the right value, but still self-corrects
  // any stale config (e.g. an init that ran with a placeholder).
  const data = Buffer.concat([
    Buffer.from(instructionDiscriminator('set_verifier')),
    Buffer.from([1]),
    VERIFIER_A_ID.toBuffer(),
  ]);
  const ix = new TransactionInstruction({
    programId: POOL_ID,
    keys: [
      { pubkey: admin.publicKey,        isSigner: true,  isWritable: false },
      { pubkey: poolConfigPda(POOL_ID), isSigner: false, isWritable: true  },
    ],
    data,
  });
  const sig = await sendAndConfirmTransaction(c, new Transaction().add(ix), [admin]);
  console.log(`  set_verifier(Adapt) sig = ${sig}`);
}

async function ensureTokenConfig(
  c: Connection, admin: Keypair, mint: PublicKey, label: string, maxTvl: bigint,
): Promise<void> {
  const existing = await c.getAccountInfo(tokenConfigPda(POOL_ID, mint));
  if (existing) {
    console.log(`▶ ${label} token config exists — running set_max_tvl to sync cap`);
    const data = Buffer.concat([
      Buffer.from(instructionDiscriminator('set_max_tvl')),
      bigintLE(maxTvl),
    ]);
    const ix = new TransactionInstruction({
      programId: POOL_ID,
      keys: [
        { pubkey: admin.publicKey,                  isSigner: true,  isWritable: false },
        { pubkey: poolConfigPda(POOL_ID),           isSigner: false, isWritable: false },
        { pubkey: tokenConfigPda(POOL_ID, mint),    isSigner: false, isWritable: true  },
      ],
      data,
    });
    const sig = await sendAndConfirmTransaction(c, new Transaction().add(ix), [admin]);
    console.log(`  set_max_tvl(${label}) sig = ${sig}`);
    return;
  }
  const data = Buffer.concat([
    Buffer.from(instructionDiscriminator('add_token_config')),
    bigintLE(maxTvl),
  ]);
  const ix = new TransactionInstruction({
    programId: POOL_ID,
    keys: [
      { pubkey: admin.publicKey,                       isSigner: true,  isWritable: true  },
      { pubkey: admin.publicKey,                       isSigner: true,  isWritable: false },
      { pubkey: poolConfigPda(POOL_ID),                isSigner: false, isWritable: false },
      { pubkey: tokenConfigPda(POOL_ID, mint),         isSigner: false, isWritable: true  },
      { pubkey: mint,                                  isSigner: false, isWritable: false },
      { pubkey: vaultPda(POOL_ID, mint),               isSigner: false, isWritable: true  },
      { pubkey: TOKEN_PROGRAM_ID,                      isSigner: false, isWritable: false },
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID,           isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId,               isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT_PUBKEY,                    isSigner: false, isWritable: false },
    ],
    data,
  });
  const cu = ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 });
  const sig = await sendAndConfirmTransaction(c, new Transaction().add(cu, ix), [admin]);
  console.log(`  add_token_config(${label}, cap=${maxTvl.toString()}) sig = ${sig}`);
}

async function ensureRegisterAdapter(
  c: Connection, admin: Keypair, adapterId: PublicKey, label: string,
): Promise<void> {
  const executeDisc = instructionDiscriminator('execute');
  const data = Buffer.concat([
    Buffer.from(instructionDiscriminator('register_adapter')),
    adapterId.toBuffer(),
    Buffer.from([1, 0, 0, 0]),    // allowed_instructions vec len = 1 (u32 LE)
    Buffer.from(executeDisc),
  ]);
  const ix = new TransactionInstruction({
    programId: POOL_ID,
    keys: [
      { pubkey: admin.publicKey,             isSigner: true,  isWritable: true  },
      { pubkey: poolConfigPda(POOL_ID),      isSigner: false, isWritable: false },
      { pubkey: adapterRegistryPda(POOL_ID), isSigner: false, isWritable: true  },
      { pubkey: SystemProgram.programId,     isSigner: false, isWritable: false },
    ],
    data,
  });
  try {
    const sig = await sendAndConfirmTransaction(c, new Transaction().add(ix), [admin]);
    console.log(`  register_adapter(${label}) sig = ${sig}`);
  } catch (e: any) {
    const msg = e.message ?? String(e);
    if (msg.includes('AdapterAlreadyRegistered') || msg.includes('already in use')) {
      console.log(`  ${label} adapter already registered — skipping`);
      return;
    }
    throw e;
  }
}

function bigintLE(v: bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(v, 0);
  return b;
}

/** Skip register_adapter when the adapter's bytecode isn't on-chain yet
 *  (phased deploy: pool + verifiers go first; adapters deploy + register later).
 *  Override with B402_FORCE_REGISTER=1 to attempt registration regardless. */
async function adapterIsDeployed(c: Connection, id: PublicKey): Promise<boolean> {
  const acc = await c.getAccountInfo(id);
  return acc !== null && acc.executable;
}

async function main(): Promise<void> {
  const c = new Connection(RPC_URL, 'confirmed');
  const admin = loadAdmin();
  console.log(`▶ RPC ${RPC_URL}`);
  console.log(`  admin = ${admin.publicKey.toBase58()}`);
  console.log(`  pool  = ${POOL_ID.toBase58()}`);

  await ensureInitPool(c, admin);
  await ensureSetAdaptVerifier(c, admin);
  for (const t of TOP_TOKENS) {
    await ensureTokenConfig(c, admin, t.mint, t.label, t.cap);
  }

  const force = process.env.B402_FORCE_REGISTER === '1';
  for (const [id, label] of [
    [JUP_ADAPTER_ID, 'jupiter'] as const,
    [KAMINO_ADAPTER_ID, 'kamino'] as const,
  ]) {
    if (!force && !(await adapterIsDeployed(c, id))) {
      console.log(`▶ ${label} adapter program not yet deployed at ${id.toBase58()} — skipping register_adapter (re-run after deploy)`);
      continue;
    }
    await ensureRegisterAdapter(c, admin, id, label);
  }

  console.log('');
  console.log('✅ mainnet alpha pool ready');
  console.log(`   ${TOP_TOKENS.length} token configs registered`);
}

main().catch((e) => { console.error(e); process.exit(1); });

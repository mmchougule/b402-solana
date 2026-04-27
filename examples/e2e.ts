/**
 * End-to-end demo: shield → unshield against a local solana-test-validator.
 *
 * Prereqs (in another terminal):
 *   ./ops/local-validator.sh --reset
 *
 * Then:
 *   pnpm --filter @b402ai/solana-examples e2e
 *
 * Flow:
 *   1. Connect to localhost:8899.
 *   2. Create admin/relayer/depositor keypairs, airdrop SOL.
 *   3. init_pool (admin signs).
 *   4. Create a real test mint, mint 100 units to depositor.
 *   5. add_token_config + create vault ATA.
 *   6. Build SDK B402Solana wallet from depositor keypair.
 *   7. shield(100) — generates Groth16 proof, submits via real RPC.
 *   8. Walk the on-chain TreeState, append the new commitment to a
 *      ClientMerkleTree so we can prove against it.
 *   9. Create a fresh recipient + ATA.
 *  10. unshield(note → recipient_ata) — generates 2nd proof, submits.
 *  11. Assert recipient ATA holds 100, vault holds 0, tree leaf_count = 1.
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
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  getAssociatedTokenAddress,
  getAccount,
} from '@solana/spl-token';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  buildWallet,
  buildZeroCache,
  proveMostRecentLeaf,
  shield,
  unshield,
  fetchTreeState,
  poolConfigPda,
  treeStatePda,
  adapterRegistryPda,
  treasuryPda,
  tokenConfigPda,
  vaultPda,
  instructionDiscriminator,
} from '@b402ai/solana';
import { TransactProver } from '@b402ai/solana-prover';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Override: RPC_URL=https://api.devnet.solana.com pnpm e2e
const RPC_URL = process.env.RPC_URL ?? 'http://127.0.0.1:8899';

// Program IDs — must match `declare_id!` in each program source.
const POOL_ID = new PublicKey('42a3hsCXtQLWonyxWZosaaCJCweYYKMrvNd25p1Jrt2y');
const VERIFIER_ID = new PublicKey('Afjbnv2Ekxa98jjRw33xPPhZabevek2uZxoE75kr6ZrK');

const CIRCUITS_BUILD = path.resolve(__dirname, '../circuits/build');

async function main() {
  console.log('▶ connecting to', RPC_URL);
  const connection = new Connection(RPC_URL, 'confirmed');
  const slot = await connection.getSlot();
  console.log(`  current slot = ${slot}`);

  // ---- Keypairs ----
  // On localnet we airdrop to fresh keypairs. On devnet airdrop is rate-
  // limited, so we reuse the locally-funded CLI wallet as admin+relayer+
  // depositor. Override via ADMIN_KEYPAIR env var.
  const isLocal = RPC_URL.includes('127.0.0.1');
  let admin: Keypair, relayer: Keypair, depositor: Keypair;

  if (isLocal) {
    admin = Keypair.fromSeed(new Uint8Array(32).fill(7));
    relayer = Keypair.generate();
    depositor = Keypair.generate();
    for (const kp of [admin, relayer, depositor]) {
      const sig = await connection.requestAirdrop(kp.publicKey, 5 * LAMPORTS_PER_SOL);
      await connection.confirmTransaction(sig, 'confirmed');
    }
    console.log('▶ funded admin / relayer / depositor via local airdrop');
  } else {
    const walletPath = process.env.ADMIN_KEYPAIR
      ?? path.join(process.env.HOME ?? '', '.config/solana/id.json');
    const secret = new Uint8Array(JSON.parse(fs.readFileSync(walletPath, 'utf8')));
    admin = Keypair.fromSecretKey(secret);
    relayer = admin;
    depositor = admin;
    const bal = await connection.getBalance(admin.publicKey);
    console.log(`▶ using CLI wallet ${admin.publicKey.toBase58()} (${(bal / LAMPORTS_PER_SOL).toFixed(3)} SOL)`);
  }

  // ---- init_pool (skip if already initialized) ----
  const cfgAcct = await connection.getAccountInfo(poolConfigPda(POOL_ID));
  if (cfgAcct) {
    console.log('▶ pool already initialized — skipping init_pool');
  } else {
    await initPool(connection, admin);
    console.log('▶ init_pool ok');
  }

  // ---- Mint + token config ----
  const mint = await createMint(connection, admin, admin.publicKey, null, 6);
  console.log(`▶ created test mint ${mint.toBase58()}`);

  const depositorAta = await getOrCreateAssociatedTokenAccount(
    connection, admin, mint, depositor.publicKey,
  );
  await mintTo(connection, admin, mint, depositorAta.address, admin, 100);
  console.log(`▶ minted 100 to depositor ATA`);

  await addTokenConfig(connection, admin, mint);
  console.log('▶ add_token_config ok');

  // ---- SDK wallet + prover ----
  const wallet = await buildWallet(depositor.secretKey.slice(0, 32));
  const prover = new TransactProver({
    wasmPath: path.join(CIRCUITS_BUILD, 'transact_js/transact.wasm'),
    zkeyPath: path.join(CIRCUITS_BUILD, 'ceremony/transact_final.zkey'),
  });
  console.log(`▶ wallet derived (spendingPub = ${wallet.spendingPub.toString().slice(0, 16)}…)`);

  // ---- Capture pre-shield tree state for relative assertions ----
  const treeBeforeShield = await fetchTreeState(connection, treeStatePda(POOL_ID));
  console.log(`▶ pre-shield tree leafCount = ${treeBeforeShield.leafCount}`);

  // ---- shield ----
  console.log('▶ shielding 100…');
  const shieldStart = Date.now();
  const shieldResult = await shield({
    connection,
    poolProgramId: POOL_ID,
    verifierProgramId: VERIFIER_ID,
    prover,
    wallet,
    mint,
    depositorAta: depositorAta.address,
    depositor,
    relayer,
    amount: 100n,
  });
  console.log(`▶ shield ok in ${Date.now() - shieldStart}ms`);
  console.log(`  signature  = ${shieldResult.signature}`);
  console.log(`  commitment = ${shieldResult.commitment.toString().slice(0, 24)}…`);
  console.log(`  leafIndex  = ${shieldResult.leafIndex}`);

  // ---- Verify on-chain state after shield ----
  // Vault: each run uses a unique mint, so its vault was empty before shield → must be 100 now.
  const vaultAddr = vaultPda(POOL_ID, mint);
  const vaultAcct = await getAccount(connection, vaultAddr);
  if (vaultAcct.amount !== 100n) throw new Error(`vault balance ${vaultAcct.amount} != 100`);
  console.log(`▶ vault balance = ${vaultAcct.amount} ✓`);

  // Tree: leafCount advanced by 1 from pre-shield baseline.
  const treeAfterShield = await fetchTreeState(connection, treeStatePda(POOL_ID));
  if (treeAfterShield.leafCount !== treeBeforeShield.leafCount + 1n) {
    throw new Error(`leafCount delta ${treeAfterShield.leafCount - treeBeforeShield.leafCount} != 1`);
  }
  console.log(`▶ tree leafCount ${treeBeforeShield.leafCount} → ${treeAfterShield.leafCount} ✓`);

  // ---- Derive merkle proof from on-chain frontier (our leaf is the most-recent) ----
  const postShieldTree = treeAfterShield;
  const zeroCache = await buildZeroCache();
  const zeroCacheLe = zeroCache.map((v) => {
    const buf = new Uint8Array(32);
    let x = v;
    for (let i = 0; i < 32; i++) { buf[i] = Number(x & 0xffn); x >>= 8n; }
    return buf;
  });
  const rootBig = (() => {
    let v = 0n;
    for (let i = 31; i >= 0; i--) v = (v << 8n) | BigInt(postShieldTree.currentRoot[i]);
    return v;
  })();
  const merkleProof = proveMostRecentLeaf(
    shieldResult.commitment,
    shieldResult.leafIndex,
    rootBig,
    postShieldTree.frontier,
    zeroCacheLe,
  );

  // ---- Create recipient + ATA ----
  const recipient = Keypair.generate();
  const recipientAta = await getOrCreateAssociatedTokenAccount(
    connection, admin, mint, recipient.publicKey,
  );
  console.log(`▶ recipient ATA = ${recipientAta.address.toBase58()}`);

  // ---- unshield ----
  console.log('▶ unshielding 100 to fresh recipient…');
  const unshieldStart = Date.now();
  const unshieldResult = await unshield({
    connection,
    poolProgramId: POOL_ID,
    verifierProgramId: VERIFIER_ID,
    prover,
    wallet,
    mint,
    note: shieldResult.note,
    merkleProof,
    recipientTokenAccount: recipientAta.address,
    recipientOwner: recipient.publicKey,
    relayer,
  });
  console.log(`▶ unshield ok in ${Date.now() - unshieldStart}ms`);
  console.log(`  signature = ${unshieldResult.signature}`);
  console.log(`  nullifier = ${unshieldResult.nullifier.toString().slice(0, 24)}…`);

  // ---- Verify final state ----
  const recipientAcct = await getAccount(connection, recipientAta.address);
  if (recipientAcct.amount !== 100n) throw new Error(`recipient ${recipientAcct.amount} != 100`);
  console.log(`▶ recipient balance = ${recipientAcct.amount} ✓`);

  const vaultAfter = await getAccount(connection, vaultAddr);
  if (vaultAfter.amount !== 0n) throw new Error(`vault after ${vaultAfter.amount} != 0`);
  console.log(`▶ vault balance after unshield = ${vaultAfter.amount} ✓`);

  const treeAfter = await fetchTreeState(connection, treeStatePda(POOL_ID));
  if (treeAfter.leafCount !== treeAfterShield.leafCount) {
    throw new Error(`tree leafCount changed after full unshield (no change note expected)`);
  }
  console.log(`▶ tree leafCount after unshield = ${treeAfter.leafCount} ✓ (no change note)`);

  console.log('\n✅ end-to-end shield → unshield successful on solana-test-validator');
}

// ---- Anchor instruction helpers (init_pool + add_token_config) ----

async function initPool(connection: Connection, admin: Keypair): Promise<void> {
  const data = Buffer.concat([
    Buffer.from(instructionDiscriminator('init_pool')),
    admin.publicKey.toBuffer(),                  // admin_multisig
    Buffer.from([1]),                             // admin_threshold
    VERIFIER_ID.toBuffer(),                       // verifier_transact
    VERIFIER_ID.toBuffer(),                       // verifier_adapt (placeholder)
    VERIFIER_ID.toBuffer(),                       // verifier_disclose (placeholder)
    admin.publicKey.toBuffer(),                   // treasury_pubkey
  ]);

  const ix = new TransactionInstruction({
    programId: POOL_ID,
    keys: [
      { pubkey: admin.publicKey,            isSigner: true,  isWritable: true  },
      { pubkey: poolConfigPda(POOL_ID),     isSigner: false, isWritable: true  },
      { pubkey: treeStatePda(POOL_ID),      isSigner: false, isWritable: true  },
      { pubkey: adapterRegistryPda(POOL_ID),isSigner: false, isWritable: true  },
      { pubkey: treasuryPda(POOL_ID),       isSigner: false, isWritable: true  },
      { pubkey: SystemProgram.programId,    isSigner: false, isWritable: false },
    ],
    data,
  });

  const cu = ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 });
  await sendAndConfirmTransaction(connection, new Transaction().add(cu, ix), [admin]);
}

async function addTokenConfig(connection: Connection, admin: Keypair, mint: PublicKey): Promise<void> {
  // AddTokenConfigArgs { max_tvl: u64 }. For test mints we set the cap as
  // high as it goes — the cap is exercised by the dedicated TVL tests, not
  // the e2e flow.
  const maxTvl = Buffer.alloc(8);
  maxTvl.writeBigUInt64LE(0xFFFFFFFFFFFFFFFFn, 0);
  const data = Buffer.concat([
    Buffer.from(instructionDiscriminator('add_token_config')),
    maxTvl,
  ]);

  const ix = new TransactionInstruction({
    programId: POOL_ID,
    keys: [
      { pubkey: admin.publicKey,                     isSigner: true,  isWritable: true  },
      { pubkey: admin.publicKey,                     isSigner: true,  isWritable: false },
      { pubkey: poolConfigPda(POOL_ID),              isSigner: false, isWritable: false },
      { pubkey: tokenConfigPda(POOL_ID, mint),       isSigner: false, isWritable: true  },
      { pubkey: mint,                                isSigner: false, isWritable: false },
      { pubkey: vaultPda(POOL_ID, mint),             isSigner: false, isWritable: true  },
      { pubkey: TOKEN_PROGRAM_ID,                    isSigner: false, isWritable: false },
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID,         isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId,             isSigner: false, isWritable: false },
      { pubkey: new PublicKey('SysvarRent111111111111111111111111111111111'), isSigner: false, isWritable: false },
    ],
    data,
  });

  const cu = ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 });
  await sendAndConfirmTransaction(connection, new Transaction().add(cu, ix), [admin]);
}

main().catch((e) => {
  console.error('\n❌ e2e failed:', e);
  process.exit(1);
});

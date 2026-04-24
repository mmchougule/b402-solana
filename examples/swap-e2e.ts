/**
 * swap-e2e — localnet end-to-end: shield → private swap → unshield.
 *
 * What this proves:
 *   1. Pool's `adapt_execute_devnet` handler is wired correctly (registry
 *      lookup, vault pre-snapshot, adapter CPI, post-delta invariant,
 *      commitment append).
 *   2. SDK can build an adapt_execute tx against any adapter (we use the
 *      mock adapter here; Jupiter is the same shape).
 *   3. The output commitment produced by the swap is a valid shielded
 *      note — we unshield it afterward using the standard flow.
 *
 * What this does NOT prove (known Phase 1 gaps):
 *   - No adapt circuit. Output commitment is trusted from caller.
 *   - No nullifier burn on the input side. Input tokens are moved to
 *     adapter_in_ta without proving we own any particular shielded note.
 *   - SDK privateSwap is Jupiter-shaped; here we bypass it and build the
 *     pool ix directly (the mock adapter uses Jupiter's unified ABI, so
 *     everything the SDK does is exercised in the direct build path).
 */

import {
  ComputeBudgetProgram, Connection, Keypair, LAMPORTS_PER_SOL, PublicKey,
  SystemProgram, Transaction, TransactionInstruction, sendAndConfirmTransaction,
} from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
  createMint, mintTo, getOrCreateAssociatedTokenAccount, getAccount,
} from '@solana/spl-token';
import { randomBytes as nodeRandomBytes } from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  adapterRegistryPda, buildWallet, poolConfigPda, shield, tokenConfigPda,
  treasuryPda, treeStatePda, unshield, vaultPda, fetchTreeState,
  proveMostRecentLeaf, buildZeroCache,
  instructionDiscriminator, concat, u32Le, u64Le, vecU8,
  poseidon, noteEnc,
} from '@b402ai/solana';
import { leToFrReduced } from '@b402ai/solana-shared';
import { TransactProver } from '@b402ai/solana-prover';

const { commitmentHash } = poseidon;
const { encryptNote } = noteEnc;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RPC_URL = process.env.RPC_URL ?? 'http://127.0.0.1:8899';

// Program IDs — same declare_id! as Anchor.toml + ops/local-validator.sh.
const POOL_ID            = new PublicKey('42a3hsCXtQLWonyxWZosaaCJCweYYKMrvNd25p1Jrt2y');
const VERIFIER_ID        = new PublicKey('Afjbnv2Ekxa98jjRw33xPPhZabevek2uZxoE75kr6ZrK');
const MOCK_ADAPTER_ID    = new PublicKey('89kw33YDcbXfiayVNauz599LaDm51EuU8amWydpjYKgp');

const CIRCUITS_BUILD = path.resolve(__dirname, '../circuits/build');

// Execute ix discriminator (sha256("global:execute")[0..8]).
const EXECUTE_DISC = instructionDiscriminator('execute');

async function main() {
  console.log(`▶ RPC ${RPC_URL}`);
  const connection = new Connection(RPC_URL, 'confirmed');

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
  } else {
    const walletPath = process.env.ADMIN_KEYPAIR
      ?? path.join(process.env.HOME ?? '', '.config/solana/id.json');
    const secret = new Uint8Array(JSON.parse(fs.readFileSync(walletPath, 'utf8')));
    admin = Keypair.fromSecretKey(secret);
    relayer = admin; depositor = admin;
  }
  console.log(`▶ admin=${admin.publicKey.toBase58().slice(0, 8)}… depositor=${depositor.publicKey.toBase58().slice(0, 8)}…`);

  // ---- init_pool (skip if already initialized) ----
  const cfgAcct = await connection.getAccountInfo(poolConfigPda(POOL_ID));
  if (!cfgAcct) {
    await initPool(connection, admin);
    console.log('▶ init_pool ok');
  } else {
    console.log('▶ pool already initialized');
  }

  // ---- Mints: in = synthetic "USDC-like", out = synthetic "SOL-like" ----
  const inMint  = await createMint(connection, admin, admin.publicKey, null, 6);
  const outMint = await createMint(connection, admin, admin.publicKey, null, 9);
  console.log(`▶ in_mint  = ${inMint.toBase58()}`);
  console.log(`▶ out_mint = ${outMint.toBase58()}`);

  await addTokenConfig(connection, admin, inMint);
  await addTokenConfig(connection, admin, outMint);
  console.log('▶ token configs ok');

  // ---- Register mock adapter with execute discriminator allowlisted ----
  await registerAdapter(connection, admin, MOCK_ADAPTER_ID, EXECUTE_DISC);
  console.log('▶ mock adapter registered');

  // ---- Fund depositor with in_mint + mint adapter's scratch out_ta ----
  const depositorAta = await getOrCreateAssociatedTokenAccount(
    connection, admin, inMint, depositor.publicKey,
  );
  await mintTo(connection, admin, inMint, depositorAta.address, admin, 100);
  console.log('▶ minted 100 in_mint to depositor');

  const adapterAuthority = PublicKey.findProgramAddressSync(
    [new TextEncoder().encode('b402/v1'), new TextEncoder().encode('adapter')],
    MOCK_ADAPTER_ID,
  )[0];

  const adapterOutTa = await getOrCreateAssociatedTokenAccount(
    connection, admin, outMint, adapterAuthority, true,
  );
  await mintTo(connection, admin, outMint, adapterOutTa.address, admin, 10_000);
  console.log(`▶ adapter_out_ta pre-funded with 10_000 out_mint`);

  const adapterInTa = await getOrCreateAssociatedTokenAccount(
    connection, admin, inMint, adapterAuthority, true,
  );
  console.log(`▶ adapter_in_ta created`);

  // ---- SDK wallet + prover ----
  const wallet = await buildWallet(depositor.secretKey.slice(0, 32));
  const prover = new TransactProver({
    wasmPath: path.join(CIRCUITS_BUILD, 'transact_js/transact.wasm'),
    zkeyPath: path.join(CIRCUITS_BUILD, 'ceremony/transact_final.zkey'),
  });

  // ---- Shield 100 in_mint ----
  console.log('▶ shielding 100 in_mint…');
  const shieldRes = await shield({
    connection, poolProgramId: POOL_ID, verifierProgramId: VERIFIER_ID,
    prover, wallet, mint: inMint, depositorAta: depositorAta.address,
    depositor, relayer, amount: 100n,
  });
  console.log(`  sig = ${shieldRes.signature}`);
  console.log(`  leafIndex = ${shieldRes.leafIndex}`);

  // ---- Swap: adapt_execute_devnet via mock adapter ----
  //
  // We take 50 of the shielded in_mint, the mock delivers 100 out_mint
  // (min_out = 100, delta = 0). Output commitment for recipient = us.
  const IN_AMOUNT = 50n;
  const MIN_OUT   = 100n;
  const OUT_AMT   = 100n;

  const outMintFr = leToFrReduced(outMint.toBytes());
  const outRandom = leToFrReduced(new Uint8Array(nodeRandomBytes(32)));
  const outCommitment = await commitmentHash(outMintFr, OUT_AMT, outRandom, wallet.spendingPub);
  const outEncrypted = await encryptNote(
    { tokenMint: outMintFr, value: OUT_AMT, random: outRandom, spendingPub: wallet.spendingPub },
    wallet.viewingPub, 0n,
  );

  // Adapter ix data: disc || u64 in_amount || u64 min_out || vec(payload=i64 delta LE)
  const payload = new Uint8Array(8); // delta = 0
  const rawAdapterIxData = concat(
    EXECUTE_DISC,
    u64Le(IN_AMOUNT),
    u64Le(MIN_OUT),
    vecU8(payload),
  );

  // Pool ix data: disc || AdaptExecuteDevnetArgs
  //   u64 in_amount, u64 min_out, Vec<u8> raw_adapter_ix_data,
  //   [u8;32] output_commitment, EncryptedNote(89+32+2)
  const poolIxData = concat(
    instructionDiscriminator('adapt_execute_devnet'),
    u64Le(IN_AMOUNT),
    u64Le(MIN_OUT),
    vecU8(rawAdapterIxData),
    fr32Le(outCommitment),
    outEncrypted.ciphertext,
    outEncrypted.ephemeralPub,
    outEncrypted.viewingTag,
  );

  const swapIx = new TransactionInstruction({
    programId: POOL_ID,
    keys: [
      { pubkey: depositor.publicKey,                     isSigner: true,  isWritable: true  },
      { pubkey: poolConfigPda(POOL_ID),                  isSigner: false, isWritable: false },
      { pubkey: adapterRegistryPda(POOL_ID),             isSigner: false, isWritable: false },
      { pubkey: tokenConfigPda(POOL_ID, inMint),         isSigner: false, isWritable: false },
      { pubkey: tokenConfigPda(POOL_ID, outMint),        isSigner: false, isWritable: false },
      { pubkey: vaultPda(POOL_ID, inMint),               isSigner: false, isWritable: true  },
      { pubkey: vaultPda(POOL_ID, outMint),              isSigner: false, isWritable: true  },
      { pubkey: treeStatePda(POOL_ID),                   isSigner: false, isWritable: true  },
      { pubkey: MOCK_ADAPTER_ID,                         isSigner: false, isWritable: false },
      { pubkey: adapterAuthority,                        isSigner: false, isWritable: false },
      { pubkey: adapterInTa.address,                     isSigner: false, isWritable: true  },
      { pubkey: adapterOutTa.address,                    isSigner: false, isWritable: true  },
      { pubkey: TOKEN_PROGRAM_ID,                        isSigner: false, isWritable: false },
    ],
    data: Buffer.from(poolIxData),
  });

  const cuIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 });
  const swapTx = new Transaction().add(cuIx, swapIx);

  console.log('▶ swapping 50 in_mint → 100 out_mint via mock adapter…');
  const swapStart = Date.now();
  const swapSig = await sendAndConfirmTransaction(connection, swapTx, [depositor]);
  console.log(`  sig = ${swapSig} (${Date.now() - swapStart}ms)`);

  // ---- Verify swap state changes ----
  const inVaultAcct  = await getAccount(connection, vaultPda(POOL_ID, inMint));
  const outVaultAcct = await getAccount(connection, vaultPda(POOL_ID, outMint));
  if (inVaultAcct.amount  !== 50n)  throw new Error(`in_vault=${inVaultAcct.amount} != 50`);
  if (outVaultAcct.amount !== 100n) throw new Error(`out_vault=${outVaultAcct.amount} != 100`);
  console.log(`▶ in_vault = ${inVaultAcct.amount} ✓  out_vault = ${outVaultAcct.amount} ✓`);

  const tree = await fetchTreeState(connection, treeStatePda(POOL_ID));
  const swapLeafIndex = tree.leafCount - 1n;
  console.log(`▶ output commitment appended at leaf ${swapLeafIndex}`);

  // ---- Unshield the output note ----
  const zeroCache = await buildZeroCache();
  const zeroCacheLe = zeroCache.map(v => fr32Le(v));
  const rootBig = (() => {
    let v = 0n;
    for (let i = 31; i >= 0; i--) v = (v << 8n) | BigInt(tree.currentRoot[i]);
    return v;
  })();
  const merkleProof = proveMostRecentLeaf(
    outCommitment, swapLeafIndex, rootBig, tree.frontier, zeroCacheLe,
  );

  const recipient = Keypair.generate();
  const recipientAta = await getOrCreateAssociatedTokenAccount(
    connection, admin, outMint, recipient.publicKey,
  );
  console.log(`▶ recipient ATA = ${recipientAta.address.toBase58()}`);

  const outNote = {
    tokenMint: outMintFr,
    value: OUT_AMT,
    random: outRandom,
    spendingPub: wallet.spendingPub,
    commitment: outCommitment,
    leafIndex: swapLeafIndex,
    spendingPriv: wallet.spendingPriv,
    encryptedBytes: outEncrypted.ciphertext,
    ephemeralPub: outEncrypted.ephemeralPub,
    viewingTag: outEncrypted.viewingTag,
  };

  console.log('▶ unshielding 100 out_mint to fresh recipient…');
  const unshieldStart = Date.now();
  const unshieldRes = await unshield({
    connection, poolProgramId: POOL_ID, verifierProgramId: VERIFIER_ID,
    prover, wallet, mint: outMint, note: outNote, merkleProof,
    recipientTokenAccount: recipientAta.address,
    recipientOwner: recipient.publicKey, relayer,
  });
  console.log(`  sig = ${unshieldRes.signature} (${Date.now() - unshieldStart}ms)`);

  const recipientAcct = await getAccount(connection, recipientAta.address);
  if (recipientAcct.amount !== 100n) throw new Error(`recipient=${recipientAcct.amount} != 100`);
  console.log(`▶ recipient balance = ${recipientAcct.amount} ✓`);

  const outVaultFinal = await getAccount(connection, vaultPda(POOL_ID, outMint));
  if (outVaultFinal.amount !== 0n) throw new Error(`out_vault after unshield=${outVaultFinal.amount} != 0`);
  console.log(`▶ out_vault after unshield = 0 ✓`);

  console.log('\n✅ shield → private swap → unshield successful');
  console.log(`   shield   ${shieldRes.signature}`);
  console.log(`   swap     ${swapSig}`);
  console.log(`   unshield ${unshieldRes.signature}`);
}

// ---------- helpers ----------

function fr32Le(v: bigint): Uint8Array {
  const out = new Uint8Array(32);
  let x = v;
  for (let i = 0; i < 32; i++) { out[i] = Number(x & 0xffn); x >>= 8n; }
  return out;
}

async function initPool(connection: Connection, admin: Keypair): Promise<void> {
  const data = Buffer.concat([
    Buffer.from(instructionDiscriminator('init_pool')),
    admin.publicKey.toBuffer(),
    Buffer.from([1]),
    VERIFIER_ID.toBuffer(),
    VERIFIER_ID.toBuffer(),
    VERIFIER_ID.toBuffer(),
    admin.publicKey.toBuffer(),
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
  await sendAndConfirmTransaction(connection, new Transaction().add(cu, ix), [admin]);
}

async function addTokenConfig(connection: Connection, admin: Keypair, mint: PublicKey): Promise<void> {
  const existing = await connection.getAccountInfo(tokenConfigPda(POOL_ID, mint));
  if (existing) return;

  const data = Buffer.from(instructionDiscriminator('add_token_config'));
  const ix = new TransactionInstruction({
    programId: POOL_ID,
    keys: [
      { pubkey: admin.publicKey,                   isSigner: true,  isWritable: true  },
      { pubkey: admin.publicKey,                   isSigner: true,  isWritable: false },
      { pubkey: poolConfigPda(POOL_ID),            isSigner: false, isWritable: false },
      { pubkey: tokenConfigPda(POOL_ID, mint),     isSigner: false, isWritable: true  },
      { pubkey: mint,                              isSigner: false, isWritable: false },
      { pubkey: vaultPda(POOL_ID, mint),           isSigner: false, isWritable: true  },
      { pubkey: TOKEN_PROGRAM_ID,                  isSigner: false, isWritable: false },
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID,       isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId,           isSigner: false, isWritable: false },
      { pubkey: new PublicKey('SysvarRent111111111111111111111111111111111'), isSigner: false, isWritable: false },
    ],
    data,
  });
  const cu = ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 });
  await sendAndConfirmTransaction(connection, new Transaction().add(cu, ix), [admin]);
}

async function registerAdapter(
  connection: Connection, admin: Keypair,
  adapterProgramId: PublicKey, executeDisc: Uint8Array,
): Promise<void> {
  // Args: AdapterRegistration { program_id: Pubkey, allowed_instructions: Vec<[u8;8]> }
  const args = Buffer.concat([
    adapterProgramId.toBuffer(),
    Buffer.from(u32Le(1)),       // 1 allowed instruction
    Buffer.from(executeDisc),    // the execute discriminator
  ]);
  const data = Buffer.concat([Buffer.from(instructionDiscriminator('register_adapter')), args]);

  const ix = new TransactionInstruction({
    programId: POOL_ID,
    keys: [
      { pubkey: admin.publicKey,             isSigner: true,  isWritable: true  },
      { pubkey: poolConfigPda(POOL_ID),      isSigner: false, isWritable: false },
      { pubkey: adapterRegistryPda(POOL_ID), isSigner: false, isWritable: true  },
    ],
    data,
  });
  const cu = ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 });
  await sendAndConfirmTransaction(connection, new Transaction().add(cu, ix), [admin]);
}

void treasuryPda; // treasuryPda used indirectly via init_pool path; silence unused-import
main().catch((e) => { console.error('\n❌ swap-e2e failed:', e); process.exit(1); });

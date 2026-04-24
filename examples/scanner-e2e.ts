/**
 * scanner-e2e — Alice privately sends to Bob; Bob's Scanner auto-discovers.
 *
 * Why this matters: without the scanner, the protocol is write-only from
 * the recipient's perspective. Alice could shield & pay Bob, but Bob
 * would have no way to find his own note. Scanner closes that loop.
 *
 * Flow (proving recipient-side privacy):
 *   1. Alice and Bob have independent wallets (different seeds).
 *   2. Bob's Scanner subscribes to pool program logs. Bob does NOT know
 *      any tx details ahead of time.
 *   3. Alice shields some in_mint (her own note).
 *   4. Alice privately swaps in_mint → out_mint. The output note is
 *      encrypted for Bob using only Bob's PUBLIC keys (spendingPub,
 *      viewingPub). Alice never sees Bob's private keys.
 *   5. The CommitmentAppended event fires. Bob's Scanner:
 *        - Runs the 2-byte viewing-tag pre-filter (Poseidon)
 *        - On hit, ECDH-decrypts the 89B ciphertext with Bob's viewingPriv
 *        - Verifies the recovered note hashes to the on-chain commitment
 *        - Pushes to Bob's NoteStore as a SpendableNote
 *   6. Bob reads `noteStore.getSpendable(outMintFr)` and finds the note.
 *   7. Bob unshields using the scanner-discovered note to a fresh recipient.
 *
 * Asserts: Bob's NoteStore contains exactly 1 new note after the swap,
 * and Bob can spend it without Alice having to hand over any details.
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
import { fileURLToPath } from 'node:url';

import {
  adapterRegistryPda, buildWallet, poolConfigPda, shield, tokenConfigPda,
  treeStatePda, unshield, vaultPda, fetchTreeState, proveMostRecentLeaf,
  buildZeroCache, instructionDiscriminator, concat, u32Le, u64Le, vecU8,
  poseidon, noteEnc, Scanner, NoteStore, ClientMerkleTree,
} from '@b402ai/solana';
import { leToFrReduced } from '@b402ai/solana-shared';
import { TransactProver } from '@b402ai/solana-prover';

const { commitmentHash } = poseidon;
const { encryptNote } = noteEnc;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RPC_URL = 'http://127.0.0.1:8899';

const POOL_ID         = new PublicKey('42a3hsCXtQLWonyxWZosaaCJCweYYKMrvNd25p1Jrt2y');
const VERIFIER_ID     = new PublicKey('Afjbnv2Ekxa98jjRw33xPPhZabevek2uZxoE75kr6ZrK');
const MOCK_ADAPTER_ID = new PublicKey('89kw33YDcbXfiayVNauz599LaDm51EuU8amWydpjYKgp');

const CIRCUITS_BUILD = path.resolve(__dirname, '../circuits/build');
const EXECUTE_DISC = instructionDiscriminator('execute');

async function main() {
  console.log(`▶ RPC ${RPC_URL}`);
  // Separate connections: confirmed for tx submission, processed for the
  // scanner's log subscription to catch events as soon as they land.
  const connection = new Connection(RPC_URL, 'confirmed');
  const wsConnection = new Connection(RPC_URL, 'confirmed');

  // ---- Alice, Bob, Charlie (recipient of unshield) ----
  const admin  = Keypair.fromSeed(new Uint8Array(32).fill(7));  // pool admin
  const alice  = Keypair.generate();                             // sender
  const bob    = Keypair.generate();                             // recipient (privately)
  const charlie = Keypair.generate();                            // final unshield recipient

  for (const kp of [admin, alice, bob, charlie]) {
    const sig = await connection.requestAirdrop(kp.publicKey, 5 * LAMPORTS_PER_SOL);
    await connection.confirmTransaction(sig, 'confirmed');
  }
  console.log(`▶ airdropped admin/alice/bob/charlie`);

  // Wallets — Alice and Bob have independent seeds.
  const aliceWallet = await buildWallet(alice.secretKey.slice(0, 32));
  const bobWallet   = await buildWallet(bob.secretKey.slice(0, 32));
  console.log(`  alice spendingPub = ${aliceWallet.spendingPub.toString().slice(0, 16)}…`);
  console.log(`  bob   spendingPub = ${bobWallet.spendingPub.toString().slice(0, 16)}…`);

  // ---- Pool setup (admin-side) ----
  const cfgAcct = await connection.getAccountInfo(poolConfigPda(POOL_ID));
  if (!cfgAcct) { await initPool(connection, admin); console.log('▶ init_pool ok'); }

  const inMint  = await createMint(connection, admin, admin.publicKey, null, 6);
  const outMint = await createMint(connection, admin, admin.publicKey, null, 9);
  console.log(`▶ in_mint=${inMint.toBase58().slice(0,8)}…  out_mint=${outMint.toBase58().slice(0,8)}…`);

  await addTokenConfig(connection, admin, inMint);
  await addTokenConfig(connection, admin, outMint);
  await registerAdapter(connection, admin, MOCK_ADAPTER_ID, EXECUTE_DISC);

  // Fund Alice with in_mint.
  const aliceInAta = await getOrCreateAssociatedTokenAccount(connection, admin, inMint, alice.publicKey);
  await mintTo(connection, admin, inMint, aliceInAta.address, admin, 100);
  console.log(`▶ minted 100 in_mint to alice`);

  // Adapter scratch ATAs + pre-fund supply.
  const adapterAuthority = PublicKey.findProgramAddressSync(
    [new TextEncoder().encode('b402/v1'), new TextEncoder().encode('adapter')],
    MOCK_ADAPTER_ID,
  )[0];
  const adapterInTa  = await getOrCreateAssociatedTokenAccount(connection, admin, inMint,  adapterAuthority, true);
  const adapterOutTa = await getOrCreateAssociatedTokenAccount(connection, admin, outMint, adapterAuthority, true);
  await mintTo(connection, admin, outMint, adapterOutTa.address, admin, 10_000);

  // ---- Bob's Scanner — running with ONLY Bob's keys ----
  const bobTree = new ClientMerkleTree();
  await bobTree.init();
  const bobNoteStore = new NoteStore({ connection: wsConnection, poolProgramId: POOL_ID, wallet: bobWallet });
  const bobScanner = new Scanner({
    connection: wsConnection, poolProgramId: POOL_ID,
    wallet: bobWallet, noteStore: bobNoteStore, tree: bobTree,
  });
  await bobScanner.start();
  console.log('▶ bob\'s scanner subscribed to pool logs');

  const prover = new TransactProver({
    wasmPath: path.join(CIRCUITS_BUILD, 'transact_js/transact.wasm'),
    zkeyPath: path.join(CIRCUITS_BUILD, 'ceremony/transact_final.zkey'),
  });

  // ---- Alice shields 100 in_mint (her own note) ----
  console.log('▶ alice shielding 100 in_mint…');
  const shieldRes = await shield({
    connection, poolProgramId: POOL_ID, verifierProgramId: VERIFIER_ID,
    prover, wallet: aliceWallet, mint: inMint,
    depositorAta: aliceInAta.address, depositor: alice, relayer: alice,
    amount: 100n,
  });
  console.log(`  sig = ${shieldRes.signature}`);

  // ---- Alice privately swaps → Bob (output note encrypted for Bob) ----
  // Alice uses ONLY Bob's public keys. She never touches bobWallet.spendingPriv.
  const outMintFr = leToFrReduced(outMint.toBytes());
  const outRandom = leToFrReduced(new Uint8Array(nodeRandomBytes(32)));
  const IN_AMOUNT = 50n;
  const MIN_OUT   = 100n;
  const OUT_AMT   = 100n;

  const outCommitment = await commitmentHash(
    outMintFr, OUT_AMT, outRandom,
    bobWallet.spendingPub,   // <-- BOB's public spending key
  );
  // Crucial: the ChaCha20-Poly1305 nonce is derived from the leafIndex.
  // Alice must predict the index the output commitment will land at (= the
  // tree's current leafCount). Wrong index → Bob's scanner decrypts to
  // garbage and can't reconstruct the note.
  const preTree = await fetchTreeState(connection, treeStatePda(POOL_ID));
  const expectedLeafIndex = preTree.leafCount;
  const outEncrypted = await encryptNote(
    { tokenMint: outMintFr, value: OUT_AMT, random: outRandom, spendingPub: bobWallet.spendingPub },
    bobWallet.viewingPub,    // <-- BOB's public viewing key (X25519)
    expectedLeafIndex,
  );

  const payload = new Uint8Array(8); // delta=0
  const rawAdapterIxData = concat(
    EXECUTE_DISC, u64Le(IN_AMOUNT), u64Le(MIN_OUT), vecU8(payload),
  );
  const poolIxData = concat(
    instructionDiscriminator('adapt_execute_devnet'),
    u64Le(IN_AMOUNT), u64Le(MIN_OUT), vecU8(rawAdapterIxData),
    fr32Le(outCommitment),
    outEncrypted.ciphertext, outEncrypted.ephemeralPub, outEncrypted.viewingTag,
  );

  const swapIx = new TransactionInstruction({
    programId: POOL_ID,
    keys: [
      { pubkey: alice.publicKey,                          isSigner: true,  isWritable: true  },
      { pubkey: poolConfigPda(POOL_ID),                   isSigner: false, isWritable: false },
      { pubkey: adapterRegistryPda(POOL_ID),              isSigner: false, isWritable: false },
      { pubkey: tokenConfigPda(POOL_ID, inMint),          isSigner: false, isWritable: false },
      { pubkey: tokenConfigPda(POOL_ID, outMint),         isSigner: false, isWritable: false },
      { pubkey: vaultPda(POOL_ID, inMint),                isSigner: false, isWritable: true  },
      { pubkey: vaultPda(POOL_ID, outMint),               isSigner: false, isWritable: true  },
      { pubkey: treeStatePda(POOL_ID),                    isSigner: false, isWritable: true  },
      { pubkey: MOCK_ADAPTER_ID,                          isSigner: false, isWritable: false },
      { pubkey: adapterAuthority,                         isSigner: false, isWritable: false },
      { pubkey: adapterInTa.address,                      isSigner: false, isWritable: true  },
      { pubkey: adapterOutTa.address,                     isSigner: false, isWritable: true  },
      { pubkey: TOKEN_PROGRAM_ID,                         isSigner: false, isWritable: false },
    ],
    data: Buffer.from(poolIxData),
  });
  const cuIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 });

  console.log(`▶ alice privately swapping 50 in_mint → 100 out_mint (note encrypted for bob)…`);
  const swapSig = await sendAndConfirmTransaction(
    connection, new Transaction().add(cuIx, swapIx), [alice],
  );
  console.log(`  sig = ${swapSig}`);

  // ---- Wait for Bob's scanner to discover the note ----
  // The scanner subscribes via `onLogs`; give it a beat to catch up.
  console.log(`▶ waiting for bob\'s scanner to discover the note…`);
  const discovered = await waitForNote(bobNoteStore, outMintFr, 10_000);
  if (!discovered) {
    throw new Error('bob\'s scanner did not discover the note within 10s');
  }
  console.log(`▶ scanner discovered ${discovered.length} note(s) for bob`);
  const bobNote = discovered[0];
  console.log(`  commitment = ${bobNote.commitment.toString().slice(0, 24)}…`);
  console.log(`  leafIndex  = ${bobNote.leafIndex}`);
  console.log(`  value      = ${bobNote.value}`);

  // Assert: the note's commitment matches what Alice wrote on-chain.
  if (bobNote.commitment !== outCommitment) {
    throw new Error(`scanner commitment mismatch ${bobNote.commitment} vs ${outCommitment}`);
  }
  // Assert: Bob's noteStore filled in his spendingPriv for actual spending.
  if (bobNote.spendingPriv !== bobWallet.spendingPriv) {
    throw new Error('spendingPriv not populated by NoteStore');
  }
  console.log('▶ commitment + spendingPriv assertions passed');

  // ---- Bob unshields using the scanner-discovered note ----
  const tree = await fetchTreeState(connection, treeStatePda(POOL_ID));
  const zeroCache = await buildZeroCache();
  const zeroCacheLe = zeroCache.map(v => fr32Le(v));
  const rootBig = (() => {
    let v = 0n;
    for (let i = 31; i >= 0; i--) v = (v << 8n) | BigInt(tree.currentRoot[i]);
    return v;
  })();
  const merkleProof = proveMostRecentLeaf(
    bobNote.commitment, bobNote.leafIndex, rootBig, tree.frontier, zeroCacheLe,
  );

  const charlieAta = await getOrCreateAssociatedTokenAccount(
    connection, admin, outMint, charlie.publicKey,
  );
  console.log(`▶ bob unshielding 100 out_mint to charlie (${charlieAta.address.toBase58().slice(0,8)}…)…`);
  const unshieldRes = await unshield({
    connection, poolProgramId: POOL_ID, verifierProgramId: VERIFIER_ID,
    prover, wallet: bobWallet, mint: outMint, note: bobNote, merkleProof,
    recipientTokenAccount: charlieAta.address,
    recipientOwner: charlie.publicKey, relayer: bob,
  });
  console.log(`  sig = ${unshieldRes.signature}`);

  const charlieAcct = await getAccount(connection, charlieAta.address);
  if (charlieAcct.amount !== OUT_AMT) throw new Error(`charlie got ${charlieAcct.amount} != ${OUT_AMT}`);
  console.log(`▶ charlie balance = ${charlieAcct.amount} ✓`);

  await bobScanner.stop();

  console.log('\n✅ alice → bob via scanner-discovery → charlie successful');
  console.log(`   alice shielded:  ${shieldRes.signature}`);
  console.log(`   alice swapped:   ${swapSig}`);
  console.log(`   bob unshielded:  ${unshieldRes.signature}`);
  console.log('   bob never knew note details ahead of time — scanner found it from public logs only');
}

// ---------- helpers ----------

function fr32Le(v: bigint): Uint8Array {
  const out = new Uint8Array(32);
  let x = v;
  for (let i = 0; i < 32; i++) { out[i] = Number(x & 0xffn); x >>= 8n; }
  return out;
}

async function waitForNote(store: NoteStore, mintFr: bigint, timeoutMs: number) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const notes = store.getSpendable(mintFr);
    if (notes.length > 0) return notes;
    await new Promise(r => setTimeout(r, 200));
  }
  return null;
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
  const treasuryPda = PublicKey.findProgramAddressSync(
    [new TextEncoder().encode('b402/v1'), new TextEncoder().encode('treasury')], POOL_ID,
  )[0];
  const ix = new TransactionInstruction({
    programId: POOL_ID,
    keys: [
      { pubkey: admin.publicKey,             isSigner: true,  isWritable: true  },
      { pubkey: poolConfigPda(POOL_ID),      isSigner: false, isWritable: true  },
      { pubkey: treeStatePda(POOL_ID),       isSigner: false, isWritable: true  },
      { pubkey: adapterRegistryPda(POOL_ID), isSigner: false, isWritable: true  },
      { pubkey: treasuryPda,                 isSigner: false, isWritable: true  },
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
  const registryAcct = await connection.getAccountInfo(adapterRegistryPda(POOL_ID));
  if (registryAcct && registryAcct.data.length > 12) {
    const target = adapterProgramId.toBuffer();
    for (let i = 12; i + 32 <= registryAcct.data.length; i++) {
      if (registryAcct.data.slice(i, i + 32).equals(target)) return;
    }
  }
  const args = Buffer.concat([
    adapterProgramId.toBuffer(),
    Buffer.from(u32Le(1)),
    Buffer.from(executeDisc),
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

main().catch((e) => { console.error('\n❌ scanner-e2e failed:', e); process.exit(1); });

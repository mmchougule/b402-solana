/**
 * swap-e2e — full end-to-end with REAL ZK proofs:
 *   shield → adapt_execute (with real Groth16 adapt proof) → unshield.
 *
 * Proves the full Phase 2 pipeline:
 *   - transact circuit (shield + unshield)
 *   - adapt circuit + b402_verifier_adapt (composable private execution)
 *   - b402-pool: registry check, adapter_id binding, action_hash binding,
 *     nullifier burn, vault transfer, adapter CPI, delta invariant, tree append
 *
 * Uses mock adapter as a stand-in (unified ABI matches Jupiter adapter;
 * Jupiter mainnet-fork version adds AMM routing on top).
 *
 * Usage:
 *   ./ops/local-validator.sh --reset          # terminal 1
 *   pnpm swap-e2e                             # terminal 2
 */

import {
  AddressLookupTableAccount, AddressLookupTableProgram,
  ComputeBudgetProgram, Connection, Keypair, LAMPORTS_PER_SOL, PublicKey,
  SystemProgram, Transaction, TransactionInstruction,
  TransactionMessage, VersionedTransaction, sendAndConfirmTransaction,
} from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
  createMint, mintTo, getOrCreateAssociatedTokenAccount, getAccount,
} from '@solana/spl-token';
import { randomBytes as nodeRandomBytes } from 'node:crypto';
import { keccak_256 } from '@noble/hashes/sha3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  adapterRegistryPda, buildWallet, poolConfigPda, shield, tokenConfigPda,
  treeStatePda, unshield, vaultPda, fetchTreeState, proveMostRecentLeaf,
  buildZeroCache, instructionDiscriminator, concat, u16Le, u32Le, u64Le, vecU8,
  poseidon, noteEnc, nullifierShardPda, shardPrefix,
} from '@b402ai/solana';
import { leToFrReduced } from '@b402ai/solana-shared';
import { TransactProver, AdaptProver, type AdaptWitness } from '@b402ai/solana-prover';

const { commitmentHash, nullifierHash, poseidonTagged, feeBindHash } = poseidon;
const { encryptNote } = noteEnc;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RPC_URL = process.env.RPC_URL ?? 'http://127.0.0.1:8899';

const POOL_ID         = new PublicKey('42a3hsCXtQLWonyxWZosaaCJCweYYKMrvNd25p1Jrt2y');
const VERIFIER_T_ID   = new PublicKey('Afjbnv2Ekxa98jjRw33xPPhZabevek2uZxoE75kr6ZrK');
const VERIFIER_A_ID   = new PublicKey('3Y2tyhNSaUiW5AcZcmFGRyTMdnroxHxc5GqFQPcMTZae');
const MOCK_ADAPTER_ID = new PublicKey('89kw33YDcbXfiayVNauz599LaDm51EuU8amWydpjYKgp');

const CIRCUITS_BUILD = path.resolve(__dirname, '../circuits/build');
const EXECUTE_DISC   = instructionDiscriminator('execute');

const P = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
function domainTagFr(tag: string): bigint {
  let acc = 0n;
  for (let i = 0; i < tag.length; i++) acc = (acc << 8n) | BigInt(tag.charCodeAt(i));
  return acc % P;
}

async function main() {
  console.log(`▶ RPC ${RPC_URL}`);
  const connection = new Connection(RPC_URL, 'confirmed');

  // Localnet: airdrop fresh keypairs. Devnet: use CLI wallet as admin (it's
  // the pool's admin_multisig, set at deploy). Override via ADMIN_KEYPAIR.
  const isLocal = RPC_URL.includes('127.0.0.1');
  let admin: Keypair;
  const alice   = Keypair.generate();
  const charlie = Keypair.generate();

  if (isLocal) {
    admin = Keypair.fromSeed(new Uint8Array(32).fill(7));
    for (const kp of [admin, alice, charlie]) {
      const sig = await connection.requestAirdrop(kp.publicKey, 5 * LAMPORTS_PER_SOL);
      await connection.confirmTransaction(sig, 'confirmed');
    }
  } else {
    const walletPath = process.env.ADMIN_KEYPAIR
      ?? path.join(process.env.HOME ?? '', '.config/solana/id.json');
    admin = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(walletPath, 'utf8'))));
    // Fund alice + charlie from admin so we don't hit devnet airdrop limits.
    // Alice pays rent for 2 nullifier shards (~0.07 SOL each) + tx fees,
    // so fund generously. Charlie just needs an ATA for the unshield.
    const fund = new Transaction()
      .add(SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: alice.publicKey,   lamports: 0.5 * LAMPORTS_PER_SOL }))
      .add(SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: charlie.publicKey, lamports: 0.05 * LAMPORTS_PER_SOL }));
    await sendAndConfirmTransaction(connection, fund, [admin]);
    const bal = await connection.getBalance(admin.publicKey);
    console.log(`▶ using CLI wallet ${admin.publicKey.toBase58().slice(0, 8)}… (${(bal / LAMPORTS_PER_SOL).toFixed(3)} SOL)`);
  }

  const aliceWallet = await buildWallet(alice.secretKey.slice(0, 32));

  // --- init pool + token configs + adapter registry ---
  const cfgAcct = await connection.getAccountInfo(poolConfigPda(POOL_ID));
  if (!cfgAcct) { await initPool(connection, admin); console.log('▶ init_pool ok'); }

  const inMint  = await createMint(connection, admin, admin.publicKey, null, 6);
  const outMint = await createMint(connection, admin, admin.publicKey, null, 9);
  console.log(`▶ in_mint=${inMint.toBase58().slice(0,8)}…  out_mint=${outMint.toBase58().slice(0,8)}…`);

  await addTokenConfig(connection, admin, inMint);
  await addTokenConfig(connection, admin, outMint);
  await registerAdapter(connection, admin, MOCK_ADAPTER_ID, EXECUTE_DISC);

  const aliceInAta = await getOrCreateAssociatedTokenAccount(connection, admin, inMint, alice.publicKey);
  await mintTo(connection, admin, inMint, aliceInAta.address, admin, 100);

  const adapterAuthority = PublicKey.findProgramAddressSync(
    [new TextEncoder().encode('b402/v1'), new TextEncoder().encode('adapter')],
    MOCK_ADAPTER_ID,
  )[0];
  const adapterInTa  = await getOrCreateAssociatedTokenAccount(connection, admin, inMint,  adapterAuthority, true);
  const adapterOutTa = await getOrCreateAssociatedTokenAccount(connection, admin, outMint, adapterAuthority, true);
  await mintTo(connection, admin, outMint, adapterOutTa.address, admin, 100_000);
  console.log(`▶ setup: adapter scratch TAs + adapter_out_ta pre-funded with 100_000 out_mint`);

  const transactProver = new TransactProver({
    wasmPath: path.join(CIRCUITS_BUILD, 'transact_js/transact.wasm'),
    zkeyPath: path.join(CIRCUITS_BUILD, 'ceremony/transact_final.zkey'),
  });
  const adaptProver = new AdaptProver({
    wasmPath: path.join(CIRCUITS_BUILD, 'adapt_js/adapt.wasm'),
    zkeyPath: path.join(CIRCUITS_BUILD, 'ceremony/adapt_final.zkey'),
  });

  // --- 1. Alice shields 100 in_mint ---
  const SHIELD_AMOUNT = 100n;
  console.log(`▶ alice shielding ${SHIELD_AMOUNT} in_mint…`);
  const shieldRes = await shield({
    connection, poolProgramId: POOL_ID, verifierProgramId: VERIFIER_T_ID,
    prover: transactProver, wallet: aliceWallet, mint: inMint,
    depositorAta: aliceInAta.address, depositor: alice, relayer: alice,
    amount: SHIELD_AMOUNT,
  });
  console.log(`  sig = ${shieldRes.signature}`);

  // --- 2. Build adapt witness + generate real proof ---
  // fee=0 keeps the tx lean and skips the fee-recipient ATA account.
  const PUBLIC_AMOUNT_IN = 100n;
  const RELAYER_FEE      = 0n;
  const EXPECTED_OUT     = 200n;
  const OUT_NOTE_VAL     = 200n;

  const actionPayload = new Uint8Array(8); // mock adapter's delta=0

  const rawAdapterIxData = concat(
    EXECUTE_DISC,
    u64Le(PUBLIC_AMOUNT_IN),
    u64Le(EXPECTED_OUT),
    vecU8(actionPayload),
  );

  const tree = await fetchTreeState(connection, treeStatePda(POOL_ID));
  const zeroCache = await buildZeroCache();
  const zeroCacheLe = zeroCache.map(v => fr32Le(v));
  const rootBig = leToBigintBE(tree.currentRoot);
  const merkleProof = proveMostRecentLeaf(
    shieldRes.commitment, shieldRes.leafIndex, rootBig, tree.frontier, zeroCacheLe,
  );

  const outMintFr  = leToFrReduced(outMint.toBytes());
  const inMintFr   = leToFrReduced(inMint.toBytes());
  const outRandom  = leToFrReduced(new Uint8Array(nodeRandomBytes(32)));
  const outCommitment = await commitmentHash(outMintFr, OUT_NOTE_VAL, outRandom, aliceWallet.spendingPub);
  const encryptedNote = await encryptNote(
    { tokenMint: outMintFr, value: OUT_NOTE_VAL, random: outRandom, spendingPub: aliceWallet.spendingPub },
    aliceWallet.viewingPub, tree.leafCount,
  );

  const adapterIdFr      = leToFrReduced(keccak_256(MOCK_ADAPTER_ID.toBytes()) as Uint8Array);
  const payloadKeccakFr  = leToFrReduced(keccak_256(actionPayload) as Uint8Array);
  const adaptBindTagFr   = domainTagFr('b402/v1/adapt-bind');
  const actionHash       = await poseidonTagged('adaptBind', payloadKeccakFr, outMintFr);

  const nullifierVal = await nullifierHash(aliceWallet.spendingPriv, shieldRes.leafIndex);
  const nullifierLe  = fr32Le(nullifierVal);
  const nullPrefix   = shardPrefix(nullifierLe);
  const dummyPrefix  = (nullPrefix + 1) & 0xffff;

  const feeBind = await feeBindHash(0n, 0n);
  const recipientBindVal = await poseidonTagged('recipientBind', 0n, 0n);

  const witness: AdaptWitness = {
    merkleRoot: rootBig,
    nullifier: [nullifierVal, 0n],
    commitmentOut: [outCommitment, 0n],
    publicAmountIn: PUBLIC_AMOUNT_IN,
    publicAmountOut: 0n,
    publicTokenMint: inMintFr,
    relayerFee: RELAYER_FEE,
    relayerFeeBind: feeBind,
    rootBind: 0n,
    recipientBind: recipientBindVal,
    commitTag:        domainTagFr('b402/v1/commit'),
    nullTag:          domainTagFr('b402/v1/null'),
    mkNodeTag:        domainTagFr('b402/v1/mk-node'),
    spendKeyPubTag:   domainTagFr('b402/v1/spend-key-pub'),
    feeBindTag:       domainTagFr('b402/v1/fee-bind'),
    recipientBindTag: domainTagFr('b402/v1/recipient-bind'),
    adapterId: adapterIdFr,
    actionHash,
    expectedOutValue: EXPECTED_OUT,
    expectedOutMint: outMintFr,
    adaptBindTag: adaptBindTagFr,
    inTokenMint:    [inMintFr, 0n],
    inValue:        [SHIELD_AMOUNT, 0n],
    inRandom:       [shieldRes.note.random, 0n],
    inSpendingPriv: [aliceWallet.spendingPriv, 1n],
    inLeafIndex:    [shieldRes.leafIndex, 0n],
    inSiblings:     [merkleProof.siblings, zeroCache.slice(0, 26)],
    inPathBits:     [merkleProof.pathBits, Array(26).fill(0)],
    inIsDummy:      [0, 1],
    outValue:       [OUT_NOTE_VAL, 0n],
    outRandom:      [outRandom, 0n],
    outSpendingPub: [aliceWallet.spendingPub, 0n],
    outIsDummy:     [0, 1],
    relayerFeeRecipient: 0n,
    recipientOwnerLow: 0n,
    recipientOwnerHigh: 0n,
    actionPayloadKeccakFr: payloadKeccakFr,
  };

  console.log(`▶ generating adapt proof…`);
  const proveStart = Date.now();
  const proof = await adaptProver.prove(witness);
  console.log(`  done in ${Date.now() - proveStart}ms (${proof.publicInputsLeBytes.length} public inputs)`);

  // --- 3. Build pool ix ---
  // fee=0 still needs a TokenAccount in that slot (Anchor constraint).
  // Use a dedicated ATA (not `in_vault`) to avoid the same pubkey appearing
  // twice as writable in the tx — Solana's runtime rejects with
  // "Overlapping copy" when a writable account meta duplicates.
  const feeAtaSentinel = (await getOrCreateAssociatedTokenAccount(
    connection, admin, inMint, admin.publicKey,
  )).address;

  const shardPda0 = nullifierShardPda(POOL_ID, nullPrefix);
  const shardPda1 = nullifierShardPda(POOL_ID, dummyPrefix);

  const poolIxData = concat(
    instructionDiscriminator('adapt_execute'),
    vecU8(proof.proofBytes),
    proof.publicInputsLeBytes[0],   // merkle_root
    proof.publicInputsLeBytes[1],   // nullifier[0]
    proof.publicInputsLeBytes[2],   // nullifier[1]
    proof.publicInputsLeBytes[3],   // commitment_out[0]
    proof.publicInputsLeBytes[4],   // commitment_out[1]
    u64Le(PUBLIC_AMOUNT_IN),
    u64Le(0n),                       // public_amount_out
    inMint.toBytes(),                // public_token_mint
    u64Le(RELAYER_FEE),
    proof.publicInputsLeBytes[9],    // relayer_fee_bind
    proof.publicInputsLeBytes[10],   // root_bind
    proof.publicInputsLeBytes[11],   // recipient_bind
    proof.publicInputsLeBytes[18],   // adapter_id
    proof.publicInputsLeBytes[19],   // action_hash
    u64Le(EXPECTED_OUT),
    outMint.toBytes(),               // expected_out_mint
    // Omit encrypted_notes to save ~127B of ix data so the tx fits with
    // shards inline (shards in ALT cause an init_if_needed error — leaving
    // them inline here). Scanner auto-discovery is covered by scanner-e2e.ts;
    // this script tests the adapt handler itself.
    u32Le(0),                        // encrypted_notes vec len = 0
    new Uint8Array([0b10]),          // in_dummy_mask
    new Uint8Array([0b10]),          // out_dummy_mask
    u16Le(nullPrefix), u16Le(dummyPrefix),
    alice.publicKey.toBytes(),       // relayer_fee_recipient (unused when fee=0)
    vecU8(rawAdapterIxData),
    vecU8(actionPayload),
  );

  const poolIxKeys = [
    { pubkey: alice.publicKey,                        isSigner: true,  isWritable: true  },
    { pubkey: poolConfigPda(POOL_ID),                 isSigner: false, isWritable: false },
    { pubkey: adapterRegistryPda(POOL_ID),            isSigner: false, isWritable: false },
    { pubkey: tokenConfigPda(POOL_ID, inMint),        isSigner: false, isWritable: false },
    { pubkey: tokenConfigPda(POOL_ID, outMint),       isSigner: false, isWritable: false },
    { pubkey: vaultPda(POOL_ID, inMint),              isSigner: false, isWritable: true  },
    { pubkey: vaultPda(POOL_ID, outMint),             isSigner: false, isWritable: true  },
    { pubkey: treeStatePda(POOL_ID),                  isSigner: false, isWritable: true  },
    { pubkey: VERIFIER_A_ID,                          isSigner: false, isWritable: false },
    { pubkey: MOCK_ADAPTER_ID,                        isSigner: false, isWritable: false },
    { pubkey: adapterAuthority,                       isSigner: false, isWritable: false },
    { pubkey: adapterInTa.address,                    isSigner: false, isWritable: true  },
    { pubkey: adapterOutTa.address,                   isSigner: false, isWritable: true  },
    // relayer_fee_ta: any TA in IN mint owned by relayer_fee_recipient. Fee=0
    // here, so we pass alice's IN ATA as a sentinel (handler skips owner check).
    { pubkey: aliceInAta.address,                     isSigner: false, isWritable: true  },
    { pubkey: shardPda0,                              isSigner: false, isWritable: true  },
    { pubkey: shardPda1,                              isSigner: false, isWritable: true  },
    { pubkey: TOKEN_PROGRAM_ID,                       isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId,                isSigner: false, isWritable: false },
  ];
  const poolIx = new TransactionInstruction({
    programId: POOL_ID,
    keys: poolIxKeys,
    data: Buffer.from(poolIxData),
  });
  const cuIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 });

  // ALT packs the 12 stable accounts so the v0 tx fits the 1232 B cap.
  const alt = await createTestAlt(connection, admin, [
    poolConfigPda(POOL_ID),
    adapterRegistryPda(POOL_ID),
    vaultPda(POOL_ID, outMint),
    treeStatePda(POOL_ID),
    VERIFIER_A_ID,
    MOCK_ADAPTER_ID,
    adapterAuthority,
    adapterInTa.address,
    adapterOutTa.address,
    aliceInAta.address,
    TOKEN_PROGRAM_ID,
    SystemProgram.programId,
  ]);

  console.log(`▶ adapt_execute…`);
  const adaptStart = Date.now();
  const blockhash = (await connection.getLatestBlockhash('confirmed')).blockhash;
  const msg = new TransactionMessage({
    payerKey: alice.publicKey,
    recentBlockhash: blockhash,
    instructions: [cuIx, poolIx],
  }).compileToV0Message([alt]);
  const vtx = new VersionedTransaction(msg);
  vtx.sign([alice]);
  const swapSig = await connection.sendRawTransaction(vtx.serialize(), { skipPreflight: true });
  await connection.confirmTransaction(swapSig, 'confirmed');
  console.log(`  sig = ${swapSig} (${Date.now() - adaptStart}ms)`);

  // CU budget regression guard. Real measurements (devnet, mock adapter):
  //   pool full invocation: ~325k CU
  //   verifier_adapt CPI:   ~207k CU (Groth16, ≈99% of pool's nested cost)
  //   mock adapter CPI:      ~16k CU
  // Assert pool's outer instruction stays under 600k CU — gives us 800k+ of
  // headroom inside the 1.4M cap for real adapter work (Jupiter 3-hop ~200k,
  // Drift settle ~120k, Pyth update ~30k). If this trips, the pool grew
  // before the adapter did and that's the regression to investigate.
  const swapTx = await connection.getTransaction(swapSig, {
    commitment: 'confirmed',
    maxSupportedTransactionVersion: 0,
  });
  const poolCuLine = swapTx?.meta?.logMessages?.find(
    (l) => l.includes(POOL_ID.toBase58()) && l.includes('consumed') && !l.includes('failed')
  );
  const m = poolCuLine?.match(/consumed (\d+) of (\d+) compute units/);
  const poolCu = m ? Number(m[1]) : 0;
  const POOL_CU_REGRESSION_CAP = 600_000;
  console.log(`  pool CU: ${poolCu.toLocaleString()} / ${POOL_CU_REGRESSION_CAP.toLocaleString()} cap`);
  if (poolCu === 0) throw new Error(`could not extract pool CU from logs`);
  if (poolCu > POOL_CU_REGRESSION_CAP) {
    throw new Error(`pool CU regression: ${poolCu} > ${POOL_CU_REGRESSION_CAP}`);
  }

  // --- Verify vault state ---
  const inVaultAcct  = await getAccount(connection, vaultPda(POOL_ID, inMint));
  const outVaultAcct = await getAccount(connection, vaultPda(POOL_ID, outMint));
  if (inVaultAcct.amount  !== 0n)   throw new Error(`in_vault=${inVaultAcct.amount} != 0`);
  if (outVaultAcct.amount !== 200n) throw new Error(`out_vault=${outVaultAcct.amount} != 200`);
  console.log(`▶ in_vault=0, out_vault=200 ✓`);

  const treeAfter = await fetchTreeState(connection, treeStatePda(POOL_ID));
  const swapLeafIndex = treeAfter.leafCount - 1n;

  // --- Unshield the adapt output ---
  const zeroCacheAfterLe = (await buildZeroCache()).map(v => fr32Le(v));
  const rootAfterBig = leToBigintBE(treeAfter.currentRoot);
  const outProof = proveMostRecentLeaf(
    outCommitment, swapLeafIndex, rootAfterBig, treeAfter.frontier, zeroCacheAfterLe,
  );
  const charlieAta = await getOrCreateAssociatedTokenAccount(connection, admin, outMint, charlie.publicKey);
  const outNote = {
    tokenMint: outMintFr, value: OUT_NOTE_VAL, random: outRandom,
    spendingPub: aliceWallet.spendingPub, commitment: outCommitment,
    leafIndex: swapLeafIndex, spendingPriv: aliceWallet.spendingPriv,
    encryptedBytes: encryptedNote.ciphertext,
    ephemeralPub: encryptedNote.ephemeralPub,
    viewingTag: encryptedNote.viewingTag,
  };
  console.log(`▶ unshielding ${OUT_NOTE_VAL} out_mint to charlie…`);
  const unshieldRes = await unshield({
    connection, poolProgramId: POOL_ID, verifierProgramId: VERIFIER_T_ID,
    prover: transactProver, wallet: aliceWallet, mint: outMint, note: outNote,
    merkleProof: outProof,
    recipientTokenAccount: charlieAta.address,
    recipientOwner: charlie.publicKey, relayer: alice,
  });

  const charlieAcct = await getAccount(connection, charlieAta.address);
  if (charlieAcct.amount !== OUT_NOTE_VAL) throw new Error(`charlie got ${charlieAcct.amount} != ${OUT_NOTE_VAL}`);
  console.log(`▶ charlie balance = ${charlieAcct.amount} ✓`);

  console.log('\n✅ shield → REAL-ZK adapt_execute → unshield successful');
  console.log(`   shield   ${shieldRes.signature}`);
  console.log(`   adapt    ${swapSig}`);
  console.log(`   unshield ${unshieldRes.signature}`);
}

// ---------- helpers ----------

function fr32Le(v: bigint): Uint8Array {
  const out = new Uint8Array(32);
  let x = v;
  for (let i = 0; i < 32; i++) { out[i] = Number(x & 0xffn); x >>= 8n; }
  return out;
}
function leToBigintBE(b: Uint8Array): bigint {
  let v = 0n;
  for (let i = 31; i >= 0; i--) v = (v << 8n) | BigInt(b[i]);
  return v;
}

async function createTestAlt(
  connection: Connection, authority: Keypair, addresses: PublicKey[],
): Promise<AddressLookupTableAccount> {
  const slot = await connection.getSlot('finalized');
  const [createIx, altKey] = AddressLookupTableProgram.createLookupTable({
    authority: authority.publicKey,
    payer: authority.publicKey,
    recentSlot: slot,
  });
  await sendAndConfirmTransaction(connection, new Transaction().add(createIx), [authority]);
  for (let i = 0; i < addresses.length; i += 20) {
    const batch = addresses.slice(i, i + 20);
    const ext = AddressLookupTableProgram.extendLookupTable({
      payer: authority.publicKey,
      authority: authority.publicKey,
      lookupTable: altKey,
      addresses: batch,
    });
    await sendAndConfirmTransaction(connection, new Transaction().add(ext), [authority]);
  }
  await new Promise(r => setTimeout(r, 500));
  const fetched = await connection.getAddressLookupTable(altKey);
  if (!fetched.value) throw new Error('ALT fetch failed');
  return fetched.value;
}

async function initPool(connection: Connection, admin: Keypair): Promise<void> {
  const data = Buffer.concat([
    Buffer.from(instructionDiscriminator('init_pool')),
    admin.publicKey.toBuffer(),
    Buffer.from([1]),
    VERIFIER_T_ID.toBuffer(),
    VERIFIER_A_ID.toBuffer(),
    VERIFIER_T_ID.toBuffer(),
    admin.publicKey.toBuffer(),
  ]);
  const treasury = PublicKey.findProgramAddressSync(
    [new TextEncoder().encode('b402/v1'), new TextEncoder().encode('treasury')], POOL_ID,
  )[0];
  const ix = new TransactionInstruction({
    programId: POOL_ID,
    keys: [
      { pubkey: admin.publicKey,             isSigner: true,  isWritable: true  },
      { pubkey: poolConfigPda(POOL_ID),      isSigner: false, isWritable: true  },
      { pubkey: treeStatePda(POOL_ID),       isSigner: false, isWritable: true  },
      { pubkey: adapterRegistryPda(POOL_ID), isSigner: false, isWritable: true  },
      { pubkey: treasury,                    isSigner: false, isWritable: true  },
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

main().catch((e) => { console.error('\n❌ swap-e2e failed:', e); process.exit(1); });

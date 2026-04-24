/**
 * swap-e2e-jupiter — end-to-end shield → real Jupiter swap → unshield on a
 * mainnet-forked solana-test-validator.
 *
 * What this proves (beyond swap-e2e.ts which uses the mock adapter):
 *   - Real Jupiter V6 bytecode CPI'd from b402_jupiter_adapter
 *   - Real mainnet AMM pool state (cloned at fork slot)
 *   - Real route data from Jupiter's /swap-instructions endpoint
 *   - Our pool's balance-delta invariant holds against a live aggregator
 *
 * Prereqs (run once before this):
 *   1. `ops/jup-quote.ts` produced /tmp/jup-route.json for wSOL → USDC
 *      with userPublicKey = adapter_authority (so Jupiter wires the swap
 *      ix to use the adapter's scratch ATAs as source/dest).
 *   2. `ops/mainnet-fork-validator.sh --route /tmp/jup-route.json --reset`
 *      booted a test-validator with Jupiter V6 + AMM state cloned.
 *
 * Flow:
 *   - Wrap 0.1 SOL → wSOL, shield 0.1 wSOL into the pool
 *   - privateSwap via real Jupiter route: 0.1 wSOL → ~8.5 USDC
 *   - Unshield USDC to a fresh recipient
 *   - Assert vault deltas + recipient balance
 */

import {
  AddressLookupTableAccount, ComputeBudgetProgram, Connection, Keypair,
  LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, TransactionInstruction,
  sendAndConfirmTransaction, TransactionMessage, VersionedTransaction,
} from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
  NATIVE_MINT, createAssociatedTokenAccountIdempotent, getAccount,
  getOrCreateAssociatedTokenAccount, createSyncNativeInstruction,
} from '@solana/spl-token';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes as nodeRandomBytes } from 'node:crypto';

import {
  adapterRegistryPda, buildWallet, poolConfigPda, shield, tokenConfigPda,
  treeStatePda, unshield, vaultPda, fetchTreeState, proveMostRecentLeaf,
  buildZeroCache, instructionDiscriminator, concat, u32Le, u64Le, vecU8,
  poseidon, noteEnc,
} from '@b402ai/solana';
import { leToFrReduced } from '@b402ai/solana-shared';
import { TransactProver } from '@b402ai/solana-prover';

const { commitmentHash } = poseidon;
const { encryptNote } = noteEnc;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RPC_URL = process.env.RPC_URL ?? 'http://127.0.0.1:8899';
const ROUTE_FILE = process.env.ROUTE_FILE ?? '/tmp/jup-route.json';

const POOL_ID          = new PublicKey('42a3hsCXtQLWonyxWZosaaCJCweYYKMrvNd25p1Jrt2y');
const VERIFIER_ID      = new PublicKey('Afjbnv2Ekxa98jjRw33xPPhZabevek2uZxoE75kr6ZrK');
const JUPITER_ADAPTER  = new PublicKey('3RHRcbinCmcj8JPBfVxb9FW76oh4r8y21aSx4JFy3yx7');

const USDC = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const WSOL = NATIVE_MINT;

const CIRCUITS_BUILD = path.resolve(__dirname, '../circuits/build');
const EXECUTE_DISC = instructionDiscriminator('execute');

async function main() {
  console.log(`▶ RPC ${RPC_URL}`);
  const connection = new Connection(RPC_URL, 'confirmed');

  // ---- Load Jupiter route ----
  const route = JSON.parse(fs.readFileSync(ROUTE_FILE, 'utf8'));
  const jupIx = route.swap.swapInstruction as {
    programId: string;
    accounts: Array<{ pubkey: string; isSigner: boolean; isWritable: boolean }>;
    data: string; // base64
  };
  console.log(`▶ route: ${route.quote.inAmount} ${route.quote.inputMint.slice(0,4)}… → ${route.quote.outAmount} ${route.quote.outputMint.slice(0,4)}… via ${route.quote.routePlan[0].swapInfo.label}`);

  const jupAlts: PublicKey[] = (route.swap.addressLookupTableAddresses ?? []).map((s: string) => new PublicKey(s));
  console.log(`▶ ${jupAlts.length} Jupiter ALT(s)`);

  // ---- Use CLI wallet ----
  const walletPath = process.env.ADMIN_KEYPAIR ?? path.join(process.env.HOME ?? '', '.config/solana/id.json');
  const secret = new Uint8Array(JSON.parse(fs.readFileSync(walletPath, 'utf8')));
  const admin = Keypair.fromSecretKey(secret);
  const bal = await connection.getBalance(admin.publicKey);
  console.log(`▶ wallet ${admin.publicKey.toBase58().slice(0,8)}… balance=${(bal / LAMPORTS_PER_SOL).toFixed(3)} SOL`);

  // ---- init_pool (skip if exists) ----
  const cfgAcct = await connection.getAccountInfo(poolConfigPda(POOL_ID));
  if (!cfgAcct) {
    await initPool(connection, admin);
    console.log('▶ init_pool ok');
  } else {
    console.log('▶ pool already initialized');
  }

  // ---- Token configs for wSOL + USDC ----
  // wSOL decimals=9, USDC decimals=6. Use real mainnet mints (cloned).
  await addTokenConfig(connection, admin, WSOL);
  await addTokenConfig(connection, admin, USDC);
  console.log('▶ token configs ok (wSOL, USDC)');

  // ---- Register jupiter adapter ----
  await registerAdapter(connection, admin, JUPITER_ADAPTER, EXECUTE_DISC);
  console.log('▶ jupiter adapter registered');

  // ---- Wrap 0.5 SOL into wSOL ATA ----
  const adminWsolAta = await getOrCreateAssociatedTokenAccount(
    connection, admin, WSOL, admin.publicKey,
  );
  const wrapAmount = BigInt(0.5 * LAMPORTS_PER_SOL);
  const wrapTx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: admin.publicKey, toPubkey: adminWsolAta.address,
      lamports: Number(wrapAmount),
    }),
    createSyncNativeInstruction(adminWsolAta.address),
  );
  await sendAndConfirmTransaction(connection, wrapTx, [admin]);
  const wsolBalance = await getAccount(connection, adminWsolAta.address);
  console.log(`▶ wrapped 0.5 SOL → wSOL ATA (balance ${wsolBalance.amount})`);

  // ---- SDK wallet + prover ----
  const wallet = await buildWallet(admin.secretKey.slice(0, 32));
  const prover = new TransactProver({
    wasmPath: path.join(CIRCUITS_BUILD, 'transact_js/transact.wasm'),
    zkeyPath: path.join(CIRCUITS_BUILD, 'ceremony/transact_final.zkey'),
  });

  // ---- Shield 0.1 wSOL (100_000_000 lamports) ----
  const SHIELD_AMT = 100_000_000n;
  console.log(`▶ shielding ${SHIELD_AMT} wSOL…`);
  const shieldRes = await shield({
    connection, poolProgramId: POOL_ID, verifierProgramId: VERIFIER_ID,
    prover, wallet, mint: WSOL, depositorAta: adminWsolAta.address,
    depositor: admin, relayer: admin, amount: SHIELD_AMT,
  });
  console.log(`  sig = ${shieldRes.signature}`);

  // ---- Pre-create adapter scratch ATAs (adapter_authority owns them) ----
  const adapterAuthority = PublicKey.findProgramAddressSync(
    [new TextEncoder().encode('b402/v1'), new TextEncoder().encode('adapter')],
    JUPITER_ADAPTER,
  )[0];
  const adapterInTa  = await createAssociatedTokenAccountIdempotent(
    connection, admin, WSOL, adapterAuthority, undefined, undefined, undefined, true,
  );
  const adapterOutTa = await createAssociatedTokenAccountIdempotent(
    connection, admin, USDC, adapterAuthority, undefined, undefined, undefined, true,
  );
  console.log(`▶ adapter scratch ATAs: in=${adapterInTa.toBase58().slice(0,8)}… out=${adapterOutTa.toBase58().slice(0,8)}…`);

  // ---- Build adapt_execute_devnet tx with real Jupiter swap ix as payload ----
  const IN_AMOUNT  = SHIELD_AMT; // full shielded balance
  const MIN_OUT    = BigInt(route.quote.otherAmountThreshold); // Jupiter's slippage floor
  const OUT_AMT    = MIN_OUT; // note claims at-least the slippage floor

  const outMintFr = leToFrReduced(USDC.toBytes());
  const outRandom = leToFrReduced(new Uint8Array(nodeRandomBytes(32)));
  const outCommitment = await commitmentHash(outMintFr, OUT_AMT, outRandom, wallet.spendingPub);
  const outEncrypted = await encryptNote(
    { tokenMint: outMintFr, value: OUT_AMT, random: outRandom, spendingPub: wallet.spendingPub },
    wallet.viewingPub, 0n,
  );

  // action_payload = raw Jupiter ix data (the route plan bytes)
  const jupData = Buffer.from(jupIx.data, 'base64');
  console.log(`▶ jupiter ix data = ${jupData.length} B`);

  // Adapter ix = disc || u64 in || u64 min_out || vec(jupiter ix data)
  const rawAdapterIxData = concat(
    EXECUTE_DISC,
    u64Le(IN_AMOUNT),
    u64Le(MIN_OUT),
    vecU8(new Uint8Array(jupData)),
  );

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

  // Pool's named accounts + jupiter's account list as remaining_accounts.
  // Jupiter expects its own accounts in its declared order; our adapter's
  // Execute struct consumes 6 accounts (adapter_auth, in_vault, out_vault,
  // adapter_in_ta, adapter_out_ta, token_program) — rest forwarded to Jupiter.
  //
  // Critically: the adapter's `in_vault` + `out_vault` are pool vaults, and
  // the adapter expects adapter_authority to be the signer. adapter_in_ta
  // and adapter_out_ta must match what Jupiter's swap ix expects as
  // userSourceTokenAccount + userDestinationTokenAccount (which we set up
  // by fetching the quote with userPublicKey=adapter_authority).

  const jupAccountMetas = jupIx.accounts.map(a => ({
    pubkey: new PublicKey(a.pubkey),
    isSigner: false,         // adapter_authority PDA signer provided by adapter's invoke_signed
    isWritable: a.isWritable,
  }));

  const poolIxKeys = [
    { pubkey: admin.publicKey,                        isSigner: true,  isWritable: true  },
    { pubkey: poolConfigPda(POOL_ID),                 isSigner: false, isWritable: false },
    { pubkey: adapterRegistryPda(POOL_ID),            isSigner: false, isWritable: false },
    { pubkey: tokenConfigPda(POOL_ID, WSOL),          isSigner: false, isWritable: false },
    { pubkey: tokenConfigPda(POOL_ID, USDC),          isSigner: false, isWritable: false },
    { pubkey: vaultPda(POOL_ID, WSOL),                isSigner: false, isWritable: true  },
    { pubkey: vaultPda(POOL_ID, USDC),                isSigner: false, isWritable: true  },
    { pubkey: treeStatePda(POOL_ID),                  isSigner: false, isWritable: true  },
    { pubkey: JUPITER_ADAPTER,                        isSigner: false, isWritable: false },
    { pubkey: adapterAuthority,                       isSigner: false, isWritable: false },
    { pubkey: adapterInTa,                            isSigner: false, isWritable: true  },
    { pubkey: adapterOutTa,                           isSigner: false, isWritable: true  },
    { pubkey: TOKEN_PROGRAM_ID,                       isSigner: false, isWritable: false },
    ...jupAccountMetas,
  ];

  const poolIx = new TransactionInstruction({
    programId: POOL_ID, keys: poolIxKeys, data: Buffer.from(poolIxData),
  });

  // ---- Compose v0 tx ----
  // Skip Jupiter ALTs on the mainnet fork: mainnet's ALT state has drifted
  // from what was cloned at fork time, causing "invalid lookup index"
  // errors. Our tx fits inline (~24 accounts × 32 B + ix data < 1232 B).
  // On real mainnet we'd use the ALTs.
  const altAccounts: AddressLookupTableAccount[] = [];
  void jupAlts;

  const cuIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 });
  const blockhash = (await connection.getLatestBlockhash('confirmed')).blockhash;
  const msg = new TransactionMessage({
    payerKey: admin.publicKey, recentBlockhash: blockhash,
    instructions: [cuIx, poolIx],
  }).compileToV0Message(altAccounts);

  const tx = new VersionedTransaction(msg);
  tx.sign([admin]);
  const serialized = tx.serialize();
  console.log(`▶ swap tx size = ${serialized.length} B (cap 1232)`);
  if (serialized.length > 1232) {
    console.warn('  ⚠ over cap — would fail on real chain');
  }

  console.log(`▶ submitting real Jupiter swap via b402 pool…`);
  const swapStart = Date.now();
  const swapSig = await connection.sendRawTransaction(serialized, { skipPreflight: false });
  await connection.confirmTransaction(swapSig, 'confirmed');
  console.log(`  sig = ${swapSig} (${Date.now() - swapStart}ms)`);

  // ---- Verify ----
  const wsolVault = await getAccount(connection, vaultPda(POOL_ID, WSOL));
  const usdcVault = await getAccount(connection, vaultPda(POOL_ID, USDC));
  console.log(`▶ wsol_vault = ${wsolVault.amount}  usdc_vault = ${usdcVault.amount}`);
  if (wsolVault.amount !== 0n) throw new Error(`wsol vault should be drained, got ${wsolVault.amount}`);
  if (usdcVault.amount < MIN_OUT) throw new Error(`usdc vault ${usdcVault.amount} < min_out ${MIN_OUT}`);
  console.log(`   delta = ${usdcVault.amount} USDC micro-units (min required ${MIN_OUT})`);

  const tree = await fetchTreeState(connection, treeStatePda(POOL_ID));
  const swapLeafIndex = tree.leafCount - 1n;
  console.log(`▶ output commitment appended at leaf ${swapLeafIndex}`);

  // ---- Unshield USDC (note value = MIN_OUT; any excess delta stays in vault) ----
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
    connection, admin, USDC, recipient.publicKey,
  );
  console.log(`▶ recipient USDC ATA = ${recipientAta.address.toBase58()}`);

  const outNote = {
    tokenMint: outMintFr, value: OUT_AMT, random: outRandom,
    spendingPub: wallet.spendingPub, commitment: outCommitment,
    leafIndex: swapLeafIndex, spendingPriv: wallet.spendingPriv,
    encryptedBytes: outEncrypted.ciphertext,
    ephemeralPub: outEncrypted.ephemeralPub,
    viewingTag: outEncrypted.viewingTag,
  };

  console.log(`▶ unshielding ${OUT_AMT} USDC micro-units to fresh recipient…`);
  const unshieldRes = await unshield({
    connection, poolProgramId: POOL_ID, verifierProgramId: VERIFIER_ID,
    prover, wallet, mint: USDC, note: outNote, merkleProof,
    recipientTokenAccount: recipientAta.address,
    recipientOwner: recipient.publicKey, relayer: admin,
  });
  console.log(`  sig = ${unshieldRes.signature}`);

  const recipientAcct = await getAccount(connection, recipientAta.address);
  console.log(`▶ recipient balance = ${recipientAcct.amount} USDC micro-units`);
  if (recipientAcct.amount < OUT_AMT) throw new Error(`recipient got ${recipientAcct.amount} < expected ${OUT_AMT}`);

  console.log('\n✅ shield → REAL JUPITER swap → unshield successful');
  console.log(`   shield   ${shieldRes.signature}`);
  console.log(`   swap     ${swapSig}`);
  console.log(`   unshield ${unshieldRes.signature}`);
  console.log(`   route    ${route.quote.routePlan[0].swapInfo.label} (${route.quote.routePlan[0].swapInfo.ammKey})`);
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
      { pubkey: admin.publicKey,                      isSigner: true,  isWritable: true  },
      { pubkey: poolConfigPda(POOL_ID),               isSigner: false, isWritable: true  },
      { pubkey: treeStatePda(POOL_ID),                isSigner: false, isWritable: true  },
      { pubkey: adapterRegistryPda(POOL_ID),          isSigner: false, isWritable: true  },
      { pubkey: PublicKey.findProgramAddressSync(
          [new TextEncoder().encode('b402/v1'), new TextEncoder().encode('treasury')], POOL_ID)[0],
                                                      isSigner: false, isWritable: true  },
      { pubkey: SystemProgram.programId,              isSigner: false, isWritable: false },
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
  // Check if already registered to make re-runs idempotent.
  const registryAcct = await connection.getAccountInfo(adapterRegistryPda(POOL_ID));
  if (registryAcct && registryAcct.data.length > 12) {
    // crude check: look for our program_id in the registry bytes
    const target = adapterProgramId.toBuffer();
    for (let i = 12; i + 32 <= registryAcct.data.length; i++) {
      if (registryAcct.data.slice(i, i + 32).equals(target)) {
        console.log('  (adapter already registered)');
        return;
      }
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

main().catch((e) => { console.error('\n❌ swap-e2e-jupiter failed:', e); process.exit(1); });

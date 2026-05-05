/**
 * MAINNET kamino lend demo — privateLend (USDC -> kUSDC) on real Solana.
 *
 * This is the first mainnet exercise of the per-user-obligation kamino-
 * adapter (deployed 2026-05-05 at 2enwFg...) and PRD-35.9's
 * pendingInputsMode wire-slim path.
 *
 * Prerequisites (one-time, already done):
 *   - kamino-adapter deployed to 2enwFg... with per_user_obligation feature
 *   - Pool upgraded with prd_35_pending_inputs feature (slot 417783211)
 *   - kUSDC token_cfg added (mainnet-add-kusdc-token-cfg.mjs)
 *   - Wallet has >= 1.1 USDC + 1 SOL for fees + adapter-authority funding
 *
 * Flow:
 *   1. Read mainnet Kamino USDC main reserve account, parse oracles +
 *      collateral mint + supply pubkeys.
 *   2. Pre-fund adapter authority with 0.5 SOL so it can pay rent for
 *      per-user UserMetadata + Obligation init (~0.03 SOL each).
 *   3. Build ALT with all the static accounts so the per-user lend tx
 *      fits under the 1232 B v0 cap.
 *   4. Shield 1 USDC into the b402 pool.
 *   5. privateLend 1 USDC -> kUSDC via b402-kamino-adapter (pendingInputsMode).
 *
 * Reports each tx signature. Verifies pool's kUSDC vault delta.
 *
 * Cost (one-time, this script):
 *   - 0.5 SOL temporarily pre-funded to adapter_authority (recoverable
 *     manually via a rent-buffer drain ix in V1.5 — for now just left there)
 *   - ~0.05 SOL for ALT account rent
 *   - ~0.005 SOL in tx fees
 *   - 1 USDC spent on the lend (kUSDC backed; recoverable via privateRedeem
 *     when the round-trip script lands)
 *
 * Usage:
 *   pnpm exec node ./mainnet-kamino-lend-demo.mjs
 */
import {
  Connection, PublicKey, Keypair, SystemProgram, LAMPORTS_PER_SOL,
  Transaction, TransactionInstruction, ComputeBudgetProgram,
  AddressLookupTableProgram, AddressLookupTableAccount, sendAndConfirmTransaction,
} from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
  getOrCreateAssociatedTokenAccount,
} from '@solana/spl-token';
import { createRpc } from '@lightprotocol/stateless.js';
import {
  B402Solana, instructionDiscriminator,
  poolConfigPda, tokenConfigPda, vaultPda, treeStatePda,
  adapterRegistryPda, derivePendingInputsPda,
} from '@b402ai/solana';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CIRCUITS = path.resolve(__dirname, '../circuits/build');

const RPC_URL = process.env.B402_RPC_URL;
if (!RPC_URL) {
  console.error('Set B402_RPC_URL to a mainnet RPC that supports getProgramAccounts + Photon (e.g. Helius). Public RPCs will not work.');
  process.exit(1);
}

const POOL = new PublicKey('42a3hsCXtQLWonyxWZosaaCJCweYYKMrvNd25p1Jrt2y');
const NULLIFIER = new PublicKey('2AnRZwWu6CTurZs1yQpqrcJWo4yRYL1xpeV78b2siweq');
const VERIFIER_T = new PublicKey('Afjbnv2Ekxa98jjRw33xPPhZabevek2uZxoE75kr6ZrK');
const VERIFIER_A = new PublicKey('3Y2tyhNSaUiW5AcZcmFGRyTMdnroxHxc5GqFQPcMTZae');
const KAMINO_ADAPTER = new PublicKey('2enwFgcGKJDqruHpCtvmhtxe3DYcV3k72VTvoGcdt2rX');
const KLEND = new PublicKey('KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD');
const FARMS_PROGRAM = new PublicKey('FarmsPZpWu9i7Kky8tPN37rs2TpmMrAZrC7S7vJa91Hr');
const USDC = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
// klend USDC main reserve constants (kamino main market)
const MARKET = new PublicKey('7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF');
const RESERVE = new PublicKey('D6q6wuQSrifJKZYpR1M8R4YawnLDtDsMmWM1NbBmgJ59');

const SYSVAR_INSTRUCTIONS = new PublicKey('Sysvar1nstructions1111111111111111111111111');
const SYSVAR_RENT = new PublicKey('SysvarRent111111111111111111111111111111111');
const COMPUTE_BUDGET = new PublicKey('ComputeBudget111111111111111111111111111111');
const LIGHT_SYSTEM_PROGRAM = new PublicKey('SySTEM1eSU2p4BGQfQpimFEWWSC1XDFeun3Nqzz3rT7');
const ACCOUNT_COMPRESSION_PROGRAM = new PublicKey('compr6CUsB5m2jS4Y3831ztGSTnDpnKJTKS95d64XVq');
const REGISTERED_PROGRAM_PDA = new PublicKey('35hkDgaAKwMCaxRz2ocSZ6NaUrtKkyNqU6c4RV3tYJRh');
const ACCOUNT_COMPRESSION_AUTHORITY = new PublicKey('HwXnGK3tPkkVY6P439H2p68AxpeuWXd5PcrAxFpbmfbA');
const ADDRESS_TREE = new PublicKey('amt2kaJA14v3urZbZvnc5v2np8jqvc4Z8zDep5wbtzx');
const OUTPUT_QUEUE = new PublicKey('oq5oh5ZR3yGomuQgFduNDzjtGvVWfDRGLuDVjv9a96P');

const EXECUTE_DISC = Uint8Array.from([130, 221, 242, 154, 13, 193, 189, 29]);

function loadKp(p) {
  return Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(p, 'utf8'))));
}

function findUtf8(buf, needle) {
  const b = Buffer.from(needle, 'utf8');
  for (let i = 0; i < buf.length - b.length; i++) {
    if (buf.subarray(i, i + b.length).equals(b)) return i;
  }
  return -1;
}

function reservePda(seed, market, mint) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(seed), market.toBuffer(), mint.toBuffer()], KLEND,
  )[0];
}

function lendingMarketAuthorityPda(market) {
  return PublicKey.findProgramAddressSync([Buffer.from('lma'), market.toBuffer()], KLEND)[0];
}

function userMetadataPda(owner) {
  return PublicKey.findProgramAddressSync([Buffer.from('user_meta'), owner.toBuffer()], KLEND)[0];
}

function obligationPda(owner, market) {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from([0]), Buffer.from([0]),
      owner.toBuffer(), market.toBuffer(),
      PublicKey.default.toBuffer(), PublicKey.default.toBuffer(),
    ], KLEND,
  )[0];
}

function obligationFarmPda(farm, obligation) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('user'), farm.toBuffer(), obligation.toBuffer()], FARMS_PROGRAM,
  )[0];
}

function deriveOwnerPda(adapter, hash) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('b402/v1'), Buffer.from('adapter-owner'), hash], adapter,
  )[0];
}

function spendingPubToHashBytes(spendingPub) {
  const buf = Buffer.alloc(32);
  let v = spendingPub;
  for (let i = 0; i < 32; i++) { buf[i] = Number(v & 0xffn); v >>= 8n; }
  return buf;
}

function parseReserve(data) {
  const liquidityMint = new PublicKey(data.subarray(128, 160));
  const reserveFarmCollateral = new PublicKey(data.subarray(64, 96));
  let nameOff = findUtf8(data, 'USDC\0');
  if (nameOff < 0) nameOff = findUtf8(data, 'USD Coin');
  if (nameOff < 0) throw new Error('TokenInfo.name not found in reserve');
  const tokenInfoOff = nameOff;
  const scopeOff = tokenInfoOff + 32 + 24 + 24;
  const swbOff = scopeOff + 52;
  const pythOff = swbOff + 68;
  const def = PublicKey.default;
  const readPk = (off) => {
    const pk = new PublicKey(data.subarray(off, off + 32));
    return pk.equals(def) ? null : pk;
  };
  return {
    liquidityMint,
    liquiditySupply: reservePda('reserve_liq_supply', MARKET, liquidityMint),
    collateralMint: reservePda('reserve_coll_mint', MARKET, liquidityMint),
    collateralReserveDestSupply: reservePda('reserve_coll_supply', MARKET, liquidityMint),
    pyth: readPk(pythOff),
    switchboardPrice: readPk(swbOff),
    switchboardTwap: readPk(swbOff + 32),
    scope: readPk(scopeOff),
    reserveFarmCollateral,
  };
}

async function main() {
  const conn = new Connection(RPC_URL, 'confirmed');
  const photonRpc = createRpc(RPC_URL, RPC_URL);
  const admin = loadKp(path.join(os.homedir(), '.config/solana/id.json'));
  console.log('admin:', admin.publicKey.toBase58());

  // 1. Read Kamino USDC reserve.
  const reserveAcct = await conn.getAccountInfo(RESERVE);
  if (!reserveAcct) throw new Error(`reserve ${RESERVE.toBase58()} not on chain`);
  const r = parseReserve(reserveAcct.data);
  if (!r.liquidityMint.equals(USDC)) {
    throw new Error(`reserve liquidity mint ${r.liquidityMint.toBase58()} != USDC`);
  }
  const isFarmAttached = !r.reserveFarmCollateral.equals(PublicKey.default);
  const inMint = r.liquidityMint; // USDC
  const outMint = r.collateralMint; // kUSDC
  console.log(`reserve ${RESERVE.toBase58().slice(0, 12)}…  USDC→kUSDC  farm=${isFarmAttached}`);
  console.log(`  collateralMint (kUSDC) = ${outMint.toBase58()}`);

  // 2. Pre-fund adapter authority for per-user PDA init rent.
  const [adapterAuthority] = PublicKey.findProgramAddressSync(
    [Buffer.from('b402/v1'), Buffer.from('adapter')], KAMINO_ADAPTER,
  );
  const aaBal = await conn.getBalance(adapterAuthority);
  if (aaBal < 0.5 * LAMPORTS_PER_SOL) {
    console.log('▶ pre-funding adapter authority with 0.5 SOL for per-user init rent');
    await sendAndConfirmTransaction(conn,
      new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: admin.publicKey, toPubkey: adapterAuthority,
          lamports: 0.5 * LAMPORTS_PER_SOL,
        }),
      ),
      [admin], { commitment: 'confirmed' },
    );
  } else {
    console.log(`adapter authority already has ${(aaBal / LAMPORTS_PER_SOL).toFixed(2)} SOL`);
  }

  // Adapter scratch ATAs.
  const adapterInTa = await getOrCreateAssociatedTokenAccount(
    conn, admin, inMint, adapterAuthority, true,
  );
  const adapterOutTa = await getOrCreateAssociatedTokenAccount(
    conn, admin, outMint, adapterAuthority, true,
  );
  console.log(`  adapter scratch: in=${adapterInTa.address.toBase58().slice(0, 12)}… out=${adapterOutTa.address.toBase58().slice(0, 12)}…`);

  // 3. Reuse a persisted ALT if one exists; otherwise create + persist.
  // Each `createLookupTable` allocates ~0.04 SOL of rent — fresh-create per
  // run burns through the wallet for nothing. Persist the pubkey so the
  // smoke is incremental: extend with new per-user PDAs as needed, but
  // keep the static-accounts block once-and-done.
  const ALT_PROGRAM = new PublicKey('AddressLookupTab1e1111111111111111111111111');
  const ALT_PERSIST = '/tmp/b402-mainnet-kamino-alt.json';
  let altPubkey;
  let altIsFresh = false;
  if (fs.existsSync(ALT_PERSIST)) {
    altPubkey = new PublicKey(JSON.parse(fs.readFileSync(ALT_PERSIST, 'utf8')).pubkey);
    const info = await conn.getAccountInfo(altPubkey, 'confirmed');
    if (!info || !info.owner.equals(ALT_PROGRAM)) {
      console.warn(`▶ persisted ALT ${altPubkey.toBase58()} no longer valid — creating fresh`);
      altPubkey = null;
    } else {
      console.log(`▶ reusing persisted ALT ${altPubkey.toBase58().slice(0, 12)}…`);
    }
  }
  if (!altPubkey) {
    console.log('▶ building ALT for tx-size compression');
    const confirmedSlot = await conn.getSlot('confirmed');
    const slot = Math.max(1, confirmedSlot - 50);
    console.log(`  ALT recentSlot: ${slot} (current confirmed: ${confirmedSlot})`);
    const [createIx, newAltPubkey] = AddressLookupTableProgram.createLookupTable({
      authority: admin.publicKey, payer: admin.publicKey, recentSlot: slot,
    });
    altPubkey = newAltPubkey;
    altIsFresh = true;
    await sendAndConfirmTransaction(conn, new Transaction().add(createIx), [admin], { commitment: 'finalized' });
    for (let i = 0; i < 60; i++) {
      const info = await conn.getAccountInfo(altPubkey, 'finalized');
      if (info && info.owner.equals(ALT_PROGRAM)) break;
      if (i === 59) throw new Error('ALT not visible after 60s — check RPC');
      await new Promise((r) => setTimeout(r, 1000));
    }
    fs.writeFileSync(ALT_PERSIST, JSON.stringify({ pubkey: altPubkey.toBase58() }, null, 2));
    console.log(`  persisted ALT pubkey -> ${ALT_PERSIST}`);
  }

  const NULLIFIER_CPI_AUTHORITY = PublicKey.findProgramAddressSync(
    [Buffer.from('cpi_authority')], NULLIFIER,
  )[0];

  const altShared = [
    LIGHT_SYSTEM_PROGRAM, ACCOUNT_COMPRESSION_PROGRAM, REGISTERED_PROGRAM_PDA,
    ACCOUNT_COMPRESSION_AUTHORITY, ADDRESS_TREE, OUTPUT_QUEUE,
    NULLIFIER, NULLIFIER_CPI_AUTHORITY,
    POOL,
    poolConfigPda(POOL), adapterRegistryPda(POOL), treeStatePda(POOL),
    tokenConfigPda(POOL, inMint), tokenConfigPda(POOL, outMint),
    vaultPda(POOL, inMint), vaultPda(POOL, outMint),
    VERIFIER_A,
    KAMINO_ADAPTER, adapterAuthority,
    adapterInTa.address, adapterOutTa.address,
    RESERVE, MARKET, lendingMarketAuthorityPda(MARKET),
    r.liquiditySupply, r.collateralMint, r.collateralReserveDestSupply,
    r.pyth ?? KLEND, r.switchboardPrice ?? KLEND,
    r.switchboardTwap ?? KLEND, r.scope ?? KLEND,
    r.liquidityMint, FARMS_PROGRAM,
    SYSVAR_INSTRUCTIONS, COMPUTE_BUDGET, TOKEN_PROGRAM_ID,
    SystemProgram.programId, SYSVAR_RENT, KLEND,
  ];
  if (altIsFresh) {
    const CHUNK = 25;
    for (let i = 0; i < altShared.length; i += CHUNK) {
      const ext = AddressLookupTableProgram.extendLookupTable({
        payer: admin.publicKey, authority: admin.publicKey, lookupTable: altPubkey,
        addresses: altShared.slice(i, i + CHUNK),
      });
      await sendAndConfirmTransaction(conn, new Transaction().add(ext), [admin], { commitment: 'confirmed' });
    }
    await new Promise((r) => setTimeout(r, 4000));
    console.log(`✓ ALT ${altPubkey.toBase58().slice(0, 12)}… extended (${altShared.length} entries)`);
  } else {
    console.log(`✓ ALT ${altPubkey.toBase58().slice(0, 12)}… reused (skipping ${altShared.length}-entry static extends)`);
  }

  // 4. Setup B402Solana SDK + per-user PDAs.
  const b402 = new B402Solana({
    cluster: 'mainnet',
    rpcUrl: RPC_URL,
    keypair: admin,
    relayer: admin,
    inlineCpiNullifier: true,
    // Indexer-backed Merkle proofs unblock spending NON-rightmost notes —
    // without this, proveMostRecentLeaf only validates leaves at
    // tree.leafCount-1, so older shielded notes can't be redeemed in
    // arbitrary order. SDK falls back to proveMostRecentLeaf if the
    // indexer is unreachable.
    indexerUrl: 'https://b402-solana-indexer-api-62092339396.us-central1.run.app',
    proverArtifacts: {
      wasmPath: path.join(CIRCUITS, 'transact_js/transact.wasm'),
      zkeyPath: path.join(CIRCUITS, 'ceremony/transact_final.zkey'),
    },
    adaptProverArtifacts: {
      wasmPath: path.join(CIRCUITS, 'adapt_js/adapt.wasm'),
      zkeyPath: path.join(CIRCUITS, 'ceremony/adapt_final.zkey'),
    },
  });
  await b402.ready();

  const sdkSpendingPub = b402.wallet.spendingPub;
  const sdkHash = spendingPubToHashBytes(sdkSpendingPub);
  const ownerPda = deriveOwnerPda(KAMINO_ADAPTER, sdkHash);
  const userMetadata = userMetadataPda(ownerPda);
  const obligation = obligationPda(ownerPda, MARKET);
  const obligationFarm = isFarmAttached ? obligationFarmPda(r.reserveFarmCollateral, obligation) : KLEND;
  const reserveFarmState = isFarmAttached ? r.reserveFarmCollateral : KLEND;
  const [pendingInputsPda] = derivePendingInputsPda(POOL, sdkHash);
  console.log('per-user PDAs:');
  console.log('  ownerPda:', ownerPda.toBase58());
  console.log('  obligation:', obligation.toBase58());

  // Extend ALT with per-user PDAs (only the ones not already in the ALT —
  // querying the ALT's deserialised addresses to dedupe).
  const altInfo = await conn.getAccountInfo(altPubkey, 'confirmed');
  const altDecoded = altInfo
    ? AddressLookupTableAccount.deserialize(altInfo.data).addresses
    : [];
  const haveInAlt = (pk) => altDecoded.some((a) => a.equals(pk));
  const perUserCandidates = [
    admin.publicKey,
    ownerPda, userMetadata, obligation,
    ...(isFarmAttached ? [obligationFarm] : []),
    ...(isFarmAttached && !reserveFarmState.equals(KLEND) ? [reserveFarmState] : []),
    pendingInputsPda,
  ];
  const toExtend = perUserCandidates.filter((pk) => !haveInAlt(pk));
  if (toExtend.length > 0) {
    const perUserExt = AddressLookupTableProgram.extendLookupTable({
      payer: admin.publicKey, authority: admin.publicKey, lookupTable: altPubkey,
      addresses: toExtend,
    });
    await sendAndConfirmTransaction(conn, new Transaction().add(perUserExt), [admin], { commitment: 'confirmed' });
    await new Promise((r) => setTimeout(r, 4000));
    console.log(`✓ ALT extended with ${toExtend.length} new per-user PDA(s)`);
  } else {
    console.log('✓ ALT already contains all per-user PDAs — skipping extend');
  }

  // 5. Reuse an existing shielded USDC note (prior sessions left several:
  //    7M, 2M, 2M). Each is already-shielded value, so spending one costs
  //    nothing extra from the wallet's USDC balance. Pick the smallest to
  //    minimize at-risk amount on this smoke. Indexer-backed proof handles
  //    non-rightmost leaves.
  //
  //    NOTE: future shields should use `omitEncryptedNotes: false` (the
  //    SDK default) so the on-chain ciphertext lets later sessions trial-
  //    decrypt and recover notes. omitEncryptedNotes saves ~120 B of tx
  //    space at the cost of cross-session recoverability.
  const { leToFrReduced } = await import('@b402ai/solana-shared');
  const inMintFr = leToFrReduced(inMint.toBytes());
  console.log('▶ scanning chain for existing shielded USDC notes (backfill)…');
  await b402.status({ refresh: true });
  const usdcNotes = b402._notes.getSpendable(inMintFr);
  console.log(`  USDC notes on chain: [${usdcNotes.map((n) => n.value.toString()).join(', ')}]`);
  if (usdcNotes.length === 0) {
    throw new Error('No discoverable shielded USDC notes — shield with omitEncryptedNotes:false first');
  }
  // Pick the smallest note — minimal at-risk amount for this smoke.
  const sorted = [...usdcNotes].sort((a, b) => Number(a.value - b.value));
  const noteToSpend = sorted[0];
  const lendAmount = noteToSpend.value;
  const shieldRes = null;
  console.log(`✓ using existing ${lendAmount}-unit USDC note (leafIndex=${noteToSpend.leafIndex})`);

  // 6. privateLend.
  const outVaultPda = vaultPda(POOL, outMint);
  const preInfo = await conn.getAccountInfo(outVaultPda);
  const preKUsdc = preInfo ? BigInt(preInfo.data.readBigUInt64LE(64)) : 0n;

  const remainingAccounts = [
    { pubkey: RESERVE, isSigner: false, isWritable: true },
    { pubkey: MARKET, isSigner: false, isWritable: false },
    { pubkey: lendingMarketAuthorityPda(MARKET), isSigner: false, isWritable: false },
    { pubkey: r.liquiditySupply, isSigner: false, isWritable: true },
    { pubkey: r.collateralMint, isSigner: false, isWritable: true },
    { pubkey: r.collateralReserveDestSupply, isSigner: false, isWritable: true },
    { pubkey: r.pyth ?? KLEND, isSigner: false, isWritable: false },
    { pubkey: r.switchboardPrice ?? KLEND, isSigner: false, isWritable: false },
    { pubkey: r.switchboardTwap ?? KLEND, isSigner: false, isWritable: false },
    { pubkey: r.scope ?? KLEND, isSigner: false, isWritable: false },
    { pubkey: r.liquidityMint, isSigner: false, isWritable: false },
    { pubkey: FARMS_PROGRAM, isSigner: false, isWritable: false },
    { pubkey: userMetadata, isSigner: false, isWritable: true },
    { pubkey: obligation, isSigner: false, isWritable: true },
    { pubkey: obligationFarm, isSigner: false, isWritable: isFarmAttached },
    { pubkey: reserveFarmState, isSigner: false, isWritable: isFarmAttached },
    { pubkey: SYSVAR_INSTRUCTIONS, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: SYSVAR_RENT, isSigner: false, isWritable: false },
    // ownerPda must be WRITABLE — the kamino-adapter's handle_deposit_per_user
    // uses it as Kamino's obligationOwner (signer-writable role), invoking
    // signed via PDA seeds. Privilege can't escalate inside a CPI, so the
    // outer slot must start writable.
    { pubkey: ownerPda, isSigner: false, isWritable: true },
  ];

  const u32Le = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n, 0); return b; };
  const u64Le = (v) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(v, 0); return b; };
  const kaminoActionPayload = Buffer.concat([
    Buffer.from([0]), // KaminoAction::Deposit
    RESERVE.toBuffer(),
    u64Le(lendAmount),
    u64Le(0n), // min_kt_out
  ]);
  const adapterIxData = new Uint8Array(Buffer.concat([
    Buffer.from(EXECUTE_DISC),
    u64Le(lendAmount),
    u64Le(0n), // expected_out
    u32Le(kaminoActionPayload.length),
    kaminoActionPayload,
  ]));

  console.log(`▶ privateLend ${lendAmount} USDC -> kUSDC via kamino-adapter`);
  const lendRes = await b402.privateLend({
    inMint, outMint,
    amount: lendAmount,
    note: noteToSpend,
    adapterProgramId: KAMINO_ADAPTER,
    adapterInTa: adapterInTa.address,
    adapterOutTa: adapterOutTa.address,
    alt: altPubkey,
    photonRpc,
    expectedOut: 0n,
    adapterIxData,
    actionPayload: kaminoActionPayload,
    remainingAccounts,
    phase9DualNote: true,
    pendingInputsMode: true,
  });

  const postInfo = await conn.getAccountInfo(outVaultPda);
  const postKUsdc = postInfo ? BigInt(postInfo.data.readBigUInt64LE(64)) : 0n;
  const kUsdcDelta = postKUsdc - preKUsdc;

  console.log('=========================================');
  console.log('PRIVATELEND RESULT');
  console.log('  shield sig:    ', shieldRes ? shieldRes.signature : '(reused existing note — no new shield)');
  console.log('  privateLend sig:', lendRes.signature);
  console.log('  kUSDC delta:   ', kUsdcDelta.toString());
  console.log('  obligation:    ', obligation.toBase58());
  console.log('=========================================');

  if (kUsdcDelta <= 0n) {
    console.error('❌ kUSDC delta NOT positive — something is wrong');
    process.exit(1);
  }
  console.log('✓ privateLend on mainnet WORKS — per-user obligation created.');
}

main().catch((e) => { console.error('\n❌', e); process.exit(1); });

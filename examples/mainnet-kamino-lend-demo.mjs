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
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
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

// =====================================================================
// Configuration — env-driven, no hardcoded credentials.
// =====================================================================
const RPC_URL = process.env.B402_RPC_URL;
if (!RPC_URL) {
  console.error('FAIL: B402_RPC_URL required (e.g. Helius mainnet URL with API key).');
  process.exit(1);
}
// Photon-compatible RPC (defaults to RPC_URL — same Helius endpoint serves
// both compressed-account methods and standard Solana RPC). Override when
// pointing at a local Photon (`http://127.0.0.1:8784`) or paid Triton.
const PHOTON_URL = process.env.B402_PHOTON_URL ?? RPC_URL;
// Indexer URL (b402's own Cloud Run service for non-rightmost Merkle proofs).
// Override for local-development against a self-hosted indexer.
const INDEXER_URL = process.env.B402_INDEXER_URL
  ?? 'https://b402-solana-indexer-api-62092339396.us-central1.run.app';
// Wallet keypair path. Default = standard Solana CLI location.
const KEYPAIR_PATH = process.env.B402_KEYPAIR ?? path.join(os.homedir(), '.config/solana/id.json');
// Persisted ALT location across runs (saves ~0.04 SOL/run on fresh ALT alloc).
const ALT_PERSIST = process.env.B402_ALT_PERSIST ?? '/tmp/b402-mainnet-kamino-alt.json';

// Step gating — run only the parts you need:
//   STEP=setup  — reserve discovery + adapter scratch ATAs + ALT (no shield, no lend)
//   STEP=shield — setup + shield only
//   STEP=lend   — setup + use existing note (or REUSE_NOTE=1 to pick smallest) + lend
//   STEP=all    — setup + shield + lend (default)
const STEP = process.env.STEP ?? 'all';
if (!['setup', 'shield', 'lend', 'all'].includes(STEP)) {
  console.error(`FAIL: STEP=${STEP} invalid; must be one of: setup, shield, lend, all`);
  process.exit(1);
}

// Lend amount (raw token units; USDC has 6 decimals).
//   default 100_000 = 0.1 USDC — minimal at-risk for smoke
const SHIELD_AMT = BigInt(process.env.SHIELD_AMT ?? '100000');

// REUSE_NOTE=1 → pick smallest existing note instead of shielding fresh.
//   Useful once a note's nullifier-address Photon state is healthy.
const REUSE_NOTE = process.env.REUSE_NOTE === '1';

console.log('=== config ===');
console.log(`  STEP=${STEP}  SHIELD_AMT=${SHIELD_AMT}  REUSE_NOTE=${REUSE_NOTE}`);
console.log(`  RPC=${RPC_URL.slice(0, 40)}…`);
console.log(`  PHOTON=${PHOTON_URL === RPC_URL ? '(same as RPC)' : PHOTON_URL.slice(0, 40) + '…'}`);
console.log(`  INDEXER=${INDEXER_URL.slice(0, 40)}…`);
console.log(`  KEYPAIR=${KEYPAIR_PATH}`);
console.log(`  ALT_PERSIST=${ALT_PERSIST}`);
console.log('==============\n');

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
  const photonRpc = createRpc(RPC_URL, PHOTON_URL);
  const admin = loadKp(KEYPAIR_PATH);
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
    indexerUrl: INDEXER_URL,
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
  // Per-user USDC ATA owned by ownerPda. Kamino's deposit_v2 enforces
  // userSourceLiquidity.owner == obligationOwner; the adapter routes USDC
  // through this ATA pre-CPI. Pre-create idempotently (first run pays
  // ~0.002 SOL rent; subsequent runs are no-ops).
  const ownerUsdcAta = getAssociatedTokenAddressSync(inMint, ownerPda, true);
  const ownerUsdcInfo = await conn.getAccountInfo(ownerUsdcAta);
  if (!ownerUsdcInfo) {
    console.log(`▶ creating owner_pda USDC ATA ${ownerUsdcAta.toBase58().slice(0, 12)}…`);
    const createAtaIx = createAssociatedTokenAccountIdempotentInstruction(
      admin.publicKey, ownerUsdcAta, ownerPda, inMint,
    );
    await sendAndConfirmTransaction(conn, new Transaction().add(createAtaIx), [admin], { commitment: 'confirmed' });
  }
  console.log('per-user PDAs:');
  console.log('  ownerPda:', ownerPda.toBase58());
  console.log('  obligation:', obligation.toBase58());
  console.log('  ownerUsdcAta:', ownerUsdcAta.toBase58());

  // Extend ALT with per-user PDAs (only the ones not already in the ALT —
  // querying the ALT's deserialised addresses to dedupe).
  const altInfo = await conn.getAccountInfo(altPubkey, 'confirmed');
  const altDecoded = altInfo
    ? AddressLookupTableAccount.deserialize(altInfo.data).addresses
    : [];
  const haveInAlt = (pk) => altDecoded.some((a) => a.equals(pk));
  const perUserCandidates = [
    admin.publicKey,
    ownerPda, userMetadata, obligation, ownerUsdcAta,
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

  if (STEP === 'setup') {
    console.log('\n=== STEP=setup complete ===');
    console.log(`  ALT: ${altPubkey.toBase58()}`);
    console.log(`  ownerPda: ${ownerPda.toBase58()}`);
    console.log(`  obligation: ${obligation.toBase58()}`);
    console.log('  next: STEP=shield pnpm exec node ./mainnet-kamino-lend-demo.mjs');
    return;
  }

  // 5. Strategy: shield a FRESH small note for this run.
  //    Why fresh: existing on-chain notes (7M/2M/2M) have nullifier addresses
  //    that prior failed runs queried — Photon's index appears poisoned for
  //    those specific addresses (returns 500 for getValidityProofV0). A
  //    fresh shield mints a brand-new nullifier address Photon has never
  //    seen, so its proof query is clean.
  //
  //    Cost: SHIELD_AMT moves from wallet → pool. We use 100_000 (0.1 USDC)
  //    to keep at-risk low. omitEncryptedNotes is FALSE (SDK default) so
  //    the on-chain ciphertext lets future sessions trial-decrypt + recover.
  //
  //    Set REUSE_NOTE=1 to override and pick the smallest existing note
  //    (only useful once Photon recovers for that note's address).
  const { leToFrReduced } = await import('@b402ai/solana-shared');
  const inMintFr = leToFrReduced(inMint.toBytes());
  // Backfill scans pool program logs for prior commitments — surfpool
  // doesn't serve historical txs, only accounts. Skip for STEP=all (we
  // shield+lend in same process; new note is in-memory). For STEP=lend
  // we still need backfill to find prior notes — that path requires real
  // mainnet RPC.
  let usdcNotes = [];
  const skipBackfill = process.env.B402_SKIP_BACKFILL === '1' || RPC_URL.includes('127.0.0.1');
  if (skipBackfill) {
    console.log('▶ skipping backfill (surfpool / local — no historical tx logs)');
  } else {
    console.log('▶ scanning chain for existing shielded USDC notes (backfill)…');
    await b402.status({ refresh: true });
    usdcNotes = b402._notes.getSpendable(inMintFr);
    console.log(`  USDC notes on chain: [${usdcNotes.map((n) => n.value.toString()).join(', ')}]`);
    console.log(`  USDC notes (idx,val): [${usdcNotes.map((n) => `${n.leafIndex}=${n.value}`).join(', ')}]`);
  }

  let noteToSpend;
  let lendAmount;
  let shieldRes = null;
  if (REUSE_NOTE && usdcNotes.length > 0) {
    const sorted = [...usdcNotes].sort((a, b) => Number(a.value - b.value));
    noteToSpend = sorted[0];
    lendAmount = noteToSpend.value;
    console.log(`✓ REUSE_NOTE=1 — using existing ${lendAmount}-unit note (leafIndex=${noteToSpend.leafIndex})`);
  } else if (STEP === 'lend' && usdcNotes.length > 0) {
    if (process.env.LEAF_INDEX) {
      const target = Number(process.env.LEAF_INDEX);
      noteToSpend = usdcNotes.find((n) => Number(n.leafIndex) === target);
      if (!noteToSpend) throw new Error(`LEAF_INDEX=${target} not found in spendable notes [${usdcNotes.map((n) => n.leafIndex).join(',')}]`);
      lendAmount = noteToSpend.value;
      console.log(`✓ STEP=lend LEAF_INDEX=${target} — using note (leafIndex=${noteToSpend.leafIndex}, value=${lendAmount})`);
    } else {
      const sorted = [...usdcNotes].sort((a, b) => Number(BigInt(b.leafIndex) - BigInt(a.leafIndex)));
      noteToSpend = sorted[0];
      lendAmount = noteToSpend.value;
      console.log(`✓ STEP=lend — using most-recent note (leafIndex=${noteToSpend.leafIndex}, value=${lendAmount})`);
    }
  } else if (STEP === 'lend') {
    throw new Error('STEP=lend requires an existing discoverable shielded note (or set REUSE_NOTE=1; not available with backfill skipped)');
  } else {
    console.log(`▶ shielding fresh ${SHIELD_AMT} USDC (with on-chain ciphertext for cross-session recovery)`);
    shieldRes = await b402.shield({
      mint: inMint, amount: SHIELD_AMT,
    });
    console.log(`✓ shield sig: ${shieldRes.signature}`);
    // After shield, the SDK has the new note in its in-memory store
    // (insertNote is called during shield). No backfill needed.
    usdcNotes = b402._notes.getSpendable(inMintFr);
    const sorted = [...usdcNotes].sort((a, b) => Number(BigInt(b.leafIndex) - BigInt(a.leafIndex)));
    noteToSpend = sorted.find((n) => n.value === SHIELD_AMT);
    if (!noteToSpend) throw new Error('fresh shield landed but matching note not visible');
    lendAmount = noteToSpend.value;
    console.log(`  using fresh note (leafIndex=${noteToSpend.leafIndex}, value=${lendAmount})`);
    if (STEP === 'shield') {
      console.log('\n=== STEP=shield complete — lend skipped ===');
      console.log(`  shield sig: ${shieldRes.signature}`);
      console.log(`  fresh note: leafIndex=${noteToSpend.leafIndex}, value=${lendAmount}`);
      console.log('  next: STEP=lend pnpm exec node ./mainnet-kamino-lend-demo.mjs');
      return;
    }
  }

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
    { pubkey: ownerPda, isSigner: false, isWritable: true },                     // 19 OWNER_PDA
    { pubkey: ownerUsdcAta, isSigner: false, isWritable: true },                 // 20 OWNER_USDC_ATA
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
    // Path A voucher value: kUSDC note value = lendAmount (1:1 against
    // deposit USDC; Kamino's exchange-rate interest accrues in the
    // obligation, not the voucher). Pool skips out_vault slippage check
    // when stateful adapter delivers less than expected (delta=0 here).
    expectedOut: lendAmount,
    adapterIxData,
    actionPayload: kaminoActionPayload,
    remainingAccounts,
    phase9DualNote: true,
    pendingInputsMode: true,
  });

  const postInfo = await conn.getAccountInfo(outVaultPda);
  const postKUsdc = postInfo ? BigInt(postInfo.data.readBigUInt64LE(64)) : 0n;
  const kUsdcDelta = postKUsdc - preKUsdc;

  // For stateful adapters (Kamino), out_vault delta is structurally 0 —
  // Kamino credits the per-user obligation, not the pool's vault.
  // Verify the deposit by inspecting the on-chain obligation account.
  const obAcct = await conn.getAccountInfo(obligation);
  const obSize = obAcct ? obAcct.data.length : 0;

  console.log('=========================================');
  console.log('PRIVATELEND RESULT');
  console.log('  shield sig:    ', shieldRes ? shieldRes.signature : '(reused existing note — no new shield)');
  console.log('  privateLend sig:', lendRes.signature);
  console.log('  out_vault delta:', kUsdcDelta.toString(), '(expected 0 for stateful adapter)');
  console.log('  obligation acct:', obligation.toBase58(), 'size=' + obSize);
  console.log('=========================================');

  if (!obAcct) {
    console.error('❌ obligation account missing — adapter init failed');
    process.exit(1);
  }
  console.log('✓ privateLend on mainnet WORKS — per-user obligation created.');

  // ====================================================================
  // STEP 7: privateRedeem — V1.5 ARCHITECTURAL WORK STILL NEEDED.
  //
  // Path A (current pool binary) cleanly handles privateLend: the pool
  // skips the out_vault delta check when a stateful adapter delivers
  // less than expected_out_value (Kamino kept the underlying in the
  // obligation). The user gets a kUSDC voucher note proof-bound to
  // depositAmount.
  //
  // privateRedeem is structurally harder. The standard adapt_execute
  // path does:
  //   1. Burn input note (kUSDC voucher value=N)
  //   2. Transfer N kUSDC from in_vault → adapter_in_ta
  //   3. Call adapter (Kamino withdraw)
  //   4. Reshield USDC out-note via dual-note excess minting
  //
  // Step 2 fails — the pool's kUSDC vault has 0 kUSDC because the
  // voucher was never backed by liquid tokens (Path A's whole point).
  // The fix is one of:
  //   (a) New `redeem_through_stateful_adapter` pool ix that skips the
  //       input transfer (V1.5 — pool source change + circuit work).
  //   (b) Mark in_mint as "synthetic" in token_config and have
  //       adapt_execute conditionally skip the transfer (V1.5).
  //
  // For V1 ship, redeem flows through the kamino-adapter DIRECTLY (see
  // examples/kamino-adapter-fork-per-user.mjs). Privacy degrades on
  // the redeem side — owner_pda is publicly linked to the spend — but
  // the deposit side privacy + per-user obligation isolation remain.
  //
  // Set REDEEM=1 to attempt the through-pool path anyway (will fail
  // until the pool ix lands).
  // ====================================================================
  if (process.env.REDEEM !== '1') {
    console.log('\n=== privateRedeem skipped (V1: direct-adapter; through-pool needs V1.5) ===');
    console.log('  see examples/kamino-adapter-fork-per-user.mjs for the direct redeem flow');
    return;
  }

  console.log('\n▶ privateRedeem — kUSDC -> USDC via kamino-adapter');

  // Pool's adapt_execute requires `fee_ata_sentinel` (the relayer's ATA
  // for the IN mint) to be initialized — Anchor's `Account<TokenAccount>`
  // type. For redeem, in_mint flips to kUSDC; the relayer (= admin in
  // this smoke) doesn't have a kUSDC ATA from the deposit side. Create
  // it idempotently before the redeem.
  await getOrCreateAssociatedTokenAccount(conn, admin, outMint /* kUSDC */, admin.publicKey);

  // The kUSDC out-note minted by the lend is the rightmost leaf in the
  // pool's tree (commitment_out[0]). Pull it from the SDK's note store.
  const kUsdcMintFr = leToFrReduced(outMint.toBytes());
  const kUsdcNotes = b402._notes.getSpendable(kUsdcMintFr);
  if (kUsdcNotes.length === 0) {
    console.error('❌ no kUSDC notes — privateLend did not reshield (Path A bug?)');
    process.exit(1);
  }
  const sortedKusdc = [...kUsdcNotes].sort((a, b) => Number(BigInt(b.leafIndex) - BigInt(a.leafIndex)));
  const redeemNote = sortedKusdc[0];
  const ktIn = redeemNote.value;
  console.log(`  using kUSDC note (leafIndex=${redeemNote.leafIndex}, value=${ktIn})`);

  // Withdraw flow flips in/out: inMint=kUSDC, outMint=USDC.
  // adapter_in_ta scratch is now kUSDC, adapter_out_ta scratch is USDC.
  const wAdapterInTa = await getOrCreateAssociatedTokenAccount(
    conn, admin, outMint /* kUSDC */, adapterAuthority, true,
  );
  const wAdapterOutTa = await getOrCreateAssociatedTokenAccount(
    conn, admin, inMint /* USDC */, adapterAuthority, true,
  );

  // ra_withdraw_per_user (20 entries — see adapter source).
  const wRemainingAccounts = [
    { pubkey: RESERVE, isSigner: false, isWritable: true },                                   // 0  withdraw_reserve
    { pubkey: obligation, isSigner: false, isWritable: true },                                // 1  obligation
    { pubkey: MARKET, isSigner: false, isWritable: false },                                   // 2  lending_market
    { pubkey: lendingMarketAuthorityPda(MARKET), isSigner: false, isWritable: false },        // 3  lending_market_authority
    { pubkey: r.collateralReserveDestSupply, isSigner: false, isWritable: true },             // 4  reserve_source_collateral
    { pubkey: r.collateralMint, isSigner: false, isWritable: true },                          // 5  reserve_collateral_mint
    { pubkey: r.liquiditySupply, isSigner: false, isWritable: true },                         // 6  reserve_liquidity_supply
    { pubkey: ownerUsdcAta, isSigner: false, isWritable: true },                              // 7  user_destination = owner_usdc_ata
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },                         // 8  collateral token program
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },                         // 9  liquidity token program
    { pubkey: SYSVAR_INSTRUCTIONS, isSigner: false, isWritable: false },                      // 10 instructions sysvar
    { pubkey: r.liquidityMint, isSigner: false, isWritable: false },                          // 11 reserve_liquidity_mint
    { pubkey: ownerPda, isSigner: false, isWritable: true },                                  // 12 owner_pda (writable for sweep)
    { pubkey: r.pyth ?? KLEND, isSigner: false, isWritable: false },                          // 13 oracle_pyth
    { pubkey: r.switchboardPrice ?? KLEND, isSigner: false, isWritable: false },              // 14 oracle_swb_price
    { pubkey: r.switchboardTwap ?? KLEND, isSigner: false, isWritable: false },               // 15 oracle_swb_twap
    { pubkey: r.scope ?? KLEND, isSigner: false, isWritable: false },                         // 16 oracle_scope
    { pubkey: isFarmAttached ? obligationFarm : KLEND, isSigner: false, isWritable: isFarmAttached }, // 17 obligation_farm
    { pubkey: isFarmAttached ? r.reserveFarmCollateral : KLEND, isSigner: false, isWritable: isFarmAttached }, // 18 reserve_farm_state
    { pubkey: FARMS_PROGRAM, isSigner: false, isWritable: false },                            // 19 farms_program
  ];

  // KaminoAction::Withdraw payload.
  const wKaminoActionPayload = Buffer.alloc(1 + 32 + 8 + 8);
  let wOff = 0;
  wKaminoActionPayload.writeUInt8(1, wOff); wOff += 1; // Withdraw variant
  RESERVE.toBuffer().copy(wKaminoActionPayload, wOff); wOff += 32;
  wKaminoActionPayload.writeBigUInt64LE(ktIn, wOff); wOff += 8;
  wKaminoActionPayload.writeBigUInt64LE(0n, wOff); // min_underlying_out

  const wAdapterIxData = new Uint8Array(Buffer.concat([
    Buffer.from(EXECUTE_DISC),
    u64Le(ktIn),
    u64Le(0n), // min_out
    u32Le(wKaminoActionPayload.length),
    wKaminoActionPayload,
  ]));

  // Pool's USDC vault (where redeemed USDC will land via adapter sweep).
  const usdcVaultPda = vaultPda(POOL, inMint);
  const preUsdcInfo = await conn.getAccountInfo(usdcVaultPda);
  const preUsdc = preUsdcInfo ? BigInt(preUsdcInfo.data.readBigUInt64LE(64)) : 0n;

  const redeemRes = await b402.privateRedeem({
    inMint: outMint,  // kUSDC (burning the lend out-note)
    outMint: inMint,  // USDC
    amount: ktIn,
    note: redeemNote,
    adapterProgramId: KAMINO_ADAPTER,
    adapterInTa: wAdapterInTa.address,
    adapterOutTa: wAdapterOutTa.address,
    alt: altPubkey,
    photonRpc,
    expectedOut: 0n,  // Path A: pool skips slippage check for stateful adapter on the inbound side too;
                      // for redeem the actual delta is non-zero (USDC physically arrives), so the standard
                      // delta check applies. expectedOut=0 means any non-zero delta is acceptable.
    adapterIxData: wAdapterIxData,
    actionPayload: wKaminoActionPayload,
    remainingAccounts: wRemainingAccounts,
    phase9DualNote: true,
    pendingInputsMode: true,
  });

  const postUsdcInfo = await conn.getAccountInfo(usdcVaultPda);
  const postUsdc = postUsdcInfo ? BigInt(postUsdcInfo.data.readBigUInt64LE(64)) : 0n;
  const usdcDelta = postUsdc - preUsdc;

  console.log('=========================================');
  console.log('PRIVATEREDEEM RESULT');
  console.log('  privateRedeem sig:', redeemRes.signature);
  console.log('  USDC vault delta:', usdcDelta.toString());
  console.log('  redeemed:', usdcDelta, 'raw USDC for', ktIn, 'kUSDC');
  console.log('=========================================');
  if (usdcDelta <= 0n) {
    console.error('❌ no USDC redeemed — Kamino withdraw did not credit pool vault');
    process.exit(1);
  }
  console.log('✓ ROUND-TRIP COMPLETE — privateLend + privateRedeem both green');
}

main().then(() => process.exit(0)).catch((e) => { console.error('\n❌', e); process.exit(1); });

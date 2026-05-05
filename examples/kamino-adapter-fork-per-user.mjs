/**
 * Direct fork test for `b402_kamino_adapter::execute()` with the
 * `per_user_obligation` payload — bypasses pool / Light / Photon entirely.
 *
 * Why this exists:
 *   The pool→adapter→Kamino chain has multiple integration constraint
 *   surfaces (Anchor `mut`, signer flags, SPL token-owner constraints).
 *   The full pool path requires Light's address-tree state which is
 *   currently broken on `light test-validator` (b402_nullifier rejects
 *   the local tree pubkey). This test cuts pool out — calls the adapter
 *   directly with a per-user payload — and validates the adapter→Kamino
 *   integration in isolation.
 *
 * Pre-conditions:
 *   - ALICE_USDC_ATA=... INJECT_USDC_ATA=... LOAD_AT_BOOT="pool,nullifier,
 *     verifier_transact,verifier_adapt,kamino_adapter"
 *     tests/v2/scripts/start-mainnet-fork.sh
 *   - kamino-adapter binary built with `--features per_user_obligation`
 *   - /tmp/kamino-clone.json from ops/setup-kamino-fork.sh
 *
 * Run:
 *   pnpm exec node examples/kamino-adapter-fork-per-user.mjs
 *
 * Flow:
 *   1. Read alice's pre-injected USDC.
 *   2. Pre-fund adapter_authority with 0.5 SOL (per-user PDA init rent).
 *   3. Compute viewing_pub_hash (deterministic) + owner_pda + per-user PDAs.
 *   4. Pre-create owner_pda's USDC ATA (the new slot 20 in
 *      ra_deposit_per_user). Skipped if the adapter binary doesn't accept
 *      it yet — script reports both behaviors.
 *   5. Transfer 0.1 USDC: alice → adapter_in_ta.
 *   6. CPI b402_kamino_adapter::execute(Deposit) directly.
 *   7. Report success/failure with full program logs.
 *   8. (Stretch) round-trip Withdraw.
 */
import {
  ComputeBudgetProgram, Connection, Keypair, PublicKey,
  Transaction, TransactionInstruction, SystemProgram, LAMPORTS_PER_SOL,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync, getAccount,
  getOrCreateAssociatedTokenAccount,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferInstruction,
} from '@solana/spl-token';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const RPC = 'http://127.0.0.1:8899';
const KAMINO_ADAPTER = new PublicKey('2enwFgcGKJDqruHpCtvmhtxe3DYcV3k72VTvoGcdt2rX');
const KLEND = new PublicKey('KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD');
const FARMS_PROGRAM = new PublicKey('FarmsPZpWu9i7Kky8tPN37rs2TpmMrAZrC7S7vJa91Hr');
const SYSVAR_INSTRUCTIONS = new PublicKey('Sysvar1nstructions1111111111111111111111111');
const SYSVAR_RENT = new PublicKey('SysvarRent111111111111111111111111111111111');

// Adapter pool-managed slots (fixed by Execute<'info>):
//   0 adapter_authority
//   1 in_vault         — the pool's USDC vault (we fake this with adapter_in_ta for direct tests)
//   2 out_vault        — pool's kUSDC vault (similarly faked)
//   3 adapter_in_ta    — USDC scratch
//   4 adapter_out_ta   — kUSDC scratch
//   5 token_program

// kamino_adapter::execute discriminator — sha256("global:execute")[..8].
const EXECUTE_DISC = Uint8Array.from([130, 221, 242, 154, 13, 193, 189, 29]);

function deriveAdapterAuthority() {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('b402/v1'), Buffer.from('adapter')], KAMINO_ADAPTER,
  )[0];
}
function deriveOwnerPda(hash) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('b402/v1'), Buffer.from('adapter-owner'), hash], KAMINO_ADAPTER,
  )[0];
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
    [Buffer.from([0]), Buffer.from([0]), owner.toBuffer(), market.toBuffer(),
      PublicKey.default.toBuffer(), PublicKey.default.toBuffer()],
    KLEND,
  )[0];
}
function obligationFarmPda(farm, obligation) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('user'), farm.toBuffer(), obligation.toBuffer()], FARMS_PROGRAM,
  )[0];
}

function findUtf8(buf, needle) {
  const b = Buffer.from(needle, 'utf8');
  for (let i = 0; i < buf.length - b.length; i++) {
    if (buf.subarray(i, i + b.length).equals(b)) return i;
  }
  return -1;
}
function parseReserve(data, market) {
  const liquidityMint = new PublicKey(data.subarray(128, 160));
  const reserveFarmCollateral = new PublicKey(data.subarray(64, 96));
  let nameOff = findUtf8(data, 'USDC\0');
  if (nameOff < 0) nameOff = findUtf8(data, 'USD Coin');
  if (nameOff < 0) throw new Error('reserve TokenInfo.name not found');
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
    liquiditySupply: reservePda('reserve_liq_supply', market, liquidityMint),
    collateralMint: reservePda('reserve_coll_mint', market, liquidityMint),
    collateralReserveDestSupply: reservePda('reserve_coll_supply', market, liquidityMint),
    pyth: readPk(pythOff),
    switchboardPrice: readPk(swbOff),
    switchboardTwap: readPk(swbOff + 32),
    scope: readPk(scopeOff),
    reserveFarmCollateral,
  };
}

const conn = new Connection(RPC, 'confirmed');
const admin = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(path.join(os.homedir(), '.config/solana/id.json'), 'utf8'))));
const alice = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync('/tmp/b402-alice.json', 'utf8'))));
const clone = JSON.parse(fs.readFileSync('/tmp/kamino-clone.json', 'utf8'));
const RESERVE = new PublicKey(clone.constants.reserve);
const MARKET = new PublicKey(clone.constants.lendingMarket);

const reserveAcct = await conn.getAccountInfo(RESERVE);
if (!reserveAcct) throw new Error('reserve missing on fork');
const r = parseReserve(reserveAcct.data, MARKET);
const isFarmAttached = !r.reserveFarmCollateral.equals(PublicKey.default);
const inMint = r.liquidityMint;
const outMint = r.collateralMint;
console.log(`reserve ${RESERVE.toBase58().slice(0, 12)}…  USDC→kUSDC  farm=${isFarmAttached}`);

const adapterAuthority = deriveAdapterAuthority();
const aaBal = await conn.getBalance(adapterAuthority);
if (aaBal < 0.5 * LAMPORTS_PER_SOL) {
  console.log('▶ pre-funding adapter_authority with 0.5 SOL');
  await sendAndConfirmTransaction(conn,
    new Transaction().add(SystemProgram.transfer({
      fromPubkey: admin.publicKey, toPubkey: adapterAuthority,
      lamports: 0.5 * LAMPORTS_PER_SOL,
    })),
    [admin], { commitment: 'confirmed' });
}

// Per-user identity. For this test the hash is deterministic but
// arbitrary; in production it's the bytes_le of the user's spendingPub.
const viewingPubHash = Buffer.alloc(32);
for (let i = 0; i < 32; i++) viewingPubHash[i] = (i * 13 + 7) & 0xff;
const ownerPda = deriveOwnerPda(viewingPubHash);
const userMetadata = userMetadataPda(ownerPda);
const obligation = obligationPda(ownerPda, MARKET);
const obligationFarm = isFarmAttached ? obligationFarmPda(r.reserveFarmCollateral, obligation) : KLEND;
const reserveFarmState = isFarmAttached ? r.reserveFarmCollateral : KLEND;
console.log(`per-user owner_pda: ${ownerPda.toBase58()}`);
console.log(`per-user obligation: ${obligation.toBase58()}`);

// Adapter scratch ATAs (owned by adapter_authority).
const adapterInTa = await getOrCreateAssociatedTokenAccount(conn, admin, inMint, adapterAuthority, true);
const adapterOutTa = await getOrCreateAssociatedTokenAccount(conn, admin, outMint, adapterAuthority, true);

// owner_pda's USDC ATA (NEW slot 20 in ra_deposit_per_user — the fix).
// Pre-create idempotently. With the OLD adapter binary this account is
// unused; with the FIXED binary, slot 20 references it.
const ownerUsdcAta = getAssociatedTokenAddressSync(inMint, ownerPda, true);
const ataInfo = await conn.getAccountInfo(ownerUsdcAta);
if (!ataInfo) {
  console.log(`▶ creating owner_pda USDC ATA ${ownerUsdcAta.toBase58().slice(0, 12)}…`);
  const createAtaIx = createAssociatedTokenAccountIdempotentInstruction(
    admin.publicKey, ownerUsdcAta, ownerPda, inMint,
  );
  await sendAndConfirmTransaction(conn, new Transaction().add(createAtaIx), [admin], { commitment: 'confirmed' });
}

// Fund adapter_in_ta with 0.1 USDC from alice.
const aliceUsdcAta = await getOrCreateAssociatedTokenAccount(conn, admin, inMint, alice.publicKey);
const DEPOSIT_AMOUNT = 100_000n; // 0.1 USDC
const aliceBal = (await getAccount(conn, aliceUsdcAta.address)).amount;
if (aliceBal < DEPOSIT_AMOUNT) throw new Error(`alice has only ${aliceBal} USDC`);

// Pre-fund alice with SOL for fees.
await sendAndConfirmTransaction(conn,
  new Transaction().add(SystemProgram.transfer({
    fromPubkey: admin.publicKey, toPubkey: alice.publicKey, lamports: 0.05 * LAMPORTS_PER_SOL,
  })),
  [admin], { commitment: 'confirmed' });
await sendAndConfirmTransaction(conn,
  new Transaction().add(createTransferInstruction(
    aliceUsdcAta.address, adapterInTa.address, alice.publicKey, DEPOSIT_AMOUNT,
  )),
  [alice], { commitment: 'confirmed' });
console.log(`✓ funded adapter_in_ta with ${DEPOSIT_AMOUNT} USDC from alice`);

// Build per-user remaining_accounts (current ra_deposit_per_user is 20-entry,
// fix adds slot 20 for owner_usdc_ata → 21 entries). Pass 21 either way; old
// binary will ignore the extra, new one will use it.
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
  { pubkey: inMint, isSigner: false, isWritable: false },
  { pubkey: FARMS_PROGRAM, isSigner: false, isWritable: false },
  { pubkey: userMetadata, isSigner: false, isWritable: true },
  { pubkey: obligation, isSigner: false, isWritable: true },
  { pubkey: obligationFarm, isSigner: false, isWritable: isFarmAttached },
  { pubkey: reserveFarmState, isSigner: false, isWritable: isFarmAttached },
  { pubkey: SYSVAR_INSTRUCTIONS, isSigner: false, isWritable: false },
  { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  { pubkey: SYSVAR_RENT, isSigner: false, isWritable: false },
  { pubkey: ownerPda, isSigner: false, isWritable: true },
  { pubkey: ownerUsdcAta, isSigner: false, isWritable: true }, // slot 20 — fix candidate
];

// action_payload = [32-byte viewing_pub_hash][KaminoAction Borsh]
//   KaminoAction::Deposit { reserve, in_amount: u64, min_kt_out: u64 }
const u64Le = (v) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(v, 0); return b; };
const u32Le = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n, 0); return b; };
const kaminoAction = Buffer.concat([
  Buffer.from([0]),  // Deposit variant
  RESERVE.toBuffer(),
  u64Le(DEPOSIT_AMOUNT),
  u64Le(0n),
]);
const actionPayload = Buffer.concat([viewingPubHash, kaminoAction]);

// execute() ix data: disc + in_amount(u64) + min_out(u64) + Vec<u8>(action_payload).
const ixData = Buffer.concat([
  Buffer.from(EXECUTE_DISC),
  u64Le(DEPOSIT_AMOUNT),
  u64Le(0n),
  u32Le(actionPayload.length),
  actionPayload,
]);

// Note: in_vault and out_vault are pool's vaults in production; for direct
// adapter test we use adapter_in_ta and adapter_out_ta as stand-ins (the
// adapter sweep moves to in_vault/out_vault, but we don't need that side to
// be a real pool vault — just a TokenAccount of the right mint owned by
// adapter_authority will pass Anchor's deserialise).
const inVault = adapterInTa.address;
const outVault = adapterOutTa.address;
// adapter_authority must be writable (the fix from earlier today).
const ix = new TransactionInstruction({
  programId: KAMINO_ADAPTER,
  keys: [
    { pubkey: adapterAuthority, isSigner: false, isWritable: true },  // 0
    { pubkey: inVault, isSigner: false, isWritable: true },           // 1
    { pubkey: outVault, isSigner: false, isWritable: true },          // 2
    { pubkey: adapterInTa.address, isSigner: false, isWritable: true },// 3
    { pubkey: adapterOutTa.address, isSigner: false, isWritable: true },// 4
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }, // 5
    ...remainingAccounts,
  ],
  data: ixData,
});

const cu = ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 });
console.log('▶ calling kamino_adapter::execute(Deposit) directly…');
try {
  const sig = await sendAndConfirmTransaction(
    conn, new Transaction().add(cu, ix), [admin], { commitment: 'confirmed', skipPreflight: false },
  );
  console.log(`✓ Deposit succeeded: ${sig}`);
  const ob = await conn.getAccountInfo(obligation);
  console.log(`  obligation account size: ${ob ? ob.data.length : 'missing'}`);
} catch (e) {
  console.error(`❌ Deposit failed: ${e.message}`);
  if (e.logs) console.error(e.logs.join('\n'));
  process.exit(1);
}

// ====================================================================
// WITHDRAW round-trip — spend kUSDC from the obligation back to USDC.
// ====================================================================
const adapterOutBalance = (await getAccount(conn, adapterOutTa.address)).amount;
console.log(`\nadapter_out_ta kUSDC balance: ${adapterOutBalance}`);
if (adapterOutBalance === 0n) {
  // Kamino's V2 deposit credits the kUSDC into reserve_dest_collateral
  // (the obligation collateral pool), NOT the adapter's scratch ATA.
  // For the withdraw test we need to redeem back. The withdraw flow's
  // ra slot 7 = user_destination_liquidity (where USDC goes) — for the
  // direct test we point it at adapter_out_ta (USDC mint) so we can
  // verify the redeemed underlying lands somewhere we control.
  console.log('  (expected — V2 deposit deposited collateral into obligation, not adapter scratch)');
}

// kt_in: how much collateral to redeem. Best practice: read the obligation
// to find the deposited collateral amount; for this smoke we burn approx
// the deposit amount. Kamino computes the exact USDC redeemed from the
// reserve's exchange rate.
// Withdraw a small portion to dodge any kt-balance off-by-one. The
// obligation has at least DEPOSIT_AMOUNT × exchange_rate kUSDC; redeeming
// 50k kUSDC is well within bounds.
const ktIn = 50_000n;

// ra_withdraw_per_user (13 slots — see programs/b402-kamino-adapter::ra_withdraw_per_user)
const wRemainingAccounts = [
  { pubkey: RESERVE, isSigner: false, isWritable: true },               // 0
  { pubkey: obligation, isSigner: false, isWritable: true },             // 1
  { pubkey: MARKET, isSigner: false, isWritable: false },                // 2
  { pubkey: lendingMarketAuthorityPda(MARKET), isSigner: false, isWritable: false }, // 3
  { pubkey: r.collateralReserveDestSupply, isSigner: false, isWritable: true },      // 4 source collateral
  { pubkey: r.collateralMint, isSigner: false, isWritable: true },                   // 5
  { pubkey: r.liquiditySupply, isSigner: false, isWritable: true },                  // 6
  { pubkey: adapterOutTa.address, isSigner: false, isWritable: true },               // 7 user_destination_liquidity = adapter_out_ta (USDC scratch)
  { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },                  // 8 collateral token program
  { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },                  // 9 liquidity token program
  { pubkey: SYSVAR_INSTRUCTIONS, isSigner: false, isWritable: false },               // 10
  { pubkey: r.liquidityMint, isSigner: false, isWritable: false },                   // 11
  { pubkey: ownerPda, isSigner: false, isWritable: true },                           // 12
];

const wKaminoAction = Buffer.concat([
  Buffer.from([1]),                  // Withdraw variant
  RESERVE.toBuffer(),
  u64Le(ktIn),
  u64Le(0n),                          // min_underlying_out
]);
const wActionPayload = Buffer.concat([viewingPubHash, wKaminoAction]);
const wIxData = Buffer.concat([
  Buffer.from(EXECUTE_DISC),
  u64Le(ktIn),
  u64Le(0n),                          // expected_out
  u32Le(wActionPayload.length),
  wActionPayload,
]);

// adapter_out_ta is now USDC (we use it as user_destination — OUT mint = USDC)
// So Execute<'info>'s in/out semantics flip: in_mint=kUSDC, out_mint=USDC.
// adapter_in_ta should be kUSDC (for withdraw the input is kToken). We need
// a kUSDC ATA for adapter_authority.
const adapterInTaKusdc = await getOrCreateAssociatedTokenAccount(
  conn, admin, outMint /* kUSDC */, adapterAuthority, true,
);
const adapterOutTaUsdc = await getOrCreateAssociatedTokenAccount(
  conn, admin, inMint /* USDC */, adapterAuthority, true,
);

// In/out vaults flipped too (we don't actually have pool vaults — re-use scratches).
const wIx = new TransactionInstruction({
  programId: KAMINO_ADAPTER,
  keys: [
    { pubkey: adapterAuthority, isSigner: false, isWritable: true },
    { pubkey: adapterInTaKusdc.address, isSigner: false, isWritable: true }, // in_vault stand-in (kUSDC)
    { pubkey: adapterOutTaUsdc.address, isSigner: false, isWritable: true }, // out_vault stand-in (USDC)
    { pubkey: adapterInTaKusdc.address, isSigner: false, isWritable: true }, // adapter_in_ta = kUSDC scratch
    { pubkey: adapterOutTaUsdc.address, isSigner: false, isWritable: true }, // adapter_out_ta = USDC scratch
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ...wRemainingAccounts,
  ],
  data: wIxData,
});

console.log('\n▶ calling kamino_adapter::execute(Withdraw) directly…');
try {
  const wSig = await sendAndConfirmTransaction(
    conn, new Transaction().add(cu, wIx), [admin], { commitment: 'confirmed', skipPreflight: false },
  );
  console.log(`✓ Withdraw succeeded: ${wSig}`);
  const usdcOut = (await getAccount(conn, adapterOutTaUsdc.address)).amount;
  console.log(`  USDC redeemed to scratch: ${usdcOut}`);
} catch (e) {
  console.error(`❌ Withdraw failed: ${e.message}`);
  if (e.logs) console.error(e.logs.join('\n'));
  process.exit(1);
}

console.log('\n=== ROUND-TRIP COMPLETE ===');

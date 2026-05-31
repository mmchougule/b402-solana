/**
 * Adapter-direct probe for `b402_percolator_adapter::execute()` —
 * mirrors `examples/kamino-adapter-fork-per-user.mjs` and isolates the
 * adapter ↔ percolator-prog interaction from the pool ↔ adapter one.
 *
 * Why this exists:
 *   slice 5's full pool→adapter→percolator chain has many integration
 *   surfaces (adapter signer flags, slab layout pinning, percolator-prog
 *   ix tags, matcher CPI depth). Calling the adapter directly with a
 *   pre-built per-user payload — bypassing pool / Light / Photon —
 *   surfaces issues at the percolator-prog boundary first. The full
 *   pool chain (slice 5-β) layers on top once this is green.
 *
 * Pre-conditions:
 *   1. Surfpool running (`tests/v2/scripts/start-percolator-fork.sh`)
 *   2. A percolator market bootstrapped on the fork
 *      (`tests/v2/scripts/init-percolator-market.sh` — emits
 *      `/tmp/percolator-market.json`)
 *   3. Alice's keypair at `/tmp/b402-alice.json`, funded with USDC.
 *      Reuse the kamino harness's keypair so we don't burn through
 *      mainnet USDC clones for distinct test runs.
 *
 * Run:
 *   node examples/percolator-adapter-fork.mjs
 *
 * Flow:
 *   1. Read /tmp/percolator-market.json — slab + matcher + LP addresses.
 *   2. Pre-fund adapter_authority with SOL (PDA init rent).
 *   3. Compute viewing_pub_hash + owner_pda + perp_mapping PDAs.
 *   4. Pre-create owner_pda's USDC ATA.
 *   5. Transfer 0.1 USDC: alice → adapter_in_ta.
 *   6. Build PercolatorAction::OpenPosition payload + execute ix data.
 *   7. CPI b402_percolator_adapter::execute(open) directly.
 *   8. Report success/failure with full program logs.
 *   9. (Stretch) close round-trip with a second invocation.
 */
import {
  ComputeBudgetProgram, Connection, Keypair, PublicKey,
  Transaction, TransactionInstruction, SystemProgram, LAMPORTS_PER_SOL,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferInstruction,
  getOrCreateAssociatedTokenAccount,
} from '@solana/spl-token';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const RPC = process.env.RPC ?? 'http://127.0.0.1:8899';
const MARKET_FILE = process.env.MARKET_FILE ?? '/tmp/percolator-market.json';

if (!fs.existsSync(MARKET_FILE)) {
  console.error(`FAIL: ${MARKET_FILE} missing.`);
  console.error('       Run tests/v2/scripts/init-percolator-market.sh first.');
  process.exit(1);
}
const market = JSON.parse(fs.readFileSync(MARKET_FILE, 'utf8'));
const PERCOLATOR_ADAPTER = new PublicKey(market.percolator_adapter);
const PERCOLATOR_PROG = new PublicKey(market.percolator_program);
const MATCHER_PROG = new PublicKey(market.matcher_program);
const SLAB = new PublicKey(market.slab);
const SLAB_VAULT = new PublicKey(market.vault);
const MATCHER_CTX = new PublicKey(market.matcher_context);
// Local-fork harness uses a custom mint (we own its mint authority);
// production wires this to USDC mainnet. Field name kept as USDC since
// the adapter doesn't care about the mint identity, only that it's SPL.
const USDC = new PublicKey(market.mint);

// PDA seeds — must match programs/b402-percolator-adapter/src/pda.rs.
const SEED_B402 = Buffer.from('b402/v1');
const SEED_ADAPTER = Buffer.from('adapter');
const SEED_PERP_OWNER = Buffer.from('perp-owner');
const SEED_PERP_MAPPING = Buffer.from('perp-mapping');

function derive(seeds, programId) {
  return PublicKey.findProgramAddressSync(seeds, programId)[0];
}
const adapterAuthority = derive([SEED_B402, SEED_ADAPTER], PERCOLATOR_ADAPTER);

// Anchor `execute` discriminator — sha256("global:execute")[..8].
const EXECUTE_DISC = Uint8Array.from([130, 221, 242, 154, 13, 193, 189, 29]);
const TAG_OPEN = 0;

function u16Le(v) { const b = Buffer.alloc(2); b.writeUInt16LE(v, 0); return b; }
function u64Le(v) { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v), 0); return b; }
function u32Le(v) { const b = Buffer.alloc(4); b.writeUInt32LE(v, 0); return b; }
function i128Le(v) {
  const out = Buffer.alloc(16);
  let x = BigInt(v);
  if (x < 0n) x = (x + (1n << 128n)) & ((1n << 128n) - 1n);
  for (let i = 0; i < 16; i++) { out[i] = Number(x & 0xffn); x >>= 8n; }
  return out;
}

const conn = new Connection(RPC, 'confirmed');
const admin = Keypair.fromSecretKey(new Uint8Array(
  JSON.parse(fs.readFileSync(path.join(os.homedir(), '.config/solana/id.json'), 'utf8'))));

const ALICE_KP = process.env.ALICE_KP ?? '/tmp/b402-alice.json';
if (!fs.existsSync(ALICE_KP)) {
  console.error(`FAIL: ${ALICE_KP} missing — generate with 'solana-keygen new -o /tmp/b402-alice.json' and fund.`);
  process.exit(1);
}
const alice = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(ALICE_KP, 'utf8'))));

// 1. Pre-fund adapter_authority for any owner_pda init rent it pays.
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

// 2. Per-user identity. Deterministic for reproducibility.
const viewingPubHash = Buffer.alloc(32);
for (let i = 0; i < 32; i++) viewingPubHash[i] = (i * 13 + 7) & 0xff;
const ownerPda = derive([SEED_B402, SEED_PERP_OWNER, viewingPubHash], PERCOLATOR_ADAPTER);
const perpMapping = derive([SEED_B402, SEED_PERP_MAPPING, SLAB.toBuffer()], PERCOLATOR_ADAPTER);

console.log(`adapter_authority ${adapterAuthority.toBase58()}`);
console.log(`owner_pda          ${ownerPda.toBase58()}`);
console.log(`perp_mapping       ${perpMapping.toBase58()}`);

// 3. Per-user USDC ATA owned by owner_pda.
const userPercolatorAta = getAssociatedTokenAddressSync(USDC, ownerPda, true);

// 4. Adapter scratch ATA — pool's adapter_in_ta + adapter_out_ta.
const adapterUsdcAta = await getOrCreateAssociatedTokenAccount(
  conn, admin, USDC, adapterAuthority, true,
);

// 4.5. Bootstrap perp_mapping PDA: init_mapping (size 10240) +
// 8 × grow_mapping (each grows by 10240, capped at PERP_MAPPING_ACCOUNT_LEN
// = 81968). Solana's MAX_PERMITTED_DATA_INCREASE is 10240 per ix, so we
// can't allocate the full account in one ix. All 9 ixs go in a single
// tx. Idempotent: skipped if account already exists.
{
  const mappingInfo = await conn.getAccountInfo(perpMapping);
  if (mappingInfo && mappingInfo.data.length === 81968) {
    console.log(`  (mapping already at full size ${mappingInfo.data.length}B, skipping)`);
  } else {
    const INIT_MAPPING_DISC = Uint8Array.from([119, 15, 30, 99, 8, 143, 191, 70]);
    const GROW_MAPPING_DISC = Uint8Array.from([202, 61, 64, 131, 68, 49, 26, 161]);
    const initIx = new TransactionInstruction({
      programId: PERCOLATOR_ADAPTER,
      keys: [
        { pubkey: admin.publicKey, isSigner: true, isWritable: true },
        { pubkey: SLAB, isSigner: false, isWritable: false },
        { pubkey: perpMapping, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: Buffer.from(INIT_MAPPING_DISC),
    });
    const growIxs = Array.from({ length: 8 }, () => new TransactionInstruction({
      programId: PERCOLATOR_ADAPTER,
      keys: [
        { pubkey: SLAB, isSigner: false, isWritable: false },
        { pubkey: perpMapping, isSigner: false, isWritable: true },
      ],
      data: Buffer.from(GROW_MAPPING_DISC),
    }));
    try {
      const sig = await sendAndConfirmTransaction(
        conn,
        new Transaction()
          .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }))
          .add(initIx, ...growIxs),
        [admin], { commitment: 'confirmed' },
      );
      const after = await conn.getAccountInfo(perpMapping);
      console.log(`▶ init_mapping + 8× grow_mapping ✓ ${sig.slice(0, 24)}… size=${after.data.length}B`);
    } catch (e) {
      const logs = (e?.logs ?? []).join('\n');
      if (logs.includes('already in use')) {
        console.log('  (init failed because mapping exists; need separate grow loop — please re-run after manual reset)');
      } else {
        throw e;
      }
    }
  }
}

// 4.6. Fresh KeeperCrank — Hyperp markets advance their internal mark
// only on cranks; if we wait too long after bootstrap the engine's
// accrual envelope (MAX_ACCRUAL_DT_SLOTS) expires and TradeCpi rejects
// with OracleStale (0x6).
//
// Encoder layout (percolator-cli encodeKeeperCrank):
//   tag(1) = 8, caller_idx(2) u16 LE, allow_panic(1) u8 = 0
{
  const SYSVAR_CLOCK = new PublicKey('SysvarC1ock11111111111111111111111111111111');
  // tag=5 (KeeperCrank), caller_idx=65535 u16 LE, format_version=1
  const crankData = Buffer.from([5, 0xff, 0xff, 1]);
  const crankIx = new TransactionInstruction({
    programId: PERCOLATOR_PROG,
    keys: [
      { pubkey: admin.publicKey, isSigner: true, isWritable: true },
      { pubkey: SLAB, isSigner: false, isWritable: true },
      { pubkey: SYSVAR_CLOCK, isSigner: false, isWritable: false },
      { pubkey: SLAB, isSigner: false, isWritable: false }, // dummy oracle (Hyperp ignores)
    ],
    data: crankData,
  });
  await sendAndConfirmTransaction(conn,
    new Transaction()
      .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }))
      .add(crankIx),
    [admin], { commitment: 'confirmed', skipPreflight: true });
  console.log('▶ fresh KeeperCrank ✓');
}

// 5. Fund adapter_in_ta from alice.
const aliceUsdcAta = getAssociatedTokenAddressSync(USDC, alice.publicKey);
// Local Hyperp market (defaultInitMarketArgs) sets minNonzeroImReq=200_000,
// initial_margin=10%, mark $100. A 1.0 unit (size_e6 = 1_000_000) trade has
// notional = mark × size = $100, IM = 10% = $10 = 10_000_000 raw. Fund
// 10.5 USDC so we cover IM + fees + tx slippage.
const FUND_AMOUNT = 10_500_000n;
console.log(`▶ funding adapter_in_ta with ${FUND_AMOUNT} (raw)`);
const fundTx = new Transaction().add(
  createAssociatedTokenAccountIdempotentInstruction(admin.publicKey, userPercolatorAta, ownerPda, USDC),
  createTransferInstruction(aliceUsdcAta, adapterUsdcAta.address, alice.publicKey, FUND_AMOUNT),
);
await sendAndConfirmTransaction(conn, fundTx, [admin, alice], { commitment: 'confirmed' });

// 6. Build OpenPosition action_payload + execute ix data.
const LP_IDX = 0;
// Default Hyperp market boots with mark = 100_000_000 e6 ($100). The
// passive matcher fills at mark + base_spread_bps; with base=50bps, fill
// ≈ $100.50. To stay collateralized, IM = size × fill_price × 10% must be
// well below our deposit (10.5 USDC raw = 10_500_000). Pick size_e6 such
// that IM ≪ deposit:
//   size_e6 = 1_000  (= 0.001 units)
//   notional ≈ 0.001 × $100.5 ≈ $0.1005
//   IM at 10% ≈ $0.01005 = 10_050 raw  ≪  10_500_000 deposit
const SIZE_E6 = 1_000n;
const LIMIT_PRICE_E6 = 200_000_000n; // $200 ceiling — well above fill price
const FEE_INIT = 1_000_000n;

const actionInner = Buffer.concat([
  Buffer.from([TAG_OPEN]),
  u16Le(LP_IDX),
  i128Le(SIZE_E6),
  u64Le(LIMIT_PRICE_E6),
  u64Le(FEE_INIT),
]);
const actionPayload = Buffer.concat([viewingPubHash, actionInner]);

const ixData = Buffer.concat([
  Buffer.from(EXECUTE_DISC),
  u64Le(FUND_AMOUNT),  // in_amount
  u64Le(0n),           // expected_out
  u32Le(actionPayload.length),
  actionPayload,
]);

// 7. Build the execute() ix.
//
// Execute<'info> account list (lib.rs):
//   0 adapter_authority    (PDA, read)
//   1 in_vault             (faked: use adapter_usdc_ata since we bypass pool)
//   2 out_vault            (faked: same)
//   3 adapter_in_ta        (writable)
//   4 adapter_out_ta       (writable)
//   5 token_program
//   6 ix_sysvar            (only present under cpi-only feature)
//
// remaining_accounts at pinned RA_* offsets (open.rs):
//   0  perp_mapping        (writable)
//   1  owner_pda           (writable)
//   2  user_percolator_ata (writable)
//   3  slab                (writable)
//   4  slab_vault          (writable)
//   5  percolator_program
//   6  clock
//   7  lp_owner            (read; this is the LP we trade against)
//   8  oracle              (read; for hyperp this can be anything if not used)
//   9  matcher_program
//  10  matcher_context     (writable)
//  11  lp_pda              (writable)
//  12+ matcher_tail (matcher-specific extras)
const SYSVAR_CLOCK = new PublicKey('SysvarC1ock11111111111111111111111111111111');

const lpOwner = market.lp_owner ? new PublicKey(market.lp_owner) : admin.publicKey;
const lpPda = market.lp_pda ? new PublicKey(market.lp_pda)
  : derive([Buffer.from('lp'), SLAB.toBuffer(), u16Le(LP_IDX)], MATCHER_PROG);
const oracle = market.oracle ? new PublicKey(market.oracle) : PERCOLATOR_PROG;

const remaining = [
  { pubkey: perpMapping, isSigner: false, isWritable: true },          // 0
  { pubkey: ownerPda, isSigner: false, isWritable: true },             // 1
  { pubkey: userPercolatorAta, isSigner: false, isWritable: true },    // 2
  { pubkey: SLAB, isSigner: false, isWritable: true },                 // 3
  { pubkey: SLAB_VAULT, isSigner: false, isWritable: true },           // 4
  { pubkey: PERCOLATOR_PROG, isSigner: false, isWritable: false },     // 5
  { pubkey: SYSVAR_CLOCK, isSigner: false, isWritable: false },        // 6
  { pubkey: lpOwner, isSigner: false, isWritable: false },             // 7
  { pubkey: oracle, isSigner: false, isWritable: false },              // 8
  { pubkey: MATCHER_PROG, isSigner: false, isWritable: false },        // 9
  { pubkey: MATCHER_CTX, isSigner: false, isWritable: true },          // 10
  { pubkey: lpPda, isSigner: false, isWritable: true },                // 11
];

const executeIx = new TransactionInstruction({
  programId: PERCOLATOR_ADAPTER,
  keys: [
    { pubkey: adapterAuthority, isSigner: false, isWritable: true },
    { pubkey: adapterUsdcAta.address, isSigner: false, isWritable: true }, // in_vault stub
    { pubkey: adapterUsdcAta.address, isSigner: false, isWritable: true }, // out_vault stub
    { pubkey: adapterUsdcAta.address, isSigner: false, isWritable: true }, // adapter_in_ta
    { pubkey: adapterUsdcAta.address, isSigner: false, isWritable: true }, // adapter_out_ta
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ...remaining,
  ],
  data: ixData,
});

console.log('▶ submitting execute(OpenPosition) to b402_percolator_adapter');
try {
  const sig = await sendAndConfirmTransaction(
    conn,
    new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
      executeIx,
    ),
    [admin],
    { commitment: 'confirmed', skipPreflight: false },
  );
  console.log(`✓ adapter execute landed: ${sig}`);
} catch (e) {
  console.error(`✗ adapter execute failed:`);
  console.error(e?.logs?.join('\n') ?? e);
  process.exit(1);
}

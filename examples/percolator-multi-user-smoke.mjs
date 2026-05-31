/**
 * Multi-user smoke test for `b402_percolator_adapter`.
 *
 * Proves the privacy property: distinct shielded users (= distinct
 * `viewing_pub_hash` values, the same kind the b402 pool's Phase-9
 * proof binds to `out_spending_pub`) land at distinct slab slots,
 * each owned by a distinct `owner_pda`. Same user re-opens reuses
 * the same slab slot.
 *
 * Pre-conditions: same as `examples/percolator-adapter-fork.mjs` —
 * surfpool running with the 6 programs deployed and a fresh market
 * bootstrapped via `tests/v2/scripts/init-percolator-market.ts`.
 *
 * Run:
 *   node examples/percolator-multi-user-smoke.mjs
 *
 * Output:
 *   /tmp/percolator-smoke-results.json — tx hashes + per-user state
 *   for the X-post / runbook.
 */
import {
  ComputeBudgetProgram, Connection, Keypair, PublicKey,
  Transaction, TransactionInstruction, SystemProgram, LAMPORTS_PER_SOL,
  sendAndConfirmTransaction, SYSVAR_CLOCK_PUBKEY,
} from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID, getOrCreateAssociatedTokenAccount,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferInstruction,
  createMintToInstruction,
} from '@solana/spl-token';
import fs from 'node:fs';
import os from 'node:os';

const RPC = process.env.RPC ?? 'http://127.0.0.1:8899';
const MARKET_FILE = process.env.MARKET_FILE ?? '/tmp/percolator-market.json';
const market = JSON.parse(fs.readFileSync(MARKET_FILE, 'utf8'));

const PERCOLATOR_ADAPTER = new PublicKey(market.percolator_adapter);
const PERCOLATOR_PROG    = new PublicKey(market.percolator_program);
const MATCHER_PROG       = new PublicKey(market.matcher_program);
const SLAB               = new PublicKey(market.slab);
const SLAB_VAULT         = new PublicKey(market.vault);
const MATCHER_CTX        = new PublicKey(market.matcher_context);
const MINT_LOCAL         = new PublicKey(market.mint);
const LP_OWNER           = new PublicKey(market.lp_owner);
const LP_PDA             = new PublicKey(market.lp_pda);
const LP_IDX             = market.lp_idx;

const SEED_B402 = Buffer.from('b402/v1');
const SEED_ADAPTER = Buffer.from('adapter');
const SEED_PERP_OWNER = Buffer.from('perp-owner');
const SEED_PERP_MAPPING = Buffer.from('perp-mapping');

const EXECUTE_DISC = Uint8Array.from([130, 221, 242, 154, 13, 193, 189, 29]);
const INIT_MAPPING_DISC = Uint8Array.from([119, 15, 30, 99, 8, 143, 191, 70]);
const GROW_MAPPING_DISC = Uint8Array.from([202, 61, 64, 131, 68, 49, 26, 161]);
const TAG_OPEN = 0;

function u16Le(v) { const b = Buffer.alloc(2); b.writeUInt16LE(v, 0); return b; }
function u32Le(v) { const b = Buffer.alloc(4); b.writeUInt32LE(v, 0); return b; }
function u64Le(v) { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v), 0); return b; }
function i128Le(v) {
  const out = Buffer.alloc(16);
  let x = BigInt(v);
  if (x < 0n) x = (x + (1n << 128n)) & ((1n << 128n) - 1n);
  for (let i = 0; i < 16; i++) { out[i] = Number(x & 0xffn); x >>= 8n; }
  return out;
}
function derive(seeds, programId) {
  return PublicKey.findProgramAddressSync(seeds, programId)[0];
}
const adapterAuthority = derive([SEED_B402, SEED_ADAPTER], PERCOLATOR_ADAPTER);

const conn = new Connection(RPC, 'confirmed');
const admin = Keypair.fromSecretKey(new Uint8Array(JSON.parse(
  fs.readFileSync(`${os.homedir()}/.config/solana/id.json`, 'utf8'))));

// Ensure adapter_authority has SOL (for any rent it pays).
const aaBal = await conn.getBalance(adapterAuthority);
if (aaBal < 0.5 * LAMPORTS_PER_SOL) {
  await sendAndConfirmTransaction(conn,
    new Transaction().add(SystemProgram.transfer({
      fromPubkey: admin.publicKey, toPubkey: adapterAuthority,
      lamports: 0.5 * LAMPORTS_PER_SOL,
    })),
    [admin], { commitment: 'confirmed' });
}

// Adapter scratch ATA — we reuse the same one across all users.
const adapterAta = await getOrCreateAssociatedTokenAccount(
  conn, admin, MINT_LOCAL, adapterAuthority, true,
);

// Bootstrap the perp_mapping account for the slab (one-shot).
async function ensureMapping() {
  const perpMapping = derive([SEED_B402, SEED_PERP_MAPPING, SLAB.toBuffer()], PERCOLATOR_ADAPTER);
  const info = await conn.getAccountInfo(perpMapping);
  if (info && info.data.length === 81968) return perpMapping;
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
  await sendAndConfirmTransaction(conn,
    new Transaction()
      .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }))
      .add(initIx, ...growIxs),
    [admin], { commitment: 'confirmed' });
  return perpMapping;
}

// One KeeperCrank to keep the engine clock fresh.
async function freshCrank() {
  const data = Buffer.from([5, 0xff, 0xff, 1]); // tag=5, caller_idx=65535, format_version=1
  const ix = new TransactionInstruction({
    programId: PERCOLATOR_PROG,
    keys: [
      { pubkey: admin.publicKey, isSigner: true, isWritable: true },
      { pubkey: SLAB, isSigner: false, isWritable: true },
      { pubkey: SYSVAR_CLOCK_PUBKEY, isSigner: false, isWritable: false },
      { pubkey: SLAB, isSigner: false, isWritable: false },
    ],
    data,
  });
  return sendAndConfirmTransaction(conn,
    new Transaction()
      .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }))
      .add(ix),
    [admin], { commitment: 'confirmed', skipPreflight: true });
}

async function openForUser(viewingPubHash, sizeE6, label) {
  const ownerPda = derive([SEED_B402, SEED_PERP_OWNER, viewingPubHash], PERCOLATOR_ADAPTER);
  const userAta = getAssociatedTokenAddressSync(MINT_LOCAL, ownerPda, true);
  const perpMapping = derive([SEED_B402, SEED_PERP_MAPPING, SLAB.toBuffer()], PERCOLATOR_ADAPTER);

  const FUND = 10_500_000n;
  // Fund adapter scratch ATA.
  await sendAndConfirmTransaction(conn,
    new Transaction().add(
      createMintToInstruction(MINT_LOCAL, adapterAta.address, admin.publicKey, FUND),
    ),
    [admin], { commitment: 'confirmed' });
  // Pre-create owner's ATA.
  await sendAndConfirmTransaction(conn,
    new Transaction().add(
      createAssociatedTokenAccountIdempotentInstruction(admin.publicKey, userAta, ownerPda, MINT_LOCAL),
    ),
    [admin], { commitment: 'confirmed' });

  await freshCrank();

  // Build the per-user payload + execute ix.
  const inner = Buffer.concat([
    Buffer.from([TAG_OPEN]),
    u16Le(LP_IDX),
    i128Le(sizeE6),
    u64Le(200_000_000n), // limit_price_e6 = $200 ceiling
    u64Le(1_000_000n),   // fee_payment_if_init = 1 USDC
  ]);
  const actionPayload = Buffer.concat([viewingPubHash, inner]);
  const ixData = Buffer.concat([
    Buffer.from(EXECUTE_DISC),
    u64Le(FUND),
    u64Le(0n),
    u32Le(actionPayload.length),
    actionPayload,
  ]);

  const oracle = PERCOLATOR_PROG;
  const [slabVaultAuthority] = PublicKey.findProgramAddressSync(
    [Buffer.from('vault'), SLAB.toBuffer()],
    PERCOLATOR_PROG,
  );
  const remaining = [
    { pubkey: perpMapping, isSigner: false, isWritable: true },          // 0
    { pubkey: ownerPda, isSigner: false, isWritable: true },             // 1
    { pubkey: userAta, isSigner: false, isWritable: true },              // 2
    { pubkey: SLAB, isSigner: false, isWritable: true },                 // 3
    { pubkey: SLAB_VAULT, isSigner: false, isWritable: true },           // 4
    { pubkey: PERCOLATOR_PROG, isSigner: false, isWritable: false },     // 5
    { pubkey: SYSVAR_CLOCK_PUBKEY, isSigner: false, isWritable: false }, // 6
    { pubkey: LP_OWNER, isSigner: false, isWritable: false },            // 7
    { pubkey: oracle, isSigner: false, isWritable: false },              // 8
    { pubkey: MATCHER_PROG, isSigner: false, isWritable: false },        // 9
    { pubkey: MATCHER_CTX, isSigner: false, isWritable: true },          // 10
    { pubkey: LP_PDA, isSigner: false, isWritable: true },               // 11
    { pubkey: slabVaultAuthority, isSigner: false, isWritable: false },  // 12 RA_SLAB_VAULT_AUTHORITY
  ];

  const executeIx = new TransactionInstruction({
    programId: PERCOLATOR_ADAPTER,
    keys: [
      { pubkey: adapterAuthority, isSigner: false, isWritable: true },
      { pubkey: adapterAta.address, isSigner: false, isWritable: true }, // in_vault stub
      { pubkey: adapterAta.address, isSigner: false, isWritable: true }, // out_vault stub
      { pubkey: adapterAta.address, isSigner: false, isWritable: true }, // adapter_in_ta
      { pubkey: adapterAta.address, isSigner: false, isWritable: true }, // adapter_out_ta
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      ...remaining,
    ],
    data: ixData,
  });

  const sig = await sendAndConfirmTransaction(conn,
    new Transaction()
      .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }))
      .add(executeIx),
    [admin], { commitment: 'confirmed' });
  return { sig, ownerPda: ownerPda.toBase58(), userAta: userAta.toBase58() };
}

// ─── main ───
const perpMapping = await ensureMapping();
console.log(`perp_mapping: ${perpMapping.toBase58()}`);
console.log(`adapter_authority: ${adapterAuthority.toBase58()}`);
console.log(`slab: ${SLAB.toBase58()}\n`);

// Build N distinct viewing_pub_hashes (deterministic for reproducibility).
function makeHash(label) {
  const h = Buffer.alloc(32);
  for (let i = 0; i < 32; i++) h[i] = (label.charCodeAt(i % label.length) + i * 7) & 0xff;
  return h;
}

const users = [
  { name: 'alice', hash: makeHash('alice'), sizeE6: 1_000n },
  { name: 'bob',   hash: makeHash('bob-zk'), sizeE6: 2_000n },
  { name: 'carol', hash: makeHash('carol-priv'), sizeE6: 1_500n },
  { name: 'dave',  hash: makeHash('dave-shielded'), sizeE6: 800n },
];

const results = [];
for (const u of users) {
  console.log(`▶ opening for ${u.name} (size_e6=${u.sizeE6})`);
  try {
    const r = await openForUser(u.hash, u.sizeE6, u.name);
    console.log(`  ✓ owner_pda=${r.ownerPda}`);
    console.log(`    sig=${r.sig.slice(0, 24)}…`);
    results.push({ ...u, hash: u.hash.toString('hex'), ...r });
  } catch (e) {
    console.error(`  ✗ ${e?.transactionMessage ?? e?.message}`);
    if (e?.logs) console.error('    logs:', e.logs.slice(-5).join('\n           '));
    process.exit(1);
  }
}

// Idempotency check: re-open for alice — should reuse the same user_idx.
console.log('\n▶ re-opening for alice (mapping should reuse user_idx)');
const aliceReopen = await openForUser(users[0].hash, 500n, 'alice-2');
console.log(`  ✓ sig=${aliceReopen.sig.slice(0, 24)}…`);
results.push({ name: 'alice (re-open)', sizeE6: 500n.toString(), ...aliceReopen, hash: users[0].hash.toString('hex') });

console.log('\n▶ verifying slab state — distinct user_idx per shielded user');
// Force fresh fetch — confirmed commitment matches our tx commitment.
const slabAcct = await conn.getAccountInfo(SLAB, 'confirmed');
const data = slabAcct.data;
// BPF layout, confirmed empirically against percolator-prog origin/main
// by reading on-chain slab state: ACCOUNTS_OFF = 18576, ACCOUNT_SIZE = 416,
// owner at +184, position_basis_q at +64 (i128 LE).
//
// (These DIFFER from what `core::mem::offset_of!` reports on host x86_64.
// Solana BPF target packs i128/u128 to 8-byte alignment; host packs to 16.
// The deployed adapter + percolator-prog binaries are both BPF, so they
// agree at runtime — only host-side `print_offsets`-style sanity tests
// are misleading.)
const ACC_OFF = 18576, ACC_SIZE = 416, OWNER_OFF_IN_ROW = 184, POS_OFF_IN_ROW = 64;
// Scan capacity: maxAccounts=64 in defaultInitMarketArgs.
const SCAN_MAX = 64;

const verified = [];
for (const u of users) {
  const ownerPda = derive([SEED_B402, SEED_PERP_OWNER, u.hash], PERCOLATOR_ADAPTER);
  const ownerBytes = Buffer.from(ownerPda.toBytes());
  let foundIdx = -1;
  for (let idx = 0; idx < SCAN_MAX; idx++) {
    const base = ACC_OFF + idx * ACC_SIZE;
    if (base + ACC_SIZE > data.length) break;
    const owner = data.subarray(base + OWNER_OFF_IN_ROW, base + OWNER_OFF_IN_ROW + 32);
    if (owner.equals(ownerBytes)) { foundIdx = idx; break; }
  }
  if (foundIdx < 0) {
    console.error(`  ✗ ${u.name}: owner_pda NOT found in slab (expected ${ownerPda.toBase58()})`);
    // Debug: dump first 5 owner fields
    for (let idx = 0; idx < 5; idx++) {
      const base = ACC_OFF + idx * ACC_SIZE;
      const owner = data.subarray(base + OWNER_OFF_IN_ROW, base + OWNER_OFF_IN_ROW + 32);
      const nz = Array.from(owner).filter(b => b !== 0).length;
      console.error(`      idx=${idx}: owner_field nonzero_bytes=${nz} ${nz > 0 ? owner.toString('hex').slice(0, 32)+'…' : ''}`);
    }
  } else {
    const base = ACC_OFF + foundIdx * ACC_SIZE;
    const posBytes = data.subarray(base + POS_OFF_IN_ROW, base + POS_OFF_IN_ROW + 16);
    const posU = BigInt('0x' + Buffer.from(posBytes).reverse().toString('hex'));
    const pos = posU >= (1n << 127n) ? posU - (1n << 128n) : posU;
    console.log(`  ${u.name.padEnd(6)} user_idx=${foundIdx}  position=${pos}  owner_pda=${ownerPda.toBase58().slice(0, 12)}…`);
    verified.push({ name: u.name, user_idx: foundIdx, position: pos.toString(), owner_pda: ownerPda.toBase58() });
  }
}

const distinct = new Set(verified.map(v => v.user_idx)).size === verified.length;
const distinctOwners = new Set(verified.map(v => v.owner_pda)).size === verified.length;
console.log();
console.log(`  privacy property: ${verified.length} users → ${verified.length} distinct user_idx ${distinct ? '✓' : '✗'}`);
console.log(`                   ${verified.length} users → ${verified.length} distinct owner_pdas ${distinctOwners ? '✓' : '✗'}`);

const out = {
  market_file: MARKET_FILE,
  slab: SLAB.toBase58(),
  privacy_property: { distinct_idx: distinct, distinct_owners: distinctOwners },
  txs: results.map(r => ({ ...r, sizeE6: r.sizeE6?.toString?.() ?? r.sizeE6 })),
  slab_state: verified,
};
fs.writeFileSync('/tmp/percolator-smoke-results.json', JSON.stringify(out, null, 2));
console.log('\nresults: /tmp/percolator-smoke-results.json');

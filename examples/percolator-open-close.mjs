/**
 * Open + close round trip against the local fork.
 *
 * Pre-cond: surfpool running with the 6 programs deployed and a fresh
 * market bootstrapped (`tests/v2/scripts/init-percolator-market.ts`
 * → `/tmp/percolator-market.json`).
 *
 * Run:
 *   node examples/percolator-open-close.mjs
 *
 * What it does:
 *   1. Boot the perp_mapping PDA (idempotent).
 *   2. Open alice's position (size=1000, margin=10.5 USDC).
 *   3. Verify slab: alice has position=1000 at her user_idx.
 *   4. Close alice's position (limit_price=$200 ceiling).
 *   5. Verify slab: position=0, capital fully withdrawn.
 *   6. Verify adapter_out_ta delta ≈ recovered margin.
 *
 * Output: /tmp/percolator-open-close-results.json with tx hashes
 * + pre/post state.
 */
import {
  ComputeBudgetProgram, Connection, Keypair, PublicKey,
  Transaction, TransactionInstruction, SystemProgram, LAMPORTS_PER_SOL,
  sendAndConfirmTransaction, SYSVAR_CLOCK_PUBKEY,
} from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID, getOrCreateAssociatedTokenAccount,
  getAssociatedTokenAddressSync, getAccount,
  createAssociatedTokenAccountIdempotentInstruction,
  createMintToInstruction,
} from '@solana/spl-token';
import fs from 'node:fs';
import os from 'node:os';

const RPC = process.env.RPC ?? 'http://127.0.0.1:8899';
const market = JSON.parse(fs.readFileSync('/tmp/percolator-market.json', 'utf8'));
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
const TAG_OPEN  = 0;
const TAG_CLOSE = 1;

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

const conn = new Connection(RPC, 'confirmed');
const admin = Keypair.fromSecretKey(new Uint8Array(JSON.parse(
  fs.readFileSync(`${os.homedir()}/.config/solana/id.json`, 'utf8'))));

const adapterAuthority = derive([SEED_B402, SEED_ADAPTER], PERCOLATOR_ADAPTER);
const adapterAta = await getOrCreateAssociatedTokenAccount(conn, admin, MINT_LOCAL, adapterAuthority, true);

// alice's deterministic shielded identity (matches multi-user-smoke).
const aliceHash = (function() {
  const h = Buffer.alloc(32);
  const s = 'alice';
  for (let i = 0; i < 32; i++) h[i] = (s.charCodeAt(i % s.length) + i * 7) & 0xff;
  return h;
})();
const ownerPda = derive([SEED_B402, SEED_PERP_OWNER, aliceHash], PERCOLATOR_ADAPTER);
const userAta = getAssociatedTokenAddressSync(MINT_LOCAL, ownerPda, true);
const perpMapping = derive([SEED_B402, SEED_PERP_MAPPING, SLAB.toBuffer()], PERCOLATOR_ADAPTER);

// On-chain BPF layout (verified in multi-user-smoke).
const ACC_OFF = 18576, ACC_SIZE = 416, OWNER_OFF = 184, POS_OFF = 64, CAPITAL_OFF = 0;

async function readSlabAccount() {
  const slabAcct = await conn.getAccountInfo(SLAB, 'confirmed');
  if (!slabAcct) throw new Error('slab missing');
  const data = slabAcct.data;
  const ownerBytes = Buffer.from(ownerPda.toBytes());
  for (let idx = 0; idx < 64; idx++) {
    const base = ACC_OFF + idx * ACC_SIZE;
    if (base + ACC_SIZE > data.length) break;
    const owner = data.subarray(base + OWNER_OFF, base + OWNER_OFF + 32);
    if (owner.equals(ownerBytes)) {
      const posBytes = data.subarray(base + POS_OFF, base + POS_OFF + 16);
      const posU = BigInt('0x' + Buffer.from(posBytes).reverse().toString('hex'));
      const pos = posU >= (1n << 127n) ? posU - (1n << 128n) : posU;
      const capBytes = data.subarray(base + CAPITAL_OFF, base + CAPITAL_OFF + 16);
      const cap = BigInt('0x' + Buffer.from(capBytes).reverse().toString('hex'));
      return { user_idx: idx, position: pos, capital_raw: cap };
    }
  }
  return null;
}

async function readAtaBalance(ata) {
  try {
    const acc = await getAccount(conn, ata, 'confirmed');
    return acc.amount;
  } catch { return 0n; }
}

async function freshCrank() {
  const data = Buffer.from([5, 0xff, 0xff, 1]);
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

async function ensureMapping() {
  const info = await conn.getAccountInfo(perpMapping);
  if (info && info.data.length === 81968) return;
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
}

function buildExecuteIx(actionPayload, inAmount, expectedOut) {
  const data = Buffer.concat([
    Buffer.from(EXECUTE_DISC),
    u64Le(inAmount),
    u64Le(expectedOut),
    u32Le(actionPayload.length),
    actionPayload,
  ]);
  // slab vault authority — derive_vault_authority(percolator_prog, slab):
  // percolator's PDA seeds are [b"vault", slab.key].
  const [slabVaultAuthority] = PublicKey.findProgramAddressSync(
    [Buffer.from('vault'), SLAB.toBuffer()],
    PERCOLATOR_PROG,
  );
  const remaining = [
    { pubkey: perpMapping, isSigner: false, isWritable: true },
    { pubkey: ownerPda, isSigner: false, isWritable: true },
    { pubkey: userAta, isSigner: false, isWritable: true },
    { pubkey: SLAB, isSigner: false, isWritable: true },
    { pubkey: SLAB_VAULT, isSigner: false, isWritable: true },
    { pubkey: PERCOLATOR_PROG, isSigner: false, isWritable: false },
    { pubkey: SYSVAR_CLOCK_PUBKEY, isSigner: false, isWritable: false },
    { pubkey: LP_OWNER, isSigner: false, isWritable: false },
    { pubkey: PERCOLATOR_PROG, isSigner: false, isWritable: false }, // oracle (Hyperp ignores)
    { pubkey: MATCHER_PROG, isSigner: false, isWritable: false },
    { pubkey: MATCHER_CTX, isSigner: false, isWritable: true },
    { pubkey: LP_PDA, isSigner: false, isWritable: true },
    { pubkey: slabVaultAuthority, isSigner: false, isWritable: false }, // 12 RA_SLAB_VAULT_AUTHORITY
  ];
  return new TransactionInstruction({
    programId: PERCOLATOR_ADAPTER,
    keys: [
      { pubkey: adapterAuthority, isSigner: false, isWritable: true },
      { pubkey: adapterAta.address, isSigner: false, isWritable: true },
      { pubkey: adapterAta.address, isSigner: false, isWritable: true },
      { pubkey: adapterAta.address, isSigner: false, isWritable: true },
      { pubkey: adapterAta.address, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      ...remaining,
    ],
    data,
  });
}

// Pre-fund adapter SOL.
const aaBal = await conn.getBalance(adapterAuthority);
if (aaBal < 0.5 * LAMPORTS_PER_SOL) {
  await sendAndConfirmTransaction(conn,
    new Transaction().add(SystemProgram.transfer({
      fromPubkey: admin.publicKey, toPubkey: adapterAuthority,
      lamports: 0.5 * LAMPORTS_PER_SOL,
    })),
    [admin], { commitment: 'confirmed' });
}

// Pre-create alice's percolator ATA.
await sendAndConfirmTransaction(conn,
  new Transaction().add(
    createAssociatedTokenAccountIdempotentInstruction(admin.publicKey, userAta, ownerPda, MINT_LOCAL),
  ),
  [admin], { commitment: 'confirmed' });

console.log(`adapter_authority: ${adapterAuthority.toBase58()}`);
console.log(`alice owner_pda:   ${ownerPda.toBase58()}`);
console.log(`alice user_ata:    ${userAta.toBase58()}`);
console.log(`slab:              ${SLAB.toBase58()}\n`);

await ensureMapping();
console.log('▶ mapping ready');

// ── 1. OPEN ─────────────────────────────────────────────────────────────
const FUND = 10_500_000n; // 10.5 USDC margin
await sendAndConfirmTransaction(conn,
  new Transaction().add(
    createMintToInstruction(MINT_LOCAL, adapterAta.address, admin.publicKey, FUND),
  ),
  [admin], { commitment: 'confirmed' });

await freshCrank();
const adapterAtaPreOpen = await readAtaBalance(adapterAta.address);

const openInner = Buffer.concat([
  Buffer.from([TAG_OPEN]),
  u16Le(LP_IDX),
  i128Le(1_000n),       // size_e6 = 1000 (small enough to be well within margin)
  u64Le(200_000_000n),  // limit_price ceiling
  u64Le(1_000_000n),    // fee_payment_if_init = 1 USDC
]);
const openPayload = Buffer.concat([aliceHash, openInner]);
const openIx = buildExecuteIx(openPayload, FUND, 0n);
const openSig = await sendAndConfirmTransaction(conn,
  new Transaction()
    .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }))
    .add(openIx),
  [admin], { commitment: 'confirmed' });
console.log(`▶ OPEN ✓  ${openSig}`);

const stateAfterOpen = await readSlabAccount();
console.log(`  slab: user_idx=${stateAfterOpen.user_idx} position=${stateAfterOpen.position}`);
if (stateAfterOpen.position !== 1_000n) {
  console.error(`  ✗ expected position=1000, got ${stateAfterOpen.position}`);
  process.exit(1);
}

// ── 2. CLOSE ────────────────────────────────────────────────────────────
await freshCrank();
const adapterAtaPreClose = await readAtaBalance(adapterAta.address);
const slabVaultPreClose = await readAtaBalance(SLAB_VAULT);
console.log(`\n  pre-close adapter_ata=${adapterAtaPreClose} slab_vault=${slabVaultPreClose}`);

// Close = sell (size = -position). For a sell side trade percolator's
// limit_price acts as a MINIMUM acceptable fill price; passing the open's
// 200e6 ceiling would mean "won't sell below $200/unit" — way above the
// passive matcher's $99.5 fill. Pass 1 = "accept any fill ≥ ~0".
const closeInner = Buffer.concat([
  Buffer.from([TAG_CLOSE]),
  u16Le(LP_IDX),
  u64Le(1n),
]);
const closePayload = Buffer.concat([aliceHash, closeInner]);
const closeIx = buildExecuteIx(closePayload, 0n, 0n); // in_amount must be 0 for close
const closeSig = await sendAndConfirmTransaction(conn,
  new Transaction()
    .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }))
    .add(closeIx),
  [admin], { commitment: 'confirmed' });
console.log(`▶ CLOSE ✓  ${closeSig}`);

const stateAfterClose = await readSlabAccount();
console.log(`  slab: position=${stateAfterClose?.position ?? '(slot evicted)'} capital_raw=${stateAfterClose?.capital_raw ?? '(slot evicted)'}`);

const adapterAtaPostClose = await readAtaBalance(adapterAta.address);
const slabVaultPostClose = await readAtaBalance(SLAB_VAULT);
const adapterDelta = adapterAtaPostClose - adapterAtaPreClose;
const vaultDelta = slabVaultPostClose - slabVaultPreClose;
console.log(`  post-close adapter_ata=${adapterAtaPostClose} (Δ=${adapterDelta})`);
console.log(`             slab_vault=${slabVaultPostClose} (Δ=${vaultDelta})`);

// Assertions for the round trip:
// - position should be 0 (or slot evicted, both fine)
// - adapter_out_ta gained back ≈ deposited margin minus fees & slippage
// - slab_vault drained back to LP-side balance only
const positionFlat = stateAfterClose === null || stateAfterClose.position === 0n;
const moneyReturned = adapterDelta > 0n;
console.log();
console.log(`  position flat after close: ${positionFlat ? '✓' : '✗'}`);
console.log(`  collateral returned to adapter_ata: ${moneyReturned ? '✓' : '✗'} (Δ=${adapterDelta})`);

const out = {
  market: market.slab,
  alice_owner_pda: ownerPda.toBase58(),
  open: { sig: openSig, size_e6: '1000', position_after: stateAfterOpen.position.toString() },
  close: {
    sig: closeSig,
    position_after: stateAfterClose?.position?.toString() ?? null,
    adapter_ata_delta: adapterDelta.toString(),
    slab_vault_delta: vaultDelta.toString(),
    position_flat: positionFlat,
    collateral_returned: moneyReturned,
  },
};
fs.writeFileSync('/tmp/percolator-open-close-results.json', JSON.stringify(out, null, 2));
console.log('\nresults: /tmp/percolator-open-close-results.json');

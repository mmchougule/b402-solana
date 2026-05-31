/**
 * Warm a percolator slab's engine by pumping KeeperCrank until the gap
 * between `clock.slot` and `engine.last_market_slot` falls inside
 * MAX_ACCRUAL_DT_SLOTS (=10).
 *
 * Each KeeperCrank advances the engine at most CATCHUP_CHUNKS_MAX × max_dt
 * = 200 slots per ix. An idle slab on devnet drifts ~7,200 slots per hour
 * (devnet does ~2 slots/sec). After a few hours of idleness it can take
 * 30-100 cranks to walk inside envelope.
 *
 * Call this ONCE before a batch of opens; T5's per-test primer keeps the
 * engine fresh through each individual open's proof-generation window.
 *
 * Usage:
 *   RPC=https://devnet.helius-rpc.com/?api-key=... \
 *     pnpm exec tsx tests/v2/scripts/warm-engine.ts
 */
import {
  Connection, Keypair, PublicKey, Transaction, TransactionInstruction,
  ComputeBudgetProgram, SYSVAR_CLOCK_PUBKEY, sendAndConfirmTransaction,
} from '@solana/web3.js';
import * as fs from 'node:fs';
import * as os from 'node:os';

const RPC = process.env.RPC ?? 'https://api.devnet.solana.com';
const MARKET_PATH = process.env.MARKET_PATH ?? '/tmp/percolator-market.json';
const MAX_ATTEMPTS = parseInt(process.env.MAX_ATTEMPTS ?? '120', 10);
const MAX_ACCRUAL_DT_SLOTS = 10;

function isCatchupRequired(e: any): boolean {
  const probe = (x: any): boolean => {
    if (!x) return false;
    if (typeof x === 'string') return /Custom"?\s*:\s*29/.test(x);
    if (x.InstructionError) {
      const inner = x.InstructionError[1];
      if (inner && typeof inner === 'object' && inner.Custom === 29) return true;
    }
    if (x.err && probe(x.err)) return true;
    if (x.cause && probe(x.cause)) return true;
    if (x.message && probe(x.message)) return true;
    try { return /"Custom":29/.test(JSON.stringify(x)); } catch { return false; }
  };
  try { return probe(e); } catch { return false; }
}

// Read engine.last_market_slot directly from the slab account. The
// engine struct lives at a fixed offset; last_market_slot is at u64 LE
// at the engine's `last_market_slot` field. Rather than vendoring the
// whole layout, we lift the value by its known offset against the
// percolator-cli's slab parser (offset confirmed against deployed binary).
async function readLastMarketSlot(conn: Connection, slab: PublicKey): Promise<bigint> {
  const acct = await conn.getAccountInfo(slab, 'confirmed');
  if (!acct) throw new Error(`slab ${slab.toBase58()} not found`);
  // Engine offsets confirmed against percolator-cli/src/solana/slab.ts:
  //   ENGINE_OFF = 520, ENGINE_LAST_MARKET_SLOT_OFF = 1016
  const ENGINE_OFF = 520;
  const ENGINE_LAST_MARKET_SLOT_OFF = 1016;
  const off = ENGINE_OFF + ENGINE_LAST_MARKET_SLOT_OFF;
  return acct.data.readBigUInt64LE(off);
}

async function main(): Promise<void> {
  const market = JSON.parse(fs.readFileSync(MARKET_PATH, 'utf8'));
  const slab = new PublicKey(market.slab);
  const percolatorProg = new PublicKey(market.percolator_program);
  const admin = Keypair.fromSecretKey(new Uint8Array(JSON.parse(
    fs.readFileSync(`${os.homedir()}/.config/solana/id.json`, 'utf8'))));

  const conn = new Connection(RPC, 'confirmed');

  const pushIx = new TransactionInstruction({
    programId: percolatorProg,
    keys: [
      { pubkey: admin.publicKey, isSigner: true, isWritable: false },
      { pubkey: slab, isSigner: false, isWritable: true },
    ],
    data: Buffer.concat([
      Buffer.from([17]),
      (() => { const b = Buffer.alloc(8); b.writeBigUInt64LE(100_000_000n, 0); return b; })(),
      (() => { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(Math.floor(Date.now() / 1000)), 0); return b; })(),
    ]),
  });
  const crankIx = new TransactionInstruction({
    programId: percolatorProg,
    keys: [
      { pubkey: admin.publicKey, isSigner: true, isWritable: true },
      { pubkey: slab, isSigner: false, isWritable: true },
      { pubkey: SYSVAR_CLOCK_PUBKEY, isSigner: false, isWritable: false },
      { pubkey: slab, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([5, 0xff, 0xff, 1]),
  });

  const slot0 = await conn.getSlot('confirmed');
  const last0 = await readLastMarketSlot(conn, slab);
  const gap0 = BigInt(slot0) - last0;
  console.log(`slab=${slab.toBase58()}`);
  console.log(`clock.slot=${slot0}  last_market_slot=${last0}  gap=${gap0}`);

  if (gap0 <= BigInt(MAX_ACCRUAL_DT_SLOTS)) {
    console.log(`already warm (gap=${gap0} ≤ ${MAX_ACCRUAL_DT_SLOTS})`);
    return;
  }

  // Each crank advances up to 200 slots; devnet runs ~2 slots/sec, so a
  // 1.5s delay between cranks keeps us comfortably ahead while staying
  // under Helius free-tier rate limits.
  const SLEEP_MS = parseInt(process.env.SLEEP_MS ?? '1500', 10);
  const sleep = (ms: number) => new Promise<void>((res) => setTimeout(res, ms));

  let attempts = 0;
  while (attempts < MAX_ATTEMPTS) {
    attempts += 1;
    const t0 = Date.now();
    let outcome = '?';
    try {
      // Crank alone: PushOraclePrice tries to accrue and trips CatchupRequired
      // before reaching the partial-progress wrapper. KeeperCrank's own path
      // uses the engine's stored mark for hyperp and commits partial progress.
      const tx = new Transaction()
        .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }))
        .add(crankIx);
      const sig = await sendAndConfirmTransaction(conn, tx, [admin],
        { commitment: 'confirmed', skipPreflight: true });
      outcome = `sig=${sig.slice(0, 8)}…`;
    } catch (e: any) {
      if (!isCatchupRequired(e)) {
        console.error(`crank failed (non-catchup): ${e?.message ?? e}`);
        throw e;
      }
      outcome = 'caught up partial (Custom 29)';
    }
    const slot = await conn.getSlot('confirmed');
    const last = await readLastMarketSlot(conn, slab);
    const gap = BigInt(slot) - last;
    console.log(`#${attempts}  ${outcome}  slot=${slot}  last=${last}  gap=${gap}  (${Date.now() - t0}ms)`);
    if (gap <= BigInt(MAX_ACCRUAL_DT_SLOTS)) {
      console.log(`warm (gap=${gap} ≤ ${MAX_ACCRUAL_DT_SLOTS}) after ${attempts} cranks`);
      return;
    }
    await sleep(SLEEP_MS);
  }
  throw new Error(`failed to warm engine after ${MAX_ATTEMPTS} cranks`);
}

main().catch((e) => { console.error(e); process.exit(1); });

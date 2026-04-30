/**
 * Phase 6c e2e — stress test the v2 nullifier IMT path through privateSwap
 * (adapt_execute) using the mock adapter for deterministic 2x output.
 *
 * Why mock adapter: isolates the v2 nullifier path's CU/cost on the
 * adapt_execute flow without Jupiter routing variability. Real-Jupiter
 * stress is a separate test.
 *
 * Loops N fresh wallets through shield (in_mint) → privateSwap → captures
 * the swap tx's CU + bytes + ix shape, against:
 *   - mainnet-fork validator (tests/v2/scripts/start-mainnet-fork.sh)
 *   - locally deployed b402_pool, b402_nullifier, mock-adapter
 *   - Light's address tree V2 + Photon indexer (local)
 */
import { describe, it, expect } from 'vitest';
import {
  AddressLookupTableProgram,
  ComputeBudgetProgram,
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from '@solana/spl-token';
import { createRpc } from '@lightprotocol/stateless.js';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

import {
  B402Solana,
  adapterRegistryPda,
  instructionDiscriminator,
  poolConfigPda,
  tokenConfigPda,
  treeStatePda,
  vaultPda,
} from '@b402ai/solana';

const SOLANA_RPC = process.env.SOLANA_RPC ?? 'http://127.0.0.1:8899';
const PHOTON_RPC = process.env.PHOTON_RPC ?? 'http://127.0.0.1:8784';
const POOL_ID = new PublicKey('42a3hsCXtQLWonyxWZosaaCJCweYYKMrvNd25p1Jrt2y');
const NULLIFIER_ID = new PublicKey('2AnRZwWu6CTurZs1yQpqrcJWo4yRYL1xpeV78b2siweq');
const VERIFIER_T_ID = new PublicKey('Afjbnv2Ekxa98jjRw33xPPhZabevek2uZxoE75kr6ZrK');
const VERIFIER_A_ID = new PublicKey('3Y2tyhNSaUiW5AcZcmFGRyTMdnroxHxc5GqFQPcMTZae');
const MOCK_ADAPTER_ID = new PublicKey('89kw33YDcbXfiayVNauz599LaDm51EuU8amWydpjYKgp');
const SYSVAR_RENT = new PublicKey('SysvarRent111111111111111111111111111111111');

// Mock adapter's `execute` discriminator — sha256("global:execute")[..8].
const EXECUTE_DISC = Uint8Array.from([130, 221, 242, 154, 13, 193, 189, 29]);

const N = Number(process.env.N_WALLETS ?? 5);
const DEBUG_LOG = process.env.DEBUG_LOG ?? '/tmp/v2-stress-logs/fork-swap.log';
fs.mkdirSync(path.dirname(DEBUG_LOG), { recursive: true });

function dbg(line: string): void {
  fs.appendFileSync(DEBUG_LOG, `[${new Date().toISOString()}] ${line}\n`);
}

function loadAdmin(): Keypair {
  const p = path.join(os.homedir(), '.config/solana/id.json');
  return Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(p, 'utf8'))));
}

async function initPoolIfNeeded(conn: Connection, admin: Keypair): Promise<void> {
  const cfg = await conn.getAccountInfo(poolConfigPda(POOL_ID));
  if (cfg) return;
  const treasury = PublicKey.findProgramAddressSync(
    [Buffer.from('b402/v1'), Buffer.from('treasury')], POOL_ID,
  )[0];
  const data = Buffer.concat([
    Buffer.from(instructionDiscriminator('init_pool')),
    admin.publicKey.toBuffer(),
    Buffer.from([1]),
    VERIFIER_T_ID.toBuffer(),
    VERIFIER_A_ID.toBuffer(),
    VERIFIER_T_ID.toBuffer(),
    admin.publicKey.toBuffer(),
  ]);
  const ix = new TransactionInstruction({
    programId: POOL_ID,
    keys: [
      { pubkey: admin.publicKey, isSigner: true, isWritable: true },
      { pubkey: poolConfigPda(POOL_ID), isSigner: false, isWritable: true },
      { pubkey: treeStatePda(POOL_ID), isSigner: false, isWritable: true },
      { pubkey: adapterRegistryPda(POOL_ID), isSigner: false, isWritable: true },
      { pubkey: treasury, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
  const cu = ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 });
  await sendAndConfirmTransaction(conn, new Transaction().add(cu, ix), [admin], { commitment: 'confirmed' });
}

async function addTokenConfigIfNeeded(conn: Connection, admin: Keypair, mint: PublicKey): Promise<void> {
  if (await conn.getAccountInfo(tokenConfigPda(POOL_ID, mint))) return;
  const ix = new TransactionInstruction({
    programId: POOL_ID,
    keys: [
      { pubkey: admin.publicKey, isSigner: true, isWritable: true },
      { pubkey: admin.publicKey, isSigner: true, isWritable: false },
      { pubkey: poolConfigPda(POOL_ID), isSigner: false, isWritable: false },
      { pubkey: tokenConfigPda(POOL_ID, mint), isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: vaultPda(POOL_ID, mint), isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([
      Buffer.from(instructionDiscriminator('add_token_config')),
      // max_tvl: u64 — pick a generous cap for tests.
      Buffer.from(new Uint8Array(new BigUint64Array([1_000_000_000_000_000n]).buffer)),
    ]),
  });
  const cu = ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 });
  await sendAndConfirmTransaction(conn, new Transaction().add(cu, ix), [admin], { commitment: 'confirmed' });
}

async function registerAdapterIfNeeded(conn: Connection, admin: Keypair): Promise<void> {
  const reg = await conn.getAccountInfo(adapterRegistryPda(POOL_ID));
  if (reg && reg.data.length > 12) {
    const target = MOCK_ADAPTER_ID.toBuffer();
    for (let i = 12; i + 32 <= reg.data.length; i++) {
      if (reg.data.slice(i, i + 32).equals(target)) return;
    }
  }
  const u32Le = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n, 0); return b; };
  const args = Buffer.concat([MOCK_ADAPTER_ID.toBuffer(), u32Le(1), Buffer.from(EXECUTE_DISC)]);
  const ix = new TransactionInstruction({
    programId: POOL_ID,
    keys: [
      { pubkey: admin.publicKey, isSigner: true, isWritable: true },
      { pubkey: poolConfigPda(POOL_ID), isSigner: false, isWritable: false },
      { pubkey: adapterRegistryPda(POOL_ID), isSigner: false, isWritable: true },
    ],
    data: Buffer.concat([Buffer.from(instructionDiscriminator('register_adapter')), args]),
  });
  const cu = ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 });
  await sendAndConfirmTransaction(conn, new Transaction().add(cu, ix), [admin], { commitment: 'confirmed' });
}

async function buildSwapAlt(
  conn: Connection,
  admin: Keypair,
  inMint: PublicKey,
  outMint: PublicKey,
  adapterInTa: PublicKey,
  adapterOutTa: PublicKey,
  relayerFeeAta: PublicKey,
  addressTree: PublicKey,
  outputQueue: PublicKey,
): Promise<PublicKey> {
  // Light V2 fixture accounts (programs are deterministic; tree + queue
  // pubkeys are passed in because they're fork-specific and must match
  // what Photon returns from getValidityProof — otherwise they go inline
  // and the swap tx overruns 1232 B).
  const LIGHT_SYSTEM_PROGRAM = new PublicKey('SySTEM1eSU2p4BGQfQpimFEWWSC1XDFeun3Nqzz3rT7');
  const ACCOUNT_COMPRESSION_PROGRAM = new PublicKey('compr6CUsB5m2jS4Y3831ztGSTnDpnKJTKS95d64XVq');
  const REGISTERED_PROGRAM_PDA = new PublicKey('35hkDgaAKwMCaxRz2ocSZ6NaUrtKkyNqU6c4RV3tYJRh');
  const ACCOUNT_COMPRESSION_AUTHORITY = new PublicKey('HwXnGK3tPkkVY6P439H2p68AxpeuWXd5PcrAxFpbmfbA');
  const NOOP_PROGRAM = new PublicKey('noopb9bkMVfRPU8AsbpTUg8AQkHtKwMYZiFUjNRtMmV');
  const ADDRESS_TREE = addressTree;
  const OUTPUT_QUEUE = outputQueue;

  const adapterAuthority = PublicKey.findProgramAddressSync(
    [Buffer.from('b402/v1'), Buffer.from('adapter')], MOCK_ADAPTER_ID,
  )[0];

  // ALT createLookupTable requires recentSlot < currentSlot at execution
  // time. On a fresh validator slots may not have advanced past a couple
  // of blocks, so we wait and use slot - 1 to guarantee strict less-than.
  await new Promise((r) => setTimeout(r, 1500));
  const slot = (await conn.getSlot('finalized')) - 1;
  const [createIx, altPubkey] = AddressLookupTableProgram.createLookupTable({
    authority: admin.publicKey, payer: admin.publicKey, recentSlot: slot,
  });
  await sendAndConfirmTransaction(conn, new Transaction().add(createIx), [admin], { commitment: 'confirmed' });

  const SYSVAR_INSTRUCTIONS = new PublicKey('Sysvar1nstructions1111111111111111111111111');
  const COMPUTE_BUDGET = new PublicKey('ComputeBudget111111111111111111111111111111');
  // b402_nullifier program's CPI authority PDA — used as a key by the
  // sibling create_nullifier ix. Missing from the ALT means it goes inline
  // (32 bytes) on every swap, busting the 1232-byte v0 cap.
  const NULLIFIER_CPI_AUTHORITY = PublicKey.findProgramAddressSync(
    [Buffer.from('cpi_authority')],
    NULLIFIER_ID,
  )[0];
  const addresses = [
    LIGHT_SYSTEM_PROGRAM, ACCOUNT_COMPRESSION_PROGRAM, REGISTERED_PROGRAM_PDA,
    ACCOUNT_COMPRESSION_AUTHORITY, NOOP_PROGRAM, ADDRESS_TREE, OUTPUT_QUEUE,
    NULLIFIER_ID, NULLIFIER_CPI_AUTHORITY,
    POOL_ID,
    poolConfigPda(POOL_ID), adapterRegistryPda(POOL_ID), treeStatePda(POOL_ID),
    tokenConfigPda(POOL_ID, inMint), tokenConfigPda(POOL_ID, outMint),
    vaultPda(POOL_ID, inMint), vaultPda(POOL_ID, outMint),
    VERIFIER_A_ID, MOCK_ADAPTER_ID, adapterAuthority,
    adapterInTa, adapterOutTa,
    relayerFeeAta,
    SYSVAR_INSTRUCTIONS, COMPUTE_BUDGET,
    TOKEN_PROGRAM_ID, SystemProgram.programId,
  ];
  const extendIx = AddressLookupTableProgram.extendLookupTable({
    payer: admin.publicKey, authority: admin.publicKey, lookupTable: altPubkey, addresses,
  });
  await sendAndConfirmTransaction(conn, new Transaction().add(extendIx), [admin], { commitment: 'confirmed' });
  // Wait for ALT to be active. The ALT must be at least 1 slot older
  // than the tx that uses it; on a fresh validator with sparse blocks,
  // ~3s buys us several slots of headroom.
  await new Promise((r) => setTimeout(r, 3000));
  return altPubkey;
}

describe('Phase 6c — v2 fork swap stress', () => {
  it(
    `runs ${N} wallets through shield → privateSwap on the mainnet-fork`,
    async () => {
      const conn = new Connection(SOLANA_RPC, 'confirmed');
      const photonRpc = createRpc(SOLANA_RPC, PHOTON_RPC);
      const admin = loadAdmin();
      dbg(`=== fork swap stress N=${N} starting ===`);

      // ----- One-time setup -----
      await initPoolIfNeeded(conn, admin);
      await registerAdapterIfNeeded(conn, admin);

      // Two test mints (admin = mint authority, free mints).
      const inMint = await createMint(conn, admin, admin.publicKey, null, 6);
      const outMint = await createMint(conn, admin, admin.publicKey, null, 6);
      dbg(`mints  in=${inMint.toBase58()}  out=${outMint.toBase58()}`);

      await addTokenConfigIfNeeded(conn, admin, inMint);
      await addTokenConfigIfNeeded(conn, admin, outMint);

      // Adapter scratch ATAs (owned by adapter authority PDA, off-curve).
      const adapterAuthority = PublicKey.findProgramAddressSync(
        [Buffer.from('b402/v1'), Buffer.from('adapter')], MOCK_ADAPTER_ID,
      )[0];
      const adapterInTa = await getOrCreateAssociatedTokenAccount(
        conn, admin, inMint, adapterAuthority, true,
      );
      const adapterOutTa = await getOrCreateAssociatedTokenAccount(
        conn, admin, outMint, adapterAuthority, true,
      );
      // Pre-fund adapterOutTa heavily — mock adapter does 2x out, and the
      // pool's out-vault rent threshold needs the OUT to land cleanly.
      await mintTo(conn, admin, outMint, adapterOutTa.address, admin, 100_000_000_000n);
      dbg(`adapter scratch TAs ready  in=${adapterInTa.address.toBase58()}  out=${adapterOutTa.address.toBase58()}`);

      // SHARED relayer across iterations. The SDK derives fee_ata_sentinel
      // as ATA(inMint, relayer.publicKey); if relayer changes per-iter, that
      // ATA is per-iter and goes inline (32 B) — busting the 1232-byte v0
      // cap on the swap path. Pinning the relayer lets fee_ata_sentinel sit
      // in the ALT. Privacy property is preserved: relayer != alice.
      const sharedRelayer = Keypair.generate();
      await sendAndConfirmTransaction(
        conn,
        new Transaction().add(
          SystemProgram.transfer({
            fromPubkey: admin.publicKey,
            toPubkey: sharedRelayer.publicKey,
            lamports: 1 * LAMPORTS_PER_SOL,
          }),
        ),
        [admin],
        { commitment: 'confirmed' },
      );
      const relayerFeeAta = await getOrCreateAssociatedTokenAccount(
        conn, admin, inMint, sharedRelayer.publicKey,
      );
      dbg(`shared relayer ${sharedRelayer.publicKey.toBase58()}  fee_ata=${relayerFeeAta.address.toBase58()}`);

      // The SDK's getValidityProofForNullifier hardcodes these (see
      // packages/sdk/src/light-nullifier.ts). They MUST be in the ALT
      // or every swap inlines them (64 B) and overruns the 1232-byte cap.
      const realAddressTree = new PublicKey('amt2kaJA14v3urZbZvnc5v2np8jqvc4Z8zDep5wbtzx');
      const realOutputQueue = new PublicKey('oq5oh5ZR3yGomuQgFduNDzjtGvVWfDRGLuDVjv9a96P');

      const altPubkey = await buildSwapAlt(
        conn, admin, inMint, outMint, adapterInTa.address, adapterOutTa.address,
        relayerFeeAta.address, realAddressTree, realOutputQueue,
      );
      dbg(`swap ALT created  ${altPubkey.toBase58()}`);

      // ----- Per-wallet loop -----
      const results: Array<{
        idx: number; ok: boolean; error?: string;
        shieldMs: number; swapMs: number;
        gasUsed: bigint;
        swapCu?: number; swapTxBytes?: number;
        swapIxCount?: number; swapInnerCount?: number;
        swapFee?: number; swapLogLines?: number;
        swapSig?: string;
      }> = [];

      for (let i = 0; i < N; i++) {
        if (i > 0) await new Promise((r) => setTimeout(r, 500));
        const alice = Keypair.generate();
        const relayer = sharedRelayer; // pinned — see comment above
        dbg(`[${i + 1}/${N}] starting  alice=${alice.publicKey.toBase58().slice(0, 12)}…`);

        const PER_WALLET = 0.05 * LAMPORTS_PER_SOL;
        await sendAndConfirmTransaction(
          conn,
          new Transaction().add(
            SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: alice.publicKey, lamports: PER_WALLET }),
          ),
          [admin],
          { commitment: 'confirmed' },
        );

        const aliceInAta = await getOrCreateAssociatedTokenAccount(conn, admin, inMint, alice.publicKey);
        await mintTo(conn, admin, inMint, aliceInAta.address, admin, 1_000_000n);

        const circuits = path.resolve(__dirname, '../../../circuits/build');
        const b402 = new B402Solana({
          cluster: SOLANA_RPC.includes('127.0.0.1') ? 'localnet' : 'devnet',
          rpcUrl: SOLANA_RPC,
          keypair: alice,
          relayer,
          // Phase 7 toggle (set INLINE_CPI=1 to use inline-CPI nullifier path).
          inlineCpiNullifier: process.env.INLINE_CPI === '1',
          proverArtifacts: {
            wasmPath: path.join(circuits, 'transact_js/transact.wasm'),
            zkeyPath: path.join(circuits, 'ceremony/transact_final.zkey'),
          },
          adaptProverArtifacts: {
            wasmPath: path.join(circuits, 'adapt_js/adapt.wasm'),
            zkeyPath: path.join(circuits, 'ceremony/adapt_final.zkey'),
          },
        });

        const tShield = Date.now();
        let shieldRes: { signature: string };
        try {
          shieldRes = await b402.shield({ mint: inMint, amount: 1_000_000n, omitEncryptedNotes: true });
        } catch (e) {
          const err = `shield: ${(e as Error).message.slice(0, 200)}`;
          dbg(`[${i + 1}/${N}] FAIL ${err}`);
          results.push({ idx: i, ok: false, error: err, shieldMs: Date.now() - tShield, swapMs: 0, gasUsed: 0n });
          continue;
        }
        const shieldMs = Date.now() - tShield;
        dbg(`[${i + 1}/${N}] shield ok ${shieldMs}ms`);

        const before = BigInt(await conn.getBalance(relayer.publicKey));
        const tSwap = Date.now();
        let swapRes: { signature: string; outAmount: bigint };
        try {
          swapRes = await b402.privateSwap({
            inMint,
            outMint,
            amount: 1_000_000n,
            adapterProgramId: MOCK_ADAPTER_ID,
            adapterInTa: adapterInTa.address,
            adapterOutTa: adapterOutTa.address,
            alt: altPubkey,
            photonRpc,
            expectedOut: 2_000_000n, // mock adapter is 2x
          });
        } catch (e) {
          const err = `swap: ${(e as Error).message.slice(0, 200)}`;
          dbg(`[${i + 1}/${N}] FAIL ${err}`);
          dbg(`stack: ${(e as Error).stack?.split('\n').slice(0, 6).join(' | ')}`);
          results.push({ idx: i, ok: false, error: err, shieldMs, swapMs: Date.now() - tSwap, gasUsed: 0n });
          continue;
        }
        const swapMs = Date.now() - tSwap;
        const after = BigInt(await conn.getBalance(relayer.publicKey));
        const gasUsed = before - after;

        // Fetch tx for metrics.
        let swapCu: number | undefined;
        let swapTxBytes: number | undefined;
        let swapIxCount: number | undefined;
        let swapInnerCount: number | undefined;
        let swapFee: number | undefined;
        let swapLogLines: number | undefined;
        try {
          let tx = await conn.getTransaction(swapRes.signature, {
            maxSupportedTransactionVersion: 0, commitment: 'confirmed',
          });
          if (!tx) {
            await new Promise((r) => setTimeout(r, 1500));
            tx = await conn.getTransaction(swapRes.signature, {
              maxSupportedTransactionVersion: 0, commitment: 'confirmed',
            });
          }
          if (tx?.meta) {
            swapCu = tx.meta.computeUnitsConsumed ?? undefined;
            swapFee = tx.meta.fee;
            swapLogLines = tx.meta.logMessages?.length;
            swapInnerCount = tx.meta.innerInstructions?.reduce(
              (acc, inner) => acc + inner.instructions.length, 0,
            ) ?? 0;
            const msg = tx.transaction.message;
            swapIxCount = (msg.compiledInstructions ?? (msg as any).instructions ?? []).length;
            try { swapTxBytes = msg.serialize().length; } catch {}
          }
        } catch {}

        dbg(
          `[${i + 1}/${N}] swap ok ${swapMs}ms  gas=${gasUsed}  cu=${swapCu ?? '?'}  bytes=${swapTxBytes ?? '?'}  ` +
          `ix=${swapIxCount ?? '?'}/inner=${swapInnerCount ?? '?'}  outAmount=${swapRes.outAmount}  sig=${swapRes.signature.slice(0, 12)}…`,
        );
        results.push({
          idx: i, ok: true, shieldMs, swapMs, gasUsed,
          swapSig: swapRes.signature,
          swapCu, swapTxBytes, swapIxCount, swapInnerCount, swapFee, swapLogLines,
        });
      }

      // ----- Report -----
      const ok = results.filter((r) => r.ok);
      const fail = results.filter((r) => !r.ok);
      console.log('\n=== Phase 6c fork swap report ===');
      console.log(`N=${N}  ok=${ok.length}  fail=${fail.length}`);
      if (ok.length) {
        const stat = (xs: number[]) => ({
          avg: xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0,
          min: xs.length ? Math.min(...xs) : 0,
          max: xs.length ? Math.max(...xs) : 0,
        });
        const num = (k: keyof (typeof results)[number]) =>
          ok.map((r) => r[k] as number | undefined).filter((v): v is number => typeof v === 'number');
        const cu = stat(num('swapCu'));
        const bytes = stat(num('swapTxBytes'));
        const ix = stat(num('swapIxCount'));
        const inner = stat(num('swapInnerCount'));
        const fee = stat(num('swapFee'));
        const logs = stat(num('swapLogLines'));
        const swapMs = stat(ok.map((r) => r.swapMs));
        const gas = ok.map((r) => Number(r.gasUsed));
        const avgGas = gas.reduce((a, b) => a + b, 0) / gas.length;
        console.log(`avg swap relayer delta: ${avgGas.toFixed(0)} lamports (~$${((avgGas / 1e9) * 190).toFixed(4)})`);
        console.log(`swap ms: avg=${swapMs.avg.toFixed(0)}  max=${swapMs.max}`);
        console.log('--- complexity (per swap) ---');
        console.log(`  CU       avg=${cu.avg.toFixed(0)}  min=${cu.min}  max=${cu.max}`);
        console.log(`  tx bytes avg=${bytes.avg.toFixed(0)}  min=${bytes.min}  max=${bytes.max}  (cap=1232)`);
        console.log(`  top-ix   avg=${ix.avg.toFixed(1)}  min=${ix.min}  max=${ix.max}`);
        console.log(`  inner    avg=${inner.avg.toFixed(1)}  min=${inner.min}  max=${inner.max}  (CPI depth proxy)`);
        console.log(`  fee      avg=${fee.avg.toFixed(0)}  min=${fee.min}  max=${fee.max}  lamports`);
        console.log(`  logs     avg=${logs.avg.toFixed(0)}  min=${logs.min}  max=${logs.max}  lines`);
      }
      if (fail.length) {
        console.log('\nfailures:');
        for (const f of fail) console.log(`  [${f.idx}] ${f.error}`);
      }
      expect(fail.length).toBe(0);
    },
    600_000,
  );
});

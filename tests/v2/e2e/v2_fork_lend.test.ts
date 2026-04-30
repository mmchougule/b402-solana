/**
 * Phase 6c e2e — privateLend through pool::adapt_execute against real
 * mainnet-cloned Kamino USDC reserve on the local fork.
 *
 * Why: validates that v2.1's adapt_execute path (the trim that lifted swap
 * under the 1232 cap) works for Kamino's deposit shape. Same architectural
 * envelope as swap, different adapter ID and remaining_accounts layout —
 * if this is green, lend/redeem/perpOpen all share the same handler so
 * they're covered too.
 *
 * Flow per iteration:
 *   1. Shield USDC (alice → pool)
 *   2. privateLend (== privateSwap with kamino_adapter program ID)
 *      - in_mint = USDC, out_mint = kUSDC
 *      - action_payload = Borsh(KaminoAction::Deposit { reserve, in, min_kt_out: 0 })
 *      - remainingAccounts = ra_deposit layout (19 entries)
 *   3. Assert pool's kUSDC out_vault grew
 *
 * Pre-req:
 *   tests/v2/scripts/start-mainnet-fork.sh booted with KAMINO_DATA_LIMIT=7
 *   + INJECT_USDC_ATA=/tmp/alice-usdc-ata.json + ALICE_USDC_ATA=...
 *   Pool init'd (init-localnet.mjs).
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
  getAccount,
  getAssociatedTokenAddressSync,
  getOrCreateAssociatedTokenAccount,
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
const VERIFIER_A_ID = new PublicKey('3Y2tyhNSaUiW5AcZcmFGRyTMdnroxHxc5GqFQPcMTZae');
const KAMINO_ADAPTER_ID = new PublicKey('2enwFgcGKJDqruHpCtvmhtxe3DYcV3k72VTvoGcdt2rX');
const KLEND = new PublicKey('KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD');
const FARMS_PROGRAM = new PublicKey('FarmsPZpWu9i7Kky8tPN37rs2TpmMrAZrC7S7vJa91Hr');
const SYSVAR_RENT = new PublicKey('SysvarRent111111111111111111111111111111111');
const SYSVAR_INSTRUCTIONS = new PublicKey('Sysvar1nstructions1111111111111111111111111');
const COMPUTE_BUDGET = new PublicKey('ComputeBudget111111111111111111111111111111');

// kamino_adapter::execute discriminator. sha256("global:execute")[..8].
const EXECUTE_DISC = Uint8Array.from([130, 221, 242, 154, 13, 193, 189, 29]);

const N = Number(process.env.N_WALLETS ?? 1);
const DEBUG_LOG = process.env.DEBUG_LOG ?? '/tmp/v2-stress-logs/fork-lend.log';
fs.mkdirSync(path.dirname(DEBUG_LOG), { recursive: true });

function dbg(line: string): void {
  fs.appendFileSync(DEBUG_LOG, `[${new Date().toISOString()}] ${line}\n`);
}

function loadAdmin(): Keypair {
  return Keypair.fromSecretKey(
    new Uint8Array(JSON.parse(fs.readFileSync(path.join(os.homedir(), '.config/solana/id.json'), 'utf8'))),
  );
}

// ---- Kamino reserve parsing (from examples/kamino-adapter-fork-deposit.ts) ----
function findUtf8(buf: Buffer, needle: string): number {
  const b = Buffer.from(needle, 'utf8');
  for (let i = 0; i < buf.length - b.length; i++) {
    if (buf.subarray(i, i + b.length).equals(b)) return i;
  }
  return -1;
}

function reservePda(seed: string, market: PublicKey, mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(seed), market.toBuffer(), mint.toBuffer()],
    KLEND,
  )[0];
}

function lendingMarketAuthorityPda(market: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from('lma'), market.toBuffer()], KLEND)[0];
}

function userMetadataPda(owner: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from('user_meta'), owner.toBuffer()], KLEND)[0];
}

function obligationPda(owner: PublicKey, market: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from([0]),
      Buffer.from([0]),
      owner.toBuffer(),
      market.toBuffer(),
      PublicKey.default.toBuffer(),
      PublicKey.default.toBuffer(),
    ],
    KLEND,
  )[0];
}

function obligationFarmPda(farm: PublicKey, obligation: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('user'), farm.toBuffer(), obligation.toBuffer()],
    FARMS_PROGRAM,
  )[0];
}

interface ReserveAccts {
  liquidityMint: PublicKey;
  liquiditySupply: PublicKey;
  collateralMint: PublicKey;
  collateralReserveDestSupply: PublicKey;
  oracles: { pyth: PublicKey | null; switchboardPrice: PublicKey | null; switchboardTwap: PublicKey | null; scope: PublicKey | null };
  reserveFarmCollateral: PublicKey;
}

function parseReserve(market: PublicKey, data: Buffer): ReserveAccts {
  const liquidityMint = new PublicKey(data.subarray(128, 160));
  const reserveFarmCollateral = new PublicKey(data.subarray(64, 96));
  let nameOff = findUtf8(data, 'USDC\0');
  if (nameOff < 0) nameOff = findUtf8(data, 'USD Coin');
  if (nameOff < 0) throw new Error('TokenInfo.name not found');
  const tokenInfoOff = nameOff;
  const scopeOff = tokenInfoOff + 32 + 24 + 24;
  const swbOff = scopeOff + 52;
  const pythOff = swbOff + 68;
  const def = PublicKey.default;
  const readPk = (off: number): PublicKey | null => {
    const pk = new PublicKey(data.subarray(off, off + 32));
    return pk.equals(def) ? null : pk;
  };
  return {
    liquidityMint,
    liquiditySupply: reservePda('reserve_liq_supply', market, liquidityMint),
    collateralMint: reservePda('reserve_coll_mint', market, liquidityMint),
    collateralReserveDestSupply: reservePda('reserve_coll_supply', market, liquidityMint),
    oracles: {
      scope: readPk(scopeOff),
      switchboardPrice: readPk(swbOff),
      switchboardTwap: readPk(swbOff + 32),
      pyth: readPk(pythOff),
    },
    reserveFarmCollateral,
  };
}

// ---- pool admin ix builders (init/register/add_token_config) ----
async function registerKaminoAdapter(conn: Connection, admin: Keypair): Promise<void> {
  const reg = await conn.getAccountInfo(adapterRegistryPda(POOL_ID));
  if (reg && reg.data.length > 12) {
    const target = KAMINO_ADAPTER_ID.toBuffer();
    for (let i = 12; i + 32 <= reg.data.length; i++) {
      if (reg.data.slice(i, i + 32).equals(target)) return;
    }
  }
  const u32Le = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n, 0); return b; };
  const args = Buffer.concat([KAMINO_ADAPTER_ID.toBuffer(), u32Le(1), Buffer.from(EXECUTE_DISC)]);
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
      Buffer.from(new Uint8Array(new BigUint64Array([1_000_000_000_000_000n]).buffer)),
    ]),
  });
  const cu = ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 });
  await sendAndConfirmTransaction(conn, new Transaction().add(cu, ix), [admin], { commitment: 'confirmed' });
}

describe('Phase 6c — v2 fork lend (Kamino USDC deposit through pool::adapt_execute)', () => {
  it(
    'shield → privateLend: USDC → kUSDC via kamino_adapter on mainnet-fork',
    async () => {
      const conn = new Connection(SOLANA_RPC, 'confirmed');
      const photonRpc = createRpc(SOLANA_RPC, PHOTON_RPC);
      const admin = loadAdmin();
      dbg('=== fork lend test starting ===');

      // Read kamino-clone for canonical reserve/market.
      const clone = JSON.parse(fs.readFileSync('/tmp/kamino-clone.json', 'utf8'));
      const RESERVE = new PublicKey(clone.constants.reserve);
      const MARKET = new PublicKey(clone.constants.lendingMarket);
      const MARKET_AUTH = lendingMarketAuthorityPda(MARKET);

      // Parse reserve to find vaults + oracles.
      const reserveAcct = await conn.getAccountInfo(RESERVE);
      if (!reserveAcct) throw new Error('reserve missing — check fork boot KAMINO state cloning');
      const r = parseReserve(MARKET, reserveAcct.data);
      const isFarmAttached = !r.reserveFarmCollateral.equals(PublicKey.default);
      const inMint = r.liquidityMint;        // USDC
      const outMint = r.collateralMint;       // kUSDC
      dbg(`reserve=${RESERVE.toBase58().slice(0, 12)}…  inMint=USDC  outMint=kUSDC=${outMint.toBase58().slice(0, 12)}…  farm=${isFarmAttached}`);

      // Adapter authority PDA — same for every Kamino call.
      const [adapterAuthority] = PublicKey.findProgramAddressSync(
        [Buffer.from('b402/v1'), Buffer.from('adapter')],
        KAMINO_ADAPTER_ID,
      );

      // Pool admin setup.
      await registerKaminoAdapter(conn, admin);
      await addTokenConfigIfNeeded(conn, admin, inMint);
      await addTokenConfigIfNeeded(conn, admin, outMint);
      dbg('pool admin setup ok');

      // Adapter scratch ATAs (owned by adapter_authority off-curve).
      const adapterInTa = await getOrCreateAssociatedTokenAccount(conn, admin, inMint, adapterAuthority, true);
      const adapterOutTa = await getOrCreateAssociatedTokenAccount(conn, admin, outMint, adapterAuthority, true);

      // Adapter authority needs SOL for init rent (user_metadata, obligation).
      const aaBal = await conn.getBalance(adapterAuthority);
      if (aaBal < LAMPORTS_PER_SOL) {
        await sendAndConfirmTransaction(
          conn,
          new Transaction().add(
            SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: adapterAuthority, lamports: 2 * LAMPORTS_PER_SOL }),
          ),
          [admin],
          { commitment: 'confirmed' },
        );
      }
      dbg(`adapter_authority funded for init rent`);

      // Kamino-derived PDAs that go into ra_deposit.
      const userMetadata = userMetadataPda(adapterAuthority);
      const obligation = obligationPda(adapterAuthority, MARKET);
      const obligationFarm = isFarmAttached
        ? obligationFarmPda(r.reserveFarmCollateral, obligation)
        : KLEND; // sentinel
      const reserveFarmState = isFarmAttached ? r.reserveFarmCollateral : KLEND;

      // ALT: every account either pool or adapter touches that's stable.
      // Per-iteration accounts (relayer signer, fee_ata_sentinel) stay inline.
      const slot = (await conn.getSlot('finalized')) - 1;
      const [createIx, altPubkey] = AddressLookupTableProgram.createLookupTable({
        authority: admin.publicKey, payer: admin.publicKey, recentSlot: slot,
      });
      await sendAndConfirmTransaction(conn, new Transaction().add(createIx), [admin], { commitment: 'confirmed' });

      const LIGHT_SYSTEM_PROGRAM = new PublicKey('SySTEM1eSU2p4BGQfQpimFEWWSC1XDFeun3Nqzz3rT7');
      const ACCOUNT_COMPRESSION_PROGRAM = new PublicKey('compr6CUsB5m2jS4Y3831ztGSTnDpnKJTKS95d64XVq');
      const REGISTERED_PROGRAM_PDA = new PublicKey('35hkDgaAKwMCaxRz2ocSZ6NaUrtKkyNqU6c4RV3tYJRh');
      const ACCOUNT_COMPRESSION_AUTHORITY = new PublicKey('HwXnGK3tPkkVY6P439H2p68AxpeuWXd5PcrAxFpbmfbA');
      const ADDRESS_TREE = new PublicKey('amt2kaJA14v3urZbZvnc5v2np8jqvc4Z8zDep5wbtzx');
      const OUTPUT_QUEUE = new PublicKey('oq5oh5ZR3yGomuQgFduNDzjtGvVWfDRGLuDVjv9a96P');
      const NULLIFIER_CPI_AUTHORITY = PublicKey.findProgramAddressSync(
        [Buffer.from('cpi_authority')],
        NULLIFIER_ID,
      )[0];

      // Shared relayer (fee_ata_sentinel must be ALT-resident — same trick as swap).
      const sharedRelayer = Keypair.generate();
      await sendAndConfirmTransaction(
        conn,
        new Transaction().add(
          SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: sharedRelayer.publicKey, lamports: 2 * LAMPORTS_PER_SOL }),
        ),
        [admin],
        { commitment: 'confirmed' },
      );
      const relayerFeeAta = await getOrCreateAssociatedTokenAccount(conn, admin, inMint, sharedRelayer.publicKey);

      const altAddresses = [
        // Light v2 infra
        LIGHT_SYSTEM_PROGRAM, ACCOUNT_COMPRESSION_PROGRAM, REGISTERED_PROGRAM_PDA,
        ACCOUNT_COMPRESSION_AUTHORITY, ADDRESS_TREE, OUTPUT_QUEUE,
        NULLIFIER_ID, NULLIFIER_CPI_AUTHORITY,
        // Pool
        POOL_ID,
        poolConfigPda(POOL_ID), adapterRegistryPda(POOL_ID), treeStatePda(POOL_ID),
        tokenConfigPda(POOL_ID, inMint), tokenConfigPda(POOL_ID, outMint),
        vaultPda(POOL_ID, inMint), vaultPda(POOL_ID, outMint),
        VERIFIER_A_ID,
        // Adapter
        KAMINO_ADAPTER_ID, adapterAuthority,
        adapterInTa.address, adapterOutTa.address,
        relayerFeeAta.address,
        // Kamino state — the ra_deposit set
        RESERVE, MARKET, MARKET_AUTH,
        r.liquiditySupply, r.collateralMint, r.collateralReserveDestSupply,
        // Oracles (some may be PublicKey.default; KLEND sentinel substituted at use site)
        r.oracles.pyth ?? KLEND, r.oracles.switchboardPrice ?? KLEND,
        r.oracles.switchboardTwap ?? KLEND, r.oracles.scope ?? KLEND,
        r.liquidityMint, FARMS_PROGRAM,
        userMetadata, obligation, obligationFarm, reserveFarmState,
        // System
        SYSVAR_INSTRUCTIONS, COMPUTE_BUDGET, TOKEN_PROGRAM_ID,
        SystemProgram.programId, SYSVAR_RENT, KLEND,
      ];
      // ALT extend ix has an account-list size limit per tx. Chunk if needed.
      const CHUNK = 25;
      for (let i = 0; i < altAddresses.length; i += CHUNK) {
        const ext = AddressLookupTableProgram.extendLookupTable({
          payer: admin.publicKey, authority: admin.publicKey, lookupTable: altPubkey,
          addresses: altAddresses.slice(i, i + CHUNK),
        });
        await sendAndConfirmTransaction(conn, new Transaction().add(ext), [admin], { commitment: 'confirmed' });
      }
      await new Promise((res) => setTimeout(res, 3000));
      dbg(`ALT ${altPubkey.toBase58().slice(0, 12)}… extended (${altAddresses.length} entries)`);

      // ---- per-iteration loop ----
      const results: Array<{
        idx: number; ok: boolean; error?: string;
        shieldMs: number; lendMs: number; gasUsed: bigint;
        kUsdcDelta?: bigint; sig?: string;
        cu?: number; bytes?: number; ix?: number; inner?: number; logs?: number;
      }> = [];

      // Alice — uses pre-injected USDC ATA from setup-kamino-fork.
      const aliceKey = Keypair.fromSecretKey(
        new Uint8Array(JSON.parse(fs.readFileSync('/tmp/b402-alice.json', 'utf8'))),
      );

      for (let i = 0; i < N; i++) {
        if (i > 0) await new Promise((r) => setTimeout(r, 500));
        dbg(`[${i + 1}/${N}] starting alice=${aliceKey.publicKey.toBase58().slice(0, 12)}…`);

        // Top up alice SOL each iter (she signs shield).
        await sendAndConfirmTransaction(
          conn,
          new Transaction().add(SystemProgram.transfer({
            fromPubkey: admin.publicKey, toPubkey: aliceKey.publicKey,
            lamports: 0.05 * LAMPORTS_PER_SOL,
          })),
          [admin], { commitment: 'confirmed' },
        );

        const circuits = path.resolve(__dirname, '../../../circuits/build');
        const b402 = new B402Solana({
          cluster: SOLANA_RPC.includes('127.0.0.1') ? 'localnet' : 'devnet',
          rpcUrl: SOLANA_RPC,
          keypair: aliceKey,
          relayer: sharedRelayer,
          // Phase 7 toggle. Set INLINE_CPI=1 to exercise the inline-CPI
          // nullifier path (pool builds the b402_nullifier::create_nullifier
          // CPI itself instead of relying on a sibling ix). Required against
          // a pool deployed with --features inline_cpi_nullifier + nullifier
          // with --features cpi-only.
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

        const SHIELD_AMT = 1_000_000n; // 1 USDC
        const tShield = Date.now();
        let shieldRes: { signature: string };
        try {
          shieldRes = await b402.shield({ mint: inMint, amount: SHIELD_AMT, omitEncryptedNotes: true });
        } catch (e) {
          const err = `shield: ${(e as Error).message.slice(0, 200)}`;
          dbg(`[${i + 1}/${N}] FAIL ${err}`);
          results.push({ idx: i, ok: false, error: err, shieldMs: Date.now() - tShield, lendMs: 0, gasUsed: 0n });
          continue;
        }
        const shieldMs = Date.now() - tShield;
        dbg(`[${i + 1}/${N}] shield ok ${shieldMs}ms`);

        // Build KaminoAction::Deposit Borsh: tag(1=Deposit) + reserve(32) + in_amount(8) + min_kt_out(8).
        // Wait — the enum has Deposit FIRST (tag = 0 in Borsh).
        const kaminoActionPayload = Buffer.alloc(1 + 32 + 8 + 8);
        let off = 0;
        kaminoActionPayload.writeUInt8(0, off); off += 1; // Deposit variant
        RESERVE.toBuffer().copy(kaminoActionPayload, off); off += 32;
        kaminoActionPayload.writeBigUInt64LE(SHIELD_AMT, off); off += 8;
        kaminoActionPayload.writeBigUInt64LE(0n, off); // min_kt_out

        // adapter execute ix data: disc + u64 in + u64 min_out + vec(action_payload).
        const u32Le = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n, 0); return b; };
        const u64Le = (v: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(v, 0); return b; };
        const adapterIxData = new Uint8Array(Buffer.concat([
          Buffer.from(EXECUTE_DISC),
          u64Le(SHIELD_AMT),
          u64Le(0n), // min_out_amount
          u32Le(kaminoActionPayload.length),
          kaminoActionPayload,
        ]));

        // ra_deposit remaining_accounts (19 entries).
        const remainingAccounts = [
          { pubkey: RESERVE, isSigner: false, isWritable: true },                        // 0
          { pubkey: MARKET, isSigner: false, isWritable: false },                         // 1
          { pubkey: MARKET_AUTH, isSigner: false, isWritable: false },                    // 2
          { pubkey: r.liquiditySupply, isSigner: false, isWritable: true },               // 3
          { pubkey: r.collateralMint, isSigner: false, isWritable: true },                // 4
          { pubkey: r.collateralReserveDestSupply, isSigner: false, isWritable: true },   // 5
          { pubkey: r.oracles.pyth ?? KLEND, isSigner: false, isWritable: false },        // 6
          { pubkey: r.oracles.switchboardPrice ?? KLEND, isSigner: false, isWritable: false }, // 7
          { pubkey: r.oracles.switchboardTwap ?? KLEND, isSigner: false, isWritable: false },  // 8
          { pubkey: r.oracles.scope ?? KLEND, isSigner: false, isWritable: false },       // 9
          { pubkey: r.liquidityMint, isSigner: false, isWritable: false },                // 10
          { pubkey: FARMS_PROGRAM, isSigner: false, isWritable: false },                  // 11
          { pubkey: userMetadata, isSigner: false, isWritable: true },                    // 12
          { pubkey: obligation, isSigner: false, isWritable: true },                      // 13
          { pubkey: obligationFarm, isSigner: false, isWritable: isFarmAttached },        // 14
          { pubkey: reserveFarmState, isSigner: false, isWritable: isFarmAttached },      // 15
          { pubkey: SYSVAR_INSTRUCTIONS, isSigner: false, isWritable: false },            // 16
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },        // 17
          { pubkey: SYSVAR_RENT, isSigner: false, isWritable: false },                    // 18
        ];

        // Snapshot pool's kUSDC out_vault pre-lend.
        const outVaultPda = vaultPda(POOL_ID, outMint);
        const preInfo = await conn.getAccountInfo(outVaultPda);
        const preKUsdc = preInfo
          ? BigInt(preInfo.data.readBigUInt64LE(64))
          : 0n;

        const tLend = Date.now();
        let lendRes: { signature: string; outAmount: bigint };
        try {
          lendRes = await b402.privateSwap({
            inMint,
            outMint,
            amount: SHIELD_AMT,
            adapterProgramId: KAMINO_ADAPTER_ID,
            adapterInTa: adapterInTa.address,
            adapterOutTa: adapterOutTa.address,
            alt: altPubkey,
            photonRpc,
            expectedOut: 0n,        // Kamino computes kUSDC out; we accept any amount > 0
            adapterIxData,
            actionPayload: kaminoActionPayload,
            remainingAccounts,
          });
        } catch (e) {
          const err = `lend: ${(e as Error).message.slice(0, 250)}`;
          dbg(`[${i + 1}/${N}] FAIL ${err}`);
          dbg(`stack: ${(e as Error).stack?.split('\n').slice(0, 8).join(' | ')}`);
          results.push({ idx: i, ok: false, error: err, shieldMs, lendMs: Date.now() - tLend, gasUsed: 0n });
          continue;
        }
        const lendMs = Date.now() - tLend;

        const postInfo = await conn.getAccountInfo(outVaultPda);
        const postKUsdc = postInfo
          ? BigInt(postInfo.data.readBigUInt64LE(64))
          : 0n;
        const kUsdcDelta = postKUsdc - preKUsdc;

        // Tx metrics.
        let cu: number | undefined;
        let bytes: number | undefined;
        let ixCount: number | undefined;
        let innerCount: number | undefined;
        let logs: number | undefined;
        try {
          let tx = await conn.getTransaction(lendRes.signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' });
          if (!tx) {
            await new Promise((r) => setTimeout(r, 1500));
            tx = await conn.getTransaction(lendRes.signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' });
          }
          if (tx?.meta) {
            cu = tx.meta.computeUnitsConsumed ?? undefined;
            logs = tx.meta.logMessages?.length;
            innerCount = tx.meta.innerInstructions?.reduce((acc, inn) => acc + inn.instructions.length, 0) ?? 0;
            const msg = tx.transaction.message;
            ixCount = (msg.compiledInstructions ?? (msg as any).instructions ?? []).length;
            try { bytes = msg.serialize().length; } catch {}
          }
        } catch {}

        dbg(`[${i + 1}/${N}] lend ok ${lendMs}ms  kUSDC_delta=${kUsdcDelta}  cu=${cu ?? '?'}  bytes=${bytes ?? '?'}  ix=${ixCount ?? '?'}/inner=${innerCount ?? '?'}  sig=${lendRes.signature.slice(0, 12)}…`);
        results.push({
          idx: i, ok: true, shieldMs, lendMs,
          gasUsed: 0n, kUsdcDelta, sig: lendRes.signature,
          cu, bytes, ix: ixCount, inner: innerCount, logs,
        });
      }

      // Report.
      const ok = results.filter((r) => r.ok);
      const fail = results.filter((r) => !r.ok);
      console.log('\n=== Phase 6c fork lend report ===');
      console.log(`N=${N}  ok=${ok.length}  fail=${fail.length}`);
      if (ok.length) {
        const stat = (xs: number[]) => xs.length ? { avg: xs.reduce((a, b) => a + b, 0) / xs.length, min: Math.min(...xs), max: Math.max(...xs) } : { avg: 0, min: 0, max: 0 };
        const num = (k: keyof (typeof results)[number]) => ok.map((r) => r[k] as number | undefined).filter((v): v is number => typeof v === 'number');
        const cu = stat(num('cu'));
        const bytes = stat(num('bytes'));
        const lendMs = stat(ok.map((r) => r.lendMs));
        console.log(`lend ms:   avg=${lendMs.avg.toFixed(0)}  max=${lendMs.max}`);
        console.log(`CU:        avg=${cu.avg.toFixed(0)}  min=${cu.min}  max=${cu.max}`);
        console.log(`tx bytes:  avg=${bytes.avg.toFixed(0)}  min=${bytes.min}  max=${bytes.max}  (cap=1232)`);
        const deltas = ok.map((r) => r.kUsdcDelta ?? 0n);
        console.log(`kUSDC delta avg: ${deltas.reduce((a, b) => a + b, 0n) / BigInt(deltas.length)}`);
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

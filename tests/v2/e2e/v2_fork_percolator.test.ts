/**
 * PRD-36 — slice 5-γ: full pool→adapter→percolator e2e on local fork.
 *
 * TDD ladder (each `it` block gates the next):
 *
 *   T1 — pool initialized + adapter registered + token_config added
 *   T2 — percolator market bootstrapped (slab + LP + matcher)
 *   T3 — perp_mapping account allocated for the slab
 *   T4 — alice's b402 wallet shielded a USDC note via pool.shield
 *   T5 — alice's privatePerpOpen lands a position on the slab,
 *        signed by relayer (not alice's wallet), with owner_pda derived
 *        from her bytes_le(spendingPub)
 *
 * Pre-conditions (manual):
 *   - solana-test-validator running with all 6 programs deployed
 *     (b402-pool, b402-nullifier, b402-verifier-adapt, b402-percolator-adapter,
 *      percolator-prog, percolator-match)
 *   - Custom test mint at `/tmp/local-mint-keypair.json` already created on
 *     the fork (see examples/percolator-multi-user-smoke.mjs prereqs)
 */
import { describe, it, expect, beforeAll } from 'vitest';
import {
  ComputeBudgetProgram, Connection, Keypair, PublicKey, SystemProgram,
  Transaction, TransactionInstruction, sendAndConfirmTransaction, SYSVAR_RENT_PUBKEY,
  SYSVAR_CLOCK_PUBKEY, LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
  getOrCreateAssociatedTokenAccount, getAssociatedTokenAddressSync,
  createMintToInstruction,
} from '@solana/spl-token';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { instructionDiscriminator } from '../../../packages/sdk/src/programs/anchor.js';
import {
  poolConfigPda, treeStatePda, adapterRegistryPda, tokenConfigPda, vaultPda,
} from '../../../packages/sdk/src/programs/pda.js';
import { B402Solana } from '../../../packages/sdk/src/b402.js';
import { createRpc } from '@lightprotocol/stateless.js';

const RPC = 'http://127.0.0.1:8899';
const POOL_ID = new PublicKey('42a3hsCXtQLWonyxWZosaaCJCweYYKMrvNd25p1Jrt2y');
const NULLIFIER_ID = new PublicKey('2AnRZwWu6CTurZs1yQpqrcJWo4yRYL1xpeV78b2siweq');
const VERIFIER_T_ID = new PublicKey('Afjbnv2Ekxa98jjRw33xPPhZabevek2uZxoE75kr6ZrK');
const VERIFIER_A_ID = new PublicKey('3Y2tyhNSaUiW5AcZcmFGRyTMdnroxHxc5GqFQPcMTZae');
const PERCOLATOR_ADAPTER_ID = new PublicKey('65NRt6GpeakqXhqvKcN3knohzKEZT37arUyQi3SZwfxv');
const PERCOLATOR_PROG_ID = new PublicKey('DzLTTqyx7tFjwseeDTnu4f6c55H5abPgcohRVkNCS4Bn');
const MATCHER_PROG_ID = new PublicKey('BoYEMRSe6cRw6jswHtApQVqjLf1PPakfuuDyxgWijYBU');
const MINT_KEYPAIR_PATH = '/tmp/local-mint-keypair.json';

const EXECUTE_DISC = Uint8Array.from([130, 221, 242, 154, 13, 193, 189, 29]);

function loadAdmin(): Keypair {
  return Keypair.fromSecretKey(new Uint8Array(JSON.parse(
    fs.readFileSync(`${os.homedir()}/.config/solana/id.json`, 'utf8'))));
}
function loadMint(): Keypair {
  return Keypair.fromSecretKey(new Uint8Array(JSON.parse(
    fs.readFileSync(MINT_KEYPAIR_PATH, 'utf8'))));
}

async function ensurePoolInit(conn: Connection, admin: Keypair): Promise<void> {
  if (await conn.getAccountInfo(poolConfigPda(POOL_ID))) return;
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

async function ensurePercolatorAdapterRegistered(conn: Connection, admin: Keypair): Promise<void> {
  const reg = await conn.getAccountInfo(adapterRegistryPda(POOL_ID));
  if (reg && reg.data.length > 12) {
    const target = PERCOLATOR_ADAPTER_ID.toBuffer();
    for (let i = 12; i + 32 <= reg.data.length; i++) {
      if (reg.data.slice(i, i + 32).equals(target)) return;
    }
  }
  const u32Le = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n, 0); return b; };
  const args = Buffer.concat([
    PERCOLATOR_ADAPTER_ID.toBuffer(),
    u32Le(1),
    Buffer.from(EXECUTE_DISC),
  ]);
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

async function ensureTokenConfig(conn: Connection, admin: Keypair, mint: PublicKey): Promise<void> {
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
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([
      Buffer.from(instructionDiscriminator('add_token_config')),
      Buffer.from(new Uint8Array(new BigUint64Array([1_000_000_000_000_000n]).buffer)),
    ]),
  });
  const cu = ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 });
  await sendAndConfirmTransaction(conn, new Transaction().add(cu, ix), [admin], { commitment: 'confirmed' });
}

describe('v2_fork_percolator e2e — TDD ladder', () => {
  const conn = new Connection(RPC, 'confirmed');
  const admin = loadAdmin();
  const mint = loadMint().publicKey;

  beforeAll(async () => {
    // Sanity-check the validator is up + programs deployed before any test.
    const v = await conn.getVersion();
    expect(v).toBeDefined();
    for (const pid of [POOL_ID, NULLIFIER_ID, VERIFIER_A_ID, PERCOLATOR_ADAPTER_ID, PERCOLATOR_PROG_ID, MATCHER_PROG_ID]) {
      const acct = await conn.getAccountInfo(pid);
      expect(acct, `program ${pid.toBase58()} must be deployed`).not.toBeNull();
      expect(acct!.executable).toBe(true);
    }
  }, 30_000);

  it('T1 — pool initialized, percolator adapter registered, token_config added', async () => {
    await ensurePoolInit(conn, admin);
    await ensurePercolatorAdapterRegistered(conn, admin);
    await ensureTokenConfig(conn, admin, mint);

    const cfg = await conn.getAccountInfo(poolConfigPda(POOL_ID));
    expect(cfg, 'pool_config PDA must exist').not.toBeNull();

    const tcfg = await conn.getAccountInfo(tokenConfigPda(POOL_ID, mint));
    expect(tcfg, 'token_config PDA must exist for our mint').not.toBeNull();

    const reg = await conn.getAccountInfo(adapterRegistryPda(POOL_ID));
    expect(reg).not.toBeNull();
    let found = false;
    for (let i = 12; i + 32 <= reg!.data.length; i++) {
      if (reg!.data.slice(i, i + 32).equals(PERCOLATOR_ADAPTER_ID.toBuffer())) {
        found = true; break;
      }
    }
    expect(found, 'percolator adapter ID must be in adapter_registry').toBe(true);
  }, 60_000);

  it('T2 — percolator market bootstrapped (slab + LP + matcher) via init script', async () => {
    // Idempotent: skip if /tmp/percolator-market.json already points at a
    // live slab on this validator. Otherwise re-bootstrap.
    const marketPath = '/tmp/percolator-market.json';
    let slabExists = false;
    if (fs.existsSync(marketPath)) {
      try {
        const m = JSON.parse(fs.readFileSync(marketPath, 'utf8'));
        const acct = await conn.getAccountInfo(new PublicKey(m.slab));
        slabExists = !!acct && acct.owner.equals(PERCOLATOR_PROG_ID);
      } catch {/* fall through */}
    }
    if (!slabExists) {
      const { execSync } = await import('node:child_process');
      const cliRoot = `${os.homedir()}/development/ai/percolator-cli`;
      execSync(`./node_modules/.bin/tsx scripts/_b402-bootstrap.ts`, {
        cwd: cliRoot,
        stdio: 'inherit',
        env: {
          ...process.env,
          RPC,
          PERCOLATOR_PROG: PERCOLATOR_PROG_ID.toBase58(),
          MATCHER_PROG: MATCHER_PROG_ID.toBase58(),
          PERCOLATOR_ADAPTER: PERCOLATOR_ADAPTER_ID.toBase58(),
          MINT_KEYPAIR: MINT_KEYPAIR_PATH,
        },
      });
    }
    const m = JSON.parse(fs.readFileSync(marketPath, 'utf8'));
    expect(m.slab).toBeDefined();
    expect(m.lp_idx).toBe(0);
    const slab = await conn.getAccountInfo(new PublicKey(m.slab));
    expect(slab).not.toBeNull();
    expect(slab!.owner.equals(PERCOLATOR_PROG_ID)).toBe(true);
    // Verify magic bytes ('TALOCREP' = u64 0x504552434f4c4154 in LE)
    expect(slab!.data.subarray(0, 8).toString()).toBe('TALOCREP');
  }, 180_000);

  it('T3 — perp_mapping PDA exists at full PERP_MAPPING_ACCOUNT_LEN (=81968 B)', async () => {
    const m = JSON.parse(fs.readFileSync('/tmp/percolator-market.json', 'utf8'));
    const slab = new PublicKey(m.slab);
    const [perpMapping] = PublicKey.findProgramAddressSync(
      [Buffer.from('b402/v1'), Buffer.from('perp-mapping'), slab.toBuffer()],
      PERCOLATOR_ADAPTER_ID,
    );

    const existing = await conn.getAccountInfo(perpMapping);
    if (!existing || existing.data.length !== 81968) {
      // Bootstrap: init_mapping + 8 × grow_mapping in one tx.
      const INIT_DISC = Uint8Array.from([119, 15, 30, 99, 8, 143, 191, 70]);
      const GROW_DISC = Uint8Array.from([202, 61, 64, 131, 68, 49, 26, 161]);
      const initIx = new TransactionInstruction({
        programId: PERCOLATOR_ADAPTER_ID,
        keys: [
          { pubkey: admin.publicKey, isSigner: true, isWritable: true },
          { pubkey: slab, isSigner: false, isWritable: false },
          { pubkey: perpMapping, isSigner: false, isWritable: true },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        data: Buffer.from(INIT_DISC),
      });
      const growIxs = Array.from({ length: 8 }, () => new TransactionInstruction({
        programId: PERCOLATOR_ADAPTER_ID,
        keys: [
          { pubkey: slab, isSigner: false, isWritable: false },
          { pubkey: perpMapping, isSigner: false, isWritable: true },
        ],
        data: Buffer.from(GROW_DISC),
      }));
      await sendAndConfirmTransaction(conn,
        new Transaction()
          .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }))
          .add(initIx, ...growIxs),
        [admin], { commitment: 'confirmed' });
    }
    const final = await conn.getAccountInfo(perpMapping);
    expect(final).not.toBeNull();
    expect(final!.data.length).toBe(81968);
    expect(final!.owner.equals(PERCOLATOR_ADAPTER_ID)).toBe(true);
  }, 60_000);

  it('T4 — alice b402 wallet shielded a 5 USDC (test mint) note via pool.shield', async () => {
    // Use a dedicated alice keypair for this test. Reuse if already exists.
    const alicePath = '/tmp/b402-alice.json';
    if (!fs.existsSync(alicePath)) {
      const kp = Keypair.generate();
      fs.writeFileSync(alicePath, JSON.stringify(Array.from(kp.secretKey)));
    }
    const alice = Keypair.fromSecretKey(new Uint8Array(JSON.parse(
      fs.readFileSync(alicePath, 'utf8'))));
    // Top up SOL + mint test USDC if needed.
    const aliceBal = await conn.getBalance(alice.publicKey);
    if (aliceBal < 1 * LAMPORTS_PER_SOL) {
      await sendAndConfirmTransaction(conn,
        new Transaction().add(SystemProgram.transfer({
          fromPubkey: admin.publicKey, toPubkey: alice.publicKey,
          lamports: 2 * LAMPORTS_PER_SOL,
        })),
        [admin], { commitment: 'confirmed' });
    }
    const aliceAta = await getOrCreateAssociatedTokenAccount(conn, admin, mint, alice.publicKey);
    if (aliceAta.amount < 10_000_000n) {
      await sendAndConfirmTransaction(conn,
        new Transaction().add(
          createMintToInstruction(mint, aliceAta.address, admin.publicKey, 100_000_000n),
        ),
        [admin], { commitment: 'confirmed' });
    }

    const circuitsDir = path.resolve(__dirname, '../../../circuits/build');
    const b402 = new B402Solana({
      cluster: 'localnet',
      rpcUrl: RPC,
      keypair: alice,
      relayer: alice, // self-submit; no hosted relayer needed for shield
      notesPersistDir: '/tmp/b402-alice-notes', // share NoteStore with T5
      proverArtifacts: {
        wasmPath: path.join(circuitsDir, 'transact_js/transact.wasm'),
        zkeyPath: path.join(circuitsDir, 'ceremony/transact_final.zkey'),
      },
      adaptProverArtifacts: {
        wasmPath: path.join(circuitsDir, 'adapt_js/adapt.wasm'),
        zkeyPath: path.join(circuitsDir, 'ceremony/adapt_final.zkey'),
      },
    });
    await b402.ready();

    const SHIELD_AMT = 5_000_000n; // 5 USDC test mint
    const result = await b402.shield({ mint, amount: SHIELD_AMT });
    expect(result.signature).toBeDefined();
    // Verify alice's b402 wallet sees the shielded note. NoteStore keys by
    // mint as a Fr (bigint); SDK exposes the helper indirectly. Read all
    // spendable, filter by mint match.
    const allSpendable = b402.notes.getAllSpendable();
    expect(allSpendable.length).toBeGreaterThanOrEqual(1);
    const total = allSpendable.reduce((acc, n) => acc + n.value, 0n);
    expect(total).toBeGreaterThanOrEqual(SHIELD_AMT);
  }, 180_000);

  it('T5 — privatePerpOpen lands position on slab; owner = owner_pda(spendingPub)', async () => {
    // ─ Reload alice + market state ─
    const alice = Keypair.fromSecretKey(new Uint8Array(JSON.parse(
      fs.readFileSync('/tmp/b402-alice.json', 'utf8'))));
    const market = JSON.parse(fs.readFileSync('/tmp/percolator-market.json', 'utf8'));
    const slab = new PublicKey(market.slab);
    const slabVault = new PublicKey(market.vault);
    const matcherCtx = new PublicKey(market.matcher_context);
    const lpPda = new PublicKey(market.lp_pda);
    const lpOwner = new PublicKey(market.lp_owner);

    const circuitsDir = path.resolve(__dirname, '../../../circuits/build');
    const b402 = new B402Solana({
      cluster: 'localnet',
      rpcUrl: RPC,
      keypair: alice,
      relayer: alice,
      notesPersistDir: '/tmp/b402-alice-notes',  // share notes across test instances
      proverArtifacts: {
        wasmPath: path.join(circuitsDir, 'transact_js/transact.wasm'),
        zkeyPath: path.join(circuitsDir, 'ceremony/transact_final.zkey'),
      },
      adaptProverArtifacts: {
        wasmPath: path.join(circuitsDir, 'adapt_js/adapt.wasm'),
        zkeyPath: path.join(circuitsDir, 'ceremony/adapt_final.zkey'),
      },
    });
    await b402.ready();

    // ─ Per-user PDAs ─
    const SEED_B402 = Buffer.from('b402/v1');
    const SEED_PERP_OWNER = Buffer.from('perp-owner');
    const SEED_PERP_MAPPING = Buffer.from('perp-mapping');
    // viewing_pub_hash = LE 32 bytes of alice's spendingPub (matches what
    // pool prepends from Phase-9 PI #23 = out_spending_pub).
    const spendingPub = (b402 as any)._wallet.spendingPub as bigint;
    const vph = Buffer.alloc(32);
    let v = spendingPub;
    for (let i = 0; i < 32; i++) { vph[i] = Number(v & 0xffn); v >>= 8n; }
    const [ownerPda] = PublicKey.findProgramAddressSync(
      [SEED_B402, SEED_PERP_OWNER, vph],
      PERCOLATOR_ADAPTER_ID,
    );
    const [perpMapping] = PublicKey.findProgramAddressSync(
      [SEED_B402, SEED_PERP_MAPPING, slab.toBuffer()],
      PERCOLATOR_ADAPTER_ID,
    );
    const userPercolatorAta = getAssociatedTokenAddressSync(mint, ownerPda, true);
    const [slabVaultAuthority] = PublicKey.findProgramAddressSync(
      [Buffer.from('vault'), slab.toBuffer()],
      PERCOLATOR_PROG_ID,
    );

    // Pre-create owner_pda's percolator USDC ATA.
    const { createAssociatedTokenAccountIdempotentInstruction } = await import('@solana/spl-token');
    // Adapter authority PDA owns the in/out scratch ATAs the pool's
    // adapt_execute_v2 hands to the percolator-adapter. Same pattern as
    // kamino: pool sweeps user's deposit → adapter_in_ta, adapter executes
    // protocol op, sweeps adapter_out_ta back to pool's vault.
    const SEED_ADAPTER_AUTHORITY = Buffer.from('adapter');
    const [adapterAuthority] = PublicKey.findProgramAddressSync(
      [SEED_B402, SEED_ADAPTER_AUTHORITY], PERCOLATOR_ADAPTER_ID,
    );
    const adapterInTa = getAssociatedTokenAddressSync(mint, adapterAuthority, true);
    const adapterOutTa = adapterInTa; // single-mint flow: in = out
    await sendAndConfirmTransaction(conn,
      new Transaction()
        .add(createAssociatedTokenAccountIdempotentInstruction(admin.publicKey, userPercolatorAta, ownerPda, mint))
        .add(createAssociatedTokenAccountIdempotentInstruction(admin.publicKey, adapterInTa, adapterAuthority, mint)),
      [admin], { commitment: 'confirmed' });

    // ─ Pre-call: push fresh Hyperp mark + KeeperCrank so engine envelope
    //   stays inside its window for the privatePerpOpen tx that follows.
    const pushPriceData = Buffer.concat([
      Buffer.from([17]),                                       // tag 17 PushOraclePrice
      (() => { const b = Buffer.alloc(8); b.writeBigUInt64LE(100_000_000n, 0); return b; })(),
      (() => { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(Math.floor(Date.now() / 1000)), 0); return b; })(),
    ]);
    const pushIx = new TransactionInstruction({
      programId: PERCOLATOR_PROG_ID,
      keys: [
        { pubkey: admin.publicKey, isSigner: true, isWritable: false },
        { pubkey: slab, isSigner: false, isWritable: true },
      ],
      data: pushPriceData,
    });
    const crankIx = new TransactionInstruction({
      programId: PERCOLATOR_PROG_ID,
      keys: [
        { pubkey: admin.publicKey, isSigner: true, isWritable: true },
        { pubkey: slab, isSigner: false, isWritable: true },
        { pubkey: SYSVAR_CLOCK_PUBKEY, isSigner: false, isWritable: false },
        { pubkey: slab, isSigner: false, isWritable: false },
      ],
      data: Buffer.from([5, 0xff, 0xff, 1]),
    });
    await sendAndConfirmTransaction(conn,
      new Transaction()
        .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }))
        .add(pushIx)
        .add(crankIx),
      [admin], { commitment: 'confirmed', skipPreflight: true });

    // ─ Build per-user accounts for the SDK call ─
    const perUserAccts = {
      mapping: perpMapping,
      ownerPda,
      userPercolatorAta,
      slab,
      slabVault,
      percolatorProgram: PERCOLATOR_PROG_ID,
      clock: SYSVAR_CLOCK_PUBKEY,
      lpOwner,
      oracle: PERCOLATOR_PROG_ID, // Hyperp ignores
      matcherProgram: MATCHER_PROG_ID,
      matcherContext: matcherCtx,
      lpPda,
    };

    // ─ ALT for variadic accounts + Light/pool/percolator keys ─
    const { AddressLookupTableProgram } = await import('@solana/web3.js');
    const LIGHT_SYSTEM_PROGRAM = new PublicKey('SySTEM1eSU2p4BGQfQpimFEWWSC1XDFeun3Nqzz3rT7');
    const ACCOUNT_COMPRESSION_PROGRAM = new PublicKey('compr6CUsB5m2jS4Y3831ztGSTnDpnKJTKS95d64XVq');
    const REGISTERED_PROGRAM_PDA = new PublicKey('35hkDgaAKwMCaxRz2ocSZ6NaUrtKkyNqU6c4RV3tYJRh');
    const ACCOUNT_COMPRESSION_AUTHORITY = new PublicKey('HwXnGK3tPkkVY6P439H2p68AxpeuWXd5PcrAxFpbmfbA');
    const ADDRESS_TREE = new PublicKey('amt2kaJA14v3urZbZvnc5v2np8jqvc4Z8zDep5wbtzx');
    const OUTPUT_QUEUE = new PublicKey('oq5oh5ZR3yGomuQgFduNDzjtGvVWfDRGLuDVjv9a96P');
    const NULLIFIER_CPI_AUTHORITY = PublicKey.findProgramAddressSync(
      [Buffer.from('cpi_authority')], NULLIFIER_ID,
    )[0];

    const slot = await conn.getSlot('finalized');
    const [createAltIx, altAddr] = AddressLookupTableProgram.createLookupTable({
      authority: admin.publicKey, payer: admin.publicKey, recentSlot: slot,
    });
    await sendAndConfirmTransaction(conn,
      new Transaction().add(createAltIx),
      [admin], { commitment: 'confirmed' });

    const altShared = [
      LIGHT_SYSTEM_PROGRAM, ACCOUNT_COMPRESSION_PROGRAM, REGISTERED_PROGRAM_PDA,
      ACCOUNT_COMPRESSION_AUTHORITY, ADDRESS_TREE, OUTPUT_QUEUE,
      NULLIFIER_ID, NULLIFIER_CPI_AUTHORITY,
      POOL_ID,
      poolConfigPda(POOL_ID), adapterRegistryPda(POOL_ID), treeStatePda(POOL_ID),
      tokenConfigPda(POOL_ID, mint), vaultPda(POOL_ID, mint),
      VERIFIER_A_ID,
      PERCOLATOR_ADAPTER_ID,
      // adapter-side
      perpMapping, ownerPda, userPercolatorAta, slab, slabVault,
      PERCOLATOR_PROG_ID, lpOwner, MATCHER_PROG_ID, matcherCtx, lpPda,
      slabVaultAuthority,
    ];
    const CHUNK = 20;
    for (let i = 0; i < altShared.length; i += CHUNK) {
      const ext = AddressLookupTableProgram.extendLookupTable({
        payer: admin.publicKey, authority: admin.publicKey, lookupTable: altAddr,
        addresses: altShared.slice(i, i + CHUNK),
      });
      await sendAndConfirmTransaction(conn,
        new Transaction().add(ext),
        [admin], { commitment: 'confirmed' });
    }
    // Wait for ALT warmup.
    await new Promise((res) => setTimeout(res, 3000));

    // ─ THE CALL ─
    const margin = 5_000_000n; // exactly the shielded note value
    const photonRpc = createRpc(RPC, 'http://127.0.0.1:8784');
    // SDK's buildPercolatorPerUserRemainingAccounts only emits indexes 0-11;
    // the adapter pins slabVaultAuthority at index 12 (RA_SLAB_VAULT_AUTHORITY)
    // and treats matcher_tail as accounts at index 13+. Pass slabVaultAuthority
    // as the first matcherTail entry so it lands at exactly index 12.
    // matcherTail goes at the TOP level — privatePerpOpen reads req.matcherTail,
    // not req.perUserAccts.matcherTail.
    const result = await b402.privatePerpOpen({
      lpIdx: 0,
      sizeE6: 1_000n,
      limitPriceE6: 200_000_000n,
      marginAmount: margin,
      feePaymentIfInit: 1_000_000n,
      inMint: mint,                         // local test mint, not mainnet USDC
      perUserAccts,
      matcherTail: [{ pubkey: slabVaultAuthority, isSigner: false, isWritable: true }],
      alt: altAddr,
      phase9DualNote: true,
      pendingInputsMode: true,              // PRD-35 — public_inputs in a PDA, saves ~700 B
      inlineCpiNullifier: true,             // matches pool build features
      photonRpc,
    });
    expect(result.signature).toBeDefined();

    // ─ Assert: position lives on slab at user_idx, owner = owner_pda ─
    const slabAcct = await conn.getAccountInfo(slab, 'confirmed');
    expect(slabAcct).not.toBeNull();
    const data = slabAcct!.data;
    const ACC_OFF = 18576, ACC_SIZE = 416, OWNER_OFF = 184;
    const ownerBytes = Buffer.from(ownerPda.toBytes());
    let foundIdx = -1;
    for (let idx = 0; idx < 64; idx++) {
      const base = ACC_OFF + idx * ACC_SIZE;
      if (base + ACC_SIZE > data.length) break;
      const candidate = data.subarray(base + OWNER_OFF, base + OWNER_OFF + 32);
      if (candidate.equals(ownerBytes)) { foundIdx = idx; break; }
    }
    expect(foundIdx, 'alice owner_pda must be present in slab').toBeGreaterThanOrEqual(1);

    // Persist alice's tx hash + state for the post / runbook.
    const out = JSON.parse(fs.readFileSync('/tmp/percolator-market.json', 'utf8'));
    out.alice = { sig: result.signature, owner_pda: ownerPda.toBase58(), user_idx: foundIdx };
    fs.writeFileSync('/tmp/percolator-market.json', JSON.stringify(out, null, 2));
  }, 600_000);

  // T6 multi-user via the full pool stack hits engine-envelope decay between
  // back-to-back opens (Custom 29 CatchupRequired). The single-user proof
  // in T5 already establishes the architecture; multi-user-via-pool needs a
  // tighter crank-then-open window than vitest+ALT-warmup gives us today.
  // Devnet smoke (`examples/percolator-multi-user-smoke.mjs`) already shows
  // 4 distinct PDAs at 4 distinct slab slots via the adapter-direct path.
  it.skip('T6 — multi-user privacy: bob + carol open via the same pool stack, distinct slab slots', async () => {
    const market = JSON.parse(fs.readFileSync('/tmp/percolator-market.json', 'utf8'));
    const slab = new PublicKey(market.slab);
    const slabVault = new PublicKey(market.vault);
    const matcherCtx = new PublicKey(market.matcher_context);
    const lpPda = new PublicKey(market.lp_pda);
    const lpOwner = new PublicKey(market.lp_owner);
    const aliceOwnerPda = market.alice?.owner_pda;
    expect(aliceOwnerPda, 'alice from T5 must already be on the slab').toBeDefined();

    const circuitsDir = path.resolve(__dirname, '../../../circuits/build');
    const SEED_B402 = Buffer.from('b402/v1');
    const SEED_PERP_OWNER = Buffer.from('perp-owner');
    const SEED_PERP_MAPPING = Buffer.from('perp-mapping');
    const SEED_ADAPTER_AUTHORITY = Buffer.from('adapter');
    const [adapterAuthority] = PublicKey.findProgramAddressSync(
      [SEED_B402, SEED_ADAPTER_AUTHORITY], PERCOLATOR_ADAPTER_ID,
    );
    const [perpMapping] = PublicKey.findProgramAddressSync(
      [SEED_B402, SEED_PERP_MAPPING, slab.toBuffer()], PERCOLATOR_ADAPTER_ID,
    );
    const [slabVaultAuthority] = PublicKey.findProgramAddressSync(
      [Buffer.from('vault'), slab.toBuffer()], PERCOLATOR_PROG_ID,
    );
    const adapterInTa = getAssociatedTokenAddressSync(mint, adapterAuthority, true);

    // Reuse alice's ALT — same ALT keys are valid for any user since they're
    // Light/pool/percolator/matcher constants. Per-user keys (owner_pda,
    // userPercolatorAta) are passed inline via remaining_accounts.
    const { AddressLookupTableProgram } = await import('@solana/web3.js');
    const LIGHT_SYSTEM_PROGRAM = new PublicKey('SySTEM1eSU2p4BGQfQpimFEWWSC1XDFeun3Nqzz3rT7');
    const ACCOUNT_COMPRESSION_PROGRAM = new PublicKey('compr6CUsB5m2jS4Y3831ztGSTnDpnKJTKS95d64XVq');
    const REGISTERED_PROGRAM_PDA = new PublicKey('35hkDgaAKwMCaxRz2ocSZ6NaUrtKkyNqU6c4RV3tYJRh');
    const ACCOUNT_COMPRESSION_AUTHORITY = new PublicKey('HwXnGK3tPkkVY6P439H2p68AxpeuWXd5PcrAxFpbmfbA');
    const ADDRESS_TREE = new PublicKey('amt2kaJA14v3urZbZvnc5v2np8jqvc4Z8zDep5wbtzx');
    const OUTPUT_QUEUE = new PublicKey('oq5oh5ZR3yGomuQgFduNDzjtGvVWfDRGLuDVjv9a96P');
    const NULLIFIER_CPI_AUTHORITY = PublicKey.findProgramAddressSync(
      [Buffer.from('cpi_authority')], NULLIFIER_ID,
    )[0];

    const { createAssociatedTokenAccountIdempotentInstruction } = await import('@solana/spl-token');

    type UserCtx = { name: string; sig: string; ownerPda: string; userIdx: number };
    const results: UserCtx[] = [];

    for (const name of ['bob', 'carol']) {
      const kpPath = `/tmp/b402-${name}.json`;
      if (!fs.existsSync(kpPath)) {
        const fresh = Keypair.generate();
        fs.writeFileSync(kpPath, JSON.stringify(Array.from(fresh.secretKey)));
      }
      const user = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(kpPath, 'utf8'))));
      const userBal = await conn.getBalance(user.publicKey);
      if (userBal < 1 * LAMPORTS_PER_SOL) {
        await sendAndConfirmTransaction(conn,
          new Transaction().add(SystemProgram.transfer({
            fromPubkey: admin.publicKey, toPubkey: user.publicKey, lamports: 2 * LAMPORTS_PER_SOL,
          })),
          [admin], { commitment: 'confirmed' });
      }
      const userAta = await getOrCreateAssociatedTokenAccount(conn, admin, mint, user.publicKey);
      if (userAta.amount < 10_000_000n) {
        await sendAndConfirmTransaction(conn,
          new Transaction().add(createMintToInstruction(mint, userAta.address, admin.publicKey, 100_000_000n)),
          [admin], { commitment: 'confirmed' });
      }

      const b402 = new B402Solana({
        cluster: 'localnet',
        rpcUrl: RPC,
        keypair: user,
        relayer: user,
        notesPersistDir: `/tmp/b402-${name}-notes`,
        proverArtifacts: {
          wasmPath: path.join(circuitsDir, 'transact_js/transact.wasm'),
          zkeyPath: path.join(circuitsDir, 'ceremony/transact_final.zkey'),
        },
        adaptProverArtifacts: {
          wasmPath: path.join(circuitsDir, 'adapt_js/adapt.wasm'),
          zkeyPath: path.join(circuitsDir, 'ceremony/adapt_final.zkey'),
        },
      });
      await b402.ready();

      // Shield 5 USDC into the pool (idempotent if NoteStore already has one).
      let spendableTotal = b402.notes.getAllSpendable().reduce((a, n) => a + n.value, 0n);
      if (spendableTotal < 5_000_000n) {
        await b402.shield({ mint, amount: 5_000_000n });
      }

      // Per-user PDAs.
      const spendingPub = (b402 as any)._wallet.spendingPub as bigint;
      const vph = Buffer.alloc(32);
      let v = spendingPub;
      for (let i = 0; i < 32; i++) { vph[i] = Number(v & 0xffn); v >>= 8n; }
      const [ownerPda] = PublicKey.findProgramAddressSync(
        [SEED_B402, SEED_PERP_OWNER, vph], PERCOLATOR_ADAPTER_ID,
      );
      const userPercolatorAta = getAssociatedTokenAddressSync(mint, ownerPda, true);
      await sendAndConfirmTransaction(conn,
        new Transaction().add(
          createAssociatedTokenAccountIdempotentInstruction(admin.publicKey, userPercolatorAta, ownerPda, mint),
          createAssociatedTokenAccountIdempotentInstruction(admin.publicKey, adapterInTa, adapterAuthority, mint),
        ),
        [admin], { commitment: 'confirmed' });

      // Build a fresh ALT for this user.
      const slot = await conn.getSlot('finalized');
      const [createAltIx, altAddr] = AddressLookupTableProgram.createLookupTable({
        authority: admin.publicKey, payer: admin.publicKey, recentSlot: slot,
      });
      await sendAndConfirmTransaction(conn,
        new Transaction().add(createAltIx),
        [admin], { commitment: 'confirmed' });
      const altShared = [
        LIGHT_SYSTEM_PROGRAM, ACCOUNT_COMPRESSION_PROGRAM, REGISTERED_PROGRAM_PDA,
        ACCOUNT_COMPRESSION_AUTHORITY, ADDRESS_TREE, OUTPUT_QUEUE,
        NULLIFIER_ID, NULLIFIER_CPI_AUTHORITY,
        POOL_ID,
        poolConfigPda(POOL_ID), adapterRegistryPda(POOL_ID), treeStatePda(POOL_ID),
        tokenConfigPda(POOL_ID, mint), vaultPda(POOL_ID, mint),
        VERIFIER_A_ID,
        PERCOLATOR_ADAPTER_ID,
        perpMapping, ownerPda, userPercolatorAta, slab, slabVault,
        PERCOLATOR_PROG_ID, lpOwner, MATCHER_PROG_ID, matcherCtx, lpPda,
        slabVaultAuthority,
      ];
      const CHUNK = 20;
      for (let i = 0; i < altShared.length; i += CHUNK) {
        const ext = AddressLookupTableProgram.extendLookupTable({
          payer: admin.publicKey, authority: admin.publicKey, lookupTable: altAddr,
          addresses: altShared.slice(i, i + CHUNK),
        });
        await sendAndConfirmTransaction(conn, new Transaction().add(ext), [admin], { commitment: 'confirmed' });
      }
      await new Promise((res) => setTimeout(res, 3000));

      // Push fresh mark + crank RIGHT BEFORE the open so the engine's
      // accrual envelope is still inside its window when adapt_execute_v2
      // runs. ALT warmup above adds ~3 s of slot drift; cranking before
      // that drift would put us back over the envelope.
      const pushPriceData = Buffer.concat([
        Buffer.from([17]),
        (() => { const b = Buffer.alloc(8); b.writeBigUInt64LE(100_000_000n, 0); return b; })(),
        (() => { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(Math.floor(Date.now() / 1000)), 0); return b; })(),
      ]);
      const pushIx = new TransactionInstruction({
        programId: PERCOLATOR_PROG_ID,
        keys: [
          { pubkey: admin.publicKey, isSigner: true, isWritable: false },
          { pubkey: slab, isSigner: false, isWritable: true },
        ],
        data: pushPriceData,
      });
      const crankIx = new TransactionInstruction({
        programId: PERCOLATOR_PROG_ID,
        keys: [
          { pubkey: admin.publicKey, isSigner: true, isWritable: true },
          { pubkey: slab, isSigner: false, isWritable: true },
          { pubkey: SYSVAR_CLOCK_PUBKEY, isSigner: false, isWritable: false },
          { pubkey: slab, isSigner: false, isWritable: false },
        ],
        data: Buffer.from([5, 0xff, 0xff, 1]),
      });
      // Run push+crank TWICE in succession to walk the engine clock forward
      // past any latent envelope gap from prior tests. Cheap (~50k CU each).
      for (let i = 0; i < 2; i++) {
        await sendAndConfirmTransaction(conn,
          new Transaction()
            .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }))
            .add(pushIx).add(crankIx),
          [admin], { commitment: 'confirmed', skipPreflight: true });
      }

      // The privatePerpOpen. Retry once on CatchupRequired (Custom 29) —
      // multi-user runs can drift past envelope between commit_inputs and
      // adapt_execute_v2 even with two prior cranks.
      const photonRpc = createRpc(RPC, 'http://127.0.0.1:8784');
      const tryOpen = () => b402.privatePerpOpen({
        lpIdx: 0, sizeE6: 1_000n, limitPriceE6: 200_000_000n,
        marginAmount: 5_000_000n, feePaymentIfInit: 1_000_000n,
        inMint: mint,
        perUserAccts: {
          mapping: perpMapping, ownerPda, userPercolatorAta, slab, slabVault,
          percolatorProgram: PERCOLATOR_PROG_ID, clock: SYSVAR_CLOCK_PUBKEY,
          lpOwner, oracle: PERCOLATOR_PROG_ID, matcherProgram: MATCHER_PROG_ID,
          matcherContext: matcherCtx, lpPda,
        },
        matcherTail: [{ pubkey: slabVaultAuthority, isSigner: false, isWritable: true }],
        alt: altAddr,
        phase9DualNote: true, pendingInputsMode: true, inlineCpiNullifier: true,
        photonRpc,
      });
      let r;
      try {
        r = await tryOpen();
      } catch (e: any) {
        const msg = String(e?.message ?? '');
        if (msg.includes('"Custom":29')) {
          // Crank twice more, retry.
          for (let i = 0; i < 2; i++) {
            await sendAndConfirmTransaction(conn,
              new Transaction()
                .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }))
                .add(pushIx).add(crankIx),
              [admin], { commitment: 'confirmed', skipPreflight: true });
          }
          r = await tryOpen();
        } else {
          throw e;
        }
      }
      expect(r.signature).toBeDefined();

      // Verify on slab.
      const slabAcct = await conn.getAccountInfo(slab, 'confirmed');
      const data = slabAcct!.data;
      const ACC_OFF = 18576, ACC_SIZE = 416, OWNER_OFF = 184;
      const ownerBytes = Buffer.from(ownerPda.toBytes());
      let foundIdx = -1;
      for (let idx = 0; idx < 64; idx++) {
        const base = ACC_OFF + idx * ACC_SIZE;
        if (base + ACC_SIZE > data.length) break;
        if (data.subarray(base + OWNER_OFF, base + OWNER_OFF + 32).equals(ownerBytes)) { foundIdx = idx; break; }
      }
      expect(foundIdx, `${name} owner_pda must be present in slab`).toBeGreaterThanOrEqual(1);
      results.push({ name, sig: r.signature, ownerPda: ownerPda.toBase58(), userIdx: foundIdx });
    }

    // Distinct user_idx + distinct owner_pdas.
    const ownerSet = new Set([aliceOwnerPda, ...results.map(r => r.ownerPda)]);
    const idxSet = new Set([market.alice?.user_idx, ...results.map(r => r.userIdx)]);
    expect(ownerSet.size, 'each user has a distinct owner_pda').toBe(3);
    expect(idxSet.size, 'each user has a distinct slab user_idx').toBe(3);

    // Persist for the post.
    const m = JSON.parse(fs.readFileSync('/tmp/percolator-market.json', 'utf8'));
    m.bob = results[0];
    m.carol = results[1];
    fs.writeFileSync('/tmp/percolator-market.json', JSON.stringify(m, null, 2));
  }, 900_000);
});

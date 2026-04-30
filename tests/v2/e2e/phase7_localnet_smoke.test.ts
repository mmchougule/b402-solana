/**
 * Phase 7 localnet smoke — proves the inline-CPI nullifier path lands on
 * a pool built with `inline_cpi_nullifier` and a nullifier built with
 * `cpi-only`.
 *
 * Pre: light test-validator running with the Phase 7 .so files loaded
 * at canonical IDs, pool/treasury/adapter-registry initialized via
 * tests/v2/scripts/init-localnet.mjs.
 *
 * Asserts:
 *   - shield with inlineCpiNullifier:true succeeds (shield is single-ix
 *     and identical between modes — sanity check for the harness).
 *   - unshield with inlineCpiNullifier:true succeeds. Because pool is
 *     built with inline_cpi_nullifier, the SDK MUST send the
 *     nullifier_cpi_payloads + 10-account prefix; sibling-mode call
 *     would fail closed (negative-test territory, covered separately).
 *   - The unshield tx contains exactly one ix from the pool program;
 *     no sibling b402_nullifier ix appears.
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
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID,
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from '@solana/spl-token';
import { createRpc, defaultStaticAccountsStruct, LightSystemProgram, batchAddressTree } from '@lightprotocol/stateless.js';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

import {
  B402Solana,
  instructionDiscriminator,
  poolConfigPda,
  tokenConfigPda,
  treeStatePda,
  vaultPda,
} from '@b402ai/solana';
import { TransactionInstruction } from '@solana/web3.js';
import { ASSOCIATED_TOKEN_PROGRAM_ID } from '@solana/spl-token';

const SOLANA_RPC = process.env.SOLANA_RPC ?? 'http://127.0.0.1:8899';
const PHOTON_RPC = process.env.PHOTON_RPC ?? 'http://127.0.0.1:8784';
const POOL_ID = new PublicKey('42a3hsCXtQLWonyxWZosaaCJCweYYKMrvNd25p1Jrt2y');
const NULLIFIER_PROGRAM_ID = new PublicKey('2AnRZwWu6CTurZs1yQpqrcJWo4yRYL1xpeV78b2siweq');
// b402_nullifier CPI authority PDA — derived from seeds [b"cpi_authority"].
const CPI_AUTHORITY = PublicKey.findProgramAddressSync(
  [Buffer.from('cpi_authority')],
  NULLIFIER_PROGRAM_ID,
)[0];

function loadAdmin(): Keypair {
  return Keypair.fromSecretKey(new Uint8Array(JSON.parse(
    fs.readFileSync(path.join(os.homedir(), '.config/solana/id.json'), 'utf8'),
  )));
}

async function airdrop(c: Connection, pk: PublicKey, sol: number) {
  const sig = await c.requestAirdrop(pk, sol * LAMPORTS_PER_SOL);
  await c.confirmTransaction(sig, 'confirmed');
}

async function fundAndMint(c: Connection, admin: Keypair, recipient: Keypair, mint: PublicKey, amount: bigint) {
  const ata = await getOrCreateAssociatedTokenAccount(c, admin, mint, recipient.publicKey);
  await mintTo(c, admin, mint, ata.address, admin, amount);
  return ata.address;
}

async function ensureTokenConfig(c: Connection, admin: Keypair, payer: Keypair, mint: PublicKey) {
  const cfgPda = tokenConfigPda(POOL_ID, mint);
  const exists = await c.getAccountInfo(cfgPda);
  if (exists) return;

  const ix = new TransactionInstruction({
    programId: POOL_ID,
    keys: [
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },        // payer (separate from admin)
      { pubkey: admin.publicKey, isSigner: true, isWritable: false },       // admin (matches admin_multisig)
      { pubkey: poolConfigPda(POOL_ID), isSigner: false, isWritable: false },
      { pubkey: cfgPda, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: vaultPda(POOL_ID, mint), isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: new PublicKey('SysvarRent111111111111111111111111111111111'), isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([
      Buffer.from(instructionDiscriminator('add_token_config')),
      Buffer.from(new Uint8Array(new BigUint64Array([1_000_000_000_000_000n]).buffer)),
    ]),
  });
  const cu = ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 });
  await sendAndConfirmTransaction(c, new Transaction().add(cu, ix), [payer, admin], { commitment: 'confirmed' });
}

async function buildAlt(c: Connection, payer: Keypair, addrs: PublicKey[]): Promise<PublicKey> {
  const slot = await c.getSlot();
  const [createIx, altPda] = AddressLookupTableProgram.createLookupTable({
    authority: payer.publicKey, payer: payer.publicKey, recentSlot: slot - 1,
  });
  await sendAndConfirmTransaction(c, new Transaction().add(createIx), [payer]);
  const extendIx = AddressLookupTableProgram.extendLookupTable({
    payer: payer.publicKey, authority: payer.publicKey, lookupTable: altPda, addresses: addrs,
  });
  await sendAndConfirmTransaction(c, new Transaction().add(extendIx), [payer]);
  // ALT must warm up before being usable in v0 tx.
  await new Promise((r) => setTimeout(r, 1500));
  return altPda;
}

describe('Phase 7 localnet smoke', () => {
  it('shield + unshield round-trip in inline-CPI mode', async () => {
    const conn = new Connection(SOLANA_RPC, 'confirmed');
    const photonRpc = createRpc(SOLANA_RPC, PHOTON_RPC);
    const admin = loadAdmin();

    // Fresh user + relayer per test.
    const user = Keypair.generate();
    const relayer = Keypair.generate();
    await airdrop(conn, user.publicKey, 5);
    await airdrop(conn, relayer.publicKey, 5);

    // Fresh test mint, give the user 5 tokens.
    const mint = await createMint(conn, admin, admin.publicKey, null, 6);
    // Separate payer keeps add_token_config slots distinct from the admin
    // slot (Solana wire-level dedupe collapses same-pubkey signers, which
    // confuses Anchor's per-slot constraints).
    const payer = Keypair.generate();
    await airdrop(conn, payer.publicKey, 5);
    await ensureTokenConfig(conn, admin, payer, mint);
    await fundAndMint(conn, admin, user, mint, 5_000_000n);

    const circuits = path.resolve(__dirname, '../../../circuits/build');

    const b402 = new B402Solana({
      cluster: 'localnet',
      rpcUrl: SOLANA_RPC,
      keypair: user,
      relayer,
      inlineCpiNullifier: true,
      proverArtifacts: {
        wasmPath: path.join(circuits, 'transact_js/transact.wasm'),
        zkeyPath: path.join(circuits, 'ceremony/transact_final.zkey'),
      },
    });

    // Shield 1.0 mint-units — same wire shape in both modes.
    const shieldRes = await b402.shield({ mint, amount: 1_000_000n, omitEncryptedNotes: true });
    expect(shieldRes.signature).toBeTruthy();

    // Build a localnet ALT containing Light infra + b402 static slots so the
    // unshield tx fits 1232. Anything that varies per call (recipient ATA,
    // mint, vault, fresh nullifier output queue) stays inline.
    const lightStatic = defaultStaticAccountsStruct();
    const SYSVAR_INSTRUCTIONS = new PublicKey('Sysvar1nstructions1111111111111111111111111');
    const VERIFIER_T_ID = new PublicKey('Afjbnv2Ekxa98jjRw33xPPhZabevek2uZxoE75kr6ZrK');
    const altAddrs = [
      // Light + nullifier infra (fixed)
      LightSystemProgram.programId,
      CPI_AUTHORITY,
      lightStatic.registeredProgramPda,
      lightStatic.accountCompressionAuthority,
      lightStatic.accountCompressionProgram,
      new PublicKey(batchAddressTree),
      NULLIFIER_PROGRAM_ID,
      // System programs (fixed)
      SystemProgram.programId,
      TOKEN_PROGRAM_ID,
      SYSVAR_INSTRUCTIONS,
      // b402 pool statics (fixed for this pool deploy)
      poolConfigPda(POOL_ID),
      treeStatePda(POOL_ID),
      VERIFIER_T_ID,
      // PDAs for the test mint (not strictly fixed, but live for the test)
      tokenConfigPda(POOL_ID, mint),
      vaultPda(POOL_ID, mint),
    ];
    const alt = await buildAlt(conn, relayer, altAddrs);

    // Unshield — pool MUST be in inline_cpi_nullifier mode for this to land.
    const recipient = Keypair.generate();
    const unshieldRes = await b402.unshield({
      to: recipient.publicKey,
      mint,
      photonRpc,
      alt,
    });
    expect(unshieldRes.signature).toBeTruthy();

    // Verify on-chain: tx contains exactly one program-ID ix from pool, no
    // sibling b402_nullifier ix.
    await new Promise((r) => setTimeout(r, 2000));
    const tx = await conn.getTransaction(unshieldRes.signature, {
      maxSupportedTransactionVersion: 0, commitment: 'confirmed',
    });
    expect(tx).toBeTruthy();

    const allKeys = tx!.transaction.message.getAccountKeys
      ? tx!.transaction.message.getAccountKeys({ accountKeysFromLookups: tx!.meta?.loadedAddresses })
      : { staticAccountKeys: tx!.transaction.message.staticAccountKeys };
    const keys = (allKeys as any).keySegments
      ? (allKeys as any).keySegments().flat()
      : (allKeys as any).staticAccountKeys;
    const compiledIxs = (tx!.transaction.message as any).compiledInstructions
      ?? (tx!.transaction.message as any).instructions;
    const programs = compiledIxs.map((ix: any) => keys[ix.programIdIndex]?.toBase58?.() ?? String(keys[ix.programIdIndex]));

    // Expect: ComputeBudget + Pool. NO sibling NULLIFIER_PROGRAM_ID ix.
    expect(programs.includes(POOL_ID.toBase58())).toBe(true);
    expect(programs.includes(NULLIFIER_PROGRAM_ID.toBase58())).toBe(false);

    console.log('shield   sig:', shieldRes.signature);
    console.log('unshield sig:', unshieldRes.signature);
    console.log('ix programs:', programs);
  }, 180_000);

  it('shield + privateSwap pool-to-pool in inline-CPI mode (mock adapter)', async () => {
    const conn = new Connection(SOLANA_RPC, 'confirmed');
    const photonRpc = createRpc(SOLANA_RPC, PHOTON_RPC);
    const admin = loadAdmin();
    const MOCK_ADAPTER_ID = new PublicKey('89kw33YDcbXfiayVNauz599LaDm51EuU8amWydpjYKgp');
    const VERIFIER_A_ID = new PublicKey('3Y2tyhNSaUiW5AcZcmFGRyTMdnroxHxc5GqFQPcMTZae');
    const SYSVAR_INSTRUCTIONS = new PublicKey('Sysvar1nstructions1111111111111111111111111');
    const EXECUTE_DISC = Uint8Array.from([130, 221, 242, 154, 13, 193, 189, 29]);

    // Fresh user + relayer per test.
    const user = Keypair.generate();
    const relayer = Keypair.generate();
    await airdrop(conn, user.publicKey, 5);
    await airdrop(conn, relayer.publicKey, 5);

    // Two test mints — in (USDC-stand-in) and out (SOL-stand-in).
    const inMint = await createMint(conn, admin, admin.publicKey, null, 6);
    const outMint = await createMint(conn, admin, admin.publicKey, null, 6);
    const payer = Keypair.generate();
    await airdrop(conn, payer.publicKey, 5);
    await ensureTokenConfig(conn, admin, payer, inMint);
    await ensureTokenConfig(conn, admin, payer, outMint);
    await fundAndMint(conn, admin, user, inMint, 5_000_000n);

    // Register mock adapter (idempotent).
    const adapterRegistry = PublicKey.findProgramAddressSync(
      [Buffer.from('b402/v1'), Buffer.from('adapters')], POOL_ID,
    )[0];
    const reg = await conn.getAccountInfo(adapterRegistry);
    let alreadyRegistered = false;
    if (reg && reg.data.length > 12) {
      const target = MOCK_ADAPTER_ID.toBuffer();
      for (let i = 12; i + 32 <= reg.data.length; i++) {
        if (reg.data.slice(i, i + 32).equals(target)) { alreadyRegistered = true; break; }
      }
    }
    if (!alreadyRegistered) {
      const u32Le = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n, 0); return b; };
      const args = Buffer.concat([MOCK_ADAPTER_ID.toBuffer(), u32Le(1), Buffer.from(EXECUTE_DISC)]);
      const ix = new TransactionInstruction({
        programId: POOL_ID,
        keys: [
          { pubkey: admin.publicKey, isSigner: true, isWritable: true },
          { pubkey: poolConfigPda(POOL_ID), isSigner: false, isWritable: false },
          { pubkey: adapterRegistry, isSigner: false, isWritable: true },
        ],
        data: Buffer.concat([Buffer.from(instructionDiscriminator('register_adapter')), args]),
      });
      const cu = ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 });
      await sendAndConfirmTransaction(conn, new Transaction().add(cu, ix), [admin], { commitment: 'confirmed' });
    }

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
    // Pre-fund OUT scratch — mock adapter does 2x out.
    await mintTo(conn, admin, outMint, adapterOutTa.address, admin, 100_000_000n);

    // Pin relayer's fee-ATA so it's ALT-able.
    const relayerFeeAta = await getOrCreateAssociatedTokenAccount(
      conn, admin, inMint, relayer.publicKey,
    );

    const circuits = path.resolve(__dirname, '../../../circuits/build');
    const b402 = new B402Solana({
      cluster: 'localnet',
      rpcUrl: SOLANA_RPC,
      keypair: user,
      relayer,
      inlineCpiNullifier: true,
      proverArtifacts: {
        wasmPath: path.join(circuits, 'transact_js/transact.wasm'),
        zkeyPath: path.join(circuits, 'ceremony/transact_final.zkey'),
      },
      adaptProverArtifacts: {
        wasmPath: path.join(circuits, 'adapt_js/adapt.wasm'),
        zkeyPath: path.join(circuits, 'ceremony/adapt_final.zkey'),
      },
    });

    // Shield 1.0 inMint.
    const shieldRes = await b402.shield({ mint: inMint, amount: 1_000_000n, omitEncryptedNotes: true });
    expect(shieldRes.signature).toBeTruthy();

    // ALT for swap. Has Light + nullifier + b402 statics + adapter accounts +
    // both mints' PDAs + scratch TAs + relayer fee ATA.
    const lightStatic = defaultStaticAccountsStruct();
    const altAddrs = [
      LightSystemProgram.programId,
      CPI_AUTHORITY,
      lightStatic.registeredProgramPda,
      lightStatic.accountCompressionAuthority,
      lightStatic.accountCompressionProgram,
      new PublicKey(batchAddressTree),
      NULLIFIER_PROGRAM_ID,
      SystemProgram.programId,
      TOKEN_PROGRAM_ID,
      SYSVAR_INSTRUCTIONS,
      poolConfigPda(POOL_ID),
      treeStatePda(POOL_ID),
      adapterRegistry,
      VERIFIER_A_ID,
      MOCK_ADAPTER_ID,
      adapterAuthority,
      adapterInTa.address,
      adapterOutTa.address,
      relayerFeeAta.address,
      tokenConfigPda(POOL_ID, inMint),
      tokenConfigPda(POOL_ID, outMint),
      vaultPda(POOL_ID, inMint),
      vaultPda(POOL_ID, outMint),
      inMint,
      outMint,
    ];
    const alt = await buildAlt(conn, relayer, altAddrs);

    const swapRes = await b402.privateSwap({
      inMint,
      outMint,
      amount: 1_000_000n,
      adapterProgramId: MOCK_ADAPTER_ID,
      adapterInTa: adapterInTa.address,
      adapterOutTa: adapterOutTa.address,
      alt,
      photonRpc,
      expectedOut: 2_000_000n,
    });
    expect(swapRes.signature).toBeTruthy();

    // Verify single-pool-ix shape.
    await new Promise((r) => setTimeout(r, 2000));
    const tx = await conn.getTransaction(swapRes.signature, {
      maxSupportedTransactionVersion: 0, commitment: 'confirmed',
    });
    expect(tx).toBeTruthy();
    const allKeys = tx!.transaction.message.getAccountKeys
      ? tx!.transaction.message.getAccountKeys({ accountKeysFromLookups: tx!.meta?.loadedAddresses })
      : { staticAccountKeys: tx!.transaction.message.staticAccountKeys };
    const keys = (allKeys as any).keySegments
      ? (allKeys as any).keySegments().flat()
      : (allKeys as any).staticAccountKeys;
    const compiledIxs = (tx!.transaction.message as any).compiledInstructions
      ?? (tx!.transaction.message as any).instructions;
    const programs = compiledIxs.map((ix: any) => keys[ix.programIdIndex]?.toBase58?.() ?? String(keys[ix.programIdIndex]));

    // Expect: ComputeBudget + Pool. NO sibling NULLIFIER_PROGRAM_ID ix.
    expect(programs.includes(POOL_ID.toBase58())).toBe(true);
    expect(programs.includes(NULLIFIER_PROGRAM_ID.toBase58())).toBe(false);

    console.log('shield sig:', shieldRes.signature);
    console.log('swap   sig:', swapRes.signature);
    console.log('outAmount:', swapRes.outAmount?.toString?.());
    console.log('ix programs:', programs);
    console.log('tx bytes:', (tx!.transaction.message as any).serialize?.()?.length);
  }, 240_000);
});

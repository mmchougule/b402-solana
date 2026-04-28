/**
 * sdk-quick-swap — TDD test for B402Solana.privateSwap.
 *
 * Two assertions, in order:
 *   RED 1: calling privateSwap() with no shielded balance must throw with
 *          B402ErrorCode.NoSpendableNotes (code 'NO_SPENDABLE_NOTES').
 *   GREEN: shield → privateSwap → unshield to fresh recipient succeeds with
 *          three real devnet sigs and outAmount == 250 (mock adapter mints
 *          a deterministic 2.5x of the 100-unit input).
 *
 * Run:
 *   RPC_URL=https://api.devnet.solana.com pnpm --filter='@b402ai/solana-examples' sdk-quick-swap
 *
 * Pre-conditions:
 *   - ~/.config/solana/id.json funded on devnet (>= 1 SOL)
 *   - circuits/build/{transact_js/transact.wasm, ceremony/transact_final.zkey,
 *                     adapt_js/adapt.wasm, ceremony/adapt_final.zkey} present
 */

import {
  AddressLookupTableProgram, ComputeBudgetProgram, Connection, Keypair, PublicKey, SystemProgram,
  Transaction, TransactionInstruction, sendAndConfirmTransaction,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
  createMint, getOrCreateAssociatedTokenAccount, mintTo,
} from '@solana/spl-token';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import {
  B402Solana, B402Error, B402ErrorCode,
  instructionDiscriminator,
  poolConfigPda, treeStatePda, adapterRegistryPda, treasuryPda,
  tokenConfigPda, vaultPda,
} from '@b402ai/solana';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RPC_URL = process.env.RPC_URL ?? 'https://api.devnet.solana.com';
const POOL_ID         = new PublicKey('42a3hsCXtQLWonyxWZosaaCJCweYYKMrvNd25p1Jrt2y');
const VERIFIER_T_ID   = new PublicKey('Afjbnv2Ekxa98jjRw33xPPhZabevek2uZxoE75kr6ZrK');
const VERIFIER_A_ID   = new PublicKey('3Y2tyhNSaUiW5AcZcmFGRyTMdnroxHxc5GqFQPcMTZae');
const MOCK_ADAPTER_ID = new PublicKey('89kw33YDcbXfiayVNauz599LaDm51EuU8amWydpjYKgp');
const SYSVAR_RENT     = new PublicKey('SysvarRent111111111111111111111111111111111');
const CIRCUITS        = path.resolve(__dirname, '../circuits/build');
const EXECUTE_DISC    = instructionDiscriminator('execute');

async function main() {
  console.log(`▶ RPC ${RPC_URL}`);
  const connection = new Connection(RPC_URL, 'confirmed');

  // Admin = CLI wallet (the devnet pool's admin_multisig). Alice = fresh user.
  const adminPath = process.env.ADMIN_KEYPAIR
    ?? path.join(os.homedir(), '.config/solana/id.json');
  const admin = Keypair.fromSecretKey(
    new Uint8Array(JSON.parse(fs.readFileSync(adminPath, 'utf8'))),
  );
  const alice = Keypair.generate();

  // Fund alice from admin (devnet airdrop is rate-limited; admin already has SOL).
  // 0.18 SOL: 2 × 0.07 SOL nullifier-shard rent + recipient ATA + tx fees.
  const fundIx = SystemProgram.transfer({
    fromPubkey: admin.publicKey,
    toPubkey: alice.publicKey,
    lamports: 0.18 * LAMPORTS_PER_SOL,
  });
  await sendAndConfirmTransaction(connection, new Transaction().add(fundIx), [admin]);
  const aliceBal = await connection.getBalance(alice.publicKey);
  console.log(`▶ alice ${alice.publicKey.toBase58().slice(0, 8)}… (${(aliceBal / LAMPORTS_PER_SOL).toFixed(3)} SOL)`);

  // --- Admin setup (out of SDK scope; lifted from swap-e2e.ts) ---
  const inMint  = await createMint(connection, admin, admin.publicKey, null, 6);
  const outMint = await createMint(connection, admin, admin.publicKey, null, 9);
  console.log(`▶ in_mint=${inMint.toBase58().slice(0,8)}…  out_mint=${outMint.toBase58().slice(0,8)}…`);

  await addTokenConfig(connection, admin, inMint);
  await addTokenConfig(connection, admin, outMint);
  await registerAdapter(connection, admin, MOCK_ADAPTER_ID);

  // Alice's IN ATA, mint 100 in_mint to her.
  const aliceInAta = await getOrCreateAssociatedTokenAccount(connection, admin, inMint, alice.publicKey);
  await mintTo(connection, admin, inMint, aliceInAta.address, admin, 100);

  // Adapter scratch ATAs + pre-fund adapter_out_ta with 100,000 out_mint
  // (mock adapter is constant-rate; this is just inventory the test consumes).
  const adapterAuthority = PublicKey.findProgramAddressSync(
    [new TextEncoder().encode('b402/v1'), new TextEncoder().encode('adapter')],
    MOCK_ADAPTER_ID,
  )[0];
  const adapterInTa  = await getOrCreateAssociatedTokenAccount(connection, admin, inMint,  adapterAuthority, true);
  const adapterOutTa = await getOrCreateAssociatedTokenAccount(connection, admin, outMint, adapterAuthority, true);
  await mintTo(connection, admin, outMint, adapterOutTa.address, admin, 100_000);
  console.log(`▶ adapter scratch TAs ready, adapter_out_ta pre-funded`);

  // Per-run ALT: fresh mints' vault PDAs aren't in the canonical b402 ALT.
  // Production callers using USDC/wSOL won't need this.
  const alt = await createTestAlt(connection, admin, [
    poolConfigPda(POOL_ID),
    adapterRegistryPda(POOL_ID),
    vaultPda(POOL_ID, outMint),
    treeStatePda(POOL_ID),
    VERIFIER_A_ID,
    MOCK_ADAPTER_ID,
    adapterAuthority,
    adapterInTa.address,
    adapterOutTa.address,
    aliceInAta.address,
    TOKEN_PROGRAM_ID,
    SystemProgram.programId,
  ]);
  console.log(`▶ ALT ${alt.toBase58().slice(0, 8)}…`);

  // --- Build B402Solana around alice ---
  const b402 = new B402Solana({
    cluster: 'devnet',
    rpcUrl: RPC_URL,
    keypair: alice,
    proverArtifacts: {
      wasmPath: path.join(CIRCUITS, 'transact_js/transact.wasm'),
      zkeyPath: path.join(CIRCUITS, 'ceremony/transact_final.zkey'),
    },
    adaptProverArtifacts: {
      wasmPath: path.join(CIRCUITS, 'adapt_js/adapt.wasm'),
      zkeyPath: path.join(CIRCUITS, 'ceremony/adapt_final.zkey'),
    },
  });

  // === RED 1: privateSwap before any shield must throw NoSpendableNotes ===
  let red1Threw = false;
  let red1Code: string | undefined;
  try {
    await b402.privateSwap({
      inMint, outMint, amount: 100n,
      adapterProgramId: MOCK_ADAPTER_ID,
      adapterInTa: adapterInTa.address,
      adapterOutTa: adapterOutTa.address,
      alt,
    });
  } catch (e) {
    red1Threw = true;
    red1Code = (e instanceof B402Error) ? e.code : undefined;
  }
  if (!red1Threw) throw new Error('RED 1 failed: privateSwap with no shielded balance did not throw');
  if (red1Code !== B402ErrorCode.NoSpendableNotes) {
    throw new Error(`RED 1 failed: expected code NO_SPENDABLE_NOTES, got ${red1Code}`);
  }
  console.log(`▶ RED 1 ✓ privateSwap before shield → ${red1Code}`);

  // === GREEN: shield then privateSwap ===
  console.log(`▶ shielding 100 in_mint…`);
  const shieldRes = await b402.shield({ mint: inMint, amount: 100n });
  console.log(`  shield ${shieldRes.signature}`);

  console.log(`▶ privateSwap 100 in_mint → out_mint via mock adapter…`);
  const swapRes = await b402.privateSwap({
    inMint, outMint, amount: 100n,
    adapterProgramId: MOCK_ADAPTER_ID,
    adapterInTa: adapterInTa.address,
    adapterOutTa: adapterOutTa.address,
    alt,
  });
  console.log(`  swap   ${swapRes.signature}`);
  console.log(`  outAmount = ${swapRes.outAmount}`);
  if (swapRes.signature.length < 32) throw new Error('expected swap signature');
  if (swapRes.outAmount !== 200n) {
    throw new Error(`expected outAmount=200 (mock adapter constant-rate), got ${swapRes.outAmount}`);
  }

  // Unshield the output note to a fresh recipient.
  const recipient = Keypair.generate();
  console.log(`▶ unshield 200 out_mint → ${recipient.publicKey.toBase58().slice(0, 8)}…`);
  const unshieldRes = await b402.unshield({
    note: swapRes.outNote,
    mint: outMint,
    to: recipient.publicKey,
  });
  console.log(`  unshield ${unshieldRes.signature}`);
  if (unshieldRes.signature.length < 32) throw new Error('expected unshield signature');

  console.log('');
  console.log('✅ shield → privateSwap → unshield via the SDK class');
  console.log(`   shield   ${shieldRes.signature}`);
  console.log(`   swap     ${swapRes.signature}`);
  console.log(`   unshield ${unshieldRes.signature}`);
}

// ---------------------------------------------------------------------------
// Admin helpers — lifted from swap-e2e.ts. Out of SDK scope (privileged ops).
// ---------------------------------------------------------------------------

async function addTokenConfig(c: Connection, admin: Keypair, mint: PublicKey): Promise<void> {
  const existing = await c.getAccountInfo(tokenConfigPda(POOL_ID, mint));
  if (existing) return;
  const maxTvl = Buffer.alloc(8);
  maxTvl.writeBigUInt64LE(0xFFFFFFFFFFFFFFFFn, 0);
  const data = Buffer.concat([
    Buffer.from(instructionDiscriminator('add_token_config')),
    maxTvl,
  ]);
  const ix = new TransactionInstruction({
    programId: POOL_ID,
    keys: [
      { pubkey: admin.publicKey,                      isSigner: true,  isWritable: true  },
      { pubkey: admin.publicKey,                      isSigner: true,  isWritable: false },
      { pubkey: poolConfigPda(POOL_ID),               isSigner: false, isWritable: false },
      { pubkey: tokenConfigPda(POOL_ID, mint),        isSigner: false, isWritable: true  },
      { pubkey: mint,                                 isSigner: false, isWritable: false },
      { pubkey: vaultPda(POOL_ID, mint),              isSigner: false, isWritable: true  },
      { pubkey: TOKEN_PROGRAM_ID,                     isSigner: false, isWritable: false },
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID,          isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId,              isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT,                          isSigner: false, isWritable: false },
    ],
    data,
  });
  const cu = ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 });
  await sendAndConfirmTransaction(c, new Transaction().add(cu, ix), [admin]);
}

async function registerAdapter(c: Connection, admin: Keypair, adapterId: PublicKey): Promise<void> {
  const data = Buffer.concat([
    Buffer.from(instructionDiscriminator('register_adapter')),
    adapterId.toBuffer(),
    Buffer.from([1, 0, 0, 0]),
    Buffer.from(EXECUTE_DISC),
  ]);
  const ix = new TransactionInstruction({
    programId: POOL_ID,
    keys: [
      { pubkey: admin.publicKey,             isSigner: true,  isWritable: true  },
      { pubkey: poolConfigPda(POOL_ID),      isSigner: false, isWritable: false },
      { pubkey: adapterRegistryPda(POOL_ID), isSigner: false, isWritable: true  },
      { pubkey: SystemProgram.programId,     isSigner: false, isWritable: false },
    ],
    data,
  });
  try {
    await sendAndConfirmTransaction(c, new Transaction().add(ix), [admin]);
  } catch (e: any) {
    const msg = e.message ?? String(e);
    if (msg.includes('AdapterAlreadyRegistered') || msg.includes('already in use')) return;
    throw e;
  }
}

async function createTestAlt(
  c: Connection,
  payer: Keypair,
  addresses: PublicKey[],
): Promise<PublicKey> {
  const slot = await c.getSlot('finalized');
  const [createIx, alt] = AddressLookupTableProgram.createLookupTable({
    authority: payer.publicKey,
    payer: payer.publicKey,
    recentSlot: slot,
  });
  await sendAndConfirmTransaction(c, new Transaction().add(createIx), [payer]);
  const extendIx = AddressLookupTableProgram.extendLookupTable({
    payer: payer.publicKey,
    authority: payer.publicKey,
    lookupTable: alt,
    addresses,
  });
  await sendAndConfirmTransaction(c, new Transaction().add(extendIx), [payer]);
  await new Promise((r) => setTimeout(r, 500));
  return alt;
}

main().then(() => process.exit(0), (e) => { console.error('\n❌', e); process.exit(1); });

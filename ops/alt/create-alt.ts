/**
 * Create (or extend) the b402 Address Lookup Table.
 *
 * The ALT compresses stable, high-frequency account references in every
 * `adapt_execute` tx from 32 B to 1 B. Without it, a 2-hop Jupiter swap
 * overflows Solana's 1,232 B tx size cap. See PRD-04 §5.2.
 *
 * Seed set is mint-agnostic: program IDs, protocol PDAs, Token/ATA/System,
 * and common mints (WSOL, USDC). Per-mint accounts (Vault, TokenConfig,
 * adapter scratch ATAs) are added on demand via `add-mint`.
 *
 * Usage:
 *   tsx ops/alt/create-alt.ts create --cluster devnet
 *   tsx ops/alt/create-alt.ts add-mint --mint <MINT_PUBKEY> --alt <ALT_PUBKEY> --cluster devnet
 *   tsx ops/alt/create-alt.ts show   --alt <ALT_PUBKEY> --cluster devnet
 *
 * Env overrides:
 *   RPC_URL         full RPC URL (takes precedence over --cluster)
 *   ADMIN_KEYPAIR   path to signer keypair (default ~/.config/solana/id.json)
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  AddressLookupTableProgram,
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddress,
} from '@solana/spl-token';

// --- Program IDs (must match declare_id! in each program source) --------
const POOL_ID = new PublicKey('42a3hsCXtQLWonyxWZosaaCJCweYYKMrvNd25p1Jrt2y');
const VERIFIER_ID = new PublicKey('Afjbnv2Ekxa98jjRw33xPPhZabevek2uZxoE75kr6ZrK');
const JUPITER_ADAPTER_ID = new PublicKey('3RHRcbinCmcj8JPBfVxb9FW76oh4r8y21aSx4JFy3yx7');
const JUPITER_V6_ID = new PublicKey('JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4');

// --- Common mints --------------------------------------------------------
const WSOL_MINT = new PublicKey('So11111111111111111111111111111111111111112');
const USDC_MAINNET = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');

// --- PDA seeds (must match programs/b402-pool/src/constants.rs) ---------
const VERSION_PREFIX = new TextEncoder().encode('b402/v1');
const SEED_CONFIG    = new TextEncoder().encode('config');
const SEED_TREE      = new TextEncoder().encode('tree');
const SEED_VAULT     = new TextEncoder().encode('vault');
const SEED_TOKEN     = new TextEncoder().encode('token');
const SEED_ADAPTER   = new TextEncoder().encode('adapter');

function pda(seeds: Uint8Array[], programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(seeds, programId)[0];
}

function poolConfigPda(): PublicKey {
  return pda([VERSION_PREFIX, SEED_CONFIG], POOL_ID);
}
function treeStatePda(): PublicKey {
  return pda([VERSION_PREFIX, SEED_TREE], POOL_ID);
}
function vaultPda(mint: PublicKey): PublicKey {
  return pda([VERSION_PREFIX, SEED_VAULT, mint.toBytes()], POOL_ID);
}
function tokenConfigPda(mint: PublicKey): PublicKey {
  return pda([VERSION_PREFIX, SEED_TOKEN, mint.toBytes()], POOL_ID);
}
function jupiterAdapterAuthority(): PublicKey {
  return pda([VERSION_PREFIX, SEED_ADAPTER], JUPITER_ADAPTER_ID);
}

// --- CLI -----------------------------------------------------------------

function parseArgs(argv: string[]): { cmd: string; flags: Record<string, string> } {
  const [cmd, ...rest] = argv;
  const flags: Record<string, string> = {};
  for (let i = 0; i < rest.length; i++) {
    const k = rest[i];
    if (!k.startsWith('--')) continue;
    const v = rest[i + 1];
    if (!v || v.startsWith('--')) { flags[k.slice(2)] = 'true'; continue; }
    flags[k.slice(2)] = v;
    i++;
  }
  return { cmd, flags };
}

function endpointFor(cluster: string, override?: string): string {
  if (override) return override;
  switch (cluster) {
    case 'devnet':       return 'https://api.devnet.solana.com';
    case 'mainnet-beta': return 'https://api.mainnet-beta.solana.com';
    case 'localnet':     return 'http://127.0.0.1:8899';
    default: throw new Error(`unknown cluster: ${cluster}`);
  }
}

function loadSigner(customPath?: string): Keypair {
  const walletPath = customPath ?? process.env.ADMIN_KEYPAIR
    ?? path.join(process.env.HOME ?? '', '.config/solana/id.json');
  const secret = new Uint8Array(JSON.parse(fs.readFileSync(walletPath, 'utf8')));
  return Keypair.fromSecretKey(secret);
}

async function confirmSend(
  connection: Connection,
  signer: Keypair,
  ixs: TransactionInstruction[],
  label: string,
): Promise<string> {
  const tx = new Transaction().add(...ixs);
  tx.feePayer = signer.publicKey;
  tx.recentBlockhash = (await connection.getLatestBlockhash('confirmed')).blockhash;
  tx.sign(signer);
  const sig = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false, preflightCommitment: 'confirmed',
  });
  await connection.confirmTransaction(sig, 'confirmed');
  console.log(`  ✓ ${label}: ${sig}`);
  return sig;
}

// --- Seed set ------------------------------------------------------------

async function stableSeedAccounts(): Promise<PublicKey[]> {
  // Order is cosmetic; ALT indices are position-based but the v0 tx builder
  // looks up by pubkey.
  const adapterAuthority = jupiterAdapterAuthority();
  return [
    // Programs (7)
    JUPITER_V6_ID,
    POOL_ID,
    VERIFIER_ID,
    JUPITER_ADAPTER_ID,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
    SystemProgram.programId,
    // b402 PDAs (3)
    poolConfigPda(),
    treeStatePda(),
    adapterAuthority,
    // Common mints (2)
    WSOL_MINT,
    USDC_MAINNET,
    // Adapter scratch ATAs for the common mints (2)
    await getAssociatedTokenAddress(WSOL_MINT, adapterAuthority, true),
    await getAssociatedTokenAddress(USDC_MAINNET, adapterAuthority, true),
  ];
}

async function mintSpecificAccounts(mint: PublicKey): Promise<PublicKey[]> {
  const adapterAuthority = jupiterAdapterAuthority();
  return [
    mint,
    vaultPda(mint),
    tokenConfigPda(mint),
    await getAssociatedTokenAddress(mint, adapterAuthority, true),
  ];
}

function dedupe(pubkeys: PublicKey[]): PublicKey[] {
  const seen = new Set<string>();
  const out: PublicKey[] = [];
  for (const k of pubkeys) {
    const s = k.toBase58();
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(k);
  }
  return out;
}

// --- Commands ------------------------------------------------------------

const EXTEND_BATCH = 20; // conservative: each pubkey costs 32B in the extend ix

async function cmdCreate(connection: Connection, signer: Keypair): Promise<void> {
  const accounts = dedupe(await stableSeedAccounts());
  console.log(`▶ seeding ALT with ${accounts.length} stable accounts`);

  const slot = await connection.getSlot('finalized');
  const [createIx, altAddress] = AddressLookupTableProgram.createLookupTable({
    authority: signer.publicKey,
    payer: signer.publicKey,
    recentSlot: slot,
  });
  console.log(`  ALT address = ${altAddress.toBase58()}`);
  await confirmSend(connection, signer, [createIx], 'create');

  await extendInBatches(connection, signer, altAddress, accounts);

  const fetched = await connection.getAddressLookupTable(altAddress);
  console.log(`✓ ALT has ${fetched.value?.state.addresses.length ?? 0} addresses`);
  console.log(`\nSet B402_ALT_DEVNET = ${altAddress.toBase58()}`);
}

async function cmdAddMint(
  connection: Connection, signer: Keypair, alt: PublicKey, mint: PublicKey,
): Promise<void> {
  const existing = await connection.getAddressLookupTable(alt);
  if (!existing.value) throw new Error(`ALT ${alt.toBase58()} not found`);
  const have = new Set(existing.value.state.addresses.map(a => a.toBase58()));

  const candidates = await mintSpecificAccounts(mint);
  const toAdd = candidates.filter(k => !have.has(k.toBase58()));
  if (toAdd.length === 0) { console.log('nothing to add'); return; }

  console.log(`▶ adding ${toAdd.length} accounts for mint ${mint.toBase58()}`);
  await extendInBatches(connection, signer, alt, toAdd);
}

async function cmdShow(connection: Connection, alt: PublicKey): Promise<void> {
  const result = await connection.getAddressLookupTable(alt);
  if (!result.value) { console.log('ALT not found'); return; }
  console.log(`ALT ${alt.toBase58()} — ${result.value.state.addresses.length} addresses`);
  for (const [i, a] of result.value.state.addresses.entries()) {
    console.log(`  [${i.toString().padStart(3)}] ${a.toBase58()}`);
  }
}

async function extendInBatches(
  connection: Connection, signer: Keypair, alt: PublicKey, addresses: PublicKey[],
): Promise<void> {
  for (let i = 0; i < addresses.length; i += EXTEND_BATCH) {
    const batch = addresses.slice(i, i + EXTEND_BATCH);
    const ix = AddressLookupTableProgram.extendLookupTable({
      payer: signer.publicKey,
      authority: signer.publicKey,
      lookupTable: alt,
      addresses: batch,
    });
    await confirmSend(connection, signer, [ix], `extend +${batch.length}`);
  }
}

// --- Main ----------------------------------------------------------------

async function main(): Promise<void> {
  const { cmd, flags } = parseArgs(process.argv.slice(2));
  if (!cmd || cmd === 'help') {
    console.log('usage: tsx ops/alt/create-alt.ts <create|add-mint|show> [flags]');
    process.exit(cmd ? 0 : 1);
  }

  const rpcUrl = endpointFor(flags.cluster ?? 'devnet', process.env.RPC_URL);
  const connection = new Connection(rpcUrl, 'confirmed');
  console.log(`▶ rpc = ${rpcUrl}`);

  const signer = loadSigner(flags.wallet);
  const bal = await connection.getBalance(signer.publicKey);
  console.log(`▶ signer = ${signer.publicKey.toBase58()} (${(bal / 1e9).toFixed(3)} SOL)`);

  if (cmd === 'create') {
    await cmdCreate(connection, signer);
  } else if (cmd === 'add-mint') {
    if (!flags.alt)  throw new Error('--alt <pubkey> required');
    if (!flags.mint) throw new Error('--mint <pubkey> required');
    await cmdAddMint(connection, signer, new PublicKey(flags.alt), new PublicKey(flags.mint));
  } else if (cmd === 'show') {
    if (!flags.alt) throw new Error('--alt <pubkey> required');
    await cmdShow(connection, new PublicKey(flags.alt));
  } else {
    throw new Error(`unknown command: ${cmd}`);
  }
}

main().then(() => process.exit(0)).catch(err => {
  console.error(err);
  process.exit(1);
});

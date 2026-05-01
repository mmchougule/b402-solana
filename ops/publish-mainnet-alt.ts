/**
 * One-time mainnet b402 ALT publisher.
 *
 * Builds + extends a single Address Lookup Table containing every stable
 * account a v2.1 unshield (and future swap/lend) tx needs to compress.
 * After this lands, set B402_ALT_MAINNET in packages/shared/src/constants.ts
 * to the printed pubkey, republish shared + SDK + MCP.
 *
 * What goes in the ALT:
 *   - Light V2 infra (6): system program, account_compression, registered
 *     program PDA, account_compression_authority, address tree V2,
 *     output queue
 *   - b402 (3): nullifier program + cpi_authority PDA, pool program ID
 *   - Pool PDAs (4): config, tree, treasury, adapter_registry
 *   - Verifiers (2): transact + adapt
 *   - System (4): compute_budget, sysvar_instructions, token_program,
 *     system_program
 *   - Per registered mint (×10): token_config_pda + vault_pda
 *
 * Total ~39 entries. Single ALT, 2 extend ixs (chunks of 25).
 *
 * Cost: ~0.04 SOL one-time (ALT account rent + tx fees).
 *
 * Usage:
 *   pnpm exec tsx ops/publish-mainnet-alt.ts
 * Optional env:
 *   RPC_URL          — defaults to public mainnet
 *   ADMIN_KEYPAIR    — defaults to ~/.config/solana/id.json
 */

import {
  AddressLookupTableProgram, Connection, Keypair, PublicKey,
  SystemProgram, Transaction, sendAndConfirmTransaction,
} from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const RPC_URL = process.env.RPC_URL ?? 'https://api.mainnet-beta.solana.com';
const ADMIN_PATH = process.env.ADMIN_KEYPAIR ?? path.join(os.homedir(), '.config/solana/id.json');

const POOL_ID = new PublicKey('42a3hsCXtQLWonyxWZosaaCJCweYYKMrvNd25p1Jrt2y');
const NULLIFIER_ID = new PublicKey('2AnRZwWu6CTurZs1yQpqrcJWo4yRYL1xpeV78b2siweq');
const VERIFIER_T_ID = new PublicKey('Afjbnv2Ekxa98jjRw33xPPhZabevek2uZxoE75kr6ZrK');
const VERIFIER_A_ID = new PublicKey('3Y2tyhNSaUiW5AcZcmFGRyTMdnroxHxc5GqFQPcMTZae');

const VPREFIX = Buffer.from('b402/v1');
function seedPda(...seeds: Buffer[]): PublicKey {
  return PublicKey.findProgramAddressSync(seeds, POOL_ID)[0];
}

const NULLIFIER_CPI = PublicKey.findProgramAddressSync(
  [Buffer.from('cpi_authority')], NULLIFIER_ID,
)[0];

// 10 registered mints (must match examples/mainnet-init.ts TOP_TOKENS).
const MINTS: { mint: PublicKey; label: string }[] = [
  { mint: new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'), label: 'USDC' },
  { mint: new PublicKey('So11111111111111111111111111111111111111112'), label: 'wSOL' },
  { mint: new PublicKey('Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'), label: 'USDT' },
  { mint: new PublicKey('JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN'), label: 'JUP'  },
  { mint: new PublicKey('jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL'), label: 'JTO'  },
  { mint: new PublicKey('DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263'), label: 'BONK' },
  { mint: new PublicKey('EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm'), label: 'WIF'  },
  { mint: new PublicKey('HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3'), label: 'PYTH' },
  { mint: new PublicKey('4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R'), label: 'RAY'  },
  { mint: new PublicKey('orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE'), label: 'ORCA' },
];

async function main() {
  const conn = new Connection(RPC_URL, 'confirmed');
  const admin = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(ADMIN_PATH, 'utf8'))));
  console.log(`▶ RPC ${RPC_URL}`);
  console.log(`  admin = ${admin.publicKey.toBase58()}`);

  // 1. Create ALT.
  const slot = (await conn.getSlot('finalized')) - 1;
  const [createIx, alt] = AddressLookupTableProgram.createLookupTable({
    authority: admin.publicKey, payer: admin.publicKey, recentSlot: slot,
  });
  const createSig = await sendAndConfirmTransaction(
    conn, new Transaction().add(createIx), [admin], { commitment: 'confirmed' },
  );
  console.log(`▶ created ALT ${alt.toBase58()} (sig ${createSig})`);

  // 2. Build the address list.
  const addresses: { pk: PublicKey; label: string }[] = [
    // Light v2 infra
    { pk: new PublicKey('SySTEM1eSU2p4BGQfQpimFEWWSC1XDFeun3Nqzz3rT7'), label: 'light_system' },
    { pk: new PublicKey('compr6CUsB5m2jS4Y3831ztGSTnDpnKJTKS95d64XVq'), label: 'account_compression' },
    { pk: new PublicKey('35hkDgaAKwMCaxRz2ocSZ6NaUrtKkyNqU6c4RV3tYJRh'), label: 'registered_program_pda' },
    { pk: new PublicKey('HwXnGK3tPkkVY6P439H2p68AxpeuWXd5PcrAxFpbmfbA'), label: 'account_compression_authority' },
    { pk: new PublicKey('amt2kaJA14v3urZbZvnc5v2np8jqvc4Z8zDep5wbtzx'), label: 'address_tree' },
    { pk: new PublicKey('oq5oh5ZR3yGomuQgFduNDzjtGvVWfDRGLuDVjv9a96P'), label: 'output_queue' },
    // b402
    { pk: NULLIFIER_ID, label: 'b402_nullifier' },
    { pk: NULLIFIER_CPI, label: 'nullifier_cpi_authority' },
    { pk: POOL_ID, label: 'b402_pool' },
    { pk: VERIFIER_T_ID, label: 'verifier_transact' },
    { pk: VERIFIER_A_ID, label: 'verifier_adapt' },
    // Pool PDAs
    { pk: seedPda(VPREFIX, Buffer.from('config')),    label: 'pool_config' },
    { pk: seedPda(VPREFIX, Buffer.from('tree')),      label: 'tree_state' },
    { pk: seedPda(VPREFIX, Buffer.from('treasury')),  label: 'treasury' },
    { pk: seedPda(VPREFIX, Buffer.from('adapters')),  label: 'adapter_registry' },
    // System
    { pk: new PublicKey('Sysvar1nstructions1111111111111111111111111'), label: 'sysvar_instructions' },
    { pk: new PublicKey('ComputeBudget111111111111111111111111111111'), label: 'compute_budget' },
    { pk: TOKEN_PROGRAM_ID, label: 'token_program' },
    { pk: SystemProgram.programId, label: 'system_program' },
  ];
  // Per-mint
  for (const m of MINTS) {
    addresses.push({ pk: seedPda(VPREFIX, Buffer.from('token'), m.mint.toBuffer()), label: `token_config(${m.label})` });
    addresses.push({ pk: seedPda(VPREFIX, Buffer.from('vault'), m.mint.toBuffer()), label: `vault(${m.label})` });
  }
  console.log(`▶ ${addresses.length} addresses to extend:`);
  for (const a of addresses) console.log(`  ${a.label.padEnd(34)} ${a.pk.toBase58()}`);

  // 3. Extend in chunks of 25 (extend-ix per-tx limit).
  const CHUNK = 25;
  for (let i = 0; i < addresses.length; i += CHUNK) {
    const slice = addresses.slice(i, i + CHUNK).map((a) => a.pk);
    const ext = AddressLookupTableProgram.extendLookupTable({
      payer: admin.publicKey, authority: admin.publicKey,
      lookupTable: alt, addresses: slice,
    });
    const sig = await sendAndConfirmTransaction(
      conn, new Transaction().add(ext), [admin], { commitment: 'confirmed' },
    );
    console.log(`▶ extended +${slice.length} (sig ${sig})`);
  }

  // 4. Wait for ALT to age past 1 slot before any caller uses it.
  await new Promise((r) => setTimeout(r, 4000));

  // 5. Verify on-chain.
  const final = await conn.getAddressLookupTable(alt);
  if (!final.value) throw new Error('ALT not visible after extend');
  console.log(`\n✅ ALT live: ${alt.toBase58()}`);
  console.log(`   on-chain entries: ${final.value.state.addresses.length}`);
  console.log(`\n   set in packages/shared/src/constants.ts:`);
  console.log(`     export const B402_ALT_MAINNET = '${alt.toBase58()}' as const;`);
}

main().catch((e) => { console.error(e); process.exit(1); });

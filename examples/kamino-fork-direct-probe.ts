/**
 * Direct-to-Kamino probe — verifies our adapter's instruction discriminator
 * + account-layout assumptions are correct against real cloned mainnet
 * Kamino state, without going through b402_kamino_adapter (which gates
 * on in_vault balance).
 *
 * Calls Kamino's `refresh_reserve` straight from a user-signed tx using
 * the same 8-byte discriminator constant the adapter uses
 * (`KAMINO_IX_REFRESH_RESERVE`). If this lands successfully, we know:
 *   1. Discriminator is correct
 *   2. Account layout for refresh_reserve is correct
 *   3. Pyth oracle in the cloned state is fresh enough
 *   4. The cloned reserve is in a usable state on the fork
 *
 * If it fails with `InstructionFallbackNotFound` → discriminator wrong.
 * If `MissingAccount` → account list wrong.
 * If `OracleStale` → expected; the cloned Pyth oracle isn't getting
 * updates, but the dispatch worked (test passes for our purposes).
 */

import {
  ComputeBudgetProgram, Connection, Keypair, PublicKey,
  Transaction, TransactionInstruction, sendAndConfirmTransaction,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import fs from 'node:fs';

const RPC = 'http://127.0.0.1:8899';
const KAMINO_LEND_PROGRAM = new PublicKey('KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD');

// Verified 2026-04-26: sha256("global:refresh_reserve")[..8]
const KAMINO_IX_REFRESH_RESERVE = Buffer.from([2, 218, 138, 235, 79, 201, 25, 102]);

async function main() {
  const clone = JSON.parse(fs.readFileSync('/tmp/kamino-clone.json', 'utf8'));
  const RESERVE = new PublicKey(clone.constants.reserve);
  const LENDING_MARKET = new PublicKey(clone.constants.lendingMarket);

  const conn = new Connection(RPC, 'confirmed');
  const alice = Keypair.generate();
  const sig0 = await conn.requestAirdrop(alice.publicKey, 5 * LAMPORTS_PER_SOL);
  await conn.confirmTransaction(sig0, 'confirmed');

  // Read the reserve account to find its pyth oracle pubkey at the standard
  // offset. Kamino reserve struct layout (klend master): the oracle is
  // referenced inside ReserveLiquidity.pyth_price; we'll just include all
  // 32-byte aligned non-zero pubkeys from the reserve account as
  // remaining_accounts and let Kamino pick the ones it needs.
  const reserveInfo = await conn.getAccountInfo(RESERVE);
  if (!reserveInfo) throw new Error('reserve not on fork — did you boot with the kamino-clone?');
  const candidates = new Set<string>();
  const data = reserveInfo.data;
  for (let off = 24; off + 32 <= data.length; off += 8) {
    const pk = new PublicKey(data.subarray(off, off + 32));
    if (pk.equals(PublicKey.default)) continue;
    candidates.add(pk.toBase58());
  }
  // Filter to live accounts on the fork.
  const candidateKeys = Array.from(candidates).map((s) => new PublicKey(s));
  const fetched = await Promise.all(candidateKeys.map((k) => conn.getAccountInfo(k)));
  const live = candidateKeys.filter((_, i) => fetched[i] !== null);
  console.log(`▶ reserve references ${live.length} live accounts on fork`);

  // refresh_reserve account list per Kamino IDL:
  //   1. reserve (writable)
  //   2. lending_market (read)
  //   3. pyth_price (read)
  //   4. switchboard_price (read, optional)
  //   5. scope_prices (read, optional)
  // We forward the reserve + lending_market explicitly; oracles + scope come
  // from the live-candidate list. Kamino selects what it needs by name.
  const keys = [
    { pubkey: RESERVE,         isSigner: false, isWritable: true  },
    { pubkey: LENDING_MARKET,  isSigner: false, isWritable: false },
    ...live
      .filter((k) => !k.equals(RESERVE) && !k.equals(LENDING_MARKET))
      .map((k) => ({ pubkey: k, isSigner: false, isWritable: false })),
  ];

  const ix = new TransactionInstruction({
    programId: KAMINO_LEND_PROGRAM,
    keys,
    data: KAMINO_IX_REFRESH_RESERVE,
  });

  const cuIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 });
  const tx = new Transaction().add(cuIx, ix);
  console.log(`▶ submitting refresh_reserve directly to Kamino (${keys.length} accounts)...`);

  try {
    const sig = await sendAndConfirmTransaction(conn, tx, [alice], {
      skipPreflight: true,
      commitment: 'confirmed',
    });
    console.log(`✓ refresh_reserve SUCCESS — sig=${sig}`);
    console.log(`  → discriminator [2, 218, 138, 235, 79, 201, 25, 102] is correct`);
    console.log(`  → reserve + lending_market layout accepted by Kamino`);
  } catch (e: any) {
    const sig = e.signature ?? '<no sig>';
    console.log(`▶ refresh_reserve reverted — sig=${sig}`);
    const txInfo = await conn.getTransaction(sig, {
      commitment: 'confirmed',
      maxSupportedTransactionVersion: 0,
    });
    const logs = txInfo?.meta?.logMessages ?? [];
    for (const line of logs) console.log(`    ${line}`);
    // Diagnose
    const all = logs.join('\n');
    if (all.includes('InstructionFallbackNotFound') || all.includes('Fallback functions are not supported')) {
      console.log(`\n✗ DISCRIMINATOR MISMATCH — our value differs from on-chain Kamino's`);
    } else if (all.includes('Stale')) {
      console.log(`\n⚠️  oracle stale on fork (expected) — discriminator + accounts are right`);
    } else if (all.includes('NotEnoughAccountKeys') || all.includes('AccountNotEnoughKeys')) {
      console.log(`\n✗ MISSING ACCOUNTS — our account list is incomplete`);
    } else {
      console.log(`\n? unexpected error class — needs investigation`);
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

/**
 * Minimum-meaningful Kamino mainnet-fork probe.
 *
 * Calls `b402_kamino_adapter::execute()` directly (not through the pool)
 * with `KaminoAction::Deposit` against cloned mainnet Kamino state.
 * The CPI sequence inside the adapter is:
 *
 *   1. (lazy) init_obligation  ← creates per-user obligation PDA
 *   2. refresh_reserve         ← reads cloned reserve + Pyth oracle
 *   3. refresh_obligation      ← reads obligation deposits/borrows
 *   4. deposit_reserve_liquidity_and_obligation_collateral
 *
 * Expected outcomes:
 *   - Step 1 (init_obligation): SUCCEEDS — alice's obligation PDA is fresh.
 *   - Step 2 (refresh_reserve): SUCCEEDS if cloned oracle is fresh enough,
 *     FAILS with `OracleStale` if Pyth is too old (acceptable for probe —
 *     tells us the discriminator + accounts are right).
 *   - Step 4 (deposit): FAILS — alice's adapter_in_ta has 0 USDC. That's
 *     fine; we're probing the ABI, not testing the deposit path.
 *
 * What this probe verifies:
 *   - All four discriminators we computed match Kamino's runtime
 *   - Reserve account layout we forwarded matches Kamino's expectation
 *   - lending_market_authority PDA derivation is correct
 *   - Per-user obligation PDA derivation matches PRD-09 §7.2
 *
 * If init_obligation or refresh_reserve return `InstructionFallbackNotFound`
 * we know a discriminator is wrong. If they return `MissingAccount` we know
 * the account list is wrong. If they succeed, the v1 ABI works against
 * real Kamino.
 *
 * Usage (after `./ops/mainnet-fork-validator.sh --clone /tmp/kamino-clone.json`):
 *   pnpm tsx examples/kamino-fork-probe.ts
 */

import {
  ComputeBudgetProgram, Connection, Keypair, PublicKey,
  SystemProgram, Transaction, TransactionInstruction, sendAndConfirmTransaction,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID, getOrCreateAssociatedTokenAccount,
} from '@solana/spl-token';
import fs from 'node:fs';
import { instructionDiscriminator, concat, u64Le, vecU8 } from '@b402ai/solana';

const RPC = 'http://127.0.0.1:8899';
const KAMINO_LEND_PROGRAM = new PublicKey('KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD');
const KAMINO_ADAPTER_ID   = new PublicKey('2enwFgcGKJDqruHpCtvmhtxe3DYcV3k72VTvoGcdt2rX');

// Borsh tag for KaminoAction::Deposit variant — first byte of encoded enum.
const KAMINO_ACTION_DEPOSIT = 0;

function encodeDeposit(reserve: PublicKey, inAmount: bigint, minKtOut: bigint): Buffer {
  return Buffer.concat([
    Buffer.from([KAMINO_ACTION_DEPOSIT]),
    reserve.toBuffer(),
    Buffer.from(u64Le(inAmount)),
    Buffer.from(u64Le(minKtOut)),
  ]);
}

async function main() {
  const clone = JSON.parse(fs.readFileSync('/tmp/kamino-clone.json', 'utf8'));
  const RESERVE = new PublicKey(clone.constants.reserve);
  const LENDING_MARKET = new PublicKey(clone.constants.lendingMarket);
  const LENDING_MARKET_AUTHORITY = new PublicKey(clone.constants.lendingMarketAuthority);

  const conn = new Connection(RPC, 'confirmed');
  const alice = Keypair.generate();
  const sig0 = await conn.requestAirdrop(alice.publicKey, 5 * LAMPORTS_PER_SOL);
  await conn.confirmTransaction(sig0, 'confirmed');
  console.log(`▶ alice = ${alice.publicKey.toBase58()}`);

  // Adapter authority PDA (signs token movements).
  const [adapterAuthority] = PublicKey.findProgramAddressSync(
    [Buffer.from('b402/v1'), Buffer.from('adapter')],
    KAMINO_ADAPTER_ID,
  );

  // Per-user obligation PDA per PRD-09 §7.2:
  //   seeds = [b"b402/v1", b"kamino-obl", viewing_pub_hash[..32], lending_market[..32]]
  // For probe purposes, viewing_pub_hash = sha256(alice.pubkey).
  const { createHash } = await import('node:crypto');
  const viewingPubHash = createHash('sha256').update(alice.publicKey.toBuffer()).digest();
  const [obligationPda] = PublicKey.findProgramAddressSync(
    [Buffer.from('b402/v1'), Buffer.from('kamino-obl'), viewingPubHash, LENDING_MARKET.toBuffer()],
    KAMINO_ADAPTER_ID,
  );
  console.log(`▶ obligation PDA = ${obligationPda.toBase58()}`);

  // Adapter scratch ATAs. We won't actually fund them (the probe stops
  // before deposit lands); just create empty SPL TokenAccount slots.
  // Reserve's underlying mint comes from the clone constants; for now
  // hardcode USDC (mainnet).
  const USDC = new PublicKey(clone.constants.underlyingMint);

  console.log(`▶ creating adapter scratch in/out token accounts...`);
  const adapterInTa = await getOrCreateAssociatedTokenAccount(
    conn, alice, USDC, adapterAuthority, true,
  );
  // For kUSDC out we'd need the kToken mint — Kamino derives this from the
  // reserve. Probe doesn't reach the deposit step, so skip out_ta for now.

  // Build the b402_kamino_adapter::execute() ix data.
  // Anchor: discriminator + Borsh args.
  const executeDisc = instructionDiscriminator('execute');
  const inAmount = 1_000_000n;   // 1 USDC (6 decimals)
  const minKtOut = 950_000n;
  const actionPayload = encodeDeposit(RESERVE, inAmount, minKtOut);
  const ixData = concat(
    executeDisc,
    u64Le(inAmount),
    u64Le(minKtOut),
    vecU8(actionPayload),
  );

  // Adapter's named accounts (PRD-04 §2: 6 named, then remaining_accounts).
  // For a deposit Probe we forward: lending_market, lending_market_authority,
  // reserve, obligation, payer (alice), system_program, rent.
  const remaining = [
    { pubkey: LENDING_MARKET,           isSigner: false, isWritable: false },
    { pubkey: LENDING_MARKET_AUTHORITY, isSigner: false, isWritable: false },
    { pubkey: RESERVE,                  isSigner: false, isWritable: true  },
    { pubkey: obligationPda,            isSigner: false, isWritable: true  },
    { pubkey: alice.publicKey,          isSigner: true,  isWritable: true  },  // payer
    { pubkey: SystemProgram.programId,  isSigner: false, isWritable: false },
    { pubkey: KAMINO_LEND_PROGRAM,      isSigner: false, isWritable: false },
  ];

  const ix = new TransactionInstruction({
    programId: KAMINO_ADAPTER_ID,
    keys: [
      { pubkey: adapterAuthority,       isSigner: false, isWritable: false },
      { pubkey: adapterInTa.address,    isSigner: false, isWritable: true  }, // in_vault placeholder
      { pubkey: adapterInTa.address,    isSigner: false, isWritable: true  }, // out_vault placeholder
      { pubkey: adapterInTa.address,    isSigner: false, isWritable: true  }, // adapter_in_ta
      { pubkey: adapterInTa.address,    isSigner: false, isWritable: true  }, // adapter_out_ta placeholder
      { pubkey: TOKEN_PROGRAM_ID,       isSigner: false, isWritable: false },
      ...remaining,
    ],
    data: Buffer.from(ixData),
  });

  const cuIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 });
  const tx = new Transaction().add(cuIx, ix);
  console.log(`▶ submitting probe ix to b402_kamino_adapter...`);

  try {
    const sig = await sendAndConfirmTransaction(conn, tx, [alice], {
      skipPreflight: true,
      commitment: 'confirmed',
    });
    console.log(`✓ probe SUCCESS — sig=${sig}`);
    console.log(`  this means the entire CPI sequence to Kamino went through`);
    console.log(`  (unexpected for a no-token-balance probe — investigate)`);
  } catch (e: any) {
    const sig = e.signature ?? '<no sig>';
    console.log(`▶ probe reverted (expected) — sig=${sig}`);
    if (e.logs) {
      console.log(`▶ relevant logs:`);
      for (const line of e.logs as string[]) {
        if (
          line.includes('KLend') ||
          line.includes('init_obligation') ||
          line.includes('refresh_reserve') ||
          line.includes('refresh_obligation') ||
          line.includes('deposit_reserve') ||
          line.includes('Instruction:') ||
          line.includes('Error') ||
          line.includes('failed') ||
          line.includes('Program log:')
        ) {
          console.log(`    ${line}`);
        }
      }
    } else {
      // Pull tx logs from the chain for the failed sig.
      const tx = await conn.getTransaction(sig, {
        commitment: 'confirmed',
        maxSupportedTransactionVersion: 0,
      });
      if (tx?.meta?.logMessages) {
        for (const line of tx.meta.logMessages) console.log(`    ${line}`);
      }
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

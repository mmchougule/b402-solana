/**
 * Devnet recovery: ResolvePermissionless → ForceCloseResolved each user →
 * WithdrawInsurance (admin) → CloseSlab. Recovers ~12 SOL from a stuck
 * hyperp slab whose engine is past the catchup envelope.
 *
 * Usage:
 *   RPC=https://devnet.helius-rpc.com/?api-key=... \
 *     pnpm exec tsx tests/v2/scripts/recover-slab.ts
 */
import {
  Connection, Keypair, PublicKey, Transaction, TransactionInstruction,
  ComputeBudgetProgram, SYSVAR_CLOCK_PUBKEY, SystemProgram,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddress } from '@solana/spl-token';
import * as fs from 'node:fs';
import * as os from 'node:os';

const CLI_ROOT = `${os.homedir()}/development/ai/percolator-cli`;
const RPC = process.env.RPC ?? 'https://api.devnet.solana.com';
const MARKET_PATH = process.env.MARKET_PATH ?? '/tmp/percolator-market.json';

async function main(): Promise<void> {
  const market = JSON.parse(fs.readFileSync(MARKET_PATH, 'utf8'));
  const slab = new PublicKey(market.slab);
  const vault = new PublicKey(market.vault);
  const vaultPda = new PublicKey(market.vault_pda);
  const mint = new PublicKey(market.mint);
  const percolatorProg = new PublicKey(market.percolator_program);
  const admin = Keypair.fromSecretKey(new Uint8Array(JSON.parse(
    fs.readFileSync(`${os.homedir()}/.config/solana/id.json`, 'utf8'))));

  const conn = new Connection(RPC, 'confirmed');

  const {
    encodeResolveMarket, encodeAdminForceCloseAccount, encodeWithdrawInsurance,
    encodeCloseSlab,
  } = await import(`${CLI_ROOT}/src/abi/instructions.js`);
  const {
    fetchSlab, parseUsedIndices, parseAccount, parseEngine, MarketMode,
  } = await import(`${CLI_ROOT}/src/solana/slab.js`);

  console.log(`slab=${slab.toBase58()}`);
  const startBal = await conn.getBalance(admin.publicKey);
  console.log(`start balance: ${(startBal / 1e9).toFixed(4)} SOL`);

  // ── Step 1: ResolveMarket admin, mode=Degenerate (1) ──
  // Mode 0 (Ordinary) requires a fresh oracle read. Mode 1 (Degenerate)
  // resolves at last_oracle_price without requiring fresh oracle, which
  // is the only path out of a stuck-engine hyperp slab.
  console.log(`\nstep 1: ResolveMarket admin mode=1 (Degenerate)`);
  {
    const probe = await fetchSlab(conn, slab);
    const eng = parseEngine(probe);
    const mode = eng.marketMode;
    if (mode === MarketMode.Resolved) {
      console.log(`  already Resolved, skipping`);
    } else {
      const ix = new TransactionInstruction({
        programId: percolatorProg,
        keys: [
          { pubkey: admin.publicKey, isSigner: true, isWritable: false },
          { pubkey: slab, isSigner: false, isWritable: true },
          { pubkey: SYSVAR_CLOCK_PUBKEY, isSigner: false, isWritable: false },
          { pubkey: slab, isSigner: false, isWritable: false },
        ],
        data: encodeResolveMarket({ mode: 1 }),
      });
      const sig = await sendAndConfirmTransaction(conn,
        new Transaction()
          .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }))
          .add(ix),
        [admin], { commitment: 'confirmed', skipPreflight: true });
      console.log(`  resolved sig=${sig}`);
    }
  }

  // ── Step 2: AdminForceCloseAccount each user ──
  // Slab was bootstrapped with force_close_delay_slots=0 (admin-only mode),
  // so the permissionless ForceCloseResolved is rejected. Admin path works
  // immediately on a Resolved market.
  console.log(`\nstep 2: AdminForceCloseAccount`);
  const slabData = await fetchSlab(conn, slab);
  const indices = parseUsedIndices(slabData);
  console.log(`  used indices: ${indices.join(', ')}`);
  const adminAta = await getAssociatedTokenAddress(mint, admin.publicKey);

  for (const idx of indices) {
    try {
      const acc = parseAccount(slabData, idx);
      const ownerAta = await getAssociatedTokenAddress(mint, acc.owner, true);
      // ACCOUNTS_ADMIN_FORCE_CLOSE: admin, slab, vault, userAta, vaultPda, tokenProgram, clock
      const ix = new TransactionInstruction({
        programId: percolatorProg,
        keys: [
          { pubkey: admin.publicKey, isSigner: true, isWritable: false },
          { pubkey: slab, isSigner: false, isWritable: true },
          { pubkey: vault, isSigner: false, isWritable: true },
          { pubkey: ownerAta, isSigner: false, isWritable: true },
          { pubkey: vaultPda, isSigner: false, isWritable: false },
          { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
          { pubkey: SYSVAR_CLOCK_PUBKEY, isSigner: false, isWritable: false },
        ],
        data: encodeAdminForceCloseAccount({ userIdx: idx }),
      });
      const sig = await sendAndConfirmTransaction(conn,
        new Transaction()
          .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }))
          .add(ix),
        [admin], { commitment: 'confirmed', skipPreflight: true });
      console.log(`  idx=${idx} closed sig=${sig.slice(0, 16)}…`);
    } catch (e: any) {
      console.log(`  idx=${idx} FAILED: ${e?.message?.slice(0, 200) ?? e}`);
    }
  }

  // ── Step 3: WithdrawInsurance ──
  console.log(`\nstep 3: WithdrawInsurance`);
  try {
    // ACCOUNTS_WITHDRAW_INSURANCE: admin, slab, adminAta, vault, tokenProgram, vaultPda
    const ix = new TransactionInstruction({
      programId: percolatorProg,
      keys: [
        { pubkey: admin.publicKey, isSigner: true, isWritable: false },
        { pubkey: slab, isSigner: false, isWritable: true },
        { pubkey: adminAta, isSigner: false, isWritable: true },
        { pubkey: vault, isSigner: false, isWritable: true },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: vaultPda, isSigner: false, isWritable: false },
      ],
      data: encodeWithdrawInsurance(),
    });
    const sig = await sendAndConfirmTransaction(conn,
      new Transaction()
        .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }))
        .add(ix),
      [admin], { commitment: 'confirmed', skipPreflight: true });
    console.log(`  drained sig=${sig.slice(0, 16)}…`);
  } catch (e: any) {
    console.log(`  WITHDRAW FAILED: ${e?.message?.slice(0, 200) ?? e}`);
  }

  // ── Step 4: CloseSlab ──
  console.log(`\nstep 4: CloseSlab`);
  try {
    // ACCOUNTS_CLOSE_SLAB: dest(signer/writable), slab, vault, vaultAuth, destAta, tokenProgram
    const ix = new TransactionInstruction({
      programId: percolatorProg,
      keys: [
        { pubkey: admin.publicKey, isSigner: true, isWritable: true },
        { pubkey: slab, isSigner: false, isWritable: true },
        { pubkey: vault, isSigner: false, isWritable: true },
        { pubkey: vaultPda, isSigner: false, isWritable: false },
        { pubkey: adminAta, isSigner: false, isWritable: true },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      data: encodeCloseSlab(),
    });
    const sig = await sendAndConfirmTransaction(conn,
      new Transaction()
        .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }))
        .add(ix),
      [admin], { commitment: 'confirmed', skipPreflight: true });
    console.log(`  CloseSlab sig=${sig}`);
  } catch (e: any) {
    console.log(`  CLOSE_SLAB FAILED: ${e?.message?.slice(0, 200) ?? e}`);
    if (e?.transactionLogs) console.log(e.transactionLogs.slice(-5));
  }

  const endBal = await conn.getBalance(admin.publicKey);
  console.log(`\nend balance: ${(endBal / 1e9).toFixed(4)} SOL  (recovered ${((endBal - startBal) / 1e9).toFixed(4)} SOL)`);
}

main().catch((e) => { console.error(e); process.exit(1); });

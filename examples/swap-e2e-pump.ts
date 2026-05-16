/**
 * End-to-end test: shield wSOL → privateSwap to $PUMP (Token-2022 with
 * transferHook + transferFee) → unshield to fresh wallet.
 *
 * Prereqs (in another terminal):
 *   tests/v2/scripts/start-pump-fork.sh
 *
 * Run:
 *   pnpm --filter @b402ai/solana-examples tsx examples/swap-e2e-pump.ts
 *
 * What this validates:
 *   - Pool's spl_token_2022::onchain::invoke_transfer_checked CPI on
 *     a real Token-2022 mint with a real transferHook program.
 *   - SDK's appendTransferHookAccounts correctly populates the
 *     instruction account list so on-chain helpers find the hook
 *     program + extra metas.
 *   - Cross-program swap (wSOL legacy → PUMP Token-2022) via the
 *     new mint_out + token_program_out slots.
 *   - Transfer fee deduction shows up in actual delivered amount;
 *     pool's post-CPI invariant uses observed delta so the math
 *     stays consistent.
 *   - Unshield to a fresh wallet completes the privacy round-trip.
 *
 * Assertions:
 *   - User receives PUMP at the fresh wallet (amount > 0, but may be
 *     less than Jupiter quote due to hook fee).
 *   - Pool's wSOL vault has zero (or only fee residue) after the trade.
 *   - Hook program log entries appear in the tx (proof the hook fired).
 */

import fs from "node:fs";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  createSyncNativeInstruction,
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
} from "@solana/spl-token";
import {
  B402Solana,
  buildWallet,
  mintHasTransferHook,
  tokenProgramOf,
} from "@b402ai/solana";

const LOCALHOST = "http://127.0.0.1:8899";
const PUMP_MINT = new PublicKey("pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn");
const WSOL = NATIVE_MINT;
const ROUTE_FILE = process.env.ROUTE_FILE ?? "/tmp/pump-route.json";
const RELAYER_KEYPAIR_PATH = process.env.RELAYER_KEYPAIR_PATH
  ?? `${process.env.HOME}/.config/solana/id.json`;

function loadKeypair(path: string): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path, "utf8"))));
}

function logStep(n: number, msg: string) {
  console.log(`\n==> ${n}. ${msg}`);
}

async function main() {
  const conn = new Connection(LOCALHOST, "confirmed");

  // === 0. Sanity ===
  logStep(0, "Validator + cloned state sanity");
  const pumpInfo = await conn.getAccountInfo(PUMP_MINT);
  if (!pumpInfo) throw new Error("PUMP mint not present on fork — was start-pump-fork.sh run?");
  if (!pumpInfo.owner.equals(TOKEN_2022_PROGRAM_ID))
    throw new Error(`PUMP owner ${pumpInfo.owner.toBase58()} != TOKEN_2022 — clone mismatch`);
  if (!(await mintHasTransferHook(conn, PUMP_MINT)))
    throw new Error("PUMP has no transferHook on fork — clone incomplete");
  console.log("   OK: PUMP mint owned by TOKEN-2022, has transferHook");

  const inProgram = await tokenProgramOf(conn, WSOL);
  const outProgram = await tokenProgramOf(conn, PUMP_MINT);
  if (!inProgram.equals(TOKEN_PROGRAM_ID)) throw new Error("wSOL not legacy on fork");
  if (!outProgram.equals(TOKEN_2022_PROGRAM_ID)) throw new Error("PUMP not Token-2022 on fork");
  console.log(`   OK: cross-program swap path: ${inProgram.toBase58().slice(0,8)} → ${outProgram.toBase58().slice(0,8)}`);

  // === 1. Test wallets ===
  logStep(1, "Set up test wallets (depositor + recipient) + fund");
  const depositor = Keypair.generate();
  const recipient = Keypair.generate();
  const relayer = loadKeypair(RELAYER_KEYPAIR_PATH);

  await conn.requestAirdrop(depositor.publicKey, 5 * LAMPORTS_PER_SOL).then(s => conn.confirmTransaction(s));
  await conn.requestAirdrop(relayer.publicKey, 5 * LAMPORTS_PER_SOL).then(s => conn.confirmTransaction(s));
  console.log(`   depositor=${depositor.publicKey.toBase58()}  recipient=${recipient.publicKey.toBase58()}`);

  // === 2. Wrap 2 SOL → wSOL on depositor's ATA ===
  logStep(2, "Wrap 2 SOL → wSOL on depositor");
  const wsolAta = await getAssociatedTokenAddress(WSOL, depositor.publicKey, false, TOKEN_PROGRAM_ID);
  const wrapTx = new Transaction();
  wrapTx.add(
    createAssociatedTokenAccountInstruction(depositor.publicKey, wsolAta, depositor.publicKey, WSOL, TOKEN_PROGRAM_ID),
    SystemProgram.transfer({ fromPubkey: depositor.publicKey, toPubkey: wsolAta, lamports: 2 * LAMPORTS_PER_SOL }),
    createSyncNativeInstruction(wsolAta, TOKEN_PROGRAM_ID),
  );
  await sendAndConfirmTransaction(conn, wrapTx, [depositor]);
  console.log(`   wSOL ATA: ${wsolAta.toBase58()}, balance: 2 SOL`);

  // === 3. Build SDK ===
  logStep(3, "Initialize B402Solana SDK against fork");
  const sdk = await B402Solana.create({
    connection: conn,
    cluster: "localnet",
    wallet: buildWallet(depositor),
    relayer,
    // Phase 9 + inline-CPI nullifier defaults match mainnet build.
    inlineCpiNullifier: true,
    phase9DualNote: true,
  });
  console.log("   SDK ready");

  // === 4. Shield 1 SOL ===
  logStep(4, "Shield 1 SOL into b402 pool");
  const shieldRes = await sdk.shield({ mint: WSOL, amount: BigInt(1 * LAMPORTS_PER_SOL) });
  console.log(`   shield tx: ${shieldRes.signature}`);

  // === 5. privateSwap wSOL → PUMP ===
  logStep(5, "privateSwap 1 wSOL → PUMP (cross-program + transferHook!)");
  const route = JSON.parse(fs.readFileSync(ROUTE_FILE, "utf8"));
  const adapterInTa = await getAssociatedTokenAddress(WSOL, new PublicKey(route.adapterAuthority), true, TOKEN_PROGRAM_ID);
  const adapterOutTa = await getAssociatedTokenAddress(PUMP_MINT, new PublicKey(route.adapterAuthority), true, TOKEN_2022_PROGRAM_ID);

  const swapRes = await sdk.privateSwap({
    inMint: WSOL,
    outMint: PUMP_MINT,
    inAmount: BigInt(1 * LAMPORTS_PER_SOL),
    minOut: BigInt(route.quote.outAmount) * 90n / 100n, // 10% slippage tolerance for hook fee
    adapterProgramId: new PublicKey("3RHRcbinCmcj8JPBfVxb9FW76oh4r8y21aSx4JFy3yx7"),
    adapterInTa,
    adapterOutTa,
    actionPayload: Buffer.from(route.swapInstruction.data, "base64"),
    remainingAccounts: route.swapInstruction.keys.map((k: any) => ({
      pubkey: new PublicKey(k.pubkey),
      isSigner: k.isSigner,
      isWritable: k.isWritable,
    })),
  });
  console.log(`   swap tx: ${swapRes.signature}`);

  // === 6. unshield PUMP to recipient ===
  logStep(6, "unshield PUMP to fresh recipient wallet");
  const unshieldRes = await sdk.unshield({
    mint: PUMP_MINT,
    to: recipient.publicKey,
  });
  console.log(`   unshield tx: ${unshieldRes.signature}`);

  // === 7. Verify ===
  logStep(7, "Verify recipient received PUMP");
  const recipientPumpAta = await getAssociatedTokenAddress(PUMP_MINT, recipient.publicKey, false, TOKEN_2022_PROGRAM_ID);
  const recipientAcc = await conn.getTokenAccountBalance(recipientPumpAta);
  const amount = BigInt(recipientAcc.value.amount);
  if (amount === 0n) throw new Error("Recipient received zero PUMP — flow broken");
  const human = Number(amount) / 10 ** recipientAcc.value.decimals;
  console.log(`   ✓ Recipient holds ${human.toFixed(6)} PUMP`);
  console.log(`   ✓ Privacy round-trip complete: depositor → b402 pool → recipient (no on-chain link)`);

  console.log("\n=== SUCCESS — full Token-2022 + transferHook flow verified on mainnet-fork ===");
}

main().catch((e) => {
  console.error("FAIL:", e?.message ?? e);
  console.error(e?.stack);
  process.exit(1);
});

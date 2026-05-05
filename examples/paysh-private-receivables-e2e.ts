/**
 * pay.sh Private Receivables — end-to-end demo on devnet.
 *
 * Demonstrates the privacy bridge of PRD-25 with real on-chain operations:
 *   1. Operator runs a PayshBridge configured with their devnet keypair as
 *      the stealth ingress.
 *   2. A simulated payer (fresh keypair, airdropped) sends a real SPL
 *      transfer of test-USDC to the operator's ingress ATA — this is what
 *      an x402 / pay.sh client would do under the hood when paying
 *      against a metered endpoint with `payTo = <operator pubkey>`.
 *   3. Bridge picks up the WS log, parses the transfer, calls
 *      `b402.shield()` (real Groth16 proof, real Merkle tree append).
 *   4. Operator unshields to a freshly-generated wallet — the recipient
 *      has no on-chain link to the payer.
 *
 * What this proves:
 *   - The b402-solana SDK shield/unshield actually executes inside the
 *     bridge's lifecycle. The privacy comes from the SDK; the bridge
 *     is the glue.
 *   - An external SPL transfer to the ingress ATA is detected, parsed,
 *     and shielded automatically — no operator action between payment
 *     and shielded balance.
 *   - The unshield destination is unlinkable to the payer on-chain.
 *
 * What this does NOT do (out of scope per PRD-25 §3):
 *   - Run an actual x402 HTTP server. The "payment" here is a direct
 *     SPL transfer, which is exactly what an x402 verifier checks for
 *     anyway. Wiring an Express service that returns 402 with the right
 *     `accepts[]` is a follow-up demo.
 *
 * Run:
 *   RPC_URL=https://api.devnet.solana.com pnpm --filter=@b402ai/solana-examples paysh-e2e
 *
 * Requires:
 *   - ~/.config/solana/id.json funded on devnet (≥ 0.5 SOL)
 *   - circuits/build/transact_js/transact.wasm
 *   - circuits/build/ceremony/transact_final.zkey
 */

import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';
import {
  ComputeBudgetProgram, SystemProgram, Transaction, TransactionInstruction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createMint,
  getAssociatedTokenAddress,
  getAssociatedTokenAddressSync,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  transfer,
} from '@solana/spl-token';
import { AddressLookupTableProgram } from '@solana/web3.js';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import { createRpc } from '@lightprotocol/stateless.js';
import { B402_ALT_DEVNET } from '@b402ai/solana-shared';
import {
  B402Solana,
  instructionDiscriminator,
  poolConfigPda,
  tokenConfigPda,
  vaultPda,
} from '@b402ai/solana';
import {
  PayshBridge,
  makeSdkShieldFn,
  type BridgeEvent,
} from '@b402ai/paysh-bridge';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RPC_URL = process.env.RPC_URL ?? 'https://api.devnet.solana.com';
const POOL_ID = new PublicKey('42a3hsCXtQLWonyxWZosaaCJCweYYKMrvNd25p1Jrt2y');
const CIRCUITS = path.resolve(__dirname, '../circuits/build');
const PAYMENT_AMOUNT = 1_000_000n; // 1.0 in 6-decimal units (mimics 1 USDC)

async function main(): Promise<void> {
  // ── 1. Load operator keypair ─────────────────────────────────────────
  const adminKey = JSON.parse(
    fs.readFileSync(path.join(os.homedir(), '.config/solana/id.json'), 'utf8'),
  );
  const operator = Keypair.fromSecretKey(new Uint8Array(adminKey));
  const conn = new Connection(RPC_URL, 'confirmed');

  console.log('━━━ pay.sh Private Receivables — devnet e2e ━━━\n');
  console.log(`operator (= ingress) ${operator.publicKey.toBase58()}`);
  const opSol = await conn.getBalance(operator.publicKey);
  console.log(`  SOL balance ${(opSol / LAMPORTS_PER_SOL).toFixed(3)}`);
  if (opSol < 0.3 * LAMPORTS_PER_SOL) {
    throw new Error('operator wallet needs ≥ 0.3 devnet SOL — top up at https://faucet.solana.com');
  }

  // ── 2. Stand up a fresh test mint that mimics USDC (6 decimals) ─────
  // We do this because devnet USDC requires a faucet and pay.sh's
  // catalog uses real USDC; for the demo, the privacy property is
  // identical for any SPL token. The pool needs the mint registered
  // (this is a one-time op for any new mint, not a privacy mechanism).
  const mint = await createMint(conn, operator, operator.publicKey, null, 6);
  console.log(`\nmint ${mint.toBase58()} (test-USDC, 6 decimals)`);
  const operatorAta = await getOrCreateAssociatedTokenAccount(
    conn, operator, mint, operator.publicKey,
  );
  await addTokenConfig(conn, operator, mint);
  console.log(`  operator ATA ${operatorAta.address.toBase58()} (this is what payers transfer to)`);

  // ── 3. Spin up the bridge ───────────────────────────────────────────
  const b402 = new B402Solana({
    cluster: 'devnet',
    rpcUrl: RPC_URL,
    keypair: operator,
    proverArtifacts: {
      wasmPath: path.join(CIRCUITS, 'transact_js/transact.wasm'),
      zkeyPath: path.join(CIRCUITS, 'ceremony/transact_final.zkey'),
    },
  });

  const bridge = new PayshBridge({
    connection: conn,
    ingressOwner: operator.publicKey,
    ingressAta: operatorAta.address,
    shield: makeSdkShieldFn(b402, mint),
    tickIntervalMs: 0, // demo doesn't need the heartbeat
  });

  // Promise that resolves on the first `shielded` event.
  const shielded = new Promise<BridgeEvent>((resolve, reject) => {
    bridge.on((e) => {
      if (e.name === 'shielded') resolve(e);
      else if (e.name === 'failed') reject(new Error(`shield failed: ${e.error}`));
    });
  });

  await bridge.start();
  console.log(`\nbridge started; payTo = ${bridge.payTo()}`);
  console.log(`  → in a real pay.sh provider, this is what goes in accepts[].payTo`);

  // ── 4. Simulate an x402 payment: fresh payer transfers test-USDC ────
  // We fund the payer's SOL from the operator rather than the public devnet
  // faucet — the faucet rate-limits aggressively and isn't reliable for CI.
  const payer = Keypair.generate();
  console.log(`\nsimulated payer ${payer.publicKey.toBase58()}`);
  const fundSig = await sendAndConfirmTransaction(
    conn,
    new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: operator.publicKey,
        toPubkey: payer.publicKey,
        lamports: Math.floor(0.05 * LAMPORTS_PER_SOL),
      }),
    ),
    [operator],
  );
  void fundSig;

  const payerAta = await getOrCreateAssociatedTokenAccount(conn, operator, mint, payer.publicKey);
  await mintTo(conn, operator, mint, payerAta.address, operator, PAYMENT_AMOUNT);
  console.log(`  funded ${PAYMENT_AMOUNT} (= 1.0 test-USDC) to payer ATA`);

  console.log(`\n→ payer signs SPL transfer of 1.0 test-USDC to operator ATA`);
  const paymentSig = await transfer(
    conn, payer, payerAta.address, operatorAta.address, payer, PAYMENT_AMOUNT,
  );
  console.log(`  payment tx ${paymentSig}`);
  console.log(`  https://explorer.solana.com/tx/${paymentSig}?cluster=devnet`);

  // ── 5. Wait for the bridge to shield ────────────────────────────────
  console.log('\nwaiting for bridge to shield (Groth16 proof + Merkle append)…');
  const t0 = Date.now();
  const evt = await Promise.race([
    shielded,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('timeout: bridge did not shield within 90s')), 90_000),
    ),
  ]);
  console.log(`  ✓ shielded in ${(Date.now() - t0) / 1000}s`);
  console.log(`    txSig      ${evt.txSig}`);
  console.log(`    commitment ${evt.commitment}`);

  // Sanity: SDK's view of private balance should now show our amount.
  const bal = await b402.balance({ mint });
  const balLine = bal.balances[0];
  console.log(`  private balance (SDK view): ${balLine?.amount ?? '0'} (${balLine?.depositCount ?? 0} note(s))`);

  // ── 6. Unshield to a fresh, unlinkable address ──────────────────────
  const recipient = Keypair.generate();
  console.log(`\nfresh recipient ${recipient.publicKey.toBase58()} (no prior on-chain history)`);
  console.log('→ operator calls unshield (requires Photon-enabled RPC)');
  const photonUrl = process.env.B402_PHOTON_RPC_URL ?? RPC_URL;
  const photonRpc = createRpc(RPC_URL, photonUrl);

  let unshieldSig: string | null = null;
  try {
    // The pre-published ALT doesn't carry our fresh test mint's accounts.
    // Build one per-call (same logic the b402-solana MCP server uses for
    // ad-hoc unshields). ~0.005 SOL rent, recoverable by closing the ALT.
    console.log('  building per-call ALT for fresh mint…');
    const recipientAta = getAssociatedTokenAddressSync(mint, recipient.publicKey);
    const alt = await buildUnshieldAlt(conn, operator, mint, recipientAta);

    const unshieldRes = await b402.unshield({
      to: recipient.publicKey,
      mint,
      photonRpc,
      alt,
      inlineCpiNullifier: true,
    });
    unshieldSig = unshieldRes.signature;
    console.log(`  ✓ unshield tx ${unshieldSig}`);
    console.log(`  https://explorer.solana.com/tx/${unshieldSig}?cluster=devnet`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/Method not found|getValidityProof/i.test(msg)) {
      console.log('  ⚠ skipped — RPC does not serve Photon (Light Protocol indexer).');
      console.log('     set RPC_URL to a Helius/Triton devnet endpoint and re-run, e.g.');
      console.log('     RPC_URL=https://devnet.helius-rpc.com/?api-key=<key> pnpm paysh-e2e');
      console.log('     the SHIELD step above is the privacy-bridge demonstration and');
      console.log('     completed successfully. Unshield is a separate operator action.');
    } else {
      throw err;
    }
  }

  // ── 7. Privacy summary ──────────────────────────────────────────────
  console.log('\n━━━ privacy summary ━━━');
  console.log(`payer    → ingress ATA   (visible on-chain: ${paymentSig.slice(0, 12)}…)`);
  console.log(`ingress  → shielded note (commitment ${(evt.commitment ?? '').slice(0, 18)}…)`);
  console.log('   the commitment is a Poseidon hash of (mint, amount, randomness, owner-pub).');
  console.log('   no on-chain field reveals the amount, the owner, or any link to the payer.');
  if (unshieldSig) {
    console.log(`shielded → recipient    (unshield tx: ${unshieldSig.slice(0, 12)}…)`);
    console.log('   the recipient has zero on-chain history connecting back to the payer.');
    console.log('   when B402_RELAYER_HTTP_URL is configured, the b402 hosted relayer pays');
    console.log('   the gas and the operator wallet is absent from this tx entirely.');
  } else {
    console.log('shielded → recipient    (skipped — needs Photon RPC, see above)');
    console.log('   even without the unshield, the privacy goal is met at shield-time:');
    console.log('   the operator\'s shielded balance is unlinkable to any future spend.');
  }

  await bridge.stop();
}

// ── helpers ──────────────────────────────────────────────────────────

/** Build an ALT that contains every account a v2.1 unshield ix references.
 *  Mirrors `packages/mcp-server/src/tools/unshield.ts:buildUnshieldAlt`. */
async function buildUnshieldAlt(
  c: Connection, payer: Keypair, mint: PublicKey, recipientAta: PublicKey,
): Promise<PublicKey> {
  const NULLIFIER_ID = new PublicKey('2AnRZwWu6CTurZs1yQpqrcJWo4yRYL1xpeV78b2siweq');
  const VERIFIER_T_ID = new PublicKey('Afjbnv2Ekxa98jjRw33xPPhZabevek2uZxoE75kr6ZrK');
  const SYSVAR_INSTRUCTIONS = new PublicKey('Sysvar1nstructions1111111111111111111111111');
  const COMPUTE_BUDGET = new PublicKey('ComputeBudget111111111111111111111111111111');
  const VPREFIX = Buffer.from('b402/v1');
  const seedPda = (...seeds: Buffer[]) =>
    PublicKey.findProgramAddressSync(seeds, POOL_ID)[0];
  const NULLIFIER_CPI = PublicKey.findProgramAddressSync(
    [Buffer.from('cpi_authority')],
    NULLIFIER_ID,
  )[0];

  const slot = (await c.getSlot('finalized')) - 1;
  const [createIx, alt] = AddressLookupTableProgram.createLookupTable({
    authority: payer.publicKey, payer: payer.publicKey, recentSlot: slot,
  });
  await sendAndConfirmTransaction(c, new Transaction().add(createIx), [payer], {
    commitment: 'confirmed',
  });

  const ext = AddressLookupTableProgram.extendLookupTable({
    payer: payer.publicKey,
    authority: payer.publicKey,
    lookupTable: alt,
    addresses: [
      new PublicKey('SySTEM1eSU2p4BGQfQpimFEWWSC1XDFeun3Nqzz3rT7'),
      new PublicKey('compr6CUsB5m2jS4Y3831ztGSTnDpnKJTKS95d64XVq'),
      new PublicKey('35hkDgaAKwMCaxRz2ocSZ6NaUrtKkyNqU6c4RV3tYJRh'),
      new PublicKey('HwXnGK3tPkkVY6P439H2p68AxpeuWXd5PcrAxFpbmfbA'),
      new PublicKey('amt2kaJA14v3urZbZvnc5v2np8jqvc4Z8zDep5wbtzx'),
      new PublicKey('oq5oh5ZR3yGomuQgFduNDzjtGvVWfDRGLuDVjv9a96P'),
      NULLIFIER_ID, NULLIFIER_CPI,
      POOL_ID,
      seedPda(VPREFIX, Buffer.from('config')),
      seedPda(VPREFIX, Buffer.from('tree')),
      seedPda(VPREFIX, Buffer.from('treasury')),
      seedPda(VPREFIX, Buffer.from('token'), mint.toBuffer()),
      seedPda(VPREFIX, Buffer.from('vault'), mint.toBuffer()),
      VERIFIER_T_ID,
      SYSVAR_INSTRUCTIONS, COMPUTE_BUDGET,
      TOKEN_PROGRAM_ID, SystemProgram.programId,
      recipientAta,
    ],
  });
  await sendAndConfirmTransaction(c, new Transaction().add(ext), [payer], {
    commitment: 'confirmed',
  });
  // ALT must be > 1 slot old before use.
  await new Promise((r) => setTimeout(r, 3000));
  return alt;
}

async function addTokenConfig(c: Connection, admin: Keypair, mint: PublicKey): Promise<void> {
  const maxTvl = Buffer.alloc(8);
  maxTvl.writeBigUInt64LE(0xFFFFFFFFFFFFFFFFn, 0);
  const data = Buffer.concat([Buffer.from(instructionDiscriminator('add_token_config')), maxTvl]);
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
      { pubkey: new PublicKey('SysvarRent111111111111111111111111111111111'), isSigner: false, isWritable: false },
    ],
    data,
  });
  const cu = ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 });
  await sendAndConfirmTransaction(c, new Transaction().add(cu, ix), [admin]);
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error('\n❌', e);
    process.exit(1);
  },
);

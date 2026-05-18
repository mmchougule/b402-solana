import {
  ComputeBudgetProgram, Connection, Keypair, PublicKey, SystemProgram,
  Transaction, TransactionInstruction, sendAndConfirmTransaction,
} from "@solana/web3.js";
import { instructionDiscriminator, poolConfigPda, treeStatePda, adapterRegistryPda, treasuryPda } from "@b402ai/solana";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const RPC_URL = "http://127.0.0.1:8899";
const POOL_ID = new PublicKey("42a3hsCXtQLWonyxWZosaaCJCweYYKMrvNd25p1Jrt2y");
const VERIFIER_T_ID = new PublicKey("Afjbnv2Ekxa98jjRw33xPPhZabevek2uZxoE75kr6ZrK");
const VERIFIER_A_ID = new PublicKey("3Y2tyhNSaUiW5AcZcmFGRyTMdnroxHxc5GqFQPcMTZae");

const c = new Connection(RPC_URL, "confirmed");
// Use the deterministic seed-7 admin keypair that examples/e2e.ts expects
// on localnet, so init + e2e stay in sync (otherwise e2e's add_token_config
// fails with UnauthorizedAdmin).
const admin = Keypair.fromSeed(new Uint8Array(32).fill(7));
// Airdrop SOL since this keypair has no balance on fresh fork.
const bal = await c.getBalance(admin.publicKey);
if (bal < 1e9) {
  const sig = await c.requestAirdrop(admin.publicKey, 5e9);
  await c.confirmTransaction(sig, "confirmed");
}

const cfg = await c.getAccountInfo(poolConfigPda(POOL_ID));
if (cfg) { console.log("pool already initialized"); process.exit(0); }

const data = Buffer.concat([
  Buffer.from(instructionDiscriminator("init_pool")),
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
    { pubkey: treasuryPda(POOL_ID), isSigner: false, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ],
  data,
});
const cu = ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 });
const sig = await sendAndConfirmTransaction(c, new Transaction().add(cu, ix), [admin]);
console.log("init_pool sig:", sig);

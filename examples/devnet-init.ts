/**
 * One-shot devnet setup after fresh deploy of pool + verifier_adapt + mock_adapter:
 *   1. set_verifier(Adapt, 3Y2tyhNS...) on pool_config (fixes pre-Phase-2 init)
 *   2. register_adapter(mock_adapter, [execute disc])
 *
 * Idempotent: re-running is safe (admin auth required, no-op if already set).
 *
 * Usage: solana -u devnet, default keypair must be the pool admin (deployer).
 */

import { Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, sendAndConfirmTransaction } from '@solana/web3.js';
import { instructionDiscriminator, poolConfigPda, adapterRegistryPda } from '@b402ai/solana';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const RPC = process.env.RPC_URL ?? 'https://api.devnet.solana.com';
const POOL_ID         = new PublicKey('42a3hsCXtQLWonyxWZosaaCJCweYYKMrvNd25p1Jrt2y');
const VERIFIER_ADAPT  = new PublicKey('3Y2tyhNSaUiW5AcZcmFGRyTMdnroxHxc5GqFQPcMTZae');
const MOCK_ADAPTER_ID = new PublicKey('89kw33YDcbXfiayVNauz599LaDm51EuU8amWydpjYKgp');

const adminKeyPath = process.env.ADMIN_KEYPAIR ?? path.join(os.homedir(), '.config/solana/id.json');
const admin = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(adminKeyPath, 'utf8'))));

async function main() {
  const c = new Connection(RPC, 'confirmed');
  console.log(`▶ RPC ${RPC}, admin ${admin.publicKey.toBase58()}`);

  // 1. set_verifier(Adapt, VERIFIER_ADAPT)
  // Anchor enum tag: VerifierKind { Transact=0, Adapt=1, Disclose=2 }
  const setVerifierData = Buffer.concat([
    Buffer.from(instructionDiscriminator('set_verifier')),
    Buffer.from([1]),                       // kind = Adapt
    VERIFIER_ADAPT.toBuffer(),              // new_id
  ]);
  const setVerifierIx = new TransactionInstruction({
    programId: POOL_ID,
    keys: [
      { pubkey: admin.publicKey,        isSigner: true,  isWritable: false },
      { pubkey: poolConfigPda(POOL_ID), isSigner: false, isWritable: true  },
    ],
    data: setVerifierData,
  });
  const sig1 = await sendAndConfirmTransaction(c, new Transaction().add(setVerifierIx), [admin]);
  console.log(`  set_verifier(Adapt) sig = ${sig1}`);

  // 2. register_adapter(mock_adapter, [execute disc])
  const executeDisc = instructionDiscriminator('execute');
  // Borsh AdapterRegistration { program_id: Pubkey, allowed_instructions: Vec<[u8;8]> }
  const registerArgs = Buffer.concat([
    MOCK_ADAPTER_ID.toBuffer(),
    Buffer.from([1, 0, 0, 0]),    // allowed_instructions vec len = 1 (u32 LE)
    Buffer.from(executeDisc),
  ]);
  const registerData = Buffer.concat([
    Buffer.from(instructionDiscriminator('register_adapter')),
    registerArgs,
  ]);
  const registerIx = new TransactionInstruction({
    programId: POOL_ID,
    keys: [
      { pubkey: admin.publicKey,             isSigner: true,  isWritable: true  },
      { pubkey: poolConfigPda(POOL_ID),      isSigner: false, isWritable: false },
      { pubkey: adapterRegistryPda(POOL_ID), isSigner: false, isWritable: true  },
      { pubkey: SystemProgram.programId,     isSigner: false, isWritable: false },
    ],
    data: registerData,
  });
  try {
    const sig2 = await sendAndConfirmTransaction(c, new Transaction().add(registerIx), [admin]);
    console.log(`  register_adapter(mock) sig = ${sig2}`);
  } catch (e: any) {
    if (e.message?.includes('already in use') || e.message?.includes('AdapterAlreadyRegistered')) {
      console.log(`  mock adapter already registered (skipping)`);
    } else {
      throw e;
    }
  }

  console.log(`✅ devnet pool ready for shield → adapt_execute → unshield demos`);
}

main().catch((e) => { console.error(e); process.exit(1); });

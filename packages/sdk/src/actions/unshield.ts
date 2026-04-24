/**
 * `unshield` — withdraw a shielded note to a clear recipient ATA.
 *
 * Flow:
 *   1. Fetch fresh merkle root.
 *   2. Walk the in-memory tree to derive the note's siblings + pathBits.
 *   3. Compute nullifier = Poseidon_3(nullTag, spendingPriv, leafIndex).
 *   4. Compute recipient_bind = Poseidon_3(recipientBindTag,
 *      ownerLow, ownerHigh) over the recipient pubkey halves.
 *   5. Build witness: 1 real input note, 0 outputs, public_amount_out = note.value.
 *   6. Generate proof.
 *   7. Build instruction with recipient_token_account in the right slot —
 *      the on-chain handler re-derives the bind from this account's owner
 *      and rejects mismatch.
 */

import {
  ComputeBudgetProgram, Connection, Keypair, PublicKey, SystemProgram,
  Transaction, TransactionInstruction,
} from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';

import {
  TRANSACT_PUBLIC_INPUT_COUNT, domainTag, leToFrReduced,
} from '@b402ai/solana-shared';
import type { SpendableNote } from '@b402ai/solana-shared';
import { TransactProver, type TransactWitness } from '@b402ai/solana-prover';

import {
  poolConfigPda, treeStatePda, tokenConfigPda, vaultPda,
  nullifierShardPda, shardPrefix,
} from '../programs/pda.js';
import { fetchTreeState } from '../programs/tree-state.js';
import { instructionDiscriminator, concat, u16Le, u32Le, u64Le, vecU8 } from '../programs/anchor.js';
import { ClientMerkleTree, type MerkleProof, buildZeroCache } from '../merkle.js';
import { nullifierHash, feeBindHash, poseidonTagged } from '../poseidon.js';
import type { Wallet } from '../wallet.js';

export interface UnshieldParams {
  connection: Connection;
  poolProgramId: PublicKey;
  verifierProgramId: PublicKey;
  prover: TransactProver;
  wallet: Wallet;
  /** Token mint of the note being unshielded. */
  mint: PublicKey;
  /** Note to spend. Caller must hold both spendingPriv and the merkle context (leafIndex). */
  note: SpendableNote;
  /**
   * Pre-computed client tree that contains the note. Either this or
   * `merkleProof` must be provided. Use `tree` when you have a full
   * scanner-maintained tree; use `merkleProof` when you only have the
   * on-chain frontier (e.g. `proveMostRecentLeaf` output).
   */
  tree?: ClientMerkleTree;
  /** Pre-computed merkle proof for the spent note. Overrides `tree` if both given. */
  merkleProof?: MerkleProof;
  /** Destination ATA — must be owned by `recipientOwner`. */
  recipientTokenAccount: PublicKey;
  /** Owner of `recipientTokenAccount`. Bound into the proof. */
  recipientOwner: PublicKey;
  /** Pays SOL fee + creates nullifier shard PDA on first use. */
  relayer: Keypair;
}

export interface UnshieldResult {
  signature: string;
  nullifier: bigint;
  amountTransferred: bigint;
}

export async function unshield(params: UnshieldParams): Promise<UnshieldResult> {
  const {
    connection, poolProgramId, verifierProgramId, prover, wallet,
    mint, note, tree, merkleProof, recipientTokenAccount, recipientOwner, relayer,
  } = params;
  if (!tree && !merkleProof) throw new Error('unshield: provide `tree` or `merkleProof`');

  // 1. Fresh root.
  const onChain = await fetchTreeState(connection, treeStatePda(poolProgramId));
  const merkleRoot = leToFrReduced(onChain.currentRoot);

  // 2. Merkle path for the note — from precomputed proof or from client tree.
  const proofMerkle = merkleProof ?? await tree!.prove(note.leafIndex);

  // 3. Nullifier.
  const nullifierVal = await nullifierHash(wallet.spendingPriv, note.leafIndex);
  const nullifierLe = bigIntToLeBytes(nullifierVal);
  const prefix = shardPrefix(nullifierLe);

  // 4. Recipient bind.
  const ownerBytes = recipientOwner.toBytes();
  const { low, high } = splitOwnerHalves(ownerBytes);
  const recipientBindVal = await poseidonTagged('recipientBind', low, high);

  // 5. Witness.
  const tokenMintFr = leToFrReduced(mint.toBytes());
  const feeBind = await feeBindHash(0n, 0n);
  const dummySpendingPriv = 1n;
  const zeroCache = tree ? tree.zeroCache : await buildZeroCache();

  const witness: TransactWitness = {
    merkleRoot,
    nullifier: [nullifierVal, 0n],
    commitmentOut: [0n, 0n],
    publicAmountIn: 0n,
    publicAmountOut: note.value,
    publicTokenMint: tokenMintFr,
    relayerFee: 0n,
    relayerFeeBind: feeBind,
    rootBind: 0n,
    recipientBind: recipientBindVal,

    commitTag:        domainTag('commit'),
    nullTag:          domainTag('nullifier'),
    mkNodeTag:        domainTag('mkNode'),
    spendKeyPubTag:   domainTag('spendKeyPub'),
    feeBindTag:       domainTag('feeBind'),
    recipientBindTag: domainTag('recipientBind'),

    // Input 0 real, input 1 dummy.
    inTokenMint:    [note.tokenMint, 0n],
    inValue:        [note.value, 0n],
    inRandom:       [note.random, 0n],
    inSpendingPriv: [wallet.spendingPriv, dummySpendingPriv],
    inLeafIndex:    [note.leafIndex, 0n],
    inSiblings:     [proofMerkle.siblings, zeroCache.slice(0, 26)],
    inPathBits:     [proofMerkle.pathBits, Array(26).fill(0)],
    inIsDummy:      [0, 1],

    // No outputs — full unshield.
    outTokenMint:   [0n, 0n],
    outValue:       [0n, 0n],
    outRandom:      [0n, 0n],
    outSpendingPub: [0n, 0n],
    outIsDummy:     [1, 1],

    relayerFeeRecipient: 0n,
    recipientOwnerLow: low,
    recipientOwnerHigh: high,
  };

  // 6. Prove.
  const proof = await prover.prove(witness);
  if (proof.publicInputsLeBytes.length !== TRANSACT_PUBLIC_INPUT_COUNT) {
    throw new Error('prover returned wrong public input count');
  }

  // 7. Build the unshield instruction. Args layout:
  //    UnshieldArgs {
  //      proof: Vec<u8>,
  //      public_inputs: TransactPublicInputs,
  //      encrypted_notes: Vec<EncryptedNote>,
  //      in_dummy_mask: u8,
  //      out_dummy_mask: u8,
  //      nullifier_shard_prefix: [u16; 2],
  //      relayer_fee_recipient: Pubkey,
  //    }
  const ixData = concat(
    instructionDiscriminator('unshield'),
    vecU8(proof.proofBytes),
    // TransactPublicInputs
    proof.publicInputsLeBytes[0],          // merkleRoot
    proof.publicInputsLeBytes[1],          // nullifier[0]
    proof.publicInputsLeBytes[2],          // nullifier[1]
    proof.publicInputsLeBytes[3],          // commitmentOut[0]
    proof.publicInputsLeBytes[4],          // commitmentOut[1]
    u64Le(0n),                             // publicAmountIn
    u64Le(note.value),                     // publicAmountOut
    mint.toBytes(),                        // publicTokenMint
    u64Le(0n),                             // relayerFee
    proof.publicInputsLeBytes[9],          // relayerFeeBind
    proof.publicInputsLeBytes[10],         // rootBind
    proof.publicInputsLeBytes[11],         // recipientBind
    // encrypted_notes — empty for full unshield (no change notes).
    u32Le(0),
    new Uint8Array([0b10]),                // in_dummy_mask: input 0 real, input 1 dummy
    new Uint8Array([0b11]),                // out_dummy_mask: both dummy
    // nullifier_shard_prefix: [u16; 2]
    u16Le(prefix),
    u16Le(0),
    // relayer_fee_recipient — unused (fee=0), pass relayer's pubkey as a benign default
    relayer.publicKey.toBytes(),
  );

  const shard0 = nullifierShardPda(poolProgramId, prefix);
  const shard1 = nullifierShardPda(poolProgramId, 0);   // dummy — pool doesn't write to it

  const ix = new TransactionInstruction({
    programId: poolProgramId,
    keys: [
      { pubkey: relayer.publicKey,                isSigner: true,  isWritable: true  },
      { pubkey: poolConfigPda(poolProgramId),     isSigner: false, isWritable: false },
      { pubkey: tokenConfigPda(poolProgramId, mint), isSigner: false, isWritable: false },
      { pubkey: vaultPda(poolProgramId, mint),    isSigner: false, isWritable: true  },
      { pubkey: recipientTokenAccount,            isSigner: false, isWritable: true  },
      { pubkey: recipientTokenAccount,            isSigner: false, isWritable: true  }, // relayer_fee_token_account; reuse recipient when fee=0
      { pubkey: treeStatePda(poolProgramId),      isSigner: false, isWritable: true  },
      { pubkey: verifierProgramId,                isSigner: false, isWritable: false },
      { pubkey: shard0,                           isSigner: false, isWritable: true  },
      { pubkey: shard1,                           isSigner: false, isWritable: true  },
      { pubkey: TOKEN_PROGRAM_ID,                 isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId,          isSigner: false, isWritable: false },
    ],
    data: Buffer.from(ixData),
  });

  const cuIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 });

  const tx = new Transaction().add(cuIx, ix);
  tx.feePayer = relayer.publicKey;
  tx.recentBlockhash = (await connection.getLatestBlockhash('confirmed')).blockhash;
  tx.sign(relayer);

  const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  await connection.confirmTransaction(sig, 'confirmed');

  return {
    signature: sig,
    nullifier: nullifierVal,
    amountTransferred: note.value,
  };
}

// ---------- helpers ----------

function bigIntToLeBytes(v: bigint): Uint8Array {
  const out = new Uint8Array(32);
  let x = v;
  for (let i = 0; i < 32; i++) {
    out[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return out;
}

/** Split a 32-byte owner pubkey into two u128 LE halves. */
function splitOwnerHalves(owner: Uint8Array): { low: bigint; high: bigint } {
  if (owner.length !== 32) throw new Error('expected 32 bytes');
  let low = 0n;
  let high = 0n;
  for (let i = 0; i < 16; i++)  low  |= BigInt(owner[i]) << BigInt(8 * i);
  for (let i = 0; i < 16; i++)  high |= BigInt(owner[i + 16]) << BigInt(8 * i);
  return { low, high };
}

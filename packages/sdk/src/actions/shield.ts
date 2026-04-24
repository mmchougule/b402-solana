/**
 * `shield` — deposit clear tokens into the shielded pool.
 *
 * End-to-end flow:
 *   1. Fetch the current merkle root from on-chain (immediately before proof
 *      gen — root staleness window is 128 appends).
 *   2. Generate a fresh `random` for the output note.
 *   3. Compute commitment + encrypted-note ciphertext for the recipient (us).
 *   4. Build the witness (recipient_bind = zero owner; shield has no
 *      destination), call the prover.
 *   5. Construct the Anchor `shield` instruction with discriminator + Borsh
 *      args (proof as Vec<u8>, public_inputs struct, encrypted_notes,
 *      note_dummy_mask).
 *   6. Sign with depositor + relayer (relayer = depositor for self-submit;
 *      separate when gasless via relayer service).
 *   7. Submit, return signature + commitment + leaf index.
 */

import {
  ComputeBudgetProgram, Connection, Keypair, PublicKey, SystemProgram,
  Transaction, TransactionInstruction,
} from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { randomBytes } from '@noble/hashes/utils';

import {
  FR_MODULUS, frToLe, leToFrReduced, u64ToFrLe,
  TRANSACT_PUBLIC_INPUT_COUNT,
} from '@b402ai/solana-shared';

import { TransactProver, type TransactWitness } from '@b402ai/solana-prover';

import {
  poolConfigPda, treeStatePda, tokenConfigPda, vaultPda,
} from '../programs/pda.js';
import { fetchTreeState } from '../programs/tree-state.js';
import { instructionDiscriminator, concat, u32Le, u64Le, vecU8 } from '../programs/anchor.js';
import { commitmentHash, spendingPub, feeBindHash, poseidonTagged } from '../poseidon.js';
import { buildZeroCache } from '../merkle.js';
import { encryptNote, type EncryptedNote } from '../note-encryption.js';
import type { Wallet } from '../wallet.js';
import type { SpendableNote } from '@b402ai/solana-shared';

export interface ShieldParams {
  connection: Connection;
  poolProgramId: PublicKey;
  verifierProgramId: PublicKey;
  prover: TransactProver;
  wallet: Wallet;
  /** SPL mint of the token being shielded. */
  mint: PublicKey;
  /** Source ATA for `mint`, owned by `depositor`. */
  depositorAta: PublicKey;
  /** Signer authorizing the SPL transfer out of `depositorAta`. */
  depositor: Keypair;
  /** Pays SOL fee + lamports for any new accounts. */
  relayer: Keypair;
  /** u64 amount of `mint` smallest-units to shield. */
  amount: bigint;
  /**
   * Skip on-chain encrypted-note publication to save ~120 B/note in the tx.
   * SAFE only for self-shields (depositor == future spender) — third-party
   * recipients can't discover their notes without the on-chain ciphertext.
   * Default true; set false when sending to a different recipient.
   */
  omitEncryptedNotes?: boolean;
}

export interface ShieldResult {
  signature: string;
  commitment: bigint;
  /** Leaf index the new commitment occupies in the tree. */
  leafIndex: bigint;
  /** Owned-note record the caller can hand straight to NoteStore. */
  note: SpendableNote;
}

const MOCK_DEPOSITOR_PROVES_OWNERSHIP = true; // placeholder for future delegated-shield flow
void MOCK_DEPOSITOR_PROVES_OWNERSHIP;

export async function shield(params: ShieldParams): Promise<ShieldResult> {
  const {
    connection, poolProgramId, verifierProgramId, prover, wallet,
    mint, depositorAta, depositor, relayer, amount,
  } = params;

  if (amount <= 0n || amount >= (1n << 64n)) {
    throw new Error('amount out of u64 range');
  }

  // 1. Fetch current merkle root.
  const tree = await fetchTreeState(connection, treeStatePda(poolProgramId));
  const merkleRoot = leToFrReduced(tree.currentRoot);

  // 2. Generate fresh randomness for the output note.
  const randomBytes32 = randomBytes(32);
  const random = leToFrReduced(randomBytes32);
  const tokenMintFr = leToFrReduced(mint.toBytes());

  // 3. Compute commitment + encrypt note for ourselves.
  const commitment = await commitmentHash(tokenMintFr, amount, random, wallet.spendingPub);
  const expectedLeafIndex = tree.leafCount;
  const encrypted = await encryptNote(
    { tokenMint: tokenMintFr, value: amount, random, spendingPub: wallet.spendingPub },
    wallet.viewingPub,
    expectedLeafIndex,
  );

  // 4. Build witness. Shield = 2 dummy inputs, 1 real output, recipient bind = zero.
  const recipLow = 0n;
  const recipHigh = 0n;
  const recipientBindVal = await poseidonTagged('recipientBind', recipLow, recipHigh);
  const feeBind = await feeBindHash(0n, 0n);

  const dummySpendingPriv = 1n;
  const dummySpendingPub = await spendingPub(dummySpendingPriv);
  void dummySpendingPub; // not needed in witness; we set inIsDummy=1

  const zeroCache = await buildZeroCache();

  const witness: TransactWitness = {
    merkleRoot,
    nullifier: [0n, 0n],
    commitmentOut: [commitment, 0n],
    publicAmountIn: amount,
    publicAmountOut: 0n,
    publicTokenMint: tokenMintFr,
    relayerFee: 0n,
    relayerFeeBind: feeBind,
    rootBind: 0n,
    recipientBind: recipientBindVal,

    commitTag:        domainTagFr('commit'),
    nullTag:          domainTagFr('nullifier'),
    mkNodeTag:        domainTagFr('mkNode'),
    spendKeyPubTag:   domainTagFr('spendKeyPub'),
    feeBindTag:       domainTagFr('feeBind'),
    recipientBindTag: domainTagFr('recipientBind'),

    // Both inputs dummy.
    inTokenMint:    [0n, 0n],
    inValue:        [0n, 0n],
    inRandom:       [0n, 0n],
    inSpendingPriv: [dummySpendingPriv, dummySpendingPriv],
    inLeafIndex:    [0n, 0n],
    inSiblings:     [zeroCache.slice(0, 26), zeroCache.slice(0, 26)],
    inPathBits:     [Array(26).fill(0), Array(26).fill(0)],
    inIsDummy:      [1, 1],

    // Output 0: real shielded note for us.
    outTokenMint:   [tokenMintFr, 0n],
    outValue:       [amount, 0n],
    outRandom:      [random, 0n],
    outSpendingPub: [wallet.spendingPub, 0n],
    outIsDummy:     [0, 1],

    relayerFeeRecipient: 0n,
    recipientOwnerLow: recipLow,
    recipientOwnerHigh: recipHigh,
  };

  // 5. Generate proof.
  const proof = await prover.prove(witness);
  if (proof.publicInputsLeBytes.length !== TRANSACT_PUBLIC_INPUT_COUNT) {
    throw new Error('prover returned wrong public input count');
  }

  if (process.env.B402_DEBUG === '1') {
    const labels = ['root','n0','n1','c0','c1','pAmtIn','pAmtOut','pTokMint','fee','feeBind','rootBind','recipBind','commitTag','nullTag','mkNodeTag','spendKeyPubTag','feeBindTag','recipBindTag'];
    for (let i = 0; i < proof.publicInputsLeBytes.length; i++) {
      const hex = Array.from(proof.publicInputsLeBytes[i]).map(b => b.toString(16).padStart(2,'0')).join('');
      // eslint-disable-next-line no-console
      console.error(`  pi[${i.toString().padStart(2,' ')}] ${labels[i].padEnd(15,' ')} = ${hex}`);
    }
    const mintHex = Array.from(mint.toBytes()).map(b => b.toString(16).padStart(2,'0')).join('');
    const wireRoot = Array.from(proof.publicInputsLeBytes[0]).map(b => b.toString(16).padStart(2,'0')).join('');
    // eslint-disable-next-line no-console
    console.error(`  WIRE merkleRoot                 = ${wireRoot}`);
    console.error(`  WIRE publicTokenMint (raw mint) = ${mintHex}`);
  }

  // 6. Build Anchor instruction. Args: ShieldArgs { proof: Vec<u8>,
  // public_inputs: TransactPublicInputs, encrypted_notes: Vec<EncryptedNote>,
  // note_dummy_mask: u8 }
  const ixData = concat(
    instructionDiscriminator('shield'),
    // proof: Vec<u8>
    vecU8(proof.proofBytes),
    // TransactPublicInputs
    encodePublicInputs({
      merkleRoot:       proof.publicInputsLeBytes[0],
      nullifier0:       proof.publicInputsLeBytes[1],
      nullifier1:       proof.publicInputsLeBytes[2],
      commitmentOut0:   proof.publicInputsLeBytes[3],
      commitmentOut1:   proof.publicInputsLeBytes[4],
      publicAmountIn:   amount,
      publicAmountOut:  0n,
      publicTokenMintBytes: mint.toBytes(),
      relayerFee:       0n,
      relayerFeeBind:   proof.publicInputsLeBytes[9],
      rootBind:         proof.publicInputsLeBytes[10],
      recipientBind:    proof.publicInputsLeBytes[11],
    }),
    // encrypted_notes: Vec<EncryptedNote(89 + 32 + 2)>. Pool accepts 0..=2.
    // Omit fully on self-shields to fit under the 1232-byte tx limit; the
    // depositor knows the note locally without needing on-chain ciphertext.
    encodeEncryptedNotes(
      params.omitEncryptedNotes ?? true ? [] : [encrypted],
    ),
    // note_dummy_mask: u8 — bit 1 = output 1 dummy
    new Uint8Array([0b10]),
  );

  const shieldIx = new TransactionInstruction({
    programId: poolProgramId,
    keys: [
      { pubkey: relayer.publicKey,       isSigner: true,  isWritable: true  },
      { pubkey: depositor.publicKey,     isSigner: true,  isWritable: true  },
      { pubkey: depositorAta,            isSigner: false, isWritable: true  },
      { pubkey: tokenConfigPda(poolProgramId, mint), isSigner: false, isWritable: false },
      { pubkey: vaultPda(poolProgramId, mint),       isSigner: false, isWritable: true  },
      { pubkey: treeStatePda(poolProgramId),         isSigner: false, isWritable: true  },
      { pubkey: poolConfigPda(poolProgramId),        isSigner: false, isWritable: false },
      { pubkey: verifierProgramId,                   isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID,                    isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId,             isSigner: false, isWritable: false },
    ],
    data: Buffer.from(ixData),
  });

  const cuIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 });

  // 7. Sign and submit.
  const tx = new Transaction().add(cuIx, shieldIx);
  tx.feePayer = relayer.publicKey;
  tx.recentBlockhash = (await connection.getLatestBlockhash('confirmed')).blockhash;

  // Order matters: relayer first (fee payer), then depositor. Same keypair OK
  // (web3.js de-duplicates signers).
  const signers = relayer.publicKey.equals(depositor.publicKey)
    ? [relayer]
    : [relayer, depositor];
  tx.sign(...signers);

  const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  await connection.confirmTransaction(sig, 'confirmed');

  // 8. Construct the SpendableNote record so the caller can hand straight to NoteStore.
  const note: SpendableNote = {
    tokenMint: tokenMintFr,
    value: amount,
    random,
    spendingPub: wallet.spendingPub,
    commitment,
    leafIndex: expectedLeafIndex,
    spendingPriv: wallet.spendingPriv,
    encryptedBytes: encrypted.ciphertext,
    ephemeralPub: encrypted.ephemeralPub,
    viewingTag: encrypted.viewingTag,
  };

  return { signature: sig, commitment, leafIndex: expectedLeafIndex, note };
}

// ---------- helpers ----------

function makeEmptyEncryptedNote(): EncryptedNote {
  return {
    ciphertext: new Uint8Array(89),
    ephemeralPub: new Uint8Array(32),
    viewingTag: new Uint8Array(2),
  };
}

interface PublicInputsForEncoding {
  merkleRoot: Uint8Array;
  nullifier0: Uint8Array;
  nullifier1: Uint8Array;
  commitmentOut0: Uint8Array;
  commitmentOut1: Uint8Array;
  publicAmountIn: bigint;
  publicAmountOut: bigint;
  publicTokenMintBytes: Uint8Array;
  relayerFee: bigint;
  relayerFeeBind: Uint8Array;
  rootBind: Uint8Array;
  recipientBind: Uint8Array;
}

/** Borsh-encode TransactPublicInputs in the exact field order pool expects. */
function encodePublicInputs(p: PublicInputsForEncoding): Uint8Array {
  return concat(
    p.merkleRoot,
    p.nullifier0,
    p.nullifier1,
    p.commitmentOut0,
    p.commitmentOut1,
    u64Le(p.publicAmountIn),
    u64Le(p.publicAmountOut),
    p.publicTokenMintBytes,
    u64Le(p.relayerFee),
    p.relayerFeeBind,
    p.rootBind,
    p.recipientBind,
  );
}

function encodeEncryptedNotes(notes: EncryptedNote[]): Uint8Array {
  const len = u32Le(notes.length);
  const parts: Uint8Array[] = [len];
  for (const n of notes) {
    if (n.ciphertext.length !== 89) throw new Error('bad ciphertext length');
    if (n.ephemeralPub.length !== 32) throw new Error('bad ephemeralPub length');
    if (n.viewingTag.length !== 2) throw new Error('bad viewingTag length');
    parts.push(n.ciphertext, n.ephemeralPub, n.viewingTag);
  }
  return concat(...parts);
}

// Re-export domain-tag accessor for action builders that need raw values.
import { domainTag, type DomainTagName } from '@b402ai/solana-shared';
function domainTagFr(name: DomainTagName): bigint {
  return domainTag(name);
}
// silence unused-import diagnostic
void FR_MODULUS;
void frToLe;
void u64ToFrLe;

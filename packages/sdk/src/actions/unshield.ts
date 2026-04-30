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
  AddressLookupTableAccount,
  ComputeBudgetProgram, Connection, Keypair, PublicKey, SystemProgram,
  Transaction, TransactionInstruction, TransactionMessage, VersionedTransaction,
} from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';

import {
  TRANSACT_PUBLIC_INPUT_COUNT, domainTag, leToFrReduced,
} from '@b402ai/solana-shared';
import type { SpendableNote } from '@b402ai/solana-shared';
import { TransactProver, type TransactWitness } from '@b402ai/solana-prover';

import {
  poolConfigPda, treeStatePda, tokenConfigPda, vaultPda,
} from '../programs/pda.js';
import { fetchTreeState } from '../programs/tree-state.js';
import { instructionDiscriminator, concat, u32Le, u64Le, vecU8 } from '../programs/anchor.js';
import { ClientMerkleTree, type MerkleProof, buildZeroCache } from '../merkle.js';
import { nullifierHash, feeBindHash, poseidonTagged } from '../poseidon.js';
import type { Wallet } from '../wallet.js';
import type { RelayerHttpClient } from '../relayer-http.js';
import {
  B402_NULLIFIER_PROGRAM_ID,
  buildCreateNullifierIx,
  buildNullifierCpiAccounts,
  buildNullifierCpiPayload,
  getValidityProofForNullifier,
} from '../light-nullifier.js';

/** Sysvar instructions account. */
const SYSVAR_INSTRUCTIONS = new PublicKey('Sysvar1nstructions1111111111111111111111111');

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
  /** Local relayer keypair. Pays SOL fee + signs locally when `relayerHttp`
   *  is not set. The pubkey is also bound into the on-chain account at
   *  slot[0] — when `relayerHttp` is set, the remote service overwrites
   *  that slot with its own pubkey before signing. */
  relayer: Keypair;
  /** When set, submit via this remote relayer instead of local sign. The
   *  on-chain fee payer becomes the relayer's wallet — the user's keypair
   *  is never present in the resulting transaction. Privacy-preserving path. */
  relayerHttp?: RelayerHttpClient;
  /**
   * v2 nullifier-set: stateless.js Rpc client wired to Photon. Required
   * at v2 — without it, no validity proof can be fetched, which means
   * the b402_nullifier::create_nullifier sibling ix can't be built.
   * If omitted at call time, the function throws a clear error.
   * Test fixtures: `createRpc(undefined, 'http://127.0.0.1:8784')`.
   */
  photonRpc?: unknown;
  /**
   * v2 nullifier-set: ALT pubkey to compress the combined unshield +
   * b402_nullifier ix account list under Solana's 1232 B tx cap. The
   * ALT must include Light's static accounts (light_system_program,
   * registered_program_pda, account_compression_authority,
   * account_compression_program, sysvar_instructions, b402_nullifier
   * cpi_authority, output_queue), our pool's PDAs (pool_config,
   * tree_state, vault, token_config, verifier_transact), and SystemProgram.
   *
   * If omitted, the SDK tries to send legacy and will fail with
   * "Transaction too large" — caller must provide an ALT.
   */
  alt?: PublicKey;
  /**
   * Phase 7 — when true, pool CPIs into b402_nullifier::create_nullifier
   * directly instead of relying on a sibling create_nullifier ix in the
   * same tx. Saves ~50 wire bytes per unshield (drops the sibling-ix
   * envelope; pool ix data grows by 134 B for the validity-proof payload
   * but the per-ix overhead + redundant relayer/program references go
   * away). Only enable when targeting a pool deployed with
   * `--features inline_cpi_nullifier`. The deployed mainnet v2.1 pool
   * (slot ~416560668) does NOT support this and will reject the tx with
   * `InvalidInstructionData` because the args struct grows by one
   * `Vec<Vec<u8>>` field.
   */
  inlineNullifierCpi?: boolean;
}

export interface UnshieldResult {
  signature: string;
  nullifier: bigint;
  amountTransferred: bigint;
}

export async function unshield(params: UnshieldParams): Promise<UnshieldResult> {
  const {
    connection, poolProgramId, verifierProgramId, prover, wallet,
    mint, note, tree, merkleProof, recipientTokenAccount, recipientOwner, relayer, relayerHttp,
    photonRpc, alt, inlineNullifierCpi,
  } = params;
  if (!tree && !merkleProof) throw new Error('unshield: provide `tree` or `merkleProof`');

  // The relayer pubkey bound into the ix's account[0] + relayer_fee_recipient
  // placeholder. When the HTTP relayer is in use, we use ITS pubkey so the
  // on-chain accounts are consistent (the relayer service does still overwrite
  // account[0], but matching pubkeys means observers see the same wallet
  // regardless of mode). When no HTTP relayer, this is just the local relayer.
  const relayerPubkey = relayerHttp?.pubkey ?? relayer.publicKey;

  // 1. Fresh root.
  const onChain = await fetchTreeState(connection, treeStatePda(poolProgramId));
  const merkleRoot = leToFrReduced(onChain.currentRoot);

  // 2. Merkle path for the note — from precomputed proof or from client tree.
  const proofMerkle = merkleProof ?? await tree!.prove(note.leafIndex);

  // 3. Nullifier.
  const nullifierVal = await nullifierHash(wallet.spendingPriv, note.leafIndex);
  const nullifierLe = bigIntToLeBytes(nullifierVal);

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

  // 7. Fetch validity proof — needed in both modes (sibling-ix and inline).
  if (!photonRpc) {
    throw new Error('unshield: v2 requires `photonRpc` (stateless.js Rpc client). See PRD-30 §3.6.');
  }
  const validityProof = await getValidityProofForNullifier(photonRpc, nullifierLe);

  // 8. Build the v2 unshield instruction. Args layout:
  //    UnshieldArgs {
  //      proof: Vec<u8>,
  //      public_inputs: TransactPublicInputs,
  //      encrypted_notes: Vec<EncryptedNote>,
  //      in_dummy_mask: u8,
  //      out_dummy_mask: u8,
  //      relayer_fee_recipient: Pubkey,
  //      // Phase 7 (`inlineNullifierCpi`) ONLY:
  //      nullifier_cpi_payloads: Vec<Vec<u8>>,
  //    }
  // (v1 had `nullifier_shard_prefix: [u16; 2]` here — dropped in v2.)
  const ixDataParts: Uint8Array[] = [
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
    // relayer_fee_recipient — unused (fee=0), pass relayer's pubkey as a benign default
    relayerPubkey.toBytes(),
  ];
  if (inlineNullifierCpi) {
    // Vec<Vec<u8>> = u32(LE) outer-len, then per-entry vecU8.
    // 1 real nullifier in unshield (slot 0), so vec len = 1.
    ixDataParts.push(u32Le(1));
    ixDataParts.push(vecU8(buildNullifierCpiPayload(validityProof)));
  }
  const ixData = concat(...ixDataParts);

  // Pool ix account list. In sibling-ix mode (v2.1, mainnet today) the
  // instructions sysvar is at slot 8 and the pool walks it to verify the
  // sibling create_nullifier ix. In inline mode (Phase 7) the pool CPIs
  // into b402_nullifier itself, so the sysvar slot is unused — the pool
  // program tolerates any account in that slot (the sysvar address
  // constraint stays so legacy clients keep working). To keep the SDK
  // single-pathed for the named accounts, we leave the sysvar there in
  // both modes; the inline-mode handler simply doesn't read it.
  const baseKeys = [
    { pubkey: relayerPubkey,                    isSigner: true,  isWritable: true  },
    { pubkey: poolConfigPda(poolProgramId),     isSigner: false, isWritable: false },
    { pubkey: tokenConfigPda(poolProgramId, mint), isSigner: false, isWritable: false },
    { pubkey: vaultPda(poolProgramId, mint),    isSigner: false, isWritable: true  },
    { pubkey: recipientTokenAccount,            isSigner: false, isWritable: true  },
    { pubkey: recipientTokenAccount,            isSigner: false, isWritable: true  }, // relayer_fee_token_account; reuse when fee=0
    { pubkey: treeStatePda(poolProgramId),      isSigner: false, isWritable: true  },
    { pubkey: verifierProgramId,                isSigner: false, isWritable: false },
    { pubkey: SYSVAR_INSTRUCTIONS,              isSigner: false, isWritable: false },
    { pubkey: TOKEN_PROGRAM_ID,                 isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId,          isSigner: false, isWritable: false },
  ];
  // In inline mode, append the b402_nullifier program + its 10 accounts to
  // remaining_accounts. Layout matches `nullifier_cpi.rs::invoke_create_nullifier`:
  //   remaining[0]    = b402_nullifier program (readonly, non-signer)
  //   remaining[1..11] = 10 nullifier accounts (per buildNullifierCpiAccounts)
  //                     (payer, ix sysvar, light_system_program, …, output_queue)
  const remainingForInline = inlineNullifierCpi
    ? [
        { pubkey: B402_NULLIFIER_PROGRAM_ID, isSigner: false, isWritable: false },
        ...buildNullifierCpiAccounts(relayerPubkey, validityProof),
      ]
    : [];
  const unshieldIx = new TransactionInstruction({
    programId: poolProgramId,
    keys: [...baseKeys, ...remainingForInline],
    data: Buffer.from(ixData),
  });

  // 9. Build the sibling create_nullifier ix — only when NOT in inline
  //    mode. In inline mode the pool program builds the inner ix itself
  //    via `nullifier_cpi::invoke_create_nullifier`, saving ~50 wire B
  //    per tx (drops the sibling-ix envelope; pool ix data grows by
  //    1 + 134 = 135 B for the validity-proof payload, but the per-ix
  //    overhead + redundant relayer/program references go away).
  const nullifierIx = inlineNullifierCpi
    ? null
    : buildCreateNullifierIx(relayerPubkey, nullifierLe, validityProof);

  const cuIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 });

  let sig: string;
  if (relayerHttp) {
    // Sibling-ix mode: pass the b402_nullifier ix as `additionalIxs`. The
    // remote relayer appends it after the main unshield ix; pool's
    // instructions-sysvar walk verifies it on-chain.
    // Inline mode: no sibling ix to append.
    const r = await relayerHttp.submit({
      label: 'unshield',
      ix: unshieldIx,
      altAddresses: alt ? [alt] : [],
      computeUnitLimit: 1_400_000,
      additionalIxs: nullifierIx ? [nullifierIx] : [],
    });
    sig = r.signature;
    return { signature: sig, nullifier: nullifierVal, amountTransferred: note.value };
  } else {
    const blockhash = (await connection.getLatestBlockhash('confirmed')).blockhash;
    const ixs: TransactionInstruction[] = [cuIx, unshieldIx];
    if (nullifierIx) ixs.push(nullifierIx);
    if (alt) {
      // v2 default path: combined unshield + b402_nullifier ixs exceed
      // the 1232 B legacy cap. Use a versioned tx with ALT to compress
      // recurring account references.
      const altInfo = await connection.getAddressLookupTable(alt);
      if (!altInfo.value) throw new Error(`unshield: ALT ${alt.toBase58()} not found`);
      const lookupTable: AddressLookupTableAccount = altInfo.value;
      const msg = new TransactionMessage({
        payerKey: relayer.publicKey,
        recentBlockhash: blockhash,
        instructions: ixs,
      }).compileToV0Message([lookupTable]);
      const vtx = new VersionedTransaction(msg);
      vtx.sign([relayer]);
      sig = await connection.sendRawTransaction(vtx.serialize(), { skipPreflight: false });
    } else {
      const tx = new Transaction().add(...ixs);
      tx.feePayer = relayer.publicKey;
      tx.recentBlockhash = blockhash;
      tx.sign(relayer);
      sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
    }
    await connection.confirmTransaction(sig, 'confirmed');
  }

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

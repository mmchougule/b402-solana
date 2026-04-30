/**
 * Light-Protocol nullifier ix builder.
 *
 * v2 of the nullifier-set architecture: instead of writing nullifier
 * shard PDAs, the pool requires a sibling `b402_nullifier::create_nullifier`
 * ix in the same tx that lands the nullifier in Light Protocol's
 * address tree V2. Per-unshield gas drops from ~$13 (fresh shard rent)
 * to ~$0.003. See PRD-30.
 *
 * This module wraps:
 *   1. `getValidityProofForNullifier` — fetches a non-inclusion proof
 *      from Photon (default: http://127.0.0.1:8784 for localnet).
 *   2. `buildCreateNullifierIx` — assembles the ix calling our forked
 *      `b402_nullifier` program with the right Borsh-encoded args + the
 *      nine Light accounts.
 *
 * The flow per unshield:
 *   - SDK derives `nullifier = Poseidon(nullTag, spendingPriv, leafIndex)`
 *   - SDK calls `getValidityProofForNullifier(nullifier)` → Photon
 *   - SDK calls `buildCreateNullifierIx(...)` to get the sibling ix
 *   - Caller submits [pool::unshield, b402_nullifier::create_nullifier]
 *     in one tx
 */

import {
  AccountMeta,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from '@solana/web3.js';
import * as stateless from '@lightprotocol/stateless.js';

/** Forked nullifier program — see `programs/b402-nullifier/src/lib.rs::declare_id!`. */
export const B402_NULLIFIER_PROGRAM_ID = new PublicKey(
  '2AnRZwWu6CTurZs1yQpqrcJWo4yRYL1xpeV78b2siweq',
);

/** Anchor `sha256("global:create_nullifier")[..8]` — same as upstream. */
const DISCRIMINATOR = Buffer.from([171, 144, 50, 154, 87, 170, 57, 66]);

/** Domain tag — must match `programs/b402-nullifier/src/lib.rs::SEED_NULL`. */
const SEED_NULL = new TextEncoder().encode('b402/v1/null');

/** CPI-authority PDA derived from b402_nullifier program ID. */
const CPI_AUTHORITY = PublicKey.findProgramAddressSync(
  [Buffer.from('cpi_authority')],
  B402_NULLIFIER_PROGRAM_ID,
)[0];

export interface NullifierProof {
  /** Groth16 non-inclusion proof from Photon. */
  proof: { a: number[]; b: number[]; c: number[] };
  addressTreeInfo: {
    rootIndex: number;
    addressMerkleTreePubkeyIndex: number;
    addressQueuePubkeyIndex: number;
  };
  outputStateTreeIndex: number;
  outputQueue: PublicKey;
  addressTree: PublicKey;
}

/**
 * Fetch a non-inclusion validity proof from Photon for the given nullifier.
 *
 * `rpc` is a stateless.js Rpc client. Caller is responsible for constructing
 * it with the right Photon URL (defaults to localnet for tests).
 *
 * @param rpc — instance of stateless.js's `Rpc` (use `createRpc(solanaUrl, photonUrl)`)
 * @param nullifierLeBytes — 32-byte nullifier value (LE BN254 element bytes)
 */
export async function getValidityProofForNullifier(
  // We type as unknown to avoid a hard dep on @lightprotocol/stateless.js
  // at the SDK-package boundary; tests + relayer pass a real `Rpc`.
  rpc: unknown,
  nullifierLeBytes: Uint8Array,
): Promise<NullifierProof> {
  const address = deriveNullifierAddress(nullifierLeBytes);
  const r = rpc as ReturnType<typeof stateless.createRpc>;

  const proofResult = await r.getValidityProofV0(
    [],
    [
      {
        tree: new PublicKey(stateless.batchAddressTree),
        queue: new PublicKey(stateless.batchAddressTree),
        address: stateless.bn(address.toBytes()),
      },
    ],
  );
  if (!proofResult.compressedProof) {
    throw new Error('Photon returned no proof — address may already exist (double-spend)');
  }

  return {
    proof: proofResult.compressedProof,
    addressTreeInfo: {
      rootIndex: proofResult.rootIndices[0],
      addressMerkleTreePubkeyIndex: 0,
      addressQueuePubkeyIndex: 0,
    },
    outputStateTreeIndex: 1,
    outputQueue: new PublicKey('oq5oh5ZR3yGomuQgFduNDzjtGvVWfDRGLuDVjv9a96P'),
    addressTree: new PublicKey(stateless.batchAddressTree),
  };
}

/** Derive the address that `create_nullifier(id)` will insert. */
export function deriveNullifierAddress(nullifierLeBytes: Uint8Array): PublicKey {
  const seed = stateless.deriveAddressSeedV2([SEED_NULL, nullifierLeBytes]);
  return stateless.deriveAddressV2(
    seed,
    new PublicKey(stateless.batchAddressTree),
    B402_NULLIFIER_PROGRAM_ID,
  );
}

/**
 * Build the b402_nullifier::create_nullifier ix.
 *
 * @param payer — signer / fee-payer (relayer)
 * @param nullifierLeBytes — 32-byte nullifier value (the `id` arg)
 * @param proof — output of getValidityProofForNullifier
 */
export function buildCreateNullifierIx(
  payer: PublicKey,
  nullifierLeBytes: Uint8Array,
  proof: NullifierProof,
): TransactionInstruction {
  if (nullifierLeBytes.length !== 32) {
    throw new Error('nullifier id must be 32 bytes');
  }

  const data = Buffer.concat([
    DISCRIMINATOR,
    encodeProof(proof.proof),
    encodeAddressTreeInfo(proof.addressTreeInfo),
    Buffer.from([proof.outputStateTreeIndex]),
    Buffer.from(nullifierLeBytes),
  ]);

  const sys = stateless.defaultStaticAccountsStruct();

  const accounts: AccountMeta[] = [
    { pubkey: payer, isSigner: true, isWritable: true },
    { pubkey: stateless.LightSystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: CPI_AUTHORITY, isSigner: false, isWritable: false },
    { pubkey: sys.registeredProgramPda, isSigner: false, isWritable: false },
    { pubkey: sys.accountCompressionAuthority, isSigner: false, isWritable: false },
    { pubkey: sys.accountCompressionProgram, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: proof.addressTree, isSigner: false, isWritable: true },
    { pubkey: proof.outputQueue, isSigner: false, isWritable: true },
  ];

  return new TransactionInstruction({
    programId: B402_NULLIFIER_PROGRAM_ID,
    keys: accounts,
    data,
  });
}

/** Borsh: ValidityProof = Option<CompressedProof> = 1 byte (Some) + 32+64+32 bytes. */
function encodeProof(p: { a: number[]; b: number[]; c: number[] }): Buffer {
  return Buffer.concat([
    Buffer.from([1]),
    Buffer.from(p.a),
    Buffer.from(p.b),
    Buffer.from(p.c),
  ]);
}

/** Borsh layout for PackedAddressTreeInfo. */
function encodeAddressTreeInfo(info: {
  rootIndex: number;
  addressMerkleTreePubkeyIndex: number;
  addressQueuePubkeyIndex: number;
}): Buffer {
  const buf = Buffer.alloc(4);
  buf.writeUInt8(info.addressMerkleTreePubkeyIndex, 0);
  buf.writeUInt8(info.addressQueuePubkeyIndex, 1);
  buf.writeUInt16LE(info.rootIndex, 2);
  return buf;
}

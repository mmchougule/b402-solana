/**
 * b402_nullifier — TypeScript SDK helper for the integration tests.
 *
 * Mirrors `src/sdk.ts` from upstream Lightprotocol/nullifier-program with
 * our changes:
 *   - PROGRAM_ID points at our forked program
 *   - Address derivation uses seed `b"b402/v1/null"` (matches our domain
 *     tag) instead of `b"nullifier"`
 *
 * This file is part of the test harness. Production SDK changes for the
 * pool's CPI flow live in packages/sdk/ in Phase 4.
 */

import {
  PublicKey,
  TransactionInstruction,
  AccountMeta,
  SystemProgram,
} from '@solana/web3.js';
import {
  bn,
  batchAddressTree,
  deriveAddressSeedV2,
  deriveAddressV2,
  Rpc,
  LightSystemProgram,
  defaultStaticAccountsStruct,
} from '@lightprotocol/stateless.js';

/** Our forked b402_nullifier program ID. */
export const PROGRAM_ID = new PublicKey(
  '2AnRZwWu6CTurZs1yQpqrcJWo4yRYL1xpeV78b2siweq',
);

/** Light V2 batch address tree pubkey. */
export const ADDRESS_TREE = new PublicKey(batchAddressTree);

/** Light V2 batch output queue 5. Same as upstream uses. */
export const OUTPUT_QUEUE = new PublicKey(
  'oq5oh5ZR3yGomuQgFduNDzjtGvVWfDRGLuDVjv9a96P',
);

/** Anchor instruction discriminator for `b402_nullifier::create_nullifier`.
 *  Computed as first 8 bytes of sha256("global:create_nullifier"). Same as
 *  upstream because the function name is unchanged. */
const DISCRIMINATOR = Buffer.from([171, 144, 50, 154, 87, 170, 57, 66]);

/** Domain tag — must exactly match `SEED_NULL` in `programs/b402-nullifier/src/lib.rs`. */
const SEED_NULL = new TextEncoder().encode('b402/v1/null');

/** CPI-authority PDA derived from our program ID. */
const CPI_AUTHORITY = PublicKey.findProgramAddressSync(
  [Buffer.from('cpi_authority')],
  PROGRAM_ID,
)[0];

/** Derive the address that `create_nullifier(id)` will try to insert. */
export function deriveNullifierAddress(id: Uint8Array): PublicKey {
  const seed = deriveAddressSeedV2([SEED_NULL, id]);
  return deriveAddressV2(seed, ADDRESS_TREE, PROGRAM_ID);
}

export interface ProofResult {
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

/** Fetch a non-inclusion validity proof from Photon for the given id. */
export async function fetchProof(rpc: Rpc, id: Uint8Array): Promise<ProofResult> {
  const address = deriveNullifierAddress(id);
  const proofResult = await rpc.getValidityProofV0(
    [],
    [{ tree: ADDRESS_TREE, queue: ADDRESS_TREE, address: bn(address.toBytes()) }],
  );
  if (!proofResult.compressedProof) {
    throw new Error('No proof returned — address may already exist');
  }
  return {
    proof: proofResult.compressedProof,
    addressTreeInfo: {
      rootIndex: proofResult.rootIndices[0],
      addressMerkleTreePubkeyIndex: 0,
      addressQueuePubkeyIndex: 0,
    },
    outputStateTreeIndex: 1,
    outputQueue: OUTPUT_QUEUE,
    addressTree: ADDRESS_TREE,
  };
}

/** Build the create_nullifier instruction. */
export function buildInstruction(
  payer: PublicKey,
  id: Uint8Array,
  proofResult: ProofResult,
  overrides: { addressTree?: PublicKey } = {},
): TransactionInstruction {
  const data = Buffer.concat([
    DISCRIMINATOR,
    encodeProof(proofResult.proof),
    encodeAddressTreeInfo(proofResult.addressTreeInfo),
    Buffer.from([proofResult.outputStateTreeIndex]),
    Buffer.from(id),
  ]);
  const sys = defaultStaticAccountsStruct();
  const accounts: AccountMeta[] = [
    { pubkey: payer, isSigner: true, isWritable: true },
    { pubkey: LightSystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: CPI_AUTHORITY, isSigner: false, isWritable: false },
    { pubkey: sys.registeredProgramPda, isSigner: false, isWritable: false },
    { pubkey: sys.accountCompressionAuthority, isSigner: false, isWritable: false },
    { pubkey: sys.accountCompressionProgram, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: overrides.addressTree ?? proofResult.addressTree, isSigner: false, isWritable: true },
    { pubkey: proofResult.outputQueue, isSigner: false, isWritable: true },
  ];
  return new TransactionInstruction({ programId: PROGRAM_ID, keys: accounts, data });
}

/** All-in-one: fetch proof + build ix. */
export async function createNullifierIx(
  rpc: Rpc,
  payer: PublicKey,
  id: Uint8Array,
): Promise<TransactionInstruction> {
  const proofResult = await fetchProof(rpc, id);
  return buildInstruction(payer, id, proofResult);
}

/** Borsh: ValidityProof = Option<CompressedProof> = 1 byte (Some) + 32+64+32 bytes. */
function encodeProof(p: { a: number[]; b: number[]; c: number[] }): Buffer {
  return Buffer.concat([Buffer.from([1]), Buffer.from(p.a), Buffer.from(p.b), Buffer.from(p.c)]);
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

/**
 * AdaptV2Prover — Groth16 proof generation for the b402 adapt v2 circuit.
 *
 * Sibling of AdaptProver. v2 ABI per PRD-11 / PRD-12 / PRD-13 / PRD-15:
 *   - vector token bindings (M=4 in / N=4 out)
 *   - content-addressed actionHash (Poseidon_6)
 *   - shadow PDA binding
 *   - deadline_slot
 *
 * Output: 38 public inputs (was 23 in v1).
 */

// @ts-expect-error — snarkjs lacks types
import * as snarkjs from 'snarkjs';
import fs from 'node:fs';

import {
  g1JacFromSnarkjs, g2JacFromSnarkjs,
  g1ToBytes64, g1ToBytes64ProofA, g2ToBytes128,
  decToBeBytes32,
} from './g1g2.js';

/** Adapt v2 circuit has 38 public inputs per circuits/adapt_v2.circom. */
export const ADAPT_V2_PUBLIC_INPUT_COUNT = 38;

export interface AdaptV2Witness {
  // ===== Public inputs =====
  merkleRoot: bigint;
  nullifier: [bigint, bigint, bigint, bigint];
  commitmentOut: [bigint, bigint, bigint, bigint];
  publicAmountIn: bigint;
  publicAmountOut: bigint;                       // adapt requires 0
  publicTokenMintIn: [bigint, bigint, bigint, bigint];
  relayerFee: bigint;
  relayerFeeBind: bigint;
  rootBind: bigint;
  recipientBind: bigint;

  commitTag: bigint;
  nullTag: bigint;
  mkNodeTag: bigint;
  spendKeyPubTag: bigint;
  feeBindTag: bigint;
  recipientBindTag: bigint;

  adapterId: bigint;
  actionHash: bigint;
  expectedOutValue: bigint;
  expectedOutMint: [bigint, bigint, bigint, bigint];
  adaptBindTag: bigint;
  scopeTag: bigint;
  accountsHash: bigint;
  extraContextRoot: bigint;
  deadlineSlot: bigint;
  shadowPdaBinding: bigint;

  // ===== Private inputs =====
  inTokenMint: [bigint, bigint, bigint, bigint];
  inValue: [bigint, bigint, bigint, bigint];
  inRandom: [bigint, bigint, bigint, bigint];
  inSpendingPriv: [bigint, bigint, bigint, bigint];
  inLeafIndex: [bigint, bigint, bigint, bigint];
  inSiblings: [bigint[], bigint[], bigint[], bigint[]];
  inPathBits: [number[], number[], number[], number[]];
  inIsDummy: [0 | 1, 0 | 1, 0 | 1, 0 | 1];

  outTokenMint: [bigint, bigint, bigint, bigint];
  outValue: [bigint, bigint, bigint, bigint];
  outRandom: [bigint, bigint, bigint, bigint];
  outSpendingPub: [bigint, bigint, bigint, bigint];
  outIsDummy: [0 | 1, 0 | 1, 0 | 1, 0 | 1];

  relayerFeeRecipient: bigint;
  recipientOwnerLow: bigint;
  recipientOwnerHigh: bigint;

  /** keccak256(action_payload) reduced mod p (private witness, ixDataHash in PRD-12). */
  actionPayloadKeccakFr: bigint;

  /** PRD-13 shadow PDA private inputs. */
  shadowDomainTag: bigint;   // = TAG_SHADOW_BIND Fr; private witness for the prover
  viewingPubHash: bigint;    // = Poseidon hash of viewing key; zero when unused
}

export interface ProverArtifacts {
  wasmPath: string;
  zkeyPath: string;
  vkeyPath?: string;
}

export interface AdaptV2Proof {
  /** 256 bytes: proofA(64, y-negated) || proofB(128) || proofC(64). */
  proofBytes: Uint8Array;
  /** 38 × 32 bytes LE. */
  publicInputsLeBytes: Uint8Array[];
  /** Decimal strings. */
  publicSignals: string[];
}

const P = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

/** Encode an ASCII tag (≤31 bytes) as Fr per house convention. */
export function tagToFr(tag: string): bigint {
  if (tag.length > 31) throw new Error(`tag too long: ${tag.length}`);
  let acc = 0n;
  for (let i = 0; i < tag.length; i++) acc = (acc << 8n) | BigInt(tag.charCodeAt(i));
  return acc % P;
}

/** PRD-12 §3 canonical AccountMeta serialization. */
export interface CanonAccountMeta {
  pubkey: Uint8Array;   // 32 bytes
  isSigner: boolean;
  isWritable: boolean;
}

/**
 * Compute keccak(canonical(accounts)) reduced mod p, matching the on-chain
 * pool handler's `compute_accounts_hash_fr`.
 */
export async function computeAccountsHashFr(accounts: CanonAccountMeta[]): Promise<bigint> {
  // @ts-expect-error — @noble/hashes lacks types in this monorepo wiring
  const { keccak_256 } = await import('@noble/hashes/sha3');
  const sorted = [...accounts].sort((a, b) => {
    const c = compareBytes(a.pubkey, b.pubkey);
    if (c !== 0) return c;
    if (a.isSigner !== b.isSigner) return a.isSigner ? -1 : 1;
    if (a.isWritable !== b.isWritable) return a.isWritable ? -1 : 1;
    return 0;
  });
  const buf = new Uint8Array(sorted.length * 33);
  for (let i = 0; i < sorted.length; i++) {
    buf.set(sorted[i].pubkey, i * 33);
    const flags = ((sorted[i].isSigner ? 1 : 0) << 1) | (sorted[i].isWritable ? 1 : 0);
    buf[i * 33 + 32] = flags;
  }
  const h = keccak_256(buf) as Uint8Array;
  return leToFrReduced(h);
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return a.length - b.length;
}

function leToFrReduced(bytes: Uint8Array): bigint {
  let v = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) v = (v << 8n) | BigInt(bytes[i]);
  return v % P;
}

/**
 * Compute the PRD-12 content-addressed action hash off-chain.
 * Must match the on-chain handler in `programs/b402-pool/src/instructions/adapt_execute_v2.rs`.
 */
export async function computeActionHashV2(args: {
  /** TAG_ADAPT_BIND_V2 Fr. */
  domainTag: bigint;
  adapterId: bigint;
  scopeTag: bigint;
  /** = keccak256(actionPayload) reduced mod p. */
  ixDataHashFr: bigint;
  accountsHash: bigint;
  extraContextRoot: bigint;
}): Promise<bigint> {
  // @ts-expect-error — circomlibjs lacks types
  const { buildPoseidon } = await import('circomlibjs');
  const p = await buildPoseidon();
  const h = p([
    p.F.e(args.domainTag.toString()),
    p.F.e(args.adapterId.toString()),
    p.F.e(args.scopeTag.toString()),
    p.F.e(args.ixDataHashFr.toString()),
    p.F.e(args.accountsHash.toString()),
    p.F.e(args.extraContextRoot.toString()),
  ]);
  return BigInt(p.F.toString(h));
}

/**
 * Compute PRD-13 shadow PDA binding off-chain.
 *   shadowPdaBinding = Poseidon_3(TAG_SHADOW_BIND, viewingPubHash, scopeTag)
 */
export async function computeShadowPdaBinding(args: {
  shadowDomainTag: bigint;
  viewingPubHash: bigint;
  scopeTag: bigint;
}): Promise<bigint> {
  // @ts-expect-error — circomlibjs lacks types
  const { buildPoseidon } = await import('circomlibjs');
  const p = await buildPoseidon();
  const h = p([
    p.F.e(args.shadowDomainTag.toString()),
    p.F.e(args.viewingPubHash.toString()),
    p.F.e(args.scopeTag.toString()),
  ]);
  return BigInt(p.F.toString(h));
}

export class AdaptV2Prover {
  constructor(private readonly artifacts: ProverArtifacts) {
    for (const p of [artifacts.wasmPath, artifacts.zkeyPath]) {
      if (!fs.existsSync(p)) {
        throw new Error(`adapt v2 prover artifact missing: ${p}`);
      }
    }
  }

  async prove(witness: AdaptV2Witness): Promise<AdaptV2Proof> {
    const input = witnessToSnarkjsInput(witness);
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(
      input, this.artifacts.wasmPath, this.artifacts.zkeyPath,
    );

    if (publicSignals.length !== ADAPT_V2_PUBLIC_INPUT_COUNT) {
      throw new Error(
        `adapt v2 public signal count mismatch: got ${publicSignals.length}, expected ${ADAPT_V2_PUBLIC_INPUT_COUNT}`,
      );
    }

    const aJac = await g1JacFromSnarkjs(proof.pi_a as [string, string, string]);
    const bJac = await g2JacFromSnarkjs(proof.pi_b as [[string, string], [string, string], [string, string]]);
    const cJac = await g1JacFromSnarkjs(proof.pi_c as [string, string, string]);

    const aBytes = await g1ToBytes64ProofA(aJac);
    const bBytes = await g2ToBytes128(bJac);
    const cBytes = await g1ToBytes64(cJac);

    const proofBytes = new Uint8Array(256);
    proofBytes.set(aBytes, 0);
    proofBytes.set(bBytes, 64);
    proofBytes.set(cBytes, 192);

    const publicInputsBe = (publicSignals as string[]).map(decToBeBytes32);
    const publicInputsLeBytes = publicInputsBe.map((be) => {
      const le = new Uint8Array(32);
      for (let i = 0; i < 32; i++) le[i] = be[31 - i];
      return le;
    });

    return {
      proofBytes,
      publicInputsLeBytes,
      publicSignals: publicSignals as string[],
    };
  }
}

function witnessToSnarkjsInput(w: AdaptV2Witness): Record<string, unknown> {
  const tostr = (x: bigint) => x.toString();
  return {
    merkleRoot: tostr(w.merkleRoot),
    nullifier: w.nullifier.map(tostr),
    commitmentOut: w.commitmentOut.map(tostr),
    publicAmountIn: tostr(w.publicAmountIn),
    publicAmountOut: tostr(w.publicAmountOut),
    publicTokenMintIn: w.publicTokenMintIn.map(tostr),
    relayerFee: tostr(w.relayerFee),
    relayerFeeBind: tostr(w.relayerFeeBind),
    rootBind: tostr(w.rootBind),
    recipientBind: tostr(w.recipientBind),
    commitTag: tostr(w.commitTag),
    nullTag: tostr(w.nullTag),
    mkNodeTag: tostr(w.mkNodeTag),
    spendKeyPubTag: tostr(w.spendKeyPubTag),
    feeBindTag: tostr(w.feeBindTag),
    recipientBindTag: tostr(w.recipientBindTag),
    adapterId: tostr(w.adapterId),
    actionHash: tostr(w.actionHash),
    expectedOutValue: tostr(w.expectedOutValue),
    expectedOutMint: w.expectedOutMint.map(tostr),
    adaptBindTag: tostr(w.adaptBindTag),
    scopeTag: tostr(w.scopeTag),
    accountsHash: tostr(w.accountsHash),
    extraContextRoot: tostr(w.extraContextRoot),
    deadlineSlot: tostr(w.deadlineSlot),
    shadowPdaBinding: tostr(w.shadowPdaBinding),
    inTokenMint: w.inTokenMint.map(tostr),
    inValue: w.inValue.map(tostr),
    inRandom: w.inRandom.map(tostr),
    inSpendingPriv: w.inSpendingPriv.map(tostr),
    inLeafIndex: w.inLeafIndex.map(tostr),
    inSiblings: w.inSiblings.map((row) => row.map(tostr)),
    inPathBits: w.inPathBits.map((row) => row.map(String)),
    inIsDummy: w.inIsDummy.map(String),
    outTokenMint: w.outTokenMint.map(tostr),
    outValue: w.outValue.map(tostr),
    outRandom: w.outRandom.map(tostr),
    outSpendingPub: w.outSpendingPub.map(tostr),
    outIsDummy: w.outIsDummy.map(String),
    relayerFeeRecipient: tostr(w.relayerFeeRecipient),
    recipientOwnerLow: tostr(w.recipientOwnerLow),
    recipientOwnerHigh: tostr(w.recipientOwnerHigh),
    actionPayloadKeccakFr: tostr(w.actionPayloadKeccakFr),
    shadowDomainTag: tostr(w.shadowDomainTag),
    viewingPubHash: tostr(w.viewingPubHash),
  };
}

/**
 * AdaptProver — Groth16 proof generation for the b402 adapt circuit.
 *
 * Sibling of TransactProver, different witness shape + VK. Output has 23
 * public inputs (18 transact-layout + 5 adapt-specific: adapterId,
 * actionHash, expectedOutValue, expectedOutMint, adaptBindTag).
 */

// @ts-expect-error — snarkjs lacks types
import * as snarkjs from 'snarkjs';
import fs from 'node:fs';

import {
  g1JacFromSnarkjs, g2JacFromSnarkjs,
  g1ToBytes64, g1ToBytes64ProofA, g2ToBytes128,
  decToBeBytes32,
} from './g1g2.js';

/** Adapt circuit has 23 public inputs per circuits/adapt.circom. */
export const ADAPT_PUBLIC_INPUT_COUNT = 23;

export interface AdaptWitness {
  // First 18 — identical to transact layout.
  merkleRoot: bigint;
  nullifier: [bigint, bigint];
  commitmentOut: [bigint, bigint];
  publicAmountIn: bigint;
  publicAmountOut: bigint;        // adapt requires 0
  publicTokenMint: bigint;         // IN mint as Fr
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

  // Adapt-specific — 5 more.
  adapterId: bigint;
  actionHash: bigint;
  expectedOutValue: bigint;
  expectedOutMint: bigint;         // OUT mint as Fr
  adaptBindTag: bigint;

  // Private inputs.
  inTokenMint: [bigint, bigint];
  inValue: [bigint, bigint];
  inRandom: [bigint, bigint];
  inSpendingPriv: [bigint, bigint];
  inLeafIndex: [bigint, bigint];
  inSiblings: [bigint[], bigint[]];
  inPathBits: [number[], number[]];
  inIsDummy: [0 | 1, 0 | 1];

  // Note: adapt circuit derives outTokenMint from expectedOutMint, so the
  // witness does NOT carry outTokenMint.
  outValue: [bigint, bigint];
  outRandom: [bigint, bigint];
  outSpendingPub: [bigint, bigint];
  outIsDummy: [0 | 1, 0 | 1];

  relayerFeeRecipient: bigint;
  recipientOwnerLow: bigint;
  recipientOwnerHigh: bigint;

  /** keccak256(action_payload) reduced mod p. */
  actionPayloadKeccakFr: bigint;
}

export interface ProverArtifacts {
  wasmPath: string;
  zkeyPath: string;
  vkeyPath?: string;
}

export interface AdaptProof {
  /** 256 bytes: proofA(64, y-negated) || proofB(128) || proofC(64). */
  proofBytes: Uint8Array;
  /** 23 × 32 bytes LE. */
  publicInputsLeBytes: Uint8Array[];
  /** Decimal strings. */
  publicSignals: string[];
}

export class AdaptProver {
  constructor(private readonly artifacts: ProverArtifacts) {
    for (const p of [artifacts.wasmPath, artifacts.zkeyPath]) {
      if (!fs.existsSync(p)) {
        throw new Error(`adapt prover artifact missing: ${p}`);
      }
    }
  }

  async prove(witness: AdaptWitness): Promise<AdaptProof> {
    const input = witnessToSnarkjsInput(witness);
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(
      input, this.artifacts.wasmPath, this.artifacts.zkeyPath,
    );

    if (publicSignals.length !== ADAPT_PUBLIC_INPUT_COUNT) {
      throw new Error(
        `adapt public signal count mismatch: got ${publicSignals.length}, expected ${ADAPT_PUBLIC_INPUT_COUNT}`,
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

function witnessToSnarkjsInput(w: AdaptWitness): Record<string, unknown> {
  const tostr = (x: bigint) => x.toString();
  return {
    merkleRoot: tostr(w.merkleRoot),
    nullifier: w.nullifier.map(tostr),
    commitmentOut: w.commitmentOut.map(tostr),
    publicAmountIn: tostr(w.publicAmountIn),
    publicAmountOut: tostr(w.publicAmountOut),
    publicTokenMint: tostr(w.publicTokenMint),
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
    expectedOutMint: tostr(w.expectedOutMint),
    adaptBindTag: tostr(w.adaptBindTag),
    inTokenMint: w.inTokenMint.map(tostr),
    inValue: w.inValue.map(tostr),
    inRandom: w.inRandom.map(tostr),
    inSpendingPriv: w.inSpendingPriv.map(tostr),
    inLeafIndex: w.inLeafIndex.map(tostr),
    inSiblings: w.inSiblings.map((row) => row.map(tostr)),
    inPathBits: w.inPathBits.map((row) => row.map(String)),
    inIsDummy: w.inIsDummy.map(String),
    outValue: w.outValue.map(tostr),
    outRandom: w.outRandom.map(tostr),
    outSpendingPub: w.outSpendingPub.map(tostr),
    outIsDummy: w.outIsDummy.map(String),
    relayerFeeRecipient: tostr(w.relayerFeeRecipient),
    recipientOwnerLow: tostr(w.recipientOwnerLow),
    recipientOwnerHigh: tostr(w.recipientOwnerHigh),
    actionPayloadKeccakFr: tostr(w.actionPayloadKeccakFr),
  };
}

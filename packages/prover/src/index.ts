/**
 * @b402ai/solana-prover — Groth16 proof generation for the b402 transact circuit.
 *
 * Wraps snarkjs with the byte-format conversions required by the on-chain
 * `b402-verifier-transact` program. Output is a 256-byte `proof` buffer
 * (A-negated 64 || B 128 || C 64) + an array of 16 32-byte LE public inputs
 * suitable for direct inclusion in the pool program's instruction data.
 */

// @ts-expect-error — snarkjs lacks types
import * as snarkjs from 'snarkjs';
import fs from 'node:fs';

import {
  g1JacFromSnarkjs,
  g2JacFromSnarkjs,
  g1ToBytes64,
  g1ToBytes64ProofA,
  g2ToBytes128,
  decToBeBytes32,
} from './g1g2.js';
import { TRANSACT_PUBLIC_INPUT_COUNT } from '@b402ai/solana-shared';

export interface TransactWitness {
  merkleRoot: bigint;
  nullifier: [bigint, bigint];
  commitmentOut: [bigint, bigint];
  publicAmountIn: bigint;
  publicAmountOut: bigint;
  publicTokenMint: bigint;
  relayerFee: bigint;
  relayerFeeBind: bigint;
  rootBind: bigint;
  recipientBind: bigint;
  // Domain tags
  commitTag: bigint;
  nullTag: bigint;
  mkNodeTag: bigint;
  spendKeyPubTag: bigint;
  feeBindTag: bigint;
  recipientBindTag: bigint;
  // Private inputs
  inTokenMint: [bigint, bigint];
  inValue: [bigint, bigint];
  inRandom: [bigint, bigint];
  inSpendingPriv: [bigint, bigint];
  inLeafIndex: [bigint, bigint];
  inSiblings: [bigint[], bigint[]];
  inPathBits: [number[], number[]];
  inIsDummy: [0 | 1, 0 | 1];
  outTokenMint: [bigint, bigint];
  outValue: [bigint, bigint];
  outRandom: [bigint, bigint];
  outSpendingPub: [bigint, bigint];
  outIsDummy: [0 | 1, 0 | 1];
  relayerFeeRecipient: bigint;
  recipientOwnerLow: bigint;
  recipientOwnerHigh: bigint;
}

export interface ProverArtifacts {
  wasmPath: string;
  zkeyPath: string;
  vkeyPath?: string;
}

export interface TransactProof {
  /** 256 bytes: proofA(64, y-negated) || proofB(128) || proofC(64). */
  proofBytes: Uint8Array;
  /** 16 × 32 bytes LE, matches Solana program instruction layout. */
  publicInputsLeBytes: Uint8Array[];
  /** Decimal strings, for debugging / SDK cross-check. */
  publicSignals: string[];
}

export class TransactProver {
  constructor(private readonly artifacts: ProverArtifacts) {
    for (const p of [artifacts.wasmPath, artifacts.zkeyPath]) {
      if (!fs.existsSync(p)) {
        throw new Error(`prover artifact missing: ${p}`);
      }
    }
  }

  /** Generate a proof for a transact witness. Does NOT verify locally. */
  async prove(witness: TransactWitness): Promise<TransactProof> {
    const input = witnessToSnarkjsInput(witness);
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(
      input, this.artifacts.wasmPath, this.artifacts.zkeyPath,
    );

    if (publicSignals.length !== TRANSACT_PUBLIC_INPUT_COUNT) {
      throw new Error(
        `public signal count mismatch: got ${publicSignals.length}, expected ${TRANSACT_PUBLIC_INPUT_COUNT}`,
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
    // Solana program expects LE — reverse each.
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

  /** Verify locally with snarkjs — useful for SDK tests before submitting on-chain. */
  async verifyLocal(proof: TransactProof): Promise<boolean> {
    if (!this.artifacts.vkeyPath) throw new Error('vkeyPath not provided');
    const vKey = JSON.parse(fs.readFileSync(this.artifacts.vkeyPath, 'utf-8'));
    // Reconstruct snarkjs-style proof from our bytes by re-using the
    // original signals — in practice SDK will call prove() + immediately
    // use the bytes, and verifyLocal is a belt-and-suspenders helper that
    // re-proves cheaply from cached snarkjs output. For the production SDK
    // path, we rely on the on-chain verify. This helper is test-only.
    const _ = vKey;
    throw new Error('verifyLocal: not implemented on proof bytes; call snarkjs.groth16.verify directly in tests');
  }
}

function witnessToSnarkjsInput(w: TransactWitness): Record<string, unknown> {
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
  };
}

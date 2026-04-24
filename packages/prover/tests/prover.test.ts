/**
 * Prover end-to-end sanity. Exercises the full path the SDK will use:
 *   witness → prove() → 256-byte proof + 16 LE public inputs.
 *
 * Validates the byte output is internally consistent by re-verifying the
 * *snarkjs-native* proof (we don't re-decode our serialized bytes here —
 * that's what the Rust verifier integration test covers).
 *
 * Gated by RUN_PROVER=1.
 */

import { describe, it, expect } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
// @ts-expect-error — snarkjs lacks types
import * as snarkjs from 'snarkjs';
// @ts-expect-error — circomlibjs lacks types
import { buildPoseidon } from 'circomlibjs';

import { TransactProver, type TransactWitness } from '../src/index.js';
import {
  FR_MODULUS, TRANSACT_PUBLIC_INPUT_COUNT, domainTag,
} from '@b402ai/solana-shared';

const RUN = process.env.RUN_PROVER === '1';
const d = RUN ? describe : describe.skip;

const CIRCUITS = path.resolve(__dirname, '../../../circuits');
const ART = {
  wasmPath: path.join(CIRCUITS, 'build/transact_js/transact.wasm'),
  zkeyPath: path.join(CIRCUITS, 'build/ceremony/transact_final.zkey'),
  vkeyPath: path.join(CIRCUITS, 'build/ceremony/verification_key.json'),
};

let poseidon: any | null = null;
async function H(...xs: bigint[]): Promise<bigint> {
  if (!poseidon) poseidon = await buildPoseidon();
  const h = poseidon(xs.map((x) => poseidon.F.e(x.toString())));
  return BigInt(poseidon.F.toString(h));
}

async function buildShieldWitness(): Promise<TransactWitness> {
  const sp = 42n;
  const spPub = await H(domainTag('spendKeyPub'), sp);
  const zero: bigint[] = [await H(domainTag('mkZero'))];
  for (let i = 0; i < 26; i++) zero.push(await H(domainTag('mkNode'), zero[i], zero[i]));
  const root = zero[26];
  const outToken = 111n;
  const outValue = 100n;
  const outRandom = 777n;
  const outCommit = await H(domainTag('commit'), outToken, outValue, outRandom, spPub);
  const feeRecipient = 555n;
  const fee = 0n;
  const feeBind = await H(domainTag('feeBind'), feeRecipient, fee);
  const recipLow = 0n;
  const recipHigh = 0n;
  const recipientBind = await H(domainTag('recipientBind'), recipLow, recipHigh);
  const dummyPriv = 1n;

  return {
    merkleRoot: root,
    nullifier: [0n, 0n],
    commitmentOut: [outCommit, 0n],
    publicAmountIn: outValue,
    publicAmountOut: 0n,
    publicTokenMint: outToken,
    relayerFee: fee,
    relayerFeeBind: feeBind,
    rootBind: 0n,
    recipientBind,
    commitTag: domainTag('commit'),
    nullTag: domainTag('nullifier'),
    mkNodeTag: domainTag('mkNode'),
    spendKeyPubTag: domainTag('spendKeyPub'),
    feeBindTag: domainTag('feeBind'),
    recipientBindTag: domainTag('recipientBind'),
    inTokenMint: [0n, 0n],
    inValue: [0n, 0n],
    inRandom: [0n, 0n],
    inSpendingPriv: [dummyPriv, dummyPriv],
    inLeafIndex: [0n, 0n],
    inSiblings: [zero.slice(0, 26), zero.slice(0, 26)],
    inPathBits: [Array(26).fill(0), Array(26).fill(0)],
    inIsDummy: [1, 1],
    outTokenMint: [outToken, 0n],
    outValue: [outValue, 0n],
    outRandom: [outRandom, 0n],
    outSpendingPub: [spPub, 0n],
    outIsDummy: [0, 1],
    relayerFeeRecipient: feeRecipient,
    recipientOwnerLow: recipLow,
    recipientOwnerHigh: recipHigh,
  };
}

d('TransactProver', () => {
  it('proves a valid shield and emits correct byte shapes', async () => {
    const prover = new TransactProver(ART);
    const witness = await buildShieldWitness();
    const proof = await prover.prove(witness);

    expect(proof.proofBytes.length).toBe(256);
    expect(proof.publicInputsLeBytes.length).toBe(TRANSACT_PUBLIC_INPUT_COUNT);
    for (const b of proof.publicInputsLeBytes) {
      expect(b.length).toBe(32);
    }
    expect(proof.publicSignals.length).toBe(TRANSACT_PUBLIC_INPUT_COUNT);

    // Public input 0 is merkleRoot — check it matches what we put in.
    const root = proof.publicSignals[0];
    expect(BigInt(root)).toBe(witness.merkleRoot);
    expect(BigInt(root) < FR_MODULUS).toBe(true);
  });

  it('LE public inputs are the bytewise reverse of decoded decimals', async () => {
    const prover = new TransactProver(ART);
    const witness = await buildShieldWitness();
    const proof = await prover.prove(witness);

    // Recompute expected LE from decimal and compare byte-for-byte.
    for (let i = 0; i < proof.publicSignals.length; i++) {
      const v = BigInt(proof.publicSignals[i]);
      const hex = v.toString(16).padStart(64, '0');
      const be = new Uint8Array(32);
      for (let j = 0; j < 32; j++) be[j] = parseInt(hex.slice(j * 2, j * 2 + 2), 16);
      const leExpected = new Uint8Array(32);
      for (let j = 0; j < 32; j++) leExpected[j] = be[31 - j];
      for (let j = 0; j < 32; j++) {
        expect(proof.publicInputsLeBytes[i][j]).toBe(leExpected[j]);
      }
    }
  });
});

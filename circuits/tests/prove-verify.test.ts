/**
 * End-to-end prove + verify.
 *
 * Gates: circuit compiled + ceremony complete. Exercises the full
 * snarkjs pipeline: witness → groth16.prove → groth16.verify.
 *
 * This test is what proves the ceremony output (`verification_key.json` +
 * `transact_final.zkey`) is internally consistent with the compiled
 * `transact.wasm`. If any of the three drift, this test fails.
 *
 * Gated by RUN_CIRCUIT_TESTS=1.
 */

import { describe, it, expect } from 'vitest';
// @ts-expect-error — snarkjs lacks types
import * as snarkjs from 'snarkjs';
import fs from 'node:fs';
import path from 'node:path';
import {
  commitment,
  tagToFr,
  DomainTags,
  ClientMerkleTree,
  poseidonTagged,
  spendingPub,
} from './helpers';

const RUN = process.env.RUN_CIRCUIT_TESTS === '1';
const d = RUN ? describe : describe.skip;

const BUILD = path.resolve(__dirname, '../build');
const WASM = path.join(BUILD, 'transact_js/transact.wasm');
const ZKEY = path.join(BUILD, 'ceremony/transact_final.zkey');
const VKEY = path.join(BUILD, 'ceremony/verification_key.json');

function requireArtifact(p: string) {
  if (!fs.existsSync(p)) {
    throw new Error(`missing artifact: ${p}. Run: bash scripts/compile.sh && bash scripts/throwaway-ceremony.sh`);
  }
}

async function buildValidShieldWitness() {
  const sp = 42n;
  const spPub = await spendingPub(sp);

  const zeroCache: bigint[] = [await poseidonTagged('mkZero')];
  for (let i = 0; i < 26; i++) {
    zeroCache.push(await poseidonTagged('mkNode', zeroCache[i], zeroCache[i]));
  }
  const root = zeroCache[26];

  const outToken = 111n;
  const outValue = 100n;
  const outRandom = 777n;
  const outCommit = await commitment(outToken, outValue, outRandom, spPub);

  const feeRecipient = 555n;
  const fee = 0n;
  const feeBind = await poseidonTagged('feeBind', feeRecipient, fee);

  const recipLow = 0n;
  const recipHigh = 0n;
  const recipientBind = await poseidonTagged('recipientBind', recipLow, recipHigh);

  const dummyPriv = 1n;

  return {
    merkleRoot: root.toString(),
    nullifier: ['0', '0'],
    commitmentOut: [outCommit.toString(), '0'],
    publicAmountIn: outValue.toString(),
    publicAmountOut: '0',
    publicTokenMint: outToken.toString(),
    relayerFee: fee.toString(),
    relayerFeeBind: feeBind.toString(),
    rootBind: '0',
    recipientBind: recipientBind.toString(),

    commitTag: tagToFr(DomainTags.commit).toString(),
    nullTag: tagToFr(DomainTags.nullifier).toString(),
    mkNodeTag: tagToFr(DomainTags.mkNode).toString(),
    spendKeyPubTag: tagToFr(DomainTags.spendKeyPub).toString(),
    feeBindTag: tagToFr(DomainTags.feeBind).toString(),
    recipientBindTag: tagToFr(DomainTags.recipientBind).toString(),

    inTokenMint: ['0', '0'],
    inValue: ['0', '0'],
    inRandom: ['0', '0'],
    inSpendingPriv: [dummyPriv.toString(), dummyPriv.toString()],
    inLeafIndex: ['0', '0'],
    inSiblings: [zeroCache.slice(0, 26).map(String), zeroCache.slice(0, 26).map(String)],
    inPathBits: [Array(26).fill('0'), Array(26).fill('0')],
    inIsDummy: ['1', '1'],

    outTokenMint: [outToken.toString(), '0'],
    outValue: [outValue.toString(), '0'],
    outRandom: [outRandom.toString(), '0'],
    outSpendingPub: [spPub.toString(), '0'],
    outIsDummy: ['0', '1'],

    relayerFeeRecipient: feeRecipient.toString(),
    recipientOwnerLow: recipLow.toString(),
    recipientOwnerHigh: recipHigh.toString(),
  };
}

d('end-to-end prove + verify', () => {
  it('artifacts present', () => {
    requireArtifact(WASM);
    requireArtifact(ZKEY);
    requireArtifact(VKEY);
  });

  it('generates a valid proof that verifies', async () => {
    const input = await buildValidShieldWitness();
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, WASM, ZKEY);

    expect(proof.pi_a).toBeDefined();
    expect(proof.pi_b).toBeDefined();
    expect(proof.pi_c).toBeDefined();

    // Sanity on public signals layout: first should be merkleRoot.
    expect(publicSignals.length).toBe(18);
    expect(publicSignals[0]).toBe(input.merkleRoot);

    const vKey = JSON.parse(fs.readFileSync(VKEY, 'utf-8'));
    const ok = await snarkjs.groth16.verify(vKey, publicSignals, proof);
    expect(ok).toBe(true);
  });

  it('rejects a proof with tampered public signals', async () => {
    const input = await buildValidShieldWitness();
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, WASM, ZKEY);

    // Flip merkleRoot — should break verification.
    const tampered = [...publicSignals];
    tampered[0] = (BigInt(tampered[0]) + 1n).toString();

    const vKey = JSON.parse(fs.readFileSync(VKEY, 'utf-8'));
    const ok = await snarkjs.groth16.verify(vKey, tampered, proof);
    expect(ok).toBe(false);
  });

  it('rejects a tampered proof', async () => {
    const input = await buildValidShieldWitness();
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, WASM, ZKEY);

    // Bump the first limb of pi_a.
    const tampered = JSON.parse(JSON.stringify(proof));
    tampered.pi_a[0] = (BigInt(tampered.pi_a[0]) + 1n).toString();

    const vKey = JSON.parse(fs.readFileSync(VKEY, 'utf-8'));
    const ok = await snarkjs.groth16.verify(vKey, publicSignals, tampered);
    expect(ok).toBe(false);
  });
});

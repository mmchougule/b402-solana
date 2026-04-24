/**
 * Adapt circuit tests.
 *
 * The adapt circuit burns N input notes in an IN mint and mints M output
 * notes in an OUT mint, provably bound to (adapter_id, action_hash,
 * expected_out_value, expected_out_mint). This is the Phase 2 primitive
 * that replaces the devnet-gated stub.
 *
 * Mirrors tests/transact.test.ts in structure. Gated behind
 * RUN_CIRCUIT_TESTS=1 because circom compilation is slow.
 */

import { describe, it, expect } from 'vitest';
import {
  loadCircuit,
  commitment,
  nullifier as nullifierHash,
  spendingPub,
  tagToFr,
  DomainTags,
  poseidonTagged,
  poseidon,
  ClientMerkleTree,
} from './helpers';
// @ts-expect-error - no types for keccak256 util
import { keccak_256 } from '@noble/hashes/sha3';

const RUN = process.env.RUN_CIRCUIT_TESTS === '1';
const d = RUN ? describe : describe.skip;

const P = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

function leToFrReduced(bytes: Uint8Array): bigint {
  let v = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) v = (v << 8n) | BigInt(bytes[i]);
  return v % P;
}

async function buildAdaptInputs() {
  // Setup: one input note in IN mint already in the tree, one output note
  // in OUT mint. Single-input, single-output adapt (other slots dummy).

  const aliceSeed = 42n;
  const aliceSpendingPriv = aliceSeed;
  const aliceSpendingPub = await spendingPub(aliceSpendingPriv);

  const tree = new ClientMerkleTree(26);
  await tree.init();

  // Input note: 100 units of IN_MINT owned by Alice, appended at leaf 0.
  const inMint = 111n;
  const inNoteValue = 100n;
  const inNoteRandom = 314n;
  const inNoteCommit = await commitment(inMint, inNoteValue, inNoteRandom, aliceSpendingPub);
  await tree.append(inNoteCommit);
  const inProof = await tree.prove(0n);

  // Output note: 250 units of OUT_MINT for Alice.
  const outMint = 222n;
  const outNoteValue = 250n;
  const outNoteRandom = 271n;
  const outNoteCommit = await commitment(outMint, outNoteValue, outNoteRandom, aliceSpendingPub);

  // Public amounts: send 80 of IN_MINT to adapter, pay 20 fee, expect 250 OUT.
  const publicAmountIn = 80n;
  const relayerFee = 20n;
  const expectedOutValue = 250n;

  const feeRecipient = 555n;
  const feeBind = await poseidonTagged('feeBind', feeRecipient, relayerFee);

  const recipLow = 0n;
  const recipHigh = 0n;
  const recipientBind = await poseidonTagged('recipientBind', recipLow, recipHigh);

  // Adapter binding.
  const adapterProgramIdBytes = new Uint8Array(32).fill(7);
  const adapterIdHash = keccak_256(adapterProgramIdBytes) as Uint8Array;
  const adapterId = leToFrReduced(adapterIdHash);

  const actionPayload = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
  const actionPayloadKeccak = keccak_256(actionPayload) as Uint8Array;
  const actionPayloadKeccakFr = leToFrReduced(actionPayloadKeccak);

  const adaptBindTagFr = tagToFr(DomainTags.adaptBind);
  const actionHash = await poseidon(adaptBindTagFr, actionPayloadKeccakFr, outMint);

  // Nullifier for the input note.
  const inNullifier = await nullifierHash(aliceSpendingPriv, 0n);

  const dummyPriv = 1n;

  return {
    // First 18 — match transact public input order
    merkleRoot: inProof.root,
    nullifier: [inNullifier, 0n],
    commitmentOut: [outNoteCommit, 0n],
    publicAmountIn,
    publicAmountOut: 0n,
    publicTokenMint: inMint,
    relayerFee,
    relayerFeeBind: feeBind,
    rootBind: 0n,
    recipientBind,

    commitTag:        tagToFr(DomainTags.commit),
    nullTag:          tagToFr(DomainTags.nullifier),
    mkNodeTag:        tagToFr(DomainTags.mkNode),
    spendKeyPubTag:   tagToFr(DomainTags.spendKeyPub),
    feeBindTag:       tagToFr(DomainTags.feeBind),
    recipientBindTag: tagToFr(DomainTags.recipientBind),

    // Adapt-specific public inputs (18–22)
    adapterId,
    actionHash,
    expectedOutValue,
    expectedOutMint: outMint,
    adaptBindTag: adaptBindTagFr,

    // Private witness
    inTokenMint:    [inMint, 0n],
    inValue:        [inNoteValue, 0n],
    inRandom:       [inNoteRandom, 0n],
    inSpendingPriv: [aliceSpendingPriv, dummyPriv],
    inLeafIndex:    [0n, 0n],
    inSiblings:     [inProof.siblings, inProof.siblings],
    inPathBits:     [inProof.pathBits, inProof.pathBits],
    inIsDummy:      [0, 1],

    outValue:       [outNoteValue, 0n],
    outRandom:      [outNoteRandom, 0n],
    outSpendingPub: [aliceSpendingPub, 0n],
    outIsDummy:     [0, 1],

    relayerFeeRecipient: feeRecipient,
    recipientOwnerLow: recipLow,
    recipientOwnerHigh: recipHigh,

    actionPayloadKeccakFr,
  };
}

d('adapt circuit — happy path', () => {
  it('accepts a valid 1-in / 1-out adapt', async () => {
    const circuit = await loadCircuit('adapt.circom');
    const input = await buildAdaptInputs();
    const w = await circuit.calculateWitness(input, true);
    await circuit.checkConstraints(w);
  });
});

d('adapt circuit — negative cases', () => {
  it('rejects output commitment with wrong mint (cross-mint attack)', async () => {
    // The attack adapt_execute_devnet permits: caller constructs an output
    // commitment encoding a different mint than expected_out_mint. The
    // circuit must bind outTokenMint === expected_out_mint.
    const circuit = await loadCircuit('adapt.circom');
    const input = await buildAdaptInputs();
    const foreignMint = 999n;
    const fakeCommit = await commitment(
      foreignMint,
      input.outValue[0] as bigint,
      input.outRandom[0] as bigint,
      input.outSpendingPub[0] as bigint,
    );
    (input as any).commitmentOut = [fakeCommit, 0n];
    await expect(circuit.calculateWitness(input, true)).rejects.toThrow();
  });

  it('rejects tampered action payload (actionHash mismatch)', async () => {
    const circuit = await loadCircuit('adapt.circom');
    const input = await buildAdaptInputs();
    // Caller's on-chain payload differs from what they proved — the
    // actionPayloadKeccakFr private witness no longer matches actionHash.
    (input as any).actionPayloadKeccakFr = 0xdeadbeefn;
    await expect(circuit.calculateWitness(input, true)).rejects.toThrow();
  });

  it('rejects balance violation (inSum != publicAmountIn + relayerFee)', async () => {
    const circuit = await loadCircuit('adapt.circom');
    const input = await buildAdaptInputs();
    (input as any).relayerFee = (input.relayerFee as bigint) - 1n;
    await expect(circuit.calculateWitness(input, true)).rejects.toThrow();
  });

  it('rejects output total != expectedOutValue', async () => {
    const circuit = await loadCircuit('adapt.circom');
    const input = await buildAdaptInputs();
    (input as any).expectedOutValue = (input.expectedOutValue as bigint) + 1n;
    await expect(circuit.calculateWitness(input, true)).rejects.toThrow();
  });

  it('rejects publicAmountOut > 0 (adapt has no public withdraw)', async () => {
    const circuit = await loadCircuit('adapt.circom');
    const input = await buildAdaptInputs();
    (input as any).publicAmountOut = 1n;
    await expect(circuit.calculateWitness(input, true)).rejects.toThrow();
  });

  it('rejects input mint mismatch', async () => {
    const circuit = await loadCircuit('adapt.circom');
    const input = await buildAdaptInputs();
    (input as any).publicTokenMint = 333n; // inTokenMint[0] is 111n
    await expect(circuit.calculateWitness(input, true)).rejects.toThrow();
  });

  it('rejects wrong recipientBind', async () => {
    const circuit = await loadCircuit('adapt.circom');
    const input = await buildAdaptInputs();
    (input as any).recipientBind = 0xbadn;
    await expect(circuit.calculateWitness(input, true)).rejects.toThrow();
  });
});

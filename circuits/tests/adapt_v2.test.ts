/**
 * Adapt v2 circuit tests.
 *
 * v2 ABI per PRD-11 / PRD-12 / PRD-13 / PRD-15:
 *   - vector token bindings (M=4 in / N=4 out)
 *   - content-addressed actionHash (Poseidon_6, the keystone)
 *   - shadow PDA binding
 *   - deadline_slot
 *
 * Mirrors tests/adapt.test.ts in structure.
 * Gated behind RUN_CIRCUIT_TESTS=1 because circom compilation is slow.
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

/**
 * Build a happy-path adapt v2 witness: 1-in / 1-out, single mint per side,
 * shadow PDA active.
 */
async function buildAdaptV2Inputs(opts: { withShadow?: boolean } = {}) {
  const aliceSeed = 42n;
  const aliceSpendingPriv = aliceSeed;
  const aliceSpendingPub = await spendingPub(aliceSpendingPriv);

  const tree = new ClientMerkleTree(26);
  await tree.init();

  const inMint = 111n;
  const inValue = 100n;
  const inRandom = 314n;
  const inCommit = await commitment(inMint, inValue, inRandom, aliceSpendingPub);
  await tree.append(inCommit);
  const inProof = await tree.prove(0n);

  const outMint = 222n;
  const outValue = 250n;
  const outRandom = 271n;
  const outCommit = await commitment(outMint, outValue, outRandom, aliceSpendingPub);

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
  const adapterId = leToFrReduced(keccak_256(adapterProgramIdBytes) as Uint8Array);

  const actionPayload = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
  const actionPayloadKeccakFr = leToFrReduced(keccak_256(actionPayload) as Uint8Array);

  // Canonical accounts list: 3 random accounts, sorted by pubkey ASC.
  const accountsHash = leToFrReduced(keccak_256(new Uint8Array([
    // pubkey0 (32 bytes ascending) || flags (00)
    ...new Array(32).fill(1), 0,
    ...new Array(32).fill(2), 1,  // writable
    ...new Array(32).fill(3), 0,
  ])) as Uint8Array);

  const scopeTag = tagToFr('kamino:lend:v1');  // example scope
  const extraContextRoot = 0n;  // none for happy path

  const adaptBindTagFr = tagToFr(DomainTags.adaptBindV2);

  // PRD-12 keystone: actionHash = Poseidon_6(...)
  const actionHash = await poseidon(
    adaptBindTagFr,
    adapterId,
    scopeTag,
    actionPayloadKeccakFr,
    accountsHash,
    extraContextRoot,
  );

  // PRD-13 shadow PDA binding.
  const shadowDomainTag = tagToFr(DomainTags.shadowBind);
  const viewingPubHash = opts.withShadow ? await poseidon(aliceSpendingPub, 0n) : 0n;
  const shadowPdaBinding = await poseidon(shadowDomainTag, viewingPubHash, scopeTag);

  const deadlineSlot = 1_000_000n;

  // Nullifier for the input note.
  const inNullifier = await nullifierHash(aliceSpendingPriv, 0n);

  const dummyPriv = 1n;

  return {
    // Public inputs.
    merkleRoot: inProof.root,
    nullifier: [inNullifier, 0n, 0n, 0n],
    commitmentOut: [outCommit, 0n, 0n, 0n],
    publicAmountIn,
    publicAmountOut: 0n,
    publicTokenMintIn: [inMint, 0n, 0n, 0n],
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

    adapterId,
    actionHash,
    expectedOutValue,
    expectedOutMint: [outMint, 0n, 0n, 0n],
    adaptBindTag: adaptBindTagFr,
    scopeTag,
    accountsHash,
    extraContextRoot,
    deadlineSlot,
    shadowPdaBinding,

    // Private witness.
    inTokenMint:    [inMint, 0n, 0n, 0n],
    inValue:        [inValue, 0n, 0n, 0n],
    inRandom:       [inRandom, 0n, 0n, 0n],
    inSpendingPriv: [aliceSpendingPriv, dummyPriv, dummyPriv, dummyPriv],
    inLeafIndex:    [0n, 0n, 0n, 0n],
    inSiblings:     [inProof.siblings, inProof.siblings, inProof.siblings, inProof.siblings],
    inPathBits:     [inProof.pathBits, inProof.pathBits, inProof.pathBits, inProof.pathBits],
    inIsDummy:      [0, 1, 1, 1],

    outTokenMint:   [outMint, 0n, 0n, 0n],
    outValue:       [outValue, 0n, 0n, 0n],
    outRandom:      [outRandom, 0n, 0n, 0n],
    outSpendingPub: [aliceSpendingPub, 0n, 0n, 0n],
    outIsDummy:     [0, 1, 1, 1],

    relayerFeeRecipient: feeRecipient,
    recipientOwnerLow: recipLow,
    recipientOwnerHigh: recipHigh,

    actionPayloadKeccakFr,
    shadowDomainTag,
    viewingPubHash,
  };
}

d('adapt v2 — happy path (single mint)', () => {
  it('accepts a valid 1-in / 1-out adapt v2 with shadow binding', async () => {
    const circuit = await loadCircuit('adapt_v2.circom');
    const input = await buildAdaptV2Inputs({ withShadow: true });
    const w = await circuit.calculateWitness(input, true);
    await circuit.checkConstraints(w);
  });

  it('accepts a valid 1-in / 1-out adapt v2 without shadow binding (zero viewingPubHash)', async () => {
    const circuit = await loadCircuit('adapt_v2.circom');
    const input = await buildAdaptV2Inputs({ withShadow: false });
    const w = await circuit.calculateWitness(input, true);
    await circuit.checkConstraints(w);
  });
});

d('adapt v2 — vector mints (PRD-11)', () => {
  it('accepts dual output (1-in / 2-out) with two distinct mints', async () => {
    const circuit = await loadCircuit('adapt_v2.circom');
    const input = await buildAdaptV2Inputs() as any;

    const aliceSpendingPub = (await spendingPub(42n)) as bigint;
    const out2Mint = 333n;
    const out2Value = 50n;
    const out2Random = 999n;
    const out2Commit = await commitment(out2Mint, out2Value, out2Random, aliceSpendingPub);

    input.commitmentOut = [input.commitmentOut[0], out2Commit, 0n, 0n];
    input.expectedOutMint = [input.expectedOutMint[0], out2Mint, 0n, 0n];
    input.expectedOutValue = (input.expectedOutValue as bigint) + out2Value;

    input.outTokenMint   = [input.outTokenMint[0], out2Mint, 0n, 0n];
    input.outValue       = [input.outValue[0], out2Value, 0n, 0n];
    input.outRandom      = [input.outRandom[0], out2Random, 0n, 0n];
    input.outSpendingPub = [input.outSpendingPub[0], aliceSpendingPub, 0n, 0n];
    input.outIsDummy     = [0, 0, 1, 1];

    const w = await circuit.calculateWitness(input, true);
    await circuit.checkConstraints(w);
  });

  it('accepts max output (1-in / 4-out) with four distinct mints', async () => {
    const circuit = await loadCircuit('adapt_v2.circom');
    const input = await buildAdaptV2Inputs() as any;
    const aliceSpendingPub = (await spendingPub(42n)) as bigint;

    const mints  = [222n, 333n, 444n, 555n];
    const values = [60n,  70n,  80n,  40n];
    const randoms = [271n, 283n, 295n, 307n];
    const commits: bigint[] = [];
    for (let k = 0; k < 4; k++) {
      commits.push(await commitment(mints[k], values[k], randoms[k], aliceSpendingPub));
    }

    input.commitmentOut    = commits;
    input.expectedOutMint  = mints;
    input.expectedOutValue = values.reduce((a, b) => a + b, 0n);

    input.outTokenMint   = mints;
    input.outValue       = values;
    input.outRandom      = randoms;
    input.outSpendingPub = [aliceSpendingPub, aliceSpendingPub, aliceSpendingPub, aliceSpendingPub];
    input.outIsDummy     = [0, 0, 0, 0];

    const w = await circuit.calculateWitness(input, true);
    await circuit.checkConstraints(w);
  });

  it('rejects attacker-set mint in dummy output slot (PRD-11 zero-binding canonicalization)', async () => {
    const circuit = await loadCircuit('adapt_v2.circom');
    const input = await buildAdaptV2Inputs() as any;
    // Slot 1 is dummy in happy path. Attacker tries to bake in a non-zero
    // mint, hoping the pool will leak by indexing slot 1.
    input.expectedOutMint = [input.expectedOutMint[0], 999n, 0n, 0n];
    await expect(circuit.calculateWitness(input, true)).rejects.toThrow();
  });

  it('rejects attacker-set mint in dummy input slot', async () => {
    const circuit = await loadCircuit('adapt_v2.circom');
    const input = await buildAdaptV2Inputs() as any;
    input.publicTokenMintIn = [input.publicTokenMintIn[0], 999n, 0n, 0n];
    await expect(circuit.calculateWitness(input, true)).rejects.toThrow();
  });
});

d('adapt v2 — content-addressed actionHash (PRD-12)', () => {
  it('rejects tampered action payload (actionHash mismatch)', async () => {
    const circuit = await loadCircuit('adapt_v2.circom');
    const input = await buildAdaptV2Inputs() as any;
    input.actionPayloadKeccakFr = 0xdeadbeefn;
    await expect(circuit.calculateWitness(input, true)).rejects.toThrow();
  });

  it('rejects tampered scopeTag', async () => {
    const circuit = await loadCircuit('adapt_v2.circom');
    const input = await buildAdaptV2Inputs() as any;
    input.scopeTag = (input.scopeTag as bigint) + 1n;
    await expect(circuit.calculateWitness(input, true)).rejects.toThrow();
  });

  it('rejects tampered accountsHash', async () => {
    const circuit = await loadCircuit('adapt_v2.circom');
    const input = await buildAdaptV2Inputs() as any;
    input.accountsHash = (input.accountsHash as bigint) ^ 1n;
    await expect(circuit.calculateWitness(input, true)).rejects.toThrow();
  });
});

d('adapt v2 — shadow PDA binding (PRD-13)', () => {
  it('rejects mismatched shadowPdaBinding', async () => {
    const circuit = await loadCircuit('adapt_v2.circom');
    const input = await buildAdaptV2Inputs({ withShadow: true }) as any;
    input.shadowPdaBinding = (input.shadowPdaBinding as bigint) ^ 1n;
    await expect(circuit.calculateWitness(input, true)).rejects.toThrow();
  });
});

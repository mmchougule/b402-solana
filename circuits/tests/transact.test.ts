/**
 * Transact circuit tests.
 *
 * These compile the circuit via circom_tester (slow first run) and exercise
 * valid and invalid witnesses. Runs are gated by env var RUN_CIRCUIT_TESTS=1
 * to keep default `pnpm test` fast; CI sets the flag.
 */

import { describe, it, expect } from 'vitest';
import {
  loadCircuit,
  commitment,
  nullifier,
  spendingPub,
  tagToFr,
  DomainTags,
  ClientMerkleTree,
  poseidonTagged,
} from './helpers';

const RUN = process.env.RUN_CIRCUIT_TESTS === '1';
const d = RUN ? describe : describe.skip;

async function buildShieldInputs() {
  // Shield: 0 real input notes (both dummy), 1 real output note, publicAmountIn > 0.
  const sp = 42n;
  const spPub = await spendingPub(sp);

  const tree = new ClientMerkleTree(26);
  await tree.init();
  // Tree is empty. Dummy merkle paths are all zero-siblings against the empty subtree.
  const zeroCache = await (async () => {
    const c: bigint[] = [];
    c.push(await poseidonTagged('mkZero'));
    for (let i = 0; i < 26; i++) c.push(await poseidonTagged('mkNode', c[i], c[i]));
    return c;
  })();
  const root = zeroCache[26];

  const outToken = 111n;
  const outValue = 100n;
  const outRandom = 777n;
  const outCommit = await commitment(outToken, outValue, outRandom, spPub);

  const feeRecipient = 555n;
  const fee = 0n;
  const feeBind = await poseidonTagged('feeBind', feeRecipient, fee);

  // Shield has no recipient; bind the zero owner.
  const recipLow = 0n;
  const recipHigh = 0n;
  const recipientBind = await poseidonTagged('recipientBind', recipLow, recipHigh);

  const dummyPriv = 1n;
  const dummyValue = 0n;
  const dummyRandom = 0n;
  const dummyLeafIdx = 0n;
  const dummySpPub = await spendingPub(dummyPriv);

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

    commitTag: tagToFr(DomainTags.commit),
    nullTag: tagToFr(DomainTags.nullifier),
    mkNodeTag: tagToFr(DomainTags.mkNode),
    spendKeyPubTag: tagToFr(DomainTags.spendKeyPub),
    feeBindTag: tagToFr(DomainTags.feeBind),
    recipientBindTag: tagToFr(DomainTags.recipientBind),

    inTokenMint: [0n, 0n],
    inValue: [dummyValue, dummyValue],
    inRandom: [dummyRandom, dummyRandom],
    inSpendingPriv: [dummyPriv, dummyPriv],
    inLeafIndex: [dummyLeafIdx, dummyLeafIdx],
    inSiblings: [zeroCache.slice(0, 26), zeroCache.slice(0, 26)],
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

d('transact circuit — shield', () => {
  it('accepts a valid 0→1 shield', async () => {
    const circuit = await loadCircuit('transact.circom');
    const input = await buildShieldInputs();
    const w = await circuit.calculateWitness(input, true);
    await circuit.checkConstraints(w);
  });

  it('rejects mismatched public commitment', async () => {
    const circuit = await loadCircuit('transact.circom');
    const input = await buildShieldInputs();
    (input as any).commitmentOut = [0xdeadn, 0n];
    await expect(circuit.calculateWitness(input, true)).rejects.toThrow();
  });

  it('rejects balance-violating shield (publicAmountIn < sum out)', async () => {
    const circuit = await loadCircuit('transact.circom');
    const input = await buildShieldInputs();
    (input as any).publicAmountIn = (input.publicAmountIn as bigint) - 1n;
    await expect(circuit.calculateWitness(input, true)).rejects.toThrow();
  });

  it('rejects both publicAmountIn and publicAmountOut non-zero', async () => {
    const circuit = await loadCircuit('transact.circom');
    const input = await buildShieldInputs();
    (input as any).publicAmountOut = 1n;
    await expect(circuit.calculateWitness(input, true)).rejects.toThrow();
  });

  it('rejects wrong fee-bind recipient', async () => {
    const circuit = await loadCircuit('transact.circom');
    const input = await buildShieldInputs();
    // Recompute fee bind with a different recipient than circuit computes
    (input as any).relayerFeeRecipient = 999n; // was 555n
    await expect(circuit.calculateWitness(input, true)).rejects.toThrow();
  });
});

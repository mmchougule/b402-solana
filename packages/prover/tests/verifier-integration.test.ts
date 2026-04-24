/**
 * Prover ↔ Rust verifier integration.
 *
 * Proves: a proof produced by `TransactProver.prove()` (SDK path) verifies
 * under the on-chain Rust verifier code when passed as an instruction. We
 * bridge via a small verify-proof CLI binary that wraps `verify_proof_be`.
 *
 * This closes the loop: SDK → prover → bytes → Rust → verified.
 *
 * Gated by RUN_PROVER=1 and RUN_VERIFIER=1.
 */

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
// @ts-expect-error
import { buildPoseidon } from 'circomlibjs';

import { TransactProver, type TransactWitness } from '../src/index.js';
import { domainTag } from '@b402ai/solana-shared';

const RUN = process.env.RUN_PROVER === '1' && process.env.RUN_VERIFIER === '1';
const d = RUN ? describe : describe.skip;

const CIRCUITS = path.resolve(__dirname, '../../../circuits');
const TARGET = path.resolve(__dirname, '../../../target/debug/b402-verify-cli');

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

function toHex(u: Uint8Array): string {
  return Array.from(u).map((b) => b.toString(16).padStart(2, '0')).join('');
}

d('prover → Rust verifier', () => {
  it('verify-cli binary exists', () => {
    if (!fs.existsSync(TARGET)) {
      throw new Error(`missing ${TARGET}; run: cargo build -p b402-verifier-transact --bin b402-verify-cli`);
    }
  });

  it('prover-emitted bytes verify in Rust', async () => {
    if (!fs.existsSync(TARGET)) return;

    const prover = new TransactProver({
      wasmPath: path.join(CIRCUITS, 'build/transact_js/transact.wasm'),
      zkeyPath: path.join(CIRCUITS, 'build/ceremony/transact_final.zkey'),
    });
    const witness = await buildShieldWitness();
    const { proofBytes, publicInputsLeBytes } = await prover.prove(witness);

    // CLI input format: proof_hex\npi0_hex\npi1_hex\n...\npi15_hex
    const stdin = [
      toHex(proofBytes),
      ...publicInputsLeBytes.map(toHex),
    ].join('\n');

    const out = execFileSync(TARGET, { input: stdin, encoding: 'utf-8' }).trim();
    expect(out).toBe('OK');
  });
});

#!/usr/bin/env node
/**
 * Generate a known-good adapt proof for Rust tests.
 *
 * Produces `build/test_artifacts/adapt_valid.json` containing:
 *   proof_a_be:    [64]byte hex (big-endian, groth16-solana format)
 *   proof_b_be:    [128]byte hex
 *   proof_c_be:    [64]byte hex
 *   public_inputs_be: [23] 32-byte BE hex strings
 *   public_decimals:  [23] decimal strings (for debugging)
 *
 * Scenario: Alice has shielded 100 IN_MINT (one input note at leaf 0).
 * Pool sends 80 IN_MINT to adapter; 20 is the relayer fee. Adapter
 * delivers 250 OUT_MINT, all as one output note for Alice.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { keccak_256 } from '@noble/hashes/sha3';
// eslint-disable-next-line import/no-unresolved
import * as snarkjs from 'snarkjs';
// eslint-disable-next-line import/no-unresolved
import { utils, buildBn128 } from 'ffjavascript';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BUILD = path.resolve(__dirname, '../build');
const WASM = path.join(BUILD, 'adapt_js/adapt.wasm');
const ZKEY = path.join(BUILD, 'ceremony/adapt_final.zkey');
const OUT_DIR = path.join(BUILD, 'test_artifacts');

const P = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
function tagToFr(tag) {
  let acc = 0n;
  for (let i = 0; i < tag.length; i++) acc = (acc << 8n) | BigInt(tag.charCodeAt(i));
  return acc % P;
}
function leToFrReduced(bytes) {
  let v = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) v = (v << 8n) | BigInt(bytes[i]);
  return v % P;
}

const tags = {
  commit:        tagToFr('b402/v1/commit'),
  nullifier:     tagToFr('b402/v1/null'),
  mkNode:        tagToFr('b402/v1/mk-node'),
  mkZero:        tagToFr('b402/v1/mk-zero'),
  spendKeyPub:   tagToFr('b402/v1/spend-key-pub'),
  feeBind:       tagToFr('b402/v1/fee-bind'),
  recipientBind: tagToFr('b402/v1/recipient-bind'),
  adaptBind:     tagToFr('b402/v1/adapt-bind'),
};

const bn128 = await buildBn128();
const F1 = bn128.G1.F;

async function poseidon(...inputs) {
  const circomlibjs = await import('circomlibjs');
  const p = await circomlibjs.buildPoseidon();
  const h = p(inputs.map((x) => p.F.e(x.toString())));
  return BigInt(p.F.toString(h));
}

async function rootAfterSingleLeaf(leaf, zero) {
  let cur = await poseidon(tags.mkNode, leaf, zero[0]);
  for (let level = 1; level < 26; level++) {
    cur = await poseidon(tags.mkNode, cur, zero[level]);
  }
  return cur;
}

async function buildAdaptInput() {
  const aliceSp = 42n;
  const aliceSpPub = await poseidon(tags.spendKeyPub, aliceSp);

  const zero = [];
  zero.push(await poseidon(tags.mkZero));
  for (let i = 0; i < 26; i++) zero.push(await poseidon(tags.mkNode, zero[i], zero[i]));

  // Input note: 100 of IN_MINT for Alice at leaf 0.
  const inMint = 111n;
  const inValue = 100n;
  const inRandom = 314n;
  const inCommit = await poseidon(tags.commit, inMint, inValue, inRandom, aliceSpPub);
  const root = await rootAfterSingleLeaf(inCommit, zero);
  const inNullifier = await poseidon(tags.nullifier, aliceSp, 0n);

  // Output note: 250 of OUT_MINT for Alice.
  const outMint = 222n;
  const outValue = 250n;
  const outRandom = 271n;
  const outCommit = await poseidon(tags.commit, outMint, outValue, outRandom, aliceSpPub);

  // Public amounts. inSum (100) === publicAmountIn (80) + relayerFee (20). outSum (250) === expectedOutValue (250).
  const publicAmountIn = 80n;
  const relayerFee = 20n;
  const expectedOutValue = 250n;

  const feeRecipient = 555n;
  const feeBind = await poseidon(tags.feeBind, feeRecipient, relayerFee);

  const recipLow = 0n;
  const recipHigh = 0n;
  const recipientBind = await poseidon(tags.recipientBind, recipLow, recipHigh);

  const adapterProgramIdBytes = new Uint8Array(32).fill(7);
  const adapterId = leToFrReduced(keccak_256(adapterProgramIdBytes));

  const actionPayload = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
  const actionPayloadKeccakFr = leToFrReduced(keccak_256(actionPayload));

  const actionHash = await poseidon(tags.adaptBind, actionPayloadKeccakFr, outMint);

  const dummyPriv = 1n;

  return {
    merkleRoot: root.toString(),
    nullifier: [inNullifier.toString(), '0'],
    commitmentOut: [outCommit.toString(), '0'],
    publicAmountIn: publicAmountIn.toString(),
    publicAmountOut: '0',
    publicTokenMint: inMint.toString(),
    relayerFee: relayerFee.toString(),
    relayerFeeBind: feeBind.toString(),
    rootBind: '0',
    recipientBind: recipientBind.toString(),
    commitTag: tags.commit.toString(),
    nullTag: tags.nullifier.toString(),
    mkNodeTag: tags.mkNode.toString(),
    spendKeyPubTag: tags.spendKeyPub.toString(),
    feeBindTag: tags.feeBind.toString(),
    recipientBindTag: tags.recipientBind.toString(),
    adapterId: adapterId.toString(),
    actionHash: actionHash.toString(),
    expectedOutValue: expectedOutValue.toString(),
    expectedOutMint: outMint.toString(),
    adaptBindTag: tags.adaptBind.toString(),
    inTokenMint: [inMint.toString(), '0'],
    inValue: [inValue.toString(), '0'],
    inRandom: [inRandom.toString(), '0'],
    inSpendingPriv: [aliceSp.toString(), dummyPriv.toString()],
    inLeafIndex: ['0', '0'],
    inSiblings: [zero.slice(0, 26).map(String), zero.slice(0, 26).map(String)],
    inPathBits: [Array(26).fill('0'), Array(26).fill('0')],
    inIsDummy: ['0', '1'],
    outValue: [outValue.toString(), '0'],
    outRandom: [outRandom.toString(), '0'],
    outSpendingPub: [aliceSpPub.toString(), '0'],
    outIsDummy: ['0', '1'],
    relayerFeeRecipient: feeRecipient.toString(),
    recipientOwnerLow: recipLow.toString(),
    recipientOwnerHigh: recipHigh.toString(),
    actionPayloadKeccakFr: actionPayloadKeccakFr.toString(),
  };
}

function feBeBytes32Mont(feMont) {
  const std = F1.fromMontgomery(feMont);
  const bi = utils.leBuff2int(std);
  let hex = bi.toString(16).padStart(64, '0');
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function decToBeBytes32(dec) {
  let hex = BigInt(dec).toString(16).padStart(64, '0');
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function toHex(u8) {
  return Array.from(u8).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function g1JacFromDec(arr) {
  return new Uint8Array([
    ...F1.e(arr[0]),
    ...F1.e(arr[1]),
    ...F1.e(arr[2]),
  ]);
}
function g2JacFromDec(arr) {
  return new Uint8Array([
    ...F1.e(arr[0][0]), ...F1.e(arr[0][1]),
    ...F1.e(arr[1][0]), ...F1.e(arr[1][1]),
    ...F1.e(arr[2][0]), ...F1.e(arr[2][1]),
  ]);
}

function g1ToProofBytes(jacDec) {
  const jac = g1JacFromDec(jacDec);
  const aff = bn128.G1.toAffine(jac);
  return new Uint8Array([
    ...feBeBytes32Mont(aff.slice(0, 32)),
    ...feBeBytes32Mont(aff.slice(32, 64)),
  ]);
}

function g1ToProofABytes(jacDec) {
  const jac = g1JacFromDec(jacDec);
  const aff = bn128.G1.toAffine(jac);
  const xBe = feBeBytes32Mont(aff.slice(0, 32));
  const yStd = F1.fromMontgomery(aff.slice(32, 64));
  const yBi = utils.leBuff2int(yStd);
  const P_BN254 = 21888242871839275222246405745257275088696311157297823662689037894645226208583n;
  const negBi = (P_BN254 - yBi) % P_BN254;
  const negHex = negBi.toString(16).padStart(64, '0');
  const yNegBe = new Uint8Array(32);
  for (let i = 0; i < 32; i++) yNegBe[i] = parseInt(negHex.slice(i * 2, i * 2 + 2), 16);
  return new Uint8Array([...xBe, ...yNegBe]);
}

function g2ToProofBytes(jacDec) {
  const jac = g2JacFromDec(jacDec);
  const aff = bn128.G2.toAffine(jac);
  return new Uint8Array([
    ...feBeBytes32Mont(aff.slice(32, 64)),
    ...feBeBytes32Mont(aff.slice(0, 32)),
    ...feBeBytes32Mont(aff.slice(96, 128)),
    ...feBeBytes32Mont(aff.slice(64, 96)),
  ]);
}

async function main() {
  if (!fs.existsSync(WASM) || !fs.existsSync(ZKEY)) {
    console.error('missing artifacts. compile adapt.circom + run adapt ceremony first.');
    process.exit(1);
  }

  const input = await buildAdaptInput();
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, WASM, ZKEY);

  const vKey = JSON.parse(fs.readFileSync(path.join(BUILD, 'ceremony/adapt_verification_key.json'), 'utf8'));
  const ok = await snarkjs.groth16.verify(vKey, publicSignals, proof);
  if (!ok) throw new Error('local verify failed — aborting artifact emit');

  const proofABe = toHex(g1ToProofABytes(proof.pi_a));
  const proofBBe = toHex(g2ToProofBytes(proof.pi_b));
  const proofCBe = toHex(g1ToProofBytes(proof.pi_c));
  const publicBe = publicSignals.map((s) => toHex(decToBeBytes32(s)));

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const out = {
    note: 'Generated from a throwaway-ceremony adapt zkey. DEVNET ONLY.',
    proof_a_be: proofABe,
    proof_b_be: proofBBe,
    proof_c_be: proofCBe,
    public_inputs_be: publicBe,
    public_decimals: publicSignals,
  };
  const outPath = path.join(OUT_DIR, 'adapt_valid.json');
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(`✓ wrote ${outPath} (${publicSignals.length} public inputs)`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => { console.error(e); process.exit(1); });

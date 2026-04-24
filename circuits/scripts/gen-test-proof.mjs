#!/usr/bin/env node
/**
 * Generate a known-good shield proof for Rust tests.
 *
 * Produces `build/test_artifacts/shield_valid.json` containing:
 *   proof_a_be:    [64]byte hex (big-endian, groth16-solana format)
 *   proof_b_be:    [128]byte hex
 *   proof_c_be:    [64]byte hex
 *   public_inputs: [16] 32-byte BE hex strings
 *   public_decimals: [16] decimal strings (for debugging)
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// eslint-disable-next-line import/no-unresolved
import * as snarkjs from 'snarkjs';
// eslint-disable-next-line import/no-unresolved
import { utils, buildBn128 } from 'ffjavascript';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BUILD = path.resolve(__dirname, '../build');
const WASM = path.join(BUILD, 'transact_js/transact.wasm');
const ZKEY = path.join(BUILD, 'ceremony/transact_final.zkey');
const OUT_DIR = path.join(BUILD, 'test_artifacts');

// Domain tag encoding — mirror of helpers.ts tagToFr.
const P = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
function tagToFr(tag) {
  let acc = 0n;
  for (let i = 0; i < tag.length; i++) acc = (acc << 8n) | BigInt(tag.charCodeAt(i));
  return acc % P;
}

const tags = {
  commit:        tagToFr('b402/v1/commit'),
  nullifier:     tagToFr('b402/v1/null'),
  mkNode:        tagToFr('b402/v1/mk-node'),
  mkZero:        tagToFr('b402/v1/mk-zero'),
  spendKeyPub:   tagToFr('b402/v1/spend-key-pub'),
  feeBind:       tagToFr('b402/v1/fee-bind'),
  recipientBind: tagToFr('b402/v1/recipient-bind'),
};

/** Split a 32-byte owner pubkey into two u128 halves (low | high, LE). */
function splitOwnerPubkey(ownerBytes) {
  let low = 0n, high = 0n;
  for (let i = 0; i < 16; i++) low  |= BigInt(ownerBytes[i])      << BigInt(8 * i);
  for (let i = 0; i < 16; i++) high |= BigInt(ownerBytes[i + 16]) << BigInt(8 * i);
  return { low, high };
}

/**
 * The default recipient pubkey used in test fixtures. We bind its bytes into
 * the proof; on-chain tests create an ATA owned by this pubkey via
 * `set_account` (the 32 bytes need not be a valid curve point for the
 * account to exist).
 *
 * Chosen as a high-byte pattern so it collides with nothing naturally.
 * For shield fixtures, we use the all-zero owner (a no-op binding).
 */
const TEST_RECIPIENT_BYTES = new Uint8Array([
  0xa1, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8,
  0xb1, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8,
  0xc1, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8,
  0xd1, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8,
]);

const bn128 = await buildBn128();
const F1 = bn128.G1.F;

async function poseidon(...inputs) {
  const circomlibjs = await import('circomlibjs');
  const p = await circomlibjs.buildPoseidon();
  const h = p(inputs.map((x) => p.F.e(x.toString())));
  return BigInt(p.F.toString(h));
}

async function buildInput(opts = {}) {
  const mode = opts.mode ?? 'shield';    // 'shield' or 'unshield'
  const sp = opts.sp ?? 42n;
  const token = opts.token ?? 111n;
  const value = opts.value ?? 100n;
  const random = opts.random ?? 777n;
  const feeRecipient = opts.feeRecipient ?? 555n;
  const fee = opts.fee ?? 0n;

  const spPub = await poseidon(tags.spendKeyPub, sp);

  const zero = [];
  zero.push(await poseidon(tags.mkZero));
  for (let i = 0; i < 26; i++) zero.push(await poseidon(tags.mkNode, zero[i], zero[i]));

  const feeBind = await poseidon(tags.feeBind, feeRecipient, fee);

  // `commit` is the commitment of the shielded note — the same thing on both
  // sides of the shield/unshield boundary, just consumed vs. created.
  const commit = await poseidon(tags.commit, token, value, random, spPub);

  if (mode === 'shield') {
    return buildShield({ sp, spPub, token, value, random, commit, feeBind, feeRecipient, fee, zero });
  }
  if (mode === 'unshield') {
    return buildUnshield({ sp, spPub, token, value, random, commit, feeBind, feeRecipient, fee, zero });
  }
  throw new Error(`unknown mode ${mode}`);
}

/** Compute the root of a tree containing exactly one leaf at position 0. */
async function rootAfterSingleLeaf(leaf, zero) {
  // Per MerkleTree::append for idx=0:
  //   frontier[0] = leaf
  //   cur = H(leaf, zero[0])
  //   then walk up: cur = H(cur, zero[level]) for level = 1..25
  let cur = await poseidon(tags.mkNode, leaf, zero[0]);
  for (let level = 1; level < 26; level++) {
    cur = await poseidon(tags.mkNode, cur, zero[level]);
  }
  return cur;
}

async function buildShield({ sp, spPub, token, value, random, commit, feeBind, feeRecipient, fee, zero }) {
  const root = zero[26];
  const dummyPriv = 1n;
  // Shield has no recipient; bind the zero owner. Pool handler ignores the
  // value for shield, but the circuit still checks the binding is consistent.
  const recipLow = 0n;
  const recipHigh = 0n;
  const recipientBind = await poseidon(tags.recipientBind, recipLow, recipHigh);
  return {
    merkleRoot: root.toString(),
    nullifier: ['0', '0'],
    commitmentOut: [commit.toString(), '0'],
    publicAmountIn: value.toString(),
    publicAmountOut: '0',
    publicTokenMint: token.toString(),
    relayerFee: fee.toString(),
    relayerFeeBind: feeBind.toString(),
    rootBind: '0',
    recipientBind: recipientBind.toString(),
    commitTag: tags.commit.toString(),
    nullTag: tags.nullifier.toString(),
    mkNodeTag: tags.mkNode.toString(),
    spendKeyPubTag: tags.spendKeyPub.toString(),
    feeBindTag: tags.feeBind.toString(),
    recipientBindTag: tags.recipientBind.toString(),
    inTokenMint: ['0', '0'],
    inValue: ['0', '0'],
    inRandom: ['0', '0'],
    inSpendingPriv: [dummyPriv.toString(), dummyPriv.toString()],
    inLeafIndex: ['0', '0'],
    inSiblings: [zero.slice(0, 26).map(String), zero.slice(0, 26).map(String)],
    inPathBits: [Array(26).fill('0'), Array(26).fill('0')],
    inIsDummy: ['1', '1'],
    outTokenMint: [token.toString(), '0'],
    outValue: [value.toString(), '0'],
    outRandom: [random.toString(), '0'],
    outSpendingPub: [spPub.toString(), '0'],
    outIsDummy: ['0', '1'],
    relayerFeeRecipient: feeRecipient.toString(),
    recipientOwnerLow: recipLow.toString(),
    recipientOwnerHigh: recipHigh.toString(),
  };
}

async function buildUnshield({ sp, spPub, token, value, random, commit, feeBind, feeRecipient, fee, zero }) {
  // State: tree contains exactly one leaf, our `commit` at position 0.
  const root = await rootAfterSingleLeaf(commit, zero);

  // Nullifier for spending that note.
  const nullifier = await poseidon(tags.nullifier, sp, 0n);

  // Bind the test recipient pubkey into the proof. On-chain tests create an
  // ATA owned by `TEST_RECIPIENT_BYTES` via `set_account`.
  const { low: recipLow, high: recipHigh } = splitOwnerPubkey(TEST_RECIPIENT_BYTES);
  const recipientBind = await poseidon(tags.recipientBind, recipLow, recipHigh);

  const dummyPriv = 1n;
  return {
    merkleRoot: root.toString(),
    nullifier: [nullifier.toString(), '0'],
    commitmentOut: ['0', '0'],
    publicAmountIn: '0',
    publicAmountOut: value.toString(),
    publicTokenMint: token.toString(),
    relayerFee: fee.toString(),
    relayerFeeBind: feeBind.toString(),
    rootBind: '0',
    recipientBind: recipientBind.toString(),
    commitTag: tags.commit.toString(),
    nullTag: tags.nullifier.toString(),
    mkNodeTag: tags.mkNode.toString(),
    spendKeyPubTag: tags.spendKeyPub.toString(),
    feeBindTag: tags.feeBind.toString(),
    recipientBindTag: tags.recipientBind.toString(),
    // Input 0: real spend of the shielded note at leaf 0.
    inTokenMint: [token.toString(), '0'],
    inValue: [value.toString(), '0'],
    inRandom: [random.toString(), '0'],
    inSpendingPriv: [sp.toString(), dummyPriv.toString()],
    inLeafIndex: ['0', '0'],
    // Merkle path to leaf 0 in a single-leaf tree: all-zero pathBits, siblings = zero cache.
    inSiblings: [zero.slice(0, 26).map(String), zero.slice(0, 26).map(String)],
    inPathBits: [Array(26).fill('0'), Array(26).fill('0')],
    inIsDummy: ['0', '1'],
    // No output notes — unshield the full amount.
    outTokenMint: ['0', '0'],
    outValue: ['0', '0'],
    outRandom: ['0', '0'],
    outSpendingPub: ['0', '0'],
    outIsDummy: ['1', '1'],
    relayerFeeRecipient: feeRecipient.toString(),
    recipientOwnerLow: recipLow.toString(),
    recipientOwnerHigh: recipHigh.toString(),
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

/**
 * groth16-solana expects `proof_a` with its y-coordinate negated so the
 * pairing check is expressed as `e(-A, B) * e(α, β) * ... = 1`.
 * VK's alpha and IC points are NOT negated; this transform applies only
 * to proof_a produced by snarkjs.
 */
function g1ToProofABytes(jacDec) {
  const jac = g1JacFromDec(jacDec);
  const aff = bn128.G1.toAffine(jac);
  const xBe = feBeBytes32Mont(aff.slice(0, 32));
  // Negate y: y' = p - y  (mod p), done in standard (non-Montgomery) form.
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
  // groth16-solana convention: x.c1 || x.c0 || y.c1 || y.c0 (each BE 32B).
  return new Uint8Array([
    ...feBeBytes32Mont(aff.slice(32, 64)),  // x.c1
    ...feBeBytes32Mont(aff.slice(0, 32)),   // x.c0
    ...feBeBytes32Mont(aff.slice(96, 128)), // y.c1
    ...feBeBytes32Mont(aff.slice(64, 96)),  // y.c0
  ]);
}

async function main() {
  if (!fs.existsSync(WASM) || !fs.existsSync(ZKEY)) {
    console.error('missing artifacts. run compile.sh + ceremony first.');
    process.exit(1);
  }

  // Scenario selector via argv[2]. Defaults to 'valid'.
  const scenario = process.argv[2] ?? 'valid';
  const scenarios = {
    valid:    { mode: 'shield',   random: 777n },
    alt:      { mode: 'shield',   random: 888n },   // same shield, different random
    unshield: { mode: 'unshield', random: 777n },   // spend the note created by `valid`
  };
  const opts = scenarios[scenario];
  if (!opts) {
    console.error(`unknown scenario "${scenario}". known: ${Object.keys(scenarios).join(', ')}`);
    process.exit(1);
  }

  const input = await buildInput(opts);
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, WASM, ZKEY);

  // Sanity: verify locally before emit.
  const vKey = JSON.parse(fs.readFileSync(path.join(BUILD, 'ceremony/verification_key.json'), 'utf8'));
  const ok = await snarkjs.groth16.verify(vKey, publicSignals, proof);
  if (!ok) throw new Error('local verify failed — aborting artifact emit');

  const proofABe = toHex(g1ToProofABytes(proof.pi_a));
  const proofBBe = toHex(g2ToProofBytes(proof.pi_b));
  const proofCBe = toHex(g1ToProofBytes(proof.pi_c));
  const publicBe = publicSignals.map((s) => toHex(decToBeBytes32(s)));

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const out = {
    note: 'Generated from a throwaway-ceremony zkey. DEVNET ONLY.',
    proof_a_be: proofABe,
    proof_b_be: proofBBe,
    proof_c_be: proofCBe,
    public_inputs_be: publicBe,
    public_decimals: publicSignals,
  };
  const outFile = scenario === 'valid' ? 'shield_valid.json' : `shield_${scenario}.json`;
  const outPath = path.join(OUT_DIR, outFile);
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(`✓ wrote ${outPath} (scenario=${scenario})`);
}

main()
  .then(() => process.exit(0))  // snarkjs / ffjavascript keep worker threads alive; force exit
  .catch((e) => { console.error(e); process.exit(1); });

#!/usr/bin/env node
/**
 * Convert snarkjs `verification_key.json` → Rust source compatible with
 * `groth16-solana`'s `Groth16Verifyingkey`.
 *
 * Output: programs/b402-verifier-transact/src/vk.rs
 *
 * Format:
 *   - G1 points: 64 bytes = x_be_32 || y_be_32 (affine, big-endian)
 *   - G2 points: 128 bytes = (negated Y-major convention used by groth16-solana)
 *     x = x.c1 || x.c0, y = y.c1 || y.c0, each 32B BE
 *   - IC: array of G1 points, one per public input + 1 for the constant term
 *
 * Source of truth for byte layout:
 *   https://github.com/Lightprotocol/groth16-solana
 *
 * The affine conversion uses ffjavascript (snarkjs dependency) so we don't
 * pull in an additional curve dep.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// eslint-disable-next-line import/no-unresolved
import { utils, buildBn128 } from 'ffjavascript';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_IN = path.resolve(__dirname, '../build/ceremony/verification_key.json');
const DEFAULT_OUT = path.resolve(__dirname, '../../programs/b402-verifier-transact/src/vk.rs');

const inPath = process.argv[2] ?? DEFAULT_IN;
const outPath = process.argv[3] ?? DEFAULT_OUT;

if (!fs.existsSync(inPath)) {
  console.error(`missing VK: ${inPath}`);
  process.exit(1);
}

const vk = JSON.parse(fs.readFileSync(inPath, 'utf8'));
const bn128 = await buildBn128();
const F1 = bn128.G1.F;
const F2 = bn128.G2.F;

function feBeBytes32(fe) {
  // fe is a Uint8Array in Montgomery form (ffjs internal) — convert to
  // standard, then to 32-byte BE.
  const std = F1.fromMontgomery(fe);
  const bi = utils.leBuff2int(std);
  return beBytes32(bi);
}

function f2BeBytesPair(fe2) {
  // fe2 is [c0, c1] each in Montgomery form.
  const c0Std = F1.fromMontgomery(fe2[0]);
  const c1Std = F1.fromMontgomery(fe2[1]);
  return {
    c0: beBytes32(utils.leBuff2int(c0Std)),
    c1: beBytes32(utils.leBuff2int(c1Std)),
  };
}

function beBytes32(bi) {
  let hex = bi.toString(16);
  if (hex.length > 64) throw new Error('scalar overflow');
  hex = hex.padStart(64, '0');
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function concatU8(arrays) {
  const total = arrays.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrays) { out.set(a, off); off += a.length; }
  return out;
}

/** Build a 96-byte Jacobian G1 buffer from [x, y, z] decimal strings. */
function strArrayToJacG1(arr) {
  return concatU8([F1.e(arr[0]), F1.e(arr[1]), F1.e(arr[2])]);
}

/** Build a 192-byte Jacobian G2 buffer from [[x0,x1],[y0,y1],[z0,z1]] decimal strings. */
function strArrayToJacG2(arr) {
  return concatU8([
    F1.e(arr[0][0]), F1.e(arr[0][1]),
    F1.e(arr[1][0]), F1.e(arr[1][1]),
    F1.e(arr[2][0]), F1.e(arr[2][1]),
  ]);
}

function g1ToBytes64(jacBuf) {
  // toAffine returns 64 bytes (x || y), each 32B in Montgomery form.
  const affMont = bn128.G1.toAffine(jacBuf);
  const xMont = affMont.slice(0, 32);
  const yMont = affMont.slice(32, 64);
  const x = feBeBytes32(xMont);
  const y = feBeBytes32(yMont);
  return [...x, ...y];
}

function g2ToBytes128(jacBuf) {
  // G2.toAffine returns 128 bytes = (x.c0, x.c1, y.c0, y.c1), each 32B Montgomery.
  const affMont = bn128.G2.toAffine(jacBuf);
  const xC0 = affMont.slice(0, 32);
  const xC1 = affMont.slice(32, 64);
  const yC0 = affMont.slice(64, 96);
  const yC1 = affMont.slice(96, 128);
  const xC0Be = feBeBytes32(xC0);
  const xC1Be = feBeBytes32(xC1);
  const yC0Be = feBeBytes32(yC0);
  const yC1Be = feBeBytes32(yC1);
  // groth16-solana encoding: x.c1 || x.c0 || y.c1 || y.c0.
  return [...xC1Be, ...xC0Be, ...yC1Be, ...yC0Be];
}

const alphaG1 = g1ToBytes64(strArrayToJacG1(vk.vk_alpha_1));
const betaG2  = g2ToBytes128(strArrayToJacG2(vk.vk_beta_2));
const gammaG2 = g2ToBytes128(strArrayToJacG2(vk.vk_gamma_2));
const deltaG2 = g2ToBytes128(strArrayToJacG2(vk.vk_delta_2));

const ic = vk.IC.map((p) => g1ToBytes64(strArrayToJacG1(p)));

function bytesToLiteral(bytes) {
  return '[' + bytes.map((b) => `0x${b.toString(16).padStart(2, '0')}`).join(', ') + ']';
}

const icBlocks = ic.map((b) => `    ${bytesToLiteral(b)},`).join('\n');

const out = `//! AUTO-GENERATED. Do not edit.
//! Source: ${path.relative(path.dirname(outPath), inPath)}
//! Generator: circuits/scripts/vk-to-rust.mjs
//!
//! Format is groth16-solana's \`Groth16Verifyingkey\`.
//! VK hash is recorded in tests; any regeneration must update the pinned hash.

use groth16_solana::groth16::Groth16Verifyingkey;

pub const VK_ALPHA_G1: [u8; 64] = ${bytesToLiteral(alphaG1)};

pub const VK_BETA_G2: [u8; 128] = ${bytesToLiteral(betaG2)};

pub const VK_GAMMA_G2: [u8; 128] = ${bytesToLiteral(gammaG2)};

pub const VK_DELTA_G2: [u8; 128] = ${bytesToLiteral(deltaG2)};

pub const VK_IC: [[u8; 64]; ${ic.length}] = [
${icBlocks}
];

pub const TRANSACT_VK: Groth16Verifyingkey = Groth16Verifyingkey {
    nr_pubinputs: ${ic.length - 1},
    vk_alpha_g1: VK_ALPHA_G1,
    vk_beta_g2: VK_BETA_G2,
    vk_gamme_g2: VK_GAMMA_G2,
    vk_delta_g2: VK_DELTA_G2,
    vk_ic: &VK_IC,
};
`;

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, out);
console.log(`✓ wrote ${outPath}`);
console.log(`  nr_pubinputs = ${ic.length - 1}`);
// ffjavascript keeps worker threads alive → force exit so scripts don't hang.
process.exit(0);

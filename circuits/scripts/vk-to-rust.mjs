#!/usr/bin/env node
/**
 * Convert snarkjs `verification_key.json` → Rust source compatible with
 * `groth16-solana`'s `Groth16Verifyingkey`.
 *
 * Usage (all flags REQUIRED — no implicit defaults; the previous default
 * silently clobbered programs/b402-verifier-transact/src/vk.rs whenever a
 * caller forgot to specify the output path):
 *
 *   node vk-to-rust.mjs \
 *     --in  circuits/build/ceremony/adapt_verification_key.json \
 *     --out programs/b402-verifier-adapt/src/vk.rs \
 *     --const ADAPT_VK \
 *     [--force]
 *
 * Safety:
 *   - Refuses to write if --in does not exist or fails JSON parse.
 *   - Refuses to write if --in lacks the expected snarkjs VK fields.
 *   - Refuses to overwrite an existing --out whose `Source:` header points
 *     to a DIFFERENT input than the one currently being processed (likely
 *     a wrong-target write). Override with --force.
 *   - Atomic write: writes to <out>.tmp then renames, so a kill mid-write
 *     doesn't leave a half-baked file.
 *
 * Format:
 *   - G1 points: 64 bytes = x_be_32 || y_be_32 (affine, big-endian)
 *   - G2 points: 128 bytes (negated Y-major convention used by groth16-solana)
 *     x = x.c1 || x.c0, y = y.c1 || y.c0, each 32B BE
 *   - IC: array of G1 points, one per public input + 1 for the constant term
 *
 * Source of truth for byte layout:
 *   https://github.com/Lightprotocol/groth16-solana
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// eslint-disable-next-line import/no-unresolved
import { utils, buildBn128 } from 'ffjavascript';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── arg parsing ──────────────────────────────────────────────────────
function die(msg) {
  console.error(`vk-to-rust: ${msg}`);
  console.error(
    'usage: vk-to-rust.mjs --in <vk.json> --out <vk.rs> --const <NAME> [--force]',
  );
  process.exit(1);
}

const args = process.argv.slice(2);
let inPath = null;
let outPath = null;
let vkConstName = null;
let force = false;

for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--in')        { inPath      = args[++i]; }
  else if (a === '--out')  { outPath     = args[++i]; }
  else if (a === '--const'){ vkConstName = args[++i]; }
  else if (a === '--force'){ force = true; }
  else                     { die(`unknown arg: ${a}`); }
}

if (!inPath || !outPath || !vkConstName) {
  die('all of --in, --out, --const are required');
}

inPath  = path.resolve(inPath);
outPath = path.resolve(outPath);

if (!/^[A-Z_][A-Z0-9_]*$/.test(vkConstName)) {
  die(`--const must be SCREAMING_SNAKE_CASE; got "${vkConstName}"`);
}

if (!fs.existsSync(inPath)) {
  die(`--in does not exist: ${inPath}`);
}
if (!fs.existsSync(path.dirname(outPath))) {
  die(`--out parent directory does not exist: ${path.dirname(outPath)}`);
}

// ── parse + validate the input VK ────────────────────────────────────
let vk;
try {
  vk = JSON.parse(fs.readFileSync(inPath, 'utf8'));
} catch (e) {
  die(`--in is not valid JSON: ${e.message}`);
}

const REQUIRED_VK_FIELDS = [
  'protocol', 'curve', 'nPublic',
  'vk_alpha_1', 'vk_beta_2', 'vk_gamma_2', 'vk_delta_2', 'IC',
];
for (const f of REQUIRED_VK_FIELDS) {
  if (vk[f] === undefined) die(`--in missing required VK field: ${f}`);
}
if (vk.protocol !== 'groth16') {
  die(`--in protocol must be groth16; got ${vk.protocol}`);
}
if (vk.curve !== 'bn128') {
  die(`--in curve must be bn128; got ${vk.curve}`);
}
if (!Array.isArray(vk.IC) || vk.IC.length < 1) {
  die(`--in IC must be a non-empty array`);
}
if (vk.IC.length !== vk.nPublic + 1) {
  die(`--in inconsistent: nPublic=${vk.nPublic}, IC.length=${vk.IC.length} (expected nPublic+1)`);
}

// ── target-mismatch guard ────────────────────────────────────────────
// If --out exists and its `Source:` header points to a different file,
// require --force. This catches the original bug where vk-to-rust wrote
// the new adapt VK into transact/vk.rs because the caller forgot --out.
if (fs.existsSync(outPath) && !force) {
  const existing = fs.readFileSync(outPath, 'utf8');
  const m = existing.match(/^\/\/!\s*Source:\s*(\S+)/m);
  if (m) {
    const existingSource = m[1];
    const proposedSource = path.relative(path.dirname(outPath), inPath);
    if (existingSource !== proposedSource) {
      die(
        `refusing to overwrite ${outPath}\n` +
        `  existing Source: ${existingSource}\n` +
        `  proposed Source: ${proposedSource}\n` +
        `  Pass --force if you really mean to retarget this file.`,
      );
    }
  }
}

// ── transform ────────────────────────────────────────────────────────
const bn128 = await buildBn128();
const F1 = bn128.G1.F;
// (F2 not used — keep for documentation symmetry)
// const F2 = bn128.G2.F;

function feBeBytes32(fe) {
  // fe is a Uint8Array in Montgomery form (ffjs internal) — convert to
  // standard, then to 32-byte BE.
  const std = F1.fromMontgomery(fe);
  const bi = utils.leBuff2int(std);
  return beBytes32(bi);
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

function strArrayToJacG1(arr) {
  return concatU8([F1.e(arr[0]), F1.e(arr[1]), F1.e(arr[2])]);
}

function strArrayToJacG2(arr) {
  return concatU8([
    F1.e(arr[0][0]), F1.e(arr[0][1]),
    F1.e(arr[1][0]), F1.e(arr[1][1]),
    F1.e(arr[2][0]), F1.e(arr[2][1]),
  ]);
}

function g1ToBytes64(jacBuf) {
  const affMont = bn128.G1.toAffine(jacBuf);
  return [...feBeBytes32(affMont.slice(0, 32)), ...feBeBytes32(affMont.slice(32, 64))];
}

function g2ToBytes128(jacBuf) {
  const affMont = bn128.G2.toAffine(jacBuf);
  const xC0 = feBeBytes32(affMont.slice(0, 32));
  const xC1 = feBeBytes32(affMont.slice(32, 64));
  const yC0 = feBeBytes32(affMont.slice(64, 96));
  const yC1 = feBeBytes32(affMont.slice(96, 128));
  // groth16-solana encoding: x.c1 || x.c0 || y.c1 || y.c0.
  return [...xC1, ...xC0, ...yC1, ...yC0];
}

const alphaG1 = g1ToBytes64(strArrayToJacG1(vk.vk_alpha_1));
const betaG2  = g2ToBytes128(strArrayToJacG2(vk.vk_beta_2));
const gammaG2 = g2ToBytes128(strArrayToJacG2(vk.vk_gamma_2));
const deltaG2 = g2ToBytes128(strArrayToJacG2(vk.vk_delta_2));
const ic      = vk.IC.map((p) => g1ToBytes64(strArrayToJacG1(p)));

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

pub const ${vkConstName}: Groth16Verifyingkey = Groth16Verifyingkey {
    nr_pubinputs: ${ic.length - 1},
    vk_alpha_g1: VK_ALPHA_G1,
    vk_beta_g2: VK_BETA_G2,
    vk_gamme_g2: VK_GAMMA_G2,
    vk_delta_g2: VK_DELTA_G2,
    vk_ic: &VK_IC,
};
`;

// ── atomic write ─────────────────────────────────────────────────────
const tmpPath = `${outPath}.tmp.${process.pid}`;
fs.writeFileSync(tmpPath, out);
fs.renameSync(tmpPath, outPath);

// ── verify written content matches expectations ──────────────────────
const written = fs.readFileSync(outPath, 'utf8');
const ok =
  written.includes(`nr_pubinputs: ${ic.length - 1},`) &&
  written.includes(`VK_IC: [[u8; 64]; ${ic.length}]`) &&
  written.includes(`pub const ${vkConstName}:`);
if (!ok) {
  // Should never happen — we just wrote the file. But check is cheap.
  die(`post-write verification failed: ${outPath} does not look right`);
}

console.log(`✓ wrote ${outPath}`);
console.log(`  nPublic       = ${vk.nPublic}`);
console.log(`  nr_pubinputs  = ${ic.length - 1}`);
console.log(`  VK_IC.length  = ${ic.length}`);
console.log(`  const         = ${vkConstName}`);
// ffjavascript keeps worker threads alive → force exit so scripts don't hang.
process.exit(0);

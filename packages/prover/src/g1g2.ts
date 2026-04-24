/**
 * G1/G2 serialization helpers matching `groth16-solana`'s on-chain format.
 *
 * Encapsulates the Y-negation of proof_a and the (c1||c0) G2 convention —
 * if this file is wrong, nothing downstream verifies.
 *
 * Parity tested against `circuits/scripts/gen-test-proof.mjs`; any divergence
 * shows up in the Rust verifier integration test.
 */

// @ts-expect-error — ffjavascript lacks types
import { utils, buildBn128 } from 'ffjavascript';

const BN254_P = 21888242871839275222246405745257275088696311157297823662689037894645226208583n;

let _bn128: any | null = null;
async function bn128() {
  if (!_bn128) _bn128 = await buildBn128();
  return _bn128;
}

function beBytes32FromBigint(v: bigint): Uint8Array {
  const hex = v.toString(16).padStart(64, '0');
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function feBeBytes32Mont(feMont: Uint8Array): Uint8Array {
  // ffjavascript stores field elements in Montgomery form internally.
  // Need to materialize the standard (non-Montgomery) representation, then BE-encode.
  // Fall back path if fromMontgomery is unavailable — convert via bigint roundtrip.
  return (async () => {
    const curve = await bn128();
    const std = curve.G1.F.fromMontgomery(feMont);
    const bi = utils.leBuff2int(std);
    return beBytes32FromBigint(bi);
  })() as any;
}

export async function g1JacFromSnarkjs(dec: [string, string, string]): Promise<Uint8Array> {
  const curve = await bn128();
  const out = new Uint8Array(96);
  out.set(curve.G1.F.e(dec[0]), 0);
  out.set(curve.G1.F.e(dec[1]), 32);
  out.set(curve.G1.F.e(dec[2]), 64);
  return out;
}

export async function g2JacFromSnarkjs(dec: [[string, string], [string, string], [string, string]]): Promise<Uint8Array> {
  const curve = await bn128();
  const out = new Uint8Array(192);
  out.set(curve.G1.F.e(dec[0][0]), 0);
  out.set(curve.G1.F.e(dec[0][1]), 32);
  out.set(curve.G1.F.e(dec[1][0]), 64);
  out.set(curve.G1.F.e(dec[1][1]), 96);
  out.set(curve.G1.F.e(dec[2][0]), 128);
  out.set(curve.G1.F.e(dec[2][1]), 160);
  return out;
}

/** Convert a snarkjs G1 Jacobian point to 64-byte BE (x || y) affine bytes. */
export async function g1ToBytes64(jac: Uint8Array): Promise<Uint8Array> {
  const curve = await bn128();
  const aff = curve.G1.toAffine(jac);
  const x = await mont32ToBe32(aff.slice(0, 32));
  const y = await mont32ToBe32(aff.slice(32, 64));
  const out = new Uint8Array(64);
  out.set(x, 0); out.set(y, 32);
  return out;
}

/**
 * Same as `g1ToBytes64` but with y negated mod p.
 * Required for `proof_a` per groth16-solana's pairing convention
 * (`e(-A, B) * e(α, β) * e(IC, γ) * e(C, δ) = 1`).
 */
export async function g1ToBytes64ProofA(jac: Uint8Array): Promise<Uint8Array> {
  const curve = await bn128();
  const aff = curve.G1.toAffine(jac);
  const xBe = await mont32ToBe32(aff.slice(0, 32));

  const yStd = curve.G1.F.fromMontgomery(aff.slice(32, 64));
  const yBi = utils.leBuff2int(yStd);
  const yNeg = (BN254_P - yBi) % BN254_P;
  const yNegBe = beBytes32FromBigint(yNeg);

  const out = new Uint8Array(64);
  out.set(xBe, 0); out.set(yNegBe, 32);
  return out;
}

/** Convert snarkjs G2 Jacobian to 128-byte (x.c1 || x.c0 || y.c1 || y.c0) BE. */
export async function g2ToBytes128(jac: Uint8Array): Promise<Uint8Array> {
  const curve = await bn128();
  const aff = curve.G2.toAffine(jac);
  const xC0 = await mont32ToBe32(aff.slice(0, 32));
  const xC1 = await mont32ToBe32(aff.slice(32, 64));
  const yC0 = await mont32ToBe32(aff.slice(64, 96));
  const yC1 = await mont32ToBe32(aff.slice(96, 128));
  const out = new Uint8Array(128);
  out.set(xC1, 0); out.set(xC0, 32); out.set(yC1, 64); out.set(yC0, 96);
  return out;
}

async function mont32ToBe32(feMont: Uint8Array): Promise<Uint8Array> {
  const curve = await bn128();
  const std = curve.G1.F.fromMontgomery(feMont);
  const bi = utils.leBuff2int(std);
  return beBytes32FromBigint(bi);
}

/** Decimal Fr → 32-byte BE buffer (for public inputs). */
export function decToBeBytes32(dec: string | bigint): Uint8Array {
  const v = typeof dec === 'string' ? BigInt(dec) : dec;
  return beBytes32FromBigint(v);
}

// Silence the unused helper lint (kept for parity with the generator script).
void feBeBytes32Mont;

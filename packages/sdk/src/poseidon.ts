/**
 * Poseidon hash wrapper over circomlibjs. MUST produce bit-identical output to
 * the Rust `b402-crypto` crate and the Circom circuits. Parity tests in
 * `tests/parity/` enforce this.
 */

// @ts-expect-error — circomlibjs lacks types
import { buildPoseidon } from 'circomlibjs';
import { domainTag } from '@b402ai/solana-shared';
import type { DomainTagName } from '@b402ai/solana-shared';

let _poseidon: any | null = null;
let _building: Promise<any> | null = null;

async function getPoseidon(): Promise<any> {
  if (_poseidon) return _poseidon;
  if (!_building) _building = buildPoseidon();
  _poseidon = await _building;
  return _poseidon;
}

async function poseidonRaw(inputs: bigint[]): Promise<bigint> {
  const p = await getPoseidon();
  const h = p(inputs.map((x) => p.F.e(x.toString())));
  return BigInt(p.F.toString(h));
}

export async function poseidonTagged(tag: DomainTagName, ...inputs: bigint[]): Promise<bigint> {
  return poseidonRaw([domainTag(tag), ...inputs]);
}

export async function commitmentHash(
  tokenMint: bigint,
  value: bigint,
  random: bigint,
  spendingPub: bigint,
): Promise<bigint> {
  return poseidonTagged('commit', tokenMint, value, random, spendingPub);
}

export async function nullifierHash(spendingPriv: bigint, leafIndex: bigint): Promise<bigint> {
  return poseidonTagged('nullifier', spendingPriv, leafIndex);
}

export async function spendingPub(spendingPriv: bigint): Promise<bigint> {
  return poseidonTagged('spendKeyPub', spendingPriv);
}

export async function merkleNodeHash(left: bigint, right: bigint): Promise<bigint> {
  return poseidonTagged('mkNode', left, right);
}

export async function merkleZeroSeed(): Promise<bigint> {
  return poseidonTagged('mkZero');
}

export async function feeBindHash(recipientAsFr: bigint, fee: bigint): Promise<bigint> {
  return poseidonTagged('feeBind', recipientAsFr, fee);
}

/**
 * Rust ↔ TS parity tests.
 *
 * Shells out to the `b402-crypto` Rust crate via a small parity binary
 * and compares outputs against the TS impl on randomized inputs.
 *
 * Gated by RUN_PARITY=1 (runs a subprocess; skip in lightweight dev runs).
 */

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import {
  commitment, nullifier, spendingPub, merkleNode, merkleZeroSeed,
  ClientMerkleTree, tagToFr, DomainTags,
} from './helpers';

const RUN = process.env.RUN_PARITY === '1';
const d = RUN ? describe : describe.skip;

const PARITY_BIN = path.resolve(__dirname, '../../target/debug/b402-parity');

function rustCall(cmd: string[]): string {
  return execFileSync(PARITY_BIN, cmd, { encoding: 'utf-8' }).trim();
}

function ensureParityBin() {
  if (!fs.existsSync(PARITY_BIN)) {
    throw new Error(
      `parity binary missing. Run: cargo build -p b402-crypto --bin b402-parity`,
    );
  }
}

d('rust ↔ ts parity', () => {
  it('binary exists', () => {
    ensureParityBin();
  });

  it('poseidon_2(1, 2) matches', async () => {
    ensureParityBin();
    const ts = (await import('./helpers')).poseidonTagged;
    const tsOut = (await ts('commit', 1n, 2n)).toString();
    const rustOut = rustCall(['poseidon-tagged', 'commit', '1', '2']);
    expect(tsOut).toBe(rustOut);
  });

  it('commitment matches', async () => {
    ensureParityBin();
    const tsOut = (await commitment(1n, 100n, 42n, 99n)).toString();
    const rustOut = rustCall(['commitment', '1', '100', '42', '99']);
    expect(tsOut).toBe(rustOut);
  });

  it('nullifier matches', async () => {
    ensureParityBin();
    const tsOut = (await nullifier(7n, 13n)).toString();
    const rustOut = rustCall(['nullifier', '7', '13']);
    expect(tsOut).toBe(rustOut);
  });

  it('spendingPub matches', async () => {
    ensureParityBin();
    const tsOut = (await spendingPub(42n)).toString();
    const rustOut = rustCall(['spending-pub', '42']);
    expect(tsOut).toBe(rustOut);
  });

  it('merkle zero cache agrees at depth 26', async () => {
    ensureParityBin();
    const tree = new ClientMerkleTree(26);
    await tree.init();
    const tsRoot = tree.root.toString();
    const rustRoot = rustCall(['merkle-empty-root']);
    expect(tsRoot).toBe(rustRoot);
  });

  it('merkle append sequence agrees', async () => {
    ensureParityBin();
    const tree = new ClientMerkleTree(26);
    await tree.init();
    const leaves = [1n, 2n, 3n, 4n, 5n, 6n, 7n];
    for (const leaf of leaves) {
      await tree.append(leaf);
    }
    const tsRoot = tree.root.toString();
    const rustRoot = rustCall(['merkle-append', ...leaves.map(String)]);
    expect(tsRoot).toBe(rustRoot);
  });
});

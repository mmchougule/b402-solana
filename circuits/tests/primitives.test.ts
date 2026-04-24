/**
 * Primitive parity and sanity tests.
 * These run without a circom compile — just spec-level crypto.
 */

import { describe, it, expect } from 'vitest';
import { tagToFr, poseidonTagged, commitment, nullifier, spendingPub, merkleNode, computeZeroCache, ClientMerkleTree, DomainTags } from './helpers';

describe('domain tags', () => {
  it('are deterministic', () => {
    expect(tagToFr(DomainTags.commit)).toBe(tagToFr(DomainTags.commit));
  });

  it('are pairwise distinct', () => {
    const frs = Object.values(DomainTags).map(tagToFr);
    for (let i = 0; i < frs.length; i++) {
      for (let j = i + 1; j < frs.length; j++) {
        expect(frs[i]).not.toBe(frs[j]);
      }
    }
  });

  it('are under the BN254 modulus', () => {
    const P = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
    for (const tag of Object.values(DomainTags)) {
      expect(tagToFr(tag)).toBeLessThan(P);
    }
  });
});

describe('commitment', () => {
  it('is deterministic', async () => {
    const a = await commitment(1n, 100n, 42n, 99n);
    const b = await commitment(1n, 100n, 42n, 99n);
    expect(a).toBe(b);
  });

  it('depends on every input', async () => {
    const base = await commitment(1n, 100n, 42n, 99n);
    expect(await commitment(2n, 100n, 42n, 99n)).not.toBe(base);
    expect(await commitment(1n, 101n, 42n, 99n)).not.toBe(base);
    expect(await commitment(1n, 100n, 43n, 99n)).not.toBe(base);
    expect(await commitment(1n, 100n, 42n, 100n)).not.toBe(base);
  });
});

describe('nullifier', () => {
  it('differs by leafIndex', async () => {
    const a = await nullifier(7n, 0n);
    const b = await nullifier(7n, 1n);
    expect(a).not.toBe(b);
  });

  it('differs by spendingPriv', async () => {
    const a = await nullifier(7n, 0n);
    const b = await nullifier(8n, 0n);
    expect(a).not.toBe(b);
  });
});

describe('spendingPub derivation', () => {
  it('is deterministic', async () => {
    expect(await spendingPub(42n)).toBe(await spendingPub(42n));
  });
  it('differs from the private key', async () => {
    expect(await spendingPub(42n)).not.toBe(42n);
  });
});

describe('merkle', () => {
  it('zero-cache is deterministic', async () => {
    const a = await computeZeroCache(26);
    const b = await computeZeroCache(26);
    expect(a).toEqual(b);
    expect(a.length).toBe(27);
  });

  it('empty tree root matches zero_cache[depth]', async () => {
    const t = new ClientMerkleTree(26);
    await t.init();
    const zc = await computeZeroCache(26);
    expect(t.root).toBe(zc[26]);
  });

  it('append one leaf and proof roundtrips', async () => {
    const t = new ClientMerkleTree(26);
    await t.init();
    await t.append(0x1234n);
    const p = await t.prove(0n);
    expect(p.leaf).toBe(0x1234n);
    expect(p.root).toBe(t.root);
    // Verify: walk up the path
    let cur = p.leaf;
    for (let i = 0; i < 26; i++) {
      const left = p.pathBits[i] === 1 ? p.siblings[i] : cur;
      const right = p.pathBits[i] === 1 ? cur : p.siblings[i];
      cur = await merkleNode(left, right);
    }
    expect(cur).toBe(p.root);
  });

  it('proof roundtrips for many leaves', async () => {
    const t = new ClientMerkleTree(26);
    await t.init();
    for (let i = 0; i < 17; i++) await t.append(BigInt(i + 1));
    for (let i = 0; i < 17; i++) {
      const p = await t.prove(BigInt(i));
      // Walk up
      let cur = p.leaf;
      for (let level = 0; level < 26; level++) {
        const left = p.pathBits[level] === 1 ? p.siblings[level] : cur;
        const right = p.pathBits[level] === 1 ? cur : p.siblings[level];
        cur = await merkleNode(left, right);
      }
      expect(cur).toBe(t.root);
    }
  });
});

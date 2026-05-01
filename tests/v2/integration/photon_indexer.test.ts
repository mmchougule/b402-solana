/**
 * Phase 0 — T0.4, T0.5
 *
 * Verifies Photon (the indexer that serves validity proofs) is healthy and
 * answers the API methods our SDK will depend on at unshield time.
 *
 * Pre-req: `light test-validator` is running (photon on 8784).
 *
 * Notes:
 *   - We test the JSON-RPC surface directly with fetch rather than via
 *     @lightprotocol/stateless.js, so a regression in their SDK can't mask
 *     a Photon outage in our gating tests.
 */
import { describe, it, expect, beforeAll } from 'vitest';

const PHOTON_RPC = 'http://127.0.0.1:8784';

async function rpc(method: string, params: unknown[] = []): Promise<unknown> {
  const res = await fetch(PHOTON_RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: Math.floor(Math.random() * 1e9), method, params }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = (await res.json()) as { result?: unknown; error?: { code: number; message: string } };
  if (json.error) throw new Error(`RPC ${method} error ${json.error.code}: ${json.error.message}`);
  return json.result;
}

describe('Phase 0 — Photon indexer', () => {
  describe('T0.4 — Photon is reachable and reports healthy state', () => {
    it('getIndexerHealth returns "ok"', async () => {
      const health = await rpc('getIndexerHealth');
      expect(health).toBe('ok');
    });

    it('getIndexerSlot returns a positive integer', async () => {
      const slot = (await rpc('getIndexerSlot')) as number;
      expect(typeof slot).toBe('number');
      expect(slot).toBeGreaterThan(0);
    });

    it('rejects unknown methods cleanly', async () => {
      await expect(rpc('thisMethodDoesNotExist')).rejects.toThrow(/error/i);
    });
  });

  describe('T0.5 — Photon serves a validity proof for an unused address', () => {
    // We exercise this through @lightprotocol/stateless.js because that is
    // exactly the path our SDK will take in Phase 4 — testing the same
    // surface the production code uses, not a hand-crafted RPC shape.
    it('getValidityProof returns a non-inclusion proof for an unused address', async () => {
      const { createRpc, bn } = await import('@lightprotocol/stateless.js');
      const rpc = createRpc(undefined, PHOTON_RPC);

      // 32-byte address overwhelmingly unlikely to collide with any
      // nullifier ever inserted into the address tree. Top 2 bytes zero
      // so the value stays under the BN254 scalar field modulus (254 bits).
      const unusedBytes = new Uint8Array(32);
      for (let i = 2; i < 32; i++) unusedBytes[i] = (i * 17 + 251) & 0xff;

      // hashes = [], newAddresses = [unusedBytes] → request a non-inclusion
      // proof for one fresh address against Photon's default address tree.
      const proof = await rpc.getValidityProof([], [bn(unusedBytes)]);

      expect(proof, 'no proof returned').toBeDefined();
      expect(proof.compressedProof, 'no compressedProof field').toBeDefined();
      // Groth16 proof has 3 components a, b, c.
      expect(proof.compressedProof.a).toBeDefined();
      expect(proof.compressedProof.b).toBeDefined();
      expect(proof.compressedProof.c).toBeDefined();
      // Root indices identify which version of the address tree this proof
      // is built against — needed at SDK-side to compose the on-chain ix.
      expect(proof.rootIndices.length).toBeGreaterThan(0);
      expect(proof.roots.length).toBeGreaterThan(0);
    });
  });
});

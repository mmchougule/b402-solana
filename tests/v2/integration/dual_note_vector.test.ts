/**
 * Phase 9 dual-note minting — TS ↔ Rust parity vector.
 *
 * Locks down a single fixed `(commitment_a, excess, spending_pub, out_mint)`
 * tuple and asserts the SDK-side `commitment_b` matches a frozen hex value.
 * The matching Rust test
 * (`programs/b402-pool/tests/excess_commitment_parity.rs`) recomputes the
 * same value via `solana_program::poseidon::hashv` and asserts the same
 * hex — guaranteeing pool and SDK derive byte-identical excess commitments
 * for the same inputs.
 *
 * If this test ever fails after a Poseidon-library upgrade, both sides have
 * drifted — fix them in lockstep, never just the test.
 *
 * Run: `pnpm -F @b402ai/solana-v2-tests test integration/dual_note_vector`
 */

import { describe, it, expect } from 'vitest';
import { computeExcessCommitment, deriveExcessRandom } from '@b402ai/solana';
import { frToLe } from '@b402ai/solana-shared';

// ---- Frozen fixture (deterministic; do not change without rotating the
// expected hex below alongside it). All values are < BN254 Fr modulus.
const FIXTURE = {
  // Stand-in `commitmentOut[0]` from the proof. Any < p value works.
  commitmentA: 0x1122334455667788_99aabbccddeeff00_1122334455667788_99aabbccddeeff00n,
  outMintFr:    0x0102030405060708_090a0b0c0d0e0f10_1112131415161718_191a1b1c1d1e1f20n,
  // Stand-in spending pub (Poseidon image scalar; not a Solana pubkey).
  spendingPub:  0x2a2b2c2d2e2f3031_3233343536373839_3a3b3c3d3e3f4041_4243444546474849n,
  excess:       1_234_567n, // u64 excess in smallest units of out mint
};

/**
 * EXPECTED_COMMITMENT_B_HEX is filled in on first run. The matching Rust
 * test must produce the same bytes — see
 * `programs/b402-pool/tests/excess_commitment_parity.rs`.
 *
 * To populate: run this test once with `EXPECTED_COMMITMENT_B_HEX = ''` —
 * the assertion will fail printing the actual hex; copy it into both this
 * file and the Rust test, then re-run both to confirm parity.
 */
const EXPECTED_COMMITMENT_B_HEX =
  'e7c90af0bf88c9e1ceb3ed40a4f9151982b38b4b61d34b6bcec5a55aab472315' as const;

describe('Phase 9 — dual-note commitment_b parity', () => {
  it('SDK produces a deterministic commitment_b for the frozen fixture', async () => {
    const randomB = await deriveExcessRandom(FIXTURE.commitmentA);
    const commitmentB = await computeExcessCommitment(
      FIXTURE.outMintFr,
      FIXTURE.excess,
      randomB,
      FIXTURE.spendingPub,
    );

    const le32 = frToLe(commitmentB);
    const hex = Buffer.from(le32).toString('hex');

    if (!EXPECTED_COMMITMENT_B_HEX) {
      // First run: surface the actual hex so the user can pin it.
      // eslint-disable-next-line no-console
      console.log(`[dual_note_vector] commitment_b (LE hex) = ${hex}`);
      throw new Error(
        `EXPECTED_COMMITMENT_B_HEX not yet pinned. ` +
          `Set it to "${hex}" in this file AND in ` +
          `programs/b402-pool/tests/excess_commitment_parity.rs, then re-run.`,
      );
    }

    expect(hex).toBe(EXPECTED_COMMITMENT_B_HEX);
  });

  it('deriveExcessRandom is deterministic', async () => {
    const a = await deriveExcessRandom(FIXTURE.commitmentA);
    const b = await deriveExcessRandom(FIXTURE.commitmentA);
    expect(a).toBe(b);
  });

  it('different commitment_a values produce different random_b', async () => {
    const a = await deriveExcessRandom(FIXTURE.commitmentA);
    const b = await deriveExcessRandom(FIXTURE.commitmentA + 1n);
    expect(a).not.toBe(b);
  });
});

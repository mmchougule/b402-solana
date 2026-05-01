/**
 * Phase 9 dual-note minting — SDK-side helpers.
 *
 * Mirrors `programs/b402-pool/src/instructions/adapt_execute.rs`'s excess-leaf
 * block. The pool computes `commitment_b` on-chain in Rust; this module
 * computes the same value off-chain so the SDK can insert a SpendableNote
 * for the excess leaf into the local NoteStore (and so the parity test in
 * `tests/v2/integration/dual_note_vector.test.ts` can prove byte equality
 * with the Rust output).
 *
 * Definitions (all using `Endianness::LittleEndian` Poseidon, BN254X5):
 *
 *   random_b      = Poseidon(commitment_a, TAG_EXCESS)
 *   commitment_b  = Poseidon(TAG_COMMIT, outMintFr, value, random_b, spendingPub)
 *
 * `commitment_a` is the main OUT note's commitment (the proof-bound public
 * input `commitmentOut[0]`). `value` is `actual_out - expected_out` (≥ 1).
 * `spendingPub` is the same value the prover used in `outSpendingPub[0]`
 * (and that the pool now reads from public input index 23).
 */

import { commitmentHash, poseidonTagged } from './poseidon.js';

/**
 * Derive the deterministic `random_b` for the excess-output commitment.
 *
 * Inputs:
 *   - commitmentA: the main OUT note's commitment as a bigint (matches
 *     the prover's `outCommitment` and the pool's `pi.commitment_out[0]`).
 *
 * Output: 32-byte LE Fr value (as a bigint), suitable for use as the
 * `random` field of a Poseidon `commitmentHash` call.
 */
export async function deriveExcessRandom(commitmentA: bigint): Promise<bigint> {
  // Poseidon([TAG_EXCESS, commitmentA]) — `poseidonTagged('excess', x)` is
  // exactly Poseidon([domainTag('excess'), x]) per packages/sdk/src/poseidon.ts.
  return poseidonTagged('excess', commitmentA);
}

/**
 * Compute the excess-output commitment. Wraps `commitmentHash` with the
 * Phase 9 input convention so callers don't have to remember the order.
 *
 *   commitment_b = Poseidon(TAG_COMMIT, outMintFr, excess, random_b, spendingPub)
 *
 * The Rust side (`adapt_execute.rs`) MUST produce the same bytes for the
 * same inputs — see `tests/v2/integration/dual_note_vector.test.ts`.
 */
export async function computeExcessCommitment(
  outMintFr: bigint,
  excess: bigint,
  randomB: bigint,
  spendingPub: bigint,
): Promise<bigint> {
  return commitmentHash(outMintFr, excess, randomB, spendingPub);
}

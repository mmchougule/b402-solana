/**
 * PRD-35 §5.4 — SDK helpers for the 2-tx commit-then-verify flow.
 *
 * The pool's `commit_inputs` ix takes `(spending_pub_le, public_inputs)`
 * and writes them into a per-user PDA. A subsequent `adapt_execute` ix
 * reads the inputs from that PDA via the verifier's
 * `verify_with_account_inputs` variant — saves ~700-735 B per
 * privateSwap / privateLend tx by moving the 768 B inputs out of inline
 * ix data.
 *
 * This module exposes the low-level helpers (PDA derivation + ix data
 * builder). The B402Solana orchestrator wires them into the privateSwap
 * flow when the `pendingInputsMode` config option is set.
 */

import { PublicKey, TransactionInstruction, SystemProgram } from '@solana/web3.js';
import { sha256 } from '@noble/hashes/sha256';

const TEXT = new TextEncoder();

/** Versioned namespace shared with the rest of b402. Matches
 *  programs/b402-pool/src/instructions/commit_inputs.rs::VERSION_PREFIX. */
export const VERSION_PREFIX = TEXT.encode('b402/v1');

/** PDA seed prefix for the per-user pending-inputs account. Matches
 *  commit_inputs.rs::PENDING_INPUTS_SEED. */
export const PENDING_INPUTS_SEED = TEXT.encode('pending-inputs');

/**
 * Anchor discriminator for `pool::commit_inputs`. sha256("global:commit_inputs")[0..8].
 * Pre-computed at module load (no per-call cost). If the pool fn is
 * renamed, regenerate.
 */
export const COMMIT_INPUTS_DISCRIMINATOR: Uint8Array = sha256(
  TEXT.encode('global:commit_inputs'),
).slice(0, 8);

/** Number of public inputs the adapt circuit binds, post-Phase 9. The
 *  Rust constant in verifier_cpi.rs::PUBLIC_INPUT_COUNT_ADAPT and
 *  pool::PendingInputs::LEN both use this value. */
export const PUBLIC_INPUT_COUNT_ADAPT = 24;

/**
 * Per-user PDA holding the committed public inputs. Scoped by
 * `spending_pub_le` (= 32 B LE encoding of the Phase 9 outSpendingPub[0]
 * input). Same value the proof binds — pool re-derives this PDA
 * server-side and rejects mismatches.
 */
export function derivePendingInputsPda(
  poolProgramId: PublicKey,
  spendingPubLe: Uint8Array,
): [PublicKey, number] {
  if (spendingPubLe.length !== 32) {
    throw new Error(`derivePendingInputsPda: spendingPubLe must be 32 bytes, got ${spendingPubLe.length}`);
  }
  return PublicKey.findProgramAddressSync(
    [VERSION_PREFIX, PENDING_INPUTS_SEED, spendingPubLe],
    poolProgramId,
  );
}

/**
 * Serialize the wire bytes for `pool::commit_inputs`:
 *   [8 anchor disc][32 spending_pub_le][4 vec_len LE][N×32 inputs]
 *
 * The pool's ix decodes via Borsh: spending_pub_le is a fixed [u8;32]
 * (no length prefix), public_inputs is a Vec<[u8;32]> (u32 LE length
 * prefix + N × 32 B).
 */
export function buildCommitInputsIxData(
  spendingPubLe: Uint8Array,
  inputs: Uint8Array[],
): Uint8Array {
  if (spendingPubLe.length !== 32) {
    throw new Error(`buildCommitInputsIxData: spending_pub_le must be 32 bytes, got ${spendingPubLe.length}`);
  }
  if (inputs.length === 0) {
    throw new Error(`buildCommitInputsIxData: inputs must be non-empty (pool expects ${PUBLIC_INPUT_COUNT_ADAPT})`);
  }
  for (let i = 0; i < inputs.length; i++) {
    if (inputs[i].length !== 32) {
      throw new Error(`buildCommitInputsIxData: input[${i}] must be 32 bytes, got ${inputs[i].length}`);
    }
  }
  const total = 8 + 32 + 4 + inputs.length * 32;
  const data = new Uint8Array(total);
  data.set(COMMIT_INPUTS_DISCRIMINATOR, 0);
  data.set(spendingPubLe, 8);
  // u32 LE length prefix.
  new DataView(data.buffer).setUint32(40, inputs.length, true);
  let off = 44;
  for (const fr of inputs) {
    data.set(fr, off);
    off += 32;
  }
  return data;
}

/**
 * Build the full `commit_inputs` TransactionInstruction. Account list:
 *   0: pending_inputs PDA (writable, init_if_needed)
 *   1: relayer (signer, writable — payer for first-time alloc)
 *   2: system_program
 */
export function buildCommitInputsIx(opts: {
  poolProgramId: PublicKey;
  spendingPubLe: Uint8Array;
  inputs: Uint8Array[];
  relayer: PublicKey;
}): TransactionInstruction {
  const [pendingInputsPda] = derivePendingInputsPda(opts.poolProgramId, opts.spendingPubLe);
  const data = buildCommitInputsIxData(opts.spendingPubLe, opts.inputs);
  return new TransactionInstruction({
    programId: opts.poolProgramId,
    keys: [
      { pubkey: pendingInputsPda, isSigner: false, isWritable: true },
      { pubkey: opts.relayer, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(data),
  });
}

/**
 * PRD-35 §5.4 — SDK orchestrator for the 2-tx commit-then-verify flow.
 *
 * Tests the SDK helpers in isolation:
 *   - derivePendingInputsPda matches the on-chain PDA seeds byte-for-byte
 *   - buildCommitInputsIx serializes the right discriminator + args
 *   - The 768 B of public inputs survive the round-trip via Borsh
 *
 * End-to-end privateSwap with the new flow is covered by the fork test
 * in tests/v2/e2e/v2_fork_prd_35.test.ts (35.6).
 */
import { describe, it, expect } from 'vitest';
import { PublicKey, Keypair } from '@solana/web3.js';
import { sha256 } from '@noble/hashes/sha256';
import {
  derivePendingInputsPda,
  buildCommitInputsIxData,
  COMMIT_INPUTS_DISCRIMINATOR,
  PENDING_INPUTS_SEED,
  VERSION_PREFIX,
} from '../commit-inputs.js';

const POOL_ID = new PublicKey('42a3hsCXtQLWonyxWZosaaCJCweYYKMrvNd25p1Jrt2y');

describe('derivePendingInputsPda', () => {
  it('matches the on-chain PDA derivation seeds byte-for-byte', () => {
    const spendingPubLe = new Uint8Array(32).fill(7);
    const [pda, bump] = derivePendingInputsPda(POOL_ID, spendingPubLe);
    // Re-derive the canonical way to confirm the helper does the right thing.
    const [expected, expectedBump] = PublicKey.findProgramAddressSync(
      [VERSION_PREFIX, PENDING_INPUTS_SEED, spendingPubLe],
      POOL_ID,
    );
    expect(pda.equals(expected)).toBe(true);
    expect(bump).toBe(expectedBump);
  });

  it('per-user isolation — distinct spending pubs produce distinct PDAs', () => {
    const alice = new Uint8Array(32).fill(1);
    const bob = new Uint8Array(32).fill(2);
    const [aPda] = derivePendingInputsPda(POOL_ID, alice);
    const [bPda] = derivePendingInputsPda(POOL_ID, bob);
    expect(aPda.equals(bPda)).toBe(false);
  });

  it('per-program isolation — same user, different pool IDs → different PDAs', () => {
    const user = new Uint8Array(32).fill(5);
    const otherPool = Keypair.generate().publicKey;
    const [aPda] = derivePendingInputsPda(POOL_ID, user);
    const [bPda] = derivePendingInputsPda(otherPool, user);
    expect(aPda.equals(bPda)).toBe(false);
  });
});

describe('buildCommitInputsIxData', () => {
  it('discriminator matches sha256("global:commit_inputs")[0..8]', () => {
    const expected = sha256(new TextEncoder().encode('global:commit_inputs')).slice(0, 8);
    expect(COMMIT_INPUTS_DISCRIMINATOR).toEqual(expected);
  });

  it('serializes to: 8 disc + 32 spending_pub_le + 4 vec_len + N×32 inputs', () => {
    const spendingPubLe = new Uint8Array(32).fill(0xab);
    const inputs: Uint8Array[] = Array.from({ length: 24 }, (_, i) => new Uint8Array(32).fill(i));
    const data = buildCommitInputsIxData(spendingPubLe, inputs);

    expect(data.length).toBe(8 + 32 + 4 + 24 * 32);
    // Disc.
    expect(data.slice(0, 8)).toEqual(COMMIT_INPUTS_DISCRIMINATOR);
    // Spending pub.
    expect(data.slice(8, 40)).toEqual(spendingPubLe);
    // Vec length prefix (u32 LE).
    const lenLe = new Uint8Array(4);
    new DataView(lenLe.buffer).setUint32(0, 24, true);
    expect(data.slice(40, 44)).toEqual(lenLe);
    // First input bytes.
    expect(data.slice(44, 76)).toEqual(inputs[0]);
    // Last input bytes.
    expect(data.slice(44 + 23 * 32, 44 + 24 * 32)).toEqual(inputs[23]);
  });

  it('rejects wrong-length spending_pub_le', () => {
    expect(() => buildCommitInputsIxData(new Uint8Array(31), [])).toThrow(/spending_pub_le/);
  });

  it('rejects empty inputs vector — pool requires exactly PUBLIC_INPUT_COUNT_ADAPT', () => {
    const sp = new Uint8Array(32);
    expect(() => buildCommitInputsIxData(sp, [])).toThrow(/inputs/);
  });
});

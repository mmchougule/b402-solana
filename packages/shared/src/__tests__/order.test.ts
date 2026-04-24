/**
 * Sanity checks on the public-input order constant. Catches drift between
 * the constant and what the rest of the codebase implicitly assumes.
 */

import { describe, it, expect } from 'vitest';
import {
  TRANSACT_PUBLIC_INPUT_COUNT,
  TRANSACT_PUBLIC_INPUT_ORDER,
  publicInputIndex,
} from '../constants.js';

describe('TRANSACT_PUBLIC_INPUT_ORDER', () => {
  it('length matches the count constant', () => {
    expect(TRANSACT_PUBLIC_INPUT_ORDER.length).toBe(TRANSACT_PUBLIC_INPUT_COUNT);
  });

  it('positions of fixture-critical inputs are pinned', () => {
    // These positions are what `tests/onchain/src/{shield_ix,unshield_ix}.rs`
    // and the prover assume. Changing them breaks every existing proof.
    expect(publicInputIndex('merkleRoot')).toBe(0);
    expect(publicInputIndex('nullifier0')).toBe(1);
    expect(publicInputIndex('commitmentOut0')).toBe(3);
    expect(publicInputIndex('publicAmountIn')).toBe(5);
    expect(publicInputIndex('publicAmountOut')).toBe(6);
    expect(publicInputIndex('publicTokenMint')).toBe(7);
    expect(publicInputIndex('relayerFeeBind')).toBe(9);
    expect(publicInputIndex('rootBind')).toBe(10);
    expect(publicInputIndex('recipientBind')).toBe(11);
    expect(publicInputIndex('recipientBindTag')).toBe(17);
  });

  it('all entries are unique', () => {
    const set = new Set(TRANSACT_PUBLIC_INPUT_ORDER);
    expect(set.size).toBe(TRANSACT_PUBLIC_INPUT_ORDER.length);
  });
});

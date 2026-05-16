/**
 * Wallet-isolation assertions: given a tx whose static account keys
 * we already have, the checker recognizes the wallet-absent /
 * relayer-signed shape (private) vs the wallet-signed shape (public).
 *
 * We deliberately don't hit the network — checkPrivateIsolation /
 * checkBaselineSelfSigned are pure functions. The fetch-and-retry
 * path (`verifyPrivateTx`) is exercised by the live CLI run; the
 * unit-level guarantee is that the predicate is correct.
 */
import { describe, it, expect } from 'vitest';
import { checkPrivateIsolation, checkBaselineSelfSigned, staticAccountKeysOf } from '../lib/wallet-isolation.js';

// The hosted-relayer pubkey on mainnet. Documented in
// docs-site/concepts/privacy-model.mdx and reachable from any
// mainnet privateSwap.
const RELAYER = '7f6gRiX56dMQGrPERNBKuzFsvagFTM1U4LMAAN9rsiNM';
const USER = 'B402testUserWallet1111111111111111111111111';
const ANOTHER = 'NotInThisTx111111111111111111111111111111111';

describe('checkPrivateIsolation', () => {
  it('passes when signer[0] is relayer and user wallet is absent', () => {
    const r = checkPrivateIsolation({
      signature: 'siga',
      userWallet: USER,
      expectedRelayer: RELAYER,
      staticAccountKeys: [RELAYER, ANOTHER, 'PoolPda1111111111111111111111111111111111'],
    });
    expect(r.passed).toBe(true);
    expect(r.userInAccountKeys).toBe(false);
    expect(r.reason).toBeUndefined();
  });

  it('fails when user wallet appears anywhere in account keys', () => {
    const r = checkPrivateIsolation({
      signature: 'sigb',
      userWallet: USER,
      expectedRelayer: RELAYER,
      staticAccountKeys: [RELAYER, USER, 'PoolPda1111111111111111111111111111111111'],
    });
    expect(r.passed).toBe(false);
    expect(r.reason).toMatch(/user wallet .* appears in accountKeys/);
  });

  it('fails when signer[0] is not the expected relayer', () => {
    const r = checkPrivateIsolation({
      signature: 'sigc',
      userWallet: USER,
      expectedRelayer: RELAYER,
      staticAccountKeys: [ANOTHER, 'PoolPda1111111111111111111111111111111111'],
    });
    expect(r.passed).toBe(false);
    expect(r.reason).toMatch(/signer\[0\] =/);
  });
});

describe('checkBaselineSelfSigned', () => {
  it('passes when signer[0] is the user wallet', () => {
    const r = checkBaselineSelfSigned({
      signature: 'sigd',
      userWallet: USER,
      staticAccountKeys: [USER, 'JupiterAggregatorV6111111111111111111111111'],
    });
    expect(r.passed).toBe(true);
  });

  it('fails when signer[0] is not the user wallet', () => {
    const r = checkBaselineSelfSigned({
      signature: 'sige',
      userWallet: USER,
      staticAccountKeys: [RELAYER, 'JupiterAggregatorV6111111111111111111111111'],
    });
    expect(r.passed).toBe(false);
  });
});

describe('staticAccountKeysOf', () => {
  it('reads v0 staticAccountKeys', () => {
    const keys = staticAccountKeysOf({
      transaction: {
        message: {
          staticAccountKeys: [{ toBase58: () => USER }, { toBase58: () => RELAYER }],
        },
      },
    });
    expect(keys).toEqual([USER, RELAYER]);
  });

  it('falls back to legacy accountKeys', () => {
    const keys = staticAccountKeysOf({
      transaction: {
        message: {
          accountKeys: [{ toBase58: () => RELAYER }, { toBase58: () => USER }],
        },
      },
    });
    expect(keys).toEqual([RELAYER, USER]);
  });

  it('handles already-base58 strings', () => {
    const keys = staticAccountKeysOf({
      transaction: {
        message: { staticAccountKeys: [RELAYER, USER] },
      },
    });
    expect(keys).toEqual([RELAYER, USER]);
  });
});

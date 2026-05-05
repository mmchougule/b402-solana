import { describe, it, expect, vi } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { makeSdkShieldFn, type B402SolanaShield } from '../sdk-shield.js';

const MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const obs = (overrides: Record<string, unknown> = {}) => ({
  txSig: 'sig1',
  payerPubkey: 'Payer1',
  amount: '1000000',
  slot: 1,
  ...overrides,
}) as Parameters<ReturnType<typeof makeSdkShieldFn>>[0];

describe('makeSdkShieldFn', () => {
  it('forwards mint + amount as bigint to b402.shield and maps the result', async () => {
    const b402: B402SolanaShield = {
      shield: vi.fn(async () => ({
        signature: 'tx-sig-zzz',
        commitment: 0xdeadbeefn,
        leafIndex: 7n,
      })),
    };
    const fn = makeSdkShieldFn(b402, MINT);

    const out = await fn(obs({ amount: '500000' }));

    expect(b402.shield).toHaveBeenCalledWith({ mint: MINT, amount: 500000n });
    expect(out).toEqual({ signature: 'tx-sig-zzz', commitment: '0xdeadbeef' });
  });

  it('pads odd-length hex commitments to even bytes', async () => {
    const b402: B402SolanaShield = {
      shield: async () => ({ signature: 's', commitment: 0xfn, leafIndex: 0n }),
    };
    const fn = makeSdkShieldFn(b402, MINT);
    const out = await fn(obs());
    expect(out.commitment).toBe('0x0f');
  });

  it('rejects non-numeric amount strings', async () => {
    const b402: B402SolanaShield = {
      shield: vi.fn(async () => ({ signature: 's', commitment: 0n, leafIndex: 0n })),
    };
    const fn = makeSdkShieldFn(b402, MINT);
    await expect(fn(obs({ amount: 'abc' }))).rejects.toThrow(/not a u64 string/);
    expect(b402.shield).not.toHaveBeenCalled();
  });

  it('rejects zero amount (reconciler usually filters earlier; defense in depth)', async () => {
    const fn = makeSdkShieldFn(
      { shield: async () => ({ signature: '', commitment: 0n, leafIndex: 0n }) },
      MINT,
    );
    await expect(fn(obs({ amount: '0' }))).rejects.toThrow(/not positive/);
  });

  it('rejects amounts that overflow u64', async () => {
    const fn = makeSdkShieldFn(
      { shield: async () => ({ signature: '', commitment: 0n, leafIndex: 0n }) },
      MINT,
    );
    await expect(fn(obs({ amount: (1n << 64n).toString() }))).rejects.toThrow(/exceeds u64/);
  });

  it('propagates SDK errors to the reconciler so retry logic engages', async () => {
    const fn = makeSdkShieldFn(
      {
        shield: async () => {
          throw new Error('rpc 503');
        },
      },
      MINT,
    );
    await expect(fn(obs())).rejects.toThrow('rpc 503');
  });
});

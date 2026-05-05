import { describe, it, expect } from 'vitest';
import { InMemoryBridgeStore } from '../store.js';
import type { Observation } from '../types.js';

const obs = (txSig: string, overrides: Partial<Observation> = {}): Observation => ({
  txSig,
  payerPubkey: 'PayerPubkey1111111111111111111111111111111',
  amount: '10000',
  slot: 100,
  ...overrides,
});

describe('InMemoryBridgeStore', () => {
  it('putSeen creates a fresh record in `seen` state', async () => {
    const s = new InMemoryBridgeStore();
    const r = await s.putSeen(obs('tx1'));
    expect(r.state).toBe('seen');
    expect(r.attempts).toBe(0);
    expect(r.observation.txSig).toBe('tx1');
  });

  it('putSeen is idempotent on txSig — second call returns the existing record', async () => {
    const s = new InMemoryBridgeStore();
    const r1 = await s.putSeen(obs('tx1', { amount: '10000' }));
    const r2 = await s.putSeen(obs('tx1', { amount: '99999' }));
    // we keep the first record; we don't overwrite a record that's possibly
    // already mid-flight with conflicting data.
    expect(r2).toBe(r1);
    expect(r2.observation.amount).toBe('10000');
  });

  it('transition seen → shielding bumps attempts', async () => {
    const s = new InMemoryBridgeStore();
    await s.putSeen(obs('tx1'));
    const r = await s.transition('tx1', 'seen', 'shielding');
    expect(r.state).toBe('shielding');
    expect(r.attempts).toBe(1);
  });

  it('transition shielding → shielded does NOT bump attempts', async () => {
    const s = new InMemoryBridgeStore();
    await s.putSeen(obs('tx1'));
    await s.transition('tx1', 'seen', 'shielding');
    const r = await s.transition('tx1', 'shielding', 'shielded', {
      shieldedAt: { commitment: 'cmt1', signature: 'sig1' },
    });
    expect(r.state).toBe('shielded');
    expect(r.attempts).toBe(1);
    expect(r.shieldedAt).toEqual({ commitment: 'cmt1', signature: 'sig1' });
  });

  it('transition rejects mismatched from-state', async () => {
    const s = new InMemoryBridgeStore();
    await s.putSeen(obs('tx1'));
    await expect(s.transition('tx1', 'shielding', 'shielded')).rejects.toThrow(
      /bad transition/,
    );
  });

  it('transition rejects unknown txSig', async () => {
    const s = new InMemoryBridgeStore();
    await expect(s.transition('nope', 'seen', 'shielding')).rejects.toThrow(
      /unknown txSig/,
    );
  });

  it('pending excludes terminal states', async () => {
    const s = new InMemoryBridgeStore();
    await s.putSeen(obs('tx1'));
    await s.putSeen(obs('tx2'));
    await s.transition('tx2', 'seen', 'shielding');
    await s.transition('tx2', 'shielding', 'shielded', {
      shieldedAt: { commitment: 'c', signature: 'g' },
    });
    const p = await s.pending();
    expect(p.map((r) => r.observation.txSig)).toEqual(['tx1']);
  });

  it('all returns every record regardless of state', async () => {
    const s = new InMemoryBridgeStore();
    await s.putSeen(obs('tx1'));
    await s.putSeen(obs('tx2'));
    const a = await s.all();
    expect(a).toHaveLength(2);
  });
});

import { describe, it, expect, vi } from 'vitest';
import fc from 'fast-check';
import { Reconciler } from '../reconciler.js';
import { InMemoryBridgeStore } from '../store.js';
import type { BridgeEvent, Observation, ShieldFn } from '../types.js';

const obs = (txSig: string, overrides: Partial<Observation> = {}): Observation => ({
  txSig,
  payerPubkey: 'PayerPubkey1111111111111111111111111111111',
  amount: '10000',
  slot: 100,
  ...overrides,
});

/** A test waiter that returns immediately so backoff doesn't slow tests. */
const noWait = () => Promise.resolve();

describe('Reconciler — happy path', () => {
  it('shields a single observation end-to-end', async () => {
    const store = new InMemoryBridgeStore();
    const shield: ShieldFn = vi.fn(async (o) => ({
      commitment: `cmt-${o.txSig}`,
      signature: `sig-${o.txSig}`,
    }));
    const events: BridgeEvent[] = [];

    const r = new Reconciler(store, shield, { waiter: noWait });
    r.on((e) => events.push(e));

    await r.submit(obs('tx1'));
    // Let the in-flight promise settle.
    await flush();

    const rec = await store.get('tx1');
    expect(rec?.state).toBe('shielded');
    expect(rec?.shieldedAt?.commitment).toBe('cmt-tx1');
    expect(shield).toHaveBeenCalledTimes(1);
    expect(events).toEqual([
      { name: 'shielded', txSig: 'tx1', commitment: 'cmt-tx1' },
    ]);
  });
});

describe('Reconciler — dedupe', () => {
  it('submit called twice with the same txSig only shields once', async () => {
    const store = new InMemoryBridgeStore();
    const shield = vi.fn<ShieldFn>(async (o) => ({
      commitment: `cmt-${o.txSig}`,
      signature: `sig-${o.txSig}`,
    }));
    const r = new Reconciler(store, shield, { waiter: noWait });

    await Promise.all([r.submit(obs('tx1')), r.submit(obs('tx1'))]);
    await flush();

    expect(shield).toHaveBeenCalledTimes(1);
  });

  it('submit after success is a no-op', async () => {
    const store = new InMemoryBridgeStore();
    const shield = vi.fn<ShieldFn>(async (o) => ({
      commitment: `cmt-${o.txSig}`,
      signature: `sig-${o.txSig}`,
    }));
    const r = new Reconciler(store, shield, { waiter: noWait });

    await r.submit(obs('tx1'));
    await flush();
    await r.submit(obs('tx1'));
    await flush();

    expect(shield).toHaveBeenCalledTimes(1);
    expect((await store.get('tx1'))?.state).toBe('shielded');
  });
});

describe('Reconciler — filters', () => {
  it('drops amount=0 silently', async () => {
    const store = new InMemoryBridgeStore();
    const shield = vi.fn<ShieldFn>();
    const r = new Reconciler(store, shield, { waiter: noWait });

    await r.submit(obs('tx1', { amount: '0' }));
    await flush();

    expect(shield).not.toHaveBeenCalled();
    expect(await store.get('tx1')).toBeUndefined();
  });
});

describe('Reconciler — retry & backoff', () => {
  it('retries on shield failure and eventually succeeds', async () => {
    const store = new InMemoryBridgeStore();
    let calls = 0;
    const shield: ShieldFn = vi.fn(async (o) => {
      calls += 1;
      if (calls < 3) throw new Error('rpc flaked');
      return { commitment: `cmt-${o.txSig}`, signature: `sig-${o.txSig}` };
    });
    const events: BridgeEvent[] = [];
    const waitsObserved: number[] = [];
    const waiter = (ms: number) => {
      waitsObserved.push(ms);
      return Promise.resolve();
    };

    const r = new Reconciler(store, shield, { waiter });
    r.on((e) => events.push(e));

    await r.submit(obs('tx1'));
    await flush();

    expect(calls).toBe(3);
    expect((await store.get('tx1'))?.state).toBe('shielded');
    // Two failures → two backoff waits before the success.
    expect(waitsObserved).toHaveLength(2);
    // Exponential: 1000, 2000.
    expect(waitsObserved[0]).toBe(1000);
    expect(waitsObserved[1]).toBe(2000);
    expect(events.map((e) => e.name)).toEqual(['shielded']);
  });

  it('caps backoff at maxDelayMs', async () => {
    const store = new InMemoryBridgeStore();
    let calls = 0;
    const shield: ShieldFn = async (o) => {
      calls += 1;
      if (calls < 5) throw new Error('still bad');
      return { commitment: `cmt-${o.txSig}`, signature: `sig-${o.txSig}` };
    };
    const waits: number[] = [];
    const waiter = (ms: number) => {
      waits.push(ms);
      return Promise.resolve();
    };

    const r = new Reconciler(store, shield, {
      waiter,
      policy: { maxAttempts: 10, baseDelayMs: 1000, maxDelayMs: 4000 },
    });

    await r.submit(obs('tx1'));
    await flush();

    // attempts: 1,2,3,4 fail; 5 succeeds. So 4 waits.
    // delays: 1000, 2000, 4000 (cap), 4000 (cap).
    expect(waits).toEqual([1000, 2000, 4000, 4000]);
  });

  it('gives up after maxAttempts and emits failed event', async () => {
    const store = new InMemoryBridgeStore();
    const shield: ShieldFn = vi.fn(async () => {
      throw new Error('permaglitch');
    });
    const events: BridgeEvent[] = [];
    const r = new Reconciler(store, shield, {
      waiter: noWait,
      policy: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 1 },
    });
    r.on((e) => events.push(e));

    await r.submit(obs('tx1'));
    await flush();

    expect(shield).toHaveBeenCalledTimes(3);
    const rec = await store.get('tx1');
    expect(rec?.state).toBe('failed');
    expect(rec?.lastError).toBe('permaglitch');
    expect(events).toEqual([{ name: 'failed', txSig: 'tx1', error: 'permaglitch' }]);
  });
});

describe('Reconciler — tick (heartbeat)', () => {
  it('re-drives a stuck `shielding` record left over from a previous process', async () => {
    const store = new InMemoryBridgeStore();
    // Simulate a crash mid-shield: putSeen + transition to shielding, no
    // in-flight promise exists in this fresh reconciler.
    await store.putSeen(obs('tx1'));
    await store.transition('tx1', 'seen', 'shielding');

    const shield = vi.fn<ShieldFn>(async (o) => ({
      commitment: `cmt-${o.txSig}`,
      signature: `sig-${o.txSig}`,
    }));
    const r = new Reconciler(store, shield, { waiter: noWait });

    await r.tick();
    await flush();

    expect(shield).toHaveBeenCalledTimes(1);
    expect((await store.get('tx1'))?.state).toBe('shielded');
  });

  it('emits `reconciled` event each tick', async () => {
    const store = new InMemoryBridgeStore();
    const shield: ShieldFn = async () => ({ commitment: 'c', signature: 's' });
    const events: BridgeEvent[] = [];
    const r = new Reconciler(store, shield, { waiter: noWait });
    r.on((e) => events.push(e));

    await r.tick();
    expect(events.some((e) => e.name === 'reconciled')).toBe(true);
  });
});

describe('Reconciler — property: invariants', () => {
  it('any sequence of submits and ticks results in exactly one shield call per txSig', async () => {
    await fc.assert(
      fc.asyncProperty(
        // a small alphabet of distinct txSigs, each may be submitted several times
        fc.array(
          fc.record({
            kind: fc.constantFrom<'submit' | 'tick'>('submit', 'tick'),
            txSig: fc.constantFrom('tx1', 'tx2', 'tx3'),
          }),
          { minLength: 1, maxLength: 30 },
        ),
        async (ops) => {
          const store = new InMemoryBridgeStore();
          const callsByTx = new Map<string, number>();
          const shield: ShieldFn = async (o) => {
            callsByTx.set(o.txSig, (callsByTx.get(o.txSig) ?? 0) + 1);
            return { commitment: `cmt-${o.txSig}`, signature: `sig-${o.txSig}` };
          };
          const r = new Reconciler(store, shield, { waiter: noWait });

          for (const op of ops) {
            if (op.kind === 'submit') await r.submit(obs(op.txSig));
            else await r.tick();
          }
          await flush();

          // every shielded record was shielded exactly once
          for (const rec of await store.all()) {
            if (rec.state === 'shielded') {
              expect(callsByTx.get(rec.observation.txSig)).toBe(1);
            }
          }
        },
      ),
      { numRuns: 50 },
    );
  });
});

/** Drain microtask queue + any pending timers/promises. The reconciler kicks
 *  in-flight work via `void` so we need to flush before assertions. */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setImmediate(r));
  }
}

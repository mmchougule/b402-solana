/**
 * runDcaLoop schedules N executions at the right cadence. Uses a
 * virtual clock so the test stays fast and deterministic.
 */
import { describe, it, expect } from 'vitest';
import { runDcaLoop } from '../lib/dca-loop.js';

function fakeClock(initial = 0) {
  let now = initial;
  const sleeps: number[] = [];
  return {
    now: () => now,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      now += ms;
    },
    sleeps,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('runDcaLoop', () => {
  it('produces exactly N signatures', async () => {
    const clock = fakeClock();
    const res = await runDcaLoop({
      iters: 8,
      intervalMs: 90_000,
      executeOnce: async (i) => `sig-${i}`,
      clock,
    });
    expect(res.signatures).toEqual([
      'sig-0', 'sig-1', 'sig-2', 'sig-3', 'sig-4', 'sig-5', 'sig-6', 'sig-7',
    ]);
    expect(res.errors).toEqual([]);
  });

  it('sleeps interval - elapsed between iters and skips the final sleep', async () => {
    const clock = fakeClock();
    // Each iter takes 10 seconds of virtual time
    const res = await runDcaLoop({
      iters: 4,
      intervalMs: 90_000,
      executeOnce: async (_i) => {
        clock.advance(10_000);
        return 'sig';
      },
      clock,
    });
    // 4 iters, 3 inter-iter sleeps, each 80s after subtracting work.
    expect(clock.sleeps).toEqual([80_000, 80_000, 80_000]);
    expect(res.perIterMs).toEqual([10_000, 10_000, 10_000, 10_000]);
  });

  it('warns when an iter overruns the interval and does not sleep negative', async () => {
    const clock = fakeClock();
    const res = await runDcaLoop({
      iters: 3,
      intervalMs: 5_000,
      executeOnce: async (i) => {
        clock.advance(i === 1 ? 12_000 : 1_000);
        return `sig-${i}`;
      },
      clock,
    });
    // Iters 0 and 1 finish, then the inter-iter logic decides sleep.
    // After iter 0 (1s): sleep 4s.
    // After iter 1 (12s): warning, no sleep.
    expect(clock.sleeps).toEqual([4_000]);
    expect(res.warnings.length).toBe(1);
    expect(res.warnings[0]).toMatch(/exceeded interval/);
  });

  it('captures per-iter errors without aborting the loop', async () => {
    const clock = fakeClock();
    const res = await runDcaLoop({
      iters: 3,
      intervalMs: 1_000,
      executeOnce: async (i) => {
        if (i === 1) throw new Error('jupiter 503');
        return `sig-${i}`;
      },
      clock,
    });
    expect(res.signatures).toEqual(['sig-0', 'sig-2']);
    expect(res.errors).toEqual([{ index: 1, message: 'jupiter 503' }]);
  });

  it('rejects invalid config', async () => {
    await expect(
      runDcaLoop({ iters: 0, intervalMs: 1_000, executeOnce: async () => 'sig' }),
    ).rejects.toThrow(/iters must be a positive integer/);
    await expect(
      runDcaLoop({ iters: 2, intervalMs: -1, executeOnce: async () => 'sig' }),
    ).rejects.toThrow(/intervalMs must be a non-negative number/);
  });
});

/**
 * DCA loop orchestrator. Pure timing + sequencing logic — no SDK,
 * no RPC. Takes an `executeOnce` callback and runs it `iters` times
 * with `intervalMs` between starts. Each iteration's elapsed time is
 * subtracted from the wait so the loop is rate-limited to the schedule,
 * not to (schedule + work). If a single iter exceeds the interval,
 * the next one starts immediately and a warning is recorded.
 */
export interface DcaConfig {
  iters: number;
  intervalMs: number;
  /** Per-iter executor. Returns the tx signature. */
  executeOnce: (i: number) => Promise<string>;
  /** Defaults to setTimeout / Date.now — overridden in tests. */
  clock?: {
    now: () => number;
    sleep: (ms: number) => Promise<void>;
  };
  /** Notifier for progress logging. Defaults to no-op. */
  onIter?: (ev: DcaIterEvent) => void;
}

export interface DcaIterEvent {
  index: number;
  signature?: string;
  startedAt: number;
  elapsedMs: number;
  waitedMs: number;
  warning?: string;
  error?: Error;
}

export interface DcaResult {
  signatures: string[];
  perIterMs: number[];
  warnings: string[];
  errors: Array<{ index: number; message: string }>;
}

const realClock = {
  now: () => Date.now(),
  sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
};

export async function runDcaLoop(cfg: DcaConfig): Promise<DcaResult> {
  if (!Number.isInteger(cfg.iters) || cfg.iters < 1) {
    throw new Error(`runDcaLoop: iters must be a positive integer, got ${cfg.iters}`);
  }
  if (!Number.isFinite(cfg.intervalMs) || cfg.intervalMs < 0) {
    throw new Error(`runDcaLoop: intervalMs must be a non-negative number, got ${cfg.intervalMs}`);
  }

  const clock = cfg.clock ?? realClock;
  const sigs: string[] = [];
  const perIter: number[] = [];
  const warnings: string[] = [];
  const errors: Array<{ index: number; message: string }> = [];

  for (let i = 0; i < cfg.iters; i++) {
    const startedAt = clock.now();
    let signature: string | undefined;
    let error: Error | undefined;
    try {
      signature = await cfg.executeOnce(i);
      sigs.push(signature);
    } catch (e) {
      error = e instanceof Error ? e : new Error(String(e));
      errors.push({ index: i, message: error.message });
    }

    const elapsedMs = clock.now() - startedAt;
    perIter.push(elapsedMs);

    const isLast = i === cfg.iters - 1;
    let waitedMs = 0;
    let warning: string | undefined;
    if (!isLast) {
      const remaining = cfg.intervalMs - elapsedMs;
      if (remaining > 0) {
        await clock.sleep(remaining);
        waitedMs = remaining;
      } else if (cfg.intervalMs > 0) {
        warning = `iter ${i} took ${elapsedMs}ms, exceeded interval ${cfg.intervalMs}ms — next iter starts immediately`;
        warnings.push(warning);
      }
    }

    cfg.onIter?.({
      index: i,
      ...(signature !== undefined ? { signature } : {}),
      startedAt,
      elapsedMs,
      waitedMs,
      ...(warning !== undefined ? { warning } : {}),
      ...(error !== undefined ? { error } : {}),
    });
  }

  return { signatures: sigs, perIterMs: perIter, warnings, errors };
}

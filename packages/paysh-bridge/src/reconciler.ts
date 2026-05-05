import type {
  BridgeEvent,
  BridgeStore,
  Observation,
  RetryPolicy,
  ShieldFn,
} from './types.js';
import { DEFAULT_RETRY_POLICY } from './types.js';

/**
 * Reconciler — the invariant-enforcing core of the bridge.
 *
 * Given a stream of `Observation`s (each one an incoming USDC SPL transfer
 * to the ingress), the reconciler:
 *
 *   1. Dedupes by `txSig`. Same txSig submitted twice is a no-op.
 *   2. Drives each observation through `seen → shielding → shielded`
 *      using the injected `shield` function.
 *   3. On `shield` failure, retries with exponential backoff up to
 *      `policy.maxAttempts`, then marks the record `failed`.
 *   4. Emits events on terminal transitions so the bridge can notify
 *      the operator.
 *
 * Concurrency model: `submit()` is safe to call concurrently with itself
 * and with `tick()`. The store's `transition()` is the synchronisation
 * primitive — duplicate or out-of-order calls fail loudly.
 *
 * The reconciler does NOT touch Solana RPC, the SDK, or anything else.
 * Everything observable by tests is in the constructor's argument list.
 */
export class Reconciler {
  private readonly policy: RetryPolicy;
  private readonly listeners: Array<(e: BridgeEvent) => void> = [];
  /** In-flight shield promises, keyed by txSig, so we never start two for the same record. */
  private readonly inflight = new Map<string, Promise<void>>();
  /** Test seam: callable that returns a delay's worth of wait. Replaceable so tests don't sleep. */
  private readonly waiter: (ms: number) => Promise<void>;

  constructor(
    private readonly store: BridgeStore,
    private readonly shield: ShieldFn,
    opts?: {
      policy?: Partial<RetryPolicy>;
      waiter?: (ms: number) => Promise<void>;
    },
  ) {
    this.policy = { ...DEFAULT_RETRY_POLICY, ...(opts?.policy ?? {}) };
    this.waiter = opts?.waiter ?? defaultWaiter;
  }

  on(cb: (e: BridgeEvent) => void): void {
    this.listeners.push(cb);
  }

  /**
   * Accept a new observation. Idempotent on `txSig` — a duplicate submit
   * returns immediately without scheduling another shield.
   *
   * Filters that drop the observation entirely:
   *   - amount === '0' (no-op transfer; nothing to shield)
   *
   * Filters on (mint, ingress) etc. happen in `parse.ts` before submit,
   * so by the time we're here we trust the observation belongs to us.
   */
  async submit(o: Observation): Promise<void> {
    if (o.amount === '0') return;

    const existing = await this.store.get(o.txSig);
    if (existing) {
      // Already known. If it's terminal, nothing to do. If it's seen/shielding,
      // either we're processing it or something else is — no second start.
      return;
    }
    await this.store.putSeen(o);
    void this.kick(o.txSig);
  }

  /**
   * Reconciler heartbeat. Re-drives every non-terminal record. Call this
   * periodically (PRD-25 §5.2 #2) to recover from process restarts and
   * missed WS events.
   */
  async tick(): Promise<void> {
    const pending = await this.store.pending();
    for (const rec of pending) {
      // `shielding` records mean a previous attempt is in flight or was
      // killed. Either way, re-driving by transitioning back to `seen`
      // and kicking is what we want — but only if no in-flight promise
      // exists for this txSig in THIS process.
      if (rec.state === 'shielding' && !this.inflight.has(rec.observation.txSig)) {
        await this.store.transition(rec.observation.txSig, 'shielding', 'seen', {
          lastError: 'reconciler: stale shielding state on tick',
        });
      }
      void this.kick(rec.observation.txSig);
    }
    this.emit({ name: 'reconciled', txSig: '' });
  }

  /** Internal: drive one record from `seen` → terminal, with retries. */
  private kick(txSig: string): Promise<void> {
    const existing = this.inflight.get(txSig);
    if (existing) return existing;
    const p = this.drive(txSig).finally(() => {
      this.inflight.delete(txSig);
    });
    this.inflight.set(txSig, p);
    return p;
  }

  private async drive(txSig: string): Promise<void> {
    while (true) {
      const rec = await this.store.get(txSig);
      if (!rec) return; // record vanished — nothing to do
      if (rec.state === 'shielded' || rec.state === 'failed') return;

      // seen → shielding (increments attempts)
      const shielding = await this.store.transition(txSig, 'seen', 'shielding');

      try {
        const result = await this.shield(shielding.observation);
        await this.store.transition(txSig, 'shielding', 'shielded', {
          shieldedAt: result,
        });
        this.emit({ name: 'shielded', txSig, commitment: result.commitment });
        return;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const attemptsAfter = shielding.attempts;
        if (attemptsAfter >= this.policy.maxAttempts) {
          await this.store.transition(txSig, 'shielding', 'failed', {
            lastError: msg,
          });
          this.emit({ name: 'failed', txSig, error: msg });
          return;
        }
        // back off, then loop and try again from `seen`
        await this.store.transition(txSig, 'shielding', 'seen', { lastError: msg });
        const delay = Math.min(
          this.policy.baseDelayMs * 2 ** (attemptsAfter - 1),
          this.policy.maxDelayMs,
        );
        await this.waiter(delay);
      }
    }
  }

  private emit(e: BridgeEvent): void {
    for (const cb of this.listeners) {
      try {
        cb(e);
      } catch {
        // listener errors are not the reconciler's problem
      }
    }
  }
}

function defaultWaiter(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

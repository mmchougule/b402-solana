import type {
  BridgeStore,
  Observation,
  ObservationRecord,
  ObservationState,
} from './types.js';

/**
 * Single-process in-memory store. Suitable for tests and short-lived demos.
 * For production, swap in the SQLite-backed store (PRD-25 §6 follow-up).
 *
 * Concurrency: a single Node event loop never preempts mid-method, so
 * sequencing is preserved. We still guard each write through the same
 * `transition` codepath that any pluggable store will use, so contract
 * tests apply identically.
 */
export class InMemoryBridgeStore implements BridgeStore {
  private readonly map = new Map<string, ObservationRecord>();

  async get(txSig: string): Promise<ObservationRecord | undefined> {
    return this.map.get(txSig);
  }

  async putSeen(o: Observation): Promise<ObservationRecord> {
    const existing = this.map.get(o.txSig);
    if (existing) return existing;
    const rec: ObservationRecord = {
      observation: o,
      state: 'seen',
      attempts: 0,
      updatedAt: Date.now(),
    };
    this.map.set(o.txSig, rec);
    return rec;
  }

  async transition(
    txSig: string,
    from: ObservationState,
    to: ObservationState,
    patch?: Partial<Pick<ObservationRecord, 'lastError' | 'shieldedAt'>>,
  ): Promise<ObservationRecord> {
    const rec = this.map.get(txSig);
    if (!rec) throw new Error(`store: unknown txSig ${txSig}`);
    if (rec.state !== from) {
      throw new Error(
        `store: bad transition ${rec.state} → ${to} (expected from=${from}) for ${txSig}`,
      );
    }
    const next: ObservationRecord = {
      ...rec,
      state: to,
      attempts: to === 'shielding' ? rec.attempts + 1 : rec.attempts,
      lastError: patch?.lastError ?? (to === 'shielded' ? undefined : rec.lastError),
      shieldedAt: patch?.shieldedAt ?? rec.shieldedAt,
      updatedAt: Date.now(),
    };
    this.map.set(txSig, next);
    return next;
  }

  async pending(): Promise<ObservationRecord[]> {
    return [...this.map.values()].filter(
      (r) => r.state === 'seen' || r.state === 'shielding',
    );
  }

  async all(): Promise<ObservationRecord[]> {
    return [...this.map.values()];
  }
}

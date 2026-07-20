/**
 * Public types for @b402ai/paysh-shield.
 *
 * The shield converts incoming USDC SPL transfers (paid by an x402 / pay.sh
 * client to a stealth ingress address) into shielded notes for an operator,
 * via the b402-solana SDK. See PRD-25.
 *
 * The data model is small on purpose: each incoming USDC transfer becomes
 * one `Observation` that walks a small state machine in `ShieldStore`:
 *
 *   seen ──▶ shielding ──▶ shielded
 *               │
 *               └──▶ failed (after N attempts)
 */

/** A single incoming USDC SPL transfer to the ingress address. */
export interface Observation {
  /** Solana tx signature that delivered the USDC. Doubles as the dedupe key. */
  txSig: string;
  /** Sender's wallet pubkey (base58). Recorded for accounting only. */
  payerPubkey: string;
  /** Amount in USDC smallest units (u64 as string to avoid number precision). */
  amount: string;
  /** Slot the source tx confirmed in. Useful for reconciler ordering. */
  slot: number;
}

export type ObservationState =
  | 'seen'        // queued, not yet started
  | 'shielding'   // shield ix in flight
  | 'shielded'    // confirmed on-chain, note created
  | 'failed';     // gave up after retries

/** Per-tx record stored by the shield. */
export interface ObservationRecord {
  observation: Observation;
  state: ObservationState;
  attempts: number;
  /** Last error message if any. */
  lastError?: string;
  /** Set on transition to `shielded`. The shield commitment / leaf id. */
  shieldedAt?: { commitment: string; signature: string };
  /** Wall-clock ms timestamps for state transitions. */
  updatedAt: number;
}

/**
 * Persistent state for the shield. v1 ships an in-memory implementation;
 * the interface is pluggable so an operator can drop in SQLite, Postgres,
 * etc. without touching reconciler logic.
 *
 * Implementations MUST be safe under concurrent calls from a single process
 * (the reconciler may interleave with the WS handler). Cross-process
 * concurrency is out of scope for v1 — operators run a single shield
 * instance per ingress.
 */
export interface ShieldStore {
  get(txSig: string): Promise<ObservationRecord | undefined>;
  /** Insert a fresh `seen` record. No-op (returns existing) if txSig already known. */
  putSeen(o: Observation): Promise<ObservationRecord>;
  /** Atomically transition state. Throws if the from-state mismatches. */
  transition(
    txSig: string,
    from: ObservationState,
    to: ObservationState,
    patch?: Partial<Pick<ObservationRecord, 'lastError' | 'shieldedAt'>>,
  ): Promise<ObservationRecord>;
  /** All non-terminal records (state ∈ {seen, shielding}). */
  pending(): Promise<ObservationRecord[]>;
  /** Diagnostic: full snapshot. */
  all(): Promise<ObservationRecord[]>;
}

export type ShieldEventName = 'shielded' | 'failed' | 'reconciled';

export interface ShieldEvent {
  name: ShieldEventName;
  txSig: string;
  /** Present on `shielded`. */
  commitment?: string;
  /** Present on `failed`. */
  error?: string;
}

/** Function the reconciler calls to actually shield an observation. Injected so tests stay pure. */
export type ShieldFn = (o: Observation) => Promise<{ commitment: string; signature: string }>;

/** Retry policy for shield attempts. */
export interface RetryPolicy {
  /** Max attempts including the first. After this many failures the record moves to `failed`. */
  maxAttempts: number;
  /** Backoff base in ms. Delay between attempt n and n+1 = base * 2^(n-1), capped at maxDelayMs. */
  baseDelayMs: number;
  maxDelayMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 5,
  baseDelayMs: 1_000,
  maxDelayMs: 30_000,
};

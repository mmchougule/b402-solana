import type { PublicKey } from '@solana/web3.js';

import { Reconciler } from './reconciler.js';
import { InMemoryBridgeStore } from './store.js';
import { parseUsdcTransfersToIngress, type ParsedTxLike } from './parse.js';
import type {
  BridgeEvent,
  BridgeStore,
  Observation,
  RetryPolicy,
  ShieldFn,
} from './types.js';

/**
 * The minimum surface of `@solana/web3.js` `Connection` we depend on.
 * Typed structurally so tests can supply a fake without pulling in the
 * full RPC client.
 */
export interface BridgeConnection {
  onLogs(
    target: PublicKey,
    callback: (logs: { signature: string; err: unknown }, ctx: { slot: number }) => void,
    commitment?: 'confirmed' | 'finalized',
  ): number | Promise<number>;
  removeOnLogsListener(subscriptionId: number): Promise<void> | void;
  getParsedTransaction(
    signature: string,
    opts?: { commitment?: 'confirmed' | 'finalized'; maxSupportedTransactionVersion?: number },
  ): Promise<ParsedTxLike | null>;
}

export interface PayshBridgeConfig {
  /** Solana connection used for log subscription + tx fetch. */
  connection: BridgeConnection;
  /** Wallet pubkey of the ingress (what an x402 provider declares as `payTo`). */
  ingressOwner: PublicKey;
  /** ATA derived from `(ingressOwner, mint)`. The bridge subscribes to logs
   *  of this account and matches incoming transfers' `destination` against it. */
  ingressAta: PublicKey;
  /** The shield function — typically `makeSdkShieldFn(b402Solana, mint)`,
   *  but injected so tests can use a stub. */
  shield: ShieldFn;
  /** Optional persistent store. Defaults to in-memory. */
  store?: BridgeStore;
  /** Retry policy override. */
  retry?: Partial<RetryPolicy>;
  /** Reconciler tick interval in ms. Pass 0 to disable the heartbeat (tests). */
  tickIntervalMs?: number;
}

/**
 * Runtime orchestrator. Wires:
 *
 *   Solana logs subscription on `ingressAta`
 *     → fetch parsed tx
 *     → parse out USDC transfers to ingress
 *     → submit to Reconciler
 *     → Reconciler invokes `shield()` (the SDK), retries on failure,
 *       emits `shielded` / `failed` / `reconciled` events.
 *
 * Lifecycle: caller invokes `start()` once; bridge owns the subscription
 * and the heartbeat timer until `stop()`.
 */
export class PayshBridge {
  private readonly reconciler: Reconciler;
  private readonly listeners: Array<(e: BridgeEvent) => void> = [];
  private subscriptionId: number | null = null;
  private tickHandle: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly cfg: PayshBridgeConfig) {
    const store = cfg.store ?? new InMemoryBridgeStore();
    const opts = cfg.retry ? { policy: cfg.retry } : {};
    this.reconciler = new Reconciler(store, cfg.shield, opts);
    this.reconciler.on((e) => this.emit(e));
  }

  /** Wallet pubkey to advertise as `payTo` in the provider's x402 challenge. */
  payTo(): string {
    return this.cfg.ingressOwner.toBase58();
  }

  on(cb: (e: BridgeEvent) => void): void {
    this.listeners.push(cb);
  }

  /**
   * Submit an observation directly. Intended for replay or manual recovery
   * (e.g. seeding from a chain backfill). The normal path is the WS callback
   * inside `start()`.
   */
  async submit(o: Observation): Promise<void> {
    await this.reconciler.submit(o);
  }

  async start(): Promise<void> {
    if (this.subscriptionId !== null) return;

    const subId = await this.cfg.connection.onLogs(
      this.cfg.ingressAta,
      (logs) => {
        // Logs callback fires for every tx touching the ATA. We re-fetch the
        // parsed tx so we get the typed instruction shape (and inner ix)
        // rather than parsing log lines.
        if (logs.err) return; // tx failed; nothing to shield
        void this.handleSignature(logs.signature);
      },
      'confirmed',
    );
    this.subscriptionId = subId;

    if ((this.cfg.tickIntervalMs ?? 30_000) > 0) {
      this.tickHandle = setInterval(() => {
        void this.reconciler.tick();
      }, this.cfg.tickIntervalMs ?? 30_000);
      // Don't pin the event loop alive solely for the heartbeat — if the
      // host process is otherwise idle, exit.
      this.tickHandle.unref?.();
    }
  }

  async stop(): Promise<void> {
    if (this.subscriptionId !== null) {
      await this.cfg.connection.removeOnLogsListener(this.subscriptionId);
      this.subscriptionId = null;
    }
    if (this.tickHandle) {
      clearInterval(this.tickHandle);
      this.tickHandle = null;
    }
  }

  /** @internal Exposed for tests to drive the parse-and-submit pipeline. */
  async handleSignature(signature: string): Promise<void> {
    const tx = await this.cfg.connection.getParsedTransaction(signature, {
      commitment: 'confirmed',
      maxSupportedTransactionVersion: 0,
    });
    if (!tx) return;
    const observations = parseUsdcTransfersToIngress(tx, this.cfg.ingressAta.toBase58());
    for (const o of observations) {
      await this.reconciler.submit(o);
    }
  }

  private emit(e: BridgeEvent): void {
    for (const cb of this.listeners) {
      try {
        cb(e);
      } catch {
        /* listener errors are not the bridge's problem */
      }
    }
  }
}

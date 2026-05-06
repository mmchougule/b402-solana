/**
 * @b402ai/paysh-shield — privacy shield for x402 / pay.sh receivables.
 *
 * Public surface (PRD-25 §5.1):
 *   - `InMemoryShieldStore`: pluggable persistence, in-memory impl
 *   - `Reconciler`: invariant-enforcing core (dedupe, retry, state machine)
 *
 * The full `PayshShield` orchestrator (RPC subscription + SDK shield wiring)
 * lands in a follow-up commit on this branch — see PRD-25 §5.1.
 */

export type {
  ShieldStore,
  ShieldEvent,
  ShieldEventName,
  Observation,
  ObservationRecord,
  ObservationState,
  RetryPolicy,
  ShieldFn,
} from './types.js';
export { DEFAULT_RETRY_POLICY } from './types.js';
export { InMemoryShieldStore } from './store.js';
export { Reconciler } from './reconciler.js';
export { parseUsdcTransfersToIngress } from './parse.js';
export type { ParsedTxLike, ParsedInstruction } from './parse.js';
export { makeSdkShieldFn } from './sdk-shield.js';
export type { B402SolanaShield } from './sdk-shield.js';
export { PayshShield } from './paysh-shield.js';
export type { PayshShieldConfig, ShieldConnection } from './paysh-shield.js';
export {
  buildPaymentRequired,
  decodePaymentHeader,
  encodePaymentHeader,
  SOLANA_NETWORKS,
} from './x402.js';
export type {
  Network,
  PaymentRequirement,
  PaymentRequiredBody,
  PaymentPayload,
} from './x402.js';
export { verifyPayment } from './x402-server.js';
export type { VerifyOpts, VerifyResult } from './x402-server.js';

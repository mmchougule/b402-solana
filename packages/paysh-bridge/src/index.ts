/**
 * @b402ai/paysh-bridge — privacy bridge for x402 / pay.sh receivables.
 *
 * Public surface (PRD-25 §5.1):
 *   - `InMemoryBridgeStore`: pluggable persistence, in-memory impl
 *   - `Reconciler`: invariant-enforcing core (dedupe, retry, state machine)
 *
 * The full `PayshBridge` orchestrator (RPC subscription + SDK shield wiring)
 * lands in a follow-up commit on this branch — see PRD-25 §5.1.
 */

export type {
  BridgeStore,
  BridgeEvent,
  BridgeEventName,
  Observation,
  ObservationRecord,
  ObservationState,
  RetryPolicy,
  ShieldFn,
} from './types.js';
export { DEFAULT_RETRY_POLICY } from './types.js';
export { InMemoryBridgeStore } from './store.js';
export { Reconciler } from './reconciler.js';
export { parseUsdcTransfersToIngress } from './parse.js';
export type { ParsedTxLike, ParsedInstruction } from './parse.js';
export { makeSdkShieldFn } from './sdk-shield.js';
export type { B402SolanaShield } from './sdk-shield.js';
export { PayshBridge } from './bridge.js';
export type { PayshBridgeConfig, BridgeConnection } from './bridge.js';
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

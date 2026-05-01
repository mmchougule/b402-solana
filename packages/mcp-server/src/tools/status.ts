import type { B402Context } from '../context.js';
import type { B402Status } from '@b402ai/solana';
import type { StatusInput } from '../schemas.js';

/**
 * Combined public + private snapshot — what the user holds in their wallet
 * (Phantom-visible) alongside what they hold privately in the b402 pool
 * (Phantom can't see this; we surface it here).
 *
 * Default `refresh: false`: returns from the persistent NoteStore which
 * already reflects every shield/unshield/swap this client has made (those
 * write paths update local state on success). Sub-millisecond.
 *
 * `refresh: true`: cursor-driven incremental backfill from on-chain logs.
 * On steady state (no new deposits since last call) this is a single
 * `getSignaturesForAddress` returning ~0 entries — sub-second even on
 * throttled public RPC. Catches deposits made from another machine.
 */
export async function handleStatus(ctx: B402Context, input: StatusInput): Promise<B402Status> {
  return ctx.b402.status({ refresh: input.refresh ?? false });
}

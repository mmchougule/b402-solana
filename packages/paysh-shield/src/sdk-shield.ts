import type { PublicKey } from '@solana/web3.js';
import type { Observation, ShieldFn } from './types.js';

/**
 * The minimum surface of `B402Solana` we use. Typed structurally so the
 * bridge does not depend on the SDK at compile time — the SDK package can
 * change shape without breaking us, and tests can pass a stub.
 */
export interface B402SolanaShield {
  shield(req: { mint: PublicKey; amount: bigint }): Promise<{
    signature: string;
    commitment: bigint;
    leafIndex: bigint;
  }>;
}

/**
 * Adapt the b402-solana SDK's `shield()` into the `ShieldFn` shape the
 * Reconciler expects. Conversions:
 *   - amount: decimal string → bigint (fails fast on bad input)
 *   - commitment: bigint → 0x-prefixed hex (canonical form for the
 *     CommitmentAppended event index; preserved as-is for downstream tools)
 *
 * The mint and SDK instance are closed over once at construction time,
 * because for a given ingress the bridge only ever shields one mint.
 */
export function makeSdkShieldFn(b402: B402SolanaShield, mint: PublicKey): ShieldFn {
  return async (o: Observation) => {
    const amount = parseAmount(o.amount, o.txSig);
    const result = await b402.shield({ mint, amount });
    return {
      signature: result.signature,
      commitment: bigintToHex(result.commitment),
    };
  };
}

function parseAmount(raw: string, txSig: string): bigint {
  if (!/^\d+$/.test(raw)) {
    throw new Error(`shield: amount for ${txSig} is not a u64 string: ${raw}`);
  }
  const v = BigInt(raw);
  if (v <= 0n) throw new Error(`shield: amount for ${txSig} is not positive: ${raw}`);
  if (v >= 1n << 64n) throw new Error(`shield: amount for ${txSig} exceeds u64`);
  return v;
}

function bigintToHex(v: bigint): string {
  const hex = v.toString(16);
  return '0x' + (hex.length % 2 === 0 ? hex : '0' + hex);
}

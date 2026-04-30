/**
 * Relay route factory — shared logic for shield/unshield/transact/adapt.
 *
 * Each operation is parameterised by:
 *   - the on-chain program ID we'll forward to (pool always)
 *   - an optional adapter-pubkey allowlist check for /relay/adapt
 *   - a label used in logs/errors
 *
 * The handler:
 *   1. Auth + rate limit (Authenticator).
 *   2. zod-parse the envelope, decode ixData.
 *   3. Structural checks: length, fee floor.
 *   4. Account-list checks: program-id allowlist, optional adapter check.
 *   5. Hand to Submitter; return signature.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { PublicKey } from '@solana/web3.js';

import type { Authenticator } from '../auth.js';
import type { Config } from '../config.js';
import { Errors, RelayerError, sendProblem } from '../errors.js';
import {
  RelayRequestSchema,
  decodeIxData,
  extractRelayerFee,
  isAllowedProgram,
  type RelayRequest,
} from '../validate.js';
import type { Submitter } from '../submit.js';

export interface RelayRouteOptions {
  path: string;
  label: 'shield' | 'unshield' | 'transact' | 'adapt';
  /** Min ixData length — 8 (disc) + 4 (vec-len) + 256 (proof) + 12*32 = ~480. */
  minIxDataLen: number;
  /** Hard cap. Tx is 1232 B; ix data alone shouldn't exceed ~1500 even with ALT savings. */
  maxIxDataLen: number;
  /** True only for /relay/adapt — requires adapter ID to be on the allowlist. */
  requiresAdapterAllowlist: boolean;
}

export interface RelayRouteDeps {
  cfg: Config;
  auth: Authenticator;
  submitter: Submitter;
}

export function registerRelayRoute(
  fastify: FastifyInstance,
  opts: RelayRouteOptions,
  deps: RelayRouteDeps,
): void {
  fastify.post(opts.path, async (req, reply) => {
    try {
      const ctx = deps.auth.authenticate(req);
      deps.auth.enforceRateLimit(ctx);

      const body = parseBody(req);
      const ixData = decodeIxData(body.ixData);
      assertLen(ixData.length, opts);

      // Fee-floor check — the bytes the proof was generated over.
      const fee = extractRelayerFee(ixData);
      if (fee === null) {
        throw Errors.badRequest('ixData too short to contain relayer_fee');
      }
      if (fee < deps.cfg.minFeeLamports) {
        throw Errors.feeTooLow(fee, deps.cfg.minFeeLamports);
      }

      // Adapter allowlist for /relay/adapt — the adapter program key is
      // somewhere in accountKeys; we require at least one allowlisted
      // adapter program to be present so the relayer can't be tricked into
      // forwarding CPIs to an arbitrary program.
      if (opts.requiresAdapterAllowlist) {
        if (deps.cfg.adapterAllowlist.length === 0) {
          throw Errors.forbidden('adapter relay disabled (no adapters configured)');
        }
        const seen = body.accountKeys.map((k) => new PublicKey(k.pubkey));
        const ok = seen.some((pk) => isAllowedProgram(pk, deps.cfg.adapterAllowlist));
        if (!ok) {
          throw Errors.programNotAllowed('no allowlisted adapter in accountKeys');
        }
      }

      // Per-key token allowlist (optional). We treat any pubkey in the IN
      // mint slot of TransactPublicInputs as the relayed mint; for shield
      // it sits at offset 8+4+256+5*32 + 16 = 444. Skip if no allowlist.
      enforceTokenAllowlist(ixData, ctx.policy.tokenAllowlist);

      const altAddresses = (body.altAddresses ?? []).map((s) => new PublicKey(s));

      let userSig: { signature: Uint8Array; pubkey: PublicKey } | undefined;
      if (body.userSignature && body.userPubkey) {
        const sigBytes = Uint8Array.from(Buffer.from(body.userSignature, 'base64'));
        if (sigBytes.length !== 64) {
          throw Errors.badRequest('userSignature must decode to 64 bytes');
        }
        userSig = { signature: sigBytes, pubkey: new PublicKey(body.userPubkey) };
      }

      const additionalIxs = (body.additionalIxs ?? []).map((extra) => ({
        programId: new PublicKey(extra.programId),
        ixData: Uint8Array.from(Buffer.from(extra.ixData, 'base64')),
        accountKeys: extra.accountKeys,
      }));

      const result = await deps.submitter.submit({
        programId: deps.cfg.poolProgramId,
        ixData,
        accountKeys: body.accountKeys,
        altAddresses,
        computeUnitLimit: body.computeUnitLimit ?? deps.cfg.computeUnitLimit,
        userSignature: userSig,
        additionalIxs,
      });

      req.log.info(
        {
          op: opts.label,
          keyId: ctx.keyId,
          signature: result.signature,
          slot: result.slot,
          feeBound: fee.toString(),
          ixLen: ixData.length,
        },
        'relayed',
      );
      return reply.send(result);
    } catch (e) {
      if (e instanceof RelayerError) {
        return sendProblem(reply, e, req.url);
      }
      req.log.error({ err: (e as Error).message }, 'relay handler failure');
      return sendProblem(reply, Errors.internal((e as Error).message), req.url);
    }
  });
}

function parseBody(req: FastifyRequest): RelayRequest {
  const result = RelayRequestSchema.safeParse(req.body);
  if (!result.success) {
    throw Errors.badRequest('invalid request body', { issues: result.error.issues });
  }
  return result.data;
}

function assertLen(len: number, opts: RelayRouteOptions): void {
  if (len < opts.minIxDataLen) {
    throw Errors.badRequest(`ixData too short for ${opts.label}: ${len} < ${opts.minIxDataLen}`);
  }
  if (len > opts.maxIxDataLen) {
    throw Errors.badRequest(`ixData too long for ${opts.label}: ${len} > ${opts.maxIxDataLen}`);
  }
}

const PUBLIC_TOKEN_MINT_OFFSET = 8 + 4 + 256 + 5 * 32 + 16; // 444
function enforceTokenAllowlist(ixData: Uint8Array, allowlist: string[] | undefined): void {
  if (!allowlist || allowlist.length === 0) return;
  if (ixData.length < PUBLIC_TOKEN_MINT_OFFSET + 32) return; // skip — caller already failed length checks
  const mintBytes = ixData.slice(PUBLIC_TOKEN_MINT_OFFSET, PUBLIC_TOKEN_MINT_OFFSET + 32);
  const mintB58 = new PublicKey(mintBytes).toBase58();
  if (!allowlist.includes(mintB58)) {
    throw Errors.forbidden(`mint ${mintB58} not in api-key allowlist`);
  }
}

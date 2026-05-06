/**
 * /relay/pool-ix — generic pool-ix relay endpoint.
 *
 * Forwards any ix to the configured pool program. Unlike the per-feature
 * routes (/relay/{shield,unshield,transact,adapt}) which carry length
 * floors, fee floors, and adapter-allowlist checks specific to
 * fee-extracting pool ixs, this route exists for pool-internal ixs that
 * have no fee field (PRD-35 commit_inputs, future maintenance setup ixs).
 *
 * Security boundary:
 *   - cfg.poolProgramId is fixed by the operator. Caller cannot forward
 *     ixs to any other program through this endpoint.
 *   - Auth + rate-limit enforced (same as per-feature routes).
 *   - The pool program itself enforces its constraints (PDA derivation,
 *     signer seeds, Light protocol checks).
 *
 * Why generic instead of per-feature: every new pool ix shouldn't
 * require a relayer redeploy. As long as the ix targets cfg.poolProgramId,
 * relay it.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { PublicKey } from '@solana/web3.js';

import type { Authenticator } from '../auth.js';
import type { Config } from '../config.js';
import { Errors, RelayerError, sendProblem } from '../errors.js';
import {
  RelayRequestSchema,
  decodeIxData,
  type RelayRequest,
} from '../validate.js';
import type { Submitter } from '../submit.js';

export interface PoolIxRouteDeps {
  cfg: Config;
  auth: Authenticator;
  submitter: Submitter;
}

export function registerPoolIx(
  fastify: FastifyInstance,
  deps: PoolIxRouteDeps,
): void {
  fastify.post('/relay/pool-ix', async (req, reply) => {
    try {
      const ctx = deps.auth.authenticate(req);
      deps.auth.enforceRateLimit(ctx);

      const body = parseBody(req);
      const ixData = decodeIxData(body.ixData);

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
        // SECURITY: programId is taken from operator config, NEVER from
        // request body. This is what restricts the relayer to forwarding
        // only to our pool program.
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
          op: 'pool-ix',
          keyId: ctx.keyId,
          signature: result.signature,
          slot: result.slot,
          ixLen: ixData.length,
          additionalIxCount: additionalIxs.length,
        },
        'relayed',
      );
      return reply.send(result);
    } catch (e) {
      if (e instanceof RelayerError) {
        return sendProblem(reply, e, req.url);
      }
      req.log.error({ err: (e as Error).message }, 'pool-ix handler failure');
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

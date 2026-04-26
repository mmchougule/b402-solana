/**
 * RFC 7807 problem-details error responses.
 *
 * https://datatracker.ietf.org/doc/html/rfc7807
 */

import type { FastifyReply } from 'fastify';

export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
  /** Free-form per-error metadata; never include PII or signature material. */
  [k: string]: unknown;
}

export class RelayerError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly extra?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'RelayerError';
  }

  toProblem(instance?: string): ProblemDetails {
    return {
      type: `https://b402.ai/errors/${this.code}`,
      title: this.code,
      status: this.status,
      detail: this.message,
      ...(instance ? { instance } : {}),
      ...(this.extra ?? {}),
    };
  }
}

export const Errors = {
  badRequest: (msg: string, extra?: Record<string, unknown>) =>
    new RelayerError(400, 'bad_request', msg, extra),
  unauthorized: (msg: string) => new RelayerError(401, 'unauthorized', msg),
  forbidden: (msg: string) => new RelayerError(403, 'forbidden', msg),
  rateLimited: (msg: string) => new RelayerError(429, 'rate_limited', msg),
  txTooLarge: (size: number, max: number) =>
    new RelayerError(400, 'tx_too_large', `serialised tx is ${size} bytes; cap is ${max}`, { size, max }),
  feeTooLow: (got: bigint, min: bigint) =>
    new RelayerError(400, 'fee_too_low', `relayer_fee ${got} below floor ${min}`, {
      got: got.toString(),
      min: min.toString(),
    }),
  programNotAllowed: (programId: string) =>
    new RelayerError(400, 'program_not_allowed', `program ${programId} is not on the allowlist`, { programId }),
  rpcFailure: (msg: string, extra?: Record<string, unknown>) =>
    new RelayerError(502, 'rpc_failure', msg, extra),
  internal: (msg: string) => new RelayerError(500, 'internal', msg),
};

export function sendProblem(reply: FastifyReply, err: RelayerError, instance?: string): FastifyReply {
  const body = err.toProblem(instance);
  return reply
    .code(err.status)
    .header('content-type', 'application/problem+json')
    .send(body);
}

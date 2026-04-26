/**
 * API-key auth + per-key sliding-window rate limit.
 *
 * Keys are passed via `Authorization: Bearer <key>` or `x-api-key: <key>`.
 * If the config has no API keys loaded (`authEnabled === false`), all
 * requests are accepted as `key="anon"` with a single shared bucket.
 *
 * Constant-time string compare to avoid timing oracle on key prefixes.
 */

import type { FastifyRequest } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import type { ApiKeyEntry, Config } from './config.js';
import { Errors, RelayerError } from './errors.js';

interface Bucket {
  windowStart: number;
  count: number;
  limit: number;
}

const WINDOW_MS = 60_000;

export interface AuthContext {
  keyId: string;
  policy: ApiKeyEntry;
}

export class Authenticator {
  private readonly buckets = new Map<string, Bucket>();
  private readonly anonPolicy: ApiKeyEntry = { rateLimitPerMin: 30 };

  constructor(private readonly cfg: Config) {}

  authenticate(req: FastifyRequest): AuthContext {
    const presented = this.extractKey(req);

    if (!this.cfg.authEnabled) {
      return { keyId: 'anon', policy: this.anonPolicy };
    }
    if (!presented) {
      throw Errors.unauthorized('missing api key');
    }
    const keys = this.cfg.apiKeys;
    if (!keys) {
      // authEnabled true but map nullified — defensive.
      throw Errors.internal('auth misconfigured');
    }

    const matched = matchKey(presented, keys);
    if (!matched) {
      throw Errors.unauthorized('invalid api key');
    }
    return { keyId: matched.keyId, policy: matched.policy };
  }

  /**
   * Increment the per-key counter. Throws RelayerError(429) when the
   * window's quota is exhausted.
   */
  enforceRateLimit(ctx: AuthContext, now: number = Date.now()): void {
    const limit = ctx.policy.rateLimitPerMin;
    let b = this.buckets.get(ctx.keyId);
    if (!b || now - b.windowStart >= WINDOW_MS) {
      b = { windowStart: now, count: 0, limit };
      this.buckets.set(ctx.keyId, b);
    }
    if (b.count >= limit) {
      throw Errors.rateLimited(`limit ${limit}/min for key ${ctx.keyId}`);
    }
    b.count += 1;
  }

  private extractKey(req: FastifyRequest): string | null {
    const auth = req.headers['authorization'];
    if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
      return auth.slice('Bearer '.length).trim();
    }
    const x = req.headers['x-api-key'];
    if (typeof x === 'string' && x.length > 0) return x.trim();
    return null;
  }
}

function matchKey(presented: string, keys: Record<string, ApiKeyEntry>): { keyId: string; policy: ApiKeyEntry } | null {
  const presentedBuf = Buffer.from(presented, 'utf-8');
  for (const [keyId, policy] of Object.entries(keys)) {
    const candidate = Buffer.from(keyId, 'utf-8');
    if (candidate.length !== presentedBuf.length) continue;
    if (timingSafeEqual(candidate, presentedBuf)) {
      return { keyId, policy };
    }
  }
  return null;
}

export function isRelayerError(e: unknown): e is RelayerError {
  return e instanceof RelayerError;
}

/**
 * /relay/pool-ix — generic pool-ix relay endpoint.
 *
 * Forwards ANY ix to the configured pool program, signing + paying gas
 * with the relayer keypair. Unlike /relay/{shield,unshield,transact,adapt}
 * which carry feature-specific length + fee + adapter checks, this route
 * exists to relay pool-internal ixs that don't extract a fee from the
 * shielded pool (e.g. PRD-35 commit_inputs, future pool maintenance
 * setup ixs).
 *
 * Security boundary:
 *   - cfg.poolProgramId is the ONLY program the relayer will forward to;
 *     callers cannot override it.
 *   - Auth + rate-limit still enforced.
 *   - No fee floor (commit_inputs has no fee field), no adapter
 *     allowlist (it's a pool ix, not adapter CPI). The pool program
 *     itself enforces its constraints (PDA derivation, signer seeds, etc).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { Keypair, PublicKey } from '@solana/web3.js';
import { Authenticator } from '../src/auth.js';
import type { Config } from '../src/config.js';
import type { Submitter, SubmitInput, SubmitResult } from '../src/submit.js';
import { registerPoolIx } from '../src/routes/pool-ix.js';

function baseConfig(overrides: Partial<Config> = {}): Config {
  return {
    port: 0,
    host: '127.0.0.1',
    logLevel: 'silent',
    rpcUrl: 'http://127.0.0.1:8899',
    keypair: Keypair.generate(),
    poolProgramId: new PublicKey('42a3hsCXtQLWonyxWZosaaCJCweYYKMrvNd25p1Jrt2y'),
    verifierTransactProgramId: null,
    verifierAdaptProgramId: null,
    adapterAllowlist: [],
    jitoBundleUrl: null,
    minFeeLamports: 0n,
    apiKeys: null,
    authEnabled: false,
    maxTxSize: 1232,
    computeUnitLimit: 1_400_000,
    ...overrides,
  };
}

function captureSubmitter(): { submitter: Submitter; calls: SubmitInput[] } {
  const calls: SubmitInput[] = [];
  const submitter: Submitter = {
    async submit(input: SubmitInput): Promise<SubmitResult> {
      calls.push(input);
      return { signature: 'mocked-sig-' + calls.length, slot: 100, confirmedAt: new Date().toISOString() };
    },
  };
  return { submitter, calls };
}

async function buildTestServer(opts: {
  cfg?: Partial<Config>;
  submitter?: Submitter;
} = {}): Promise<{ fastify: FastifyInstance; calls: SubmitInput[] }> {
  const cfg = baseConfig(opts.cfg);
  const auth = new Authenticator(cfg);
  const { submitter, calls } = opts.submitter
    ? { submitter: opts.submitter, calls: [] as SubmitInput[] }
    : captureSubmitter();
  const fastify = Fastify({ logger: false });
  registerPoolIx(fastify, { cfg, auth, submitter });
  await fastify.ready();
  return { fastify, calls };
}

const VALID_BODY = {
  ixData: Buffer.from(new Uint8Array([1, 2, 3, 4])).toString('base64'),
  accountKeys: [
    { pubkey: '11111111111111111111111111111111', isSigner: true, isWritable: true },
  ],
  altAddresses: [],
  computeUnitLimit: 200_000,
};

describe('POST /relay/pool-ix', () => {
  it('forwards a small ix (no fee field) to the submitter and returns the sig', async () => {
    const { fastify, calls } = await buildTestServer();
    const res = await fastify.inject({
      method: 'POST',
      url: '/relay/pool-ix',
      payload: VALID_BODY,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.signature).toBe('mocked-sig-1');
    expect(calls).toHaveLength(1);
    expect(calls[0].ixData).toEqual(new Uint8Array([1, 2, 3, 4]));
    await fastify.close();
  });

  it('locks programId to cfg.poolProgramId — caller cannot override', async () => {
    const cfg = baseConfig();
    const { fastify, calls } = await buildTestServer({ cfg });
    const res = await fastify.inject({
      method: 'POST',
      url: '/relay/pool-ix',
      payload: {
        ...VALID_BODY,
        // attacker tries to inject another program id; relayer must ignore.
        programId: '11111111111111111111111111111111',
      },
    });
    expect(res.statusCode).toBe(200);
    expect(calls[0].programId.toBase58()).toBe(cfg.poolProgramId.toBase58());
    await fastify.close();
  });

  it('forwards altAddresses + computeUnitLimit + additionalIxs unchanged', async () => {
    const { fastify, calls } = await buildTestServer();
    const altAddr = 'SysvarRent111111111111111111111111111111111';
    const res = await fastify.inject({
      method: 'POST',
      url: '/relay/pool-ix',
      payload: {
        ...VALID_BODY,
        altAddresses: [altAddr],
        computeUnitLimit: 333_000,
        additionalIxs: [{
          programId: '11111111111111111111111111111111',
          ixData: Buffer.from(new Uint8Array([9, 9])).toString('base64'),
          accountKeys: [{ pubkey: '11111111111111111111111111111111', isSigner: false, isWritable: false }],
        }],
      },
    });
    expect(res.statusCode).toBe(200);
    expect(calls[0].altAddresses.map((p) => p.toBase58())).toEqual([altAddr]);
    expect(calls[0].computeUnitLimit).toBe(333_000);
    expect(calls[0].additionalIxs).toHaveLength(1);
    expect(calls[0].additionalIxs?.[0]?.ixData).toEqual(new Uint8Array([9, 9]));
    await fastify.close();
  });

  it('rejects malformed body with 400', async () => {
    const { fastify } = await buildTestServer();
    const res = await fastify.inject({
      method: 'POST',
      url: '/relay/pool-ix',
      payload: { ixData: 'not-base64!!!', accountKeys: [] },
    });
    expect(res.statusCode).toBe(400);
    await fastify.close();
  });

  it('rejects requests without auth when authEnabled', async () => {
    const cfg = baseConfig({
      authEnabled: true,
      apiKeys: { kp_test: { rateLimitPerMin: 60 } },
    });
    const { fastify } = await buildTestServer({ cfg });
    const res = await fastify.inject({
      method: 'POST',
      url: '/relay/pool-ix',
      payload: VALID_BODY,
    });
    expect(res.statusCode).toBe(401);
    await fastify.close();
  });

  it('accepts authenticated request and forwards to submitter', async () => {
    const cfg = baseConfig({
      authEnabled: true,
      apiKeys: { kp_test: { rateLimitPerMin: 60 } },
    });
    const { fastify, calls } = await buildTestServer({ cfg });
    const res = await fastify.inject({
      method: 'POST',
      url: '/relay/pool-ix',
      payload: VALID_BODY,
      headers: { authorization: 'Bearer kp_test' },
    });
    expect(res.statusCode).toBe(200);
    expect(calls).toHaveLength(1);
    await fastify.close();
  });

  it('does NOT enforce a fee floor (some pool ixs have no fee field)', async () => {
    // Set min fee high; would normally reject if fee-floor was enforced.
    const cfg = baseConfig({ minFeeLamports: 10_000_000n });
    const { fastify, calls } = await buildTestServer({ cfg });
    const res = await fastify.inject({
      method: 'POST',
      url: '/relay/pool-ix',
      payload: VALID_BODY,
    });
    expect(res.statusCode).toBe(200);
    expect(calls).toHaveLength(1);
    await fastify.close();
  });

  it('does NOT require an adapter allowlist match (it is a pool-internal ix)', async () => {
    const cfg = baseConfig({ adapterAllowlist: [] });
    const { fastify, calls } = await buildTestServer({ cfg });
    const res = await fastify.inject({
      method: 'POST',
      url: '/relay/pool-ix',
      payload: VALID_BODY,
    });
    expect(res.statusCode).toBe(200);
    expect(calls).toHaveLength(1);
    await fastify.close();
  });
});

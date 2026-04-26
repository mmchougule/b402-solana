import { describe, it, expect, beforeEach } from 'vitest';
import { Keypair, PublicKey } from '@solana/web3.js';
import { Authenticator } from '../src/auth.js';
import type { Config } from '../src/config.js';
import { RelayerError } from '../src/errors.js';

function fakeReq(headers: Record<string, string>) {
  // FastifyRequest has many fields; we only use `headers` in Authenticator.
  // Cast to unknown to satisfy the structural typing.
  return { headers } as unknown as Parameters<Authenticator['authenticate']>[0];
}

function baseConfig(authEnabled: boolean, apiKeys: Config['apiKeys']): Config {
  return {
    port: 0,
    host: '127.0.0.1',
    logLevel: 'silent',
    rpcUrl: 'http://127.0.0.1:8899',
    keypair: Keypair.generate(),
    poolProgramId: PublicKey.default,
    verifierTransactProgramId: null,
    verifierAdaptProgramId: null,
    adapterAllowlist: [],
    jitoBundleUrl: null,
    minFeeLamports: 0n,
    apiKeys,
    authEnabled,
    maxTxSize: 1232,
    computeUnitLimit: 1_400_000,
  };
}

describe('Authenticator', () => {
  describe('auth disabled', () => {
    it('accepts every request as anon', () => {
      const auth = new Authenticator(baseConfig(false, null));
      const ctx = auth.authenticate(fakeReq({}));
      expect(ctx.keyId).toBe('anon');
      expect(ctx.policy.rateLimitPerMin).toBeGreaterThan(0);
    });
  });

  describe('auth enabled', () => {
    const keys = {
      'test-key-12345678': { rateLimitPerMin: 3 },
      'second-key-abcdefgh': { rateLimitPerMin: 5, label: 'beta' },
    };

    let auth: Authenticator;
    beforeEach(() => {
      auth = new Authenticator(baseConfig(true, keys));
    });

    it('rejects missing key', () => {
      expect(() => auth.authenticate(fakeReq({}))).toThrowError(RelayerError);
    });

    it('rejects bad key', () => {
      try {
        auth.authenticate(fakeReq({ 'x-api-key': 'wrong' }));
        expect.fail('should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(RelayerError);
        expect((e as RelayerError).status).toBe(401);
      }
    });

    it('accepts via Bearer header', () => {
      const ctx = auth.authenticate(fakeReq({ authorization: 'Bearer test-key-12345678' }));
      expect(ctx.keyId).toBe('test-key-12345678');
    });

    it('accepts via x-api-key header', () => {
      const ctx = auth.authenticate(fakeReq({ 'x-api-key': 'second-key-abcdefgh' }));
      expect(ctx.keyId).toBe('second-key-abcdefgh');
      expect(ctx.policy.label).toBe('beta');
    });
  });

  describe('rate limit', () => {
    it('allows up to limit then 429s', () => {
      const auth = new Authenticator(baseConfig(true, { 'k1234567890': { rateLimitPerMin: 2 } }));
      const ctx = auth.authenticate(fakeReq({ 'x-api-key': 'k1234567890' }));
      auth.enforceRateLimit(ctx, 1_000);
      auth.enforceRateLimit(ctx, 1_001);
      expect(() => auth.enforceRateLimit(ctx, 1_002)).toThrowError(/rate_limited|limit/);
    });

    it('resets after window', () => {
      const auth = new Authenticator(baseConfig(true, { 'k1234567890': { rateLimitPerMin: 1 } }));
      const ctx = auth.authenticate(fakeReq({ 'x-api-key': 'k1234567890' }));
      auth.enforceRateLimit(ctx, 1_000);
      expect(() => auth.enforceRateLimit(ctx, 2_000)).toThrowError();
      // 60s + 1ms later → new window
      auth.enforceRateLimit(ctx, 1_000 + 60_001);
    });
  });
});

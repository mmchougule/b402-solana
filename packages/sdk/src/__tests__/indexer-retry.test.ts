/**
 * Tests for B402Indexer.proveLeafWithRetry — the retry layer that absorbs
 * the shield-then-immediate-swap race against the indexer.
 *
 * Strategy: stub global.fetch so proveLeaf hits a controllable response
 * sequence. The retry method's behavior we pin:
 *   - succeed on first try → 1 call, no sleeps
 *   - 404 then success    → retry, succeed (transient case)
 *   - 5xx then success    → retry, succeed (transient case)
 *   - all 404             → throw after `attempts` calls, with the last error
 *   - permanent 400       → don't retry, throw on first call
 *   - permanent 403       → don't retry, throw on first call
 *   - aborted / network   → retry (transient)
 *   - respects custom attempts + sleep injection
 *   - exponential backoff caps at maxDelayMs
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Connection, PublicKey } from '@solana/web3.js';
import { B402Indexer, isTransientIndexerError } from '../indexer.js';

const POOL_ID = new PublicKey('42a3hsCXtQLWonyxWZosaaCJCweYYKMrvNd25p1Jrt2y');

function stubConn(): Connection {
  // proveLeaf only hits the connection when verifyOnChainRoot=true. We
  // disable that here so the retry behavior is the unit under test, not
  // the on-chain assertion.
  return { getAccountInfo: async () => null } as unknown as Connection;
}

function makeIndexer(opts: { url?: string } = {}) {
  return new B402Indexer({
    url: opts.url ?? 'http://test.local',
    connection: stubConn(),
    poolProgramId: POOL_ID,
    verifyOnChainRoot: false,
  });
}

/**
 * Build a Response-like object that the SDK's fetchJson accepts.
 * On success we return a valid proof shape; on error we return a non-2xx.
 */
function okResponse(leafIndex: bigint): Response {
  const body = {
    leafIndex: leafIndex.toString(),
    leaf: '00'.repeat(32),
    siblings: Array(26).fill('00'.repeat(32)),
    pathBits: Array(26).fill(0),
    root: '00'.repeat(32),
  };
  return new Response(JSON.stringify(body), { status: 200 });
}

function errResponse(status: number): Response {
  return new Response('error', { status, statusText: `HTTP ${status}` });
}

const ORIG_FETCH = globalThis.fetch;

beforeEach(() => {
  // Each test reprograms global.fetch.
});

afterEach(() => {
  globalThis.fetch = ORIG_FETCH;
});

describe('proveLeafWithRetry', () => {
  it('returns on first attempt when indexer responds 200', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(okResponse(5n));
    globalThis.fetch = fetchMock as any;
    const sleep = vi.fn(async () => {});

    const idx = makeIndexer();
    const proof = await idx.proveLeafWithRetry(5n, { sleep });
    expect(proof.leafIndex).toBe(5n);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('retries on 404 (leaf not yet indexed) then succeeds', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(errResponse(404))
      .mockResolvedValueOnce(okResponse(7n));
    globalThis.fetch = fetchMock as any;
    const sleep = vi.fn(async () => {});

    const idx = makeIndexer();
    const proof = await idx.proveLeafWithRetry(7n, { sleep });
    expect(proof.leafIndex).toBe(7n);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('retries on 503 (server transient) then succeeds', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(errResponse(503))
      .mockResolvedValueOnce(okResponse(9n));
    globalThis.fetch = fetchMock as any;
    const sleep = vi.fn(async () => {});

    const idx = makeIndexer();
    const proof = await idx.proveLeafWithRetry(9n, { sleep });
    expect(proof.leafIndex).toBe(9n);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does NOT retry on permanent 400 (bad request)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(errResponse(400));
    globalThis.fetch = fetchMock as any;
    const sleep = vi.fn(async () => {});

    const idx = makeIndexer();
    await expect(idx.proveLeafWithRetry(1n, { sleep })).rejects.toThrow(/HTTP 400/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('does NOT retry on permanent 403 (forbidden)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(errResponse(403));
    globalThis.fetch = fetchMock as any;
    const sleep = vi.fn(async () => {});

    const idx = makeIndexer();
    await expect(idx.proveLeafWithRetry(1n, { sleep })).rejects.toThrow(/HTTP 403/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('exhausts retries on persistent 404 and throws the last error', async () => {
    const fetchMock = vi.fn().mockResolvedValue(errResponse(404));
    globalThis.fetch = fetchMock as any;
    const sleep = vi.fn(async () => {});

    const idx = makeIndexer();
    await expect(idx.proveLeafWithRetry(99n, { sleep, attempts: 3 })).rejects.toThrow(
      /HTTP 404/,
    );
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2); // sleep between attempts, not after last
  });

  it('respects custom `attempts` (1 → no retries)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(errResponse(404));
    globalThis.fetch = fetchMock as any;
    const sleep = vi.fn(async () => {});

    const idx = makeIndexer();
    await expect(idx.proveLeafWithRetry(1n, { sleep, attempts: 1 })).rejects.toThrow(
      /HTTP 404/,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('applies exponential backoff: 1x, 1.5x, capped at maxDelayMs', async () => {
    const fetchMock = vi.fn().mockResolvedValue(errResponse(404));
    globalThis.fetch = fetchMock as any;
    const delays: number[] = [];
    const sleep = vi.fn(async (ms: number) => {
      delays.push(ms);
    });

    const idx = makeIndexer();
    await expect(
      idx.proveLeafWithRetry(1n, {
        sleep,
        attempts: 5,
        initialDelayMs: 100,
        maxDelayMs: 250,
      }),
    ).rejects.toThrow();
    // 4 sleeps between 5 attempts. Growth: 100, 150, 225, then capped at 250.
    expect(delays).toEqual([100, 150, 225, 250]);
  });

  it('retries on network/abort errors (fetch failure pattern)', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('fetch failed'))
      .mockResolvedValueOnce(okResponse(2n));
    globalThis.fetch = fetchMock as any;
    const sleep = vi.fn(async () => {});

    const idx = makeIndexer();
    const proof = await idx.proveLeafWithRetry(2n, { sleep });
    expect(proof.leafIndex).toBe(2n);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('isTransientIndexerError', () => {
  it.each([
    ['indexer http://x HTTP 404: Not Found', true],
    ['indexer http://x HTTP 503: Service Unavailable', true],
    ['indexer http://x HTTP 502: Bad Gateway', true],
    ['fetch failed', true],
    ['The operation was aborted', true],
    ['ECONNRESET something', true],
    ['indexer http://x HTTP 400: Bad Request', false],
    ['indexer http://x HTTP 401: Unauthorized', false],
    ['indexer http://x HTTP 403: Forbidden', false],
    ['indexer returned leafIndex 7 for request 5', false],
  ])('"%s" → transient=%s', (msg, expected) => {
    expect(isTransientIndexerError(new Error(msg))).toBe(expected);
  });
});

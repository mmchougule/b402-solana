/**
 * Verifies the browser-compat buffer path: AdaptProver / TransactProver
 * accept Uint8Array (and ArrayBuffer) for wasm/zkey alongside string
 * paths. Construction must NOT trip fs.existsSync when the artifact is
 * already a buffer.
 *
 * We don't run a full proof here (the buffers are zero-bytes; snarkjs
 * would fail at fullProve, which is the right behavior). The test scope
 * is the constructor's path/buffer dispatch.
 */
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { AdaptProver } from '../adapt.js';
import { TransactProver } from '../index.js';

const REAL_ADAPT_WASM = path.resolve(
  __dirname, '../../../../circuits/build/adapt_js/adapt.wasm',
);
const REAL_ADAPT_ZKEY = path.resolve(
  __dirname, '../../../../circuits/ceremony/adapt_final.zkey',
);

describe('AdaptProver — buffer artifacts', () => {
  it('accepts string paths (Node / MCP back-compat)', () => {
    // Skip when ceremony artifacts aren't on disk (clean checkout / CI).
    if (!fs.existsSync(REAL_ADAPT_WASM) || !fs.existsSync(REAL_ADAPT_ZKEY)) return;
    expect(() => new AdaptProver({
      wasmPath: REAL_ADAPT_WASM,
      zkeyPath: REAL_ADAPT_ZKEY,
    })).not.toThrow();
  });

  it('accepts Uint8Array buffers — no fs.existsSync trip', () => {
    expect(() => new AdaptProver({
      wasmPath: new Uint8Array(0),
      zkeyPath: new Uint8Array(0),
    })).not.toThrow();
  });

  it('accepts ArrayBuffer — no fs.existsSync trip', () => {
    expect(() => new AdaptProver({
      wasmPath: new ArrayBuffer(0),
      zkeyPath: new ArrayBuffer(0),
    })).not.toThrow();
  });

  it('mixed string + buffer is allowed', () => {
    if (!fs.existsSync(REAL_ADAPT_WASM)) return;
    // String wasm exists, buffer zkey doesn't trip fs.existsSync
    expect(() => new AdaptProver({
      wasmPath: REAL_ADAPT_WASM,
      zkeyPath: new Uint8Array(0),
    })).not.toThrow();
  });

  it('nonexistent string path still throws (back-compat — fail fast)', () => {
    expect(() => new AdaptProver({
      wasmPath: '/dev/null/nonexistent.wasm',
      zkeyPath: '/dev/null/nonexistent.zkey',
    })).toThrow(/missing/);
  });

  it('nonexistent string + valid buffer: still throws on the missing path', () => {
    expect(() => new AdaptProver({
      wasmPath: '/dev/null/nonexistent.wasm',
      zkeyPath: new Uint8Array(0),
    })).toThrow(/missing/);
  });
});

describe('TransactProver — buffer artifacts', () => {
  it('accepts Uint8Array buffers', () => {
    expect(() => new TransactProver({
      wasmPath: new Uint8Array(0),
      zkeyPath: new Uint8Array(0),
    })).not.toThrow();
  });

  it('nonexistent string path still throws', () => {
    expect(() => new TransactProver({
      wasmPath: '/dev/null/nonexistent.wasm',
      zkeyPath: '/dev/null/nonexistent.zkey',
    })).toThrow(/missing/);
  });
});

/**
 * Circuit artifact loader. Resolves wasm + zkey paths for the transact +
 * adapt circuits with a content-addressed cache.
 *
 * Trust model:
 *   - SHA256 hashes for all four artifacts are pinned in this file.
 *   - The CDN serves untrusted bytes — every fetched file is verified
 *     against its pinned hash before being placed in the cache. A
 *     tampered CDN can DoS but cannot substitute a backdoored zkey.
 *   - Cache key is the hash itself, not the URL — even if cache dir is
 *     shared across versions, files cannot masquerade.
 *
 * Default cache: ~/.b402ai/circuits/<sha256>/<filename>
 *
 * Override the URL base with B402_CIRCUITS_URL_BASE for air-gapped /
 * mirrored deployments. Override the cache root with B402_CIRCUITS_CACHE.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

export interface CircuitArtifact {
  /** Public name of the file as it appears in the CDN. */
  filename: string;
  /** Pinned SHA256 of the file's bytes (hex, lowercase). */
  sha256: string;
  /** Expected size in bytes (early sanity check before hashing). */
  size: number;
}

/**
 * Pinned artifact descriptors. Update on every circuit-binary release.
 * Hashes computed with `shasum -a 256 <file>`.
 */
export const TRANSACT_WASM: CircuitArtifact = {
  filename: 'transact.wasm',
  sha256: 'e7660490d3d99eeb47c2af0757927a834a9391194bb016c35debea075341ee4f',
  size: 3_038_965,
};
export const TRANSACT_ZKEY: CircuitArtifact = {
  filename: 'transact_final.zkey',
  sha256: '0f2975e137582aa8a30855b3e0f4a1888538059ac8428232eee1d9d2eeae0506',
  size: 12_359_270,
};
export const ADAPT_WASM: CircuitArtifact = {
  filename: 'adapt.wasm',
  sha256: 'ab7b3c3a309bd0c637b3a12006ee584b4afbae11231d2d8b513a270f3b1b3a64',
  size: 3_129_641,
};
export const ADAPT_ZKEY: CircuitArtifact = {
  filename: 'adapt_final.zkey',
  sha256: '1d3cb5496cb1dd4dfbb923ce166f24cdfdffcb8a803fa1a36ea74071ede33f2a',
  size: 18_565_200,
};

/**
 * Default CDN — GitHub release for the pinned circuit set.
 * Tag `circuits-v1` matches Pool Phase 9 + Adapter v2 deployed on mainnet.
 */
const DEFAULT_URL_BASE =
  'https://github.com/mmchougule/b402-solana/releases/download/circuits-v1';

function urlBase(): string {
  return process.env.B402_CIRCUITS_URL_BASE ?? DEFAULT_URL_BASE;
}

function cacheRoot(): string {
  return (
    process.env.B402_CIRCUITS_CACHE
    ?? path.join(os.homedir(), '.b402ai', 'circuits')
  );
}

function cachePath(art: CircuitArtifact): string {
  return path.join(cacheRoot(), art.sha256, art.filename);
}

function sha256File(p: string): string {
  const h = createHash('sha256');
  h.update(fs.readFileSync(p));
  return h.digest('hex');
}

/**
 * Resolve a circuit artifact, fetching + caching if needed.
 *
 * Returns the absolute path to a verified copy of the file. Throws on
 * checksum mismatch — the caller should not retry blindly, since it
 * indicates either CDN tampering or a stale pinned hash in this SDK
 * version.
 */
export async function resolveCircuit(art: CircuitArtifact): Promise<string> {
  const dest = cachePath(art);

  if (fs.existsSync(dest)) {
    const got = sha256File(dest);
    if (got === art.sha256) return dest;
    // Cache poisoned somehow — wipe and refetch.
    fs.unlinkSync(dest);
  }

  fs.mkdirSync(path.dirname(dest), { recursive: true });

  const url = `${urlBase()}/${art.filename}`;
  // First call per artifact, every install. Log once so the user sees the
  // ~10s cold-start instead of a silent stall.
  console.error(`[b402] fetching circuit ${art.filename} (${(art.size / 1e6).toFixed(1)} MB)…`);

  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) {
    throw new Error(
      `circuit fetch failed: ${url} → HTTP ${res.status} ${res.statusText}. ` +
      `Set B402_CIRCUITS_URL_BASE to a mirror or pre-populate ${dest}.`,
    );
  }
  const buf = Buffer.from(await res.arrayBuffer());

  if (buf.length !== art.size) {
    throw new Error(
      `circuit ${art.filename} size mismatch — expected ${art.size}, got ${buf.length}. ` +
      `CDN may be serving a different version; refusing to cache.`,
    );
  }

  const got = createHash('sha256').update(buf).digest('hex');
  if (got !== art.sha256) {
    throw new Error(
      `circuit ${art.filename} checksum mismatch — expected ${art.sha256}, got ${got}. ` +
      `CDN tampered or SDK pinned hash is stale; refusing to cache.`,
    );
  }

  // Atomic write: tmp file + rename so a crashed download doesn't leave a
  // half-file at the cache path.
  const tmp = `${dest}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, dest);
  return dest;
}

/**
 * Resolve all four artifacts in parallel. Returns the {wasm,zkey} pair
 * for each prover.
 */
export async function resolveAllCircuits(): Promise<{
  transact: { wasmPath: string; zkeyPath: string };
  adapt: { wasmPath: string; zkeyPath: string };
}> {
  const [tWasm, tZkey, aWasm, aZkey] = await Promise.all([
    resolveCircuit(TRANSACT_WASM),
    resolveCircuit(TRANSACT_ZKEY),
    resolveCircuit(ADAPT_WASM),
    resolveCircuit(ADAPT_ZKEY),
  ]);
  return {
    transact: { wasmPath: tWasm, zkeyPath: tZkey },
    adapt: { wasmPath: aWasm, zkeyPath: aZkey },
  };
}

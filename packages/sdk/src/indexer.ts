/**
 * B402Indexer — typed client for the b402-solana-indexer HTTP service.
 *
 * The indexer is a CONVENIENCE oracle, not a trust root. It mirrors on-chain
 * state and serves Merkle proofs for arbitrary leaves (PRD-31). The wallet
 * still cryptographically verifies every proof against the on-chain root,
 * so a tampered indexer can only DoS — not forge a valid spend.
 *
 * Trust model:
 *   - Indexer-claimed `root` MUST match an on-chain root (current or recent
 *     ring entry). If not, the call is rejected before any proof is used.
 *   - The actual zk circuit + on-chain verifier do the binding: even if the
 *     SDK skipped the upfront check, an indexer-forged proof with an
 *     impossible (root, leaf) pair would be rejected by the on-chain
 *     `merkle_root` public-input check.
 *
 * Endpoints (PRD-31 §4.3):
 *   GET /v1/proof?leafIndex=N        Merkle inclusion proof for a leaf
 *   GET /v1/spent?nullifier=hex      double-spend pre-check
 *   GET /v1/state                    leaf count + current root, freshness gate
 *   GET /v1/commitments?since=N      paginated cross-device sync (V2)
 */

import { Connection, PublicKey } from '@solana/web3.js';
import type { MerkleProof } from './merkle.js';
import { decodeTreeState } from './programs/tree-state.js';
import { treeStatePda } from './programs/pda.js';
import { B402Error, B402ErrorCode } from './errors.js';

export interface B402IndexerConfig {
  /**
   * Base URL of the indexer service. e.g.
   *   https://b402-solana-indexer-api-62092339396.us-central1.run.app
   */
  url: string;
  /** Connection used to verify on-chain roots. */
  connection: Connection;
  /** b402_pool program id — used to derive the TreeState PDA for root checks. */
  poolProgramId: PublicKey;
  /**
   * Per-request timeout (ms). Default 5000 — proof generation is server-side
   * and DB-only; over 5s is a clear sign of indexer trouble, fail fast so the
   * caller can fall back to proveMostRecentLeaf.
   */
  timeoutMs?: number;
  /**
   * If true, the SDK fetches the on-chain TreeState account to verify that
   * the indexer's claimed `root` matches a recent root. Default true.
   * Disable only in tests where you don't want the extra RPC.
   */
  verifyOnChainRoot?: boolean;
}

export interface IndexerStateResponse {
  currentRoot: string | null; // hex LE
  leafCount: string;          // decimal bigint
  lastSlot: string | null;
  lastSlotAge: number;
  poolProgramId: string;
  healthy: boolean;
  schemaVersion: number;
}

export interface IndexerProofResponse {
  leafIndex: string;
  leaf: string;          // hex LE 32B
  siblings: string[];    // hex LE 32B each, length = TREE_DEPTH
  pathBits: number[];    // length = TREE_DEPTH, each 0|1
  root: string;          // hex LE 32B
  rootSlot?: number;
}

export interface IndexerSpentResponse {
  nullifier: string;
  spent: boolean;
  slot?: number;
  signature?: string;
}

/**
 * Minimal hex/bigint helpers — keep the surface tight so we don't pull
 * crypto-flavoured deps into a thin HTTP client.
 */
function hexToBigint(hex: string): bigint {
  // Indexer returns LE byte-hex (matches the on-chain encoding). Read LE.
  if (hex.length !== 64) throw new Error(`expected 64-char hex, got ${hex.length}`);
  let v = 0n;
  for (let i = 31; i >= 0; i--) {
    v = (v << 8n) | BigInt(parseInt(hex.slice(i * 2, i * 2 + 2), 16));
  }
  return v;
}

function bigintToLeHex32(v: bigint): string {
  let hex = '';
  for (let i = 0; i < 32; i++) {
    hex += (Number(v >> BigInt(i * 8)) & 0xff).toString(16).padStart(2, '0');
  }
  return hex;
}

/** AbortController-driven timeout wrapper around fetch. */
async function fetchJson<T>(url: string, timeoutMs: number): Promise<T> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) {
      throw new B402Error(
        B402ErrorCode.RpcError,
        `indexer ${url} HTTP ${res.status}: ${res.statusText}`,
      );
    }
    return (await res.json()) as T;
  } finally {
    clearTimeout(t);
  }
}

export class B402Indexer {
  private readonly cfg: Required<B402IndexerConfig>;

  constructor(cfg: B402IndexerConfig) {
    this.cfg = {
      timeoutMs: 5000,
      verifyOnChainRoot: true,
      ...cfg,
      url: cfg.url.replace(/\/$/, ''), // strip trailing slash
    };
  }

  /**
   * Fetch a Merkle inclusion proof for a specific leaf. Replaces
   * `proveMostRecentLeaf` for the spend-any-leaf path.
   *
   * Verifies that the indexer's claimed `root` matches a recent on-chain
   * root before returning, so a stale or tampered indexer fails fast rather
   * than producing a proof that the on-chain verifier will reject anyway.
   */
  async proveLeaf(leafIndex: bigint): Promise<MerkleProof> {
    const r = await fetchJson<IndexerProofResponse>(
      `${this.cfg.url}/v1/proof?leafIndex=${leafIndex.toString()}`,
      this.cfg.timeoutMs,
    );

    if (BigInt(r.leafIndex) !== leafIndex) {
      throw new B402Error(
        B402ErrorCode.InvalidConfig,
        `indexer returned leafIndex ${r.leafIndex} for request ${leafIndex}`,
      );
    }

    if (this.cfg.verifyOnChainRoot) {
      await this.assertRootIsOnChain(r.root);
    }

    return {
      leaf: hexToBigint(r.leaf),
      leafIndex,
      siblings: r.siblings.map(hexToBigint),
      pathBits: r.pathBits,
      root: hexToBigint(r.root),
    };
  }

  /**
   * Cross-check the indexer-claimed `root` against the on-chain TreeState's
   * current root and ring-buffer of recent roots. Mismatch = indexer is
   * stale (caller should retry or fall back) OR malicious (caller should
   * surface the discrepancy). Either way: don't trust it.
   *
   * Reads the TreeState account once. Caller can disable via
   * verifyOnChainRoot=false if they're willing to defer to the on-chain
   * verifier's eventual rejection.
   */
  private async assertRootIsOnChain(rootHex: string): Promise<void> {
    const acc = await this.cfg.connection.getAccountInfo(
      treeStatePda(this.cfg.poolProgramId),
    );
    if (!acc) {
      throw new B402Error(
        B402ErrorCode.InvalidConfig,
        'TreeState account not found — pool not initialised on this cluster?',
      );
    }
    const view = decodeTreeState(new Uint8Array(acc.data));
    const expected = hexToBigint(rootHex);
    const current = leToBig(view.currentRoot);
    if (current === expected) return;
    // Ring buffer of recent roots — accept any of them as valid (a proof
    // generated against a slightly-older root is still verifiable as long
    // as that root is still in the on-chain ring; otherwise the on-chain
    // verifier rejects regardless).
    for (const rOld of view.rootRing) {
      if (leToBig(rOld) === expected) return;
    }
    throw new B402Error(
      B402ErrorCode.InvalidConfig,
      `indexer root ${rootHex} not found in on-chain TreeState (current or ring). ` +
        `Indexer is stale or compromised. Disable verifyOnChainRoot only at your own risk.`,
    );
  }

  async isSpent(nullifier: bigint): Promise<boolean> {
    const hex = bigintToLeHex32(nullifier);
    const r = await fetchJson<IndexerSpentResponse>(
      `${this.cfg.url}/v1/spent?nullifier=${hex}`,
      this.cfg.timeoutMs,
    );
    return r.spent;
  }

  async state(): Promise<IndexerStateResponse> {
    return fetchJson<IndexerStateResponse>(
      `${this.cfg.url}/v1/state`,
      this.cfg.timeoutMs,
    );
  }

  /** Liveness probe — returns true if /v1/state is reachable + non-stale. */
  async healthy(): Promise<boolean> {
    try {
      const s = await this.state();
      return s.healthy;
    } catch {
      return false;
    }
  }
}

/** LE bytes → bigint helper kept local so we don't widen the public API. */
function leToBig(b: Uint8Array): bigint {
  let v = 0n;
  for (let i = b.length - 1; i >= 0; i--) v = (v << 8n) | BigInt(b[i]);
  return v;
}

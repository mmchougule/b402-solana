# PRD-31 — Indexer + spend-any-leaf

| Field | Value |
|---|---|
| **Status** | Draft |
| **Owner** | b402 core |
| **Date** | 2026-05-01 |
| **Version** | 0.1 |
| **Depends on** | PRD-01 (architecture), PRD-03 (program spec), PHASE-10 (distribution spike) |
| **Gates** | V1.0 freeze; multi-deposit unshield correctness; cross-device sync; UTXO split |

---

## 1. Goal

Build an external indexer that turns the deployed b402-solana protocol from a "rightmost-leaf-only, single-device" demo into a "spend-any-leaf, cross-device" V1.0 system. Closes four of the seven duct-tape items identified in the Phase 10 architecture spike with one piece of infrastructure.

This PRD does **not** add new on-chain programs, new circuits, or new trusted setup. The indexer is a read-side mirror of the pool's state; the pool itself is unchanged.

## 2. Problem statement

The SDK's `proveMostRecentLeaf` only generates a valid Merkle proof for the *rightmost* leaf in the on-chain tree, because it only has access to the on-chain frontier (the path of right-spine nodes). For any other leaf the SDK has no way to construct the sibling vector required by the transact circuit's `MerkleVerify`.

Direct user-visible consequence (reproduced 2026-05-01): after a private swap, the user had two wSOL deposits. The first unshield (rightmost = newer deposit) succeeded. The second unshield (older deposit) failed inside the prover with `Transact_221:169` — a Merkle assert, because the SDK fed in the proof for the now-rightmost leaf (which differs from the leaf being spent).

Three further blockers stack on the same root cause:

1. **Cross-device note discovery.** A user who shields on machine A and tries to spend on machine B has no source for the note ciphertext + leaf index — the on-chain `CommitmentAppended` event carries the encrypted note, but walking 30 days of pool history at 30 sigs/page through public RPC is impractical.
2. **UTXO split.** Already supported by the transact circuit (1 real in, 2 real out). But a split produces two notes; spending the *non-rightmost* one requires the same Merkle-proof-for-arbitrary-leaf capability.
3. **Recovery.** Wallet wipe + re-import is impossible without an indexer-served viewing-tag scan.

## 3. Non-goals (explicitly excluded)

- **Trustless / decentralised indexing.** v1 indexer is operated by the b402 team. Trustless would require either an on-chain accumulator (expensive) or a ZK-VM proof of state (out of scope). Users who don't trust the indexer can run their own; the protocol is permissionless.
- **MEV / privacy via indexer routing.** The indexer is a read-side mirror, not a sequencer. It sees what anyone sees on-chain — no additional privacy leak vs the public pool program.
- **Fee abstraction / payments.** Indexer is HTTP, free for v1. PRD-XX-fees handles monetisation later.
- **Multi-pool support.** This indexer indexes one b402 pool. Multi-pool comes if/when we deploy on Solana sister-chains.

## 4. Architecture

```
                 Solana RPC (Helius)
                        │
                        │  (a) getSignaturesForAddress polling
                        │  (b) getTransaction → parse logs
                        ▼
┌──────────────────────────────────────────────┐
│  b402-indexer service (Rust, Axum)           │
│                                              │
│  ┌─────────────┐    ┌──────────────────┐   │
│  │  Ingestor   │ ─▶ │  Postgres state  │   │
│  │  (1 worker) │    │  (commitments,   │   │
│  └─────────────┘    │   nullifiers,    │   │
│                     │   merkle nodes)  │   │
│  ┌─────────────┐    └──────────────────┘   │
│  │  HTTP API   │ ◀──────────┘               │
│  │  (Axum)     │                            │
│  └─────────────┘                            │
└──────────────────────────────────────────────┘
                        │
                        │  HTTPS GET
                        ▼
                 @b402ai/solana SDK
```

### 4.1 Ingestor

Single-tenant worker that polls `getSignaturesForAddress(b402_pool, until: lastIngestedSig)` every 2-3 seconds. For each new signature:

1. `getTransaction(sig)` → parse `program data:` log lines.
2. Decode `CommitmentAppended` and `NullifierSpent` events (Anchor base64 layout, IDL-defined).
3. Insert into Postgres atomically.
4. Update the in-memory Merkle tree mirror (Aztec-style indexed Merkle tree, Poseidon-hashed, depth 20 — matches `programs/b402-pool/src/state.rs::TreeState`).
5. Persist `lastIngestedSig` for restart recovery.

Constraint: the indexer's tree mirror MUST stay byte-equal to the pool's on-chain root. We assert this every batch by comparing `tree_root_after` from the event against our locally-computed root. Any divergence is a fatal alert.

### 4.2 Postgres schema

```sql
-- Append-only event log of every commitment leaf.
CREATE TABLE commitments (
  leaf_index    BIGINT PRIMARY KEY,
  commitment    BYTEA NOT NULL,        -- 32B Poseidon
  ciphertext    BYTEA NOT NULL,        -- 89B AES-GCM
  ephemeral_pub BYTEA NOT NULL,        -- 32B X25519
  viewing_tag   BYTEA NOT NULL,        -- 2B fast-scan
  slot          BIGINT NOT NULL,
  signature     TEXT NOT NULL UNIQUE,
  ingested_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX commitments_viewing_tag ON commitments USING HASH (viewing_tag);
CREATE INDEX commitments_slot       ON commitments (slot);

-- Append-only set of spent nullifiers.
CREATE TABLE spent_nullifiers (
  nullifier  BYTEA PRIMARY KEY,        -- 32B Poseidon
  slot       BIGINT NOT NULL,
  signature  TEXT NOT NULL,
  ingested_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Cached internal Merkle nodes for fast sibling-path queries.
-- Rebuilt from `commitments` on indexer restart; not source of truth.
CREATE TABLE merkle_nodes (
  level       SMALLINT NOT NULL,        -- 0 = leaf, 20 = root
  index       BIGINT   NOT NULL,
  hash        BYTEA    NOT NULL,
  PRIMARY KEY (level, index)
);

-- Single-row table tracking ingestion progress.
CREATE TABLE indexer_state (
  id                INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  last_signature    TEXT,
  last_slot         BIGINT,
  current_root      BYTEA,
  leaf_count        BIGINT NOT NULL DEFAULT 0,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

Storage estimate: at 100 leaves/day mainnet volume, 5 years = 180k leaves × ~200B per row + 200k merkle node rows = ~75 MB. Negligible.

### 4.3 HTTP API

All endpoints are public, unauthenticated, rate-limited at 60 req/min/IP via Cloud Run frontend. Response is JSON; binary fields are hex-encoded.

#### `GET /v1/proof?leafIndex=<N>`

Returns the Merkle inclusion proof for a specific leaf against the *current* tree root. **This is the spend-any-leaf unblocker.**

```json
{
  "leafIndex": 42,
  "leaf": "0xabc...",
  "siblings": ["0x...", "0x..." /* depth × 32B hex */],
  "pathBits": [0, 1, 1, /* depth bits */],
  "root": "0xdef...",
  "rootSlot": 416800000
}
```

SDK swaps `proveMostRecentLeaf` → `proveLeaf(leafIndex)` which fetches this and feeds it into the transact prover. Drop-in.

#### `GET /v1/spent?nullifier=<hex>`

```json
{ "nullifier": "0x...", "spent": true, "slot": 416700000, "signature": "..." }
```

Used by the SDK to detect double-spend attempts before submitting.

#### `GET /v1/commitments?since=<cursor>&limit=100&viewingTagPrefix=<2B-hex>`

Paginated stream of new commitments since cursor. Optional `viewingTagPrefix` filter for client-side scan acceleration. **This is the cross-device sync unblocker.**

```json
{
  "items": [
    {
      "leafIndex": 100,
      "commitment": "0x...",
      "ciphertext": "0x...",
      "ephemeralPub": "0x...",
      "viewingTag": "0x1234",
      "slot": 416800000
    }
  ],
  "nextCursor": "100"
}
```

Client walks pages, computes `viewingTag = AESGCM(viewingPriv ⊕ ephemeralPub)[0..2]` for each, decrypts on match. Identical to current scanner logic; just sourced from the indexer instead of `getSignaturesForAddress`.

#### `GET /v1/state`

```json
{
  "currentRoot": "0x...",
  "leafCount": 1234,
  "lastSlot": 416800000,
  "lastSlotAge": 3,
  "healthy": true
}
```

Health check. SDK uses `lastSlotAge < 60s` as a freshness gate before relying on indexer responses.

### 4.4 Failure modes + mitigations

| Failure | Detection | Mitigation |
|---|---|---|
| **Reorg** (Solana finalized commitment) | indexer uses `confirmed`; reorg between ingest and finalization can change `tree_root_after` for an unfinalized slot | Re-poll any sigs whose slot is < `current_finalized_slot`; rebuild merkle tail from commitments table if root divergence detected |
| **Indexer falls behind** | `/v1/state.lastSlotAge > 30s` | SDK falls back to `proveMostRecentLeaf` (current behavior) and surfaces a warning. Indexer alert pages on > 30s lag for > 1 min. |
| **Postgres disk full** | metric alert | Indexer is read-only after this point; ingestion stops, existing data still served. Volume scales with leaf count → far below budget. |
| **Compromised indexer (response tampering)** | client-side root verification | SDK fetches `current_root` from on-chain `TreeState` and rejects any `/v1/proof` whose `root` doesn't match. Indexer cannot forge proofs because the verifier checks the proof against the on-chain root. **Indexer is a convenience oracle, not a trust root.** |
| **DDOS** | Cloud Run autoscaling | Cache `/v1/proof` responses by `leafIndex+rootSlot` for 60s. |

The third row is the important one: **the indexer is not in the trust path.** A malicious indexer can withhold service or return stale data, but cannot get the user to construct a proof that the verifier accepts against a wrong leaf — the on-chain root is the source of truth. This is materially different from a sequencer.

### 4.5 Operations

- **Hosting:** Cloud Run with `--no-cpu-throttling --cpu-boost --min-instances=1` (avoid cold-start during sustained polling). Mirror of `b402-relayer` deploy pattern.
- **DB:** Cloud SQL Postgres (smallest tier, $7/mo) or self-hosted on a $5 VPS. Schema fits in 1GB for years.
- **Monitoring:** Datadog or Grafana Cloud. Critical alerts: (a) `lastSlotAge > 60s` for > 60s, (b) root divergence (any), (c) ingestion error rate > 1/min, (d) HTTP 5xx > 1%.
- **Cost:** ~$25/mo for hosting + DB at expected volume. Negligible vs the value unlocked.

## 5. SDK changes

```ts
// Before
import { proveMostRecentLeaf } from '@b402ai/solana';
const merkleProof = proveMostRecentLeaf(treeState, frontier);

// After
import { B402Indexer } from '@b402ai/solana';
const indexer = new B402Indexer({ url: process.env.B402_INDEXER_URL });
const merkleProof = await indexer.proveLeaf(note.leafIndex);
// On-chain root is verified inside proveLeaf — throws if indexer is stale or wrong
```

Adds:

- `packages/sdk/src/indexer.ts` — `B402Indexer` class with `proveLeaf`, `isSpent`, `commitmentsSince`, `state` methods.
- `B402SolanaConfig.indexerUrl` (defaults to `https://b402-indexer-...run.app`).
- `B402Solana.restoreFromCloud(viewingPriv, options?)` — walks `/v1/commitments` paginated, decrypts matches, populates the local NoteStore. Required for cross-device sync.

`proveMostRecentLeaf` stays in the SDK as a fallback path (when indexer is down). Triggered by `B402_INDEXER_URL=''` or explicit `{ useIndexer: false }`.

## 6. Sequencing (~2 weeks total)

| Phase | What | Effort |
|---|---|---|
| 31.1 | Indexer service skeleton: ingestor + Postgres + `/v1/state` | 2d |
| 31.2 | `/v1/proof` endpoint + Merkle node cache + on-chain root verification in SDK | 1.5d |
| 31.3 | `/v1/spent` + `/v1/commitments` endpoints | 1d |
| 31.4 | SDK integration: `B402Indexer`, `proveLeaf`, fallback | 1.5d |
| 31.5 | `restoreFromCloud` cross-device sync | 1d |
| 31.6 | Reorg handling + restart recovery | 1.5d |
| 31.7 | Monitoring, alerts, deploy to prod | 1d |
| 31.8 | E2E tests: 10-deposit shield → spend-any-order; cross-device A→B sync | 1d |

**Total ~10-11 days.** Roughly half of the Phase 10 spike's "~2 weeks for V1.0" estimate; the other half is UTXO split + indexer resilience hardening.

## 7. Done criteria

V1.0 is gated on all of:

1. ✅ Multi-deposit unshield works in any order (regression-tested with 10-deposit fixture, all permutations).
2. ✅ Cross-device sync: shield on machine A, `restoreFromCloud(viewingPriv)` on machine B sees all notes within 30s.
3. ✅ Indexer SLO: 99% of `/v1/proof` < 200ms p95 over 7 consecutive days.
4. ✅ Reorg test: stop indexer mid-ingestion, restart, verify byte-equal tree state without data loss.
5. ✅ Adversarial test: SDK rejects proofs from a tampered indexer that returns wrong-root response.

## 8. Open questions

- **Should the indexer also serve fee-payment nonces / quote attestations?** Probably no — separate concern, separate PRD. Keep indexer purely read-only.
- **Geyser vs polling for ingestion?** Polling is simpler for v1 and Helius's free tier covers it. Geyser plugin is faster but adds a Solana RPC operational dependency. Defer.
- **Should `/v1/commitments` support viewing-tag *substring* matching (privacy-preserving query)?** Returns a few false positives so the indexer can't tell which note is yours. Yes — implement as `viewingTagPrefix` (already in spec); user picks prefix length to trade privacy vs bandwidth.

---

## Appendix: relation to other privacy-pool indexers

| Protocol | Indexer model | Trust |
|---|---|---|
| **Tornado Cash** | None — clients walk on-chain history | Trustless but slow |
| **Railgun** | Multiple community indexers + protocol-run "POI" lists | Convenience oracles, not trust-critical for spend |
| **Aztec** | Sequencer is also indexer (rollup model) | Sequencer is trusted for liveness |
| **Penumbra** | Light-client friendly chain, no separate indexer | Built into chain design |
| **b402-solana (this PRD)** | Single trusted-for-liveness, untrusted-for-correctness oracle | Same shape as Railgun |

The Railgun pattern is the one we're matching — convenience oracle, on-chain root is source of truth, multiple indexers can co-exist if/when the community runs them. We start with one (b402-team-operated); the protocol is permissionless so anyone can run their own from the open-source service code.

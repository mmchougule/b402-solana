# Phase 10 — Distribution-readiness architecture spike

| Field | Value |
|---|---|
| Status | Spike — design-ready for sequenced implementation |
| Date | 2026-05-01 |
| Predecessor | Phase 9 (dual-note minting; pool-side ready, awaiting trusted-setup ceremony + deploy) |
| Owner | b402 core |
| Trigger | npm packages have 800+ downloads; preparing for broader distribution. Need to harden the SDK + supporting infra before that distribution hits real users. |

## §1. The four blockers for real distribution

In rough order of severity:

| # | Blocker | What breaks today |
|---|---|---|
| 1 | **Spend-any-leaf** | SDK's `proveMostRecentLeaf` only validates for the rightmost on-chain leaf. Once another user shields after yours, your leaf is "stranded" — you cannot privateSwap or unshield it without first unshielding everything newer. Fatal for multi-user adoption. |
| 2 | **Cross-device note discovery** | Local `NoteStore` is the only source of truth for which leaves you own. Open the SDK on a fresh machine → balance is 0, all your shielded funds appear lost. Today's `backfill` walks recent signatures via RPC; it's slow and incomplete (no historical replay, drops past 1000 sigs). |
| 3 | **Dual-note (slippage)** | Phase 9 in flight. Vault dust = up to `slippageBps` per swap = unacceptable at $1M+ trade size. |
| 4 | **UTXO split / merge** | One shielded note in, one out — no way to split a 100 USDC deposit into 4×25 for staggered withdrawal anonymity, or merge dust into a clean note. Privacy hygiene gap (amount-fingerprinting). |

**The unblocker for #1 and #2 is the same thing: a real indexer.** Once it exists, both are downstream code changes. Phase 9 is independent. Phase 10's UTXO split is a circuit/SDK feature on top of the indexer.

## §2. The indexer — what it is, what it serves

A persistent off-chain mirror of the b402 pool's on-chain state. Subscribes to the pool program's logs, persists every relevant event, exposes a small HTTP API to SDK clients.

### §2.1 What it indexes

| Source event | Persisted shape | Used for |
|---|---|---|
| `CommitmentAppended { leaf_index, commitment, encrypted_note? }` | `(leaf_index, commitment, root_after, slot, ciphertext)` | Note discovery; sibling-path generation |
| `NullifierSpent { nullifier }` | `(nullifier, slot, signature)` | Cache reconciliation; spent-state authority |
| `ExcessNoteMinted { leaf_index, excess }` (Phase 9) | `(leaf_index, excess, slot)` | Dual-note tracking — flags which leaves are excess (no ciphertext) |
| Pool-program slot/root changes | `(slot, root)` time series | Root-ring sync |

### §2.2 HTTP API

Small, stable, cacheable. Versioned at `/v1/`.

```
GET /v1/proof?leaf=<u64>
  → { siblings: [hex; 26], pathBits: [bit; 26], root: hex, root_index: u8 }

GET /v1/spent?nullifier=<hex>
  → { spent: bool, slot?: u64, signature?: string }

GET /v1/spent-since?cursor=<u64>
  → { nullifiers: [hex...], cursor: u64 } // for batch reconcile

GET /v1/commitments?from_slot=<u64>&to_slot=<u64>&limit=<u32>
  → { items: [{ leaf_index, commitment, root_after, slot, ciphertext_hex? }], next_cursor }
  // SDK uses this for note discovery: walks ciphertexts, attempts to decrypt
  // each with the user's viewing key, claims the matched leaves locally

GET /v1/tree-state
  → { leaf_count: u64, current_root: hex, ring_head: u8 }

GET /v1/healthz
  → { ok: true, latest_slot: u64, lag_seconds: u32 }
```

All responses cacheable (immutable for finalized slots). SDK clients use stale-while-revalidate.

### §2.3 Storage shape

PostgreSQL (or sqlite for self-hosters):

```sql
CREATE TABLE commitments (
  leaf_index BIGINT PRIMARY KEY,
  commitment BYTEA NOT NULL,
  root_after BYTEA NOT NULL,
  slot BIGINT NOT NULL,
  signature TEXT NOT NULL,
  ciphertext BYTEA,             -- NULL for excess-mint leaves
  ephemeral_pub BYTEA,
  viewing_tag BYTEA,
  inserted_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX commitments_slot ON commitments(slot);
CREATE INDEX commitments_viewing_tag ON commitments(viewing_tag);

CREATE TABLE nullifiers (
  nullifier BYTEA PRIMARY KEY,
  slot BIGINT NOT NULL,
  signature TEXT NOT NULL,
  inserted_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX nullifiers_slot ON nullifiers(slot);

CREATE TABLE roots (
  slot BIGINT PRIMARY KEY,
  root BYTEA NOT NULL,
  ring_head SMALLINT NOT NULL
);
```

Sibling-path generation is computed on-demand from the `commitments` table: for any `leaf_index N`, walk levels 0..25 reading the leaves at the appropriate sibling positions, hash up. ~26 reads per `/proof` call. Cacheable per (leaf_index, root_index) pair indefinitely.

### §2.4 Source of truth model

The indexer is **derived** state. Its authority comes from re-reading on-chain events. Anyone can run their own. SDK clients can be configured to point at multiple indexers (quorum / failover).

For the alpha launch: one canonical hosted indexer at `https://indexer.b402.ai/v1/`, plus `B402_INDEXER_URL` env var to override. Eventually: multiple indexers + cryptographic checkpoints + light-client verification of `root` against on-chain truth.

### §2.5 Existing repo: `b402-solana-indexer`

There's already a sibling repo at `~/development/b402-pl/b402-solana-indexer`. Status check needed (haven't read recently). If it's a reasonable starting point, build Phase 10 on top. If not, replace.

## §3. Spend-any-leaf — the SDK change once the indexer ships

Today (`packages/sdk/src/merkle.ts::proveMostRecentLeaf`):

```ts
export function proveMostRecentLeaf(
  commitment: bigint,
  leafIndex: bigint,
  rootBig: bigint,
  frontier: Uint8Array[],
  zeroCacheLe: Uint8Array[],
): MerkleProof {
  // assumes leaf is the rightmost — uses frontier + zeroCache for siblings
}
```

After Phase 10:

```ts
export async function proveLeaf(
  indexerUrl: string,
  commitment: bigint,
  leafIndex: bigint,
): Promise<MerkleProof> {
  const r = await fetch(`${indexerUrl}/v1/proof?leaf=${leafIndex}`).then(r => r.json());
  return {
    siblings: r.siblings.map(hexToBytes),
    pathBits: r.pathBits,
    root: hexToBytes(r.root),
  };
}
```

Drop-in replacement at the call sites in `b402.ts privateSwap` (line ~644) and `actions/unshield.ts` (line ~518). `proveMostRecentLeaf` stays as a fallback (e.g. for localnet development without an indexer).

**Note selection logic** can also drop the "rightmost only" hack — sort by spendability + amount, not by leafIndex. Multi-deposit users immediately become first-class.

Cost impact per swap/unshield: +1 HTTP round-trip to the indexer (~50ms). Acceptable.

## §4. Cross-device note discovery — the user-facing win

Today: `NoteStore.backfill({ limit: 30 })` walks `getSignaturesForAddress(POOL_ID, { limit })` and re-parses each tx for `CommitmentAppended` events. Limited to ~1000 most recent (RPC cap). Fresh device past that horizon = lost notes.

After Phase 10:

```ts
// New SDK method
async syncNotesFromIndexer(opts: { from_slot?: number; viewingTag?: string }) {
  const indexerUrl = this.indexerUrl;
  let cursor = opts.from_slot ?? 0;
  while (true) {
    const r = await fetch(`${indexerUrl}/v1/commitments?from_slot=${cursor}&limit=500`);
    const { items, next_cursor } = await r.json();
    for (const item of items) {
      // Try to decrypt ciphertext with this wallet's viewing key
      const decoded = tryDecrypt(item.ciphertext, this._wallet.viewingPriv);
      if (decoded) {
        this._notes.insertNote({
          leafIndex: item.leaf_index,
          commitment: BigInt('0x' + item.commitment),
          ...decoded,
        });
      }
    }
    if (!next_cursor) break;
    cursor = next_cursor;
  }
}
```

Per-call cost: walks from `from_slot` to current head. With viewing-tag pre-filtering server-side (`?viewing_tag=<8B>`), only ~1/256 of all leaves come back per request — fast.

**Phase 9 caveat**: excess-mint leaves have no ciphertext. They're discovered via a side channel: when SDK observes a `CommitmentAppended { leaf_index: N }` immediately followed by `CommitmentAppended { leaf_index: N+1 }` in the SAME tx, AND it owns leaf N (decrypt success), it derives leaf N+1's value+random+commitment via the deterministic Phase 9 recipe and claims it. **Indexer should expose `tx_id` per commitment so SDK can group leaves from the same tx.** Add to API §2.2.

## §5. Dual-note (Phase 9) — already in flight

See `PHASE-9-HANDOFF-FINAL.md`. The action_hash wire trim closed the byte budget. Pending: trusted-setup ceremony, verifier_adapt redeploy, pool redeploy. Targeting deploy this week. Out of scope for this spike.

## §6. UTXO split / merge — privacy hygiene

### §6.1 The split primitive

Goal: turn one note into N notes that sum to the input, all owned by the same user. Useful for:
- **Staggered unshield** — split 100 USDC into 4×25, unshield each over time so the recipient amounts don't fingerprint to a single deposit
- **Pre-trade splitting** — break a large note into trade-sized chunks before the swap (avoids the swap revealing your full holding via expected_out_value bound)
- **Dust consolidation** (merge primitive) — sweep many small notes into one clean note

### §6.2 Does it already work?

**Probably yes via the existing `transact` circuit**, which has 2 inputs + 2 outputs. Need to confirm:

```
1 real input, 2 real outputs, 0 dummy outputs → SPLIT a note into 2 notes
2 real inputs, 1 real output → MERGE 2 notes into 1
2 in, 2 out                  → atomic split-merge (rebalance)
1 in, 1 out (different value/random)  → re-randomize a note
```

Read `circuits/transact.circom` to confirm the constraint `inSum === outSum + relayerFee` (or similar) holds for any of these arrangements without dummy-mask gymnastics. If yes, no new circuit needed — only an SDK API surface.

### §6.3 SDK API

```ts
// b402.ts new methods
async splitNote(req: { note: SpendableNote; values: bigint[] }): Promise<{ signature: string; notes: SpendableNote[] }> {
  // values must sum to note.value
  // Generates a transact proof with 1-real-in, N-real-out
  // Each output gets a fresh random_i, same spendingPub
}

async mergeNotes(req: { notes: SpendableNote[]; intoValue?: bigint }): Promise<{ signature: string; note: SpendableNote }> {
  // notes.length must be ≤ 2 (transact circuit limit)
  // For >2 notes, caller chains merges
}
```

### §6.4 Dust merge as a built-in

Once `mergeNotes` exists, the SDK can offer `consolidateDust({ minDeposits: 5 })` that merges any unspent notes worth < some threshold into one clean note. Run periodically, makes the user's anonymity set cleaner.

## §7. Recommended sequencing

| Phase | Effort | Blocking | Outcome |
|---|---|---|---|
| 9 (dual-note) | in flight | trusted setup | Zero-loss swaps |
| 10.1 (indexer MVP) | 3-4 days | nothing | Backend that serves /proof + /spent + /commitments |
| 10.2 (spend-any-leaf SDK) | 1 day | 10.1 | SDK can spend any unspent note, not just rightmost |
| 10.3 (cross-device sync SDK) | 2 days | 10.1 | Fresh-device users see their balance |
| 10.4 (UTXO split/merge SDK) | 1-2 days | confirm transact circuit supports it | New SDK methods, privacy hygiene |
| 10.5 (indexer resilience) | 2-3 days | 10.1 | Multiple-indexer support, finality verification, light-client root check |

**Total: ~2 weeks for a properly hardened V1.0** that supports real users at distribution scale.

### §7.1 What can ship to npm RIGHT NOW (without 10)

- Phase 7B + Phase 9 deployed
- Single-deposit, single-device users — works fine, exactly what we've demoed
- Multi-deposit users — must spend rightmost note OR explicitly pass `note: ...` to swap/unshield
- Cross-device — explicitly broken; document as "alpha, single-device only for now"

That's a defensible alpha. The 800 npm downloaders haven't all hit these limits yet (most are kicking the tires on a single deposit). Phase 10 is the second-wave hardening.

## §8. Spend-any-leaf without an indexer (degraded fallback)

If we want a partial fix on the SDK side that doesn't require shipping the indexer first:

- SDK keeps a local **frontier history** indexed by `leaf_count` snapshot
- Every successful `shield`, the SDK records `{ leaf_count_at_shield, frontier_at_shield_time, root_after }`
- When spending a leaf, SDK uses the frontier from THAT historical snapshot to compute siblings
- Limited: only works for leaves the SDK has personally observed appended

That's a 100-LoC SDK feature that handles the single-device, multi-deposit case without an indexer. Doesn't fix cross-device. Worth shipping as a stop-gap if Phase 10 takes longer than expected.

## §9. Open questions

1. **Indexer hosting**: Vercel + Postgres, Cloud Run + Cloud SQL, Fly.io? Who pays for the canonical hosted version pre-mainstream? Cost analysis for 1k users: ~$50/month at the volumes we expect.
2. **Indexer bootstrap**: how long does a fresh indexer take to backfill from genesis? Pool deployed at slot ~416560668; current ~462000000 → ~46M slots = 18 days at 400ms/slot. RPC throttling is the real ceiling. Plan for parallel ingestion + state checkpointing.
3. **Indexer trust**: do we cryptographically verify on-chain root against indexer's claimed root? For alpha, no (trust the canonical hosted). For production, yes (light client root verification).
4. **Excess-leaf recovery**: Phase 9 leaves don't have ciphertext. Cross-device discovery of excess leaves requires the indexer to expose `tx_grouping` so SDK can pair (main, excess) leaves. Add to indexer API spec.
5. **transact circuit's split/merge**: needs an empirical check by writing a test that calls `transact` with `outIsDummy[0]=0, outIsDummy[1]=0` and `inIsDummy[1]=1` → does the proof generate? If yes, split is free. If circuit constrains otherwise, new circuit (small).

## §10. Decision points for the user

1. **Greenlight Phase 10.1 (indexer MVP)?** Without it, the npm package will hit hard limits as more users adopt.
2. **Build new indexer or extend `b402-solana-indexer` repo?** Need to read what's in there first.
3. **Indexer hosting choice?** (Vercel + Neon Postgres is the smoothest match for the existing toolchain.)
4. **Stop-gap SDK frontier-history?** Or wait for the proper indexer? The stop-gap is ~1 day; the proper indexer is ~3-4 days.
5. **UTXO split: confirm via test (1 hour) before committing scope?** If the transact circuit supports it natively, Phase 10.4 is just SDK code.

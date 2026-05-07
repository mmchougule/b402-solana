# PRD-36 — Percolator Perp Adapter (Option B: shielded user / private positions)

| Field | Value |
|---|---|
| **Status** | Signed Off — Locked (2026-05-06, @mayur) |
| **Owner** | b402 core |
| **Date** | 2026-05-06 |
| **Version** | 0.1 |
| **Depends on** | PRD-09 (Kamino adapter, the template), PRD-33 (per-user adapter state via shielded-identity PDAs), Phase-9 (outSpendingPub public input) |
| **Spike** | [`PHASE-12-percolator-adapter-spike.md`](./PHASE-12-percolator-adapter-spike.md). Read first. |
| **Branch (design)** | `phase-12/percolator-adapter-design` |
| **Branch (impl)** | TBD on signoff (suggested: `phase-12/percolator-adapter-impl`) |

---

## 1. Problem

Today b402 has a working private-DeFi pattern for **stateful lending** (kamino) but no path to **stateful perps**. The two architectural primitives we need — per-user protocol-level state owned by an `owner_pda` and a CPI flow that composes adapter → protocol → matcher — exist in PRD-33 (Kamino) but not for the percolator perp DEX.

Concretely, a b402 user today cannot:
- Hold an open perp position whose `user_idx` is unlinked from any public Solana wallet.
- Close that position and have the PnL settle back into the b402 shielded pool without exposing the operator wallet on the spend tx.

These are not implementation gaps in the existing kamino adapter — percolator's account model (slab-slot index) differs from kamino's (PDA address), so the per-user adapter state pattern needs a layer of mapping the kamino path doesn't have. PHASE-12 spike documents the specific divergences.

## 2. Goal

A working `b402-percolator-adapter` program that:

1. Lets a shielded b402 user **open a perp position** in a single `b402.privatePerpOpen({slab, lpIdx, sizeE6, limitPriceE6, marginAmount})` call. The adapter claims a slab slot owned by `owner_pda` (deriving from `viewing_pub_hash`), deposits `marginAmount` of USDC as collateral, and executes a `TradeCpi` of `sizeE6` against the named LP.
2. Lets the same user **close their position** in a single `b402.privatePerpClose({slab})` call. The adapter closes the position via `TradeCpi` (size = -current_size), withdraws all collateral (including realized PnL), and returns the proceeds to the b402 pool, which unshields to the recipient via the hosted relayer.

Net result: the `user_idx` slot inside percolator's slab is owned by an `owner_pda` that no public Solana wallet is linked to. An on-chain observer scanning percolator slabs sees positions, but the position's identity is 1-of-N b402 users, not 1-of-1.

## 3. Non-goals (v1)

- Partial collateral deposits or withdrawals on an open position. v1 is open-then-close only.
- Adjusting an existing position (size up, size down, leverage change). v1 forces close-and-reopen.
- Multi-market portfolios per user. v1 is one slab → one adapter call.
- Shielded LP (Option A from the spike). Tracked as PRD-36-A; reuses ~80% of this PRD's machinery.
- Custom matcher. The adapter passes whatever LP + matcher already exists in the slab; matcher choice is the LP's, not ours.
- Liquidation rescue / partial-loss insurance for shielded users. External keepers can liquidate; users eat the realized loss like everyone else.

## 4. Users and value

| Actor | Today | After PRD-36 |
|---|---|---|
| b402 shielded user | Can swap (Jupiter), can lend (Kamino), cannot trade perps | Can open and close a private perp position via two SDK calls |
| Public observer | Can graph positions on percolator's slab to identifying wallets | Sees `user_idx` slots owned by `owner_pda`s with no public-wallet linkage |
| LP / matcher | No change — sees a regular `TradeCpi` | No change — `lp_pda` signing path unchanged |
| Liquidation keeper | No change | No change — `KeeperCrank` works on `user_idx` regardless of who owns the slot |

## 5. Architecture

### 5.1 Component diagram

```
┌──────────────────────────────────────────────────────────────────────┐
│  Solana mainnet                                                       │
│                                                                        │
│  b402-pool ──adapt_execute──▶ b402-percolator-adapter                  │
│   │ Groth16 + nullifier              │                                 │
│   │ vault transfer (in)              │ derives owner_pda from          │
│   │                                  │ viewing_pub_hash                │
│   ▼                                  │                                 │
│  pool USDC vault                     │ ┌──────────────────────┐        │
│                                      ├─▶ perp-mapping account│        │
│                                      │ │ viewing_pub_hash →   │        │
│                                      │ │ user_idx (per slab)  │        │
│                                      │ └──────────────────────┘        │
│                                      │                                 │
│                                      ▼                                 │
│                              percolator-prog                           │
│                              ┌─────────────────────────┐               │
│                              │ slab account            │               │
│                              │  accounts[user_idx]     │               │
│                              │   owner = owner_pda     │               │
│                              │   collateral, position  │               │
│                              └─────────────┬───────────┘               │
│                                            │                           │
│                                            ▼ (TradeCpi only)           │
│                                  matcher_program                       │
│                                  (passive_lp / vAMM)                   │
└──────────────────────────────────────────────────────────────────────┘
```

CPI depth: pool → adapter → percolator-prog → matcher = 4 levels. Under sBPF `MAX_INVOKE_STACK_HEIGHT=5`. (Confirmed in spike §4.1.)

### 5.2 New on-chain accounts

#### 5.2.1 `owner_pda`

```
seeds:   [b"b402/v1", b"perp-owner", viewing_pub_hash]
program: b402_percolator_adapter
```

`viewing_pub_hash` = `pi.out_spending_pub.to_le_bytes()` from the adapt_execute proof's public inputs (Phase-9). Same derivation as PRD-33 §3.2.

`owner_pda` is referenced as the user `signer` in percolator's account list at `InitUser`, `DepositCollateral`, `WithdrawCollateral`, `TradeCpi`. The adapter `invoke_signed`s with the seeds above + bump.

#### 5.2.2 `perp-mapping` account

One per slab (per market). Stores the `viewing_pub_hash → user_idx` table.

```
seeds:   [b"b402/v1", b"perp-mapping", slab_pubkey]
program: b402_percolator_adapter
size:    HEADER + MAX_ENTRIES * (32 + 2 + 6)  // pad to 8-byte align
```

Header:
```rust
struct PerpMappingHeader {
    bump: u8,
    _pad: [u8; 7],
    slab: Pubkey,        // pinned at init
    next_free_idx: u16,  // monotone hint for InitUser allocator
    entry_count: u16,    // current entries (sorted prefix length)
    _pad2: [u8; 4],
}
```

Entry (40 bytes packed, 8-aligned):
```rust
struct PerpMappingEntry {
    viewing_pub_hash: [u8; 32],
    user_idx: u16,
    flags: u16,         // bit 0 = closed (slot returned to allocator)
    _pad: [u8; 4],
}
```

Lookup: binary search the sorted prefix of length `entry_count` keyed on `viewing_pub_hash`. O(log N) with N capped at `MAX_ENTRIES`.

`MAX_ENTRIES` defaults to **2048** for v1 — half of percolator's `MAX_ACCOUNTS=4096` `medium` tier, so the mapping table fits in one account (~80KB total) and rent stays under 0.6 SOL per market. Reconsider if real demand exceeds 2k unique shielded users on a single slab.

`next_free_idx` is a monotone hint, not a guarantee — the actual free-slot lookup walks percolator's slab on `InitUser` and trusts whatever percolator returns. The hint just lets us skip the most recently-allocated slot.

#### 5.2.3 `adapter_authority` (existing pattern)

```
seeds:   [b"b402/v1", b"adapter"]
program: b402_percolator_adapter
```

Owns the adapter's USDC ATA (where pool transfers in_amount before the adapter forwards it to the user's percolator-slot ATA). Same shape as kamino-adapter.

### 5.3 Action payload — `PercolatorAction`

Borsh-encoded enum, passed in the pool's `action_payload` field. Two variants for v1:

```rust
pub enum PercolatorAction {
    OpenPosition {
        lp_idx: u16,
        size_e6: i128,
        limit_price_e6: u64,
        // fee_payment passed to InitUser if first call. 0 if user already
        // has a slot in this slab.
        fee_payment_if_init: u64,
    },
    ClosePosition {
        // No params. Adapter reads current position size from slab,
        // submits TradeCpi(-current_size), then WithdrawCollateral(all).
        // limit_price_e6 sourced from a separate adapter arg below.
        limit_price_e6: u64,
    },
}
```

Bound by the proof:
- For `OpenPosition`: `in_amount` from the pool = `margin_to_deposit`. `size_e6`, `lp_idx`, `limit_price_e6` are public-input adapter args (visible — same exposure as Drift's order book).
- For `ClosePosition`: `in_amount = 0`, `min_out` is the post-PnL floor. `limit_price_e6` is the close-side slippage bound.

Public-input args (visible) vs proof-bound args (hidden):

| Arg | Visibility | Reason |
|---|---|---|
| `lp_idx` | Public | Matcher routing |
| `size_e6` | Public | Position size on chain — same exposure as any DEX trade |
| `limit_price_e6` | Public | Slippage bound, like any order |
| `viewing_pub_hash` (= `out_spending_pub`) | Public | The whole point of PRD-33 — pseudonymous identity |
| `margin_to_deposit` (open) | Bound by proof | The shielded amount being moved |
| `min_out` (close) | Public | Floor on the unshielded amount; user's choice |

### 5.4 SDK API surface

```ts
// New on B402Solana class
async privatePerpOpen(req: {
  slab: PublicKey;
  lpIdx: number;
  sizeE6: bigint;          // signed; positive = long, negative = short
  limitPriceE6: bigint;
  marginAmount: bigint;    // USDC smallest units
  inMint?: PublicKey;      // defaults to USDC mainnet
  alt?: PublicKey;
}): Promise<{
  signature: string;
  userIdx: number;         // assigned by percolator at InitUser
  positionSig: string;     // the TradeCpi that opened
}>;

async privatePerpClose(req: {
  slab: PublicKey;
  to: PublicKey;           // unshield destination
  limitPriceE6: bigint;
  minOut?: bigint;         // floor on what comes back; default 0
  alt?: PublicKey;
}): Promise<{
  signature: string;
  realizedPnl: bigint;     // signed; positive = profit
  outAmount: bigint;       // USDC unshielded to `to`
}>;
```

Both methods route through `b402.adaptExecute` with the appropriate `PercolatorAction` payload. `privatePerpOpen` has `in_amount = marginAmount`, `min_out = 0`. `privatePerpClose` has `in_amount = 0`, `min_out = minOut ?? 0n`.

### 5.5 Adapter program layout

```
programs/b402-percolator-adapter/
  Cargo.toml
  src/
    lib.rs              — entrypoint + ix dispatch
    actions/
      open.rs           — handles OpenPosition action
      close.rs          — handles ClosePosition action
    mapping.rs          — perp-mapping account read/write
    pda.rs              — owner_pda + adapter_authority + mapping derivation
    percolator_ix.rs    — manual constructors for InitUser, DepositCollateral,
                          WithdrawCollateral, TradeCpi (mirrors kamino-adapter's
                          KAMINO_IX_* constants)
  tests/
    payload_codec.rs    — Borsh round-trip on PercolatorAction
    mapping_alloc.rs    — table allocator unit tests
    open_close.rs       — fork-mode integration test
```

Mirrors `programs/b402-kamino-adapter/` 1:1 layout.

## 6. TDD plan

Per repo convention (PRD-07), every component lands with tests first.

### 6.1 Unit (Rust + Anchor harness)

| Test | Subject |
|---|---|
| `payload_codec::open_position_roundtrip` | Borsh encode/decode `OpenPosition` |
| `payload_codec::close_position_roundtrip` | Borsh encode/decode `ClosePosition` |
| `payload_codec::reject_truncated` | Truncated payloads return `InvalidInstructionData` |
| `mapping::insert_and_lookup_sorted` | Insert N entries, verify sorted prefix + binary search |
| `mapping::reject_duplicate_viewing_pub_hash` | Second `OpenPosition` for the same user reuses `user_idx` (does not allocate a new slot) |
| `mapping::next_free_hint_advances` | Allocator hint advances on each InitUser |
| `mapping::full_table_returns_error` | Insert at `MAX_ENTRIES` returns `MappingTableFull` |
| `mapping::closed_flag_skipped_on_search` | A slot with `flags & FLAG_CLOSED` is filtered from lookup, allowing reuse |
| `pda::owner_pda_matches_kamino_construction_modulo_seed` | `owner_pda` for the same user differs between kamino and percolator (per-adapter scoping check) |
| `pda::derive_with_bump_matches_find_program_address` | `Pubkey::create_program_address` parity |

### 6.2 Property tests (proptest)

- For any sequence of `(open, close)` operations on the same user, the mapping table state is invariant: at most one open entry per `viewing_pub_hash`, allocator never returns a slot already in `slab.accounts` as live.
- For any subset of `[0, MAX_ENTRIES)` of users opening then closing, the table never has more than `MAX_ENTRIES` total entries (closed slots get reused).

### 6.3 Integration (`solana-test-validator` + percolator-prog `target/deploy/`)

- **Fixture:** local validator with `b402-pool` + `b402-percolator-adapter` + `percolator-prog` + `percolator-match`'s `passive_lp_matcher` deployed; one slab `InitMarket`'d; one LP `InitLP`'d with the passive matcher.
- **Test 1 — first-call open:** privatePerpOpen by a fresh user; verify slab now has one entry at `user_idx = 0` with `owner = owner_pda(viewing_pub_hash_A)`; mapping table has one entry.
- **Test 2 — repeat open by same user:** privatePerpOpen by user A again on a different lp (or same); verify mapping reuses `user_idx = 0`; new position lives on the existing slot.
- **Test 3 — close end-to-end:** privatePerpClose by user A; verify position size = 0, collateral fully withdrawn, b402 unshield returns `marginAmount + realizedPnl` to recipient.
- **Test 4 — distinct users:** two privatePerpOpens from A and B; verify two distinct user_idx in slab, two distinct mapping entries, both positions live independently.
- **Test 5 — close after liquidation by external keeper:** trigger oracle move that liquidates A's slot via `KeeperCrank`; subsequent `privatePerpClose` for A returns whatever's left; mapping table flagged closed.
- **Test 6 — full table:** open 2048 distinct users; the 2049th returns a clean error, not a panic.
- **Test 7 — CPI depth + CU:** measure on-chain CU for a single privatePerpOpen end-to-end; assert under 1.4M (the request_compute_unit_limit cap).

### 6.4 End-to-end (`examples/percolator-perp-e2e.ts`)

The full demo flow on local validator. Runs in CI under `--test` mode; runs on devnet manually under `--devnet` once percolator-prog ships there.

## 6.5 Handler-level invariants discovered during slice 1

Found while reviewing slice 1 (pure-logic primitives). Promoted from inline notes
to explicit handler obligations so slice 3 (action handlers) implements them.

1. **Stale-entry re-verification.** Before trusting a `mapping.allocate(hash) →
   Existing { user_idx }` result, the handler MUST verify on chain that
   `slab.accounts[user_idx].owner == owner_pda`. Percolator's `KeeperCrank`
   can liquidate any slot and reassign it. If the mapping is stale, the
   handler closes the stale entry (`mapping.record_close`) and falls
   through to the `NewSlotNeeded` path.
2. **Handler-level rejection of percolator-unsafe args.** The codec accepts
   `size_e6 == 0`, `size_e6 == i128::MIN`, and `lp_idx == user_idx` because
   they're valid Borsh — but percolator-prog rejects all three with
   `InvalidInstructionData`. The handler MUST reject these earlier so the
   user sees a clean adapter-level error rather than burning CU through
   InitUser/Deposit and failing at TradeCpi.
3. **`viewing_pub_hash == [0u8; 32]` rejection at the pool layer.** The
   adapter assumes `out_spending_pub` is a non-zero Poseidon image. The
   pool's `adapt_execute` should reject proofs whose `out_spending_pub`
   public input is zero — otherwise we silently derive a "default"
   `owner_pda`. Out of scope for this PRD; tracked as PRD-36-F.
4. **Mapping `record_init` idempotency.** Slice 1 added a
   `LiveEntryMismatch` error. Handlers calling `record_init` after an
   apparent `NewSlotNeeded` outcome must pass percolator's freshly-assigned
   `user_idx` exactly. A second `record_init` for the same live hash with
   a different `user_idx` indicates a handler bug and is rejected.

## 7. Acceptance criteria

PRD-36 v1 is "done" when all of the following hold:

1. `programs/b402-percolator-adapter` builds, all unit + property + integration tests green in CI.
2. e2e example runs end-to-end on `solana-test-validator` in under 90s.
3. e2e example, run against devnet (with percolator-prog deployed there), completes a full open → close round trip and the recipient's USDC delta equals `marginAmount + realizedPnl - protocol_fees` to within rounding.
4. The user's b402 main wallet does not appear as a signer on any tx in the close path. Verified by parsing all txs in the e2e and asserting the user's main pubkey is not in any account-list of the close tx.
5. `b402.privatePerpOpen` and `b402.privatePerpClose` shipped on `@b402ai/solana`. MCP tools `private_perp_open` / `private_perp_close` shipped on `@b402ai/solana-mcp`.
6. README in `programs/b402-percolator-adapter/` documents: install, deploy, configure, threat model, limitations.
7. PRD-36 §11 outcomes met or revised in §12 Revision History.

## 8. Out-of-scope follow-ups

- **PRD-36-A:** Option A — shielded LP. Reuses ~80% of the adapter; the new surface is `privateLPInit` + `privateLPDeposit` + `privateLPWithdraw`. LP earns matcher fees in a slab slot owned by `owner_pda`.
- **PRD-36-B:** partial deposits / withdrawals on an open position. Today's v1 forces close-and-reopen.
- **PRD-36-C:** position adjustment (size delta, leverage delta) without close.
- **PRD-36-D:** multi-market portfolio per user, with one mapping table per slab.
- **PRD-36-E:** sponsored gas for shielded users on percolator (via the existing hosted relayer pattern).
- **PRD-36-F:** mapping-table compaction crank. Closed entries persist forever in the sorted prefix; over a long-lived slab with churn, the table fills and locks out new users. v2 adds a permissionless crank that compacts the table (rewrites without closed entries). Until then, MAX_ENTRIES=2048 is the soft cap on lifetime-distinct shielded users per market. Pool-side rejection of zero `out_spending_pub` also lives here.
- **Upstream coordination:** request a percolator-prog mainnet deployment slot. v1 of this PRD targets local validator + devnet.

## 9. Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| `percolator-prog` not deployed on devnet/mainnet by signoff time | High | Ship v1 against local validator only; PRD-36 acceptance §3 has a separate devnet criterion that gates merge to mainnet |
| CPI depth + CU exceed budget under matcher-side state writes | Medium | Slice 7 measures CU on a real open. If over 1.4M, fall back to splitting open across two txs (Init+Deposit, then Trade) |
| Mapping table corruption from a partial-execute on tx failure | Medium | Adapter writes mapping entry only AFTER percolator's `InitUser` returns success; on rollback the mapping write also rolls back |
| Slab slot reused after liquidation while mapping still points there | Medium | `flags & FLAG_CLOSED` set on observed liquidation; allocator skips closed entries; reclaim path in §6.3 test 5 |
| `limit_price_e6` exposure leaks intent | Low | Documented as same shape as Drift order books. Agents wanting tighter privacy add an intent layer above the adapter |
| Solana runtime upgrade reduces `MAX_INVOKE_STACK_HEIGHT` | Low | sBPF v3 set it at 5; v4+ may change. Re-test on every Solana release pinning |
| Per-user PDA reseeding if `viewing_pub_hash` algorithm changes | Low | Phase-9 outSpendingPub is locked. If a v2 changes the hash domain, mapping table needs migration |
| Stale-entry race after percolator liquidation | Medium | Handler re-verifies `slab.accounts[user_idx].owner == owner_pda` before reusing a mapping entry; on mismatch, calls `record_close` and falls through to a fresh `InitUser`. Specified in §6.5 #1. |
| Sorted `record_init` is O(N); worst-case insert at MAX_ENTRIES costs ~330k CU on top of pool's ~600k Groth16 verify | Medium | Acceptable in v1 (still under the 1.4M ix cap); slice 5 measures on solana-test-validator. If tight, switch to unsorted append-only (O(1) insert, O(N) lookup) — same correctness, different CU profile. |

## 10. Review process

- @mayur signs off this PRD before code lands on `phase-12/percolator-adapter-impl`.
- Spike doc + this PRD are the audit trail for assumptions.
- Per repo convention: this PRD must be **Signed Off → Locked** before merging code into `main`.

## 11. Expected outcomes

Concrete predictions for v1 ship and the 4-week window after.

### Engineering outcomes (target ship: 2 weeks from signoff)

| Outcome | How we verify |
|---|---|
| `b402-percolator-adapter` deployed to local validator + devnet (assuming percolator-prog is on devnet by then) | Anchor.toml + IDL committed; Railway redeploy of `paysh-demo-server` not required (separate service) |
| 30+ unit tests, 6+ integration tests, 1 e2e | CI green on `phase-12/percolator-adapter-impl` |
| Two SDK methods + two MCP tools | `@b402ai/solana` v0.1.0 bump; `@b402ai/solana-mcp` v0.0.27 |
| First open + close round trip on devnet with the user's main wallet absent from the close tx | Explorer link in PR description |
| CU envelope measured at < 1.4M for the open path | CI emits the measurement; PR shows the number |

### Product outcomes (target: post-ship + 2 weeks)

| Outcome | How we verify |
|---|---|
| First mainnet open of any size > $10 | Explorer tx + screenshot in a follow-up post |
| First mainnet close with non-zero realized PnL | Same |
| First adopter outside us — at least one third party that runs `privatePerpOpen` against the same percolator-prog instance | DMs / GitHub issues |
| Light Protocol or Solana Foundation amplification of the announcement | Retweet count / engagement |
| Coverage in at least one Solana ecosystem newsletter or thread roundup | Manual check |

### Distribution outcomes (target: signoff + 4 weeks)

| Outcome | How we verify |
|---|---|
| GitHub stars on `b402-solana` net +50 from announcement | repo Insights |
| Demo video / loom of the SDK calls + explorer trail | Tweet engagement |
| At least 5 builder DMs about how to integrate | DM count |
| One follow-on PRD: 36-A (shielded LP) drafted | docs/prds/PRD-36-A-* |

### Honest non-outcomes (things this PRD is unlikely to deliver)

- **Real anonymity-set growth**: shipping the adapter does not fix the anonymity-set problem we acknowledged in PRD-25. Same volume-bootstrap caveats apply. Single-user immediate open-then-close is graphable by amount + timing correlation. The adapter is the infrastructure; growing the set is operational.
- **Direct revenue**: this is open-source library + reference adapter. Revenue accrues if (a) a hosted SaaS layer ships later, or (b) the relayer fee policy from PRD-26 is wired and traffic flows through it.
- **Mainnet on day one**: percolator-prog needs a mainnet deployment we don't control. v1 ships against devnet with a follow-up landing on mainnet once percolator does.
- **Liquidation insurance**: shielded users get liquidated like everyone else. The privacy property is preserved (the liquidator sees `owner_pda`, not the underlying wallet) but the user's loss is real and unmitigated.

## 12. Revision history

- 2026-05-06: Initial draft.
- 2026-05-06: Signed Off — Locked. Implementation branch: `phase-12/percolator-adapter-impl`.
- 2026-05-06: §6.5 added — handler invariants discovered in slice 1 review (stale-entry re-verify, codec-accepts-but-handler-rejects arg list, `record_init` idempotency rule). §8 PRD-36-F added (compaction crank + zero-`out_spending_pub` pool guard). §9 risks expanded for stale-entry race and mapping-insert CU profile.
- 2026-05-06: Slice 1 implemented (pure-logic primitives, 29 tests). §13 added.
- 2026-05-06: Slice 2 implemented (cdylib + execute entrypoint + ix builders, 52 tests, BPF compiles).

## 13. Implementation state

Updated each session so the next session can pick up without re-reading the whole branch. Source of truth: `git log phase-12/percolator-adapter-impl`.

### Slice ledger

| Slice | Scope | Status | Commits | Tests added |
|---|---|---|---|---|
| 1 | Pure-logic primitives — payload codec, mapping table, PDA derivations | **DONE** | 77e7019, 0884d51 | 26 unit + 2 proptest |
| 1.5 | Review-driven fixes — `record_init` idempotency, PRD §6.5 amendments | **DONE** | a074784 | +3 unit |
| 2 | cdylib + `execute` entrypoint + percolator-prog ix builders + arg validators + Anchor.toml registration | **DONE** | 471024c, f823cd8 | +23 unit |
| **3a-α** | Slab data parsing — vendored SlabHeader / MarketConfig, percolator git dep, layout pinning, byte-level field reads | **DONE** | b510828 | +15 unit |
| **3a-β** | Open handler proper — per-user payload decode, CPI builders, mapping read/write, full open.rs handler with stale-entry guard | **DONE** | 2fa02d5 | +14 unit (7 payload + 7 cpi) + open handler tests |
| **3b** | Close path: full handler — slab-side position read, TradeCpi flatten, WithdrawCollateral, mapping `record_close`, USDC return flow | **DONE** | def626d | +1 unit (lp_idx range on close) |
| **3.5** | LiteSVM integration tests — load adapter only, drive `execute()` directly, assert dispatch + arg validation reach the percolator CPI step (which fails because percolator-prog isn't loaded — that exact signal is the acceptance proof). 7 cases covering happy-dispatch + 6 error paths. | **DONE** | 5f58c8b | +7 integration |
| **4-α** | SDK encoding — `packages/sdk/src/percolator.ts` with action-payload + per-user wrapper + execute-ix builders, three PDA derivations, RA-layout builder. Byte-pinned to Rust via shared `FIXTURE_*_HEX` (encoder drift on either side breaks both test suites). | **DONE** | 1449c00 | +23 SDK + 4 Rust fixture pins |
| **4-β** | SDK methods proper — `B402Solana.privatePerpOpen` / `privatePerpClose`. Wraps `privateSwap` with percolator-specific encoding, ATA derivation at `adapter_authority`, RA-layout. Caller passes pre-resolved `perUserAccts` (slab parsing comes in slice 4-γ). Tested via `vi.spyOn(privateSwap)` to assert wrapper packages args correctly. | **DONE** | (next commit) | +15 SDK |
| 4-γ | TS slab parser — read slab account on-chain, derive `slab_vault` / `lp_owner` / `oracle` / `matcher_program` / `matcher_context` / `lp_pda` from a single `slab` pubkey. Promotes the surfpool harness's slab-parsing helper into the SDK once it stabilizes. | blocked on 5 | — | — |
| **5-α** | Surfpool boot infrastructure — `start-percolator-fork.sh` loads all 6 programs at boot (b402-pool/nullifier/verifier_adapt/percolator-adapter + percolator-prog + percolator-match), `init-percolator-market.sh` scaffolds the bootstrap (init-market + matcher init + init-lp), `examples/percolator-adapter-fork.mjs` is the adapter-direct probe, `docs/percolator-fork-runbook.md` ties it together. | **DONE** | 853c598 | scaffolding only — first manual run will iterate on TODOs in init script |
| **5-β** | Adapter-direct probe GREEN against real percolator-prog + match. Six bugs found + fixed: declare_id alignment, slab MAGIC byte-order, missing init/grow_mapping ixs, SPL-transfer ordering vs InitUser, engine-pin staleness (a946e550→f6b13f57), Hyperp accrual envelope. Tx `2L6xAduAenkrpzA6sJtnDwqKGdqpH9vwd7zehM7d4jmhJ4w86kRU3JvcDstsbLAUhRbUWAwMi2XL5ztz2A3ohSsG` finalized: `[open] user_idx=1 principal=10500000 size=1000 lp=0 ok` at 254k CU. | **DONE** | (next commit) | bootstrap.ts + probe.mjs running end-to-end |
| 5-γ | Full pool→adapter→percolator e2e — `tests/v2/e2e/v2_fork_percolator.test.ts` using `B402Solana.privatePerpOpen`. Multi-user isolation + close round trip. PRD-36 §6.3 seven cases. | next | — | — |
| 6 | Devnet deployment — deploy percolator-prog ourselves if not already there; deploy adapter; smoke test | not started | — | — |
| 7 | Mainnet — coordinated with percolator-prog mainnet ship (out of our control timing) | blocked | — | — |
| 8 | Post + announcement | blocked on slice 6 | — | — |

### Test-harness model

- **Local unit + proptest**: `cargo test -p b402-percolator-adapter`. ~52 cases as of slice 2.
- **BPF build**: `cargo build-sbf --manifest-path programs/b402-percolator-adapter/Cargo.toml`. Produces `target/deploy/b402_percolator_adapter.so`.
- **Surfpool integration (slice 5+)**: forks mainnet, loads our adapter `.so`, loads percolator-prog `.so` (built locally from `~/development/ai/percolator-prog`), runs a JS/TS harness that drives the open + close round trip. Pattern lifted from `examples/kamino-adapter-fork-per-user.mjs` and `examples/mainnet-kamino-lend-demo.mjs`.
- **Devnet (slice 6)**: same harness but pointed at devnet RPC; we pre-deploy percolator-prog if it isn't there.

### Known external dependencies for the impl branch

| Dep | What we need | Status |
|---|---|---|
| `~/development/ai/percolator-prog` deployed somewhere we can hit | A live `Perco1ator…` (or rotated) program ID for the slab/ix calls | Local `target/deploy/percolator_prog.so` only — no devnet/mainnet yet. Slice 6 ships our copy if upstream still hasn't. |
| Phase-9 `outSpendingPub` public input on adapt_execute | Pool already passes a 32-byte hash to adapter via action_payload prefix (kamino confirms) | DONE on `feat/phase-9-deploy` (our base) |
| `b402-pool` adapter_registry entry for the adapter program ID | Pool needs to know about us before it can route privatePerp calls | Add in slice 4 alongside the SDK-side builders |
| Surfpool 1.0.0 binary | Local integration test runner | Installed at `/opt/homebrew/bin/surfpool` |

### Slab layout dependency note

Slice 3a requires reading percolator's `Account` table inside the slab to find the user_idx that `InitUser` assigned (no return data) and to read position state on close. Two options for the type layout:

1. **Vendor minimal struct fields** (preferred). Copy `Account.owner` offset / `Account` size / `accounts[]` base offset into a `slab_layout.rs` module. Add a runtime sanity check (slab header `MAGIC == 0x504552434f4c4154`). Pro: small footprint, no external dep. Con: must update if percolator changes `Account` layout — pin the percolator commit hash in a constant.
2. Add `percolator` as a path dep. Use `RiskEngine` types directly. Pro: type-safe. Con: pulls 7,500 LOC into our adapter binary; brittle path requires a known checkout layout.

Going with (1) for slice 3a. The vendored layout block lives at the top of `src/slab_layout.rs` with explicit version pin (`PERCOLATOR_LAYOUT_PINNED_AT = "v12.19.13"`) and a CI test that re-derives the offsets and asserts they match the constants.

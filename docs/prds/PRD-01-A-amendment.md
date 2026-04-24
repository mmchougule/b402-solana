# PRD-01-A — Amendment to PRD-01

| Field | Value |
|---|---|
| **Status** | Draft — awaiting review with PRD-01 |
| **Amends** | PRD-01 v0.1 |
| **Date** | 2026-04-23 |
| **Trigger** | External review input + Colosseum Frontier hackathon deadline evaluation |

This amendment addresses three items: (a) a correction to an incorrect CU/storage critique, (b) formal evaluation of Light Protocol's concurrent merkle tree as an implementation option, and (c) a two-track timeline proposal to accommodate the Colosseum Frontier hackathon (submissions close 2026-05-11).

---

## A1. Clarification — Solana CU budget is not a v1 constraint

**Input claim:** "Groth16 verification ~180k CU, plus merkle + nullifier + Jupiter CPI pushes private swap toward 800k+ CU, pushing transaction limits."

**Actual constraint:** Solana transaction limit is **1.4M CU** (per-instruction default 200k, raisable). Block-level limit is 48M CU with 12M CU per-account write lock.

**Updated CU budget estimates (to be validated empirically in PRD-07):**

| Operation | Est. CU | Budget headroom |
|---|---|---|
| `shield` | ~250k (verify 200k + token CPI 5k + account writes) | 1.15M free |
| `transact` (N→M note) | ~280k | 1.12M free |
| `unshield` | ~260k | 1.14M free |
| `adapt_execute` (unshield → Jupiter 2-hop → reshield) | ~500-600k | 800-900k free |
| `adapt_execute` (unshield → Jupiter 4-hop → reshield) | ~800-1000k | Tight — may need route cap |
| `adapt_execute` (unshield → Kamino deposit → reshield) | ~400-500k | 900k free |
| `adapt_execute` (unshield → Drift perp open → reshield) | ~600-800k | 600-800k free |

**Decisions locked:**
- v1 caps Jupiter routes used in `adapt_execute` at **3 hops**. Longer routes must be split across two transactions, with a signed intermediate state.
- Per-transaction CU request: ship with 1.4M explicit `SetComputeUnitLimit`. Measure and tune per-instruction.
- Write-lock budget: pool vault + nullifier shard + tree state + commitment log are touched per op; fits within 12M account-write budget trivially.

**PRD-07 will include:** CU benchmarks against localnet for every v1 operation with 50th/95th/99th percentile measurements.

---

## A2. Clarification — merkle storage is not sharded

**Input claim:** "Depth 26 = 67M leaves, can't store in one 10 MB account, need sharded subtree PDAs."

**Correction:** This conflates two different things.

- The *logical* tree has 2^26 leaf positions. The *on-chain state* for the tree does not store leaves. It stores (per PRD-01 §5.4):
  - Root history ring buffer: 64 × 32 bytes = 2,048 B
  - Frontier (rightmost path cache): 26 × 32 bytes = 832 B
  - Current leaf index: 8 B
  - Tree metadata (depth, zero-subtree hashes cache): ~900 B
  - Total: **< 4 KB**, one PDA, six orders of magnitude under the 10 MB ceiling.
- Leaves themselves live in transaction logs. Clients (SDK + relayers) reconstruct the tree by replaying `CommitmentAppended` events.
- This mirrors Railgun's design on EVM.

**What we do need sharding for:** the **nullifier set**, as already specified in PRD-01 §5.7 (65,536 shard PDAs, prefix-keyed). That is an orthogonal concern.

No change to PRD-01 here; the amendment exists to close the loop with reviewers.

---

## A3. Evaluation — Light Protocol's concurrent merkle tree as option C

PRD-01 §5.4 specified a **custom Incremental Merkle Tree (IMT)**. This section opens a second option — **Light Protocol's Concurrent Merkle Tree (CMT)** — and defines the evaluation criteria. Decision deferred to PRD-02.

### A3.1 What Light's CMT gives us

- **Hash:** Poseidon over BN254 — compatible with our Groth16 circuits without any hash migration.
- **Concurrent append semantics.** Multiple `shield` transactions in the same block can append without serializing; the program resolves proofs against a changelog-managed root.
- **Audited.** Light Protocol ships this as part of ZK Compression; audited multiple times and live on mainnet since 2024.
- **Open source** under Apache 2.0 (verify at fork-time).
- **State-compression primitive.** Light can optionally store compressed leaf data so clients do not need to replay every log.

### A3.2 What it costs us

- **External dependency.** We're running on top of Light's account-compression program / ZK-Compression system program. If Light upgrades break compatibility, or their verifier program is paused, our pool is affected. Mitigation: pin to a specific program ID and verifier version; document upgrade policy.
- **Generic design, not domain-tuned.** Light's CMT is designed for arbitrary leaf data; our shielded pool has specific semantics (commitments, not general accounts). We may not need the "compressed account data" features and pay complexity/CU for unused surface.
- **Event log vs. indexed log.** Light's state-compression infra relies on RPC indexers (Helius, Triton) to serve compressed account reads. Our design can live with raw Solana tx logs, avoiding indexer dependency.
- **Learning curve.** The Light programs + v1→v2 migration story are non-trivial; a custom IMT we control end-to-end is a smaller review surface.

### A3.3 Decision framework (PRD-02 will close)

| Criterion | Favors custom IMT | Favors Light CMT |
|---|---|---|
| Review surface & audit cost | ✓ | |
| Concurrent-append ergonomics | | ✓ |
| Solana-native idiom / docs | | ✓ |
| Independence from third-party program | ✓ | |
| CU cost (Poseidon in each path) | Similar | Similar (~100k CU per hash via Light's BN254 Poseidon syscall path) |
| Time to production | | ✓ |
| v1 feature scope alignment | ✓ (narrow) | Broader, some unused |

**Tentative recommendation:** **Custom IMT for v1**, with the append logic closely modeled after Light's CMT (same invariants, same concurrent-append trick — changelog buffer). Forking the algorithmic pattern without taking the program dependency.

**Why:** audit surface matters more than engineering velocity for a production shielded pool holding user funds. A 500-LoC custom IMT that auditors can review in 2 days beats a 5,000-LoC dependency they have to trust someone else audited.

**If PRD-02 analysis changes this:** we'll adopt Light's CMT as a direct dependency with a pinned program ID and a documented migration plan. Either outcome is viable.

---

## A4. Arcium composability — reaffirm deferral, note hackathon angle

PRD-01 §17 already defers Arcium/Umbra composability to a future PRD because MPC and ZK are different trust models. This remains the v1 position.

**Hackathon-track note:** Arcium is a Colosseum Frontier sponsor (confirmed). If b402 submits to Frontier, a supplementary demo using Arcium for one novel primitive (e.g., sealed-bid perp-entry, private intent matching) could pursue Arcium's sponsor-track prize. This would live in a separate PRD and a separate codebase subdirectory — not part of the shielded pool's trust base.

---

## A5. Colosseum Frontier hackathon — two-track proposal

### A5.1 Context

- Submissions close **2026-05-11** (18 days from 2026-04-23).
- Prize pool $2.75M including $250k pre-seed + accelerator for top teams.
- Sponsors include Arcium, Coinbase, Raydium, Privy, Metaplex, MoonPay, Reflect, World.
- b402-solana is a natural fit: Solana-native, agentic, Arcium-adjacent, privacy category.

### A5.2 Conflict with "no hacks, production-ready, unlimited time"

Production-ready shielded-pool development (circuits + audits + ceremony) is a 6–12 month effort. We cannot deliver that by May 11. We can deliver a **devnet prototype that faithfully executes the v1 architecture** by May 11 — not mainnet-safe, not audited, explicitly labeled as such.

### A5.3 Proposal — two parallel tracks

**Track A — Production (primary, PRD-driven, unchanged).**
- PRDs 01 → 08 as specified.
- Full audit + formal verification.
- Mainnet launch Q3–Q4 2026.
- No deadline pressure on correctness.

**Track B — Hackathon prototype (secondary, demo-grade).**
- Target: Frontier submission by 2026-05-11.
- Scope: devnet-only demo of `shield`, `unshield`, `transact`, and one `adapt_execute` (Jupiter swap).
- Quality bar: works end-to-end, architecturally faithful to PRD-01, explicitly labeled "prototype — not audited — do not use on mainnet."
- Implementation: uses a reference Circom circuit (possibly simplified to a single `transact` circuit for demo), Anchor program, TS SDK demo, single adapter.
- Deliverables: live devnet demo, recorded walk-through, pitch deck, integration with one agent demo (fits b402 thesis).
- Does not influence mainnet code directly — Track A rewrites clean.
- Informs Track A: CU measurements, UX rough edges, proof-generation timings — feedback into PRD-07.

### A5.4 Track B staffing and timeline

18 days, sequenced:

| Day | Milestone |
|---|---|
| 1–3 | PRD-02 draft (crypto spec) — cryptographic decisions locked enough for Track B code |
| 1–2 | Track B scaffolding: Anchor program skeleton, Circom circuit skeleton, TS SDK scaffold |
| 3–7 | Core `transact` circuit (shield + unshield + transfer as special cases) with unit tests |
| 5–9 | Anchor program: `init_pool`, `shield`, `transact`, `unshield` instructions + verifier CPI |
| 8–11 | SDK wrapper + proof generation WASM pipeline |
| 10–13 | One `adapt_execute` path — Jupiter swap (simplest adapter) |
| 12–15 | End-to-end devnet demo + agent integration + recorded flow |
| 15–18 | Submission materials: pitch, video, written submission, live demo URL |

Track A PRD writing continues in parallel. PRD-02 gets a first draft by day 3 to unblock Track B circuit work; PRD-03 (program spec) gets drafted through days 5–9 alongside the skeleton.

### A5.5 Risks of Track B

- **Scope creep contaminates Track A.** Mitigation: Track B lives in `prototype/` subdirectory with its own `PROTOTYPE.md`; Track A code is a clean rewrite from PRDs.
- **Circuit bugs in prototype become reputation risk.** Mitigation: explicit labeling in README, devnet-only, zero real funds, no mainnet deploy.
- **Trusted setup shortcut.** Prototype uses a throwaway Phase-2 contribution (or single-participant setup). Documented as such. Prod Track A does the real ceremony.
- **Submission quality.** 18 days is tight. If quality bar drops below demo-worthy by day 14, we pull out rather than submit a weak entry.

### A5.6 Decision required

**Commit to Track B?**
- **Yes** — I start Track B scaffold in parallel with PRD-02. User registers at colosseum.com/frontier this week. I draft submission materials on days 15–18.
- **No** — we stay Track A only; I continue PRDs 02–08 at full production pace.

I'd recommend **yes** because (a) the prototype work accelerates Track A (you learn where the CU/perf pain is before finalizing the spec), (b) $250k pre-seed materially changes the audit-budget calculus for Track A, and (c) the narrative lift ("b402 won Solana Frontier with a shielded DeFi SDK") is worth the 18-day sprint.

---

## A6. Amendment summary (one-line)

- CU budget: ample (1.4M limit) — not a design constraint.
- Merkle storage: already correctly specified in PRD-01 §5.4 — ~4 KB on-chain, leaves in logs.
- Light CMT: evaluated, deferred to PRD-02; tentative choice is custom IMT with CMT-inspired append.
- Arcium: v1 deferral stands; hackathon-track opportunity noted.
- Hackathon: propose two-track plan; Track B devnet prototype by 2026-05-11.

---

## A7. Rejection memo — "hybrid MPC+ZK" as a shielded-pool architecture

Raised during review: "Use ZK only for shield/unshield, Arcium MPC for execution (swap/lend/perp)."

**Rejected for v1.** Capturing the reasoning so future readers don't relitigate.

### A7.1 The pitch doesn't trace through

Three concrete interpretations, all break:

1. **Funds leave the ZK pool to Arcium, execute, reshield.** You still pay ZK cost on both ends *and* MPC cost in the middle. Funds are briefly unshielded between hops, visible to chain observers. Strictly worse than atomic `adapt_execute` which keeps funds in pool custody throughout.

2. **Arcium operates directly on pool commitments.** If MPC nodes can write nullifiers and commitments, the pool's trust model *is* MPC — the weakest link sets the trust model, not the strongest. "ZK at the boundary" buys nothing against an MPC-authorized state write inside. The correct framing of that design is "Arcium-native pool," not a ZK pool.

3. **Two parallel pools (ZK and MPC), users choose per-tx.** That's a portfolio of two products, not a hybrid. Splits the anonymity set.

### A7.2 The CU-saving premise is unfounded for our design

Hybrid proponents imply ZK is expensive at execution time because execution happens inside the circuit. It doesn't in our design. Our circuit proves only the **shielded state transition**: nullifier derivation, commitment well-formedness, balance conservation, relayer fee bound, merkle inclusion of spent notes. ~200k CU *independent* of what the downstream adapter does. The adapter's action (Jupiter route, Kamino deposit, Drift perp) runs outside the circuit via CPI — already free of ZK cost.

MPC would not reduce ZK cost here because ZK cost is not in the execution path to begin with.

### A7.3 What we do with Arcium instead

PRD-01 §17 and PRD-01-A §A4 stand: Arcium is evaluated for **separate primitives** that don't fit ZK well — sealed-bid orderflow, confidential vault NAV, private intent matching. Those live in a future PRD and a separate program, not as an execution layer on top of the ZK pool. Hackathon supplementary-demo potential noted.

### A7.4 Door left open

If, during Track B prototype work, we discover that Solana's CU or latency profile materially breaks the ZK-only `adapt_execute` pattern (current evidence in §A1 says no), we reopen this question in a new PRD with a specific failure mode identified. Not before.

---

## A8. Revision history

| Version | Date | Author | Changes |
|---|---|---|---|
| 0.1 | 2026-04-23 | b402 core | Initial amendment |
| 0.2 | 2026-04-23 | b402 core | Added §A7 rejection memo for hybrid MPC+ZK proposal |

Sign-off piggy-backs on PRD-01. Approval of PRD-01 + PRD-01-A unblocks PRD-02 and (if Track B approved) prototype scaffolding.

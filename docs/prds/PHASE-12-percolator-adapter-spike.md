# PHASE-12 Spike — Percolator perp adapter

**Status:** Spike notes (pre-PRD).
**Date:** 2026-05-06.
**Branch:** `phase-12/percolator-adapter-design` (off `feat/phase-9-deploy`).
**Goal:** before drafting PRD-36, establish the architecture of the percolator perp DEX, the b402 integration shape, the CPI depth budget, and the divergences from PRD-33's per-user adapter state pattern (the Kamino template).

Files referenced live outside this repo at `~/development/ai/percolator*` — line citations below are against those repos at the commits in place during this spike.

---

## 1. Percolator deployment topology

Three sibling repos compose the perp DEX:

| Repo | Role | Notes |
|---|---|---|
| `~/development/ai/percolator/` | Pure no_std risk-engine library (~7,500 LOC) | Embedded into the deployed program. Formally verified (kani + proptest + fuzz). No on-chain footprint of its own. |
| `~/development/ai/percolator-prog/` | Single-file deployed Solana program (~9,000 LOC, raw `solana-program 1.18`, no Anchor) | Owns the slab account. Embeds the engine. Exposes the ix surface below. Program ID placeholder `Perco1ator111111111111111111111111111111111`. |
| `~/development/ai/percolator-match/` | Separate matcher program | Two implementations: `passive_lp_matcher.rs` and `vamm.rs`. CPI'd by `percolator-prog`'s `TradeCpi`. |

## 2. Instruction surface

`percolator-prog/src/percolator.rs:1597` — full `Instruction` enum:

```
0  InitMarket(admin, …)              // create a slab
1  InitUser { fee_payment }          // claim a User slot
2  InitLP   { matcher_program, matcher_context, fee_payment }
3  DepositCollateral  { user_idx, amount }
4  WithdrawCollateral { user_idx, amount }
5  KeeperCrank        { caller_idx, candidates }      // liquidations / fee sweeps
6  TradeNoCpi { lp_idx, user_idx, size }              // atomic price-taker
7  CloseAccount       { user_idx }
8  TopUpInsurance     { amount }
9  TradeCpi   { lp_idx, user_idx, size, limit_price_e6 }
10 CloseSlab          // admin
11 UpdateConfig       // admin
12 PushHyperpMark     // oracle authority
13 Resolve            // admin terminal
…  ForceCloseResolved, UpdateAuthority, etc.
```

Dispatch: `process_instruction` at `percolator-prog/src/percolator.rs:4766`; per-ix arms inline in the match (no Anchor).

## 3. Account model — the divergence from Kamino

The Kamino template (PRD-33) keys per-user state on a **PDA address** at the protocol level (the `Obligation` PDA, derived from the user's pubkey + lending market). Percolator does not.

### 3.1 Percolator's identity model

A user is identified by a **u16 slab-slot index** (`user_idx`) into a fixed-size table inside the slab account. Slot ownership is recorded inline: `account.owner` is the signer pubkey passed at `InitUser` time. Subsequent ixs (`DepositCollateral`, `TradeCpi`, etc.) take `user_idx` as an argument and verify the signer matches the stored owner.

Concretely, `InitUser` at `percolator-prog/src/percolator.rs:5275` requires a 6-account layout:

```
[0] user        (signer)
[1] slab        (writable)
[2] user_ata    (user's USDC ATA)
[3] vault       (slab's USDC vault PDA)
[4] token_program
[5] clock_sysvar
```

The `user` signer is whoever's claiming the slot. Percolator records `slab.accounts[chosen_idx].owner = user.key`. From that point on, only that pubkey can write to that slot.

`DepositCollateral` (line 5541) and `WithdrawCollateral` (line 5659) reuse the same 6-account layout with `user_idx` as an arg.

### 3.2 Implication for the b402 adapter

For an adapter to call these ixs on behalf of a shielded b402 user, the adapter `invoke_signed`s with `owner_pda = PDA(["b402/v1", "perp-owner", viewing_pub_hash], adapter_program_id)` as the user signer.

But percolator stores `owner_pda` as the slab slot's owner — the slot index is assigned at `InitUser` time and **the adapter must remember it**. Percolator does not expose a "find my slot" lookup keyed on owner pubkey.

Therefore the adapter needs **a side-table account**: `viewing_pub_hash → user_idx`. Owned by the adapter program. Written once at first `InitUser` per user; read on every subsequent `DepositCollateral` / `TradeCpi` / `WithdrawCollateral`.

This is the only architectural piece PRD-33 (Kamino) does not have. With Kamino, the per-user account is itself a PDA at the deterministic address — no side table needed.

### 3.3 Side-table layout (sketch — to be locked in PRD-36)

```rust
// PDA: ["b402/v1", "perp-mapping", slab.key], owned by adapter program
struct PerpMapping {
    bump: u8,
    slab: Pubkey,                  // pinned to one market
    entries: [(Hash32, u16); MAX], // viewing_pub_hash → user_idx, sorted for binary search
    next_free: u16,
}
```

Open: fixed-size table vs. on-demand allocator. Fixed-size up to `MAX_ACCOUNTS` (4096 default in percolator's `medium` feature) is simplest and matches the slab's own cap.

## 4. TradeCpi — the matcher CPI hop

`percolator-prog/src/percolator.rs:6610`. Account layout (8+):

```
[0] user (signer)
[1] lp_owner (non-signer; LP delegated trade auth to matcher)
[2] slab (writable)
[3] clock
[4] oracle
[5] matcher_program
[6] matcher_context (writable)
[7] lp_pda                ← PDA(["lp", slab, lp_idx], percolator_program_id)
[8..] variadic tail forwarded verbatim to matcher CPI
```

Percolator `invoke_signed`s with `lp_pda` as the matcher's signer. The LP's matcher delegation is the security boundary: an LP that calls `InitLP { matcher_program, matcher_context }` is binding their slot to a specific matcher program. The `lp_pda` ownership lives entirely inside percolator-prog; the adapter does not derive or sign for it.

So for the b402 user-side path (`privatePerp` → `TradeCpi`), the adapter signs as `user` (`owner_pda`) and passes the LP's existing `lp_pda` straight through. The matcher itself does not need to know b402 exists.

### 4.1 CPI depth budget

```
tx → b402-pool::adapt_execute              (level 1)
   → b402-percolator-adapter::execute      (level 2)
      → percolator-prog::TradeCpi           (level 3)
         → matcher_program::on_trade        (level 4)
```

Solana's `MAX_INVOKE_STACK_HEIGHT` is 5 (sBPF v3+). We sit comfortably at 4. No CPI-depth blocker.

### 4.2 CU budget

`adapt_execute` already burns ~600k CU on the Groth16 verify + nullifier check (Phase-9 baseline). `TradeCpi` itself is quoted at ≤ 200k CU in percolator's docs. Matcher CPI varies. Conservative envelope: 1.0M CU per request, with 1.4M as the request_compute_unit_limit. Headroom exists; needs measurement during PRD-36 §6 testing.

## 5. Mapping the b402 adapter pattern

### 5.1 The Kamino template (PRD-33, on `feat/phase-9-deploy`)

`programs/b402-kamino-adapter/src/lib.rs:130` documents the path-A architecture:
- `owner_pda` = `PDA(["b402/v1", "kamino-owner", viewing_pub_hash], adapter_program_id)` (line 27-28).
- `adapter_authority` signs vault transfers; `owner_pda` signs Kamino-side ixs (line 31-32).
- `viewing_pub_hash` is the post-Phase-9 `outSpendingPub[0]` public input (PRD-33 §3.1).

The kamino adapter v0.1 ships path 2 (shared obligation, no privacy) and amends PRD-09 §7.2 inline (line 35-46). The per-user path is the planned upgrade.

### 5.2 Percolator adapter — what we inherit, what's new

| From PRD-33 / Kamino | New for percolator |
|---|---|
| `owner_pda` derivation from `viewing_pub_hash` | Side-table account `viewing_pub_hash → user_idx` |
| Dual-seed `invoke_signed` (auth + owner) | Same |
| Pool-side `out_spending_pub` forwarded to adapter (PRD-33 §3.4) | Same — already wired |
| Shielded-side ABI: `execute(in_amount, min_out, action_payload)` | Same — `KaminoAction`-style enum becomes `PercolatorAction` |
| Per-user obligation state | Per-user slab-slot ownership (smaller rent footprint, but adds the mapping table) |
| ATA layout for liquidity flow | Same — `adapter_in_ta` / `adapter_out_ta` move through `owner_pda`'s percolator USDC ATA |

### 5.3 Action payload shape (sketch)

```rust
pub enum PercolatorAction {
    InitAndDeposit { fee_payment: u64 },          // first call: claim slot, deposit
    Deposit        { amount: u64 },                // subsequent deposits to existing slot
    Trade          { lp_idx: u16, size_e6: i128, limit_price_e6: u64 },
    WithdrawAll,                                   // close out and exit
}
```

`amount` is bound by the proof (= `in_amount` from the pool). `lp_idx`, `size_e6`, `limit_price_e6` are public-input adapter args (visible on chain — same exposure as Drift order books).

## 6. Tractability — Option A vs Option B

The user's three options from the prompt:

- **A. Shielded LP** — `privateLP` routes to `InitLP` + `DepositCollateral`. LP earns matcher fees in a slab slot owned (PDA-signed) by `owner_pda`.
- **B. Shielded user / private positions** — `privateTrade` routes to `InitUser` + `DepositCollateral` + `TradeCpi`. The matcher CPI rides through.
- **C. Shielded matcher** — out of scope (would require rethinking percolator's matcher ABI).

A and B share ~80% of the adapter:
- Same `owner_pda` derivation.
- Same side-table mapping (`viewing_pub_hash → slab slot`).
- Same vault-flow plumbing.
- Same pool-side wire format.

The differences are in the action handlers (which ix is called) and the LP-side `matcher_program` / `matcher_context` plumbing for option A.

### 6.1 Recommended order

**B first.** Reasons:

1. **Marketing coherence.** "Private perp positions on Solana" is the cleaner external-facing story.
2. **Forces the harder integration on slice 1.** B exercises the matcher CPI hop end-to-end (depth 4, CU envelope), while A only goes to `DepositCollateral` (depth 3). If B fits the budget, A definitely does. Discovering the budget is tight in slice 2 (after A ships) is more expensive than discovering it in slice 1.
3. **A becomes a config delta after B.** The mapping table, owner_pda derivation, and ATA flow are all reused. A's marginal scope is just two new `PercolatorAction` variants (`InitLP` and an LP withdraw) and a separate variant of the user/LP slot allocation.

## 7. Open questions for PRD-36

1. **Mapping table allocator.** Fixed-size sorted array vs. on-chain B-tree vs. per-slot PDAs. Fixed-size sorted is simplest; cap at `percolator::MAX_ACCOUNTS`.
2. **Slot reclaim on liquidation.** When percolator's `KeeperCrank` liquidates a slot another caller holds, the mapping table now points to a stale `user_idx`. Need a reclaim path (likely: detect at `DepositCollateral` time, allocate a fresh slot, update the table).
3. **Per-market vs shared mapping table.** One table per slab keeps things scoped; one global table per adapter program is simpler but cross-contaminates markets. Probably one-per-slab.
4. **Adapter as a separate program or merged with `b402-jupiter-perps-adapter`.** The Jupiter perps adapter exists at `programs/b402-jupiter-perps-adapter`. If percolator is "another perps protocol", merging the two adapters into one with action enum variants is plausible. Probably separate — Jupiter and percolator have very different account models.
5. **`limit_price_e6` for trades — is its public-input exposure acceptable?** Same shape as Drift's order book exposure; agents that care wrap with their own intent layer. Document and move on.
6. **Liquidation-as-permissionless.** `KeeperCrank` is permissionless — anyone can liquidate any user's slot if it's underwater. b402 users get liquidated by external bots. The user receives a partial-loss `WithdrawCollateral` outcome; the adapter needs to surface this gracefully (the b402 side will have already sent the principal in, so the user's net delta must reconcile with what comes back).
7. **Slot allocation cost at `InitUser`.** Each new user pays `fee_payment` (routed to insurance) + the adapter's per-user side-table entry. Costs in PRD-36 §5.

## 8. Recommended PRD scope

`PRD-36-percolator-perp-adapter.md`. Minimum viable cut:

- Option B only (shielded user, `privateTrade`). Option A as a §8 follow-up.
- Single-market support (one slab, one mapping table). Multi-market expansion in a §8 follow-up.
- `Trade` action only at first; `InitAndDeposit` and `WithdrawAll` round out the v1 surface. No partial deposits/withdrawals in v1 — match the Kamino-adapter v0.1 cut.
- Tests: unit (mapping table allocation), integration (against a local fork running percolator-prog deployed), e2e (against a deployed percolator instance once one exists on devnet).

## 9. Numbering

- Spike: `docs/prds/PHASE-12-percolator-adapter-spike.md` (this file).
- PRD: `docs/prds/PRD-36-percolator-perp-adapter.md` (drafts after this spike is reviewed).
- Branch: `phase-12/percolator-adapter-design` for design; implementation lands on a separate branch off the same base after PRD-36 is signed off.

---

## Appendix A — what's already in place on `feat/phase-9-deploy` we'd build on

- `programs/b402-kamino-adapter/src/lib.rs` — the per-user adapter pattern in production form (path-A planned, path-2 shipped).
- `programs/b402-pool/src/instructions/adapt_execute.rs` — passes `out_spending_pub` to adapters per PRD-33 §3.4.
- Phase-9 prover artifacts (committed): `circuits/build/adapt_js/adapt.wasm` + `circuits/build/ceremony/adapt_final.zkey`. The proof binds `outSpendingPub[0]` as a public input.
- `packages/sdk/src/__tests__/kamino.test.ts` — pattern for per-user adapter SDK tests.

## Appendix B — what is NOT yet decided in this spike

- Whether percolator-prog is deployed anywhere yet. Program ID `Perco1ator111111111111111111111111111111111` is a placeholder. Until percolator-prog ships to devnet/mainnet, this PRD targets a local validator with the program loaded from `~/development/ai/percolator-prog/target/deploy/`.
- The matcher-program / matcher-context the LP slot will bind to. For option B (shielded user) the adapter doesn't pick this — whatever LP exists in the slab is fine. For option A (shielded LP), the LP's matcher choice is part of the action payload.
- Whether `b402-percolator-adapter` lives in this monorepo or as a sibling crate. Probably this monorepo at `programs/b402-percolator-adapter/`, mirroring the kamino layout.

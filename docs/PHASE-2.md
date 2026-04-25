# Phase 2 — adapt circuit

## Status: 2a shipped (2026-04-25)

Real ZK-bound `adapt_execute` is live on devnet. Cross-mint attack closed
via circuit constraints. The previous `adapt_execute_devnet` stub has been
replaced; no feature flag, no runtime cfg gate. Three sigs proving the
full path (shield → real Groth16 adapt proof → unshield) on devnet are in
the README.

What changed:

- `circuits/adapt.circom` — extends transact with `adapter_id`,
  `action_hash`, `expected_out_value`, `expected_out_mint` (4 added
  public inputs, 23 total). Constraints: `outTokenMint === expectedOutMint`,
  `actionHash === Poseidon_3(adaptBindTag, keccak(action_payload), expectedOutMint)`,
  `inSum === publicAmountIn + relayerFee`, `outSum === expectedOutValue`.
- `b402_verifier_adapt` (program ID `3Y2tyhNS…`) — Groth16 verifier with the
  baked-in adapt VK from a throwaway ceremony.
- `programs/b402-pool/src/instructions/adapt_execute.rs` — full handler:
  parses 23 public inputs, binds adapter program / action hash / mints to
  pool state, verifies proof via verifier_adapt CPI, burns input nullifiers,
  pool-signed transfer to adapter, post-CPI delta invariant, appends output
  commitments, optional relayer fee transfer.
- `packages/prover/src/adapt.ts` — `AdaptProver` mirroring `TransactProver`.

What 2a still does NOT ship: the production-grade trusted setup. The
current adapt VK is from a single-contributor throwaway ceremony — same
class as the transact VK on devnet. Mainnet needs the multi-party
ceremony described below.

---

## What was in 2a (now done)

This is the "same cadence as Phase 1" milestone. Goal: replace
`adapt_execute_devnet` with a real ZK-bound `adapt_execute` handler,
ship on devnet + mainnet-fork with a throwaway ceremony, prove the
cross-mint attack is closed. Not audit-ready; no mainnet deploy yet.

Actual work items with real hour estimates:

| Item | Effort |
|---|---|
| `circuits/adapt.circom` — extends transact with 4 public inputs (`adapter_id`, `action_hash`, `expected_out_value`, `expected_out_mint`) + 2 binding constraints (output commitment mint = expected_out_mint; action_hash recomputed in-circuit) | **1-2 h** (it's transact.circom + two `<==` lines) |
| Circuit tests (mint-binding rejection, action-hash tamper rejection) | **~1 h** (mirror `transact.test.ts` patterns) |
| Throwaway ceremony run (`scripts/throwaway-ceremony.sh` variant for adapt) | **~10 min** (same pipeline as transact) |
| `b402_verifier_adapt` program — clone of `b402_verifier_transact` with new VK baked via `vk-to-rust.mjs` | **30 min** |
| Real `adapt_execute` handler — replaces `adapt_execute_devnet`. Adds: verifier CPI, parse 22 public inputs, bind `adapter_id` / `expected_out_mint` / `action_hash` to pool state, burn input nullifiers | **2-3 h** (all primitives already exist in shield/unshield/transact) |
| SDK `privateSwap` — currently builds the ix directly; needs to call the prover for an adapt proof and include it in the ix data | **1-2 h** |
| Wire `swap-e2e-jupiter.ts` onto the new path + re-run mainnet-fork e2e | **30 min** |
| Delete `adapt_execute_devnet` + feature flag + runtime cfg gate | **15 min** |

**Total: ~7-10 focused hours.** One day if uninterrupted, two if split across sessions.

Deliverable at the end: the real `adapt_execute` running against real
Jupiter on mainnet-fork, cross-mint attack closed, output commitment
cryptographically bound to the actual swap output mint.

## Milestone 2b — audit-ready mainnet (~ 2-3 weeks, mostly not engineering)

This is the "not laughed off by Anza" milestone. The critical path is
not code — it's ceremony coordination and audit scheduling.

| Item | Effort / driver |
|---|---|
| 3+ contributor ceremony for adapt circuit (per PRD-08 §2) | 1-2 weeks, dominated by contributor availability |
| Same ceremony redo for transact circuit (currently throwaway) | runs alongside adapt ceremony |
| Veridise audit — circuit + verifier programs | 3-4 weeks engagement once scheduled |
| Accretion audit — pool + adapter programs | 3-4 weeks engagement |
| Zellic independent second opinion on pool | 2-3 weeks |
| Audit remediation + regression | 1 week post-findings |
| Deploy authority rotation to Squads multisig or HSM | 1 day engineering, gated on operational readiness |
| Mainnet deploy (capped beta → uncapped per PRD-08 §3) | 1 day once everything above is done |

Engineering inside 2b is maybe 1-2 weeks of focused time. The 2-3 month
real-world timeline is ceremony + audit calendar, which runs in parallel
with other work — not blocking.

**Milestone 2a does not gate Milestone 2b.** The audit engagements can
start against the 2a code; ceremony for production can run in parallel.

---

## What's in scope for 2a vs 2b

**2a ships:**
- Correct cryptographic binding on the adapt path
- Real Jupiter private swap with ZK proofs on mainnet-fork (no real money)
- Devnet campaigns with agent/partner integrations using the real path

**2a does NOT ship:**
- A production-grade VK (throwaway ceremony, same class as current
  transact VK on devnet)
- Auditor sign-off
- Mainnet deploy

**2b ships:**
- Production-grade ceremonies for both transact + adapt circuits
- External audit sign-off
- Mainnet deploy under capped beta

The difference between 2a and 2b is trust assumptions, not code
correctness. 2a's code is the same code 2b deploys — just with a
different VK and more eyes.

---

## What can land alongside 2a on the same day without blocking it

All non-adapt-path work. Pick any, parallel track:
- Relayer HTTP + Jito bundle service for shield/unshield (matches our
  EVM relayer pattern)
- Stealth-address bech32 encoding + SDK `sendToAddress(addr)`
- Scanner persistence layer (IndexedDB / SQLite for `NoteStore` state
  across sessions)
- Kamino / Drift / Orca adapter programs (same `execute` ABI as Jupiter,
  each ~200-300 LoC)

These are independent. 2a is the critical-path unlock for private DeFi
composability; everything else is breadth.

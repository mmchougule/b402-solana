# Phase 2 — what closes the real `adapt_execute`

The current `adapt_execute_devnet` handler exists to validate pool + SDK +
ALT plumbing against a real adapter CPI. It is **feature-gated** behind
`--features adapt-devnet` and explicitly claims **no security property**.
A default build (which is what a mainnet deploy would produce) rejects the
instruction at the runtime `cfg!` gate.

This doc explains what Phase 2 adds, why it's required, and what the
actual work looks like.

---

## The concrete hole in `adapt_execute_devnet`

The handler does:

1. Registry check — adapter program ID + instruction discriminator must
   be allowlisted.
2. Pool-signed transfer of `in_amount` from `in_vault` → `adapter_in_ta`.
3. CPI the adapter with caller-supplied raw instruction data.
4. Post-CPI invariant: `out_vault.amount` delta ≥ `min_out_amount`.
5. Append caller-supplied `output_commitment` (32 bytes) to the tree.

Step 5 is the hole. The caller hands the pool an opaque 32-byte
commitment. The pool doesn't verify that the commitment is
`Poseidon(expected_out_mint, actual_delta, random, caller_spendingPub)`
— it just appends the bytes.

### Example attack (requires the feature flag to be on)

- Alice: shields 50 USDC. USDC vault balance: 50.
- Carol: shields 100 USDC. USDC vault balance: 150.
- Alice calls `adapt_execute_devnet` with `in_mint=USDC`, `out_mint=wSOL`,
  `in_amount=10`. Adapter delivers 0.01 wSOL. Delta check passes.
- Alice's output commitment field is her choice. She constructs
  `Poseidon(USDC_mint, 1000, random, alice_spendingPub)` — a 1,000-USDC
  commitment, not the wSOL commitment the swap actually produced.
- Pool appends it. USDC vault now holds 140 (10 went through the adapter).
- Later, Alice unshields the note with a real Groth16 proof claiming
  `mint=USDC, value=1000, owner=alice`. The proof verifies (the commitment
  IS in the tree) and the pool pays out from the USDC vault — draining up
  to its current balance.

Alice burned 10 USDC to extract 140 USDC (her 50 + Carol's 100 − 10
sent through adapter). Net +80 USDC stolen from Carol.

### Why this doesn't reach mainnet today

1. The handler is only compiled when `--features adapt-devnet` is passed
   to `cargo build-sbf`. Mainnet builds omit the feature.
2. Even if the feature were compiled in, the runtime `cfg!` check in
   `lib.rs` is a second gate.
3. The one chain where the feature is on (b402's own devnet) uses
   ephemeral test mints — each `pnpm e2e` run creates a fresh mint, so
   there's no persistent Carol-equivalent balance to drain.

The feature flag is the primary defense; the test-mint convention is a
secondary safety net.

---

## Milestone 2a — working adapt circuit (≈ 1 focused day)

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

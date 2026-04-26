# PRD-14 — Two-Phase Async with Claim Notes

| Field | Value |
|---|---|
| **Status** | Deferred — awaiting first async adapter |
| **Owner** | b402 core |
| **Date** | 2026-04-26 |
| **Version** | 0.1 |
| **Depends on** | PRD-11, PRD-12, PRD-13 |
| **Gates** | Jupiter Perps, Drift post-reboot async order types, oracle-pending Pyth flows |

> **Deferral note (2026-04-26).** Adrena (PRD-16, the first v2-native adapter) is fully synchronous. We do not need claim notes to ship v2. This PRD is specified now so the v1/v2 architecture does not preclude it, but no implementation work is scheduled until a real async adapter (Jupiter Perps, post-reboot Drift, Phoenix limit orders) is the next integration target. The circuits, registry fields, and state machine below are the *intended shape* — open to revision when an actual async target arrives.

---

## 1. Goal

Subsume any DeFi action that doesn't settle atomically in the calling transaction — keeper-fulfilled requests, oracle-pending settlements, liquidation queues, governance-gated executions. Solve it once with a generic two-phase commit + compensating-action pattern, drawing on Gray (1978).

---

## 2. State machine

```
   ┌──────────┐      claim       ┌──────────────┐    settle    ┌────────────┐
   │  REGULAR │ ─────────────►   │  PENDING     │ ──────────►  │   REGULAR  │
   │   NOTE   │                  │  CLAIM NOTE  │              │   NOTE     │
   └──────────┘                  └──────────────┘              └────────────┘
                                       │
                                       │ deadline elapsed,
                                       │ no settlement
                                       ▼
                                  ┌────────────┐
                                  │  REDEEMED  │
                                  │  (refund)  │
                                  └────────────┘
```

---

## 3. Three new circuits

**`claim_circuit`** — debit `bound_inputs`, mint a `claim_note` with `domain_tag = CLAIM_NOTE`. Public inputs: standard adapt prefix (PRD-11) + `claim_id` (Poseidon hash linking this claim to its eventual settlement).

**`claim_settle_circuit`** — prove that:
1. The keeper has fulfilled the action (proven via SPL on-chain settlement-receipt account read into the proof's public inputs).
2. The `claim_note` is owned by the prover (nullifier derivation as usual).
3. The settlement output meets `expected_outputs` from the claim.

Burn the `claim_note`; mint real shielded output(s).

**`claim_redeem_circuit`** — prove that:
1. `current_slot > deadline_slot`.
2. No settlement has occurred (proven via absence of a settlement receipt, attested by the adapter program's deterministic state).
3. The prover owns the `claim_note`.

Burn the `claim_note`; mint shielded refund of the original inputs.

---

## 4. Claim note structure

```rust
pub struct ClaimNote {
    pub commitment: Hash,         // Poseidon(CLAIM_DOMAIN, claim_id, viewing_pub, original_inputs_hash)
    pub claim_id: Hash,            // unique per claim, used for state lookup
    pub adapter_id: Pubkey,
    pub deadline_slot: u64,
    pub original_inputs: [TokenBinding; 4],  // for refund path
    pub expected_outputs: [TokenBinding; 4], // settlement target
}
```

Claim notes are stored in the same Merkle tree as regular notes but with a distinct domain tag in the commitment hash. The circuit refuses to spend a claim note via the regular `transact_circuit` — they're a different type. This prevents accidental claim-as-regular-note spending.

---

## 5. Settlement-receipt protocol

Each adapter that supports two-phase declares in its `AdapterEntry` a "settlement attestation account" pattern:

```rust
pub struct SettlementAttestation {
    pub claim_id: [u8; 32],
    pub settled: bool,
    pub settlement_amount: [u64; 4],   // up to 4 mints per PRD-11
    pub settlement_slot: u64,
    pub keeper: Pubkey,
}
```

The adapter writes this PDA when fulfilling. The settle circuit reads it as a public input and verifies that `settled == true` for the bound `claim_id`.

For protocols that don't natively expose this kind of receipt (Jupiter Perps' on-chain position state may not have a clean "this came from claim X" link), the adapter wraps the protocol with a thin attestation program that records the linkage. **This puts the burden of attestation on the adapter author, not on b402's protocol.**

---

## 6. Use cases

| Protocol case | Two-phase? | Notes |
|---|---|---|
| Jupiter swap | No — synchronous | Uses regular adapt path (PRD-11) |
| Adrena perps open | No — synchronous fill | Regular adapt path |
| Jupiter Perps open | Yes — keeper queue | Phase 1: claim. Phase 2: settle when keeper fills. |
| Drift post-reboot conditional orders | Yes — slot-or-price-conditional | Same shape |
| Pyth-pending oracle settle | Yes — oracle update gate | Same shape |
| MetaDAO governance-gated DeFi | Yes — vote-conditional | Same shape |
| Phoenix limit order | Yes — match-conditional | Same shape |
| Sanctum LST exchange (instant) | No | Synchronous |

---

## 7. Threat model additions

- **Replay of settlement attestation.** Mitigated by `claim_id` uniqueness + settlement attestation lookup.
- **Adapter griefing via never-settling.** User has the redeem path after deadline; redeem returns original inputs minus a small slashing fee that pays the relayer to clean up. Slashing fee bound at registration time, not user-tx-time.
- **Front-running settlement with redeem.** Settlement and redeem cannot both succeed: the on-chain handler atomically checks `(deadline_slot vs current_slot)` AND `(settlement attestation status)`. Race is decided by Solana's transaction ordering.

---

## 8. Hard vs soft

**Hard:**
- Three-circuit structure (claim, settle, redeem). Removing any breaks safety.
- `claim_id` uniqueness via Poseidon collision-resistance.
- Settlement-attestation PDA pattern as the binding between off-chain keeper action and on-chain proof.

**Soft:**
- Per-adapter slashing fee cap on redeem.
- Maximum `deadline_slot` distance from `current_slot` (recommendation: ≤ 50,000 slots ≈ 5.5 hours).

---

## 9. Rejected alternatives

- **No two-phase, only synchronous.** Eliminates ~30% of Solana DeFi protocols (Jupiter Perps, Phoenix limit orders, anything keeper-fulfilled).
- **Two-phase via off-chain SDK retries (no protocol support).** Loses atomicity of refund path; user must trust their own retry logic.
- **Single-circuit "general adapt" that handles sync + async via a flag.** Doubles circuit complexity for the synchronous path; degrades worst-case proving time uniformly.

---

## 10. Open questions

1. Should redeem also work *before* deadline if the adapter explicitly cancels the claim? Tentative: yes — adapter can write `settled = false; cancelled = true` to settlement attestation, redeem path checks `cancelled` and skips deadline test.
2. Cross-adapter claim chaining (claim from adapter A used as input to adapter B): scope-bound to single-adapter in v1. Cross-adapter is PRD-23.

---

## 11. Revision history

| Version | Date | Author | Changes |
|---|---|---|---|
| 0.1 | 2026-04-26 | b402 core | Initial draft. **Marked deferred** — Adrena (first v2-native adapter, PRD-16) is synchronous; no async target on the v2 critical path. Spec retained so v2 ABI does not preclude future async adapters. |

---

## 12. Sign-off

| Role | Name | Date | Status |
|---|---|---|---|
| Protocol lead | | | |
| Circuit lead | | | |
| Solana/Anchor review | | | |
| Final approval | | | |

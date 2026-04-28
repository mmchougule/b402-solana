# PRD-15 — Delta-Zero Adapt + Deadline Slot

| Field | Value |
|---|---|
| **Status** | Draft — awaiting review |
| **Owner** | b402 core |
| **Date** | 2026-04-26 |
| **Version** | 0.1 |
| **Depends on** | PRD-11, PRD-13 |
| **Gates** | Drift cancel/settle, governance ops, Pyth nudges |

---

## 1. Goal

Treat zero-output actions as a first-class case (not a special-case workaround) and add `deadline_slot` as a mandatory public input even for synchronous actions. Both are small, both are forced by real adapters.

---

## 2. Delta-zero specification

`output_count == 0` (PRD-11 vector) implies:
- No `out_vault` writes.
- No new commitments appended.
- Optional `state_binding` (PRD-13) — almost always present, since zero-output actions are usually pure state mutations.

The circuit checks: if `output_count == 0` and `input_count == 0` and `state_binding.is_none()`, the action is a no-op and is **rejected** at proof generation time. This prevents free-action spam.

---

## 3. `deadline_slot` semantics

```rust
pub struct AdaptInputs {
    // ... PRD-11, PRD-12 fields ...
    pub deadline_slot: u64,
}
```

The on-chain handler verifies `current_slot <= deadline_slot`. Past deadline, the proof is rejected even if cryptographically valid.

Defends against:
- **RPC delay attacks.** A malicious relayer holding a tx for hours and submitting it when oracle prices have moved.
- **Slot-aware MEV.** If the user signed a proof at slot T, executing it at slot T+10000 may be against their interest.
- **Stale claim attempts.** Per PRD-14, deadlines are also the trigger for claim redemption.

---

## 4. Use cases

| Action | Inputs | Outputs | State | Notes |
|---|---|---|---|---|
| Drift `cancelOrder` | 0 | 0 | yes (User PDA) | Pure state mutation |
| Drift `settlePnl` | 0 | 0 | yes (User PDA) | Pure state mutation |
| Kamino `refresh_obligation` | 0 | 0 | yes (Obligation) | Oracle update prep |
| Pyth oracle update nudge | 0 | 0 | no | Pure protocol-state poke |
| MetaDAO vote | 0 | 0 | yes (Voter PDA) | Governance |
| Jupiter swap | 1 | 1 | no | Standard case |
| Orca DecreaseLiquidity | 1 | 2 | yes (Position) | PRD-11 multi-output |
| Adrena open position | 1 | 0 | yes (Position) | Collateral in, no token out, position-state mutation |
| Adrena close position | 0 | 1 | yes (Position) | No collateral in, settlement out |

The pattern is regular. No special-case logic anywhere.

---

## 5. Threat model

`deadline_slot` enables a new griefing vector: a malicious user could set `deadline_slot = current_slot` and force a tx to fail if it's not packed in *this slot*. This is **the user's problem** — they're griefing themselves. Defense at the relayer layer: relayers may refuse proofs with deadlines too close to current slot.

---

## 6. Hard vs soft

**Hard:**
- `deadline_slot` is a public input (cannot be added later without re-cut).
- Zero-output rejection rule when no state binding — closes free-action vector.

**Soft:**
- Maximum `deadline_slot` window (rec: 50k slots).
- Relayer policy on minimum deadline distance.

---

## 7. Rejected alternatives

- **Implicit "current slot + 50000" deadline.** Hides the parameter from the user; bad UX, weakens defense against RPC delay.
- **No deadline at all.** Accepts RPC-delay risk. Unacceptable for systematic-trader users.
- **Block-hash binding instead of slot.** Block hash is per-tx already (Solana's `recent_blockhash`). Slot-based deadline is orthogonal and finer-grained.

---

## 8. Open questions

1. Should claim notes (PRD-14) reuse `deadline_slot` from the originating claim, or carry their own? Tentative: claim carries its own; settle/redeem inherit it.

---

## 9. Revision history

| Version | Date | Author | Changes |
|---|---|---|---|
| 0.1 | 2026-04-26 | b402 core | Initial draft. Generalizes PRD-04 §7.1 delta-zero exemption into a first-class circuit case; adds mandatory `deadline_slot` public input. |
| 0.2 | 2026-04-24 | b402 core | Implementation notes for `phase-3-abi-v2`. Public-input offset 36 = `deadlineSlot`. 64-bit range-checked in-circuit (matches `Clock.slot` u64). Pool check `Clock::get().slot <= pi.deadline_slot` runs *before* any token movement in `adapt_execute_v2`. Error code `PoolError::DeadlineExceeded = 2000`. Delta-zero (M=0, N=0) is supported by the v2.0 handler — `public_amount_in` and `relayer_fee` transfers are conditional on positive amounts, and slot 0 dummy nullifiers/commitments are accepted; the only required movement remains the optional shadow-state mutation in the adapter CPI. |

---

## 10. Sign-off

| Role | Name | Date | Status |
|---|---|---|---|
| Protocol lead | | | |
| Circuit lead | | | |
| Solana/Anchor review | | | |
| Final approval | | | |

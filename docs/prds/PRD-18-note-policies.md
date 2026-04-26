# PRD-18 — Programmable Note Policies

| Field | Value |
|---|---|
| **Status** | Forward — designed-for, ship-later |
| **Owner** | b402 core |
| **Date** | 2026-04-26 |
| **Version** | 0.1 |
| **Depends on** | PRD-02, PRD-11 |
| **Gates** | time-locked notes, multi-sig spends, vesting |

> Forward PRD: not implemented in v1 or v2. The v1/v2 architecture **must not preclude this.**

---

## 1. Goal

Per-note conditional spending rules. Time-locks, adapter-locks, multi-sig spends, vesting schedules.

---

## 2. Mechanism

Extend commitment hash to include `policy_root`. Spending requires proving membership in `policy_root` *and* policy condition satisfaction.

```
commitment = Poseidon(token, value, random, spendingPub, policy_root)
```

`policy_root = 0` means "no policy" (current behavior). Non-zero policies decoded by the prover; the on-chain verifier doesn't need to know policy contents — only that the policy was satisfied.

---

## 3. v1/v2 constraint already met

Commitment shape can carry an extra field with zero-default for backwards compatibility. This means v1/v2 commitments interoperate with v3 policy-aware commitments — the zero `policy_root` is the no-op case.

---

## 4. Open questions

1. Policy DSL: hand-rolled mini-language vs reuse of Sapling/Orchard-style note policies. Lean: hand-rolled, minimal.
2. Whether policy check happens in the spend circuit or in a separate "policy gate" circuit. Lean: spend circuit, single proof.

---

## 5. Revision history

| Version | Date | Author | Changes |
|---|---|---|---|
| 0.1 | 2026-04-26 | b402 core | Initial sketch. Forward PRD; not on v2 critical path. |

---

## 6. Sign-off

| Role | Name | Date | Status |
|---|---|---|---|
| Protocol lead | | | |
| Circuit lead | | | |
| Final approval | | | |

# PRD-17 — Recursive Proof Aggregation (Nova / Sonobe folding)

| Field | Value |
|---|---|
| **Status** | Forward — designed-for, ship-later |
| **Owner** | b402 core |
| **Date** | 2026-04-26 |
| **Version** | 0.1 |
| **Depends on** | PRD-11, PRD-12 |
| **Gates** | v3+ batch privacy, amortized verifier cost |

> Forward PRD: not implemented in v1 or v2. The v1/v2 architecture (PRD-11 → PRD-16) **must not preclude this.** The sketch below is sufficient to ensure that.

---

## 1. Goal

Aggregate N user adapt actions into one on-chain proof. Amortizes Groth16 verification cost; enables batch privacy (which user did what, hidden inside the batch).

---

## 2. v1 architecture constraints already met

- Commitments are additive (Poseidon).
- Nullifier set is sharded (PRD-01 §5.7).
- `action_hash` is content-addressed (PRD-12).
- Proofs over our 39-public-input adapt circuit can be folded with HyperNova / Sonobe once those tools mature on Solana.

No v1/v2 protocol change is needed to keep this option open.

---

## 3. v2/v3 implementation sketch

When Sonobe / Lurk Beta / similar tooling is production-grade on Solana:

- Add `b402-aggregator` program.
- Verifier accepts folded proofs.
- Pool batches N users' `adapt_execute` calls into one transaction.

Folding scheme choice (Nova vs HyperNova vs Protostar) deferred until tooling matures and Solana CU costs for the recursive verifier are measurable.

---

## 4. Open questions

1. Folding-friendly curve: BN254 (current) vs a cycle-of-curves construction. Affects whether existing verifier keys carry forward.
2. Whether the aggregator is a separate program or an instruction on the pool. Lean: separate program.

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

# PRD-21 — PQ-Readiness Migration Path

| Field | Value |
|---|---|
| **Status** | Forward — designed-for, ship-later |
| **Owner** | b402 core |
| **Date** | 2026-04-26 |
| **Version** | 0.1 |
| **Depends on** | PRD-01, PRD-02, PRD-03 |
| **Gates** | post-quantum migration, NIST PQ standardization timeline |

> Forward PRD: not implemented in v1 or v2. The v1/v2 architecture **must not preclude this.**

---

## 1. Goal

Dual-verifier scheme. BN254 Groth16 alongside a PQ-safe verifier (lattice-based or hash-based, e.g., Plonky3 + STARK-friendly curve, or Falcon-style signatures).

---

## 2. Mechanism

New shields default to dual-attestation (both verifiers must accept); old shields verify with BN254 only. Migration triggered by NIST PQ standardization timeline (~2027–2030).

The dual-verifier scheme is a *defense-in-depth* property — both proofs must succeed for a spend to land, so a break in one curve does not immediately compromise user funds. After NIST PQ standardization stabilizes, b402 may flip the default to PQ-only for new shields while keeping BN254 verification available for legacy notes.

---

## 3. v1/v2 constraint already met

`b402-verifier-transact` and `b402-verifier-adapt` are pinned in `PoolConfig` per PRD-01 §5.4. Adding a second verifier slot is a soft change (admin instruction). The pool already expects to support multiple verifier programs.

---

## 4. Open questions

1. PQ proof system choice: STARKs (Plonky3, RISC Zero), lattice-based (Lasso/Jolt), hash-based signatures (XMSS, Falcon). Decision deferred until NIST timeline tightens.
2. Whether circuits are redesigned for the PQ system or compiled from a common front-end (Noir, Circom-to-STARK). Lean: common front-end if mature; otherwise rewrite.

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

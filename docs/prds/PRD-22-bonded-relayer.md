# PRD-22 — Bonded Relayer Market

| Field | Value |
|---|---|
| **Status** | Forward — designed-for, ship-later |
| **Owner** | b402 core |
| **Date** | 2026-04-26 |
| **Version** | 0.1 |
| **Depends on** | PRD-01, PRD-06 |
| **Gates** | permissionless relayer set with economic guarantees |

> Forward PRD: not implemented in v1 or v2. The v1/v2 architecture **must not preclude this.**

---

## 1. Goal

Slashing-secured permissionless relayer set. Replaces "trust the default relayer" with economic guarantees.

---

## 2. Mechanism

Relayers post a bond. Censorship, MEV-extraction, or proof-of-fraud (off-chain attestation that a relayer's behavior was provably bad) trigger slashing. Bond is per-relayer-per-region.

Layered above the protocol — the pool's permissionless relayer model (PRD-01 §7.3) does not need to change. The bonded market is a separate program plus reputation registry; the pool sees the relayer fee recipient and is indifferent to whether that recipient is bonded.

---

## 3. v1/v2 constraint already met

PRD-01 §7.3 already specifies "no allowlist." Bonded market is a layer above the protocol, not a protocol change. Reputation registry is a separate program.

---

## 4. Open questions

1. Slashing condition: censorship is hard to prove on-chain. Lean: subjective off-chain slashing (DAO-arbitrated) until a clean on-chain proof-of-censorship primitive exists.
2. Bond denomination: SOL vs USDC vs a b402-native token. Lean: USDC, sized in fiat for predictability.

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
| Relayer lead | | | |
| Final approval | | | |

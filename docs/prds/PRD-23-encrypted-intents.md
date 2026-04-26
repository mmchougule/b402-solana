# PRD-23 — Encrypted Intents Layer

| Field | Value |
|---|---|
| **Status** | Forward — designed-for, ship-later |
| **Owner** | b402 core |
| **Date** | 2026-04-26 |
| **Version** | 0.1 |
| **Depends on** | PRD-01, PRD-06, PRD-12 |
| **Gates** | pre-execution privacy, MEV-protected order flow |

> Forward PRD: not implemented in v1 or v2. The v1/v2 architecture **must not preclude this.**

---

## 1. Goal

Compose b402's shielded execution with encrypted-mempool order flow. Pairs with Jito intents, Skip, encrypted-mempool research from a16z. Hides the *intent itself*, not just the execution.

---

## 2. Mechanism

User encrypts an intent; an MEV-protected submission layer (Jito bundle with encrypted payload, decrypted by validator at execution) prevents pre-execution leak. b402's shielded execution then handles post-execution privacy.

The two layers compose cleanly:

- **Encrypted intents layer** hides the user's *desired action* until just before execution. Defends against pre-execution MEV (front-running, sandwiching).
- **b402 shielded execution layer** hides *who* did the action and *what state changed* in shielded form. Defends against post-execution linkage.

---

## 3. v1/v2 constraint already met

b402 is the *execution* layer; the *submission* layer is orthogonal. No protocol changes. Pure SDK + relayer-config work.

---

## 4. Open questions

1. Submission layer choice: Jito bundles, Skip, custom encrypted mempool. Lean: pluggable submission strategy in the SDK.
2. Cross-adapter intent composition (claim from adapter A used as input to adapter B): scope-bound to single-adapter through PRD-14; cross-adapter chaining lives here. Spec deferred until intent layer matures.

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

# PRD-19 — Multi-Asset Notes

| Field | Value |
|---|---|
| **Status** | Deferred — superseded by PRD-11 vector bindings for current use cases |
| **Owner** | b402 core |
| **Date** | 2026-04-26 |
| **Version** | 0.1 |
| **Depends on** | PRD-02, PRD-11 |
| **Gates** | LP positions, basket trades, atomic portfolio rebalances (currently handled by dual notes) |

> **Deferred.** PRD-11's vector ABI handles every multi-asset case we currently want via dual notes (one per mint). True multi-asset notes are an optimization, not a capability gap. Spec deferred until a real need surfaces.

---

## 1. Goal

One note holds `Vec<(mint, value)>` instead of single `(mint, value)`. Useful for LP positions, basket trades, atomic portfolio rebalances.

---

## 2. Why deferred

PRD-11 gives `M ≤ 4` inputs and `N ≤ 4` outputs per adapt action. Every current use case (Orca DecreaseLiquidity 2-out, three-leg arbitrage, basket rebalance) maps cleanly to dual notes. The ergonomic loss is one extra note in the wallet's notebook per LP position — measurable in user-facing UX but not capability-blocking.

True multi-asset notes (one commitment, multiple `(mint, value)` pairs) require:

- Wider commitment hash (Poseidon over `4 × 2 = 8` extra field elements at minimum).
- Spend circuit reasoning over per-asset balance changes.
- Substantial audit surface for the value-conservation logic.

We accept the dual-note workaround for v2 and revisit if a real LP-heavy adapter (Orca v2, Meteora) makes the wallet UX intolerable.

---

## 3. v1/v2 constraint already met

Note schema is field-extensible behind a `note_version` byte. v3 multi-asset notes would carry `note_version = 2` and a different commitment shape; v1/v2 single-asset notes (`note_version = 1`) remain spendable indefinitely.

---

## 4. Open questions

1. If we eventually ship this, do we migrate existing single-asset notes lazily or force a re-shield? Lean: lazy.

---

## 5. Revision history

| Version | Date | Author | Changes |
|---|---|---|---|
| 0.1 | 2026-04-26 | b402 core | Initial sketch. **Marked deferred** — PRD-11 vector bindings cover the current use cases via dual notes. |

---

## 6. Sign-off

| Role | Name | Date | Status |
|---|---|---|---|
| Protocol lead | | | |
| Circuit lead | | | |
| Final approval | | | |

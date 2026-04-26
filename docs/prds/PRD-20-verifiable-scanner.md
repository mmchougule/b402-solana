# PRD-20 — Verifiable Scanner

| Field | Value |
|---|---|
| **Status** | Forward — designed-for, ship-later |
| **Owner** | b402 core |
| **Date** | 2026-04-26 |
| **Version** | 0.1 |
| **Depends on** | PRD-02, PRD-06 |
| **Gates** | indexer-trust elimination, censorship-resistance proofs |

> Forward PRD: not implemented in v1 or v2. The v1/v2 architecture **must not preclude this.**

---

## 1. Goal

ZK proof that the scanner discovered all notes for a given viewing key up to slot S. Eliminates trust in indexer infrastructure; proves "you have not been censored."

---

## 2. Mechanism

Scanner produces a proof over Solana log digest (or a Merkle commitment to the log range) that all `viewing_tag` matches were processed. The user's SDK verifies the proof; if it succeeds, the user knows they've seen every note addressed to their viewing key in `[start_slot, end_slot]`.

---

## 3. v1/v2 architecture already supports it

- Event log stream is content-addressable.
- `viewing_tag` Poseidon pre-filter is already in the scanner.
- Only the proof construction is new.

No v1/v2 protocol change is needed.

---

## 4. Open questions

1. Proof system: same Groth16 stack as the rest of b402, or a STARK-friendly system better suited to log-range commitments. Lean: keep Groth16 for tooling consistency unless STARK costs are dramatically better.
2. Granularity: per-slot proof vs per-epoch (e.g., per 432,000-slot epoch). Lean: per-epoch, with on-demand smaller ranges.

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

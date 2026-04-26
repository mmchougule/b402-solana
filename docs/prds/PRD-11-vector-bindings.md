# PRD-11 — Vector Token Bindings (M-in / N-out)

| Field | Value |
|---|---|
| **Status** | Draft — awaiting review |
| **Owner** | b402 core |
| **Date** | 2026-04-26 |
| **Version** | 0.1 |
| **Depends on** | PRD-01, PRD-02, PRD-03, PRD-04 |
| **Gates** | PRD-12, PRD-16, all multi-output adapters |
| **Supersedes** | PRD-04 §2 single-mint binding |

---

## 1. Goal

Generalize the adapt circuit's token-binding from a scalar `(in_mint, public_amount_in)` plus scalar `(out_mint, expected_out_value)` to **vectors** of `(mint, amount)` tuples, bounded at `M ≤ 4` inputs and `N ≤ 4` outputs.

This subsumes every multi-mint case we know about — Orca DecreaseLiquidity (2 outputs), CollectFees (2 outputs), three-leg arbitrage (3 outputs), basket rebalances (multiple in + multiple out) — without further protocol amendment.

---

## 2. Why now, not later

The cost of adding multi-output later is a circuit recut, a new pool program, and a user-funds migration. The cost of adding it now is one round of audit on a bigger circuit. Adding it after audit-1 is the most expensive moment in the protocol's lifetime to make this change.

---

## 3. ABI

```rust
pub struct TokenBinding {
    pub mint: Pubkey,         // SPL token mint; zero-pubkey signals an unused slot
    pub amount: u64,          // for inputs: exact debit; for outputs: minimum credit
}

pub struct AdaptInputs {
    pub bound_inputs:     [TokenBinding; 4],   // M ≤ 4
    pub expected_outputs: [TokenBinding; 4],   // N ≤ 4
    pub input_count:      u8,                  // actual M
    pub output_count:     u8,                  // actual N (0 = delta-zero, see PRD-15)
    // ... other fields per PRD-12, PRD-13, PRD-14, PRD-15
}
```

Slots beyond `input_count` / `output_count` are zero-bindings (mint = 11111…, amount = 0). The circuit verifies that **either** the slot is used (mint ≠ 0 ∧ amount > 0) **or** the slot is fully zero. No half-zero slots permitted — closes a malleability vector.

---

## 4. Circuit changes

- New public inputs: 4 × (mint_fr, amount_fr) for inputs + 4 × for outputs = 16 new public inputs (currently 23 → 39).
- New constraints: ~5,500 R1CS additional (mostly Poseidon hashes for binding the four mints into the action context, plus range checks on amounts).
- Updated `adapt_circuit` total: ~22,500 R1CS constraints (current ~17,500). Proving time: <1.2s WASM (current ~0.8s for 18-input transact, <1.2s extrapolating linearly).
- Verifier CU: ~210k for Groth16 verification (39 public inputs ≈ +6k CU vs current 23-input verifier — within budget per PRD-01 §13.3).

---

## 5. On-chain handler

```rust
// Pseudocode — full spec in PRD-03 update
for i in 0..input_count {
    let TokenBinding { mint, amount } = bound_inputs[i];
    // Verify in_vault[mint] balance pre-CPI; debit amount.
    transfer_signed(vault_pda(mint), adapter_in_ta(mint), amount);
}

cpi_into_adapter(adapter_id, action_hash, accounts);

for j in 0..output_count {
    let TokenBinding { mint, amount: min_amount } = expected_outputs[j];
    let post = balance(out_vault(mint));
    let pre  = pre_balances[mint];
    require!(post >= pre + min_amount, AdapterUnderdelivered);
    append_commitment(mint, output_commitments[j]);
}
```

Account layout: pool now passes `2 × (M + N)` token-account references (vault + adapter scratch) instead of 4. ALT capacity already allows this — current 16-entry ALT covers 8 mint × 2 = 16 slots; bump to 32-entry ALT for v2 (PRD-04 §5 amendment).

---

## 6. Hard vs soft

**Hard:**
- Slot count `M=N=4`. Increasing it later is a new circuit + ceremony. Audit firms prefer fixed-size loops; dynamic loops are harder to formally verify.
- Zero-binding canonicalization rule. Closes a known malleability class.
- Slot semantics (input = exact, output = minimum). Asymmetric on purpose: inputs must be exactly what the user authorized; outputs are floors, not ceilings.

**Soft:**
- Per-instance values of `input_count`, `output_count`. User-chosen per tx.

---

## 7. Rejected alternatives

- **Dynamic-length vectors.** Groth16 circuits cannot have dynamic shape; would require Plonk + universal setup or recursive proofs (PRD-17 territory). Defer.
- **Unbounded N at the protocol level (e.g., 16-output bound).** Audit cost grows superlinearly in circuit size. Four covers every action we've seen and a wide margin.
- **Separate circuits per output count (1-out, 2-out, 3-out, 4-out variants).** Multiplies trusted-setup ceremonies and audit surface 4×. Single circuit with zero-padded slots is cheaper end-to-end.

---

## 8. Open questions

1. Should output binding allow specifying a *maximum* amount in addition to the minimum? Use case: dust avoidance (refuse if dust returned). Tentative: no — adapters can short-circuit dust internally; protocol stays minimal.
2. Per-mint ALT preregistration: do we lock specific mints into the canonical ALT or accept ad-hoc mint accounts? Tentative: keep top-N by volume in canonical ALT, allow ad-hoc for tail mints.

---

## 9. Revision history

| Version | Date | Author | Changes |
|---|---|---|---|
| 0.1 | 2026-04-26 | b402 core | Initial draft. Generalizes PRD-04 §2 single-mint binding to M-in / N-out vectors with `M=N=4` cap. |

---

## 10. Sign-off

| Role | Name | Date | Status |
|---|---|---|---|
| Protocol lead | | | |
| Circuit lead | | | |
| Solana/Anchor review | | | |
| Final approval | | | |

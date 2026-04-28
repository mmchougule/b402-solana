# PRD-13 — Shadow PDA Derivation Spec

| Field | Value |
|---|---|
| **Status** | Draft — awaiting review |
| **Owner** | b402 core |
| **Date** | 2026-04-26 |
| **Version** | 0.1 |
| **Depends on** | PRD-12 |
| **Supersedes** | PRD-09 §7 (Kamino-specific shadow obligation pattern is generalized here) |

---

## 1. Goal

Per-user protocol state (Kamino Obligation, Drift User, Marginfi MarginAccount, future per-user PDAs) without revealing user identity to chain observers, parameterized over arbitrary protocols.

---

## 2. Derivation

```rust
shadow_pda = Pubkey::find_program_address(
    &[
        b"b402-shadow",                   // global namespace
        adapter_id.as_ref(),              // 32 bytes
        scope_tag,                        // 16 bytes ASCII
        viewing_key_commitment.as_ref(),  // 32 bytes
    ],
    &adapter_id,                          // adapter owns the PDA
)
```

`viewing_key_commitment` is a Poseidon hash already computed and bound by the adapt circuit (existing public input from PRD-02 §5.6's note encryption key derivation). This means:

- **Different users get different shadow PDAs** for the same `(adapter, scope)`.
- **Same user gets the same shadow PDA** every time, deterministic.
- **Chain observers see a PDA address** but cannot derive the viewing key from the address (preimage resistance of Poseidon).

---

## 3. Authorization model

Mutating the shadow PDA's state requires:

1. The adapter program is the technical signer (PDA-owned by adapter).
2. The user must produce a proof binding `(viewing_key_commitment, action_hash)` such that the adapter only proceeds if the user demonstrably knows the spending key from which the viewing key was derived. This is the *same nullifier-derivation logic* that authorizes regular note spends — no new cryptographic primitive.

Concretely: the adapt circuit's existing `recipient_bind = Poseidon("recipientBind", owner_low, owner_high)` mechanism extends to `state_bind = Poseidon("stateBind", viewing_pub, scope_tag, adapter_id)`. The on-chain handler verifies `state_bind` matches the PDA being mutated.

---

## 4. Use cases

| Protocol | scope_tag | shadow PDA contains |
|---|---|---|
| Kamino Lend | `kamino:obligation:v1` | per-user Obligation account |
| Drift v2 | `drift:user:0` (sub-account 0) | per-user User account |
| Marginfi | `marginfi:account:v1` | per-user MarginAccount |
| Adrena | `adrena:position:v1` | per-user Position |
| Phoenix | `phoenix:trader:v1` | per-user TraderState |
| Future protocol X | `x:state:v1` | per-user state account |

The pattern is **identical** for all of them. No protocol-specific logic in the pool or circuit.

---

## 5. State lifecycle

Shadow PDAs are created lazily — first action to a given `(viewing_key, adapter, scope)` triple creates the PDA via `init_if_needed` semantics. Rent is paid by the user (or relayer) at create time. State is preserved across actions. Shadow PDAs are never closed by the protocol — closure is a user-initiated `state_close` instruction that proves ownership via the same circuit and recovers rent.

---

## 6. Privacy properties

**What's leaked:**
- Number of distinct shadow PDAs per adapter (= number of distinct users using that adapter).
- Per-PDA action frequency (timing).
- Per-PDA on-protocol balances (if the protocol exposes them publicly, e.g., Drift positions).

**What's not leaked:**
- Linkage between a shadow PDA and any wallet address (the PDA is derived from `viewing_key_commitment`, which is one Poseidon hash away from the user's spending key — preimage-resistant).
- Linkage between two shadow PDAs of the same user across different protocols (different `adapter_id`s yield different PDAs, no cross-correlation).

This means: a user with a position on Drift and a deposit on Kamino has **no on-chain link** between the two unless the underlying protocols themselves leak it (e.g., Drift's public liquidation events). Per-protocol leakage is the protocol's problem, not b402's.

---

## 7. Hard vs soft

**Hard:**
- Seed namespace `"b402-shadow"`. Changing it migrates every existing shadow PDA — equivalent to a new pool.
- The four-component seed structure `(namespace, adapter_id, scope_tag, viewing_key_commitment)`.

**Soft:**
- Per-adapter `scope_tag` choice — adapters define their own.
- State account size — set per-adapter at registration.

---

## 8. Rejected alternatives

- **Per-user state stored *inside the pool's* nullifier set.** Couples b402's storage model to every protocol's state shape. Doesn't scale.
- **Shadow PDA derived from spending key directly.** Spending key is more sensitive than viewing key; binding it to a public PDA address is bad opsec.
- **No shadow PDA, single shared adapter user.** Already rejected in PRD-10 §4 due to the cross-user liquidation contagion problem.

---

## 9. Open questions

1. Per-protocol scope-tag registry: should b402 maintain a canonical `scope_tag` registry across all adapters to prevent collisions? Tentative: yes — soft-locked at adapter registration time.
2. Cross-adapter state composition (e.g., Kamino-collateral → Drift-margin): does the shadow PDA model permit this? Tentative: yes via two-phase PRD-14 with cross-protocol claim notes; spec deferred to PRD-23.

---

## 10. Revision history

| Version | Date | Author | Changes |
|---|---|---|---|
| 0.1 | 2026-04-26 | b402 core | Initial draft. Generalizes PRD-09 §7 Kamino-specific shadow obligation pattern to arbitrary per-user protocol state. |
| 0.2 | 2026-04-24 | b402 core | Implementation notes for `phase-3-abi-v2`. Public-input offset 37 = `shadowPdaBinding`. Circuit binding is `Poseidon_3(shadowDomainTag, viewingPubHash, scopeTag)` where `shadowDomainTag` is a private witness equal to LE Fr of `b402/v2/shadow-bind` (distinct from `b402/v2/adapt-bind` — closes a cross-context replay vector). Pool gate is per-call: `AdaptExecuteV2Args.require_shadow_binding`. The strong PDA-derivation check (PDA seeds = `("b402-shadow", adapter_id, scope_tag, viewing_key_commitment)`) lives in the adapter program, not in the pool — adapters own their shadow PDAs and re-derive on each call. |

---

## 11. Sign-off

| Role | Name | Date | Status |
|---|---|---|---|
| Protocol lead | | | |
| Circuit lead | | | |
| Solana/Anchor review | | | |
| Final approval | | | |

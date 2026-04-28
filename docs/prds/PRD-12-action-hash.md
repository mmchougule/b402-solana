# PRD-12 — Content-Addressed `action_hash` (the keystone)

| Field | Value |
|---|---|
| **Status** | Draft — awaiting review |
| **Owner** | b402 core |
| **Date** | 2026-04-26 |
| **Version** | 0.1 |
| **Depends on** | PRD-11 |
| **Gates** | every adapter henceforth |

---

## 1. Thesis

The single change that closes the protocol for modification while leaving it open for extension. Once `action_hash` is content-addressed, **adding any future adapter is a pure CPI wrapper.** The pool, verifier, and circuit do not change for new adapters. Ever. This is the Open/Closed Principle (Meyer 1988) made cryptographically enforceable.

---

## 2. Definition

```
action_hash = Poseidon(
    DOMAIN_TAG_ACTION,            // "b402/v2/action"
    adapter_id_fr,                 // adapter program ID, reduced to BN254 Fr
    scope_tag_fr,                  // adapter-defined scope (Poseidon-friendly tag)
    ix_data_hash_fr,               // keccak256(adapter ix data) reduced to Fr
    accounts_hash_fr,              // keccak256(canonical AccountMeta vec) reduced to Fr
    extra_context_root,            // optional; Poseidon root of (deadline_slot, claim_id, etc.)
)
```

`ix_data_hash` and `accounts_hash` are computed off-chain by the SDK from the adapter's ABI declaration (registered on-chain in `AdapterRegistry`). The adapter program, at execution time, recomputes `action_hash` from the actual instruction it's about to issue — using the *exact same* ix bytes and account list — and asserts equality with the proof's bound `action_hash`.

The circuit treats `action_hash` as opaque. It binds the user's signature over the hash; it never decomposes the hash.

---

## 3. AccountMeta canonicalization

Account list is sorted by `(pubkey ASC, is_signer DESC, is_writable DESC)` then serialized as:

```
∀ i ∈ [0, N): pubkey[i] || (is_signer[i] << 1 | is_writable[i])
```

Sorting is stable; duplicates rejected by the on-chain handler. Canonicalization eliminates ordering ambiguity (a known cause of EVM `delegatecall` malleability).

---

## 4. Adapter Registry — extended schema

```rust
pub struct AdapterEntry {
    pub adapter_id: Pubkey,
    pub scope_tag: [u8; 16],          // ASCII, e.g., "kamino:lend:v1\0\0"
    pub abi_descriptor_hash: [u8; 32], // hash of the ABI declaration JSON
    pub allowed_input_mints: Option<Vec<Pubkey>>,  // None = any whitelisted mint
    pub allowed_output_mints: Option<Vec<Pubkey>>, // None = any whitelisted mint
    pub state_binding_required: bool,              // PRD-13
    pub timing_mode: TimingMode,                   // Sync | TwoPhase, PRD-14
    pub max_inputs: u8,                            // ≤ M from PRD-11
    pub max_outputs: u8,                           // ≤ N from PRD-11
    pub registered_slot: u64,
}
```

The registry is admin-gated for *adding* adapters but each entry is otherwise immutable. Removing an adapter from the registry is allowed — existing notes already proved against the adapter remain spendable; new adapt actions against the removed adapter are rejected.

---

## 5. Off-chain SDK flow

```typescript
// SDK pseudocode
const abi = await registry.getAdapterEntry(adapterId);
const ix = adapter.encodeAction(abi, action);   // SDK consults ABI descriptor
const ixDataHash = keccak256(ix.data);
const accountsHash = keccak256(canonicalize(ix.keys));
const actionHash = poseidon(
  DOMAIN_TAG_ACTION,
  adapterIdFr, scopeTagFr,
  ixDataHash, accountsHash,
  extraContextRoot
);

const proof = await prover.proveAdapt({ ...witness, actionHash });
```

The SDK never needs to know what an adapter *does*. It only needs the adapter's ABI descriptor, which is on-chain and content-hashed.

---

## 6. On-chain CPI verification

```rust
// In b402_pool::adapt_execute, just before CPI:
let ix_data = build_adapter_ix(adapter_payload);
let ix_data_hash = keccak256(&ix_data);
let accounts_hash = keccak256(&canonicalize(&accounts));
let computed = poseidon([
    DOMAIN_TAG_ACTION,
    fr(adapter_id),
    fr(scope_tag),
    fr_le(ix_data_hash),
    fr_le(accounts_hash),
    fr(extra_context_root),
]);
require!(computed == proof.action_hash, ActionMismatch);
invoke_signed(adapter_program, &accounts, &ix_data, &[adapter_authority_seeds])?;
```

Cost: one keccak256 over ~200 bytes of ix data + one keccak256 over ~512 bytes of canonicalized accounts + one Poseidon over ~6 field elements. Total: ~12k CU. Within the 1.4M budget by three orders of magnitude.

---

## 7. What this enables

- **Marginfi adapter.** Pure CPI wrapper. No circuit change.
- **Phoenix orderbook adapter.** Pure CPI wrapper.
- **Meteora DLMM adapter.** Pure CPI wrapper.
- **Sanctum LST swap.** Pure CPI wrapper.
- **Jito restaking.** Pure CPI wrapper.
- **Any future protocol that complies with `M ≤ 4`, `N ≤ 4`, sync or two-phase.** Pure CPI wrapper.

---

## 8. Hard vs soft

**Hard:**
- Domain tag value `"b402/v2/action"`.
- AccountMeta canonicalization rule.
- Inclusion of `adapter_id` and `scope_tag` in the hash. Removing either lets an adapter masquerade as another.

**Soft:**
- `extra_context_root` contents — can carry arbitrary per-action metadata.
- Specific Poseidon arity (currently 6).

---

## 9. Rejected alternatives

- **Hashing the entire ix + accounts as keccak256 only, no Poseidon.** Loses circuit-friendliness for any future case where the proof needs to inspect ix substructure (e.g., per-leg proofs in PRD-17 recursion).
- **Per-adapter custom commitment shape.** Would require circuit changes per adapter — exactly what we're avoiding.
- **No registry, anyone can be an adapter.** Loses the operational property of "admin can pause an adapter without invalidating user notes."

---

## 10. Open questions

1. Should `scope_tag` be a Poseidon hash of an arbitrary string, or a fixed-width tag? Tentative: 16-byte ASCII, hashed on-chain to Fr — gives readable scope tags in human-facing tooling without losing circuit-friendliness.
2. Versioning: should the registry support `(adapter_id, abi_version)` pairs so an adapter can ship a v2 ABI without redeploying the program? Tentative: yes — version is part of `scope_tag`.

---

## 11. Revision history

| Version | Date | Author | Changes |
|---|---|---|---|
| 0.1 | 2026-04-26 | b402 core | Initial draft. Replaces PRD-04 §2.1 ad-hoc `action_payload` keccak with a content-addressed Poseidon hash binding adapter_id + scope + ix-data + accounts. |
| 0.2 | 2026-04-24 | b402 core | Implementation notes for `phase-3-abi-v2`. Poseidon arity = 6 (`Poseidon(6)`, light-poseidon Bn254X5). Public-input offsets: domain tag = 32, adapter_id = 25, scope_tag = 33, ixDataHash (private witness `actionPayloadKeccakFr`), accountsHash = 34, extra_context_root = 35. Domain tag value `b402/v2/adapt-bind` (LE Fr-reduced, distinct from v1 `b402/v1/adapt-bind` so v1 proofs cannot satisfy v2 checks). Canonical accounts hash uses keccak256 over `pubkey \|\| (is_signer<<1 \| is_writable)` for each AccountMeta sorted ascending by pubkey then signer-desc, writable-desc — implemented in `compute_accounts_hash_fr` in `adapt_execute_v2.rs` and mirrored off-chain in `packages/prover/src/adapt_v2.ts::computeAccountsHashFr`. Ceremony output: `circuits/build/ceremony/adapt_v2_final.zkey`, `adapt_v2_verification_key.json`. Verifier program ID: `DG7Fi75b2jkcUgG5K6Ekgpy7uigYxePPSxSSrdPzLGUd`. |

---

## 12. Sign-off

| Role | Name | Date | Status |
|---|---|---|---|
| Protocol lead | | | |
| Circuit lead | | | |
| Solana/Anchor review | | | |
| Final approval | | | |

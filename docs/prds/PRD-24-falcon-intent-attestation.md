# PRD-24 — Falcon Intent Attestation

| Field | Value |
|---|---|
| **Status** | Forward — designed-for, ship-later |
| **Owner** | b402 core |
| **Date** | 2026-04-30 |
| **Version** | 0.1 |
| **Depends on** | PRD-06, PRD-12, PRD-22, PRD-23 |
| **Gates** | PQ-authenticated relayer flow; agent-facing PQ control plane |

> Forward PRD: not implemented in v1 or v2. The v1/v2 architecture **must not preclude this.**

---

## 1. Goal

Add a **post-quantum authenticated intent layer** for relayed b402 actions, using
Falcon-512 signatures over a proof-bound intent message.

This PRD is intentionally narrow. It does **not** attempt to make the full pool
post-quantum secure. It hardens the **control plane**:

1. user or agent authorizes an exact b402 action with a PQ signature;
2. relayer verifies that signature before paying fees and submitting;
3. optional later phase: the same signature is verified in a consensus-critical
   on-chain path.

The result is a defensible claim:

- **Allowed claim after PRD-24 ships:** "b402 supports Falcon-signed private-action intents."
- **Disallowed claim:** "b402 is a post-quantum private pool."

The latter requires deeper work covered by PRD-21.

---

## 2. Why this exists

Today the critical relayer path is:

1. client builds `ixData` locally;
2. client sends `ixData + accountKeys + ALT refs` to the relayer;
3. relayer runs policy checks and signs as fee payer;
4. pool verifies the Groth16 proof and executes.

This is strong on privacy, but the relayer-facing authorization story is still
classical:

- API-key auth in `packages/relayer/src/auth.ts`;
- optional Ed25519 `userSignature` transport field in
  `packages/relayer/src/submit.ts`;
- no standard PQ-signed user or agent intent envelope.

For autonomous agents, that leaves a gap: there is no canonical way for an
agent to express "I authorize this exact private action" using a PQ signature,
independent of its Solana fee-payer key.

PRD-24 fills that gap without forcing a circuit or verifier migration.

---

## 3. Non-goals

Out of scope for PRD-24:

1. Replacing Groth16 / BN254.
2. Replacing X25519 note delivery.
3. Changing the note commitment shape.
4. Making Falcon the spend-authority primitive inside the current circuit.
5. Replacing Solana's Ed25519 transaction signatures.
6. Solving relayer censorship; PRD-22 remains the path for economic relayer guarantees.

PRD-24 is a **PQ attestation** layer, not a PQ custody layer.

---

## 4. Security model

### 4.1 What PRD-24 protects

If a relayer enforces Falcon intent verification, it gains a cryptographically
stronger answer to:

- did this user or agent authorize this exact relay request?
- was the request altered in transit?
- is this request replayed across clusters, relayers, or time windows?

This is meaningful for:

1. agent wallets that want a dedicated auth key separate from the Solana keypair;
2. multi-tenant relayer deployments where API keys are too weak as the sole control;
3. institutional integrations that want a PQ-signed audit trail for every private action.

### 4.2 What PRD-24 does not protect

PRD-24 alone does **not** prevent pool compromise if:

1. Groth16 soundness breaks;
2. BN254 becomes economically breakable;
3. X25519 note confidentiality is broken by a future quantum adversary.

This is why PRD-24 is paired with PRD-21 but does not replace it.

---

## 5. Design

### 5.1 Primitive

Use **Falcon-512 compressed signatures** only.

Reasons:

1. best current Solana verification story among practical PQ signatures;
2. compact enough for relayer transport and feasible on-chain verification;
3. existing `solana-falcon512` verifier path already demonstrates a prepared-pubkey
   Solana flow with acceptable compute for selective use.

Rejected for v0.1 of this PRD:

1. Falcon-1024 — larger signatures and keys, worse tx-size fit.
2. Dilithium — larger signatures, weaker immediate Solana fit.
3. XMSS / SPHINCS+ — statefulness or larger signatures make UX and wire size worse.

### 5.2 Auth key

Each user or agent may provision a dedicated **Falcon auth keypair**.

Properties:

1. separate from Solana fee-payer key;
2. separate from the BN254 spending key used inside the current circuit;
3. separate from the X25519 viewing key.

The Falcon auth key is a **control-plane key**, not a note-ownership key.

Key registration modes:

1. **Off-chain mode (phase A)** — relayer or application stores the Falcon pubkey.
2. **On-chain registry mode (phase B)** — a small registry PDA maps a stable agent or
   wallet identifier to a Falcon pubkey hash.
3. **Note-bound mode (future, PRD-21 path)** — a PQ auth root or key is committed into
   note semantics. Not part of PRD-24.

### 5.3 Intent envelope

The signed message is a canonical **intent hash**, not raw JSON.

```
request_root = Poseidon(
    DOMAIN_TAG_PQ_INTENT_REQ,   // "b402/v1/pq-intent-req"
    ix_data_hash_fr,            // keccak256(ixData) reduced to Fr
    accounts_hash_fr,           // keccak256(canonical account metas) reduced to Fr
    alt_hash_fr                 // keccak256(canonical ALT list) reduced to Fr
)

routing_root = Poseidon(
    DOMAIN_TAG_PQ_INTENT_ROUTE, // "b402/v1/pq-intent-route"
    relayer_pubkey_fr,          // relayer expected to submit
    compute_unit_limit_fr,
    expiry_slot_fr,
    nonce_fr
)

intent_hash = Poseidon(
    DOMAIN_TAG_PQ_INTENT,       // "b402/v1/pq-intent"
    action_kind_fr,             // shield | unshield | transact | adapt
    cluster_id_fr,              // mainnet | devnet | localnet
    pool_program_id_fr,
    request_root,
    routing_root
)
```

The Falcon signature is over the 32-byte canonical encoding of `intent_hash`.

### 5.4 Canonicalization

To avoid replay or encoding ambiguity:

1. `ixData` is hashed exactly as sent to the relayer.
2. `accountKeys` are hashed in their exact instruction order after relayer-slot normalization.
3. `accountKeys[0]` is normalized to a **relayer placeholder role**, not a specific
   pubkey, because the relayer overwrites that slot with its own key today.
4. ALT addresses are sorted ascending before hashing.
5. `cluster_id` is explicit so devnet requests do not replay on mainnet.
6. `expiry_slot` and `nonce` are mandatory.

Canonical account-meta serialization:

```
for each account meta:
  role_tag || pubkey || signer_bit || writable_bit
```

`role_tag` is one of:

1. `relayer_slot` for account[0] in relay-submitted operations;
2. `ordinary` for all other metas.

This avoids false mismatches caused by relayer pubkey substitution.

### 5.5 Domain tags

New tags:

| Domain | Tag string | Purpose |
|---|---|---|
| `b402/v1/pq-intent` | intent hash |
| `b402/v1/pq-intent-req` | request root |
| `b402/v1/pq-intent-route` | routing root |
| `b402/v1/pq-auth-key` | optional Falcon-key registry hash |
| `b402/v1/pq-intent-json` | human-readable envelope serialization, if retained alongside the binary hash |

These tags are new and orthogonal to PRD-12 `action_hash`.

### 5.6 Relationship to `action_hash`

`action_hash` remains the protocol keystone for adapter extensibility.

PRD-24 does **not** replace it. Instead:

1. `action_hash` stays proof-bound and adapter-facing;
2. `intent_hash` becomes relayer-facing and user/agent-facing;
3. when the action is `adapt`, the relayer must verify that the signed
   intent corresponds to the exact `action_hash` embedded in the request.

For `adapt`, the canonical rule is:

```
intent_hash binds ix_data_hash_fr where ixData already contains the public-input
bytes that carry action_hash.
```

No second adapter-specific hash is introduced.

---

## 6. Wire format

### 6.1 Relay request extensions

Extend the relayer request body with:

```ts
{
  falconPubkey?: string,        // base64 or base58 canonicalized in spec
  falconSignature?: string,     // base64, 666-byte compressed Falcon-512 sig
  falconExpirySlot?: string,    // decimal u64
  falconNonce?: string          // 32-byte hex / base64 canonical nonce
}
```

Validation rules:

1. either all four fields are present or none are present;
2. signature must be Falcon-512 compressed format only;
3. pubkey must be Falcon-512 wire format only;
4. `falconExpirySlot` must be above current slot and within a configured horizon;
5. `(falconPubkey, falconNonce)` replay cache is enforced by the relayer.

### 6.2 Registry mode

If on-chain or server-side Falcon key registration is enabled, the request may
omit `falconPubkey` and instead carry a stable `authKeyId`. The relayer resolves
it to the registered Falcon pubkey before verification.

Registry lookup is an optimization, not a security primitive.

---

## 7. Verification modes

### 7.1 Mode A — relayer-only verification

Relayer verifies Falcon before signing.

Properties:

1. no pool or circuit changes;
2. immediate product value;
3. strongest fit for near-term rollout;
4. not consensus-critical.

Failure mode: a malicious relayer could ignore the Falcon requirement if the
user intentionally chooses that relayer.

### 7.2 Mode B — relayer verification + policy enforcement

Relayer verification is mandatory for a relayer tier or product surface:

1. "PQ agents" tier;
2. enterprise relayer;
3. high-value private execution.

Still off-chain, but operationally meaningful.

### 7.3 Mode C — on-chain verification

Add an optional on-chain Falcon verification path:

1. a verifier instruction checks the Falcon signature against a prepared pubkey;
2. the pool or a sibling program enforces that the verification succeeded in
   the same transaction.

This is more expensive and should be reserved for specific flows where
consensus-critical authorization matters.

PRD-24 does not require Mode C to ship first.

---

## 8. Compute and size budgets

Falcon on Solana is not free. This PRD therefore separates:

1. **default mode** — off-chain relayer verification, zero extra on-chain cost;
2. **selective mode** — on-chain verification only where the product gain justifies it.

Budget expectations for the selective mode:

1. prepared-pubkey verification is on the order of ~200k CU;
2. raw-pubkey verification is materially worse and should be avoided;
3. raw Falcon pubkey + signature are too large to inline casually in a dense
   Solana tx shape already constrained by ALT usage.

Therefore:

1. if on-chain verification is used, prepared pubkeys should be registered or
   stored in dedicated accounts;
2. the tx should pass only the signature and a reference to the prepared key.

---

## 9. Integration points

### 9.1 SDK

Add:

1. Falcon key import / generation helpers;
2. canonical intent-hash builder;
3. Falcon signing helpers;
4. request builders that attach Falcon auth material.

The SDK must keep Falcon auth orthogonal to:

1. Solana fee-payer key;
2. BN254 spending key;
3. X25519 viewing key.

### 9.2 Relayer

Add:

1. Falcon verification library integration;
2. replay cache keyed by `(falcon_pubkey_hash, nonce)`;
3. optional registry lookup for Falcon auth keys;
4. policy toggle: `requireFalconFor = { adapt, unshield, ... }`.

### 9.3 Pool / on-chain

No pool changes are required for Mode A.

If Mode C is later adopted:

1. add a small Falcon verifier program or sibling verification hook;
2. bind it to the same transaction via instructions sysvar or explicit CPI result.

---

## 10. Threat model

### 10.1 Defended

1. relay-request tampering between user and relayer;
2. replay across clusters or relayers;
3. weak API-key-only auth for autonomous agents;
4. compromised Solana fee-payer key not automatically implying control-plane auth.

### 10.2 Not defended

1. a malicious relayer refusing to submit;
2. a compromised Groth16 proving system;
3. quantum decryption of note ciphertexts;
4. forged note spends if the protocol core remains purely classical and is broken.

---

## 11. Rollout

### Phase A

1. SDK intent hashing;
2. relayer Falcon verification;
3. no on-chain changes.

### Phase B

1. Falcon auth-key registry;
2. replay cache and policy enforcement;
3. enterprise / agent-facing PQ intent product surface.

### Phase C

1. optional on-chain Falcon verify path;
2. selective use for high-assurance flows;
3. input to PRD-21 phase planning.

---

## 12. Open questions

1. Falcon pubkey encoding in API surface: base64 vs base58 vs hex. Lean: base64 for exact byte round-trip.
2. Whether intent canonicalization should reuse PRD-12 account hashing or define a narrower relay-specific scheme. Lean: reuse the same canonicalization rules where possible.
3. Whether registry mode should live in the relayer config only or in a dedicated PDA. Lean: off-chain first, on-chain only if multi-relayer interoperability becomes important.
4. Whether `shield` should support Falcon intent auth even though it still requires a depositor signature for SPL transfer. Lean: yes, as an additive control-plane signal.

---

## 13. Revision history

| Version | Date | Author | Changes |
|---|---|---|---|
| 0.1 | 2026-04-30 | b402 core | Initial draft. Defines Falcon-512 as a PQ intent-attestation layer for SDK + relayer, explicitly separate from PQ proof-system migration. |

---

## 14. Sign-off

| Role | Name | Date | Status |
|---|---|---|---|
| Protocol lead | | | |
| SDK lead | | | |
| Relayer lead | | | |
| Final approval | | | |

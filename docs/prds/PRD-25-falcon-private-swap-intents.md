# PRD-25 — Falcon-Signed Private Swap Intents

| Field | Value |
|---|---|
| **Status** | Draft |
| **Owner** | b402 core |
| **Date** | 2026-05-02 |
| **Version** | 0.1 |
| **Depends on** | PRD-12, PRD-23, PRD-24 |
| **Gates** | Demoable PQ-authenticated relayer flow for `privateSwap` |

---

## 1. Goal

Ship a narrow implementation of PRD-24 for one concrete user flow:

- `packages/sdk/src/b402.ts::privateSwap`
- through the HTTP relayer
- with Falcon-512 authorization of the exact relay request

The relayer must verify the Falcon signature before submission.

This PRD is intentionally scoped. It does **not**:

1. change pool semantics;
2. change circuits;
3. change note encryption;
4. add on-chain Falcon verification.

It adds a cryptographic authorization envelope for relayed private swaps.

---

## 2. User-visible behavior

When enabled, a private swap request carries:

1. a Falcon public key;
2. a Falcon signature;
3. an expiry slot;
4. a nonce.

The relayer reconstructs the canonical intent hash from the request body and
its own routing context, verifies the Falcon signature, and rejects the request
if verification fails.

The signed intent must bind the exact request that will be submitted.

---

## 3. Scope

### 3.1 In scope

1. SDK canonical intent hashing for private swaps.
2. SDK helper for attaching Falcon auth material to `/relay/adapt` requests.
3. Relayer schema support for Falcon envelope fields.
4. Relayer-side canonical intent reconstruction and Falcon verification.
5. Focused tests for acceptance, rejection, replay, and tamper cases.

### 3.2 Out of scope

1. Persistent Falcon key registry.
2. On-chain Falcon verification.
3. Falcon signing for `shield`, `unshield`, or `transact`.
4. Replacing or removing optional Ed25519 `userSignature`.

---

## 4. Canonical intent

### 4.1 Inputs

The canonical Falcon intent binds:

1. `label = "adapt"`
2. `cluster_id`
3. `pool_program_id`
4. `ixData`
5. normalized `accountKeys`
6. normalized `altAddresses`
7. `computeUnitLimit`
8. `relayer_pubkey`
9. `expiry_slot`
10. `nonce`

### 4.2 Normalized account-meta sequence

For canonical hashing:

1. account index `0` is encoded as role `relayer_slot`;
2. all remaining accounts are encoded as role `ordinary`;
3. each entry includes the pubkey bytes except the relayer slot;
4. each entry includes `isSigner` and `isWritable`.

This mirrors the current relayer behavior in `submit.ts`, where the relayer
replaces account `0` with its own pubkey.

### 4.3 ALT normalization

`altAddresses` are sorted lexicographically by base58 string before hashing.

### 4.4 Hash structure

The implementation should reuse PRD-24's structure:

```
request_root = Poseidon(
  DOMAIN_TAG_PQ_INTENT_REQ,
  keccak(ixData) mod Fr,
  keccak(normalized_account_keys) mod Fr,
  keccak(sorted_alt_addresses) mod Fr
)

routing_root = Poseidon(
  DOMAIN_TAG_PQ_INTENT_ROUTE,
  relayer_pubkey_fr,
  compute_unit_limit_fr,
  expiry_slot_fr,
  nonce_fr
)

intent_hash = Poseidon(
  DOMAIN_TAG_PQ_INTENT,
  action_kind_fr,      // adapt
  cluster_id_fr,
  pool_program_id_fr,
  request_root,
  routing_root
)
```

The Falcon signature is over the canonical 32-byte little-endian encoding of
`intent_hash`.

---

## 5. Relay request extension

Extend `RelayRequestSchema` with:

```ts
falconPubkey?: string
falconSignature?: string
falconExpirySlot?: string
falconNonce?: string
```

Rules:

1. either all four fields are present or none are present;
2. `falconPubkey` must decode to a Falcon-512 public key;
3. `falconSignature` must decode to a compressed Falcon-512 signature;
4. `falconExpirySlot` must parse as `u64`;
5. `falconNonce` must decode to exactly 32 bytes.

The first implementation may use base64 for both key and signature to avoid
base58 ambiguity and to match the current request transport style.

---

## 6. Verification policy

If Falcon fields are present, the relayer must:

1. parse and validate the envelope;
2. compute the canonical intent hash;
3. verify the Falcon signature;
4. reject if current slot is greater than `falconExpirySlot`;
5. reject if the nonce has already been seen within the configured replay window.

If Falcon fields are absent, behavior remains unchanged.

The nonce replay store may start as an in-memory cache for the demo, with a
clear note that distributed relayer deployments need shared storage.

---

## 7. SDK requirements

The SDK must expose a narrow helper for private swaps that:

1. derives the canonical intent hash from the final relay request shape;
2. signs the hash with a Falcon signer abstraction;
3. injects the Falcon envelope into the relayer HTTP request.

The helper must operate on the same exact bytes passed to the relayer.

This avoids split-brain bugs where the signed object differs from the submitted
request body.

---

## 8. Tests

### 8.1 Red tests before implementation

Add failing tests for:

1. schema accepts a request with all Falcon fields;
2. schema rejects any request with partial Falcon field presence;
3. canonical hashing ignores the concrete relayer pubkey in account slot `0`;
4. canonical hashing changes when any non-slot account changes;
5. canonical hashing changes when `ixData`, sorted ALT set, compute limit,
   expiry slot, or nonce changes;
6. relayer verification accepts a valid Falcon envelope;
7. relayer verification rejects mutated `ixData`;
8. relayer verification rejects expired requests.

### 8.2 Green implementation tests

After implementation, the above tests must pass without network access or RPC.

Use fixture bytes where possible so the Falcon verification path is deterministic.

---

## 9. Implementation plan

### 9.1 SDK

Add a new module for Falcon intent helpers, likely under `packages/sdk/src/`.

Responsibilities:

1. normalize request fields;
2. hash canonical request bytes;
3. attach Falcon envelope to relayer payloads.

### 9.2 Relayer

Add a new verification module under `packages/relayer/src/`.

Responsibilities:

1. parse Falcon envelope fields;
2. reconstruct canonical intent hash;
3. verify signature;
4. enforce expiry and nonce policy.

### 9.3 Wiring

The `/relay/adapt` route should call Falcon verification after schema parsing
and before tx assembly/submission.

---

## 10. Acceptance criteria

This PRD is satisfied when:

1. an SDK-built private swap request can carry Falcon auth material;
2. the relayer accepts a valid Falcon-signed request;
3. the relayer rejects a tampered request without submitting anything on-chain;
4. the relayer rejects expired or replayed requests;
5. the implementation adds no pool or circuit changes.

---

## 11. Future extensions

After this lands, follow-ons may include:

1. persistent nonce storage;
2. Falcon-signed `unshield` and `transact`;
3. optional on-chain Falcon verification mode;
4. Falcon auth-key registry PDA;
5. integration with encrypted intents from PRD-23.

# Phase 11 Spike — Falcon-Signed Private Jupiter Swap Intents

| Field | Value |
|---|---|
| **Status** | Spike complete |
| **Owner** | b402 core |
| **Date** | 2026-05-02 |
| **Version** | 0.1 |
| **Depends on** | PRD-12, PRD-23, PRD-24 |
| **Output** | Narrow implementation PRD for relayer-enforced Falcon auth on `privateSwap` |

---

## 1. Question

What is the highest-value, lowest-risk way to make Falcon intent attestation
real in `b402-solana` without changing the pool, circuits, or note model?

This spike answers that question for a single concrete flow:

- `privateSwap` through the Jupiter adapter,
- submitted through the HTTP relayer,
- with Falcon verification enforced by the relayer before it pays fees and
  submits the transaction.

The intended outcome is not "PQ-secure private pool." The intended outcome is:

- the relayer can prove a user or agent authorized this exact private swap;
- the authorization is bound to the economics and routing semantics already
  enforced by the proof and `action_hash`;
- replay and tampering are rejected before submission.

---

## 2. Current path

Today `packages/sdk/src/b402.ts::privateSwap()` does all economically relevant
work client-side:

1. selects the input note;
2. computes `adapterId`;
3. computes `payloadKeccakFr`;
4. computes `actionHash = Poseidon(adaptBindTag, keccak(actionPayload), outMintFr)`;
5. generates the adapt proof;
6. encodes `adapt_execute` instruction bytes;
7. submits the instruction to the relayer via `packages/sdk/src/relayer-http.ts`.

The relayer path today:

1. `packages/relayer/src/validate.ts` validates shape and size;
2. `packages/relayer/src/submit.ts` normalizes the relayer slot, signs, and submits;
3. the pool verifies the proof and executes the adapter CPI.

This already gives strong privacy and proof-bound execution semantics. What it
does not give is a standard cryptographic answer to:

- did the intended user or agent authorize this exact relay request?
- did anyone change `min_out`, fee recipient, expiry, or payload bytes?
- is this request being replayed across time or environments?

---

## 3. Why relayer-side Falcon verification is the correct first slice

This repo now has PRD-24, which defines Falcon as a control-plane attestation
layer. The spike confirms the best first implementation is **relayer-side only**.

Reasons:

1. no pool ABI changes are required;
2. no circuit changes are required;
3. no verifier ceremony changes are required;
4. no note-ownership semantics change;
5. the value is still real because the relayer is a genuine authority boundary.

Rejected as first slice:

1. on-chain Falcon verification inside the pool path;
2. Falcon as an in-circuit spend-authority primitive;
3. Falcon-bound notes.

All three are larger protocol changes. None is necessary to demonstrate real
value in the existing relayed private-swap architecture.

---

## 4. Threat model and value

### 4.1 What this prevents

If the relayer enforces a Falcon-signed intent envelope, it can reject:

1. a request whose `ixData` was altered after the user approved it;
2. a request replayed after expiry;
3. a request replayed with a different relayer or cluster;
4. a request where economically relevant routing fields no longer match the
   user's approval;
5. a request that came through valid transport auth but lacks valid user/agent
   cryptographic authorization.

### 4.2 What this does not prevent

This does not protect against:

1. Groth16 / BN254 compromise;
2. note confidentiality compromise;
3. relayer censorship;
4. a user intentionally authorizing a bad swap.

So the engineering value is **execution authorization hardening**, not core
protocol soundness migration.

---

## 5. Design boundary

The signed object should not be "raw JSON body" and should not be "just ixData."

It must bind enough information to prevent semantic drift while staying aligned
with the current request flow.

The narrowest viable binding for `privateSwap` is:

1. exact `ixData` bytes;
2. exact account-meta sequence after relayer-slot normalization;
3. exact ALT list;
4. relayer pubkey expected to submit;
5. compute-unit limit;
6. expiry slot;
7. nonce.

For `adapt`, this is sufficient because:

1. `ixData` already contains public inputs that bind `action_hash`;
2. `action_hash` already binds `keccak(actionPayload)` and `outMintFr`;
3. account metas and ALTs determine the adapter/program routing surface;
4. relayer routing fields prevent cross-relayer and stale replay.

No second swap-specific hash is needed in the first slice.

---

## 6. Canonicalization rules

The implementation should follow PRD-24's intent-hash model but narrow it to
one concrete route.

### 6.1 Normalized account metas

Hash account metas in exact instruction order after this normalization:

1. account index `0` is serialized as role `relayer_slot`, not as a concrete pubkey;
2. every other account is serialized as role `ordinary`;
3. signer and writable bits are serialized explicitly.

This is required because `submit.ts` overwrites account `0` with the relayer's
real pubkey at submission time.

### 6.2 ALT list

Sort ALT pubkeys ascending before hashing.

The request order is not economically meaningful, and sorting avoids accidental
mismatches from equivalent ALT sets.

### 6.3 Cluster id

Use an explicit cluster discriminator in the signed envelope.

The implementation PRD should encode this as a small enum:

1. `mainnet-beta`
2. `devnet`
3. `testnet`
4. `localnet`

### 6.4 Expiry and nonce

Both are mandatory.

`expiry_slot` prevents stale replay. `nonce` prevents replay within the valid
slot horizon.

---

## 7. Minimal wire extension

The current relay request already supports optional `userSignature` / `userPubkey`
for Ed25519. The Falcon path should be parallel, not overloaded onto those fields.

Minimal extension:

```ts
falconPubkey?: string
falconSignature?: string
falconExpirySlot?: string
falconNonce?: string
```

All-or-none presence rule:

1. all four fields absent => current behavior;
2. all four fields present => Falcon verification path;
3. partial presence => reject at schema layer.

The first slice should keep pubkey transport self-contained in each request.
No registry dependency is required for the demo.

---

## 8. Real-world demo shape

The best world-facing demo is:

1. client builds a private Jupiter swap;
2. SDK computes Falcon intent hash over the final relay request surface;
3. client signs it with Falcon;
4. relayer verifies Falcon before submission;
5. a modified request fails before any transaction is sent.

The most compelling failure case is economic tampering:

1. sign a valid request;
2. change `actionPayload` or `ixData` so `min_out` / route semantics drift;
3. relayer rejects with Falcon verification failure.

This demonstrates value immediately without changing on-chain state semantics.

---

## 9. Recommended implementation order

### 9.1 Docs

1. add a narrow PRD for Falcon private-swap intents;
2. keep the claim limited to relayer-enforced control-plane auth.

### 9.2 Tests first

Write failing tests for:

1. schema accepts all-or-none Falcon fields;
2. schema rejects partial Falcon field presence;
3. canonical request hashing is stable under relayer slot replacement;
4. canonical request hashing changes when any non-slot account meta changes;
5. canonical request hashing changes when `ixData`, ALT set, expiry, nonce, or
   relayer pubkey changes.

### 9.3 Minimal implementation

1. add a Falcon intent module in the SDK for canonicalization + signing;
2. extend `relayer-http.ts` to carry the envelope;
3. add relayer-side canonicalization + signature verification;
4. enforce verification only when Falcon fields are present.

### 9.4 Demo script

After the core implementation lands, add a focused script or test that:

1. signs a private swap intent;
2. verifies it successfully;
3. mutates one bound field and proves rejection.

---

## 10. Recommendation

Proceed with a narrow PRD and implementation for:

- `privateSwap`,
- HTTP relayer path,
- optional Falcon envelope on the relay request,
- relayer-side verification only.

This is the smallest slice that:

1. delivers real execution-authorization value;
2. stays aligned with PRD-24;
3. avoids protocol churn;
4. produces a credible public demo.

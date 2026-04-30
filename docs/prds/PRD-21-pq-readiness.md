# PRD-21 — PQ-Readiness Migration Path

| Field | Value |
|---|---|
| **Status** | Forward — designed-for, ship-later |
| **Owner** | b402 core |
| **Date** | 2026-04-30 |
| **Version** | 0.2 |
| **Depends on** | PRD-01, PRD-02, PRD-03, PRD-06, PRD-24 |
| **Gates** | protocol-level post-quantum migration; truthful PQ positioning |

> Forward PRD: not implemented in v1 or v2. The v1/v2 architecture **must not preclude this.**

---

## 1. Purpose

Define what "post-quantum readiness" means for b402-solana, and separate it into
the three cryptographic layers that matter:

1. **authorization** — who authorized an action;
2. **soundness / spend validity** — what cryptographic statement the chain accepts;
3. **confidentiality** — what data remains unreadable to a future quantum adversary.

This separation is non-negotiable. Without it, the protocol risks making claims
that are true for one layer but false for the system as a whole.

---

## 2. Executive summary

Today, b402-solana is **not post-quantum secure**.

Why:

1. spend validity is rooted in **Groth16 over BN254**;
2. note confidentiality is delivered via **X25519 + ChaCha20-Poly1305**;
3. spend authority inside the current circuit is a **BN254-field preimage** model,
   not a PQ signature model.

What can be added sooner:

1. **Falcon-signed intents** for relayer-facing authorization, specified in PRD-24.

What that does **not** mean:

1. Falcon intent attestation does **not** make the pool itself PQ-secure;
2. it does **not** prevent pool compromise if Groth16 / BN254 soundness breaks;
3. it does **not** preserve note confidentiality against a future quantum attacker.

Therefore the roadmap is staged:

1. PQ-authenticated intents first;
2. protocol-level dual-attestation next, if economically justified;
3. PQ note confidentiality migration;
4. PQ validity / proof migration.

Only the last two justify strong "post-quantum private pool" language.

---

## 3. Current cryptographic baseline

### 3.1 Authorization layer

Current system:

1. relayer auth is API-key based;
2. optional user signature transport is Ed25519 in the relayer path;
3. the protocol's real spend authority is proved in-circuit from knowledge of
   `spendingPriv` in BN254 `Fr`.

Observation:

The control plane can be hardened independently of the custody plane.

### 3.2 Soundness layer

Current system:

1. `b402-verifier-transact` and `b402-verifier-adapt` accept Groth16 proofs;
2. verification keys are embedded in immutable verifier programs;
3. successful proof verification is the consensus-critical spend gate.

Observation:

If Groth16 soundness fails or BN254 becomes tractable enough to attack, the pool
is forgeable regardless of any outer Falcon signature layer.

### 3.3 Confidentiality layer

Current system:

1. note delivery uses X25519 ECDH;
2. encryption key derivation uses HKDF-SHA256;
3. note payload encryption uses ChaCha20-Poly1305.

Observation:

This is classical confidentiality. A store-now-decrypt-later adversary is part
of the PQ threat model and is not addressed by a Falcon intent layer.

---

## 4. Terminology rules

These rules are binding on engineering, docs, and marketing.

### 4.1 Allowed phrases

1. "PQ-ready roadmap"
2. "Falcon-signed private-action intents"
3. "post-quantum authenticated control plane"
4. "designed not to preclude a PQ migration"

### 4.2 Disallowed phrases unless later phases ship

1. "post-quantum pool"
2. "quantum-resistant private DeFi"
3. "PQ-secure shielded custody"
4. "post-quantum privacy on Solana"

Those claims require more than PRD-24.

---

## 5. Design goals

### 5.1 Goal A — near-term, low-risk

Add a PQ signature layer for relayer-facing authorization without changing:

1. circuits;
2. note commitments;
3. verifier programs;
4. note encryption.

This is PRD-24.

### 5.2 Goal B — medium-term, protocol hardening

Introduce a **consensus-critical second authorization primitive** such that a
break in one primitive does not immediately imply spend forgery.

This is substantially harder than adding an outer Falcon signature because the
second primitive must be bound to what the pool considers note ownership or spend rights.

### 5.3 Goal C — long-term, real PQ migration

Replace or augment both:

1. classical confidentiality mechanisms;
2. classical validity / proof mechanisms.

Only after Goal C can the protocol claim end-to-end PQ security properties.

---

## 6. Architecture constraints already present

### 6.1 Helpful existing properties

The current codebase already has several useful seams:

1. verifier program IDs are stored in pool config and the pool already supports
   separate verifier slots;
2. `action_hash` and proof-bound request fields already give a stable object to
   authenticate externally;
3. the relayer path already carries optional second-signer data and can enforce
   richer policy before submission;
4. the SDK is already responsible for witness construction and request assembly.

These make PRD-24 straightforward.

### 6.2 Missing properties

The current protocol does **not** yet have:

1. a PQ auth key committed into note semantics;
2. a PQ KEM for note delivery;
3. a PQ proof or validity primitive accepted by consensus;
4. a migration mechanism that lets legacy and PQ-native notes coexist with
   unambiguous spend rules.

These are the actual hard parts.

---

## 7. Migration stages

### Stage 0 — truthful readiness

Outcome:

1. tighten docs so "PQ-ready" means "architecturally designed for staged migration";
2. explicitly separate signatures, proof systems, and confidentiality.

Deliverables:

1. this PRD;
2. PRD-24;
3. marketing/docs guidance.

### Stage 1 — PQ intent attestation

Outcome:

1. users or agents sign relay intents with Falcon-512;
2. relayers verify Falcon before signing and submitting.

Properties:

1. no circuit change;
2. no note migration;
3. no on-chain PQ guarantee;
4. immediate product value.

This stage is specified in PRD-24.

### Stage 2 — protocol-level dual attestation

Outcome:

A spend or adapt action requires:

1. the existing Groth16 proof; and
2. a second, consensus-critical PQ authorization check.

Important:

This is only meaningful if the PQ authorization primitive is tied to spend
rights, not merely to the relayer request envelope.

Naive outer-signature designs are insufficient. If note ownership remains purely
BN254- and Groth16-defined, a forged proof can still drain funds even if Falcon
is used at the relayer edge.

This stage therefore requires at least one of:

1. a PQ auth public key or auth root committed into note data or policy data;
2. a protocol rule that each spend must satisfy both the current witness relation
   and a second PQ-auth relation over the same note set;
3. a new note version whose commitment semantics include a PQ authorization field.

This is a protocol change, not a relayer feature.

### Stage 3 — PQ confidentiality migration

Outcome:

Replace X25519 note delivery with a PQ-safe key exchange / KEM.

Minimum requirement:

1. a store-now-decrypt-later adversary should not be able to recover note
   plaintexts from ciphertexts logged today.

This implies:

1. new note-encryption envelope;
2. wallet and scanner changes;
3. coexistence rules for old and new ciphertext formats.

### Stage 4 — PQ validity / proof migration

Outcome:

Consensus-critical validity no longer depends solely on BN254 Groth16.

Candidate directions:

1. STARK-family system with acceptable Solana verification economics;
2. a hybrid construction where legacy Groth16 is retained for compatibility but
   a second PQ-safe validity primitive is required for new notes;
3. a future proof system with mature Solana verifier support.

This is the real long pole.

---

## 8. Why Falcon is in scope, and why it is not enough

Falcon belongs in the roadmap because:

1. it is a practical PQ signature primitive;
2. it fits the relayer / agent control plane well;
3. it has a viable Solana verification story.

Falcon is **not** sufficient because:

1. signatures do not replace a SNARK verifier;
2. signatures do not replace a KEM for note confidentiality;
3. signatures do not retroactively bind existing notes to a PQ auth key.

Therefore:

1. PRD-24 is a valid PQ-hardening step;
2. PRD-24 is not the completion of PRD-21.

---

## 9. Hard requirements for any future "PQ-secure" claim

Before b402 may claim protocol-level PQ security, all of the following must be true:

1. new spends do not rely solely on BN254 Groth16 for consensus-critical validity;
2. new notes are not confidential solely via X25519;
3. authorization of new spends is bound to a PQ-safe primitive at the protocol layer;
4. legacy-note handling is explicitly documented, including whether legacy notes
   remain only classically secure or must be migrated.

If any item above is false, the claim must be downgraded.

---

## 10. Preferred sequence

The preferred engineering sequence is:

1. PRD-24 Falcon intent attestation;
2. relayer policy tiers that can require Falcon for selected flows;
3. design note for PQ note-encryption migration;
4. design note for note-bound PQ auth semantics;
5. design note for PQ validity / proof migration.

This order optimizes for:

1. near-term product value;
2. minimal disruption to the existing protocol;
3. truthful communications.

---

## 11. Open questions

1. Which PQ KEM should replace X25519 for note delivery when Stage 3 begins?
2. Should PQ authorization be a dedicated note field, or should it enter through
   a future `policy_root` mechanism?
3. Is the eventual validity migration a second proof, a proof replacement, or a
   proof-plus-signature construction for new notes?
4. How much on-chain compute is acceptable for consensus-critical PQ verification
   on Solana mainnet?

---

## 12. Revision history

| Version | Date | Author | Changes |
|---|---|---|---|
| 0.1 | 2026-04-26 | b402 core | Initial sketch. Mixed PQ signatures and PQ verifiers under one heading. |
| 0.2 | 2026-04-30 | b402 core | Rewritten to separate authorization, soundness, and confidentiality; adds staged migration model and explicit dependency on PRD-24. |

---

## 13. Sign-off

| Role | Name | Date | Status |
|---|---|---|---|
| Protocol lead | | | |
| Circuit lead | | | |
| SDK lead | | | |
| Final approval | | | |

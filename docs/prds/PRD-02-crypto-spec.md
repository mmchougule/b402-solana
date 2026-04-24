# PRD-02 — Cryptographic Specification

| Field | Value |
|---|---|
| **Status** | Draft — awaiting review |
| **Owner** | b402 core |
| **Date** | 2026-04-23 |
| **Version** | 0.1 |
| **Gates** | PRD-03 (Anchor Program Spec), PRD-07 (Testing) |
| **Depends on** | PRD-01 (signed off), PRD-01-A (signed off) |

This document is the auditor's reference. It specifies every primitive, parameter, derivation, and circuit with enough precision that two independent implementations would produce byte-identical commitments, nullifiers, and proofs.

Where PRD-01 stated a choice in prose, this PRD states it in math.

---

## 0. Conventions

- **Field:** BN254 scalar field `Fr`, prime `p = 21888242871839275222246405745257275088548364400416034343698204186575808495617`.
- **Field element encoding:** little-endian 32-byte buffer, canonical (`x < p`). Rejected if `x ≥ p`.
- **Concat:** `A || B` is byte concatenation.
- **Integer types:** `u64` is a 64-bit unsigned integer. Values `> 2^64 - 1` are rejected at circuit input.
- **Poseidon:** `H(...)` refers to the Poseidon hash defined in §1.1.
- **Curve25519:** used for viewing key ECDH only. Not mixed with BN254 arithmetic.
- **Pubkey:** Solana `Pubkey`, 32 bytes, base58-decoded.
- **Hex values:** all domain tags and ceremony hashes are lowercase hex with `0x` prefix.

Endianness within circuit signals follows the Circom convention: field elements as native `Fr`, byte arrays as arrays of `Fr` representing 8-bit values.

---

## 1. Primitive specifications

### 1.1 Poseidon hash

**Parameters (fixed across all usages):**
- Field: BN254 `Fr`.
- S-box: `x^5`.
- Security: 128 bits.
- Widths supported: `t ∈ {2, 3, 5, 6}`, i.e. Poseidon_2, Poseidon_4, Poseidon_5. Arity of the hash = `t - 1`.
- Rounds per width (from Poseidon reference paper / circomlib `poseidon.circom`):
  - `t=2`: 8 full + 56 partial
  - `t=3`: 8 full + 57 partial
  - `t=5`: 8 full + 60 partial
  - `t=6`: 8 full + 60 partial
- Round constants and MDS matrix: exactly those in `iden3/circomlib@v2.4.0` (`circuits/poseidon_constants.circom`). We freeze this commit and include the artifact hash in §10.

**Canonical reference implementation for parity testing:** `iden3/go-iden3-crypto` `poseidon` package for Go, `arkworks-rs/poseidon` for Rust. Both must match `circomlib/poseidon.circom` bit-for-bit on all test vectors in §11.

**Usage rules:**
- For a hash of arity `k`, use width `t = k + 1`. First input slot (`state[0]`) is set to 0, remaining slots receive the `k` preimage elements.
- Domain separation uses `k+1`-arity Poseidon with a constant domain tag as the first element (see §1.2).

**Not supported in v1:** Poseidon2, Poseidon-X. Sticking to one hash to keep the audit surface minimal.

### 1.2 Domain tags

Every Poseidon hash in b402 uses a per-purpose domain tag prepended. Tags are ASCII strings embedded as `Fr` by interpreting the UTF-8 bytes as a big-endian integer (always well under `p` because tags are ≤ 31 bytes). Tags are defined once here:

| Domain | Tag string | Purpose |
|---|---|---|
| `b402/v1/commit` | commitment hash |
| `b402/v1/null` | nullifier hash |
| `b402/v1/mk-node` | merkle internal node |
| `b402/v1/mk-zero` | merkle zero-subtree anchor |
| `b402/v1/note-enc-key` | note encryption key derivation |
| `b402/v1/spend-key` | spending private key derivation from seed |
| `b402/v1/view-key` | viewing private key derivation from seed |
| `b402/v1/viewtag` | viewing-tag derivation for scan optimization |
| `b402/v1/fee-bind` | relayer fee recipient binding |
| `b402/v1/root-bind` | recent-root binding |
| `b402/v1/adapt-bind` | adapter action binding |
| `b402/v1/disclose` | disclosure circuit input binding |

These strings are byte-literal in the circuit and in every reference impl. Changing any is a breaking protocol change.

### 1.3 Note encryption (ChaCha20-Poly1305 AEAD)

- **Cipher:** ChaCha20-Poly1305, RFC 7539/8439.
- **Key:** 32 bytes derived per §4.2.
- **Nonce:** 12 bytes, first 8 bytes = little-endian `leafIndex`, last 4 bytes = 0. Nonce uniqueness is ensured because leafIndex is monotonic and never reused.
- **Associated data:** fixed string `b402-note-v1`.
- **Plaintext:** 73 bytes (see §3.3).
- **Ciphertext:** 73 + 16 (tag) = 89 bytes.

### 1.4 Viewing key ECDH (X25519)

- Curve25519 scalar multiplication per RFC 7748.
- Used only to derive `sharedSecret = X25519(ephemeralPriv, viewingPub)` for note encryption.
- Viewing pubkey is 32 bytes Curve25519. Separate from spending key (BN254-based).

### 1.5 Groth16 over BN254

- Proof: `(A, B, C)` with `A, C ∈ G1`, `B ∈ G2`. On-wire 256 bytes after compression (two 32-byte G1 + one 64-byte G2 compressed via Solana syscall conventions, per `groth16-solana` format).
- Verifier: Solana program wrapping `Lightprotocol/groth16-solana v0.x` (pinned in §10).
- Verification key: per circuit. Hard-coded into the verifier program at build time. Not upgradable.

---

## 2. Key hierarchy

### 2.1 Seed

A user seed is 32 bytes of uniform randomness. Typically derived from a BIP-39 mnemonic via a Solana-compatible derivation path. Derivation path for b402-solana: `m/44'/501'/0'/0'/b402'` (501 is Solana's SLIP-44 coin type). The terminal `b402'` is `0x62343032` as a hardened child index.

### 2.2 Spending key

```
spendingPriv = Poseidon_2("b402/v1/spend-key", seed_as_field) mod p
```

Where `seed_as_field` = the 32 seed bytes interpreted as a little-endian integer, then reduced mod `p`.

```
spendingPub  = Poseidon_2("b402/v1/spend-key-pub", spendingPriv)
```

**Important:** this is not ECDSA or any curve-based signature scheme. `spendingPriv` and `spendingPub` are field elements in `Fr`. The "signature" of spend authority is proven in-circuit by demonstrating knowledge of the preimage of `spendingPub`. No on-chain signature verification of a spending key ever occurs.

### 2.3 Viewing key

```
viewingSeed   = SHA512("b402/v1/view-key" || seed)[0..32]
viewingPriv   = clamp(viewingSeed) as X25519 scalar  (per RFC 7748)
viewingPub    = X25519(viewingPriv, basepoint)
```

Viewing key is Curve25519 because we need ECDH for note encryption. Spending key lives in BN254 because it must be cheap inside the SNARK. They never mix.

### 2.4 Viewing tag (scan optimization)

To let a wallet skip notes not addressed to it without full decryption, each on-chain ciphertext is accompanied by a **viewing tag**:

```
viewingTag = Poseidon_2("b402/v1/viewtag", sharedSecret_as_field)[0..2]   // 16 bits
```

A wallet scanning N ciphertexts computes the 16-bit tag candidate from its own viewing key + per-note ephemeral pubkey and skips mismatches. Expected false-positive rate 1/65,536. Cuts scan time by ~65k on average.

---

## 3. Note structure

### 3.1 Clear (in-circuit and wallet) layout

```
Note {
  tokenMint:     Fr  (32B — Solana mint pubkey encoded as Fr; see §3.4)
  value:         Fr  (u64, range-checked 0 ≤ value < 2^64)
  random:        Fr  (32B uniformly random; the note's blinding)
  spendingPub:   Fr  (recipient's spending pubkey)
}
```

### 3.2 Commitment

```
commitment = Poseidon_5("b402/v1/commit", tokenMint, value, random, spendingPub)
```

Size: 32 bytes (one `Fr`).

### 3.3 On-chain encrypted payload (89 bytes)

Transmitted inside the Solana transaction that creates the note so the recipient can decrypt and discover it. Structure before encryption (73 B):

| Field | Size | Notes |
|---|---|---|
| `value` | 8 B | u64 little-endian |
| `random` | 32 B | Fr canonical bytes |
| `tokenMint` | 32 B | Solana mint pubkey (raw 32B, not field-encoded) |
| `version` | 1 B | currently `0x01` |

Encrypted with ChaCha20-Poly1305 per §1.3 → 89 B on chain. Accompanied by:
- `ephemeralPub` (32 B Curve25519)
- `viewingTag` (2 B)

Total per-note on-chain overhead: 32 (commitment) + 89 (ciphertext) + 32 (ephemeralPub) + 2 (viewingTag) = **155 bytes**. Fits with room in Solana's transaction size budget.

### 3.4 Token mint encoding

Solana `Pubkey` is 32 bytes. Not all 32-byte values are valid `Fr` (values ≥ p are out of range). We encode the mint for circuit use as:

```
tokenMint_Fr = mint_bytes_as_LE_integer mod p
```

Collisions across mints require finding two mints whose 256-bit little-endian values differ only by a multiple of `p`. `p ≈ 2^253.99`, so the top ~2 bits of the pubkey are the only region where wrap occurs. Probability of pre-image collision via birthday attack over valid mints is negligible, but to be safe we maintain an on-chain `TokenConfig` PDA keyed by the raw mint bytes and additionally embed the raw mint in the PDA state. Circuit verifies `tokenMint_Fr = compute(mint)` against the PDA's stored mint, preventing any aliasing.

### 3.5 Nullifier

```
nullifier = Poseidon_3("b402/v1/null", spendingPriv, leafIndex)
```

Where `leafIndex` is the 0-based position of the commitment in the merkle tree's append order, encoded as `Fr`.

**Critical properties:**
- Only the holder of `spendingPriv` can compute the nullifier for their note (since spendingPriv is secret).
- `nullifier` is deterministic given (spendingPriv, leafIndex) — spending the same note twice yields the same nullifier, caught by the on-chain nullifier set.
- `nullifier` is unlinkable to `commitment` without `spendingPriv`.
- Different notes owned by the same user produce different nullifiers (different leafIndex), so knowing one nullifier does not leak others.

---

## 4. Note delivery and scanning

### 4.1 Ephemeral key

Per note, sender generates a fresh Curve25519 scalar `ephPriv`, computes `ephPub = X25519(ephPriv, basepoint)`. `ephPub` is published on-chain.

### 4.2 Encryption key

```
sharedSecret  = X25519(ephPriv, recipientViewingPub)      // 32 B
encryptKey    = HKDF-SHA256(sharedSecret, salt="b402-note-enc-v1", info="", out=32B)
```

HKDF used instead of Poseidon here because the key targets ChaCha20 (a non-algebraic cipher); stay in the byte-oriented hash family.

### 4.3 Wallet scan algorithm

On each new on-chain commitment event:
1. Compute candidate `sharedSecret = X25519(myViewingPriv, ephPub)`.
2. Compute candidate `viewingTag = Poseidon_2("b402/v1/viewtag", sharedSecret_as_field)[0..2]`.
3. If candidate mismatches published tag: skip (fast path).
4. Else: derive `encryptKey`, attempt ChaCha20-Poly1305 decrypt. If AEAD tag invalid: skip.
5. Else: decode `Note`, verify `commitment = Poseidon_5(…)` matches on-chain commitment, verify `spendingPub` corresponds to our spending key. If all pass: note is ours, index it.

### 4.4 Lost note recovery

A note whose ciphertext is malformed or whose ephemeralPub was corrupted cannot be decrypted. **Funds are not lost** — the `commitment` is on-chain and the sender, if honest, knows `(tokenMint, value, random, spendingPub)`. Out-of-band recovery: sender retransmits the clear note to the recipient. Recipient can verify by re-hashing and spend as normal.

---

## 5. Merkle tree

### 5.1 Parameters

- **Arity:** 2 (binary).
- **Depth:** 26. Capacity 2^26 = 67,108,864 leaves.
- **Hash:** Poseidon_3 with domain tag `b402/v1/mk-node`.
  - `parent = Poseidon_3("b402/v1/mk-node", left, right)`
- **Leaf:** commitment `Fr` (§3.2). No additional hash at the leaf level.

### 5.2 Zero subtree

For an empty tree, each level has a well-defined zero-value:

```
zero[0]   = Poseidon_1("b402/v1/mk-zero")          // 1-arity Poseidon of domain tag; t=2 with 0 in state[0]
zero[i+1] = Poseidon_3("b402/v1/mk-node", zero[i], zero[i])
```

`zero[26]` is the empty-tree root. Circuit hardcodes `zero[0..26]` as constants. Reference values in §11 test vectors.

### 5.3 On-chain state

Single PDA `TreeState`:

```rust
pub struct TreeState {
    pub root_ring: [Fr; 64],          // most recent 64 roots (oldest overwritten)
    pub ring_head: u8,                // index of newest root
    pub leaf_count: u64,              // next leaf index to append
    pub frontier: [Fr; 26],           // right-most path hashes, each level
    pub zero_cache: [Fr; 26],         // zero[0..26]; redundant with const but avoids recompute
}
```

Total size: `64*32 + 1 + 8 + 26*32 + 26*32 = 2048 + 1 + 8 + 832 + 832 = 3721 B`. One PDA, never shards.

### 5.4 Append algorithm (concurrent-safe)

When a new leaf is appended:
1. `idx = leaf_count`.
2. `hash = leaf`.
3. For level `l` in `0..26`:
   - If bit `l` of `idx` is 0: write `hash` to `frontier[l]`, then `hash = Poseidon_3(tag, hash, zero[l])`. Break — higher levels unchanged for this path.
   - If bit `l` of `idx` is 1: `hash = Poseidon_3(tag, frontier[l], hash)`.
4. New root = `hash`.
5. `root_ring[(ring_head + 1) % 64] = new_root`; `ring_head = (ring_head + 1) % 64`.
6. `leaf_count += 1`.

Concurrent appends within a block are sequenced by Solana's single-writer-per-account rule — each append acquires a write lock on `TreeState`. No explicit CMT changelog needed because write ordering is enforced by Solana runtime. If this proves a throughput bottleneck (see PRD-07 benchmarks), migrate to Light's CMT per PRD-01-A §A3.

### 5.5 Root validity for proofs

A proof references a root. On-chain verification accepts the root if it appears in `root_ring[]`. Stale roots (older than 64 appends) are rejected; user regenerates against a more recent root.

### 5.6 Merkle path

Circuit receives the path as `(sibling[0..26], pathBits[0..26])`. Verifies:

```
cur = leaf
for l in 0..26:
    if pathBits[l] == 0:
        cur = Poseidon_3(tag, cur, sibling[l])
    else:
        cur = Poseidon_3(tag, sibling[l], cur)
assert cur == publicRoot
```

26 × Poseidon_3 ≈ 26 × 240 ≈ 6,240 constraints for the merkle step per proven input.

---

## 6. Circuits

### 6.1 Overview

v1 defines **one core circuit family**, specialized to three operations by public-input layout:

- `transact(N=2, M=2)` — spend ≤ 2 notes, create ≤ 2 notes. Covers shield (1→2, with one dummy input), unshield (2→1 with one dummy output + clear-value output), and internal transfer (2→2).

Plus one auxiliary:

- `adapt` — atomic composability (see §6.3).

Plus one optional:

- `disclose` — opt-in viewing-key disclosure (see §6.4).

### 6.2 The `transact` circuit

**Arity choice:** N=2 in, M=2 out. Sufficient for shield/unshield/transfer. Higher arities can be added post-v1 behind a new circuit variant and VK.

**Public inputs (all ∈ Fr):**

| # | Name | Meaning |
|---|---|---|
| 0 | `merkleRoot` | tree root the proof is valid against |
| 1 | `nullifier[0]` | first spent note's nullifier |
| 2 | `nullifier[1]` | second spent note's nullifier (or zero sentinel) |
| 3 | `commitmentOut[0]` | first created note's commitment |
| 4 | `commitmentOut[1]` | second created note's commitment (or zero sentinel) |
| 5 | `publicAmountIn` | clear amount flowing into pool (shield). 0 for internal/unshield. |
| 6 | `publicAmountOut` | clear amount flowing out of pool (unshield). 0 for internal/shield. |
| 7 | `publicTokenMint` | mint of the clear amount (must match note token for shield/unshield; 0 if none) |
| 8 | `relayerFee` | amount routed to relayer's fee recipient (same mint as public amount if unshield; 0 for shield) |
| 9 | `relayerFeeBind` | `Poseidon_2("b402/v1/fee-bind", relayerFeeRecipientPubkey_as_Fr, relayerFee)` |
| 10 | `rootBind` | `Poseidon_2("b402/v1/root-bind", merkleRoot, blockExpiry)` — optional freshness bind, omitted if unused |

**Private inputs:**

```
for i in 0..2:
    inNote[i] = { tokenMint, value, random, spendingPub, spendingPriv, leafIndex, sibling[0..26], pathBits[0..26], isDummy }
for j in 0..2:
    outNote[j] = { tokenMint, value, random, spendingPub, isDummy }
```

**Constraints (high-level):**

1. **Spend note well-formedness and ownership (each i in 0..2):**
    - If `isDummy`: all checks skip via selector; `nullifier[i]` public input must equal 0.
    - Else:
      - `commitmentIn = Poseidon_5(commitTag, inNote.tokenMint, inNote.value, inNote.random, inNote.spendingPub)`
      - Verify merkle path from `commitmentIn` to `merkleRoot` using `sibling[]` and `pathBits[]`.
      - `spendingPub = Poseidon_2("b402/v1/spend-key-pub", inNote.spendingPriv)` — proves ownership.
      - `nullifier[i] = Poseidon_3(nullTag, inNote.spendingPriv, inNote.leafIndex)`.
      - `inNote.value < 2^64` (range check).

2. **Create note well-formedness (each j in 0..2):**
    - If `isDummy`: `commitmentOut[j] = 0` and selector zeroes value contributions.
    - Else:
      - `commitmentOut[j] = Poseidon_5(commitTag, outNote.tokenMint, outNote.value, outNote.random, outNote.spendingPub)`
      - `outNote.value < 2^64`.
      - `outNote.spendingPub ≠ 0`.

3. **Token consistency:** all non-dummy input and output notes carry the same `tokenMint`. If `publicAmountIn > 0` or `publicAmountOut > 0`, that mint matches as well.

4. **Balance conservation:**
    ```
    Σ inNote[i].value (non-dummy) + publicAmountIn
      ==
    Σ outNote[j].value (non-dummy) + publicAmountOut + relayerFee
    ```
    Enforced as an `Fr` equality. Because values are `< 2^64` and we have at most 4 terms, there is no wrap concern (4 × 2^64 ≪ p).

5. **Public amount exclusivity:** not both `publicAmountIn > 0` and `publicAmountOut > 0`. Asserted via `publicAmountIn * publicAmountOut == 0`.

6. **Relayer fee binding:** if `relayerFee > 0`, `relayerFeeBind` public input must match `Poseidon_2(feeBindTag, relayerFeeRecipientPubkey_as_Fr, relayerFee)` where the recipient is a private input. This prevents a relayer from rewriting the recipient after the fact.

7. **Nullifier ordering:** to canonicalize duplicate-nullifier detection in the on-chain set, we require `nullifier[0] ≤ nullifier[1]` (with sentinel 0 sorting first). Prevents a user from getting two valid encodings of the same transaction.

**Estimated constraint count:** ~32,000 R1CS. Proof gen time 500 ms – 2 s on modern desktop (Circom → Groth16 via snarkjs / rapidsnark).

### 6.3 The `adapt` circuit

Identical to `transact` *plus* binding of an adapter action.

**Additional public inputs:**

| # | Name | Meaning |
|---|---|---|
| +0 | `adapterId` | identifier of which registered adapter |
| +1 | `actionHash` | `Poseidon_2(adaptBindTag, actionPayload_hash, expectedOutMint_Fr)` |
| +2 | `expectedOutValue` | minimum token received (slippage bound) |

**Semantics:** the circuit commits that the pool will call `adapter[adapterId]` with the payload whose hash is `actionHash`, and will only mint `commitmentOut[j]` if the adapter returns at least `expectedOutValue` of the expected mint. On-chain program enforces the actual CPI and checks the returned balance.

**Critical invariant:** this circuit does **not** prove that the adapter behaves correctly. It proves that the shielded state transition is valid **conditional on** the on-chain program enforcing the adapter's output. If the program code is buggy or the adapter is compromised, a note of the wrong mint or value could be appended. Adapter trust boundary is enforced in the program (PRD-03), not the circuit.

### 6.4 The `disclose` circuit (optional)

Proves: "I own notes whose commitments are `C_1, ..., C_k`, and here are their cleartext contents."

**Public inputs:**
- `merkleRoot`, `commitments[]`, `disclosedValues[]`, `disclosedMints[]`, `disclosedTotal`, `scopeHash`.

**Private inputs:**
- `spendingPrivs[]`, merkle paths, `randoms[]`.

**Constraints:** standard commitment recompute + merkle inclusion + ownership (as §6.2). Outputs the cleartext `(value, mint)` for each.

Produced client-side on demand for auditors. Not required for any pool state change. Separate VK, independent of `transact` / `adapt`.

---

## 7. Trusted setup

### 7.1 Phase 1

**Source:** Perpetual Powers of Tau (PPoT) — `privacy-scaling-explorations/perpetualpowersoftau` ceremony.

**Pinned transcript:** the `Final` attestation at contribution **N=76** (TBD; pick a recent, widely-attested contribution). Hash in §10 once pinned.

**Reuse rationale:** PPoT has 75+ contributors, multiple from named public organizations. Reusing it is standard practice and eliminates the need to run our own Phase-1.

### 7.2 Phase 2

**Process:** Groth16 Phase-2 (circuit-specific) per `iden3/snarkjs` `zkey` ceremony commands.

**Contributors (minimum 3, tentative — close in PRD-08):**
1. b402 core (in-house).
2. An external organization with no financial interest in b402 (candidates: Privacy & Scaling Explorations, Light Protocol, Kohaku contributors, Aztec Labs).
3. A notable individual ZK researcher.

**Ceremony rules:**
- Each contributor contributes on an air-gapped machine, generates random entropy from multiple hardware sources, destroys the machine post-contribution.
- Public transcript with SHA-256 chain: each contribution's output hash is published, chained into the next.
- Coordinator (separate from contributors) collates and publishes final `zkey` + `verificationKey.json`.
- Final VK hash is hardcoded into `b402_verifier` program at build time.
- Ceremony archive (all intermediate files + transcripts + attestation signatures) published on-chain (IPFS pin + Arweave permanent) before mainnet launch.

### 7.3 Rollover policy

A circuit change requires a fresh Phase-2 ceremony. No "trust me" upgrades.

---

## 8. Security reductions and known-weak assumptions

- **Soundness of transact** reduces to Groth16 soundness over BN254 with honest setup.
- **Zero-knowledge of transact** reduces to Groth16 ZK property.
- **Commitment binding** reduces to Poseidon collision resistance.
- **Commitment hiding** reduces to Poseidon pseudorandomness + uniform `random` sampling. User must use a CSPRNG for `random`; SDK enforces.
- **Nullifier unlinkability to commitment** reduces to Poseidon one-wayness + secrecy of `spendingPriv`.
- **Note confidentiality** reduces to ChaCha20-Poly1305 AEAD + X25519 DH secrecy + uniform `ephPriv`.
- **Spend authority** is in-circuit knowledge of `spendingPriv` preimage. Not signature-based; no EdDSA/ECDSA trust required.
- **Replay protection** via on-chain nullifier set — once added, double-spend attempts fail at program layer regardless of proof validity.
- **Known weak assumptions for post-quantum:** BN254 pairings and Poseidon will both fall to sufficient QCs. Migration path deferred.

---

## 9. Interaction with Solana runtime

- **alt_bn128 syscalls:** `sol_alt_bn128_addition`, `sol_alt_bn128_multiplication`, `sol_alt_bn128_pairing`. All in Solana 1.18+ mainnet. `groth16-solana` uses these directly. Our verifier program composes them.
- **Poseidon syscall:** Solana 1.18+ provides `sol_poseidon` syscall (Light Protocol contributed). We use it for on-chain Poseidon computations needed by the append path (§5.4) and nullifier prefix derivation. ~100k CU per hash — measured.
- **Memory:** circuit witness generation is off-chain only. On-chain program never runs Circom.
- **Proof bytes on-chain:** 256 bytes per proof. Public inputs: 11 × 32 bytes = 352 bytes. Total instruction data ~700 bytes. Fits in single tx.

---

## 10. Pinned artifacts and versions

All values filled in at circuit compile + ceremony time. Placeholders now; PRD-02 is not signed off until these are concrete. Listed here so reviewers see the complete shape.

| Artifact | Version / Hash | Status |
|---|---|---|
| `iden3/circomlib` commit | TBD (pin to a tagged release, e.g. v2.4.0) | Pending |
| `circom` compiler version | TBD (e.g. 2.2.2) | Pending |
| `snarkjs` version | TBD | Pending |
| PPoT transcript hash | TBD | Pending |
| Phase-2 final `zkey` SHA-256 | TBD | Pending (post-ceremony) |
| `verificationKey.json` SHA-256 | TBD | Pending (post-ceremony) |
| `groth16-solana` crate version | TBD (lock to audited release) | Pending |
| `sol_poseidon` — Solana version support floor | 1.18.x | Pinned |

---

## 11. Test vectors (specimen — to be expanded in PRD-07)

All reference implementations (Circom, TypeScript, Rust) must produce these exact outputs.

### 11.1 Poseidon_2

Input `(x, y) = (1, 2)`:
```
Poseidon_2(1, 2) = <expected Fr — filled from circomlib test vector>
```

### 11.2 Commitment

```
tokenMint    = USDC_mint_Fr = <precomputed>
value        = 1_000_000  (1 USDC, 6 decimals)
random       = 0x0123...  (32B)
spendingPub  = Poseidon_2("b402/v1/spend-key-pub", 0x00000001) = <expected>
commitment   = Poseidon_5("b402/v1/commit", tokenMint, value, random, spendingPub) = <expected>
```

### 11.3 Nullifier

```
spendingPriv = 0x00000001
leafIndex    = 42
nullifier    = Poseidon_3("b402/v1/null", 0x00000001, 42) = <expected>
```

### 11.4 Merkle zero[26]

Filled at circuit-compile. Reference impls must match bit-for-bit.

### 11.5 End-to-end transact proof

A full transact with N=1 (shield), published witness + proof + VK hash. Reference impl must verify true and must reject after flipping any public-input bit.

PRD-07 expands this into ≥50 vectors per primitive and covers the negative cases systematically.

---

## 12. Open questions to resolve before PRD-03

1. **`rootBind` public input —** keep optional, or drop? Adds 1 constraint but enables time-bounded proofs (prevents relayer-induced replay across long blockspace gaps). Tentative: keep, optional per-tx.
2. **Adapter-ID format —** enum (fixed id) or pubkey hash? Enum simpler; pubkey hash more extensible. Tentative: pubkey hash → `Fr`.
3. **Disclosure circuit scope —** single-note disclose only, or range disclose with time bounds? v1 minimal: single-note. Time-range deferred.
4. **Transact arity bump —** v1 N=2 M=2 only. Demand signal for N=4 M=4 (consolidation) is real in EVM SDK; consider shipping both at launch so consolidation doesn't need 2 txs.
5. **Double-commitment protection —** do we want per-commitment uniqueness check on-chain (reject if the same commitment appears twice)? Useful against a maliciously reused `random`. Tentative: yes; small set-add.

---

## 13. Revision history

| Version | Date | Author | Changes |
|---|---|---|---|
| 0.1 | 2026-04-23 | b402 core | Initial draft |

---

## 14. Sign-off

| Role | Name | Date | Status |
|---|---|---|---|
| Cryptography review (external) | | | |
| Protocol lead | | | |
| Circuit author | | | |
| Final approval | | | |

Once signed off, PRD-03 (Anchor Program Spec) begins, which binds this cryptographic spec into Solana account layouts, instruction handlers, and CPI contracts.

# PRD-A02 - Parity and Deterministic Vectors

| Field | Value |
|---|---|
| Status | Active |
| Owner | b402 core |
| Date | 2026-04-23 |
| Version | 1.0 |
| Depends on | PRD-A01 |
| Purpose | Define exact parity coverage and canonical vector generation across Rust, TypeScript, and Circom |

## 1. Objective

Establish a deterministic vector corpus and a parity harness that proves all shared primitives and public-input layouts are identical across implementations.

This is the first implementation phase because any mismatch here invalidates later fuzzing, benchmark, and audit work.

## 2. In-scope implementations

- Rust: `packages/crypto`, selected verifier helpers
- TypeScript: `packages/sdk`, `packages/shared`, `packages/prover`
- Circom: `circuits/lib`, `circuits/transact.circom`

## 3. Canonical vector sets

Create the following vector files:

- `b402-assurance/vectors/domain-tags.json`
- `b402-assurance/vectors/fr-codec.json`
- `b402-assurance/vectors/poseidon-primitives.json`
- `b402-assurance/vectors/merkle.json`
- `b402-assurance/vectors/transact-public-inputs.json`
- `b402-assurance/vectors/note-encryption.json`

Each file must include:
- version
- generation timestamp
- generator commit or source tree fingerprint
- input cases
- exact expected outputs
- serialization format notes

## 4. Exact coverage

### 4.1 Domain and field encoding

Cases:
- every domain tag in the repo
- zero
- one
- `p - 1`
- `p`
- `p + 1`
- `2^64 - 1`
- 32-byte boundary cases with highest bit set

Assertions:
- canonical decode acceptance is identical
- non-canonical decode rejection is identical where applicable
- reduced encoding behavior is explicit and tested separately from canonical decoding

### 4.2 Poseidon-derived primitives

Cases per primitive:
- fixed regression vectors: 100 cases
- seeded randomized vectors: 10,000 cases

Primitives:
- `commitment`
- `nullifier`
- `spendingPub`
- `merkleNode`
- `merkleZeroSeed`
- `feeBind`

Assertion:
- decimal field values match exactly across Rust and TS
- Circom witness public/private outputs match exactly where the circuit exposes them

### 4.3 Merkle behavior

Cases:
- empty tree root
- append sequences of length 1, 2, 3, 7, 32, 257, 1024
- randomized append sequences: 1,000 runs with seeded inputs
- proof verification for head, middle, and tail leaves
- stale sibling/path corruption cases

Assertions:
- root equality across Rust and TS
- proof round-trip validity
- path-bit order is identical

### 4.4 Transact public-input ordering

Cases:
- shield witness
- internal transact witness
- unshield witness
- randomized valid witness shapes with dummy combinations

Assertions:
- public input count is fixed
- field ordering is fixed
- LE/BE conversions match verifier expectations exactly
- serialized proof bytes and public-input bytes are stable

### 4.5 Note encryption vectors

Cases:
- deterministic fixtures with pinned sender ephemeral secret for test mode
- decrypt-for-me cases
- not-for-me cases
- malformed ciphertext cases

Assertions:
- X25519 and ChaCha20-Poly1305 outputs are stable for pinned fixtures
- viewing tag filtering is correct
- decrypted note recomputes the expected commitment

## 5. Harness structure

Required harnesses:
- Rust vector generator
- TS vector generator and validator
- Circom witness validator where applicable

Required outputs:
- JSON vectors
- parity summary report in markdown

Target files:
- `b402-assurance/rust/parity/`
- `b402-assurance/ts/parity/`
- `b402-assurance/reports/parity-summary.md`

## 6. Implementation steps

1. Add a canonical vector schema and validate all vector files against it.
2. Add Rust generators for field, Poseidon, Merkle, and public-input cases.
3. Add TS validators that consume Rust-generated vectors and compare outputs.
4. Add Circom witness checks for the circuit-covered surfaces.
5. Add a parity report generator that summarizes pass/fail counts and lists any drift by primitive.
6. Commit the generated vectors only after reproducibility is proven across two runs.

## 7. Exit criteria

PRD-A02 is complete when:
- 10,000 seeded randomized primitive cases pass
- all fixed vectors pass
- merkle append/proof parity passes
- transact public-input layout is frozen and reported
- note-encryption fixtures pass
- a machine-readable and human-readable report both exist

## 8. Failure policy

Any parity mismatch blocks all later assurance phases until resolved.

No benchmark or fuzz result is considered valid if PRD-A02 is failing.

# PRD-A06 - Formal Verification Readiness

| Field | Value |
|---|---|
| Status | Active |
| Owner | b402 core |
| Date | 2026-04-23 |
| Version | 1.0 |
| Depends on | PRD-A01, PRD-A02, PRD-A03, PRD-A04, PRD-A05 |
| Purpose | Define the exact artifacts and freeze conditions required before external formal verification and audit handoff |

## 1. Objective

Prepare the transact circuit and surrounding trust boundary for external formal verification in a way that is concrete, reviewable, and backed by artifacts rather than claims.

This PRD does not pretend to replace external formal verification.
It defines the package that makes external formal verification efficient and credible.

## 2. Verification scope

Primary scope:
- transact circuit

Secondary scope, documented but not yet subject to the same FV bar:
- verifier input layout
- pool program checks that bind proof outputs to state updates
- adapter trust-boundary invariants

Reason:
- the transact circuit is the cryptographic core
- the surrounding program logic must still be tested and specified, but external FV should start with the highest-value surface

## 3. Required freeze conditions

No FV handoff occurs until all are true:
- public input count is frozen
- public input ordering is frozen
- domain tags are frozen
- circuit constraint count snapshots exist
- canonical vectors exist
- negative-test matrix exists and is green
- benchmark summary exists
- known limitations are documented

## 4. Required artifact bundle

Create the following under `b402-assurance/reports/fv/`:

1. `scope.md`
- exact components in scope
- exact components out of scope

2. `public-input-schema.md`
- ordered list of all public inputs
- meaning of each field
- serialization format and endianness

3. `constraint-snapshots.csv`
- circuit name
- constraint count
- public input count
- private signal count

4. `negative-test-matrix.md`
- one row per failure mode
- location of the test
- pass/fail result

5. `vectors-index.md`
- list of vector files
- provenance
- how to regenerate them

6. `threat-boundary-summary.md`
- what the circuit proves
- what it does not prove
- what the pool program must enforce

7. `known-limitations.md`
- root ring limits
- single-writer tree tradeoff
- shard capacity assumptions
- adapter trust assumptions
- route-cap limits

8. `assurance-summary.md`
- parity results
- property/invariant results
- fuzzing status
- benchmark classification

## 5. Negative-test matrix

The matrix must explicitly cover at least:
- mismatched nullifier
- wrong commitment
- balance violation
- simultaneous public in/out
- wrong fee bind
- wrong root
- tampered merkle path
- duplicate nullifier
- dummy sentinel abuse
- wrong token mint crossing
- malformed proof bytes
- malformed public input count
- wrong verifying key

Every matrix row must link to a real test location.

## 6. Formal-verification prep steps

1. Freeze vectors and public-input ordering.
2. Generate and commit constraint snapshots.
3. Generate the negative-test matrix from real tests.
4. Generate the trust-boundary summary from PRD-02, PRD-03, and PRD-04.
5. Generate the known-limitations report from observed benchmark and invariant results.
6. Assemble the FV bundle into `reports/fv/`.

## 7. Exit criteria

PRD-A06 is complete when:
- all FV bundle documents exist
- all references point to real artifacts
- no section says "TBD", "later", or equivalent placeholder language
- the transact circuit can be handed to an external verifier with a stable artifact set

## 8. Success condition

At the end of this phase, b402 can state something precise:

"The transact circuit has a frozen public-input schema, deterministic vectors, negative-test coverage, benchmark data, and a complete formal-verification handoff bundle."

That statement is the bar. Anything weaker is not formal-verification readiness.

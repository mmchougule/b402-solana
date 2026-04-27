# b402-assurance

The PRDs here (`prds/PRD-A01..A06`) are the design docs for the assurance
workspace. The **executable harness lives in a separate repo**:

> https://github.com/mmchougule/b402-solana-assurance

That repo contains the test runners, parity vectors, fuzz corpora, on-chain
probe, formal-verification bundle generator, and the latest run's
`reports/` + `artifacts/`. It's split out so it can run against this repo
as immutable system-under-test (no shared `Cargo.lock`, no shared
`pnpm-lock`), and so the assurance posture has its own audit trail.

## What the harness proves (latest run)

Run from `b402-solana-assurance/` against this repo's HEAD:

| Lane | Result |
|---|---|
| Onchain litesvm — active | 19 pass / 0 fail / 3 deferred |
| Adapt verifier integration | 6 / 6 pass — `adapter_id`, `action_hash`, `expected_out_mint` tampering all rejected |
| Property tests (PRD-A03) | 384 single-shot + 104 stateful + 32 merkle |
| Fuzz (PRD-A04, audit profile) | 22,256 / 22,272 mutations rejected (99.93%) |
| Replay attempts caught | 165 |
| Paused-shield rejections | 637 |
| Root-pressure appends | 512 |
| Nullifier-shard samples | 4,096 (max bucket = 4) |
| Domain-tag vectors | 14 |
| Rust ↔ TS Poseidon parity | 35 cases |
| Merkle Rust ↔ TS parity | 11 sequences |
| Adapt CU end-to-end (Groth16 + deployed bytecode) | 313,725 (under Solana's 1.4M cap) |
| Shield CU | 233,495 |
| Unshield CU | 223,413 |

The harness fails closed: any deviation from the parity vectors, any
unrejected fuzz mutation, any onchain test regression, any benchmark drift
beyond ±5% of pinned baselines fails the run. Every artifact is committed
to the assurance repo so individual numbers are traceable to a specific
git SHA on both sides.

## What it does NOT prove

These are out of scope for the harness; they're what an external audit
covers:

- Constraint-system completeness in the Circom circuits — does the circuit
  enforce what the spec says it does? Needs formal-verification or a
  circuit auditor.
- Soundness of the trusted setup ceremony — current devnet VK is a
  single-contributor throwaway. Mainnet redoes a multi-party ceremony
  per [PRD-08](../docs/prds/PRD-08-audit-launch.md).
- Subtle edge cases at the field-prime / tree-depth / nullifier-shard
  boundaries that fuzz happens to miss. Audit + formal cover this.

The PRDs below describe design intent. The assurance repo at the link
above is the executable proof.

## PRD set (kept here as inline reference)

- `prds/PRD-A01-assurance-architecture.md`
- `prds/PRD-A02-parity-vectors.md`
- `prds/PRD-A03-property-invariant-testing.md`
- `prds/PRD-A04-fuzzing.md`
- `prds/PRD-A05-benchmarks-budgets.md`
- `prds/PRD-A06-formal-verification-readiness.md`

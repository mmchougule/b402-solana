# PRD-A05 - Benchmarks and Runtime Budgets

| Field | Value |
|---|---|
| Status | Active |
| Owner | b402 core |
| Date | 2026-04-23 |
| Version | 1.0 |
| Depends on | PRD-A01, PRD-A02, PRD-A03 |
| Purpose | Define measurable budgets for cryptography, proving, verifier cost, pool instructions, and scalability limits |

## 1. Objective

Replace rough estimates with benchmarked budgets that can support audit decisions and Solana-runtime design choices.

## 2. Benchmark classes

### 2.1 Microbenchmarks

Targets:
- `Fr` encode/decode
- Poseidon wrappers
- Merkle append
- Merkle prove
- note encrypt
- note decrypt
- public-input serialization

### 2.2 Proof-system benchmarks

Targets:
- witness generation latency
- Groth16 proof generation latency
- proof byte serialization latency
- verifier helper latency off-chain

### 2.3 Program/runtime benchmarks

Targets:
- verifier program CU
- `shield` CU
- `transact` CU
- `unshield` CU
- adapter-assisted transaction CU
- account-list size and transaction size pressure

### 2.4 Scalability/limit benchmarks

Targets:
- nullifier shard insertion cost vs count
- root-ring freshness window vs proof latency
- tree append throughput under repeated writes
- note scan throughput over large commitment streams

## 3. Required budget table

The baseline report must include at minimum:

| Metric | Target |
|---|---|
| Transact verifier CU | <= 200,000 |
| Shield total CU | <= 300,000 |
| Transact total CU | <= 350,000 |
| Unshield total CU | <= 350,000 |
| 3-hop adapter route total CU | <= 1,000,000 |
| Proof generation p50 | <= 1.5 s on pinned bench machine |
| Proof generation p95 | <= 2.5 s on pinned bench machine |
| Note scan throughput | >= 5,000 commitments/s |

These targets are not placeholders. If they are missed, the report must say so explicitly and propose the exact remediation path.

## 4. Benchmark environment policy

Every benchmark report must state:
- machine model
- CPU and memory
- OS version
- rustc/toolchain versions
- Node version
- Solana/Anchor versions
- whether local validator, program-test, or off-chain benchmark path was used

No benchmark numbers are accepted without environment metadata.

## 5. Baseline files

Create:
- `b402-assurance/baselines/microbench.json`
- `b402-assurance/baselines/proofbench.json`
- `b402-assurance/baselines/cubench.json`
- `b402-assurance/baselines/scanbench.json`

Create summary report:
- `b402-assurance/reports/benchmark-summary.md`

## 6. Implementation steps

1. Add Rust microbench harnesses for crypto and Merkle.
2. Add TS benchmarks for note encryption, note scan, and serialization.
3. Add proof generation bench harness against compiled circuit artifacts.
4. Add CU measurement harness for verifier and pool instructions.
5. Add scalability sweeps for shard size and scan volume.
6. Commit machine-readable baselines and markdown summary together.

## 7. Interpretation policy

Benchmark reports must not just print numbers. They must classify each metric:
- pass
- near budget
- fail

Every fail or near-budget metric must include:
- likely cause
- likely fix direction
- whether it blocks audit readiness

## 8. Solana-specific concerns this phase must answer

This phase must quantify:
- whether single `TreeState` writes are acceptable for v1 throughput
- whether 64-entry root history is enough under realistic proof latency
- whether 64 KB shard writes create unacceptable CU or lock pressure
- whether adapter composition needs stricter route caps than currently specified
- whether account-list limits require ALTs earlier than expected

## 9. Exit criteria

PRD-A05 is complete when:
- all baseline JSON files exist
- markdown summary exists
- each metric is classified against a budget
- the report explicitly names bottlenecks and non-bottlenecks

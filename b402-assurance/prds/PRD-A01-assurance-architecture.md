# PRD-A01 - Assurance Architecture

| Field | Value |
|---|---|
| Status | Active |
| Owner | b402 core |
| Date | 2026-04-23 |
| Version | 1.0 |
| Depends on | PRD-01, PRD-02, PRD-03, PRD-04, PRD-07, PRD-08 |
| Purpose | Define the isolated assurance workspace, test taxonomy, outputs, and execution order |

## 1. Decision

Create a dedicated top-level workspace named `b402-assurance/`.

This workspace is the coordination layer for:
- parity tests
- deterministic vectors
- property tests
- stateful invariant tests
- fuzzing
- benchmarks
- formal-verification readiness artifacts

It is intentionally separate from the production package graph until each assurance component is ready to be wired in.

## 2. Why this structure

The current repo has real cryptographic and verifier coverage, but the higher-order assurance work is still scattered between draft PRDs and ad hoc test files.

The main risks with doing this directly in the live package roots are:
- accidental dependency drift that breaks SBF builds
- noisy generated artifacts mixed with product code
- unclear audit trail between "spec intent" and "executed assurance output"
- collisions with concurrent feature work

`b402-assurance/` solves that by making assurance a first-class subsystem rather than a loose collection of tests.

## 3. Repository layout

Target layout:

```text
b402-assurance/
  README.md
  prds/
    PRD-A01-assurance-architecture.md
    PRD-A02-parity-vectors.md
    PRD-A03-property-invariant-testing.md
    PRD-A04-fuzzing.md
    PRD-A05-benchmarks-budgets.md
    PRD-A06-formal-verification-readiness.md
  vectors/
  corpora/
  baselines/
  reports/
  scripts/
  rust/
  ts/
```

Rules:
- `vectors/` stores deterministic canonical inputs and expected outputs
- `corpora/` stores fuzz seeds and minimized crashers
- `baselines/` stores benchmark JSON baselines and budget thresholds
- `reports/` stores generated markdown, JSON, and CSV outputs intended for auditors
- `scripts/` stores orchestration only, not production logic
- `rust/` and `ts/` host assurance harnesses that depend on production crates/packages without changing their behavior

## 4. Test taxonomy

### 4.1 Parity

Goal:
- prove Rust, TypeScript, and Circom agree bit-for-bit on every shared primitive and serialized public input surface

Initial surfaces:
- domain tags
- Fr encoding and reduction boundaries
- commitment
- nullifier
- spending public key
- merkle zero seed
- merkle node hash
- empty root
- append sequence
- merkle proof verification
- fee bind
- root bind
- public-input ordering

### 4.2 Property and invariant tests

Goal:
- prove the state transition rules hold under broad randomized inputs and randomized instruction sequences

Targets:
- crypto primitives
- merkle append behavior
- nullifier shard behavior
- root ring freshness
- pool-level conservation
- unshield availability
- adapter post-balance invariant

### 4.3 Fuzzing

Goal:
- prove the system rejects malformed data with typed failures and never panics or corrupts state

Targets:
- instruction argument decoding
- proof/public-input payload assembly
- nullifier insertion
- tree append
- verifier byte parsing
- event parsing and note ingestion

### 4.4 Benchmarks

Goal:
- prove the implementation fits performance and Solana-runtime budgets before audit and before mainnet

Targets:
- CPU time
- CU consumption
- account growth behavior
- note-scan throughput
- proof generation latency
- verifier cost

### 4.5 Formal-verification readiness

Goal:
- produce a stable, auditable package for an external verifier such as Veridise

Outputs:
- frozen vectors
- negative-test matrix
- constraint count snapshots
- public input schema
- threat-boundary summary
- benchmark reports
- known limitations list

## 5. Isolation policy

Hard rules:
- no package version changes for production crates as part of assurance scaffolding unless explicitly reviewed
- no new root-level scripts replacing current build/test entrypoints until assurance jobs are proven stable
- no generated corpus or report files committed outside `b402-assurance/`
- no benchmark gating on production CI until baselines have been collected on stable hardware twice

## 6. Execution order

Mandatory order:
1. freeze architecture and outputs in this PRD
2. generate deterministic vectors and parity coverage
3. add property and invariant harnesses
4. add fuzzing
5. add benchmarks and budgets
6. generate the formal-verification readiness package

Reason:
- parity finds cross-impl disagreements early
- invariant tests define the safety oracles that fuzzing should enforce
- benchmark numbers are meaningful only after correctness coverage exists
- formal-verification handoff should be the output of the previous layers, not a parallel guess

## 7. Deliverables

Definition of done for the assurance workspace:
- all PRDs in `b402-assurance/prds/` are implemented, not merely written
- deterministic vectors exist and are reproducible
- fuzz corpora exist and are versioned
- benchmark baselines exist and are machine-readable
- formal-verification readiness report is complete and references concrete artifacts

## 8. Red flags to track

The assurance effort must explicitly test and quantify:
- single-writer `TreeState` throughput limits
- 64 KB `NullifierShard` operational behavior
- root ring depth pressure under real proof latency
- adapter trust-boundary failures
- CU headroom on worst-case Jupiter routes
- transaction account-list pressure and ALT dependence
- differences between local validator behavior and real runtime behavior

## 9. Sign-off gate

This PRD is the gate for any assurance implementation work. No harness code should land without mapping to one of PRD-A02 through PRD-A06.

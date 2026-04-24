# b402-assurance

Isolated assurance workspace for the Solana shielded-pool stack.

Purpose:
- expand cross-implementation parity coverage
- add property, invariant, and fuzz testing
- measure performance and resource budgets
- produce audit and formal-verification handoff artifacts

Non-goals:
- no changes to production program semantics from this folder alone
- no hidden CI side effects
- no placeholder plans; every PRD here is intended to be executable

Scope:
- `circuits/`
- `packages/crypto/`
- `packages/prover/`
- `packages/sdk/`
- `programs/b402-verifier-transact/`
- `programs/b402-pool/`
- `programs/b402-jupiter-adapter/`

Document set:
- `prds/PRD-A01-assurance-architecture.md`
- `prds/PRD-A02-parity-vectors.md`
- `prds/PRD-A03-property-invariant-testing.md`
- `prds/PRD-A04-fuzzing.md`
- `prds/PRD-A05-benchmarks-budgets.md`
- `prds/PRD-A06-formal-verification-readiness.md`

Execution order:
1. PRD-A01
2. PRD-A02
3. PRD-A03
4. PRD-A04
5. PRD-A05
6. PRD-A06

Rationale for isolation:
- the active repo is under concurrent development
- SBF builds are sensitive to dependency and stack changes
- fuzz corpora, benchmark baselines, and generated reports should be kept deliberate and reviewable

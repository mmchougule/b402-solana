# b402-solana

Private DeFi on Solana. Shielded pool for SOL + SPL tokens, with composable private execution into Jupiter, Kamino, Drift, and Orca. Gasless, permissionless, 0% protocol fee.

Built by the b402 team as the Solana counterpart to the EVM Railgun fork deployed on Base, Arbitrum, and BSC.

## Status

Pre-alpha. No code yet. PRD-driven design in progress — see `docs/prds/`.

## Repository layout

- `docs/prds/` — sequenced product requirements documents. Read in order.
- `circuits/` — Circom 2.x circuits.
- `programs/` — Anchor on-chain programs.
- `packages/sdk/` — `@b402ai/solana` TypeScript SDK.
- `packages/prover/` — WASM proof generation.
- `packages/relayer/` — off-chain relayer service (gasless execution).
- `packages/shared/` — shared types and utilities.
- `tests/` — unit, integration, and e2e tests.
- `ops/` — deploy scripts and trusted-setup ceremony materials.

## Design principles

- **No hacks.** Every design decision is documented in a PRD and reviewed before implementation.
- **TDD for circuits.** Every circuit template has unit tests, property-based tests, Rust parity tests, and negative tests before any program integration.
- **Permissionless.** No KYT screening, no allowlists. Optional opt-in viewing-key disclosure for users who need it.
- **0% protocol fee.** Maximizes the anonymity set. Relayer fees are market-rate and paid in-kind from unshield amount.
- **Audit-first.** Designs are written for auditor consumption. Cryptographic primitives and failure modes are spelled out before code.

## License

TBD (will likely match b402-sdk).

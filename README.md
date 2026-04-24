# b402-solana

Private DeFi on Solana — shielded pool for SPL tokens, composable execution path
for Jupiter (and other adapters), gasless, 0% protocol fee, permissionless.
Circom 2 + Groth16 + Anchor.

Counterpart to the b402 Railgun fork on Base, Arbitrum, and BSC. Same UTXO +
viewing-key model; ported to Solana's account-centric runtime.

> ⚠️ **Alpha, devnet only. Not audited. Trusted-setup ceremony is a single-contributor
> throwaway — do not deploy real funds.**

## Status

Phase 1 in progress. Shield and unshield are live on devnet and passing
end-to-end with real Groth16 proofs. Composable `adapt_execute` is wired
behind a feature gate for devnet demos.

**Devnet deployment (2026-04-23)**

| Program | ID | Cost |
|---|---|---|
| Pool | `42a3hsCXtQLWonyxWZosaaCJCweYYKMrvNd25p1Jrt2y` | 2.99 SOL |
| Verifier | `Afjbnv2Ekxa98jjRw33xPPhZabevek2uZxoE75kr6ZrK` | 1.28 SOL |
| Jupiter adapter | `3RHRcbinCmcj8JPBfVxb9FW76oh4r8y21aSx4JFy3yx7` | 1.35 SOL |
| b402 ALT | `9FPYufa1KDkrn1VgfjkR7R667hbnTA7CNtmy38QcsuNj` | ~0.002 SOL |

**Live shield/unshield on devnet:**

- Shield: [`5XLaccuw6tv6AWowMDKLK24zTSxD4Ej2nuRwSnpbLWZSHU19SPb7n8mNpx8G4fHEHxBMRo5GiYPyPj6G4pmsLyZB`](https://explorer.solana.com/tx/5XLaccuw6tv6AWowMDKLK24zTSxD4Ej2nuRwSnpbLWZSHU19SPb7n8mNpx8G4fHEHxBMRo5GiYPyPj6G4pmsLyZB?cluster=devnet)
- Unshield: [`38mKQXBPuwtYhM5JvbyJA2se9cehMvw1mUbevhERAkZdni7a6VTYdYNx66nZ5KqzbgUng1SsbCiQEJX2F3XG77PD`](https://explorer.solana.com/tx/38mKQXBPuwtYhM5JvbyJA2se9cehMvw1mUbevhERAkZdni7a6VTYdYNx66nZ5KqzbgUng1SsbCiQEJX2F3XG77PD?cluster=devnet)

See `docs/TX-WALKTHROUGH.md` for a layer-by-layer anatomy of both.

## What's implemented

### Programs (`programs/`)
- `b402-pool` — init/shield/unshield/transact + admin (pause, register adapter) + `adapt_execute_devnet` feature-gated handler
- `b402-verifier-transact` — Groth16 verifier wrapping `Lightprotocol/groth16-solana`, VK baked from ceremony at build time
- `b402-jupiter-adapter` — CPI adapter forwarding `action_payload` to Jupiter V6
- `b402-mock-adapter` — test-only adapter for balance-delta invariant tests

### Circuits (`circuits/`)
- `transact.circom` — 2-in / 2-out shielded transaction, 17,259 R1CS constraints, 18 public inputs
- Sub-circuits for commitment, nullifier, spending-key derivation, merkle path
- Tests: primitives, Rust ↔ TS parity, witness generation, end-to-end snarkjs prove-verify

### SDK (`packages/sdk/`)
- `shield(params)` — build + submit a shield tx
- `unshield(params)` — build + submit an unshield tx, supports merkle-proof override or `ClientMerkleTree`
- `privateSwap(params)` — compose a shielded swap via `adapt_execute_devnet` (Phase 1, devnet-gated)
- `buildPrivateSwapTx(inputs)` — pure v0-tx builder for size-regression tests
- `Scanner` — log-subscription + viewtag-filtered note discovery
- `ClientMerkleTree`, `buildWallet`, `NoteStore` — client-side crypto primitives

### Ops (`ops/`)
- `local-validator.sh` — boots solana-test-validator with all 4 programs pre-deployed
- `smoke-validator.sh` — verifies programs are live on the chosen RPC
- `alt/create-alt.ts` — creates + extends the b402 Address Lookup Table (required for `adapt_execute` — without it, Jupiter routes overflow Solana's 1,232 B tx cap)

## Quickstart

```bash
# Toolchain
#   Rust stable + Solana CLI 2.0+ + platform-tools v1.54
#   Node 20+, pnpm workspace
pnpm install

# 1. Cryptographic stack — circuits + parity + prover (no chain)
cd circuits && pnpm install && RUN_PARITY=1 RUN_CIRCUIT_TESTS=1 pnpm vitest run
cd ../packages/prover && RUN_PROVER=1 RUN_VERIFIER=1 pnpm vitest run
cd ../crypto && cargo test

# 2. Build programs for BPF
cargo build-sbf --tools-version v1.54 --manifest-path programs/b402-verifier-transact/Cargo.toml
cargo build-sbf --tools-version v1.54 --manifest-path programs/b402-pool/Cargo.toml --features test-mock
cargo build-sbf --tools-version v1.54 --manifest-path programs/b402-jupiter-adapter/Cargo.toml
cargo build-sbf --tools-version v1.54 --manifest-path programs/b402-mock-adapter/Cargo.toml

# 3. On-chain tests (litesvm, in-process Solana VM)
cd tests/onchain && cargo test

# 4. SDK regression tests (tx-size, parity)
pnpm --filter=@b402ai/solana test

# 5. End-to-end against a local validator
./ops/local-validator.sh --reset          # terminal 1
cd examples && pnpm e2e                   # terminal 2 — runs shield → unshield

# 6. Same e2e against devnet (uses CLI wallet + deployed programs)
RPC_URL=https://api.devnet.solana.com pnpm --filter=@b402ai/solana-examples e2e
```

## Repo layout

```
b402-solana/
├── docs/
│   ├── prds/                      sequenced PRDs 01–08 + 01-A amendment
│   ├── TX-WALKTHROUGH.md          anatomy of shield + unshield tx
│   └── SUBMISSION.md              internal: submission strategy
├── circuits/                      Circom 2.2 source + scripts + tests
├── programs/
│   ├── b402-pool/
│   ├── b402-verifier-transact/
│   ├── b402-jupiter-adapter/
│   └── b402-mock-adapter/
├── packages/
│   ├── crypto/                    Rust Fr / Poseidon / Merkle (parity-tested ↔ TS)
│   ├── shared/                    @b402ai/solana-shared — constants, codecs
│   ├── prover/                    @b402ai/solana-prover — snarkjs wrapper
│   └── sdk/                       @b402ai/solana — wallet, actions, scanner
├── tests/onchain/                 litesvm integration tests (15 tests)
├── ops/
│   ├── local-validator.sh         boot a validator with all programs
│   ├── smoke-validator.sh         verify deploys
│   ├── alt/                       Address Lookup Table tooling
│   └── keypairs/                  deploy authority keys (gitignored)
├── examples/
│   └── e2e.ts                     shield → unshield demo
├── Anchor.toml, Cargo.toml
├── BUILD-STATE.md                 running internal state doc
└── ENGINEER-REVIEW.md             one-pager for reviewers
```

## Design principles

- **PRD-driven.** Read `docs/prds/` in numeric order. Each decision is
  justified before code.
- **TDD for circuits.** Unit + property + Rust parity + negative tests
  before integration.
- **Permissionless.** No KYT, no allowlists. Optional opt-in viewing-key
  disclosure.
- **0% protocol fee** (immutable). Maximizes the anonymity set. Relayer
  fees are paid in-kind from unshield amount.
- **Audit-first.** Designs written for auditor consumption. Cryptographic
  primitives and failure modes spelled out before implementation.

## What's intentionally stubbed

See `ENGINEER-REVIEW.md` for the full "please flag in review" list. Summary:

- **Full `adapt_execute` (with ZK)** — the devnet path (`adapt_execute_devnet`,
  feature-gated) validates pool-side plumbing + balance-delta invariant.
  The adapt circuit + `b402_verifier_adapt` program are Phase 2.
- **Relayer / indexer service** — `Scanner` handles the indexer side from
  the client. A Fastify HTTP relayer matching our EVM conventions is not
  written.
- **Stealth-address bech32 encoding** — primitives exist; the `b402sol1q…`
  encode/decode layer is not written.
- **Production trusted setup** — current VK is from a throwaway
  single-contributor ceremony. Mainnet needs Phase-2 ceremony per PRD-08.
- **Admin multisig** — v1 uses single-key admin; PRD-03 §9 specifies
  full multisig co-signer pattern.

## License

TBD (will likely match `@b402ai/sdk`).

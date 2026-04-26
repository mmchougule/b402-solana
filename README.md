# b402-solana

Private DeFi on Solana — shielded pool for SPL tokens, composable execution path
for Jupiter (and other adapters), gasless, 0% protocol fee, permissionless.
Circom 2 + Groth16 + Anchor.

Counterpart to the b402 Railgun fork on Base, Arbitrum, and BSC. Same UTXO +
viewing-key model; ported to Solana's account-centric runtime.

> ⚠️ **Alpha, devnet only. Not audited. Trusted-setup ceremony is a single-contributor
> throwaway — do not deploy real funds.**

## What works today

- Shield and unshield on Solana devnet with real Groth16 proofs.
- `adapt_execute` composition path (feature-gated `adapt-devnet`) that
  CPIs any registered adapter. Validated end-to-end against **real
  Jupiter V6** on a mainnet-forked validator: 0.1 wSOL → 8.549 USDC
  through SolFi V2, real aggregator bytecode, real pool state cloned
  from mainnet.
- Recipient-side privacy: a `Scanner` subscribes to pool logs, runs
  viewing-tag pre-filter + ECDH decrypt, auto-discovers incoming notes.
  Alice → Bob → Charlie is wired and green.
- 71 tests across Rust crypto, verifier, Circom parity, prover, on-chain
  (litesvm), and SDK tx-size regression. See `docs/REPRODUCE.md`.

**Devnet deployment (2026-04-25)**

| Program | ID |
|---|---|
| Pool | `42a3hsCXtQLWonyxWZosaaCJCweYYKMrvNd25p1Jrt2y` |
| Verifier (transact) | `Afjbnv2Ekxa98jjRw33xPPhZabevek2uZxoE75kr6ZrK` |
| Verifier (adapt) | `3Y2tyhNSaUiW5AcZcmFGRyTMdnroxHxc5GqFQPcMTZae` |
| Jupiter adapter | `3RHRcbinCmcj8JPBfVxb9FW76oh4r8y21aSx4JFy3yx7` |
| Mock adapter | `89kw33YDcbXfiayVNauz599LaDm51EuU8amWydpjYKgp` |
| b402 ALT (16 entries) | `9FPYufa1KDkrn1VgfjkR7R667hbnTA7CNtmy38QcsuNj` |

**Live end-to-end on devnet — shield → real Groth16 adapt swap → unshield:**

- Shield: [`59ahVAQN…Qyk3u`](https://explorer.solana.com/tx/59ahVAQNKGce4d5QRcfZuxYcGsPuXXrgbGqSTQpi4ByCuAtJtPyipypb8jLJwiqQf64suYjWHz625ynPNcQyk3u?cluster=devnet)
- Adapt (real ZK proof, 23 public inputs): [`5AVK983L…vzBf`](https://explorer.solana.com/tx/5AVK983LcxXN3851GpAiZG58cUGncRjfDYKLU1oziWyWVps8YYTnaDW2r27cYb65NUcYUSVYstPZNqq8RZMEvzBf?cluster=devnet)
- Unshield: [`e9KvuQn8…CEv6u`](https://explorer.solana.com/tx/e9KvuQn8F2iN9Gr8gzdVtKSHXjVPWyA623kUbqRAhYWhvwQP1GVsJwZfP1NCB8rGswmrVfgvxgmhVRzgRZCEv6u?cluster=devnet)

See `docs/TX-WALKTHROUGH.md` for a layer-by-layer anatomy of both, and
`docs/REPRODUCE.md` for the exact commands to re-run everything locally.

**Observed on-chain costs**

| Op | Tx size | Compute | Fee |
|---|---|---|---|
| Shield | 1,157 B | 239,224 CU | 5,000 lamports (~$0.001) |
| Unshield | ~1,150 B | ~350k CU | 5,000 lamports |
| Adapt swap (mock adapter, real Groth16) | 1,214 B | ~600k CU | 5,000 lamports |
| Adapt swap (mainnet-fork, real Jupiter SolFi V2) | 1,231 B | ~660k CU | 5,000 lamports |

Proof verification fits in one instruction (under Solana's 1.4M CU budget),
so no multi-tx split required — cheaper and simpler than the EVM
counterpart.

## What's implemented

### Programs (`programs/`)
- `b402-pool` — init/shield/unshield/transact + `adapt_execute` (composable private execution with full ZK binding to adapter ID, action hash, expected mint and value) + admin (pause, set verifier, register adapter)
- `b402-verifier-transact` — Groth16 verifier for the 18-input transact circuit, VK baked from ceremony at build time
- `b402-verifier-adapt` — Groth16 verifier for the 23-input adapt circuit (transact's bindings + adapter ID + action hash + expected out mint/value)
- `b402-jupiter-adapter` — CPI adapter forwarding `action_payload` to Jupiter V6
- `b402-mock-adapter` — test-only adapter for balance-delta invariant tests

### Circuits (`circuits/`)
- `transact.circom` — 2-in / 2-out shielded transaction, 17,259 R1CS constraints, 18 public inputs
- `adapt.circom` — adapt circuit, 17,582 R1CS constraints, 23 public inputs (transact's 18 + adapter binding fields)
- Sub-circuits for commitment, nullifier, spending-key derivation, merkle path
- Tests: primitives, Rust ↔ TS parity, witness generation, end-to-end snarkjs prove-verify (37 total)

### SDK (`packages/sdk/`)
- `shield(params)` — build + submit a shield tx
- `unshield(params)` — build + submit an unshield tx, supports merkle-proof override or `ClientMerkleTree`
- `Scanner` — log-subscription + viewtag-filtered note discovery
- `ClientMerkleTree`, `buildWallet`, `NoteStore` — client-side crypto primitives

### Prover (`packages/prover/`)
- `TransactProver` — generates Groth16 proofs for transact (18 public inputs)
- `AdaptProver` — generates Groth16 proofs for adapt (23 public inputs); composable swap demonstrated in `examples/swap-e2e.ts`

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
cargo build-sbf --tools-version v1.54 --manifest-path programs/b402-verifier-adapt/Cargo.toml
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

# 7. Private swap on localnet (shield → real Groth16 adapt proof → mock adapter → unshield)
./ops/local-validator.sh --reset          # terminal 1
cd examples && pnpm swap-e2e              # terminal 2

# 7b. Same private swap, but on devnet against deployed programs.
#     Funded CLI wallet pays rent for fresh nullifier shards (~0.07 SOL each).
RPC_URL=https://api.devnet.solana.com pnpm --filter=@b402ai/solana-examples swap-e2e

# 7a. Scanner auto-discovery: Alice privately sends to Bob, Bob's scanner
#     discovers the note from public logs, Bob unshields to Charlie.
./ops/local-validator.sh --reset          # terminal 1
cd examples && pnpm scanner-e2e           # terminal 2

# 8. Private swap on a mainnet-forked validator (shield → REAL Jupiter → unshield)
#    Fetches a live Jupiter quote, boots validator with Jupiter + AMM state
#    cloned from mainnet, runs the full flow. No real money, real bytecode.
cd examples && pnpm tsx ../ops/jup-quote.ts \
  --in So11111111111111111111111111111111111111112 \
  --out EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v \
  --amount 100000000 \
  --caller $(solana address -k ~/.config/solana/id.json) \
  --out-file /tmp/jup-route.json
./ops/mainnet-fork-validator.sh --route /tmp/jup-route.json --reset   # terminal 1
cd examples && pnpm swap-e2e-jupiter      # terminal 2
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

- **Relayer / indexer service** — `Scanner` handles the indexer side from
  the client. A Fastify HTTP relayer matching our EVM conventions is not
  written.
- **Stealth-address bech32 encoding** — primitives exist; the `b402sol1q…`
  encode/decode layer is not written.
- **Production trusted setup** — current VK is from a throwaway
  single-contributor ceremony. Mainnet needs a multi-party ceremony per
  PRD-08.
- **Admin multisig** — v1 uses single-key admin; PRD-03 §9 specifies
  full multisig co-signer pattern.
- **Beyond Jupiter** — Kamino, Drift, Orca adapters are scoped in
  PRD-05 but not yet implemented. The same circuit + per-protocol adapter
  pattern applies.

## License

Apache 2.0 — see `LICENSE`.

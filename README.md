# b402-solana

**Private DeFi on Solana.** Shield once, then swap, lend, LP, or trade perps —
all without your wallet appearing on-chain as the executing party. Single-tx
execution, composable with any Solana protocol via a registered adapter.

Same construction class as Railgun (Groth16 + Poseidon + UTXO commitments
+ nullifiers + viewing keys), compiled native to Solana's SVM as Anchor programs.

## Run it on devnet (~30 seconds)

```bash
git clone https://github.com/mmchougule/b402-solana && cd b402-solana
pnpm install
solana airdrop 1 --url devnet                       # if you don't have devnet SOL
RPC_URL=https://api.devnet.solana.com pnpm --filter=@b402ai/solana-examples e2e
```

Shield 100, unshield 100 to a fresh recipient. Sender and recipient share no
on-chain edge.

## Run private lending (mainnet-fork, ~2 minutes)

Kamino isn't on devnet, so we boot a local validator with Kamino's mainnet
program + USDC reserve + Pyth oracle cloned in. No real funds — the local
validator mints alice 100 USDC.

```bash
./ops/setup-kamino-fork.sh                            # clones state, boots validator
pnpm tsx examples/kamino-adapter-fork-deposit.ts      # private 1 USDC deposit
```

Goes through `b402_kamino_adapter::execute` → 7 nested CPIs into Kamino
(`init_user_metadata`, `init_obligation`, `init_obligation_farms_for_reserve`,
`refresh_reserve`, `refresh_obligation`, `deposit_v2`, sweep). Obligation account
grows 0 → 3,344 B in a single tx. Alice's wallet shows the deposit; it does not
show the Kamino position.

For the private swap variant (Jupiter v6 on mainnet-fork): [Quickstart](#quickstart)
step 8. Instruction layout for `adapt_execute`: [`docs/TX-WALKTHROUGH.md`](docs/TX-WALKTHROUGH.md).

## Numbers

| Op | Tx size | CU | Fee |
|---|---|---|---|
| Shield | 1,157 B | 239k | $0.001 |
| Unshield | ~1,150 B | ~350k | $0.001 |
| Private swap (mock adapter) | 1,214 B | ~600k | $0.001 |
| Private swap (Jupiter SolFi V2 mainnet-fork) | 1,231 B | ~660k | $0.001 |

Single-instruction Groth16 verification under Solana's 1.4M CU cap. No multi-tx
splits, no off-chain coordinator. ~325k CU consumed by the pool itself, ~1.07M
CU of headroom for adapter work.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  Client SDK         shield → adapt → unshield builders  │
│  packages/sdk       AdaptProver (23 public inputs)      │
└──────────────┬──────────────────────────────────────────┘
               │
┌──────────────▼──────────────────────────────────────────┐
│  Pool program       commitments tree, nullifier set,    │
│  programs/b402-pool adapter registry, post-CPI delta    │
└────┬───────────┬─────────┬──────────────────────────────┘
     │           │         │
┌────▼───┐  ┌────▼────┐  ┌─▼────────────────┐
│ Verif. │  │ Verif.  │  │ Adapter (any     │
│ trans. │  │ adapt   │  │ registered)      │
│ 18 PI  │  │ 23 PI   │  │ → Jupiter/Kamino │
└────────┘  └─────────┘  │   /Adrena/Orca/… │
                         └─────────┬────────┘
                                   │
                           ┌───────▼────────┐
                           │ Solana DeFi    │
                           │ (Jupiter, …)   │
                           └────────────────┘
```

Adding a new protocol = one Anchor crate (~200-300 LoC) implementing the
`execute(action_payload)` ABI + a registry entry. No circuit recut, no
ceremony, no pool change. Six adapter crates in repo today; PRDs cover the
v2 ABI extension that makes this strictly true going forward.

## Adapter status

| Adapter | Status | What it enables |
|---|---|---|
| Jupiter v6 | devnet + mainnet-fork integration tests | private swap on any Jupiter route |
| Kamino lend | mainnet-fork through `b402_kamino_adapter::execute` | private collateral, borrow, repay |
| Mock | live on devnet | adapter ABI invariant tests |
| Adrena perps | scaffold; discriminators verified vs Adrena IDL | private leveraged trading (impl in progress) |
| Orca LP | scaffold | private whirlpool positions |
| Jupiter perps | scaffold | private perps via JLP (request-queue model — pending v2 ABI two-phase claim notes) |
| Drift perps | spec only | deferred pending Drift's post-hack reboot |

## Devnet deployment

| Program | ID |
|---|---|
| Pool | `42a3hsCXtQLWonyxWZosaaCJCweYYKMrvNd25p1Jrt2y` |
| Verifier (transact) | `Afjbnv2Ekxa98jjRw33xPPhZabevek2uZxoE75kr6ZrK` |
| Verifier (adapt) | `3Y2tyhNSaUiW5AcZcmFGRyTMdnroxHxc5GqFQPcMTZae` |
| Jupiter adapter | `3RHRcbinCmcj8JPBfVxb9FW76oh4r8y21aSx4JFy3yx7` |
| Kamino adapter | `2enwFgcGKJDqruHpCtvmhtxe3DYcV3k72VTvoGcdt2rX` |
| Mock adapter | `89kw33YDcbXfiayVNauz599LaDm51EuU8amWydpjYKgp` |
| b402 ALT (16 entries) | `9FPYufa1KDkrn1VgfjkR7R667hbnTA7CNtmy38QcsuNj` |

Mainnet alpha deployment in progress. See [`ops/mainnet-deploy.sh`](ops/mainnet-deploy.sh).

## Privacy model

The chain is public. b402 doesn't change that. What it cryptographically breaks
is the link between your wallet and your shielded actions:

| Layer | What | Today |
|---|---|---|
| **L1: wallet ↔ action** | After shielding, your wallet doesn't appear in any subsequent shielded tx | broken cryptographically — same construction as Railgun, Tornado, Aztec |
| **L2: action ↔ action** | Two shielded actions can't be trivially linked | broken at the note layer; per-user adapter PDAs land in v0.2 (helpers in `programs/b402-kamino-adapter/src/lib.rs` already, gated) |
| **L3: pool-level clustering** | Timing + amount correlation across the pool boundary | scales with anonymity set — small pool weak, large pool strong |

Wallet-watching bots and MEV searchers — the dominant real-world threat —
hit Layer 1 and stop. Patient timing+amount analysts targeting a small pool
defeat Layer 3 statistically. We cap alpha TVL while the anonymity set grows;
that's the honest trade.

For autonomous agents specifically — where the adversary is automated
strategy-copying, not patient analysis — Layer 1 alone solves the problem.

[derive_owner_pda]: programs/b402-kamino-adapter/src/lib.rs

**The threat model b402 defends against:** the dominant real-world adversary —
bots scraping wallets to copy strategies, MEV searchers targeting public DEX
flow, surveillance-grade indexers (Chainalysis, Nansen, Arkham) building
wallet-level histories. Layer 1 unlinkability is complete protection here.

**The threat model b402 does NOT fully defend against (yet):** patient
clustering analysts running timing-and-amount correlation across the pool
boundary at small TVL. This is a fundamental property of UTXO-mixer
constructions, not a b402-specific weakness. It is solved by adoption — every
shield strengthens every other user's privacy.

For autonomous agents specifically — where the adversary is automated
strategy-copying bots, not patient analysts — Layer 1 is sufficient. That's
the use case we lead with.

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

# 7. Private swap on localnet (shield → adapt proof → mock adapter → unshield)
./ops/local-validator.sh --reset          # terminal 1
cd examples && pnpm swap-e2e              # terminal 2

# 7b. Same private swap, but on devnet against deployed programs.
#     Funded CLI wallet pays rent for fresh nullifier shards (~0.07 SOL each).
RPC_URL=https://api.devnet.solana.com pnpm --filter=@b402ai/solana-examples swap-e2e

# 7a. Scanner auto-discovery: Alice privately sends to Bob, Bob's scanner
#     discovers the note from public logs, Bob unshields to Charlie.
./ops/local-validator.sh --reset          # terminal 1
cd examples && pnpm scanner-e2e           # terminal 2

# 8. Private swap on a mainnet-forked validator (shield → Jupiter → unshield)
#    Fetches a live Jupiter quote, boots a validator with Jupiter + AMM state
#    cloned from mainnet, runs the flow against cloned bytecode.
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

## Status

Alpha. Single-key admin during alpha → 3-of-5 multisig migration scheduled.
Throwaway trusted-setup VK → multi-party ceremony in progress. External
audits scoped with Veridise / Trail of Bits / Zellic — reports linked here
when they land. Soft TVL cap during alpha; hard cap lands in `PoolConfig`
before community-promoted deposits. Stealth-address bech32 encoding +
production relayer hardening are next.

Read the full [PRD set](docs/prds/) for the design rationale behind every
decision. Issues + PRs welcome — adapter additions are the easiest contribution.
See [`SECURITY.md`](SECURITY.md) for disclosure and [`CONTRIBUTING.md`](CONTRIBUTING.md)
for setup.

## License

[Apache-2.0](LICENSE). Use [SECURITY.md](SECURITY.md) for responsible disclosure and
[CONTRIBUTING.md](CONTRIBUTING.md) for pull requests.

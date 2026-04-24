# b402-solana — review brief

Private shielded pool + composability layer on Solana. Circom + Groth16 + Anchor. This doc is the one-pager for someone doing a first review.

Counterpart to the b402 Railgun fork on Base/Arbitrum/BSC. Same UTXO model (commitments + nullifiers), same viewing/spending key separation, ported to Solana's account model.

## Quickstart

```bash
# 1. One-time toolchain setup
rustup install 1.89                                   # host rustc
# Solana 2.2.20 + platform-tools v1.54 must be installed

# 2. Build & test the cryptographic stack
cargo test -p b402-crypto --lib                        # 17 tests
cargo test -p b402-verifier-transact --test verify     # 3 tests
cd circuits && pnpm install && \
   RUN_PARITY=1 RUN_CIRCUIT_TESTS=1 pnpm vitest run    # 29 tests
cd ../packages/prover && \
   RUN_PROVER=1 RUN_VERIFIER=1 pnpm vitest run         # 4 tests

# 3. Build programs for Solana BPF + run on-chain integration
cargo build-sbf --tools-version v1.54 --manifest-path programs/b402-verifier-transact/Cargo.toml
cargo build-sbf --tools-version v1.54 --manifest-path programs/b402-pool/Cargo.toml
cargo build-sbf --tools-version v1.54 --manifest-path programs/b402-jupiter-adapter/Cargo.toml
cargo build-sbf --tools-version v1.54 --manifest-path programs/b402-mock-adapter/Cargo.toml
cd tests/onchain && cargo test                         # 14 on-chain tests

# 4. Track B — boot a real Solana validator with all programs deployed
./ops/local-validator.sh --reset          # terminal 1
./ops/smoke-validator.sh                  # terminal 2 — confirms deploys
```

Expected: **67 passing tests**, no failures.

## What's covered

| Layer | Tests | What's validated |
|---|---:|---|
| Rust crypto crate | 17 | Fr canonicality, Poseidon domain tags, Merkle IMT append/prove |
| Circom circuits | 9 | Witness generation, constraint rejection (4 tamper cases), end-to-end snarkjs prove-verify |
| Primitive parity (Rust ↔ TS) | 7 | Commitment, nullifier, spendingPub, merkle agree byte-for-byte |
| Prover package → Rust verifier | 4 | Groth16 proof produced by TS verifies in Rust code that ships on-chain (A-negation, G2 byte order, LE→BE flip) |
| On-chain shield | 8 | init_pool, add_token_config, valid shield, 5 rejection paths, double-shield tree advance |
| On-chain unshield | 2 | Full unshield with token transfer + nullifier insert; double-spend rejected with `NullifierAlreadySpent` |
| On-chain adapter delta | 3 | Balance-delta invariant (success at ≥ min_out, failure at < min_out, revert atomicity) |

All on-chain tests run against the *same .so bytecode* that would ship to mainnet, via `litesvm`'s in-process Solana VM.

## Pre-Phase-0 hardening (2026-04-23)

Three fixes landed before SDK action builders, in response to senior-engineer review:

1. **Recipient binding (was 🔴):** `unshield` proof now binds the recipient
   ATA's owner pubkey via `recipient_bind = Poseidon_3(tag, ownerLow, ownerHigh)`
   (collision-free 128/128 split). Pool re-derives from `recipient_token_account.owner`
   and rejects mismatch. Tested — see `unshield_rejects_wrong_recipient`.
2. **`adapt_mock` runtime gate:** the `check_adapter_delta_mock` instruction
   is always present in the dispatcher (Anchor macro requirement) but its body
   refuses to execute unless the binary was built with `--features test-mock`.
   Mainnet builds (default features) cannot reach the handler body.
3. **Root ring 64 → 128:** doubles the proof-freshness window. SDK should still
   fetch a fresh root immediately before proof generation, not at intent time.

## What's intentionally stubbed — please flag in review

1. **`adapt_execute` proper.** The full flow (adapt circuit with action-hash binding, input-note spending, output-note minting, CPI into real DeFi adapters) is not implemented. What IS implemented: a test-only `check_adapter_delta_mock` instruction that exercises the balance-delta invariant. See `programs/b402-pool/src/instructions/adapt_mock.rs`. Real `adapt_execute` requires:
   - `adapt.circom` = transact + 3 public inputs (adapter_id, action_hash, expected_out_value). New ceremony. New VK.
   - `b402_verifier_adapt` program (different VK from transact verifier).
   - `adapt_execute` handler orchestrating proof verify → note burn → adapter CPI → delta check → note mint.
   - Jupiter / Kamino / Drift / Orca per-adapter plumbing. The mock adapter proves the pattern works.

2. **UTXO indexer (wallet-side).** Users can't discover their own notes without scanning the tree. Needed for production wallet UX. Lives in `packages/relayer/` per PRD-06 — not written. See PRD-02 §4.3 for the viewtag pre-filter that makes scanning O(n) Poseidon instead of O(n) decryptions.

3. **Stealth-address encoding (`b402sol1q…`).** Primitives are all there (spending pub in BN254, viewing pub in X25519, per PRD-02 §2). The `bech32` encode/decode + SDK `sendToAddress(addr)` method is not written.

4. **Trusted setup.** Current `.zkey` is from a **throwaway ceremony** (`circuits/scripts/throwaway-ceremony.sh`). Single-contributor. DEVNET ONLY. Mainnet needs the 3-contributor Phase-2 ceremony per PRD-08 §2. The VK file `circuits/build/ceremony/verification_key.json` is baked into the verifier program at build time via `circuits/scripts/vk-to-rust.mjs`.

5. **Admin multisig.** Pool v1 scaffold uses a single-key admin (single pubkey compared against `pool_config.admin_multisig`). PRD-03 §9 specifies a full multisig co-signer pattern; not implemented.

6. **RelayAdapt-equivalent in `adapt_execute`** (PRD-04). Mock tested; real production path needs full adapt circuit + handler.

## Architectural shifts from the PRDs — note for PRD amendments

1. **`NullifierShard` capacity.** PRD-03 §5.7 specified variable-capacity `Vec<[u8; 32]>` with realloc. Reality: Solana's `MAX_PERMITTED_DATA_INCREASE = 10,240` caps CPI-initiated account size. Implementation uses a zero-copy `[u8; 9600]` buffer → 300 nullifiers per shard × 65,536 shards = ~19.6M total nullifier slots. Well within v1 budget. Future growth needs a top-level (not CPI) realloc instruction.

2. **Token-mint encoding to `Fr`.** PRD-02 §3.4 said "pass raw pubkey bytes, groth16-solana reduces mod p". Implementation passes raw 32B and the pool checks `pi.public_token_mint == token_config.mint` as a Pubkey equality before the verifier sees it. Tests enforce this via a fixture whose `publicTokenMint` Fr-encoding (111) equals its raw bytes (`[111, 0, ..., 0]`).

3. **Domain tags as public inputs.** PRD-02 §6.2 had them as private (with a build-time constant lookup). Implementation promoted them to 5 extra public inputs (total 16) so the pool program verifies the circuit committed to the canonical tag values, without needing a preprocessor. Proof size cost: +160B. Negligible.

## Repo map

```
b402-solana/
├── docs/prds/                  PRDs 01–08 + 01-A amendment
├── docs/SUBMISSION.md          Frontier submission strategy (internal)
├── circuits/
│   ├── lib/*.circom            Sub-circuits (commitment, nullifier, spendingPub, merkle, range)
│   ├── transact.circom         Main 2-in/2-out shielded transaction
│   ├── scripts/
│   │   ├── compile.sh          circom build
│   │   ├── throwaway-ceremony.sh
│   │   ├── vk-to-rust.mjs      Ceremony → verifier Rust source
│   │   └── gen-test-proof.mjs  Generate test fixtures (valid / alt / unshield)
│   ├── build/                  Compiled artifacts + ceremony output (gitignored)
│   └── tests/                  vitest: primitives + parity + witness + prove-verify
├── packages/
│   ├── crypto/                 Rust Fr / domain / Poseidon / Merkle, parity-tested against TS
│   ├── shared/                 TS shared types + encoding
│   ├── prover/                 @b402ai/solana-prover — snarkjs wrapper with on-chain byte layouts
│   ├── sdk/                    @b402ai/solana SDK scaffold (wallet, notes, main class)
│   └── relayer/                (empty; indexer + relayer service — not yet built)
├── programs/
│   ├── b402-verifier-transact/ Anchor Groth16 verifier; VK baked from ceremony
│   ├── b402-pool/              Anchor pool: init/add_token_config/shield/transact/unshield/admin
│   ├── b402-jupiter-adapter/   Jupiter V6 CPI adapter (scaffold, not integrated with pool)
│   └── b402-mock-adapter/      TEST-ONLY adapter for balance-delta tests
├── tests/onchain/              litesvm-driven integration tests (14 tests)
├── ops/
│   ├── local-validator.sh      Boot solana-test-validator with all programs deployed
│   └── smoke-validator.sh      Confirm deploys
├── Anchor.toml, Cargo.toml     Workspace configs
└── BUILD-STATE.md              Running internal doc — what's built, what's next
```

## Critical design choices

1. **Railgun-style UTXO model.** One unified pool per token (maximum anonymity set). Notes = `Poseidon(tokenMint, value, random, spendingPub)`. Nullifiers = `Poseidon(spendingPriv, leafIndex)`.
2. **Depth-26 Incremental Merkle Tree.** 67M leaf capacity. Poseidon-3 internal nodes with `b402/v1/mk-node` domain tag. 64-root ring buffer lets proofs reference recent roots without race conditions.
3. **Zero-copy account state.** `TreeState` (3.7KB) and `NullifierShard` (9.6KB) use `#[account(zero_copy)]` + `AccountLoader`. Without this, the `Account<'info, T>` inline materialization blew Solana's 4KB BPF stack on `transact`/`unshield`.
4. **Verifier CPI with Anchor discriminator.** Pool→verifier uses real Anchor-formatted instructions (not raw bytes). Discriminator = `sha256("global:verify")[..8]`. Verifier's `Verify` struct has no accounts to allow CPI without forwarding outer signers.
5. **Proof A Y-negation.** `groth16-solana` expects the pairing as `e(−A, B) · e(α, β) · … = 1`, so the prover package negates Y on proof_a before serialization. Caught during the first Rust-verifier test failure.

## Known footguns for future contributors

- Touch the Circom circuit → must rerun `compile.sh` → `throwaway-ceremony.sh` → `vk-to-rust.mjs` → SBF rebuild. Skip any step and tests fail cryptically.
- `indexmap` stays pinned to `=2.9.0` across SBF crates (Solana's rustc 1.84.1 can't handle `edition2024` that indexmap 2.10+ needs). `tests/onchain/` is outside the workspace specifically so litesvm can use the newer indexmap.
- The litesvm tests *cannot* reuse blockhashes for two txs with identical content — call `svm.expire_blockhash()` between duplicate tx sends.
- Shield fixture's `publicTokenMint = 111n` → test uses `Pubkey::new_from_array([111, 0, ..., 0])`. Real mint deployment requires fixture regeneration with the actual mint Pubkey.

## Contact points

- PRDs: `docs/prds/`
- Build state: `BUILD-STATE.md`
- Submission strategy: `docs/SUBMISSION.md`

## Recommended review order

1. PRD-02 (crypto spec) — verify the Poseidon params, merkle scheme, note encoding match what you'd expect from a Railgun fork.
2. `circuits/transact.circom` — the whole cryptographic commitment of the protocol. Focus on constraint completeness: no `<--` anywhere, all values range-checked, selector-guarded merkle verify, balance conservation.
3. `programs/b402-pool/src/instructions/shield.rs` + `unshield.rs` — instruction logic + CPI handoffs. Verify nullifier insert order vs. token transfer order.
4. `programs/b402-verifier-transact/src/lib.rs` + `vk.rs` — stateless, should be simple; double-check the LE/BE flip.
5. `tests/onchain/` — the invariants we believe hold. Add scenarios you want tested.

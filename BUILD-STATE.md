# Build state — what's in, what's next

Not for publication. Working doc for the next session.

## In (real, not placeholder)

### Crypto (Rust, `packages/crypto/`)
- `Fr` — BN254 scalar with canonical 32-LE encoding + tag-to-Fr
- Domain tags (13 tags, PRD-02 §1.2), pairwise-distinct test
- Poseidon wrapper over `light-poseidon` with domain-tagged helpers (commitment, nullifier, spendingPub, merkle node, fee bind, adapt bind)
- `MerkleTree` (depth 26) with append + prove + verify; client + on-chain modes
- `Note` / `Commitment` / `Nullifier` types, shard prefix derivation
- Unit tests covering determinism, input-dependence, tamper-rejection, tag collision

### Circuits (Circom 2.2, `circuits/`)
- `lib/commitment.circom` — Poseidon_5 commitment
- `lib/nullifier.circom` — Poseidon_3 nullifier
- `lib/spending_pub.circom` — Poseidon_2 pubkey derivation
- `lib/merkle_verify.circom` — depth-parameterized merkle path verify with bit-selected left/right mixing
- `lib/range_check.circom` — `Num2Bits`-based value bound
- `transact.circom` — 2-in/2-out, all PRD-02 §6.2 constraints (commitment recompute, merkle verify, nullifier derive, token consistency, balance conservation, public-amount exclusivity, fee bind). Domain tags promoted to public inputs with program-side verification.
- `tests/helpers.ts` — spec-level poseidon parity + ClientMerkleTree mirror
- `tests/primitives.test.ts` — determinism, distinctness, merkle roundtrips (no circuit compile required)
- `tests/transact.test.ts` — witness-level happy path + 4 negative cases (gated by `RUN_CIRCUIT_TESTS=1`)
- `scripts/compile.sh`, `scripts/throwaway-ceremony.sh`

### Pool program (`programs/b402-pool/`)
- `constants.rs` — all PDA seeds + all domain-tag constants as compile-time LE Fr
- `state.rs` — `PoolConfig`, `TokenConfig`, `TreeState`, `NullifierShard`, `AdapterRegistry`, `TreasuryConfig`
- `error.rs` — full PRD-03 §3.2 taxonomy, stable numbers
- `events.rs` — 8 events for indexer reconstruction
- `util.rs` — `tree_append` mirroring client merkle bit-for-bit, `nullifier_insert` with sorted binary-search insert, shard-prefix derivation
- `instructions/init_pool.rs` — computes zero_cache + initial root via sol_poseidon, writes config/tree/registry/treasury
- `instructions/add_token_config.rs` — creates TokenConfig + vault ATA with pool-signer authority
- `instructions/shield.rs` — verifier CPI, token transfer, tree append, event emit
- `instructions/transact.rs` — nullifier shard writes, ordering check, tree append for change notes
- `instructions/unshield.rs` — verifier CPI, nullifier writes, recipient + relayer-fee token transfers with pool-signer seeds, never-pauseable semantics
- `instructions/admin.rs` — pause/unpause, register_adapter; single-key admin for v1 (multisig flow to follow)
- `instructions/verifier_cpi.rs` — structured CPI into verifier program

### Verifier program (`programs/b402-verifier-transact/`)
- Scaffold wired to `groth16-solana`. VK slot present but gated with `UninitializedVk` until ceremony runs + build script replaces the constant. Proof (A,B,C) split + public-input (16×32) parse implemented.

### Jupiter adapter (`programs/b402-jupiter-adapter/`)
- Full `execute` handler: records pre-balance, CPIs Jupiter V6 with forwarded route_plan + `remaining_accounts`, transfers output to pool vault, enforces min_out slippage. Adapter PDA signer flow end-to-end.

### TypeScript SDK (`packages/sdk/`, `packages/shared/`)
- `@b402ai/solana-shared`: constants, domain-tag encoding, Fr LE codec, program IDs, public input count
- `@b402ai/solana`:
  - `buildWallet(seed)` — HKDF-style spending (Fr/Poseidon) + viewing (X25519) derivation per PRD-02 §2
  - `poseidon.ts` — circomlibjs wrapper with domain-tagged helpers matching Rust + Circom
  - `merkle.ts` — `ClientMerkleTree` mirroring Rust `MerkleTree`
  - `note-encryption.ts` — ChaCha20-Poly1305 + X25519 ECDH + Poseidon viewing tag, encrypt/decrypt round-trip
  - `note-store.ts` — RPC log subscription scaffold + `ingestCommitment` direct-claim path
  - `errors.ts` — structured error codes matching PRD-06
  - `b402.ts` — `B402Solana` class with wallet, note store, status(); shield/unshield/privateSwap throw `NotImplemented` until prover WASM + deployed programs wire in

## Test status (2026-04-23, post ceremony + prover)

| Suite | Tests | Status |
|---|---:|---|
| Rust `b402-crypto` unit | 17 | ✓ |
| Rust `b402-verifier-transact` integration (real proof from fixture) | 3 | ✓ |
| TS circuits primitives | 13 | ✓ |
| TS circuits parity (Rust ↔ TS) | 7 | ✓ |
| TS circuits witness (transact shield + 4 negatives) | 5 | ✓ |
| TS circuits end-to-end prove+verify (snarkjs) | 4 | ✓ |
| TS prover unit | 2 | ✓ |
| TS prover → Rust verifier integration | 2 | ✓ |
| **Total** | **53** | **all green** |

Critical end-to-end gate achieved:
- TS builds witness → prover package emits Groth16 proof bytes in on-chain format
- Those exact bytes fed into the same Rust code that ships on-chain via `b402-verify-cli`
- Verification passes. Tampering fails.

This means the whole Circom → ceremony → prover → verifier pipeline is
cryptographically correct across all three implementations and byte layouts
agree. Next step is the SDK action builders, which are plumbing on top of
this validated stack.

Bugs caught and fixed during this round:
1. **light-poseidon 0.3 → 0.4 + ark 0.4 → 0.5** version mismatch (wouldn't compile)
2. **`Fr::from_le_bytes` canonicality check** — accepted `p` as canonical because loop fell through with initial `true` (now `false` + strict less-than)
3. **Circom degree-2 constraint violation** on balance sum — split to aux `inWeighted`/`outWeighted` signals
4. **Circom include paths** — `-l node_modules` convention, not nested relative
5. **Merkle-verify for dummy inputs** — promoted to `MerkleRoot` + selector-guarded equality (structural, not style)
6. **Invalid base58 program IDs** — regenerated with real pubkeys
7. **groth16-solana proof A Y-negation** — adjusted in both generator script and prover package

## SBF build state (2026-04-23, post zero-copy refactor)

All three programs compile for the Solana BPF target:

| Program | Size | Status |
|---|---:|---|
| `b402_verifier_transact.so` | 184 KB | ✓ |
| `b402_pool.so` | 411 KB | ✓ |
| `b402_jupiter_adapter.so` | 194 KB | ✓ |

Compiled via `cargo build-sbf --tools-version v1.54`. Solana's bundled rustc
1.84.1 + platform-tools 1.54 (newer rustc stabilizes `edition2024` used by
transitive deps).

### Bugs fixed during SBF build

1. `indexmap 2.14` requires `edition2024` — **pinned** to `=2.9.0` in all program crates.
2. `init_if_needed` requires the matching anchor-lang feature — enabled in pool.
3. Solana BPF 4 KiB stack overflow on `transact`/`unshield` (frame sizes 8.8 KB and 10 KB). **Root causes + fixes:**
   - Heavy `[u8; 256]` / `[EncryptedNote; 2]` args — moved to `Vec<u8>` / `Vec<EncryptedNote>` (heap) with entry-time length asserts.
   - `[[u8; 32]; 16]` public-input buffer on stack — built incrementally into `Vec<[u8; 32]>` via a `#[inline(never)]` helper.
   - Dominating problem: `Account<'info, TreeState>` materializes the 3.7 KB struct inline; `Account<'info, NullifierShard>` materializes 64 KB inline. **Structural fix:** converted both to `#[account(zero_copy)]` + `AccountLoader<'info, _>`. Zero memcpy to stack; access via `load()` / `load_mut()` / `load_init()` returns `Ref`/`RefMut` pointing at account data.
4. Host-only dev binaries (`b402-verify-cli`) gated with `required-features = ["host-bins"]` to keep them out of SBF builds.
5. Jupiter program ID constant — `anchor_lang::solana_program::pubkey!` doesn't resolve on SBF; replaced with explicit `Pubkey::new_from_array([...])` of the base58-decoded bytes.

### Critical design shift from PRD-03

`NullifierShard` was specified in PRD-03 as a Borsh `Vec<[u8; 32]>` that grows via `realloc`. Implementation found this incompatible with the stack budget — zero-copy requires fixed-size arrays. Updated to `[[u8; 32]; 2048]` with an explicit `count` field. At saturation, each shard is ~64 KB; across 65,536 shards that's ~134 M nullifier slots, well beyond v1 needs. **This changes §5.7 and §3.3 of PRD-03 — update before final sign-off.**

## Next (in order)

1. **Compile the circuit** — run `cd circuits && pnpm install && pnpm build`, pin the R1CS constraint count, commit the artifact.
2. **Throwaway ceremony for devnet** — `pnpm ceremony:throwaway` → grab `verification_key.json`.
3. **Bake VK into verifier program** — `build.rs` reads `verification_key.json`, emits `const VK: Groth16Verifyingkey = ...`; flip the `UninitializedVk` gate.
4. **`@b402ai/solana-prover` package** — loads the compiled WASM + `.zkey`, `proveTransact(witness)` returns `Groth16Proof`.
5. **Action builders (`packages/sdk/src/actions/`)** — `shield.ts`, `unshield.ts`, `privateSwap.ts`: assemble witness, call prover, build `VersionedTransaction` with `SetComputeUnitLimit`, submit via relayer or self-pay.
6. **Parity test suite (`tests/parity/`)** — cross-check Rust ↔ TS ↔ Circom produce identical commitments/nullifiers/merkle-roots across 10k random inputs. Gate: CI required.
7. **Devnet deploy** — `anchor deploy --provider.cluster devnet`, seed init_pool + add_token_config for USDC/wSOL, register Jupiter adapter.
8. **End-to-end integration test** — `tests/e2e/shield-swap-unshield.ts` exercises the full flow on devnet.
9. **Relayer service (`packages/relayer/`)** — Fastify HTTP with `POST /v1/relay/submit`, fee quoting, Jito-bundle optional submit, matching b402 EVM relayer ops conventions (Cloud Run, IPv4-first, no CPU throttling).
10. **MCP tool mapping** — `b402-mcp`'s existing 12 tools gain `chain: 'solana'` routing.

## Circuit audit pass (2026-04-23, against `circom-dev` skill)

Ran a best-practices audit of `transact.circom` against the `circom-dev`
skill's `references/best_practices.md`. Two real bugs found and fixed:

1. **Signal arrays declared inside for-loops** — `nullSelected[2]` and
   `commitSelected[2]` were redeclared each iteration. Hoisted to template
   scope. Fix: `circuits/transact.circom`.

2. **Merkle verify unconditionally enforced for dummy inputs** — dummy
   notes produce non-zero commitments that cannot satisfy any real merkle
   path. This would have broken every unshield and transact with a dummy
   input. Fix: split `MerkleVerify` → `MerkleRoot` (computes only) and
   selector-guard the equality check in `transact.circom` via
   `(1 - isDummy) * (computedRoot - merkleRoot) === 0`. See
   `circuits/lib/merkle_verify.circom` + `transact.circom`.

Other best-practices checks passed:
- No `<--` anywhere (all `<==` or `===`)
- All inputs range-checked where needed (64-bit values)
- No division ops
- Public/private signals explicit
- Boolean constraints on all flag inputs

To add to CI (pending): `circomspect` + `PICUS` static analysis per the
skill's security checklist. Tracked in PRD-07 §2.1 toolchain update.

## Gate-close round 2 (2026-04-23, post zero-copy + unshield + adapter-delta)

**On-chain tests: 14/14 green across 4 suites:**
- `tests/onchain/tests/shield.rs` — 8 tests (happy path + 5 rejections + double-shield)
- `tests/onchain/tests/unshield.rs` — 2 tests (full unshield + double-spend rejected)
- `tests/onchain/tests/adapt_delta.rs` — 3 tests (exact min_out, over-delivery, under-delivery rejection)
- `tests/onchain/src/discriminator.rs` — 1 test (discriminator stability)

**Track B smoke proven:** `./ops/local-validator.sh --reset` + `./ops/smoke-validator.sh` boots a real solana-test-validator with all 4 programs deployed and verified.

**`check_adapter_delta_mock` is TEST-ONLY.** The real `adapt_execute` is deferred:
- Needs `adapt.circom` (transact + 3 extra public inputs: adapter_id, action_hash, expected_out_value).
- Needs new ceremony + `b402_verifier_adapt` program.
- Needs full `adapt_execute` handler with proof verify → nullifier insert → adapter CPI → delta check → commitment append.
- Jupiter/Kamino/Drift/Orca per-adapter integration pending.

The mock validates the **balance-delta invariant** (the security-critical post-CPI check) without the surrounding machinery. Same invariant will apply in the real implementation.

**Bug caught by TDD this round:**
1. Nullifier shard capacity (2048 × 32B = 65KB) exceeded Solana's `MAX_PERMITTED_DATA_INCREASE = 10,240` for CPI-initiated account creation. **Structural PRD-03 §5.7 amendment:** reduced to 300 × 32B per shard (9.6KB), still 19.6M total nullifier slots.
2. bytemuck `Pod` only auto-implements for fixed array sizes up to N=32. Had to wrap the 9600-byte buffer in a newtype with manual `unsafe impl Pod/Zeroable`.
3. litesvm dedupes transactions by signature; same-blockhash same-payload txs never reach program. Fix: `svm.expire_blockhash()` between duplicate sends.
4. Anchor `execute` discriminator miscomputed manually — caught by test rejecting for wrong reason, verified via Node helper.

## Known shortcuts (documented, not hidden)

- Token mint encoding passed to verifier as raw pubkey bytes (reduced in Fr at verifier side). Alternate design with Fr-reduced binding to TokenConfig PDA noted in PRD-02 §3.4.
- Admin is single-key for v1 scaffold (PRD-03 §9). Multisig co-signer pattern tracked as follow-up.
- Note store's `handleLogs` is a stub-acknowledgment until the Anchor IDL ships with a generated decoder — `ingestCommitment` direct-claim path exercises the real decrypt flow.
- Circuit nullifier-ordering constraint is enforced in the program (PRD-03 §4.4 step 6), not in-circuit. Revisit per PRD-02 §12 Q2.
- Verifier VK is placeholder-gated with explicit runtime panic (`UninitializedVk`) until ceremony runs — no chance of an unverified deploy.

## Gate-close round 3 (2026-04-23 → 2026-04-24, devnet deploy + Phase 1)

**Devnet deployment** (from program keypairs in `ops/keypairs/`, gitignored):

| Program | Program ID | Rent |
|---|---|---|
| Pool | `42a3hsCXtQLWonyxWZosaaCJCweYYKMrvNd25p1Jrt2y` | 2.99 SOL |
| Verifier | `Afjbnv2Ekxa98jjRw33xPPhZabevek2uZxoE75kr6ZrK` | 1.28 SOL |
| Jupiter adapter | `3RHRcbinCmcj8JPBfVxb9FW76oh4r8y21aSx4JFy3yx7` | 1.35 SOL |

**Live shield/unshield on devnet, round-tripped:**
- shield sig `5XLaccuw6tv6AWowMDKLK24zTSxD4Ej2nuRwSnpbLWZSHU19SPb7n8mNpx8G4fHEHxBMRo5GiYPyPj6G4pmsLyZB`
- unshield sig `38mKQXBPuwtYhM5JvbyJA2se9cehMvw1mUbevhERAkZdni7a6VTYdYNx66nZ5KqzbgUng1SsbCiQEJX2F3XG77PD`
- shield 1299ms, unshield 1387ms, 100 synthetic-mint units through the full circuit on real Solana devnet

See `docs/TX-WALKTHROUGH.md` for account-by-account breakdown.

### Phase 1 — adapter composability plumbing (2026-04-24)

Goal: wire `adapt_execute` end-to-end **without** the adapt circuit so we
can validate pool + SDK + ALT budgeting on devnet before ceremony work.

1. **b402 ALT on devnet**: `9FPYufa1KDkrn1VgfjkR7R667hbnTA7CNtmy38QcsuNj`, 14 stable
   accounts (programs, PDAs, common mints, Jupiter-adapter scratch ATAs).
   Extensible per-adapter via `ops/alt/create-alt.ts add-adapter`.
   Without it, 2-hop Jupiter routes overflow Solana's 1,232 B tx cap.

2. **`adapt_execute_devnet` handler** behind `--features adapt-devnet`:
   - Registry lookup (adapter program + ix discriminator allowlisted)
   - Pool signs `in_vault → adapter_in_ta` transfer
   - CPI adapter.execute with caller-supplied raw ix data + accounts
   - Post-CPI balance-delta invariant on `out_vault`
   - Append caller-supplied output commitment to tree
   - Emit `AdaptExecutedDevnet` + `CommitmentAppended`

   Security property: **none** (no proof verification, no nullifier
   burn, output commitment trusted from caller). Devnet-only. Gated via
   runtime `cfg!` check so default builds and any mainnet build that
   forgets `--features` cannot dispatch the instruction.

3. **SDK `privateSwap` builder**:
   - Takes a pre-fetched Jupiter swap instruction from `/swap-instructions`
   - Composes adapter's Anchor ix data `disc || in_amount || min_out || vec(payload)`
   - Builds v0 tx with `[B402 ALT, ...jupiterAlts]`, asserts ≤ 1232 B
   - Enforces `MAX_ACTION_PAYLOAD = 350 B` pre-build (PRD-04 §5.3 allows 400)
   - Splits into pure `buildPrivateSwapTx` (no I/O) for size-regression testing

4. **Tx-size regression** (`packages/sdk/src/__tests__/tx-size.test.ts`):
   - 2-hop Jupiter (14 accounts, 180 B payload) with b402 ALT → ≤ 1232 B ✓
   - 3-hop Jupiter (20 accounts, 280 B payload) with b402 ALT → ≤ 1232 B ✓
   - action_payload > ceiling throws pre-build ✓
   - Same 3-hop WITHOUT any ALT overflows (documents the dependency) ✓

### Test status (post Phase 1)

| Suite | Tests | Status |
|---|---:|---|
| Rust `b402-crypto` unit | 17 | ✓ |
| Rust verifier integration | 3 | ✓ |
| TS circuits primitives + parity | 20 | ✓ |
| TS circuits witness + prove-verify | 9 | ✓ |
| TS prover → Rust verifier | 4 | ✓ |
| On-chain shield (litesvm) | 8 | ✓ |
| On-chain unshield (litesvm) | 3 | ✓ |
| On-chain adapt-delta (litesvm) | 3 | ✓ |
| SDK tx-size regression | 4 | ✓ |
| **Total** | **71** | **all green** |

Plus live devnet shield + unshield txs as the 72nd + 73rd "tests".

### Deferred to Phase 2

- **Adapt circuit** (`adapt.circom`): transact + `adapter_id`, `action_hash`,
  `expected_out_value` public inputs. New ceremony. New `b402_verifier_adapt`
  program with its own VK.
- **Full `adapt_execute`** handler: proof verify → nullifier burn → adapter
  CPI → delta check → commitment append, replacing the devnet-gated stub.
- Kamino / Drift / Orca adapters (one per protocol, same `execute` ABI).
- Relayer HTTP service + Jito bundle submission.
- Scanner auto-discovery e2e (Task D): recipient's wallet finds its own
  output notes from the log subscription without being told the leaf index.

## Gate-close round 4 (2026-04-24, Phase 1 composability end-to-end)

Three end-to-end flows proven today, each building on the last:

### Task A — localnet shield → private swap → unshield (mock adapter)

Unified the mock-adapter ABI with the jupiter-adapter shape (3-arg
`execute(in_amount, min_out, payload)`, canonical `[b"b402/v1", b"adapter"]`
PDA seeds). `adapt_execute_devnet` in the pool drives either adapter
identically. Full round-trip on `solana-test-validator`:

- shield 100 in_mint → commitment at leaf 0, in_vault = 100
- `adapt_execute_devnet` swap via mock: in_vault=50, mock CPI delivers
  100 out_mint to out_vault, output commitment appended at leaf 1
- unshield output note with real Groth16 proof → fresh recipient gets 100

Localnet signatures logged. Timings: shield ~1100ms, swap 466ms, unshield 1072ms.
All 15 on-chain tests + 4 SDK tx-size tests green after the ABI unification.

### Task B — pool redeploy on devnet with `--features adapt-devnet`

Upgraded `42a3hsCXtQLWonyxWZosaaCJCweYYKMrvNd25p1Jrt2y` in place — same
program ID, existing upgrade authority (`4ym542u1...`). Buffer rent
~3.2 SOL was returned after the swap; net cost was fees only (~0.21 SOL).
Pool now dispatches `adapt_execute_devnet` on devnet while mainnet
builds (no feature flag) still reject the instruction at the runtime
`cfg!` gate.

### Option 1 — real Jupiter swap on mainnet-forked validator

`ops/mainnet-fork-validator.sh` boots `solana-test-validator` with:

- `--clone-upgradeable-program` for Jupiter V6 + every AMM program in
  the route (detected via `getAccountInfo(executable)` in `ops/jup-quote.ts`)
- `--maybe-clone` for every data account referenced by the swap ix
- Built-in programs (System, Token, ATA, Sysvars, ComputeBudget, BPF
  loaders) filtered so solana-test-validator's own copies are used
- All four b402 programs `--bpf-program`'d alongside

`examples/swap-e2e-jupiter.ts` then ran the full flow against real
Jupiter bytecode + real AMM pool state:

| Step | Amount | Signature |
|---|---|---|
| Shield | 0.1 wSOL (100,000,000 lamports) | `3GyU6qst…FCcZA` |
| **Real Jupiter swap** | 0.1 wSOL → 8.549 USDC via SolFi V2 | `3BzF7M8W…FXEZ` (512ms) |
| Unshield | 8.509 USDC → fresh recipient | `bccbx7RG…Hq6` |

Post-swap assertions: `wsol_vault=0`, `usdc_vault=8549123` (≥ min_out
8509157), output commitment appended at leaf 1, recipient got 8509157
USDC. Tx size 1231 B (1 B under cap, no ALT).

Two production fixes landed in the process:
1. **jupiter-adapter signer escalation**: CPI to Jupiter needs
   `userTransferAuthority` (= adapter PDA) marked as `is_signer=true`.
   Adapter was copying the false flag from forwarded accounts. Fix:
   explicitly mark the adapter PDA as signer in the CPI ix so
   `invoke_signed`'s seeds satisfy Jupiter's requirement.
2. **Program classification in `ops/jup-quote.ts`**: route contains
   ~18 accounts of mixed type. AMM programs need
   `--clone-upgradeable-program`; data accounts need `--maybe-clone`;
   built-ins must be skipped entirely. Quote script now classifies
   via `getAccountInfo` and filters a hardcoded built-ins set.

### Observed on-chain costs (Solana)

| Op | Tx size | Compute | Fee |
|---|---|---|---|
| Shield | 1,157 B | 239,224 CU | 5,000 lamports (~$0.001) |
| Unshield | ~1,150 B | ~350k CU | 5,000 lamports |
| Private swap (shield→adapt→unshield chain) | shield+swap+unshield = 3 txs | ~1M CU total | ~15,000 lamports (~$0.003) |

Under a quarter of what a Railgun EVM shield costs on Base at current
base-fee + priority; proof verification fits inside one Solana ix at
1.4M CU budget (no multi-tx split needed).

### Three new ops scripts

| Path | What |
|---|---|
| `ops/jup-quote.ts` | Fetch Jupiter `/quote` + `/swap-instructions` from mainnet, classify accounts (programs vs data vs built-in), emit `{quote, swap, programs, data}` JSON for the fork validator. |
| `ops/mainnet-fork-validator.sh` | Boot test-validator cloning Jupiter + all AMM programs + AMM state from mainnet, with all four b402 programs pre-deployed. |
| `examples/swap-e2e-jupiter.ts` | End-to-end shield → real Jupiter swap → unshield against the fork. Asserts vault deltas + recipient balance. |

### Test status (post round 4)

| Suite | Tests | Status |
|---|---:|---|
| Rust `b402-crypto` unit | 17 | ✓ |
| Rust verifier integration | 3 | ✓ |
| TS circuits primitives + parity | 20 | ✓ |
| TS circuits witness + prove-verify | 9 | ✓ |
| TS prover → Rust verifier | 4 | ✓ |
| On-chain shield (litesvm) | 8 | ✓ |
| On-chain unshield (litesvm) | 3 | ✓ |
| On-chain adapt-delta (litesvm) | 3 | ✓ |
| SDK tx-size regression | 4 | ✓ |
| **Total** | **71** | **all green** |

Plus three live round-trips: devnet shield+unshield (round 3), localnet
shield+swap+unshield via mock adapter (Task A), mainnet-fork
shield+real-Jupiter-swap+unshield (Option 1). Six real tx signatures
captured in the logs.

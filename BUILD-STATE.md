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

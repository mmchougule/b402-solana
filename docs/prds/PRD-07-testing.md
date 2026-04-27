# PRD-07 — Testing Strategy & TDD Plan

| Field | Value |
|---|---|
| **Status** | Draft — awaiting review |
| **Owner** | b402 core |
| **Date** | 2026-04-23 |
| **Version** | 0.1 |
| **Depends on** | PRD-02, 03, 04, 05, 06 |
| **Gates** | Audit readiness (PRD-08) |

This PRD defines the test architecture that every circuit, program, and SDK component must pass before audit sign-off. The guiding principle: **no component ships without layered tests demonstrating it works, breaks when it should, and matches reference implementations bit-for-bit.**

TDD is mandatory for circuits (the highest-risk layer). Tests are written as the spec evolves; circuit code is written to pass them.

---

## 1. Layer-by-layer coverage targets

| Layer | Unit | Property | Differential / Parity | Fuzz | Integration | E2E |
|---|---|---|---|---|---|---|
| Poseidon / primitives | ✓ | ✓ | ✓ (circomlib ↔ Rust ↔ TS) | ✓ | — | — |
| Merkle (IMT) | ✓ | ✓ | ✓ (spec ↔ impl) | ✓ | — | — |
| Note encryption | ✓ | ✓ | ✓ (X25519, ChaCha test vectors) | ✓ | — | — |
| Circuits (transact, adapt, disclose) | ✓ | ✓ | ✓ (Rust witness ↔ Circom witness) | ✓ | ✓ | — |
| Verifier programs | ✓ | — | ✓ (groth16-solana) | — | ✓ | — |
| Pool program | ✓ | ✓ | — | ✓ (fuzz instructions) | ✓ | ✓ |
| Adapters | ✓ | ✓ | — | ✓ | ✓ (mainnet fork) | ✓ |
| SDK | ✓ | ✓ | ✓ (vs circuits) | — | ✓ | ✓ |

Coverage gate:
- Unit tests: **≥ 95% line + branch** for circuits and programs, ≥ 85% for SDK.
- Mutation score: **≥ 70%** for circuit-adjacent code (measured via `stryker-js` for TS, `cargo-mutants` for Rust).

---

## 2. Circuit TDD

### 2.1 Toolchain

- **Compiler:** `circom 2.2.x` (pinned). Compile with `--r1cs --wasm --sym --c`.
- **Witness generator:** compiled WASM.
- **Prover:** `snarkjs` for unit tests; `rapidsnark` for perf tests.
- **Test harness:** `circom_tester` (JS) + `vitest` runner.
- **Rust parity:** `ark-works` primitives + hand-rolled spec implementations.
- **Python reference:** optional, `iden3/py_iden3_crypto` for cross-check.
- **Static analysis:** `circomspect` (Trail of Bits) on every PR; `PICUS`
  automated-verification on main-branch nightly. Both target the full circuit
  tree under `circuits/`. Any new lint from circomspect fails CI.

### 2.2 Per-template unit tests

For every circomlib / custom template (Poseidon_k, merkle_verify, range_check, commitment, nullifier, transact):

1. **Happy path** — valid inputs produce valid witness.
2. **Expected failure** — each constraint individually; flip one input bit per test, assert witness generation fails with expected error.
3. **Boundary conditions** — 0, p-1, 2^64-1 for range-bounded fields.
4. **Domain tag enforcement** — swap tag, assert output differs.
5. **Constraint-count snapshot** — R1CS constraint count, public/private signal count frozen; CI fails on unexpected drift.

Example structure (vitest + circom_tester):

```typescript
describe('transact circuit', () => {
  let circuit: Circuit;
  beforeAll(async () => { circuit = await circomTester('circuits/transact.circom'); });

  it('generates valid witness for 1-in 2-out shield', async () => {
    const w = await circuit.calculateWitness(validShieldInputs());
    await circuit.checkConstraints(w);
  });

  it('rejects mismatched nullifier', async () => {
    const bad = { ...validInputs(), nullifier_0: '0xDEAD' };
    await expect(circuit.calculateWitness(bad)).rejects.toThrow(/constraint/i);
  });

  // ... 40+ additional tests
});
```

### 2.3 Property-based tests

Using `fast-check`:

```typescript
test.prop([feArbitrary, feArbitrary])(
  'Poseidon_2(x, y) == Poseidon_2(x, y)',
  async (x, y) => {
    const a = await poseidon2(x, y);
    const b = await poseidon2(x, y);
    expect(a).toBe(b);
  }
);

test.prop([noteArbitrary])('commitment round-trip via circuit matches offline', async (note) => {
  const offline = await commitmentSpec(note);
  const onchainPub = await transactCircuit.calcPublicOut(note);
  expect(onchainPub.commitment).toBe(offline);
});
```

Run: ≥ 10,000 iterations per property in CI (parallel workers).

### 2.4 Parity across implementations

Three parallel implementations of every primitive:
- **Circom** (as constraint system, verified via witness gen).
- **TypeScript** (`@b402ai/solana` internal).
- **Rust** (`b402-crypto` crate, used by program/adapter tests).

Parity tests: generate 10,000 random inputs; each impl must produce bit-identical outputs. Any divergence fails CI.

### 2.5 Negative-test taxonomy (every circuit MUST cover)

1. Under-constrained signal — pass different values for the same logical position, both witness OK.
2. Over-constrained signal — inputs that should be valid rejected.
3. Missing domain tag — commitment derived without tag accepted.
4. Wrong arity Poseidon — `k=2` used where `k=3` expected.
5. Merkle path with wrong pathBits.
6. Range-check bypass — value ≥ 2^64 accepted.
7. Duplicate nullifier within one proof.
8. Zero-sentinel abuse — `nullifier = 0` accepted as real spend.
9. Fee-bind mismatch — relayer_fee public differs from bound recipient+amount.
10. Public amount exclusivity — both in and out > 0.
11. Token-mint cross — input note mint ≠ output note mint.
12. Balance wrap — values near `p` exploited to bypass sum check.

Each gets a named test. Missing any blocks audit sign-off.

### 2.6 Differential against the Groth16-privacy-pool construction class

Spend, commit, and nullifier math here uses the same construction class as Railgun, Aztec, and Tornado Cash (Groth16 + Poseidon + UTXO commitments + nullifiers). The implementation is independent (Circom 2 sources, no shared code), but the canonical primitives must remain byte-compatible with the published constructions for any third-party reference vector. Where a primitive overlaps with Railgun's published reference, we generate vectors from that reference and assert byte-equality on Poseidon + merkle path checks. Catches domain-tag mistakes and parameter drift early.

---

## 3. Program tests (Anchor)

### 3.1 Unit tests (`cargo test`)

- Per-handler tests using `anchor-test` harness.
- Fake accounts + mocked CPIs to verifier.
- Invariant checks (e.g., `insert_nullifier` preserves sort order + rejects duplicates).

### 3.2 Instruction-level property tests

```rust
#[test_strategy::proptest]
fn shield_never_drains_vault(#[strategy(any_valid_shield_args())] args: ShieldArgs) {
    let mut ctx = mock_ctx();
    let pre = ctx.vault_balance();
    let _ = shield::handler(ctx.clone(), args);
    // Vault increases on success, unchanged on failure. Never decreases.
    prop_assert!(ctx.vault_balance() >= pre);
}
```

### 3.3 Fuzz tests

- `cargo-fuzz` target per instruction handler.
- Inputs: arbitrary `ShieldArgs`, `TransactPublicInputs`, proof bytes.
- Oracle: program must either succeed (state consistency preserved) or return a typed `PoolError`; never panic, never produce inconsistent state.
- CI runs 10 min per target per commit. Extended 4-hour runs on main branch weekly.

### 3.4 Invariant tests

Execute random sequences of instructions; assert global invariants hold after each:

1. **Conservation:** `Σ vault_balances = Σ shielded_values` (since protocol fee = 0).
2. **Nullifier monotonicity:** no nullifier ever un-inserts.
3. **Root ring ordering:** `root_ring[i+1]` derives from `root_ring[i]` via append.
4. **Leaf-count monotonicity:** `leaf_count` only grows.
5. **Config immutables:** `deployed_slot`, `admin_multisig` (unless explicit rotate) never change.

### 3.5 Specific regression suites

One test per known hazard:

- Unshield cannot be paused.
- Pause flags reset only via admin.
- Double-spend within one tx (both nullifier indices equal) rejected.
- Adapter disabled mid-tx (registry flipped by admin) — next tx using that adapter must fail cleanly.
- Proof replay across different roots — rejected via root ring.

---

## 4. Verifier program tests

- **Canonical cases:** proofs generated by SDK for known witnesses, verified successfully.
- **Malleability:** flip single bits of proof; verify rejects.
- **Wrong VK:** verifier hardcoded VK-A, submit proof generated against VK-B; rejects.
- **Public input count mismatch:** submit fewer/more inputs; rejects.
- **Benchmarks:** CU cost within ±5% of budget (PRD-03 §8).

---

## 5. Integration tests

### 5.1 Localnet full-flow

`tests/integration/` uses Solana `solana-test-validator` with all b402 programs deployed plus mock Jupiter / Kamino / Drift / Orca programs (minimal stand-ins for CPI shape).

Scenarios:

1. Cold wallet → shield → status shows balance → unshield to clean address → chain view unlinked.
2. Shield → transact (internal transfer) → transferee scans and sees note → transferee unshields.
3. Shield → privateSwap → new shielded note of different mint → unshield.
4. Shield → privateLend → privateRedeem → unshield.
5. Concurrent 10 shields in one block — all succeed, tree consistent.
6. Nullifier double-spend attempt — second tx rejects.
7. Relayer fee bind tamper — rejects.
8. Admin pause → shield fails → unshield succeeds → unpause → shield succeeds.

### 5.2 Mainnet-fork tests

`solana-test-validator --clone` for mainnet state. Exercise adapters against real Jupiter/Kamino/Drift/Orca programs with forked liquidity.

Tests run nightly; flag any adapter regression caused by external program upgrades.

---

## 6. End-to-end tests

`tests/e2e/` scripts, run manually and by CI on devnet:

1. Deploy programs fresh.
2. Init pool, whitelist USDC + WSOL, register Jupiter adapter.
3. Seed trusted setup with throwaway ceremony (Track B only).
4. Shield USDC (real devnet USDC mint or equivalent).
5. Run privateSwap.
6. Run privateLend (Kamino devnet).
7. Verify events, on-chain state, SDK status reports.

Passes gate every Track B demo cut.

---

## 7. SDK tests

- **Unit:** every method with mocked program interactions.
- **Deterministic proof:** fixed seed + input → exact bytes out.
- **Scan correctness:** synthetic event stream → SDK discovers exactly our notes, skips others.
- **Error surface:** inject each `PoolError` → SDK surfaces correct `B402ErrorCode`.
- **Multi-chain dispatch:** via `@b402ai/sdk`, `chain: 'solana'` routes through Solana adapter, `chain: 'base'` routes through EVM. Unit-tested with mocked adapters.

---

## 8. Benchmarks

`bench/` directory with criterion-rs + vitest-bench:

| Benchmark | Target |
|---|---|
| Poseidon_3 in-circuit constraint count | ≤ 240 |
| Transact circuit R1CS total | ≤ 35,000 |
| Transact proof gen (rapidsnark, 8-core) | p50 ≤ 1.5 s |
| Adapt proof gen | p50 ≤ 2.0 s |
| Verify program CU (transact) | ≤ 200,000 |
| Shield end-to-end latency | p50 ≤ 3 s |
| Note scan throughput (10k commitments) | ≥ 5,000 / s |

CI records bench values; regression > 10% fails the build.

---

## 9. Audit-readiness artifacts

By PRD-08 sign-off, this PRD's work produces:

1. **Test vectors file** (`tests/vectors.json`) — inputs + expected outputs for every primitive. Ships with the SDK. Auditors use it to spot-check independent impls.
2. **Constraint count report** — CSV of R1CS/public-input counts per circuit. Published in repo, tracked in CI.
3. **CU budget report** — measured values for every instruction, per git SHA.
4. **Coverage report** — HTML published per PR.
5. **Fuzz corpus** — seed corpus + CI-discovered corpus archived.
6. **Property-test statistics** — per property, number of iterations + any shrunk counterexamples saved.

---

## 10. CI pipeline

```
PR open:
  ├─ Circuit unit tests          (5 min)
  ├─ Circuit property tests      (5 min)
  ├─ Parity tests                (2 min)
  ├─ Program unit tests          (10 min)
  ├─ Program fuzz (10-min target)
  ├─ Program invariant tests     (5 min)
  ├─ SDK unit tests              (3 min)
  ├─ Localnet integration        (20 min)
  ├─ Coverage report             (3 min)
  └─ Benchmark regressions       (10 min)

Total ≤ 60 min wall clock via parallel jobs.

Main branch nightly:
  ├─ Circuit fuzz (4 hours)
  ├─ Program fuzz (4 hours)
  ├─ Mainnet fork tests          (15 min)
  └─ E2E devnet (15 min)
```

---

## 11. Definition of Done — component-level

**Circuit:** all tests in §2 pass + R1CS snapshot reviewed + constraint report published.
**Program:** §3 tests pass + CU under budget + fuzz 4h clean on main.
**Adapter:** §3 tests pass + adapter-review checklist (PRD-05 §6) filled + mainnet-fork integration green.
**SDK:** §7 tests pass + multi-chain dispatch verified + error surface exhaustive.

Any "done" that doesn't meet these regresses to in-progress.

---

## 12. Audit handoff inputs

When handing to audit firms (PRD-08):

1. PRDs 01–08 (this series).
2. Test vectors (§9).
3. Coverage + benchmark reports.
4. Fuzz corpus.
5. List of known limitations and open questions (explicit).
6. Threat model (PRD-01 §3).

Auditors get full context without having to reconstruct it from the codebase.

---

## 13. Open questions

1. **Formal verification scope.** Veridise formal-verified Privacy.cash. We should target the same for our transact circuit at minimum. Scope: just transact, or transact + adapt + disclose? PRD-08 decides.
2. **Solana runtime compatibility testing.** Firedancer is coming; do we run parallel tests on Firedancer fork? Recommended if stable in time.
3. **MEV protection testing.** Jito bundle mode — separate test harness or incorporated?
4. **Mutation testing — Rust vs. TS mutators.** Some operators don't fit ZK logic well; curate per-repo.

---

## 14. Revision history

| Version | Date | Author | Changes |
|---|---|---|---|
| 0.1 | 2026-04-23 | b402 core | Initial draft |
| 0.2 | 2026-04-24 | b402 core | §2.6 reframed "mirrors Railgun" to construction-class language. Same vectors, same byte-equality assertion. |

---

## 15. Sign-off

| Role | Name | Date | Status |
|---|---|---|---|
| Test lead | | | |
| Circuit author | | | |
| Security review | | | |
| Final approval | | | |

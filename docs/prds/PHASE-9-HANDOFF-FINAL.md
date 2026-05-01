# Phase 9 — handoff (READY FOR COMPILE + CEREMONY + TEST)

| Field | Value |
|---|---|
| Date | 2026-04-30 (second overnight session) |
| Branch | `feat/phase-9-dual-note` (off `feat/phase-7-inline-cpi` HEAD `7e21ff0`, prior spike at `adeaa10`) |
| Status | **Source edits complete. NO compile, NO ceremony, NO tests run.** Caller drives all of those tomorrow. |
| Predecessor | Phase 7B (live on mainnet) — unchanged on disk; rebuild required because the public-input layout shifted. |
| Mainnet impact at sign-off | none. No `.so` rebuilt, no `git push`, no deploy. |

This supersedes `PHASE-9-HANDOFF.md` (the previous BLOCKED handoff). The blocker (no `outSpendingPub` in pool's view of public inputs) is resolved per the spike's Option A: a 1-line circuit change exposes `outSpendingPub[0]` as a public input via a constrained alias, the verifier grows from 23 → 24 inputs, and the pool program can now recompute `commitment_b` in Rust to mint the excess leaf inside the same atomic `adapt_execute` call.

## §1. The change in two paragraphs

`circuits/adapt.circom` gained one new public-input alias signal `outSpendingPubA`, constrained equal to `outSpendingPub[0]`. The `component main { public[...] }` list grows from 23 → 24 entries (new entry appended at the END so existing public-input indices keep their meaning). Phase 9's trusted setup must rerun for the adapt circuit, the verifier program's VK must regenerate via `circuits/scripts/vk-to-rust.mjs`, and `b402-verifier-adapt` must redeploy with the new VK + 24-input expectation. **Old proofs do not verify against the new VK; new proofs do not verify against the old VK. There is no in-place upgrade path — both programs must redeploy together with a tx-level coordinated cutover, OR an incompatible new pool ID is used and the SDK targets the new pool.**

In `programs/b402-pool/src/instructions/adapt_execute.rs`, after the existing `tree_append` loop appends the main commitment, a new block reads `delta - expected_out_value`; if positive it computes `random_b = Poseidon(commitment_a, TAG_EXCESS)` and `commitment_b = Poseidon(TAG_COMMIT, outMintFr, excess, random_b, spendingPub)` (both `Endianness::LittleEndian`, same convention as every existing call), appends `commitment_b` as a second leaf, and emits a new `ExcessNoteMinted` event. SDK side, `privateSwap` mirrors the same derivation off-chain, builds a `SpendableNote` for the excess leaf, inserts it into the local NoteStore, and returns it as `excessNote?` on `PrivateSwapResult`. The two notes always sum to the on-chain out_vault delta — zero slippage dust.

## §2. Files edited

### Circuit (one file)
- `circuits/adapt.circom` (+15 LoC, unchanged signature otherwise)
  - Added `signal input outSpendingPubA;` at the end of the public-inputs section
  - Added constraint `outSpendingPubA === outSpendingPub[0];` near the end of the template
  - Appended `outSpendingPubA` to the `component main { public [...] }` list
  - Updated header comment to document index 23

### Pool program (4 files)
- `programs/b402-pool/src/constants.rs` (+7 LoC)
  - Added `pub const TAG_EXCESS: [u8; 32] = tag_fr_le(b"b402/v1/excess");` matching the `tag_fr_le` const-fn convention
  - Updated `tags_are_distinct` test to include the new tag
- `programs/b402-pool/src/error.rs` (+2 LoC)
  - Added `ArithmeticUnderflow = 1704` variant
- `programs/b402-pool/src/events.rs` (+10 LoC)
  - Added `#[event] pub struct ExcessNoteMinted { leaf_index: u64, excess: u64 }`
- `programs/b402-pool/src/instructions/adapt_execute.rs` (+~140 LoC, mostly tests)
  - `AdaptPublicInputs` gained `pub out_spending_pub: [u8; 32]` (last field)
  - `build_public_inputs_for_adapt` pushes `pi.out_spending_pub` at the end (verifier index 23)
  - After the existing main `tree_append` loop, added the dual-note block: subtracts `expected_out_value` from `delta`, derives `random_b` + `commitment_b` via `solana_program::poseidon::hashv` (LE), `tree_append`s the second leaf, emits `CommitmentAppended` (zero-padded encrypted-note fields) + `ExcessNoteMinted`
  - Added `#[cfg(test)] mod excess_parity_tests` with the frozen fixture, deterministic-ness check, perturbation check, pinned-vector check (vector hex starts EMPTY — fill it in on first run)
- `programs/b402-pool/src/instructions/verifier_cpi.rs` (+5 LoC, -1 LoC)
  - `PUBLIC_INPUT_COUNT_ADAPT` bumped 23 → 24 with a comment that clarifies the upgrade dance

### Verifier program (2 files, doc-only on the second)
- `programs/b402-verifier-adapt/src/lib.rs` (+4 LoC, -1 LoC)
  - `PUBLIC_INPUT_COUNT` bumped 23 → 24
- `programs/b402-verifier-adapt/src/vk.rs` (+8 LoC of comment ONLY)
  - Added a TODO block at the file header flagging that the VK bytes were generated for 23 public inputs and MUST be regenerated before the program rebuild lands
  - **No bytes were changed.** The user's ceremony tomorrow regenerates this file in full.

### SDK + prover (5 files)
- `packages/shared/src/constants.ts` (+5 LoC)
  - `DomainTags.excess = 'b402/v1/excess'`
- `packages/prover/src/adapt.ts` (+8 LoC, -2 LoC)
  - `ADAPT_PUBLIC_INPUT_COUNT` bumped 23 → 24
  - `AdaptWitness` interface gained `outSpendingPubA: bigint`
  - `witnessToSnarkjsInput` writes the new field
  - Header comment updated
- `packages/sdk/src/excess.ts` (NEW, ~50 LoC)
  - `deriveExcessRandom(commitmentA): Promise<bigint>` — `Poseidon(TAG_EXCESS, commitmentA)`
  - `computeExcessCommitment(outMintFr, excess, randomB, spendingPub): Promise<bigint>` — wraps `commitmentHash`
- `packages/sdk/src/index.ts` (+1 LoC)
  - Re-exports the two helpers
- `packages/sdk/src/b402.ts` (+~50 LoC)
  - `PrivateSwapResult.excessNote?: SpendableNote` field added
  - Witness now sets `outSpendingPubA: this._wallet.spendingPub`
  - Wire data inserts `proof.publicInputsLeBytes[23]` (= `out_spending_pub`) right after `u64Le(expectedOut)` to match the Anchor borsh order of `AdaptPublicInputs`
  - After `_confirmAndMarkSpent` and the main `insertNote(outNote)`, the new excess block computes `random_b` + `commitment_b`, builds a `SpendableNote` at `tree.leafCount + 1n` with empty ciphertext, inserts it into the NoteStore, and returns it as `excessNote`

### Tests (2 files)
- `tests/v2/integration/dual_note_vector.test.ts` (NEW, ~80 LoC) — TS-side parity test, frozen fixture, vector hex starts empty (first run prints the actual hex; copy it into both this file and the matching Rust test).
- `tests/v2/integration/dual_note_fork.test.ts` (NEW, ~140 LoC) — mainnet-fork e2e. Skipped unless `DUAL_NOTE_FORK=1`. Asserts `result.outNote.value + result.excessNote.value === outAmount`, `excessNote.value === outAmount - expectedOut`, and `b402.balance({ mint: outMint }).balances[0].depositCount === 2`.

The Rust counterpart parity test lives inside `adapt_execute.rs::excess_parity_tests` (no separate file in `programs/b402-pool/tests/` because the pool crate has no integration-test harness today; embedding the test next to the source matches existing patterns like `util.rs::tests`).

## §3. What the user runs tomorrow (in order)

Start in repo root: `cd /Users/mayurchougule/development/b402-pl/b402-solana`.

### 3.1 Recompile circuit
```bash
cd circuits
bash scripts/compile-adapt.sh
```
Verify the output: `pnpm exec snarkjs r1cs info build/adapt.r1cs` should report **24 public inputs** (was 23). Constraint count grows by ~1 (the new equality constraint).

### 3.2 Trusted-setup ceremony (throwaway, devnet/test only)
```bash
bash scripts/throwaway-ceremony-adapt.sh
```
This runs `groth16 setup` against the new `build/adapt.r1cs`, contributes once with throwaway entropy, and exports `build/ceremony/adapt_verification_key.json`. **Mainnet ceremony is a separate process — do NOT ship the throwaway zkey to mainnet.** See PRD-08 §2 for the production plan.

### 3.3 Refresh the verifier program's VK
```bash
node scripts/vk-to-rust.mjs \
    build/ceremony/adapt_verification_key.json \
    ../programs/b402-verifier-adapt/src/vk.rs \
    ADAPT_VK
```
Confirm the regenerated `vk.rs` reports `nr_pubinputs = 24` and `VK_IC: [[u8; 64]; 25]` in its console output (= public_input_count + 1). The TODO comment block at the top of `vk.rs` will be replaced by the auto-generated header — that's expected and fine; the comment was a marker for this step.

### 3.4 Build BPF artifacts
```bash
cd ..
cargo build-sbf --features inline_cpi_nullifier --manifest-path programs/b402-pool/Cargo.toml
cargo build-sbf --manifest-path programs/b402-verifier-adapt/Cargo.toml
```
Both builds must succeed cleanly. If `programs/b402-pool` errors with a missing `TAG_EXCESS` import or a missing `ArithmeticUnderflow` variant, double-check the source edits landed.

Save the rebuilt `.so` files to `ops/phase7-builds/`:
```bash
cp target/deploy/b402_pool.so          ops/phase7-builds/b402_pool_dual_note.so
cp target/deploy/b402_verifier_adapt.so ops/phase7-builds/b402_verifier_adapt_dual_note.so
```

### 3.5 Build TypeScript
```bash
pnpm -F @b402ai/solana-shared build
pnpm -F @b402ai/solana-prover build
pnpm -F @b402ai/solana build
```

### 3.6 Run the parity test (will fail on first run; that's the design)
```bash
pnpm -F @b402ai/solana-v2-tests vitest run integration/dual_note_vector
```
First run: the test prints the computed `commitment_b` LE hex and fails with a "not yet pinned" error. Copy the printed hex into BOTH:
- `tests/v2/integration/dual_note_vector.test.ts` → `EXPECTED_COMMITMENT_B_HEX`
- `programs/b402-pool/src/instructions/adapt_execute.rs` → `EXPECTED_COMMITMENT_B_HEX` (inside `excess_parity_tests`)

Re-run the TS test — it passes. Run the Rust test:
```bash
cargo test --manifest-path programs/b402-pool/Cargo.toml \
    --lib instructions::adapt_execute::excess_parity_tests
```
All three Rust tests pass. **If the Rust hex differs from the TS hex, STOP**: that's the parity invariant breaking. Check Poseidon endianness, input order, and field encodings before continuing.

### 3.7 Run litesvm + on-chain unit tests
```bash
cargo test --manifest-path programs/b402-pool/Cargo.toml --lib
cargo test --manifest-path tests/onchain/Cargo.toml -- --nocapture
```
Existing adapt-delta + shield + unshield tests must still pass — the dual-note block only fires when `excess > 0`; the existing fixtures use `expected = actual` so they exercise the no-excess path implicitly.

### 3.8 Boot mainnet-fork; rerun e2e
```bash
bash tests/v2/scripts/start-mainnet-fork.sh   # in another shell
pnpm -F @b402ai/solana-v2-tests vitest run e2e/v2_fork_swap   # 5-wallet smoke
```
Then the dual-note fork test (requires a real adapter — Phoenix or Jupiter — wired into a `TEST_ARTIFACTS` JSON. Mock adapter delivers exactly 2x with no slippage so it does NOT exercise the excess path.):
```bash
DUAL_NOTE_FORK=1 \
ADAPTER_PROGRAM_ID=<phoenix or jupiter adapter id> \
TEST_ARTIFACTS=/tmp/dual-note-fork-artifacts.json \
SLIPPAGE_BPS=300 \
pnpm -F @b402ai/solana-v2-tests vitest run integration/dual_note_fork
```
The harness must produce `TEST_ARTIFACTS` with `{ adapterInTa, adapterOutTa, alt, expectedOut, adapterIxData?, actionPayload?, remainingAccounts? }` before the test runs.

### 3.9 Commit
```bash
git add circuits/adapt.circom \
        programs/b402-pool/src \
        programs/b402-verifier-adapt/src \
        packages/shared/src/constants.ts \
        packages/prover/src/adapt.ts \
        packages/sdk/src/{excess.ts,index.ts,b402.ts} \
        tests/v2/integration/dual_note_vector.test.ts \
        tests/v2/integration/dual_note_fork.test.ts \
        docs/prds/PHASE-9-HANDOFF-FINAL.md
git commit -m "phase 9: dual-note minting end-to-end (circuit + pool + sdk + tests)"
```
Don't forget to also add the regenerated `programs/b402-verifier-adapt/src/vk.rs` if `vk-to-rust.mjs` overwrote it. **Don't commit the `circuits/build/` artifacts** — they're gitignored already.

## §4. Mainnet deploy plan

Phase 7B's pool is live at `42a3hsCXtQLWonyxWZosaaCJCweYYKMrvNd25p1Jrt2y` and the verifier is at `3Y2tyhNSaUiW5AcZcmFGRyTMdnroxHxc5GqFQPcMTZae`. Both must be redeployed for Phase 9 because:
- Verifier expects 23 public inputs today and 24 after the rebuild — old SDK proofs (still 23) reject against the new VK and new SDK proofs (24) reject against the old VK.
- Pool sends the verifier 23 public inputs today; the new pool sends 24. Pool ↔ verifier must upgrade together.

Two deploy options:

**Option A — atomic upgrade (preferred when relayer + clients can pause briefly).** Stop the relayer, deploy verifier first, then pool, then publish SDK 0.0.12 + MCP 0.0.17 simultaneously. Brief inflight-tx breakage during the 5–10s window between the two `solana program deploy` calls — clients see `ProofVerificationFailed` if their tx lands during the window.

**Option B — new program IDs (zero-downtime, more bookkeeping).** Generate fresh keypairs for `b402-pool-v3` and `b402-verifier-adapt-v3`, deploy fresh, point the SDK config there. Phase 7B's old programs keep serving until the SDK clients have all migrated. This is safer if mainnet has live agents that would notice a 5-second blip.

```bash
# Option A:
solana program deploy \
    --url https://mainnet.helius-rpc.com/?api-key=<KEY> \
    --program-id 3Y2tyhNSaUiW5AcZcmFGRyTMdnroxHxc5GqFQPcMTZae \
    ops/phase7-builds/b402_verifier_adapt_dual_note.so

solana program deploy \
    --url https://mainnet.helius-rpc.com/?api-key=<KEY> \
    --program-id 42a3hsCXtQLWonyxWZosaaCJCweYYKMrvNd25p1Jrt2y \
    ops/phase7-builds/b402_pool_dual_note.so

# SDK + MCP republish:
pnpm -F @b402ai/solana publish --tag latest    # 0.0.12
pnpm -F @b402ai/solana-mcp publish --tag latest # 0.0.17 (server delegates to SDK)
```

## §5. Rollback plan

Phase 7B's `.so` files are the rollback target:
- `ops/phase7-builds/rollback-mainnet/b402_pool_inline_v2.so`
- `ops/phase7-builds/rollback-mainnet/b402_verifier_adapt.so` (if not present, restore from the previously-deployed buildkit; the program data on-chain pre-Phase-9 IS the rollback source of truth)

Roll back BOTH together — pool and verifier must agree on public-input count or every proof fails closed.
```bash
solana program deploy \
    --url https://mainnet.helius-rpc.com/?api-key=<KEY> \
    --program-id 3Y2tyhNSaUiW5AcZcmFGRyTMdnroxHxc5GqFQPcMTZae \
    ops/phase7-builds/rollback-mainnet/b402_verifier_adapt.so

solana program deploy \
    --url https://mainnet.helius-rpc.com/?api-key=<KEY> \
    --program-id 42a3hsCXtQLWonyxWZosaaCJCweYYKMrvNd25p1Jrt2y \
    ops/phase7-builds/rollback-mainnet/b402_pool_inline_v2.so
```
Then `npm dist-tag add @b402ai/solana@0.0.11 latest` (or whatever the pre-Phase-9 SDK version was).

## §6. Known limitations + open questions

1. **Pure dummy-only swap path is unaffected.** When `actual_out == expected_out`, `excess == 0` and the dual-note block is a no-op. No extra CU, no extra leaf. Existing fork tests with the mock adapter (which delivers exactly 2x) exercise this path implicitly.

2. **Compute units.** Adding 1 Poseidon (random_b) + 1 Poseidon (commitment_b) + 1 `tree_append` + 1 `emit!` is ~17K extra CU. Phase 7B's swap measured ~558K out of 1,400,000 cap; 575K is comfortable. Confirmed expected via static analysis only — measure on the fork test before signing off.

3. **Wire-size delta — RESOLVED via Phase 9.1 trim.** `AdaptPublicInputs` grew by 32 bytes for `out_spending_pub` (Phase 9 dual-note). Mitigation in this branch: also dropped `pi.action_hash` from the wire — pool reconstructs `Poseidon_3(adaptBindTag, keccak(action_payload) mod p, out_mint Fr)` (it already did this for the binding check at line ~275; the same value now goes into the verifier vector). Net wire bytes: Phase 7B 1230 + 32 (new field) − 32 (action_hash trim) = **1230 B unchanged.** Same pattern as Phase 7B's `adapter_id` removal. See `build_public_inputs_for_adapt(&computed_action_hash)` and the SDK's `poolIxParts` (action_hash now omitted between `recipient_bind` and `expected_out_value`).

4. **`u64_to_fr_le` is still duplicated** across `adapt_execute.rs`, `shield.rs`, `unshield.rs`, `transact.rs`. Spike noted this; not blocking.

5. **Excess leaf has no on-chain ciphertext.** Off-chain backfill from a fresh device requires the old commitment_a + tag, which an indexer can extract from the `CommitmentAppended` events emitted in the same tx (same `tree_root_after` + adjacent `leaf_index`). This is a minor UX concern — flag it for the SDK note-recovery path, but not blocking for the demo.

6. **Anchor `borsh` serialization order.** I added `out_spending_pub` as the LAST field of `AdaptPublicInputs` so Anchor encodes it after `expected_out_value`. The SDK wire writes the bytes in matching order. Triple-check by running `pnpm -F @b402ai/solana-v2-tests vitest run integration/phase7_wire_size` and confirm the new total is what we expect.

7. **Relayer fee offset (pre-existing)**. `packages/relayer/src/validate.ts::RELAYER_FEE_OFFSET = 476` is computed for a wire that includes `public_token_mint` (32B). Phase 7B's wire dropped that field, so `RELAYER_FEE_OFFSET` should already be 444. Phase 9 adds 0 bytes BEFORE `relayer_fee` (the new field is after `expected_out_value`), so the offset stays at 444 regardless of pre-existing drift. Document but do NOT touch — out of scope.

## §7. Concerns / surprises uncovered

1. **Circom does not allow indexed elements in `component main { public[] }`.** The user's overnight instructions said "promote `outSpendingPub[0]` only, not the dummy slot". Implemented as: introduce a dedicated single-element signal `outSpendingPubA`, constrain it to `outSpendingPub[0]`, expose only the alias. One extra constraint, dummy stays private. 1 line in the public list, 4 lines elsewhere.

2. ~~Wire size will overrun 1232.~~ **Resolved.** Action_hash trim landed in this branch as Phase 9.1 — pool reconstructs from `args.action_payload + out_mint`, same trim pattern as Phase 7B's `adapter_id`. Net wire 1230 B (unchanged from Phase 7B). See §6 (3).

3. **`programs/b402-pool/tests/` directory does not exist** in the pool crate. The Rust parity test was added inline as `#[cfg(test)] mod excess_parity_tests` inside `adapt_execute.rs` — matches the existing `util.rs::tests` and `constants.rs::tests` pattern.

4. **`b402-onchain-tests` (litesvm) does not link `solana-program`'s Poseidon directly** in its current Cargo.toml. The parity test therefore lives inside the pool crate (which already imports `anchor_lang::solana_program::poseidon::hashv`) instead of the more obvious litesvm location. If you want it in litesvm, add `solana-program = "<matching version>"` to `tests/onchain/Cargo.toml` and copy the test body verbatim.

5. **Excess-leaf encrypted-note fields are zero-padded** in the `CommitmentAppended` event. Indexers that scan ciphertexts will silently skip the excess leaf on backfill. The SDK path inserts the SpendableNote directly (it knows the plaintext at swap time), so live discovery works. Backfill on a fresh wallet is impossible — TODO for the indexer-recovery flow if/when it lands.

## §8. Confidence level

**Ready to compile.** I read every file the spike notes pointed at, traced the Anchor borsh field order, the snarkjs public-signal order, the SDK wire layout, and the witness shape side-by-side before writing the edits. All cross-references match: circuit's `public[...]` order ↔ prover's `witnessToSnarkjsInput` ↔ pool's `build_public_inputs_for_adapt` ↔ SDK's `poolIxParts` writer.

The two failure modes I cannot eliminate without runtime feedback:
- Snarkjs's `publicSignals` ordering for an array signal where only an alias is exposed (e.g. `outSpendingPub[2]` private + `outSpendingPubA` public). I'm 95% confident snarkjs treats `outSpendingPubA` as a single index in `publicSignals` — circom emits it as a regular scalar signal. Verify on the first compile via `r1cs info` and the public-signals dump.
- Anchor 0.30's borsh derivation handling of trailing optional fields (none here — `out_spending_pub: [u8; 32]` is non-optional). Should be byte-for-byte equivalent to the SDK wire writer.

If either of those bites, the fix is local: re-order the `publicInputsLeBytes[N]` reference in `b402.ts` line 894 (for snarkjs ordering) or move the new field's position in `AdaptPublicInputs` (for borsh).

The wire-size overrun in §6 (3) is the only thing that would prevent Phase 9 from shipping as-drafted. Mitigation is a 30-line follow-up patch (drop `action_hash` from wire) that I recommend doing immediately after the user confirms the compile + ceremony succeed.

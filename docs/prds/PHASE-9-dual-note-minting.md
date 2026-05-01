# Phase 9 — Dual-note minting (zero-loss private swaps)

| Field | Value |
|---|---|
| Status | Spec — implementation overnight 2026-04-30 → 2026-05-01 |
| Branch | `feat/phase-9-dual-note` (off `feat/phase-7-inline-cpi`) |
| Predecessor | Phase 7B (live on mainnet) |
| Mainnet impact at sign-off | none — feature-gated until deploy |
| Owner | b402 core |

## §1. Problem

`privateSwap` (and any future variable-output adapter call) currently has a vault-dust leak. Mainnet flow today:

1. SDK fetches Jupiter quote at time T → `outAmount = X`, slippage floor `otherAmountThreshold = X * (1 - slippageBps/10000)`
2. Proof generated binding `expected_out_value = otherAmountThreshold` (the floor)
3. Adapter executes, Phoenix delivers `actual_out`
4. Pool checks `actual_out >= expected_out_value` → require pass
5. Pool mints commitment with value = `expected_out_value` (the floor, NOT `actual_out`)
6. Excess `actual_out - expected_out_value` stays in pool's vault, **untracked, unclaimable** by any user note

At slippageBps=100 (1%), up to 1% of every swap is leaked into shared vault dust. **Unacceptable at scale** — $1M swap = $10K dust per swap.

## §2. Goal

Zero loss to the user on swap excess. After this phase, the user's two notes (main + excess) sum to exactly `actual_out` minted on-chain.

Acceptance criteria:
- For every successful `adapt_execute` where `actual_out > expected_out_value`, pool appends a SECOND commitment whose value = `actual_out - expected_out_value`.
- SDK's `privateSwap` returns the second note alongside the main note.
- SDK's `NoteStore` persists both. `b402.balance()` and `b402.status()` reflect the actual recoverable balance.
- The second commitment is deterministic from on-chain inputs; no extra trust on relayer.
- Privacy unchanged: observers still see only commitment hashes, not values.

## §3. Design

### §3.1 Tag constant

```
TAG_EXCESS = poseidon_bytes("b402/v1/excess") // 32 B, precomputed once
```

Hardcoded in both pool program and SDK. Used to deterministically derive the excess note's `random_b` from the proof-bound `random_a`.

### §3.2 Pool side — `programs/b402-pool/src/instructions/adapt_execute.rs`

After the existing main commitment append, before returning:

```rust
let excess: u64 = actual_out_amount.checked_sub(args.public_inputs.expected_out_value)
    .ok_or(error!(PoolError::ArithmeticUnderflow))?;
if excess > 0 {
    // Derive deterministic random_b from proof-bound random_a + TAG_EXCESS.
    // random_a is the second OUT note's random in v2.1 layout (commitment_out[1]).
    // We use commitment_out[0]'s random... TBD via spike (see §6).
    let random_b: [u8; 32] = poseidon::hashv(
        Parameters::Bn254X5,
        Endianness::BigEndian,
        &[&random_a, &TAG_EXCESS],
    )?.to_bytes();

    // Compute commitment_b in Rust from runtime values.
    let commitment_b: [u8; 32] = poseidon::hashv(
        Parameters::Bn254X5,
        Endianness::BigEndian,
        &[
            &u64_to_fr_le(excess),
            &random_b,
            &spending_pub_x,  // from proof public input (recipient_bind reconstruction)
            &spending_pub_y,
        ],
    )?.to_bytes();

    tree_state.append_leaf(commitment_b)?;
    emit!(ExcessNoteMinted {
        leaf_index: tree_state.leaf_count.checked_sub(1).unwrap(),
        excess,
    });
}
```

Plus: extend `tree_state.append_leaf` (or whatever the current API) to support up to 3 leaves per tx (main commitment + dummy slot + excess). If the current API is hardcoded to 2-per-tx batching, refactor.

### §3.3 SDK side — `packages/sdk/src/b402.ts privateSwap`

After `_confirmAndMarkSpent`:

```ts
const excess = outAmount - expectedOut;
if (excess > 0n) {
  const randomB = await poseidonTagged(TAG_EXCESS, randomA);
  const commitmentB = await commitmentHash(outMintFr, excess, randomB, this._wallet.spendingPub);
  this._notes.insertNote({
    tokenMint: outMintFr,
    value: excess,
    random: randomB,
    spendingPub: this._wallet.spendingPub,
    spendingPriv: this._wallet.spendingPriv,
    commitment: commitmentB,
    leafIndex: BigInt(tree.leafCount + 1n), // main was at +0, excess at +1
  });
}
return { signature, outNote, outAmount, excessNote };
```

`PrivateSwapResult` gains `excessNote?: SpendableNote`.

### §3.4 Tx size impact

Phase 7B mainnet swap is 1230 B (2 B headroom). Adding a third leaf append on-chain is a CU cost (extra Poseidon ~3K CU + tree append ~5K CU), NOT a wire-size cost. The ix accounts/data don't change.

If the wire grows by 1-2 bytes (e.g., extra event byte), we may need ALT extension. Verify in spike.

### §3.5 Compute budget

Today's swap uses ~558K CU / 1.4M cap. Adding:
- 1 Poseidon (excess random_b): ~3K CU
- 1 Poseidon (commitment_b): ~3K CU
- 1 tree_state.append_leaf: ~10K CU
- Event emit: ~1K CU

Total +17K CU. New ceiling: ~575K. Plenty of headroom.

## §4. Security

| Invariant | Argument |
|---|---|
| Only b402_pool can mint excess | Pool program is the only authority over its tree-state PDA; users can't construct an "excess mint" call directly |
| Excess value is exactly `actual - expected` | Pool reads `actual` from its OWN vault delta (post-CPI) — not user-controlled. `expected` is bound to the verified proof. |
| `random_b` is non-malleable | Poseidon hash of `random_a` (proof-bound) + a fixed tag. No degree of freedom for adversary. |
| `spending_pub` is the user's | Same source as the main commitment — derived from the verified proof's public inputs |
| Excess note is recoverable by user only | Commitment uses user's `spending_pub` — only their `spending_priv` can spend it |
| No double-mint | Excess only minted when `actual > expected`. If equal, no second commitment. |

## §5. Privacy

- Observers see TWO commitment-appended events per swap (instead of one).
- They can infer "this swap had non-zero slippage" — but **no value information**.
- Anonymity set unchanged: still all users who shielded into the pool.
- The size of the vault delta is still public (token transfers are public on Solana). That hasn't changed and isn't a Phase 9 concern.

## §6. Spike items (resolve before code)

The agent must answer these via `git log`/`grep`/local builds before writing code:

1. **Which OUT slot's random do we use as `random_a`?** v2.1 has `commitment_out[0]` (real) and `commitment_out[1]` (dummy for swap). The real OUT note's random is the seed. Confirm by reading the SDK's privateSwap proof construction.
2. **Where do `spending_pub_x`, `spending_pub_y` come from in the pool's view of public inputs?** They're encoded in the recipient_bind or commitment_out fields. Find the existing reconstruction in `build_public_inputs_for_adapt`.
3. **Does `tree_state` support 3 leaves per tx?** Likely 2 max today (matches circuit's commitment_out[0..2]). Refactor needed if so. Document the refactor scope.
4. **`u64_to_fr_le` exists?** Confirm helper is available in pool's util module.
5. **Test: poseidon parity with TS SDK.** Both ends must compute the same `commitment_b` for the same `(excess, random_b, spending_pub)`. Add a deterministic vector to `b402-assurance/vectors/`.

## §7. TDD plan

Before any production code:

1. **Vector parity test (cargo + vitest)**: given fixed `(random_a, excess, spending_pub)`, both Rust and TS compute the same `random_b` and `commitment_b`. Lives in crypto package + Rust util.
2. **Pool unit test (litesvm)**: deploy pool, invoke a fake `adapt_execute` path with a known excess > 0, assert tree's leaf_count incremented by 2 (main + excess), and `commitment_b` matches expected.
3. **Pool unit test (litesvm)**: same as above with excess = 0 (i.e., `actual_out == expected_out`), assert tree's leaf_count incremented by exactly 1 (no excess mint).
4. **Mainnet-fork integration test (vitest)**: real Phoenix swap with known slippage, assert SDK's NoteStore contains both notes and they sum to `actual_out`.
5. **Negative test**: malformed args (e.g., user-supplied `excess`) cannot influence the mint. Pool must compute excess from on-chain state only.

Tests live in `tests/v2/integration/dual_note*.test.ts` and `programs/b402-pool/tests/dual_note*.rs` (or matching litesvm location).

## §8. Implementation order (overnight agent)

1. **Spike** — read code, answer §6 items, write findings to `docs/prds/PHASE-9-spike-notes.md`.
2. **Tag constant** — derive `TAG_EXCESS` once via a one-shot script; commit the 32-byte hex constant in both Rust and TS.
3. **Vector parity tests (red)** — write the cross-language Poseidon parity test first; should fail because helpers don't exist yet.
4. **Helpers (green)** — implement `derive_excess_random` + `commitment_b` builder in both Rust and TS. Tests pass.
5. **Pool litesvm tests (red)** — `adapt_execute` paths with excess > 0 and excess == 0. Should fail because dual-note isn't implemented.
6. **Pool implementation (green)** — extend `adapt_execute` handler. Refactor `tree_state.append_leaf` if needed for 3-per-tx.
7. **SDK changes (green)** — extend `privateSwap` to compute + insert the excess note. Update `PrivateSwapResult` type.
8. **Fork integration test** — real Phoenix swap, assert dual notes appear and sum correctly.
9. **Build artifacts** — `cargo build-sbf --features inline_cpi_nullifier`. Save .so to `ops/phase7-builds/b402_pool_dual_note.so`. **DO NOT DEPLOY.**
10. **Handoff doc** — `docs/prds/PHASE-9-HANDOFF.md` with deploy commands, test results, expected mainnet upgrade SOL cost, and rollback plan.

## §9. Hard guardrails for the agent

- ❌ NO `solana program deploy` to mainnet (or devnet — devnet is also Phase 7B live)
- ❌ NO `git push`
- ❌ NO `npm publish`
- ❌ NO `gcloud run deploy`
- ❌ NO touching `~/.config/solana/*.json` (user wallets) or `~/.config/b402-solana/notes/`
- ❌ NO destructive git ops (`reset --hard`, `clean -f`, `push --force`, `--no-verify`)
- ❌ NO modifying the deployed mainnet pool's behavior — local builds only
- ✅ Local commits on `feat/phase-9-dual-note` only
- ✅ Build .so files to `ops/phase7-builds/`
- ✅ Run litesvm + mainnet-fork tests locally
- ✅ Use a paid Helius / Triton / QuickNode mainnet RPC for read-only queries during fork harness setup. Set via `B402_RPC_URL` env var; never hardcode the API key.

## §10. Done criteria

When user wakes up:
1. `feat/phase-9-dual-note` branch exists with N small commits, working tree clean
2. `docs/prds/PHASE-9-HANDOFF.md` summarizes what was done, with byte counts + CU measurements + tx sigs from fork tests
3. `cargo build-sbf` for both feature combos passes with new code
4. `pnpm -F @b402ai/solana typecheck` + `build` passes
5. Litesvm tests green (both excess > 0 and excess == 0 paths)
6. Fork integration test green (real Phoenix swap shows dual notes summing to actual_out)
7. Pool .so saved at `ops/phase7-builds/b402_pool_dual_note.so` (NOT deployed)
8. Vector parity proven with a frozen test case (TS and Rust agree on commitment_b for known inputs)

User then reviews, deploys to mainnet manually, runs the smoke, and records the demo.

## §11. Demo claim after this lands

> "First composable private DEX swap on Solana. Atomic, gasless, **zero slippage loss to the user**. The user gets exactly the swap output, recorded in two commitments — one bound to the slippage floor, one for the actual delivery delta. Both are theirs to spend."

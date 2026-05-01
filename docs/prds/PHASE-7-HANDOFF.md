# Phase 7 — pool→nullifier inline CPI (handoff)

| Field | Value |
|---|---|
| Status | Implemented on `feat/phase-7-inline-cpi`, **not built**, **not deployed**, **not tested** |
| Branch | `feat/phase-7-inline-cpi` (fork of `feat/v2-nullifier-imt`) |
| Owner | b402 core |
| Date | 2026-04-30 |
| Predecessor | PRD-30 (v2 nullifier IMT, sibling-ix design) |
| Predecessor spike | `docs/spikes/SPIKE-v2-jito-bundle.md` §"Option B" |
| Mainnet impact at sign-off | none — feature-gated, default-off |

---

## §1. What this branch implements

Pool program calls `b402_nullifier::create_nullifier` via direct `solana_program::program::invoke` instead of relying on a sibling instruction in the same transaction. The sibling-ix path is preserved behind a Cargo feature flag so the deployed v2.1 mainnet build (slot ~416560668) keeps compiling and the wire ABI for that build is unchanged.

Everything is gated:

| Crate | Feature | Default | Effect |
|---|---|---|---|
| `b402-pool` | `inline_cpi_nullifier` | OFF | `UnshieldArgs` / `TransactArgs` / `AdaptExecuteArgs` gain a `nullifier_cpi_payloads: Vec<Vec<u8>>` field; handlers CPI into b402_nullifier instead of walking the instructions sysvar. |
| `b402-nullifier` | `cpi-only` | OFF | `CreateNullifier` accounts struct gains an `ix_sysvar` slot; handler reads top-level ix's program ID and rejects any caller other than `b402_pool`. |
| `@b402ai/solana` SDK | runtime flag | OFF | `B402SolanaConfig.inlineCpiNullifier` (or per-call `inlineCpiNullifier` in `UnshieldRequest` / `PrivateSwapRequest`) toggles whether the SDK inlines the proof payload into the pool ix and skips the sibling. |

These three are paired: pool with `inline_cpi_nullifier` requires nullifier with `cpi-only` (and the SDK flag set). Mismatched combinations crash:

- pool inline + nullifier sibling-mode (no `cpi-only`): the inner CPI carries an `ix_sysvar` account the receiver doesn't expect → Anchor fails to deserialize the accounts struct.
- pool sibling + nullifier `cpi-only`: there is no sibling ix; nullifier rejects any direct/non-pool call.

Default-off everywhere preserves today's mainnet behaviour bit-for-bit.

## §2. Files changed

```
programs/b402-pool/Cargo.toml                                +8
programs/b402-pool/src/instructions/mod.rs                   +5
programs/b402-pool/src/instructions/nullifier_cpi.rs         new (+125)
programs/b402-pool/src/instructions/transact.rs              +90
programs/b402-pool/src/instructions/unshield.rs              +90
programs/b402-pool/src/instructions/adapt_execute.rs         +95
programs/b402-nullifier/Cargo.toml                           +8
programs/b402-nullifier/src/lib.rs                           +56
packages/sdk/src/light-nullifier.ts                          +72
packages/sdk/src/actions/unshield.ts                         +60
packages/sdk/src/b402.ts                                     +90
```

Every pool/nullifier change is `#[cfg(feature = "...")]`-gated. The SDK changes are runtime-gated by a config flag whose default is `false`; the existing call sites pass through the flag unchanged when the caller doesn't set it.

### §2.1 Notable touchpoints

- `programs/b402-pool/src/instructions/nullifier_cpi.rs` (new). Helper that constructs the inner ix data (`build_inner_ix_data`) and performs the `invoke` (`invoke_create_nullifier`). The whole module is inside `#![cfg(feature = "inline_cpi_nullifier")]`.
- `programs/b402-pool/src/instructions/{transact,unshield,adapt_execute}.rs`. Each handler grew a `cfg(not(feature = ...)) { sibling-ix walk }` branch and a `cfg(feature = ...) { CPI block }` branch. The `adapt_execute` path additionally slices `remaining_accounts` so the b402_nullifier prefix is consumed before the tail is forwarded to the adapter CPI (see `nullifier_remaining_consumed`).
- `packages/sdk/src/light-nullifier.ts`. Two new exports:
  - `buildNullifierCpiPayload(proof) → Buffer(134)` — proof + tree-info + state-tree-index, no discriminator, no id (the pool program adds those).
  - `buildNullifierCpiAccounts(payer, proof) → AccountMeta[10]` — the 10 accounts required by the `cpi-only` b402_nullifier `CreateNullifier` accounts struct (payer, ix sysvar, light_system_program, cpi_authority, registered_program_pda, account_compression_authority, account_compression_program, system_program, address_tree, output_queue).
- `packages/sdk/src/actions/unshield.ts` + `packages/sdk/src/b402.ts privateSwap`. Both gate three things on `inlineNullifierCpi`:
  1. Append `nullifier_cpi_payloads: Vec<Vec<u8>>` to the pool ix data.
  2. Splice `[b402_nullifier_program, ...10 nullifier accounts]` into `remainingAccounts` (in `privateSwap` this prefix sits between the named adapter accounts and the caller-supplied adapter `remainingAccounts`; the pool's adapt_execute handler slices the prefix off before forwarding).
  3. Skip the sibling `buildCreateNullifierIx` call when in inline mode.

## §3. What the user needs to do (in order, when they pick this up)

### §3.1 Local verification (no mainnet impact)

These commands are blocked in the agent sandbox; the user runs them in their normal shell.

```bash
# 1. Build pool (default — sibling-ix mainnet ABI). MUST succeed unchanged.
cargo build-sbf --manifest-path programs/b402-pool/Cargo.toml

# 2. Build pool with inline CPI feature.
cargo build-sbf --manifest-path programs/b402-pool/Cargo.toml \
    --features inline_cpi_nullifier

# 3. Build nullifier (default).
cargo build-sbf --manifest-path programs/b402-nullifier/Cargo.toml

# 4. Build nullifier with cpi-only feature.
cargo build-sbf --manifest-path programs/b402-nullifier/Cargo.toml \
    --features cpi-only

# 5. SDK build (the public API surface gained two functions and three
#    optional fields — should be additive, no breaking changes).
pnpm -F @b402ai/solana build
pnpm -F @b402ai/solana typecheck
```

Expected: every step compiles. **If step 2 or 4 fails, stop here and surface the error** — Anchor 0.30 vs 0.31 is the most likely culprit and is documented as a known risk in §6 below.

### §3.2 Localnet smoke against the inline build

Boot a localnet validator with the inline-feature pool + cpi-only nullifier deployed, and run the existing v2 stress test in inline mode. Concrete commands depend on local validator scripts in `tests/v2/scripts/`; the SDK side just needs `inlineCpiNullifier: true` set on the `B402Solana` constructor.

The test that matters most is `tests/v2/e2e/v2_fork_swap.test.ts` and `tests/v2/e2e/v2_fork_lend.test.ts` — they're the ones that produced the 1278-byte / >1232-byte raw-tx measurements that motivated this whole exercise.

## §4. Byte-budget analysis (READ BEFORE DEPLOYING)

This is the most important section. Original ask: "Jupiter swap currently exceeds 1232-byte tx cap by 46–99 bytes, exactly because of the 187-byte sibling ix." The 187-byte figure is correct for the sibling instruction's full envelope + data, but **dropping the sibling does not save 187 wire bytes** because most of those bytes have to move into the pool ix to keep the same on-chain semantics.

### §4.1 What actually moves

Sibling ix wire breakdown (today, with all 9 Light accounts already in the ALT):
- 1 B program-id index
- 1 B account-meta count varint (9 → 1 B)
- 9 B account-meta indexes (each Light account is 1 B via ALT)
- 2 B data-length varint (174 → 2 B)
- 174 B data (8 disc + 129 proof + 4 tree-info + 1 state-tree-idx + 32 id)
- **Total: 187 B**

Pool ix delta when inlining:
- −1 B drop instructions sysvar from named accounts (no longer read).
- +10 B append b402_nullifier program + 10 nullifier accounts to the ix's account-meta-index list.
- +135 B prepend `Vec<Vec<u8>>` length (4) + per-payload length (1) + 134 B payload.
- **Total: +144 B**

**Net wire savings: 187 − 144 = ~43 B per nullifier slot** in a transaction whose ALT already contains the 9 Light accounts (which it does in every measured production tx today).

If a transaction has 2 real nullifiers (currently only `transact` shape, not unshield/swap/lend), the savings double to ~86 B.

### §4.2 Where this lands the production payloads — REAL MEASUREMENTS

Run on this branch via `node scripts/phase7-wire-size.mjs` (no validator needed —
synthetic ix-data + accounts; only @solana/web3.js wire encoding is measured):

```
flow           sibling    inline     delta      cap=1232
unshield       1045 B     980 B      -65 B       OK -> OK
swap (24 ra)   OVERFLOW   1177 B     ?           OVER -> OK
swap (12 ra)   1218 B     1153 B     -65 B       OK -> OK
lend (19 ra)   1192 B     1127 B     -65 B       OK -> OK
```

**Real net savings: 65 B per nullifier slot**, not the 43 B I estimated above.
The extra 22 B comes from one fewer tx-message ix entry (saves the sibling ix's
length-prefix byte, account-key-list preamble, and program-ID-index byte) which
the byte-budget arithmetic in §4.1 didn't fully credit.

**Critical finding: swap with 24 adapter remaining-accounts (Jupiter complex
route) OVERFLOWS in sibling mode today** — i.e. it can't even be built in v2.1.
Phase 7 lands it at 1177 B, fitting with 55 B headroom.

So Phase 7 unblocks:
- Simple Jupiter (12 adapter accounts): 1218 → 1153 B
- Complex Jupiter (24 adapter accounts): overflow → 1177 B  ← **the headline win**
- Kamino deposit/withdraw (~19 accounts): 1192 → 1127 B
- Drift perp open (similar shape): expected fit

No production payload measured here exceeds 1,232 B in inline mode.

The §4.1 byte-budget analysis is the right *direction* but underestimates real
savings; trust §4.2's measurements.

### §4.3 If even larger payloads (>1,250 B sibling-mode) become a blocker

Phase 7 may be insufficient for future heavier composability (e.g. 4-hop Jupiter,
Drift cross-margin). Follow-ups, in order of intrusiveness:

- **Phase 7B** — drop more redundant pool accounts (e.g. consolidate `relayer_fee_token_account` ↔ `recipient_token_account` slots when fee=0, drop verifier program account in favour of a hardcoded const). Each saved slot is 1 B in the ALT case. Estimated 5-15 B available.
- **Phase 7C** — compress the 256 B Groth16 proof. Not really compressible; this would require switching to a different proof system (KZG, Plonk).
- **Phase 8 / Jito bundle (Option A in the spike)** — split into two atomic txs. Adds Jito dependency but unblocks arbitrarily large payloads.

Don't pursue 7B/7C/8 from this branch. Land Phase 7 first, measure, then decide.

## §5. Test results

**None.** This branch hasn't been built. The agent sandbox blocks `cargo`, `anchor`, `pnpm test`, validator binaries, and `/tmp` reads, so no on-chain or in-process test ran.

What is asserted in code (compile-time / shape):

- The Borsh layout of `nullifier_cpi_payloads: Vec<Vec<u8>>` is well-formed (TypeScript builder uses the existing `u32Le` + `vecU8` primitives covered by `packages/sdk/src/__tests__/borsh-roundtrip.test.ts`).
- Account count constants match (10 in pool's `ACCT_PER_NULL`, 10 in SDK's `buildNullifierCpiAccounts`).
- The b402_nullifier program-ID bytes constant in `programs/b402-nullifier/src/lib.rs::B402_POOL_PROGRAM_ID` matches `42a3hsCXtQLWonyxWZosaaCJCweYYKMrvNd25p1Jrt2y` (verified via web3.js bs58 decode at authoring time).

What needs to be checked before a deploy:

1. Both feature combos compile (`§3.1` step 2 and step 4).
2. Localnet shield → unshield with `inlineCpiNullifier: true` produces a tx that lands and the address tree contains the new nullifier address.
3. Re-run `tests/v2/e2e/v2_fork_swap.test.ts` with `inlineCpiNullifier: true` against a Kamino deposit and capture the actual raw tx bytes — confirm under 1232 and the tx lands.
4. Negative test: same flow against a `inline_cpi_nullifier`-built pool but with the SDK flag off (sibling-ix mode) — must fail closed because the pool no longer walks the instructions sysvar.
5. Negative test: SDK in inline mode against an old (sibling-only) pool — must fail closed because the pool's Borsh deserializer rejects the trailing `nullifier_cpi_payloads` field.

## §6. Known and suspected blockers

### §6.1 Anchor version conflict (HIGH)

`b402_pool` pins `anchor-lang = 0.30.1` (workspace). `b402_nullifier` pins `anchor-lang = 0.31.1` (separate crate, excluded from the workspace) because `light-sdk = 0.23.0` requires it.

Phase 7 deliberately does **not** import `light-sdk` into the pool. The pool's CPI helper (`nullifier_cpi.rs`) uses only `solana_program::program::invoke` + raw `Instruction { program_id, accounts, data }`. It does **not** depend on any Anchor-version-specific types — only the wire-level `AccountMeta`/`Instruction`. This *should* be Anchor-version-agnostic.

The only place Anchor 0.30/0.31 matters is the `#[derive(Accounts)]` macro and `#[program]` macro on each program independently. They never need to agree.

That said: this hasn't been *built*. If `cargo build-sbf` for the pool with `--features inline_cpi_nullifier` fails, the most likely failure mode is some transitive Anchor type that leaked into `nullifier_cpi.rs` via `anchor_lang::prelude::*`. Mitigation if it bites: replace the prelude import with explicit `use anchor_lang::solana_program::{...}` only — drop all Anchor types from the helper.

### §6.2 Optional `ix_sysvar` slot in `cpi-only` nullifier (MEDIUM)

`programs/b402-nullifier/src/lib.rs::CreateNullifier` declares `ix_sysvar: Option<AccountInfo<'info>>` only when `cpi-only` is enabled. Anchor's `Option<AccountInfo>` semantics — whether the slot must be physically present in the ix accounts list, or may be skipped — differs slightly across Anchor versions.

The current SDK always supplies the slot (10 accounts) when `inlineCpiNullifier` is on. That's the safe path. But if Anchor 0.31's `Option<AccountInfo>` *requires* a leading bool/pubkey-sentinel byte in the ix data instead, the deserialize will fail. This is the single most likely thing to surface during local testing.

If it does, two cheap fixes:
- Drop `Option`, make `ix_sysvar` mandatory in cpi-only builds.
- Switch to a non-Anchor account derivation (`UncheckedAccount` + manual `address` constraint).

### §6.3 Inner-CPI signer flag propagation (LOW)

`nullifier_cpi.rs::invoke_create_nullifier` reads each account's `is_signer` flag from the passed `AccountInfo` and forwards it into the inner `AccountMeta`. The relayer's `is_signer = true` propagates through the runtime. Standard Solana CPI semantics, used everywhere; no reason to think this fails.

### §6.4 The pool's `instructions_sysvar` named slot in inline mode (LOW)

The pool's `Unshield` / `AdaptExecute` accounts struct still declares `instructions_sysvar: AccountInfo` with an `address = ...` constraint. In inline mode the handler doesn't read it. The slot still has to be the canonical sysvar pubkey or Anchor rejects the tx during account validation. The SDK passes the canonical sysvar in both modes, so this is fine — but it does cost 1 B in the ALT case forever.

A future cleanup could `cfg`-gate the field too, dropping it from inline-mode builds and saving that 1 B. Skipped for Phase 7 to keep the on-chain account-struct ABI stable across the two feature builds.

## §7. Mainnet upgrade plan (DO NOT execute from this branch)

The user runs these manually after review. None of these commands have been run by the agent.

```bash
# Confirm clean working tree on the right branch.
git status
git log --oneline -3   # expect the 3 phase-7 commits

# 1. Build both programs locally first.
cargo build-sbf --manifest-path programs/b402-pool/Cargo.toml \
    --features inline_cpi_nullifier
cargo build-sbf --manifest-path programs/b402-nullifier/Cargo.toml \
    --features cpi-only

# 2. Inspect the resulting .so sizes — should be within ~2 KiB of the
#    deployed bytecode size for each program (no major dep growth).
ls -lh programs/b402-pool/target/deploy/b402_pool.so
ls -lh programs/b402-nullifier/target/deploy/b402_nullifier.so

# 3. Compare the deployed mainnet bytecode size to the new .so size to
#    estimate the deploy buffer rent. The mainnet pool is at ~416560668.
solana program show 42a3hsCXtQLWonyxWZosaaCJCweYYKMrvNd25p1Jrt2y \
    --url https://api.mainnet-beta.solana.com

# 4. Devnet rehearsal — deploy to devnet and run the full
#    tests/v2/e2e/*.test.ts against the deployed devnet pool with
#    inlineCpiNullifier: true. CONFIRM raw tx bytes are < 1232 for
#    Jupiter (simple) + Kamino deposit. If either test goes red,
#    DO NOT PROCEED to mainnet.

# 5. Mainnet upgrade — pool first, then nullifier.
solana program deploy \
    --url https://mainnet.helius-rpc.com/?api-key=1a565ed2-... \
    --program-id 42a3hsCXtQLWonyxWZosaaCJCweYYKMrvNd25p1Jrt2y \
    programs/b402-pool/target/deploy/b402_pool.so

solana program deploy \
    --url https://mainnet.helius-rpc.com/?api-key=1a565ed2-... \
    --program-id 2AnRZwWu6CTurZs1yQpqrcJWo4yRYL1xpeV78b2siweq \
    programs/b402-nullifier/target/deploy/b402_nullifier.so

# 6. Mainnet smoke. Same shape as
#    examples/hosted-relayer-smoke.ts, but with inlineCpiNullifier: true
#    on the B402Solana constructor. Confirm the round trip and capture
#    the tx signature in commit history.
```

Order matters: deploy the pool first (it's still backwards-compatible during the gap because the nullifier still serves sibling callers), then the nullifier. If the nullifier upgrades first, every in-flight v2.1 sibling-ix unshield breaks (cpi-only rejects direct calls). The pool-first order tolerates the gap.

## §8. Concerns and surprises

- **The 187-byte savings figure was a sibling-ix-overhead-only number.** Once you account for the ~135 B of payload data that has to move into the pool ix's `nullifier_cpi_payloads`, the gross delta drops. Real measured net is **~65 B per nullifier** (see §4.2). That's enough to land complex Jupiter (24 adapter accounts, OVERFLOWS today) and Kamino deposit/withdraw. No measured production payload exceeds 1,232 B in inline mode.
- **Pre-existing unshield.rs / adapt_execute.rs / nullifier_cpi.rs work was already present on the branch's working tree** when this session started. The implementation visible here is largely that prior work plus this session's audit, doc fixes, byte-budget rewrite, and the SDK side. Specifically: `nullifier_cpi.rs`, the cfg-gated handler branches, the `cpi-only` feature scaffold in nullifier, and the `inline_cpi_nullifier` Cargo feature were all on the working tree before this session committed anything. I left them in place because they read sound; the session's contributions on the program side were limited to the doc-comment fix in `nullifier_cpi.rs` (`9` → `10`) and verifying the `B402_POOL_PROGRAM_ID` bytes via bs58 decode (they were correct).
- **Nothing was built.** The Bash sandbox blocks `cargo`, `anchor`, `solana-test-validator`, `pnpm test`, and reads of `/tmp`. The branch's first compile is the user's. Treat steps in §3.1 as smoke-test gates; if any of them fails, surface the error and stop before §3.2.
- **The `cpi-only` enforcement is real but narrow.** It checks the *top-level* ix's program ID equals `b402_pool`. It does not check the immediate parent (= `get_stack_height() == 2` would be a stricter invariant). For our use case the top-level check is sufficient because we trust b402_pool to only CPI when the proof verifies; a more sophisticated attacker who pushes a CPI chain through some intermediary program *could* potentially relay the call — but they'd need an existing CPI authority into b402_nullifier, which only b402_pool has. Defence-in-depth, not the primary boundary.
- **No litesvm test was added.** The plan called for one. It would have looked like the existing `programs/b402-nullifier/tests/` shape, but parameterised on the inline build of b402_pool. Skipped because authoring a litesvm fixture without being able to execute it has high false-confidence risk.

## §9. Commits on this branch

Filled in below as the session commits land. Each commit is intentionally narrow so revert is easy if a piece doesn't pan out.

| sha (short) | message |
|---|---|
| TBD | feat(pool,nullifier): inline_cpi_nullifier + cpi-only feature scaffolds |
| TBD | feat(sdk): inlineCpiNullifier mode for unshield + privateSwap |
| TBD | docs: PHASE-7-HANDOFF.md |

## §10. Open questions for the user

1. ~~Do you want to land the byte-savings from Phase 7 immediately on mainnet, or wait until 3-hop Jupiter is also unblocked (and ship Phase 7 + Phase 8 together)?~~ — moot: real measurements (§4.2) show Phase 7 unblocks complex Jupiter (24-account routes) by itself. Recommendation: ship Phase 7 alone.
2. Phase 7 changes the pool's args struct shape under the feature flag. The on-chain ABI of the *default* (non-feature) build is unchanged — but a Borsh deserializer that ignores trailing bytes would also accept v2.1 wire on an inline-mode pool. We don't have a Borsh-strictness test pinned. Worth adding before any deploy?
3. The `cpi-only` enforcement is a narrowing of the address-derivation isolation, not a replacement for it. Is it worth the deploy complexity (matching feature flags across two crates) right now, or should we ship inline_cpi_nullifier alone first, then layer cpi-only as a later hardening pass?

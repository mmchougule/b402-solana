# PRD-34 — Solana Program Hardening + Pre-Deploy Harness

Status: drafted 2026-05-03. Author: mayur. Owner: protocol.

## 1. Problem

`solana program upgrade` is irreversible per-tx but not per-state. A bad mainnet binary can:

1. **Brick existing state**: an upgraded binary that mis-decodes its own previously-written accounts wedges every user with funds in those accounts. Recovery requires another upgrade with a corrected binary, but if the bad one is consuming compute from any user touching it, that recovery window costs real SOL in failed txs.
2. **Drain the deployer/upgrade-authority account** if the upgrade has unbounded loops, account-init mistakes, or rent-exempt-balance bugs. We saw this with mistakes on Phase 7 (~0.5 SOL each on extend + buffer).
3. **Permanently waste SOL** on buffers from failed upgrades: 0.5–3 SOL per buffer on a 200KB program. Over a couple bad attempts that's $300+ gone.

The recent shipping bugs in this repo (Phase 9 republish chain — wrong zkey bundled, missing `excess` tag, missing `outSpendingPubA`) hit users but didn't cost SOL because they were JS-side. As we move per-user adapter state, rent buffer logic, withdraw handlers, and the upcoming `gc_obligation` body to mainnet, the equivalent class of bug WILL cost SOL — both ours (deploy buffer + extend) and users' (failed-tx fees against a broken obligation).

## 2. Goals

A `pre-deploy-check.sh` harness that gates every `solana program upgrade` on:

1. Reproducible byte-identical build from a clean checkout
2. Mainnet-fork e2e green for the exact target flow
3. Localnet upgrade dry-run from the previously-deployed binary to the new one, with state cloned
4. IDL diff review (account layout breaks surface here)
5. CU profile + tx size bounds check

If any gate fails, the script aborts before any irreversible mainnet call. Manual override is possible (`--force`) but logged.

## 3. Non-goals

- Formal verification (out of scope for V1; revisit at $10M+ TVL)
- Multisig upgrade authority (Phase 35; current authority is a hot keypair — flag for follow-up)
- 3rd-party audit (separate gate, scheduled per release cadence)

## 4. Gates

### 4.1 Reproducible build

Source + toolchain → byte-identical `.so`. Without this, an attacker controlling the build environment can substitute bytes; we also can't verify "the binary I'm about to deploy is what I tested."

```sh
# In ops/pre-deploy-check.sh, before any deploy:
cargo clean -p $PROGRAM
RUSTFLAGS="-C metadata=" cargo build-sbf -p $PROGRAM \
  --features "$FEATURES" \
  --manifest-path Cargo.toml
sha256sum target/sbf-solana-solana/release/$PROGRAM.so > /tmp/local-build.sha
solana program dump $PROGRAM_ID /tmp/onchain.so 2>/dev/null
sha256sum /tmp/onchain.so > /tmp/onchain-build.sha
```

For an upgrade, we don't compare to the on-chain binary (that's what we're replacing). Instead we re-run the build twice and require the two SHAs match — the determinism check.

Anchor doesn't ship a verifiable-build tool yet; `solana-verify` (Ellipsis) is the closest, but adoption is uneven across the ecosystem. For now we treat "two consecutive `cargo build-sbf` runs from a clean tree produce the same SHA" as the bar. If they don't, abort — something in the toolchain has nondeterminism we need to fix first (usually `RUSTFLAGS` metadata, build paths, or proc-macro state).

### 4.2 Mainnet-fork e2e green

`tests/v2/scripts/start-mainnet-fork.sh` clones klend + Pyth oracles + market state. The harness builds the new binary into the local validator BPF cache so the fork runs the program-being-deployed against real protocol state.

Required passing tests for any kamino-adapter upgrade:

```
tests/v2/e2e/v2_fork_lend.test.ts                   shared-obligation backstop
tests/v2/e2e/v2_fork_lend_per_user.test.ts          deposit per-user
tests/v2/e2e/v2_fork_redeem_per_user.test.ts        withdraw per-user (new)
tests/v2/e2e/v2_fork_rent_charging.test.ts          setup fee + buffer (new)
tests/v2/e2e/v2_fork_gc_obligation.test.ts          gc body (when 33.4 lands)
```

For pool upgrades, add:

```
tests/v2/e2e/v2_fork_swap.test.ts
tests/v2/e2e/v2_fork_phase9_dual_note.test.ts
```

Harness fails CI if any of the above fail or if a NEW e2e in the changed program's path lacks coverage (i.e. you can't merge a new code path without an e2e for it).

### 4.3 Upgrade dry-run

Real upgrades on mainnet have one mode: replace the program data. There's no "stage and review" between buffer-write and upgrade-apply at the protocol level (the buffer is durable, but applying it is one tx). What we can do:

1. Spin up a local validator (`solana-test-validator --reset --bpf-program ...`)
2. Deploy the CURRENT mainnet binary (`solana program dump` then `solana program deploy`) at the same program ID
3. Clone any state accounts that depend on the binary's current shape (Pool config, AdapterRegistry, prior-version ObligationOwner accounts if any exist on mainnet)
4. Run `solana program upgrade` against the new binary
5. Run the e2e suite from §4.2 in a single shot, asserting that:
   - Pre-existing state accounts deserialize cleanly under the new binary
   - New tx flow lands without `AccountDidNotDeserialize` or `InvalidAccountData`
   - Pre-existing user balances are unchanged

This catches the entire class of "the new account layout doesn't match what's already on chain." Specifically valuable when we add struct fields without bumping account discriminators.

```sh
ops/upgrade-dry-run.sh kamino-adapter $PROGRAM_ID per_user_obligation
```

Required to pass before mainnet upgrade.

### 4.4 IDL diff

Anchor IDLs encode the public surface. A breaking change here breaks SDK + clients silently:

```sh
anchor idl build -p $PROGRAM > /tmp/new-idl.json
anchor idl fetch $PROGRAM_ID > /tmp/onchain-idl.json
diff <(jq -S . /tmp/onchain-idl.json) <(jq -S . /tmp/new-idl.json) > /tmp/idl-diff.txt
```

Harness flags any of:
- Removed instruction (caller breakage)
- Removed account in an existing ix (caller breakage)
- Reordered fields in any account or struct (binary breakage — discriminator collision risk)
- Type narrowing (`u64` → `u32`, etc.)

Additions are fine. Deletions and reorderings require explicit `--allow-breaking` flag with a comment in the deploy log.

### 4.5 CU profile + tx size

Each new e2e test logs:
- Maximum CU consumed by any tx in the suite
- Maximum serialized tx size (bytes)
- Maximum account count in any single tx

Hard limits (Solana runtime):
- 1.4M CU per tx (we target 1M to leave headroom)
- 1232 B per tx (legacy) / 1232 B + ALT compression (v0)
- 64 accounts per tx, 256 in v0 with ALT

Harness fails if any test breaches 1.2M CU or 1100 B uncompressed. A 1100 B alarm gives us 132 B of headroom for sig + recent_blockhash + preflight metadata that aren't visible in the inner ix.

## 5. Implementation

### 5.1 `ops/pre-deploy-check.sh`

```sh
#!/usr/bin/env bash
# Pre-deploy gate. Exit non-zero if any check fails.
#
# Usage:
#   ops/pre-deploy-check.sh <program-name> <program-id> [features]
#
# Example:
#   ops/pre-deploy-check.sh b402-kamino-adapter \
#       2enwFgcGKJDqruHpCtvmhtxe3DYcV3k72VTvoGcdt2rX \
#       per_user_obligation

set -euo pipefail

PROGRAM=$1
PROGRAM_ID=$2
FEATURES=${3:-}

echo "→ gate 1/5: reproducible build"
./ops/check-reproducible-build.sh "$PROGRAM" "$FEATURES"

echo "→ gate 2/5: mainnet-fork e2e"
./tests/v2/scripts/start-mainnet-fork.sh &
FORK_PID=$!
trap "kill $FORK_PID" EXIT
sleep 10
pnpm vitest run tests/v2/e2e/v2_fork_*.test.ts -- --filter "$PROGRAM"

echo "→ gate 3/5: upgrade dry-run"
./ops/upgrade-dry-run.sh "$PROGRAM" "$PROGRAM_ID" "$FEATURES"

echo "→ gate 4/5: IDL diff"
./ops/idl-diff.sh "$PROGRAM" "$PROGRAM_ID"

echo "→ gate 5/5: CU + tx size budget"
./ops/cu-budget-check.sh "$PROGRAM"

echo "✓ all gates passed. SAFE TO RUN: solana program upgrade ..."
```

Wraps the more focused per-gate scripts. Each gate's script is small (10–30 lines) and individually testable.

### 5.2 Wire into `ops/phase9-devnet-upgrade.sh` and equivalents

Every existing deploy script gains a `pre-deploy-check.sh` invocation as the first line. Bypass requires `--skip-checks` flag, which prints a loud warning and logs the bypass.

### 5.3 CI integration (post-V1)

GitHub Actions runs the pre-deploy-check on every PR that touches `programs/`. Nightly runs against mainnet RPC for fork freshness. PRs gated on green.

Not in V1 (we're a small team and ops budget is tight); ship the local script first and graduate to CI when the cadence justifies it.

## 6. Rollback plan

If a bad binary lands on mainnet:

1. **Immediate**: revert the upgrade with `solana program upgrade` against the previous-known-good binary. Requires upgrade authority (a hot keypair today; multisig in Phase 35). Cost: 1 buffer rent (~3 SOL on a 200 KB program), recoverable when the buffer is closed.
2. **Cooldown**: any tx in flight against the bad binary will fail. Users see the failure; we eat ~0.000005 SOL per failed tx. Manageable; broadcast warning on the relayer health endpoint immediately.
3. **Postmortem**: the harness gate that should have caught the bug is named in the incident doc + a regression test added before the next deploy.

## 7. Open questions

1. **Multisig upgrade authority.** Currently a hot keypair. Phase 35 spec needed: Squads multisig, with 2-of-N signers. Until then, the keypair sits in `~/.config/solana/`.
2. **Reproducible-build vendor.** `solana-verify` adds a docker dependency; do we run it in V1 or accept "two cargo runs match" as the bar?
3. **Testnet vs devnet vs mainnet-fork as the e2e target.** Today: mainnet-fork is the most realistic. Devnet skips Kamino (not deployed there). Worth maintaining a devnet sanity-check despite the gap?

## 8. Schedule

- Phase 34.1 — `pre-deploy-check.sh` skeleton + reproducible-build gate (~3h)
- Phase 34.2 — upgrade-dry-run script (~4h)
- Phase 34.3 — IDL diff + CU budget gates (~2h)
- Phase 34.4 — wire into phase9-devnet-upgrade.sh + every existing deploy script (~2h)
- Phase 34.5 — CI integration (post-V1)

Total Phase 34.1–34.4: ~1 focused day. Run before the next mainnet upgrade (which is the kamino-adapter `per_user_obligation` flip from PRD-33).

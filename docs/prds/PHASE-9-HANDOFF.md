# Phase 9 — handoff (BLOCKED)

| Field | Value |
|---|---|
| Date | 2026-04-30 (overnight session) |
| Branch | `feat/phase-9-dual-note` (off `feat/phase-7-inline-cpi` HEAD `7e21ff0`) |
| Status | **Spike complete. Implementation halted.** Spec needs a design decision before code lands. |
| Predecessor | Phase 7B (live on mainnet, slot ~458500000+) — **untouched.** |
| Mainnet impact | none. No deploys, no pushes, no built `.so`. |

## §1. What you wake up to

One commit on `feat/phase-9-dual-note`:

```
adeaa10 phase 9 spike: codebase findings — design blocked on circuit access to outSpendingPub
```

That commit adds exactly one file: `docs/prds/PHASE-9-spike-notes.md`. Nothing else. No production code, no tests, no `.so` artifact, no SDK changes for Phase 9.

The other working-tree modifications (PRD-21 doc edits, mcp-server `private_swap` and `status` tweaks, SDK `b402.ts` changes, examples, etc.) are unrelated to Phase 9 and were already on `feat/phase-7-inline-cpi`'s working tree at session start. I did **not** touch them.

## §2. Why I stopped

The PRD's §3.2 implementation sketch — *pool computes `commitment_b` in Rust from runtime values* — cannot be written against the deployed v2.1 adapt circuit. The handler does not have access to the user's `spending_pub`, which is the witness that binds a Poseidon commitment to its owner. The PRD also calls for `Endianness::BigEndian` Poseidon and `poseidon_bytes("...")` tag derivation — both wrong relative to the deployed convention (LittleEndian + `tag_fr_le` const fn).

Per your overnight task instructions:

> If you find the spec is wrong, document the correction and stop for review rather than improvising.

So I stopped. The spike notes spell out the chain of citations (file:line for every claim) and sketch four redesign options for you to pick from. Read those before writing more code.

## §3. The two-paragraph version

The adapt circuit (`circuits/adapt.circom`) has 23 public inputs. None of them is the user's `outSpendingPub` or `outRandom`. Both are private witnesses inside the prover. The pool's view of the proof is *only* the public list, so when the PRD says "pool computes `commitment_b = Poseidon(commit, mint, excess, randomB, spendingPub)` in Rust", the pool cannot fill in the `spendingPub` slot. Without that slot, the excess commitment either (a) carries no owner identity (so anyone can spend it — security break), (b) reuses `recipient_bind` which is `Poseidon(tag, 0, 0)` for swap (same break), or (c) skips the leg entirely (same break). All three break the PRD's own §4 invariant *"Excess note is recoverable by user only"*.

The cleanest fix is to add `outSpendingPub[0]` to the adapt circuit's public input list. That's a 1-line circuit change but requires a fresh trusted setup for the adapt circuit and a redeploy of `b402_verifier_adapt`. After that, the PRD's §3.2 implementation works literally as drafted (with the endianness and tag-derivation corrections from §5 of the spike notes). Three other paths (out-of-band hint, value-anchored leaf, defer-to-Phase-8) are sketched in spike notes §6 with cost/risk for each.

## §4. Where to go from here

**Read first:** `docs/prds/PHASE-9-spike-notes.md`. Specifically §1 (spike Q&A with citations), §5 (PRD errata table), §6 (four redesign options).

**Decide:** which of the four options to take. My recommendation is Option A (circuit change, +1 public input). It matches the PRD's intent verbatim, costs 32 wire bytes per swap, and stays inside the existing primitive set.

**Then:**

- **If Option A:** add `outSpendingPub[0]` to `circuits/adapt.circom`'s `component main { public [...] }` block, run the trusted setup ceremony, deploy a new `b402_verifier_adapt`, point pool's `pool_config.verifier_adapt` at it. Then the rest of PRD §3 implements as written (with the corrections in spike notes §5). I can resume the overnight implementation from this branch on top of those.

- **If Option B / C:** rewrite the PRD section by section. The current §3.2 sketch becomes obsolete; the new one would describe the chosen mechanism. Then I can implement against the rewritten PRD.

- **If Option D:** close PHASE-9-dual-note-minting.md without implementation. Reframe the demo claim to acknowledge ≤slippageBps loss until a future "sweep dust" phase lands.

## §5. What I did not do (deliberately)

- Did **not** modify any production code. The risk of writing code against a broken spec (per task instructions) outweighs the time saved.
- Did **not** add a `TAG_EXCESS` constant. The PRD's spec for it is wrong (says Poseidon, should be `tag_fr_le`); committing the wrong shape locks in a bug. Once the redesign is picked, the constant lands as part of that branch.
- Did **not** run `cargo build-sbf`. No code changes ⇒ no rebuild. Phase 7B's `.so` at `ops/phase7-builds/b402_pool_inline_v2.so` is still the rollback target.
- Did **not** boot mainnet-fork. Same reason.
- Did **not** publish, push, or deploy anything. None of the guardrail-blocked operations were attempted.

## §6. Test results

None to report. No tests were added or run because the implementation halted before code.

The existing test suite on `feat/phase-7-inline-cpi` remains untouched. Smoke gating that suite before any Phase 9 work resumes is a pre-requisite anyway, and I did not perturb it.

## §7. Build artifacts

None new. `ops/phase7-builds/b402_pool_inline_v2.so` (existing, from the prior session) is unchanged and is still the production rollback target. No `b402_pool_dual_note.so` was built.

## §8. Concerns / surprises uncovered (beyond the spec issue)

1. **`u64_to_fr_le` is duplicated four times** in `programs/b402-pool/src/instructions/{adapt_execute,shield,unshield,transact}.rs`. Unrelated to Phase 9, but worth a future cleanup commit lifting it into `util.rs`.

2. **The PRD sketch hand-waves `(spending_pub_x, spending_pub_y)`** as if Poseidon over BN254 had an x/y decomposition. It does not — the `Commitment` template takes a single Fr `spendingPub`. The author may have been thinking of an ECDSA pubkey decomposition (Ethereum-style) and forgotten that here it's a Poseidon-image scalar. Worth noting in the redesigned PRD so the author's mental model converges with the deployed primitive.

3. **PRD §3.2 says "extend `tree_state.append_leaf` ... if hardcoded to 2-per-tx, refactor"** — there's no such hardcode. `tree_append` is N-per-tx already. The handler loops over `commitment_out.iter()`. So this part of the PRD plan is unnecessary work.

4. **PRD §6 Q5 calls for a parity test in `b402-assurance/vectors/`** — I did not add it because the Rust-side function it would parity-check (`commitment_b` builder) does not yet have a defined shape. Ship the parity test alongside the implementation, not before.

5. **The `feat/phase-7-inline-cpi` working tree was already dirty** at session start (9 modified + 15 untracked, as shown in §1). I left those alone. If you intend to commit any of them, do so on `feat/phase-7-inline-cpi` directly — don't carry them on `feat/phase-9-dual-note` because they're noise relative to Phase 9's purpose.

## §9. Rollback plan

There is nothing to roll back. Phase 7B mainnet remains untouched. The branch `feat/phase-9-dual-note` contains one commit (the spike notes) that is doc-only.

If you want to discard the branch entirely and treat the spike as an in-place doc on `feat/phase-7-inline-cpi`:

```bash
git switch feat/phase-7-inline-cpi
git checkout feat/phase-9-dual-note -- docs/prds/PHASE-9-spike-notes.md docs/prds/PHASE-9-HANDOFF.md
git branch -D feat/phase-9-dual-note   # no force needed; nothing was pushed
```

Or keep the branch as the on-record artifact of the spike. Both are clean.

## §10. Mainnet upgrade commands (placeholder)

None. No new `.so` exists to deploy. The Phase 9 deploy plan will be filled in once the redesign option is picked and the implementation lands.

For reference, the Phase 7B commands (already in `PHASE-7-HANDOFF.md`) remain the active mainnet-deploy reference until Phase 9 ships:

```bash
solana program deploy \
    --url https://mainnet.helius-rpc.com/?api-key=1a565ed2-... \
    --program-id 42a3hsCXtQLWonyxWZosaaCJCweYYKMrvNd25p1Jrt2y \
    ops/phase7-builds/b402_pool_inline_v2.so   # current production binary
```

## §11. Final summary

- Branch state: 1 commit on `feat/phase-9-dual-note`, working tree carries pre-existing dirty edits from `feat/phase-7-inline-cpi` (untouched here). No `.so` built.
- Test results: none, by design.
- What's left for you: read the spike notes, pick redesign Option A/B/C/D, then unblock me. Estimated overnight implementation time once unblocked is ~4-6 hours for Option A (circuit + verifier + pool + SDK + tests + handoff).
- Concerns: the PRD as drafted has 5 distinct technical errors (catalogued in spike notes §5). All fixable; none discovered late enough to compromise mainnet.

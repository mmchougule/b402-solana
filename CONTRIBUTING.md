# Contributing

Thanks for the interest. This is alpha — every contribution counts more than
it would on a mature project.

## Quick rules

- **Read the PRDs before writing code.** `docs/prds/` is the architecture
  ground truth. PR comments arguing against the PRD are fine; PR code that
  silently contradicts the PRD won't merge.
- **TDD where the surface allows.** Circuit tests, payload-format tests,
  pool program tests, SDK tests — if your change touches one of these,
  add a failing test first and make it pass. There's a test framework in
  every layer; check before writing a new one.
- **Honest about ship-state.** "Designed-for-future" claims are fine in
  PRDs and module docs (clearly tagged), not in user-facing READMEs or
  the website.
- **Adapter additions** are the easiest win — pick a Solana DeFi protocol,
  copy the `b402-kamino-adapter` scaffold, write the per-op account list
  from the protocol's IDL, write payload tests, write a mainnet-fork
  probe. PR.

## Setup

Toolchain:

- Rust stable + Solana CLI 2.0+ + platform-tools v1.54
- Node 20+, pnpm workspace
- Circom 2.2+, snarkjs

```bash
pnpm install
cd circuits && pnpm install && RUN_PARITY=1 RUN_CIRCUIT_TESTS=1 pnpm vitest run
cd ../programs/b402-pool && cargo test
```

## Commit style

- Conventional-ish: `<area>: <change>` — e.g. `pool: bind expected_out_value
  in adapt_execute`, `kamino-adapter: full Deposit handler GREEN on
  mainnet-fork`
- One logical change per commit. Squash before merge unless there's a
  reason for granular history.
- Write WHY in the body, not just WHAT. Reviewers and future-you read it.
- Reference the relevant PRD section: `Per PRD-04 §7.2, the registry
  gains a circuit_binding_flags field...`

## PR checklist

- [ ] Tests pass: `cargo test --workspace` and `pnpm test` in each
      package you touched
- [ ] BPF builds clean for any program crate touched:
      `cargo build-sbf --tools-version v1.54 --manifest-path programs/<crate>/Cargo.toml`
- [ ] If you touched a public input or wire format, the SDK encoder + on-chain
      decoder agree (parity tests)
- [ ] If you touched the adapter ABI, PRD-04 is amended in the same PR
- [ ] If you added a new file, it has an Apache 2.0 / SPDX header
- [ ] No internal scratch docs (BUILD-STATE.md, OPS.md, NOTES.md, SCRATCH.md
      are all gitignored — keep it that way)

## What's a good first contribution

In rough order of helpfulness:

1. **Run the examples and report what broke.** Fresh-eyes UX feedback is
   gold. File issues with reproduction commands.
2. **Open a PR for the adapter you wish existed.** Marginfi, Solend, Phoenix,
   Meteora, Sanctum LST, Jito restaking, Phoenix orderbook — all are open
   game. The kamino-adapter PR is the worked example.
3. **Test vector contributions to `b402-solana-assurance`** — find a
   vector we haven't pinned (commitment edge case, nullifier collision
   probe, oracle-stale fork test) and add it.
4. **Documentation gaps.** If you read the docs and a concept was unclear,
   PR a clarification. Fresh-eyes is rare and valuable.
5. **Audit-friendly cleanups.** Anything that removes a `// TODO(verify)`
   comment by replacing it with a verified-against-IDL citation.

## Code of conduct

See [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md). Standard Contributor
Covenant.

## License

Apache 2.0. By contributing you agree your contribution is licensed under the
same. We don't require a CLA for v0.x.

## Operating reality

This is a small team during alpha. Response times on issues + PRs are
best-effort. If something is urgent (security), email per
[SECURITY.md](./SECURITY.md). Otherwise, expect 1-3 business days for a
first response.

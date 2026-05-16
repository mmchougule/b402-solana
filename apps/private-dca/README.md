# private-dca

Agent-driven private DCA on Solana mainnet — `N` recurring USDC -> SOL
swaps where none of the swap transactions contains the user's wallet
pubkey. A parallel public-Jupiter baseline produces the inverse property
on a throwaway wallet so the comparison artifact is dropped side-by-side.

The spec is in [`PRD.md`](./PRD.md). This file is operational.

## What it proves

For an `iters=N` run with the same pair / amount / cadence:

- **Public baseline** — every Jupiter swap tx has the user wallet as
  `signer[0]`. Linkage `wallet -> N swaps` is direct on chain.
- **Private DCA** — every swap tx is signed by the hosted relayer
  (`7f6gRiX56dMQGrPERNBKuzFsvagFTM1U4LMAAN9rsiNM`). The user wallet does
  not appear in `tx.transaction.message.staticAccountKeys` on any of the
  N txs.
- The shielded pool deposit (one-time per run) is still wallet-attributable,
  same as any zk-pool. See `PRD.md` for the full privacy frame and the
  on-chain enforcement points cited in `docs-site/concepts/privacy-model.mdx`.

The artifact (`results/run-<ts>.json` and `.md`) carries the two tx-hash
sets + a verified `signer[0]` per row. Wallet-isolation is asserted
in code (`lib/wallet-isolation.ts`) after each loop completes; runs
that don't satisfy the property still produce the artifact, with the
failed checks recorded.

## Run

Requires Node 20+, pnpm, and a Helius mainnet RPC URL.

```
export B402_RPC_URL='https://mainnet.helius-rpc.com/?api-key=<your-key>'
pnpm install --filter @b402ai/private-dca...
```

### Tests

```
pnpm --filter @b402ai/private-dca test
```

Three test files cover the orchestrator, the wallet-isolation predicate,
and the artifact renderer. No RPC needed.

### Fresh wallets

First invocation auto-generates a keypair in `.wallets/` (gitignored)
for each role and exits. Fund them:

```
pnpm --filter @b402ai/private-dca private        # generates .wallets/private-dca.json
pnpm --filter @b402ai/private-dca public         # generates .wallets/public-dca.json
```

Each fresh wallet needs roughly:

- Private side: `iters * amount` USDC + ~0.005 SOL for the one-shot
  shield's network fee + ATA rent.
- Public side: `iters * amount` USDC + ~0.01 SOL for `N` Jupiter swap
  fees + transient wSOL account rent.

Both wallet files are mode 0600 and gitignored. Override the path with
`B402_DCA_PRIVATE_KEYPAIR` / `B402_DCA_PUBLIC_KEYPAIR` if you want to
manage keys elsewhere.

### Private DCA loop

```
pnpm --filter @b402ai/private-dca private -- \
  --iters 8 --interval 90 --amount 1.0
```

What happens:

1. Sanity-checks `B402_RPC_URL`, the wallet's USDC and SOL balances.
2. Calls `b402.shield()` once for `iters * amount` USDC. This is the
   only tx in the run that the user wallet signs.
3. Runs the DCA loop. Each iter calls `b402.swap()` (USDC -> SOL via
   Jupiter behind the shielded pool). The hosted relayer signs.
4. For each swap signature, fetches the tx and asserts
   `signer[0] == relayer && !accountKeys.includes(userWallet)`.
5. Writes `results/private-<ts>.json` with per-iter sigs, explorer
   links, latencies, and the isolation-check rows.

`B402_DCA_SKIP_SHIELD=1` skips the seed shield and reuses an existing
shielded note from the SDK note store (`~/.b402ai/notes/mainnet/`).

### Public Jupiter baseline

```
pnpm --filter @b402ai/private-dca public -- \
  --iters 8 --interval 90 --amount 1.0
```

Each iter hits Jupiter v6 (`/quote` + `/swap`) and lands a user-signed
v0 tx. Writes `results/public-<ts>.json` with the same shape as the
private side.

### Render comparison

```
pnpm --filter @b402ai/private-dca render
```

With no flags, picks the most recent `private-*.json` and `public-*.json`
in `results/`. Writes `run-<ts>.json` and `run-<ts>.md` next to them and
prints the Markdown to stdout. Pass `--private <path>` / `--public <path>`
to pin specific runs.

The Markdown table renders the two tx-hash columns row-by-row with the
linkage summary at the top: who signs (user vs. relayer) and whether
the user wallet appears in the swap-tx accounts list at all.

## Agent usage

The b402 MCP server exposes the same code paths used by `cli.ts`. Once
the MCP server is configured (see `docs-site/mcp/claude-code-setup.mdx`)
an agent driving USDC -> SOL DCA through `b402_shield` then a loop of
`b402_swap` calls produces the same on-chain shape and the same artifact
when the orchestrator pipes the returned sigs into `render-comparison.ts`.

## Files

```
PRD.md                 product spec — outcome property, what is and isn't hidden
cli.ts                 private DCA loop entry point
baseline-cli.ts        public Jupiter loop entry point
render-comparison.ts   combines a private + public JSON into the side-by-side artifact
lib/dca-loop.ts        pure orchestrator (tested with virtual clock)
lib/wallet-isolation.ts predicate + verifier used after each run
lib/comparison.ts      JSON + Markdown artifact builders
lib/public-jupiter.ts  thin Jupiter v6 client for the baseline
lib/keypair.ts         load-or-create fresh demo wallet (never overwrites)
lib/args.ts            tiny flag parser
test/*.test.ts         3 test files, 17 tests, no RPC
results/               run artifacts (committed alongside the demo for proof)
```

## What's intentionally not here

- No vault. No third-party deposit. No yield management.
- No multi-token routing. v1 is one IN, one OUT.
- No on-chain anonymity-set widening. The hosted relayer's tx history
  is shared across users on mainnet today; in this run the only privacy
  property we claim is `wallet-not-in-swap-tx`, not "indistinguishable
  among many users."

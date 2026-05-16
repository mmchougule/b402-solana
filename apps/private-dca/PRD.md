# Private DCA — product spec

Status: v1. Mainnet target. Engineering-only spec.

## Outcome property

A scheduled USDC -> SOL DCA loop on Solana mainnet produces N swap txs none of which contain the user's wallet pubkey in any account slot. A parallel public-Jupiter DCA on a throwaway wallet produces N txs all of which trace back to that wallet. The two tx-hash sets, dropped side-by-side, are the artifact.

## What this is NOT

- Not a vault. No deposit of third-party funds, no shared state.
- Not a yield strategy. No rebalancing logic beyond fixed-interval swap.
- Not multi-token in v1. One IN mint, one OUT mint, one user.
- Not a UI. CLI + JSON artifact + Markdown report.
- Not a relayer change. Uses the deployed hosted relayer as-is.

## User flows

### Agent-driven (Claude / MCP)
The agent is given: `IN=USDC, OUT=SOL, amount=1.0 USDC, interval=90s, iters=8`. It invokes the b402 MCP `shield` + `swap` tools in a loop, or calls the SDK directly. Same code path either way — the SDK is the source of truth.

### CLI-driven (Node script)
```
pnpm exec tsx cli.ts --iters 8 --interval 90 --amount 1.0
pnpm exec tsx baseline-cli.ts --iters 8 --interval 90 --amount 1.0
pnpm exec tsx render-comparison.ts \
    --private results/private-<ts>.json \
    --public  results/public-<ts>.json
```

## The artifact

A pair of files in `results/`:

- `run-<timestamp>.json`:
  ```
  { public_run:  { wallet, tx_hashes[], explorer_links[], per_swap_ms[] },
    private_run: { user_wallet, relayer_wallet, tx_hashes[], explorer_links[], per_swap_ms[] },
    config:      { in_mint, out_mint, amount, iters, interval_s, cluster, timestamp_utc } }
  ```
- `run-<timestamp>.md`: human-readable table.

Verification: for every private-side tx, the user wallet pubkey is asserted absent from `tx.transaction.message.staticAccountKeys`. For every public-side tx, the user wallet pubkey is asserted present as `signer[0]`.

## Privacy property — what is and isn't hidden

Mirror of `docs-site/concepts/privacy-model.mdx`. v1 demo claims only the wallet-isolation property:

**Hidden across the N private swaps:**
- The user's wallet pubkey. None of the N swap txs contains it; signer[0] is the hosted relayer `7f6gRiX56dMQGrPERNBKuzFsvagFTM1U4LMAAN9rsiNM`.
- Note ownership. Each shielded note is owned by a Poseidon commitment of the viewing pub, not by a wallet.
- Sender -> recipient linkage for any subsequent unshield (unshield isn't in v1 scope but the property survives).

**Public across the N private swaps:**
- The shield tx that seeded the position. Wallet -> pool is visible for the initial deposit. This is the standard "first-deposit reveal" of any shielded pool. Mitigation in scope for v2: shield once with a margin, DCA out of that single deposit.
- Swap amounts, IN/OUT mints, Jupiter route venue. Same exposure as any DEX.
- Tx timing. Small anonymity set on mainnet today; the demo's iterations are spaced 90s apart so the timing pattern is itself a fingerprint. This is honest and matches the privacy model doc.

## Comparison frame

A throwaway Solana wallet runs the same N swaps directly via Jupiter (no shielding). Its `signer[0]` is itself on all N swap txs. The diff is the proof.

The public-baseline tx is constructed via Jupiter's `/v6/quote` + `/v6/swap` REST API (already referenced by the SDK's `jupiter-route.ts`) and submitted by the throwaway wallet's own keypair. No relayer, no shielded pool. Just plain swaps.

## Locked decisions for v1

| Decision | Value | Rationale |
|---|---|---|
| Pair | USDC -> SOL | Cheapest, deepest Jupiter route; matches `quickstart-private-swap.ts`. |
| Default iterations | 8 | Enough to read as a "schedule" not a one-off. 8x ~$1 swap = ~$8 budget per run. |
| Default interval | 90s | Each private swap is ~10-15s of work; 90s spacing gives idle gaps a real DCA would have. |
| Default amount | 1.0 USDC per iter | Above Phoenix lot floor; minimum that routes reliably. |
| RPC | Helius (via `B402_RPC_URL`) | Per `feedback_alchemy_rpc.md` — public RPCs crash Railgun-style flows. |
| Relayer | SDK default (hosted Cloud Run mainnet relayer) | No infra to stand up. |
| Initial shield | One-shot, sized to `iters * amount` | One on-chain wallet -> pool link, then DCA out of it. v2: rotate. |
| Keypair source | `B402_DCA_KEYPAIR_PATH`, falls back to fresh ephemeral keypair written to `apps/private-dca/.wallets/` (gitignored) | Don't reuse user's main wallet. |
| Cluster | mainnet | The artifact only counts on mainnet. |

## Open questions (punted)

- Schedule recovery on crash. v1 is in-memory; if the loop dies, you re-run from scratch. v2 should persist `state.json`.
- Variable amounts (e.g. true-cost DCA against a price oracle). Out of scope.
- Slippage controls beyond the SDK default (30 bps). Out of scope.
- Anonymity-set widening (multi-user batching). Out of scope; needs protocol work, not app work.
- Comparison fairness: the public baseline runs from a fresh wallet, so the "linkage" property is artificially clean. A more honest baseline reuses a wallet with prior history. Not v1.

## Failure modes the demo must handle

- Jupiter route 500: retry once with widened DEX set (`Phoenix,Raydium,Orca`). Surface failure if both fail.
- Relayer 429: backoff + retry. Cap one retry.
- Shield insufficient balance: fail loud, do not start the loop.
- Per-swap latency > interval: emit a warning, do not overlap. The next iter starts when the previous returns.

## Definition of done

1. `results/run-<ts>.json` exists with N public hashes and N private hashes for `iters=8`.
2. For each private hash: `tx.message.staticAccountKeys.includes(userWallet) === false` and `staticAccountKeys[0] === relayerPubkey`.
3. For each public hash: `staticAccountKeys[0] === userWallet`.
4. The `.md` report renders both lists side-by-side, with explorer links.
5. README cites the artifact filename and tx hashes.

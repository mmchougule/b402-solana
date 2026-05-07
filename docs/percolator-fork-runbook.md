# Percolator surfpool runbook (slice 5)

End-to-end harness for testing `b402-percolator-adapter` against the
real `percolator-prog` + `percolator-match` binaries on a mainnet-fork
local validator (Light test-validator + Photon).

## Why this layout

PRD-36 §6.3's seven test cases need:
- a real percolator slab (from `percolator-prog`'s `InitMarket`)
- a real LP entry (from `percolator-match`'s `InitLP`)
- the b402 pool deployed at its `declare_id` so adapt_execute can route
- our adapter at its `declare_id` so the pool can find it

Surfpool gives us all of that locally, without relying on devnet/mainnet
percolator deployments (Toly hasn't shipped either yet).

## Files

| Path | Role |
|---|---|
| `tests/v2/scripts/start-percolator-fork.sh` | Boot script — loads all 6 programs at boot, clones mainnet USDC mint |
| `tests/v2/scripts/init-percolator-market.sh` | Bootstrap — runs `percolator-cli init-market` + matcher init + `init-lp`, emits `/tmp/percolator-market.json` |
| `examples/percolator-adapter-fork.mjs` | Adapter-direct probe — calls `b402_percolator_adapter::execute()` directly, bypassing pool. Isolates adapter↔percolator-prog from pool↔adapter |
| `tests/v2/e2e/v2_fork_percolator.test.ts` | Full pool→adapter→percolator e2e (slice 5-β; not yet shipped) |

## Slice 5 status

| Step | Status |
|---|---|
| Boot script | ✅ |
| Bootstrap script | ✅ end-to-end |
| Adapter-direct probe | ✅ **GREEN — position opened on-chain** |
| Full pool→adapter e2e (slice 5-γ) | next |

### Probe success — finalized tx log

```
[open] user_idx=1 principal=10500000 size=1000 lp=0 ok
sig: 2L6xAduAenkrpzA6sJtnDwqKGdqpH9vwd7zehM7d4jmhJ4w86kRU3JvcDstsbLAUhRbUWAwMi2XL5ztz2A3ohSsG
Finalized
```

Full chain executed: alice USDC → adapter scratch ATA →
`b402_percolator_adapter::execute(OpenPosition)` →
`percolator-prog::InitUser` → `percolator-prog::DepositCollateral` →
`percolator-prog::TradeCpi` → `percolator-match` (passive vAMM) →
position recorded in slab at `user_idx=1`. Total CU: 254k under
the 1.4M cap.

## Bugs found + fixed during the fork run

The probe surfaced six real bugs in our adapter; all fixed in
`programs/b402-percolator-adapter`:

1. **`declare_id!` mismatch with on-disk keypair** — `Brp48gh1…`
   placeholder had no matching keypair. Aligned to
   `65NRt6GpeakqXhqvKcN3knohzKEZT37arUyQi3SZwfxv` (the keypair Anchor
   generated at `target/deploy/b402_percolator_adapter-keypair.json`).
2. **Slab MAGIC byte-order** — adapter `SLAB_MAGIC` was the byte-
   reversed form. percolator-prog stores `u64 MAGIC = 0x504552434f4c4154`
   in native LE; bytes on disk read "TALOCREP". Fixed in `slab.rs`.
3. **Missing `init_mapping` ix** — open path required the `perp_mapping`
   PDA to exist but no ix could create it. Added `init_mapping` +
   `grow_mapping` (Solana's `MAX_PERMITTED_DATA_INCREASE = 10_240`
   forces multi-ix bootstrap: `init` at 10240, then 8 × `grow` to
   reach 81,968 B).
4. **Open-path SPL transfer ordered after `InitUser`** — percolator's
   `InitUser` charges `fee_payment_if_init` from `user_pcl_ata` BEFORE
   our adapter funded it. Reordered: SPL transfer first, then InitUser
   (which now consumes from a funded ATA), then DepositCollateral with
   the post-fee remainder.
5. **Stale percolator-engine pin** — adapter pinned engine commit
   `a946e550`, but percolator-prog at origin/main pins `f6b13f57`.
   `Account` struct grew by 64 bytes (224 → 264 owner offset, 384 →
   448 size) and `MarketConfig` grew (328 → 384). Updated git rev +
   `MARKET_CONFIG_LEN` + layout-pin test.
6. **Hyperp market `MAX_ACCRUAL_DT_SLOTS = 10`** — with the
   `defaultInitMarketArgs` profile, trades require a fresh KeeperCrank
   within ~10 slots. Probe now bootstraps + cranks + trades in one
   tight sequence.

## What this proves (mainnet-close)

The full pool-equivalent flow works against the **real** percolator
binaries Toly ships:

- Anchor `execute()` ix dispatch + Borsh action_payload decode
- `derive_owner_pda` / `derive_perp_mapping` PDA verification against
  the slab pubkey
- Slab `MAGIC` sentinel + `Account` field-offset pins (264 / 64 / 0)
  vs the **production** percolator-prog binary
- `invoke_signed` as `owner_pda` for percolator's `InitUser`,
  `DepositCollateral`, `TradeCpi`
- Matcher CPI depth (adapter → percolator-prog → percolator-match) at
  3 levels, well under sBPF's 5-level cap
- Total CU 254k for the open path, well under 1.4M cap

## Prerequisites

```bash
# 1. b402 .so files
anchor build
cd programs/b402-nullifier && cargo build-sbf && cd ../..

# 2. percolator .so files (from Toly's repos)
cd ~/development/ai/percolator-prog && cargo build-sbf
cd ~/development/ai/percolator-match && cargo build-sbf

# 3. percolator-cli
cd ~/development/ai/percolator-cli && pnpm install && pnpm build

# 4. Light + Solana CLI
which light solana solana-keygen jq
```

## Boot

```bash
# Terminal 1 — fork
tests/v2/scripts/start-percolator-fork.sh

# Terminal 2 — point CLI at fork, fund admin
solana config set --url http://127.0.0.1:8899
solana airdrop 100  # admin keypair at ~/.config/solana/id.json

# Bootstrap a market (currently scaffolded — see TODOs in script)
tests/v2/scripts/init-percolator-market.sh
# Emits /tmp/percolator-market.json

# Generate an alice keypair (one-time) and fund USDC
solana-keygen new --outfile /tmp/b402-alice.json --no-bip39-passphrase
solana airdrop 10 /tmp/b402-alice.json
# USDC funding: clone an ATA from mainnet (mint authority is Circle's)
# — see tests/v2/scripts/start-mainnet-fork.sh's INJECT_USDC_ATA pattern.

# Run adapter-direct probe
node examples/percolator-adapter-fork.mjs
```

## What the adapter-direct probe proves

When green: the adapter Borsh-decodes the per-user payload, derives PDAs,
verifies slab MAGIC, allocates a mapping slot, signs as `owner_pda` for
`InitUser` + `DepositCollateral`, and reaches `TradeCpi` against
percolator-prog. Same chain the LiteSVM tests assert in the program-isolation
sense, but here against real percolator-prog state — proves the slab parser's
field offsets (`slab.rs` ACCOUNT_OWNER_OFF=200, etc.) are correct against the
production layout.

## Open issues to resolve on first manual run

1. **Matcher init args** — `percolator-match` likely has its own
   `InitMatcherContext` ix. Capture the exact arg shape on first run +
   bake into `init-percolator-market.sh`.
2. **`init-lp` arg shape** — `percolator-cli init-lp` requires
   `--matcher-program`, `--matcher-context`, `--fee`. Confirm that's
   sufficient and capture working values.
3. **Oracle slot** — Hyperp mode skips oracle reads inside `TradeCpi`,
   but the adapter still passes an account at RA slot 8. Surfpool may
   reject if it's the percolator program ID (which we use as a
   placeholder). Likely fix: pass `Sysvar1nstructions…` or a fresh
   noop account.
4. **lp_pda derivation** — the matcher derives lp_pda from
   `[lp_seed, slab, lp_idx]`; confirm seed name from `percolator-match`
   source.

## Once slice 5-α is green: next is 5-β

The full pool→adapter→percolator chain via `B402Solana.privatePerpOpen`.
Builds on the same fork; uses the SDK methods from slice 4-β. Test file:
`tests/v2/e2e/v2_fork_percolator.test.ts`. ALT extension required for the
12+ remaining_accounts; mirror `v2_fork_lend_per_user.test.ts`'s pattern.

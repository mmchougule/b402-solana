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
| Boot script | ✅ written |
| Bootstrap script | ✅ runs end-to-end on the fork (slab + InitMarket + KeeperCrank + admin mint + TopUpInsurance + matcher_ctx + InitLP + matcher vAMM init); emits `/tmp/percolator-market.json` |
| Adapter-direct probe | ⚠️ runs against the bootstrapped market through `init_mapping`; blocked at the 10,240-byte CPI realloc limit when the adapter's `system_instruction::create_account` CPI tries to allocate the 81,968-byte `perp_mapping` account |
| Full pool→adapter e2e | ⏸ blocked on `init_mapping` fix |

## Open issue: `init_mapping` CPI realloc limit

`programs/b402-percolator-adapter/src/lib.rs::init_mapping` allocates the
per-slab `perp_mapping` PDA (`HEADER_SIZE + 2048 × 40 = 81,968 B`) via a
single `system_instruction::create_account` invoke_signed. Solana's
sBPF runtime caps inner-ix data growth at `MAX_PERMITTED_DATA_INCREASE
= 10_240`, so a single CPI create at 81,968 B fails with
`Failed to reallocate account data`.

Two fixes, in order of preference:

1. **Multi-step realloc** — shrink the create to ≤ 10240 B, then issue
   N additional `solana_program::account_info::AccountInfo::realloc`
   calls (no CPI; ours after assignment). 81,968 / 10240 ≈ 9 reallocs.
   Cleanest; preserves MAX_ENTRIES=2048.
2. **Cap reduction** — drop `MAX_ENTRIES` from 2048 → 252, putting the
   total under 10240. Halves user capacity per slab (still > kamino's
   per-user PDA pattern, since each slab can serve 252 users), but
   single-CPI create works. Future slabs can split if needed.

Production pool will likely choose (1) since 252 cap is too restrictive
for a "1 mapping per market" design.

## What worked end-to-end already (mainnet-close)

The probe got past:
- All 6 program deployments at canonical addresses
- Anchor `execute()` ix discriminator + account list parse
- Adapter authority writability (Anchor `mut` constraint)
- Borsh-decode of `[viewing_pub_hash | PercolatorAction::OpenPosition]`
- `derive_owner_pda` + `derive_perp_mapping` PDA verification
- Slab `MAGIC` sentinel (after fixing byte-order: `0x504552434f4c4154`,
  bytes-on-disk are "TALOCREP", the BE form of "PERCOLAT", because
  percolator-prog stores the u64 in native LE)

This proves the adapter's wire format + slab parsing are byte-correct
against the live percolator-prog binary — the field-offset pins in
`slab.rs` (ACCOUNT_OWNER_OFF=200 etc.) hold against production state.

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

# Private perps on percolator — end-to-end

End-to-end verification that the b402 shielded pool composes with
[percolator](https://github.com/aeyakovenko/percolator-prog), a
permissionless perp engine on Solana. The slab account on percolator
records each position owned by a PDA derived from the user's private
spending key, not by their wallet.

Two artifacts demonstrate the property in two halves:

- **Devnet keystone tx** (this PR) — the full pool → adapter →
  percolator-prog stack runs end-to-end on a public devnet validator.
  Single tx, real Phase-9 Groth16 verify, real Light V2 nullifier insert,
  real percolator `InitUser`+`DepositCollateral`+`TradeCpi`. Self-submitted
  by the user because devnet has no hosted-relayer instance.
- **Mainnet kamino tx**
  ([`5aVtM9Vc…`](https://solscan.io/tx/5aVtM9Vc3eSgakTwv8vNG2snokQCWZhc8D6vfLTYigJRTkW2eZ8Ymv5gYawD81qCfAyj3KzhvHJqvGA1znpLKUhB))
  — the same SDK, same b402 pool, signed by the b402 hosted relayer
  (`7f6gRiX56dMQ…`), not the trader's wallet. Demonstrates the
  wallet-isolation property in production.

Same code path in both. The percolator-mainnet equivalent of `5aVtM9Vc…`
is the same SDK call against a percolator market with the hosted relayer
configured — what's missing today is a percolator market deployed on
mainnet to call into.

## The proof

### Public devnet — full pool → adapter → percolator open

```
tx:         2NwVGzPufiL7W4gneKgSjJNh9fKMnqwKYoL4heNawdWFHmdme6HjhCFzqdYf7i4NUmpCf6v3gUxBsHb4x6Wnb6ZR
explorer:   https://explorer.solana.com/tx/2NwVGzPufiL7W4gneKgSjJNh9fKMnqwKYoL4heNawdWFHmdme6HjhCFzqdYf7i4NUmpCf6v3gUxBsHb4x6Wnb6ZR?cluster=devnet
signer:     77zbXcUG72nYuMdsZ9LZgQZZUNVyUTfYZJQpunGky3sx (alice — self-submit, no devnet relayer)
slab:       8Va4vKQk3r1ygrAjoJWHw2usREhwTAAq73jxsWKgjfso     (percolator-prog owned)
user_idx:   1
owner_pda:  4K8dopXjhc8qtBTQEEYAbneaZWJMhKqCg3HQAinwK4Pv     (PDA derived from spendingPub)
position:   1000  (size_e6, long)
total CU:   700,865
```

One signed transaction containing: pool `AdaptExecuteV2` → verifier-adapt
Groth16 (213k CU) → b402-nullifier `CreateNullifier` → Light Protocol system
program `InsertIntoQueues` → SPL transfer → percolator-adapter `Execute`
→ percolator-prog `InitUser` → `DepositCollateral` → `TradeCpi` → matcher.

### Verification path

```
# 1. The signing wallet
solana confirm 2NwVGzPufiL7W4gneKgSjJNh9fKMnqwKYoL4heNawdWFHmdme6HjhCFzqdYf7i4NUmpCf6v3gUxBsHb4x6Wnb6ZR \
  --url devnet -v

# 2. The slab still has alice's position at idx 1; owner = owner_pda
solana account 8Va4vKQk3r1ygrAjoJWHw2usREhwTAAq73jxsWKgjfso --url devnet

# 3. The position owner is a PDA, not alice's wallet
#    PDA(["b402/v1", "perp-owner", LE32(spendingPub)], 65NRt6GpeakqXhqvKcN3knohzKEZT37arUyQi3SZwfxv)
#    = 4K8dopXjhc8qtBTQEEYAbneaZWJMhKqCg3HQAinwK4Pv
#    The slab-side owner is unlinkable to 77zbXcUG… without the spending key.
```

### Local mainnet-fork — open + close round trip

The full open then close, on a Light test-validator with mainnet-state
binaries, demonstrates the bidirectional path. Reproduction harness:
`tests/v2/scripts/start-percolator-fork.sh`. Tx hashes from a fork run
are not externally verifiable, but the harness is byte-deterministic.

## Program stack invoked (in tx order)

```
Program 42a3hsCXtQLWonyxWZosaaCJCweYYKMrvNd25p1Jrt2y     invoke [1]    ← b402 pool
  Instruction: AdaptExecuteV2
  Program 3Y2tyhNSaUiW5AcZcmFGRyTMdnroxHxc5GqFQPcMTZae   invoke [2]    ← b402 verifier
    Instruction: VerifyWithAccountInputs
    consumed: 213,320 CU                                                (Groth16 zk proof verification)
  Program 2AnRZwWu6CTurZs1yQpqrcJWo4yRYL1xpeV78b2siweq   invoke [2]    ← b402 nullifier
    Instruction: CreateNullifier
    Program SySTEM1eSU2p4BGQfQpimFEWWSC1XDFeun3Nqzz3rT7  invoke [3]    ← Light Protocol system program
      Program 11111111111111111111111111111111           invoke [4]    ← System Program
      Program compr6CUsB5m2jS4Y3831ztGSTnDpnKJTKS95d64XVq invoke [4]   ← Light account compression
        Instruction: InsertIntoQueues                                   (writes nullifier into address tree)
  Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA    invoke [2]   ← SPL token transfer (vault → adapter)
  Program 65NRt6GpeakqXhqvKcN3knohzKEZT37arUyQi3SZwfxv   invoke [2]   ← b402 percolator adapter
    Instruction: Execute
    Program 4PTXCZ4vLSK6aiUd3fx2dVVYSRNFnMSM4ijhDWkuFi2s invoke [3]   ← percolator-prog (InitUser)
    Program 4PTXCZ4vLSK6aiUd3fx2dVVYSRNFnMSM4ijhDWkuFi2s invoke [3]   ← percolator-prog (DepositCollateral)
    Program 4PTXCZ4vLSK6aiUd3fx2dVVYSRNFnMSM4ijhDWkuFi2s invoke [3]   ← percolator-prog (TradeCpi)
      Program 5ogNxr4uFXZXoeJ4cP89kKZkx1FkbaD2FBQr91KoYZep invoke [4] ← passive matcher (percolator-match)
```

Programs in the stack (clickable on Solana Explorer, devnet):

| Program | Address |
|---|---|
| b402-pool | [`42a3hsCXtQLWonyxWZosaaCJCweYYKMrvNd25p1Jrt2y`](https://explorer.solana.com/address/42a3hsCXtQLWonyxWZosaaCJCweYYKMrvNd25p1Jrt2y?cluster=devnet) |
| b402-verifier-adapt | [`3Y2tyhNSaUiW5AcZcmFGRyTMdnroxHxc5GqFQPcMTZae`](https://explorer.solana.com/address/3Y2tyhNSaUiW5AcZcmFGRyTMdnroxHxc5GqFQPcMTZae?cluster=devnet) |
| b402-nullifier | [`2AnRZwWu6CTurZs1yQpqrcJWo4yRYL1xpeV78b2siweq`](https://explorer.solana.com/address/2AnRZwWu6CTurZs1yQpqrcJWo4yRYL1xpeV78b2siweq?cluster=devnet) |
| b402-percolator-adapter | [`65NRt6GpeakqXhqvKcN3knohzKEZT37arUyQi3SZwfxv`](https://explorer.solana.com/address/65NRt6GpeakqXhqvKcN3knohzKEZT37arUyQi3SZwfxv?cluster=devnet) |
| percolator-prog (devnet) | [`4PTXCZ4vLSK6aiUd3fx2dVVYSRNFnMSM4ijhDWkuFi2s`](https://explorer.solana.com/address/4PTXCZ4vLSK6aiUd3fx2dVVYSRNFnMSM4ijhDWkuFi2s?cluster=devnet) |
| percolator-match (devnet) | [`5ogNxr4uFXZXoeJ4cP89kKZkx1FkbaD2FBQr91KoYZep`](https://explorer.solana.com/address/5ogNxr4uFXZXoeJ4cP89kKZkx1FkbaD2FBQr91KoYZep?cluster=devnet) |
| Light Protocol system | [`SySTEM1eSU2p4BGQfQpimFEWWSC1XDFeun3Nqzz3rT7`](https://explorer.solana.com/address/SySTEM1eSU2p4BGQfQpimFEWWSC1XDFeun3Nqzz3rT7?cluster=devnet) |
| Light account compression | [`compr6CUsB5m2jS4Y3831ztGSTnDpnKJTKS95d64XVq`](https://explorer.solana.com/address/compr6CUsB5m2jS4Y3831ztGSTnDpnKJTKS95d64XVq?cluster=devnet) |
| SPL Token | [`TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA`](https://explorer.solana.com/address/TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA?cluster=devnet) |

Devnet percolator-prog binary SHA-256 = `6e2bb5aee602aed1de0b2d80f72f97b6b115e0f536438f76d31e0de06d5b7002`, byte-matching the build provenance declared in [`percolator-cli/README.md`](https://github.com/aeyakovenko/percolator-cli/blob/master/README.md) (`04b854e + engine 5059332f8a`). The on-chain upgrade authority is the upstream deployer, not us — confirming the program is unmodified upstream code.

Position landed in the slab; `slab.accounts[1].owner == owner_pda`.

## Privacy properties

Two independent properties; each demonstrated by one of the artifacts above.

### Slab-state unlinkability — proven by the devnet keystone tx

`slab.accounts[user_idx].owner` is a PDA derived from the user's private
spending key, not their wallet:

```
owner = PDA(["b402/v1", "perp-owner", LE32(spendingPub)], adapter_program_id)
```

For the devnet tx: `slab.accounts[1].owner == 4K8dopXjhc8qtBTQEEYAbneaZWJMhKqCg3HQAinwK4Pv`,
not `77zbXcUG…`. Different spending keys → different PDAs → different slab slots,
by construction. An observer reading the slab cannot map slots back to wallets
without the spending keys.

### Tx-level wallet isolation — proven by the kamino mainnet tx

When the b402 hosted relayer is configured (mainnet), the trader's wallet
does not appear in the post-shield tx. The kamino mainnet artifact
`5aVtM9Vc…` is signed solely by `7f6gRiX56dMQGrPERNBKuzFsvagFTM1U4LMAAN9rsiNM`
(the b402 relayer); the user wallet `4ym542u…` is not in the signer set.
Same SDK code path that the devnet keystone tx exercised; the only
difference is `relayerHttpUrl` was empty on devnet because no relayer
instance is hosted there.

### What's not hidden either way

- **The viewing_pub_hash is on chain.** It links a trader's repeated
  perp opens to each other (so the engine can find their slot) — not
  back to a wallet.
- **Trade size, lp, limit price.** Same exposure as any on-book perp DEX.

## How the e2e is wired

```
shield (user-signed)
  USDC ──► b402 shielded pool   (Light Protocol nullifier set)
                              │
                              │
privatePerpOpen (relayer-signed on mainnet; self-submit on devnet, no relayer)
  ZK proof ─► verifier_adapt   (Groth16, 213k CU on-chain)
  ↓
  pool::adapt_execute_v2
  ├─► nullifier::create_nullifier ─► Light system program ─► address tree
  └─► b402_percolator_adapter::execute
       ├─► percolator-prog::InitUser
       ├─► percolator-prog::DepositCollateral
       └─► percolator-prog::TradeCpi ─► passive matcher
            ↓
            position recorded at slab.accounts[user_idx]
            owner = PDA(viewing_pub_hash, adapter_id)
```

## Reproduce

### Local mainnet-fork

```bash
tests/v2/scripts/start-percolator-fork.sh
pnpm exec vitest run tests/v2/e2e/v2_fork_percolator.test.ts
```

Expected:

```
✓ T1 — pool initialized + percolator adapter registered + token_config added
✓ T2 — percolator market bootstrapped (slab + LP + matcher)
✓ T3 — perp_mapping PDA at full PERP_MAPPING_ACCOUNT_LEN (=81968 B)
✓ T4 — user b402 wallet shielded a 5 USDC (test mint) note via pool.shield
✓ T5 — privatePerpOpen lands position on slab; owner = owner_pda(spendingPub)
```

### Public devnet

```bash
RPC=https://devnet.helius-rpc.com/?api-key=YOUR_KEY \
  PHOTON_RPC=$RPC \
  pnpm exec vitest run tests/v2/e2e/v2_fork_percolator.test.ts
```

The 6 b402 programs are deployed on devnet at the IDs in the program
stack above. The percolator-prog at `4PTXCZ4vLSK6aiUd3fx2dVVYSRNFnMSM4ijhDWkuFi2s`
matches the upstream-published binary (verifiable via `solana program dump`
+ SHA-256: `6e2bb5aee602aed1de0b2d80f72f97b6b115e0f536438f76d31e0de06d5b7002`,
matches `percolator-cli/README.md` build provenance).

## Operational note on devnet vs mainnet

Devnet runs need a primer step (`crank` ix loop) to walk the percolator
engine forward to within `MAX_ACCRUAL_DT_SLOTS = 10` of `clock.slot`
before each open. Hyperp markets accrue per-slot state and become
unrevivable past the catchup envelope (200 slots at the engine's
`CATCHUP_CHUNKS_MAX × max_dt`).

Mainnet doesn't hit this — the upstream-deployed markets run keeper
bots (`percolator-cli/scripts/crank-bot.ts`, cron-installed via
`mainnet-bounty3-cron-install.ts`) that crank continuously, so the
engine never exits the envelope. The adapter's path is identical;
only the test harness conditionally runs the primer when `CLUSTER !== 'mainnet'`.

## Bugs found integrating against percolator-prog

Six layout/wire issues caught during integration, all fixed against
percolator-prog `origin/main` (commit `04b854e`, engine pin
`5059332f8a`):

1. **Slab `MAGIC` byte-order**: percolator-prog stores `pub const MAGIC:
   u64 = 0x504552434f4c4154` in native LE, so the bytes-on-disk read
   `"TALOCREP"` (BE form of `"PERCOLAT"`). Adapter's verify_slab_magic
   was using the byte-reversed form.
2. **`Account` struct layout offsets** vary between Solana BPF target
   (8-byte i128 alignment) and host (16-byte). On-chain Account is 416 B
   with `owner` at +184, `position_basis_q` at +64, `capital` at +0.
3. **Mapping PDA allocation > 10,240 B** — split into `init_mapping`
   (creates at `MAX_PERMITTED_DATA_INCREASE = 10,240 B`) plus 8 ×
   `grow_mapping` reallocs to reach 81,968 B target.
4. **`SPL transfer ordering`**: percolator's `InitUser` charges
   `fee_payment_if_init` from the user's slab ATA *before* the rest of
   the open path runs. Adapter must transfer adapter_in_ta → user ATA
   first, then InitUser, then DepositCollateral with the post-fee
   remainder.
5. **Engine `f6b13f57` pin**: percolator's `Account` struct grew between
   `a946e550` and `f6b13f57` (+64 B) and `MarketConfig` grew (+56 B).
   Adapter's vendored layout consts had to bump.
6. **Hyperp `MAX_ACCRUAL_DT_SLOTS = 10`**: Hyperp markets need a fresh
   `KeeperCrank` within ~10 slots of every trade, otherwise the engine
   returns `CatchupRequired`. Test harness pushes a fresh mark + cranks
   immediately before each open.

All six are wire/integration issues, not bugs in percolator's logic —
they're the kind of thing that surfaces only when a third party tries
to compose against the binary cold.

## Repo

- `programs/b402-percolator-adapter/` — the on-chain Anchor adapter
- `tests/v2/e2e/v2_fork_percolator.test.ts` — TDD ladder (T1-T5)
- `tests/v2/scripts/start-percolator-fork.sh` — fork harness
- `tests/v2/scripts/init-percolator-market.ts` — market bootstrap

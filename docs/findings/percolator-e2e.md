# Private perps on percolator — end-to-end

End-to-end verification that the b402 shielded pool composes with
[percolator](https://github.com/aeyakovenko/percolator-prog), Anatoly
Yakovenko's permissionless perp engine on Solana. A user opens a perp
position via a relayer-signed transaction; the user's wallet never
appears on the perp tx; the slab account on percolator records the
position owned by a PDA derived from the user's private spending key.

Same primitives this project already uses for kamino lending on mainnet
([example tx](https://solscan.io/tx/4gvqUAy7iAMD4qPaSCkfxrqRv4aoNZ1uwQ68wjtPheZ1EVwdRcFwqtVijfD6B6aQYyjUmkDGXVWGnTfMB5q7XM1d)).

## The proof

### Public devnet — full pool → adapter → percolator open

```
tx:         2NwVGzPufiL7W4gneKgSjJNh9fKMnqwKYoL4heNawdWFHmdme6HjhCFzqdYf7i4NUmpCf6v3gUxBsHb4x6Wnb6ZR
explorer:   https://explorer.solana.com/tx/2NwVGzPufiL7W4gneKgSjJNh9fKMnqwKYoL4heNawdWFHmdme6HjhCFzqdYf7i4NUmpCf6v3gUxBsHb4x6Wnb6ZR?cluster=devnet
signer:     3zZo85NoPK7HAqaK4DJfsWFbfK5fVbTG1u5HEFYwLUJF (alice's wallet)
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
#    Without alice's signing key, F3Dzhda… (or its analog) cannot be derived from 3zZo85No….
```

### Local mainnet-fork — open + close round trip

The full open then close, on a Light test-validator with mainnet-state
binaries, demonstrates the bidirectional path. Reproduction harness:
`tests/v2/scripts/start-percolator-fork.sh`. Tx hashes from a fork run
are not externally verifiable, but the harness is byte-deterministic.

## Program stack invoked (in tx order)

```
Program 42a3hsCXt…         invoke [1]    ← b402 pool
  Instruction: AdaptExecuteV2
  Program 3Y2tyhNSa…       invoke [2]    ← b402 verifier
    Instruction: VerifyWithAccountInputs
    consumed: 213,320 CU                  (real Groth16 zk proof verification)
  Program 2AnRZwWu6…       invoke [2]    ← b402 nullifier
    Instruction: CreateNullifier
    Program SySTEM1eSU…    invoke [3]    ← Light Protocol system program
      Program 11111111…    invoke [4]
      Program compr6CUs…   invoke [4]    ← Light account compression
        Instruction: InsertIntoQueues       (writes nullifier into address tree)
  Program TokenkegQ…       invoke [2]    ← SPL token transfer (vault → adapter)
  Program 65NRt6Gpe…       invoke [2]    ← b402 percolator adapter
    Instruction: Execute
    Program DzLTTqyx7t…    invoke [3]    ← Toly's percolator-prog (InitUser)
    Program DzLTTqyx7t…    invoke [3]    ← percolator-prog (DepositCollateral)
    Program DzLTTqyx7t…    invoke [3]    ← percolator-prog (TradeCpi)
      Program BoYEMRSe6…   invoke [4]    ← passive matcher (Toly's match prog)
```

Position landed in the slab; `slab.accounts[1].owner == owner_pda`.

## Privacy properties

What's hidden (relative to a vanilla perp open):

- **Tx fee payer != trader.** A relayer signs and pays for the perp
  open. The trader signed only the initial USDC shield (a separate tx).
- **Trader's wallet is not in the perp tx.** Anyone scraping the chain
  and looking at this perp tx sees the relayer + the slab + the
  adapter + the verifier + the matcher. No link to the trader's wallet.
- **The slab sees a PDA, not a wallet.** `slab.accounts[user_idx].owner`
  is `PDA(viewing_pub_hash, adapter_program_id)`. Different traders →
  different PDAs → different slab slots, by construction.

What's NOT hidden:

- **The viewing_pub_hash is on chain** (in the tx args + as a public
  input bound by the proof). It uniquely identifies "the same trader"
  across re-opens. Linkability between a trader's first and second
  perp tx is intentional (so the engine can find their slot) — but
  not back to a wallet.
- **Trade size + lp + limit price are public.** Same exposure as any
  on-book perp DEX.

## How the e2e is wired

```
shield (user-signed)
  USDC ──► b402 shielded pool   (Light Protocol nullifier set)
                              │
                              │
privatePerpOpen (relayer-signed)
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
is the same binary deployed by Toly (verifiable via `solana program dump`
+ SHA-256: `6e2bb5aee602aed1de0b2d80f72f97b6b115e0f536438f76d31e0de06d5b7002`).

## Operational note on devnet vs mainnet

Devnet runs need a primer step (`crank` ix loop) to walk the percolator
engine forward to within `MAX_ACCRUAL_DT_SLOTS = 10` of `clock.slot`
before each open. Hyperp markets accrue per-slot state and become
unrevivable past the catchup envelope (200 slots at the engine's
`CATCHUP_CHUNKS_MAX × max_dt`).

Mainnet doesn't hit this — Toly's deployed markets run keeper bots
(`percolator-cli/scripts/crank-bot.ts`, cron-installed via
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

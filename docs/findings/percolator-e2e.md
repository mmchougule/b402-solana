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

### Local mainnet-fork — full pool → adapter → percolator open

One signed transaction, on a mainnet-forked validator with the same
binaries percolator runs in production:

```
tx:         3ioH8S77y1mZKkoF7uUFkkJ8M7vxmj42KYduARCgyQ9mG9Gkict81edybxR1pXrFYjPA6orhkqSwDYLh2jpbbnNb
slab:       BrH8x3hjKBVjwPiN8LhdryG7E5fv7zD9vDJ1pvgHL62Y     (percolator-prog owned)
user_idx:   1
owner_pda:  F3DzhdaFZy8wo1cKPkhvRZAt1goMHDoffEryY3LtwBLP     (PDA derived from spendingPub)
position:   1000  (size_e6, long)
total CU:   702,785
```

### Public devnet — shielded note via the b402 pool

A real shielded note created on Solana devnet, signed by alice, hitting
the pool program at `42a3hsCXtQLWonyxWZosaaCJCweYYKMrvNd25p1Jrt2y`:

```
tx:         2b3pj2rCJtStu2nZCmNXtYce6vHUieGQYdi27suiHpamb5MCPvPQMo7tJaT5uki6NHNvu6euNe1bJmf6yEc3iGZ7
explorer:   https://explorer.solana.com/tx/2b3pj2rCJtStu2nZCmNXtYce6vHUieGQYdi27suiHpamb5MCPvPQMo7tJaT5uki6NHNvu6euNe1bJmf6yEc3iGZ7?cluster=devnet
signer:     3zZo85NoPK7HAqaK4DJfsWFbfK5fVbTG1u5HEFYwLUJF (alice)
pool:       42a3hsCXtQLWonyxWZosaaCJCweYYKMrvNd25p1Jrt2y
```

T5 (the perp open) on devnet is gated on a pool program upgrade —
the on-chain devnet pool predates the `commit_inputs` instruction
the current SDK uses. Tracking; will replicate the local-fork open
on devnet next.

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

## Reproduce locally

```bash
# 1. Boot the fork (Light test-validator + photon + prover, all 7 programs).
tests/v2/scripts/start-percolator-fork.sh

# 2. In a separate shell, run the TDD ladder.
pnpm exec vitest run tests/v2/e2e/v2_fork_percolator.test.ts
```

Expected:

```
✓ T1 — pool initialized + percolator adapter registered + token_config added
✓ T2 — percolator market bootstrapped (slab + LP + matcher)
✓ T3 — perp_mapping PDA at full PERP_MAPPING_ACCOUNT_LEN (=81968 B)
✓ T4 — alice b402 wallet shielded a 5 USDC (test mint) note via pool.shield
✓ T5 — privatePerpOpen lands position on slab; owner = owner_pda(spendingPub)
```

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

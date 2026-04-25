# PRD-10 — Drift Perps Adapter (private margin trading)

| Field | Value |
|---|---|
| **Status** | Draft — awaiting review |
| **Owner** | b402 core |
| **Date** | 2026-04-24 |
| **Version** | 0.1 |
| **Depends on** | PRD-03 §4.6, PRD-04 (adapter ABI), PRD-05 §3 (preliminary Drift sketch) |
| **Gates** | Drift adapter program implementation, SDK `privatePerpOpen` / `privatePerpClose` |
| **Supersedes** | PRD-05 §3 (this PRD is the canonical Drift spec; §3 there is preliminary) |

Phase 2a is live on devnet: `adapt_execute` proves and enforces `(adapter_id, action_hash, in_mint, out_mint, expected_out_value)` and the Jupiter adapter ships against the 6-account ABI from PRD-04 §2. This PRD specifies the **Drift v2 perps adapter** — the most provocative DeFi primitive on Solana to deliver privately, and architecturally the hardest to date because of margin-account ownership and funding-rate dynamics.

---

## §1. Goal

Allow a shielded user to open, manage, and close perpetual futures positions on Drift v2 from inside the b402 pool — such that on-chain observers cannot link a position's size, side, market, entry, or PnL to any Solana wallet. The headline use case is **size and direction privacy**: a 7-figure SOL-PERP long should not move SOL spot the way it currently does when whales front-run themselves on the orderbook. The second-order use case is **strategy privacy** for systematic traders — momentum bots, basis traders, funding-rate harvesters — who today leak their playbook to anyone who can group their orders by `User` pubkey on a Drift explorer.

Privacy is not absolute. Drift's matching engine sees fills; the orderbook sees the order. What's hidden is the *identity* behind the position: the same shielded user can open SOL-PERP long today and close it tomorrow without an observer being able to connect the two actions to one another or to a deposit/withdrawal address.

---

## §2. Protocol overview

### 2.1 Drift v2 program

- **Program ID:** `dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH`
- **IDL:** `@drift-labs/sdk` ships the canonical IDL; `drift-rs` mirrors it for Rust clients. We pin to a specific IDL hash at adapter build time.

### 2.2 Account types we touch

- `State` — global Drift state singleton. PDA: seeds `[b"drift_state"]`. Read-only from our perspective (rare).
- `User` — per-trader margin account. Holds collateral deposits, open positions, open orders, accrued funding. PDA: seeds `[b"user", authority_pubkey, sub_account_id_le]`. **This is the critical account; see §4.**
- `UserStats` — per-authority statistics (referrer, taker volume, etc.). PDA: seeds `[b"user_stats", authority_pubkey]`. One per authority, shared across sub-accounts.
- `PerpMarket` — per-market state (AMM, funding, oracle pointer). PDA: seeds `[b"perp_market", market_index_le]`.
- `SpotMarket` — per-collateral state (USDC, SOL, etc. as collateral). PDA: seeds `[b"spot_market", market_index_le]`. We need at least the USDC SpotMarket (index 0) for collateral deposits.
- `Oracle` — Pyth or Switchboard price account, referenced by `PerpMarket.amm.oracle`. **Adapter must forward the oracle account for every market touched.**

### 2.3 Cross-collateral margin

Drift uses cross-collateral margin: a single `User` account holds USDC (and other) collateral, and PnL on any perp settles in quote (USDC). This matters for our shielded-note bookkeeping (§10) — an open SOL-PERP long does not change the user's USDC collateral note immediately; collateral is only debited at settlement (loss) or credited at settlement (profit), with funding folded in.

### 2.4 Instructions we wrap (v1)

[verify exact instruction names against the pinned IDL hash; names below match `@drift-labs/sdk` 2.x]

- `initializeUser` and `initializeUserStats` — one-time per `User` PDA.
- `deposit` — deposit collateral (USDC) into a `User` account.
- `withdraw` — withdraw collateral from `User`.
- `placePerpOrder` — place a perp order (market or limit).
- `cancelOrder` — cancel an open order by `order_id`.
- `settlePnl` — realize unrealized PnL on a market into the User's USDC collateral.
- (`closePosition` is not a separate Drift ix; we model it as a reduce-only `placePerpOrder` matching the open size.)

---

## §3. Operations supported in v1

The Drift adapter's `execute(action_payload)` decodes a `DriftAction` enum (§6) and dispatches:

| Op | Purpose | In-mint | Out-mint | Notes |
|---|---|---|---|---|
| `DepositCollateral` | Pool USDC → User margin account | USDC | (none — see §10.2) | Increments collateral; no token returned to pool |
| `WithdrawCollateral` | User margin account → Pool | (none) | USDC | Decrements collateral; pool gets USDC |
| `PlacePerpOrder` | Open / increase / decrease a perp position | (none) | (none) | No token motion; mutates User state only |
| `CancelPerpOrder` | Cancel an open order | (none) | (none) | No token motion |
| `ClosePerpPosition` | Reduce-only market order, full size | (none) | (none) | No token motion until `SettlePerpPnl` |
| `SettlePerpPnl` | Realize PnL → collateral | (none) | (none for v1) | Updates collateral; pool sees no token motion |

Three of the six ops have no token-motion delta from the pool's standpoint. This breaks the assumption baked into PRD-03 §4.6 that `adapt_execute` always moves at least `expected_out_value` of `out_mint` into `out_vault`. The adapter ABI must support **delta-zero adapt actions** (§6.1).

### 3.1 Deferred to v2 / v3

- Spot orders (Drift's spot AMM, market index ≥ 0).
- Prediction markets (BET).
- TPSL, OracleOrder, advanced order types beyond market/limit.
- Insurance-fund private claims (post-liquidation, see §8).
- Cross-margin position migration / sub-account re-keying.
- Multi-collateral deposits (only USDC v1).

---

## §4. Margin account ownership — the central design question

Drift ties every position, order, and collateral entry to a `User` PDA derived from an `authority` pubkey + `sub_account_id`. Two coherent paths exist; choosing wrong commits us to either a fund (Path A) or a non-trivial circuit change (Path B). This section presents both, then takes a position.

### 4.1 Path A — single shared `User` PDA per market

The adapter's `adapter_authority` PDA is the `authority` on a single `User` (e.g. `sub_account_id = 0`). All shielded users' collateral aggregates into this one Drift account.

**Pros:**
- Implementation simplicity. One-time `initializeUser` at adapter deployment.
- Cross-margin happens implicitly — the pool benefits from Drift's own cross-collateral mechanics across all users.
- No additional circuit binding required beyond the existing `(adapter_id, action_hash, expected_out)` triple.
- Smaller account footprint per `adapt_execute` tx (one `User` account, not a per-user PDA).

**Cons (severe):**
- **One user's loss eats every user's collateral.** A shielded user opens a 50× SOL-PERP long, gets liquidated below maintenance, and the Drift `User` account's collateral is decremented by their liquidation. Every other shielded user's claim on collateral is now diluted.
- **PnL attribution depends entirely on adapter-internal off-chain bookkeeping.** The adapter must remember "user X's deposit was 1000 USDC, their PnL on position Y is +37 USDC" via something it stores. Either an on-chain registry (defeats privacy — observers see the registry growing) or an off-chain ledger (defeats trustlessness).
- Effectively turns the adapter into a fund. Regulatory + custodial implications we do not want.

This is what PRD-05 §3.4 sketched as option (b) and called "shared adapter-PDA Drift account." That sketch is hereby superseded — PRD-05 was incomplete on the loss-dilution problem.

### 4.2 Path B — per-user `User` PDA derived from a viewing-key hash

Each shielded user gets a deterministic `User` PDA at:

```
seeds = [b"b402/v1", b"drift_user", viewing_pub_hash[..32]]
authority = adapter_authority (PDA)
sub_account_id = 0
```

where `viewing_pub_hash = Poseidon(viewingPub_x, viewingPub_y)` truncated/serialized to 32 bytes. The authority on the Drift `User` is still the adapter's PDA (so the adapter can sign for deposits/withdrawals/orders), but the `User` PDA itself is unique to the shielded recipient.

**Pros:**
- Per-user collateral and per-user PnL. Liquidation of user X never touches user Y's collateral.
- The PDA derivation is one-way: an observer sees `User` PDAs being created and used, but cannot map them back to a shielded user without the viewing key. Statistically, the privacy set is the set of all b402-Drift users, not the set of one Drift account.
- The adapter is non-custodial in the meaningful sense — each user's funds are isolated at the Drift account level.

**Cons:**
- Each new shielded user pays Drift's `User` rent (~0.035 SOL at current rent-exempt minimum [verify against current `User` account size in Drift IDL]). Relayer covers this and reimburses via the in-mint fee, like every other adapt cost.
- Larger per-tx account footprint. ALT use is mandatory (see §5.4).
- **Circuit must bind the `User` PDA to the shielded note.** Otherwise relayer could route user X's deposit to user Y's `User` PDA. See §4.4.

### 4.3 Decision: Path B

We pick **Path B**. Loss isolation is a non-negotiable property for a permissionless system; without it, any single retail user's blowup is a pool-wide event, and we cannot in good conscience ship that. The cost (one-time rent per user, additional circuit binding) is bounded and well-understood. Path A's fund-shape implications are not.

### 4.4 Circuit binding for `User` PDA

The Phase 2a `b402_verifier_adapt` circuit publicizes `(adapter_id, action_hash, in_mint, out_mint, expected_out_value, ...)`. For Drift, we extend the circuit's public signals with one additional field:

```
drift_user_binding = Poseidon_2(driftUserBindTag, viewing_pub_hash_Fr)
```

where `driftUserBindTag = keccak256("b402/v1/drift_user/v1")` reduced mod p. The on-chain handler:

1. Recomputes `viewing_pub_hash` from the spent note's `viewingPub` (already available in proof-context).
2. Recomputes `drift_user_binding` and asserts it matches the proof's public signal.
3. Recomputes the expected `User` PDA from `(b"b402/v1", b"drift_user", viewing_pub_hash)` and asserts the `User` account passed in `remaining_accounts` matches.

This makes it impossible for a relayer to swap in a different `User` PDA — the circuit ties the action to the spending key's viewing pubkey, and the handler ties the viewing pubkey to a unique `User` PDA. Cost: ~30 additional circom constraints (one Poseidon call), negligible.

This circuit field is **only set for adapters that opt in**. The adapter registry entry gains a `requires_user_binding: bool` flag; pool's handler reads the flag and conditionally validates the binding. Jupiter and Kamino do not set it.

---

## §5. Account layout per operation

This section gives the exact accounts the adapter forwards to Drift via CPI. Pool always passes the 6 ABI-fixed accounts (PRD-04 §2) plus `remaining_accounts`. Drift account layouts below are **forwarded** — pool does not parse them.

### 5.1 `DepositCollateral`

CPI target: `Drift.deposit(market_index = 0, amount, reduce_only = false)`.

`remaining_accounts`:
1. Drift program (`dRiftyHA...`)
2. `State` PDA
3. `User` PDA (per §4.4 binding)
4. `UserStats` PDA
5. `authority` (= `adapter_authority`, signer)
6. USDC `SpotMarket` PDA (market index 0)
7. USDC `SpotMarket` vault (Drift-owned token account)
8. Source token account (= `adapter_in_ta`)
9. Token program
10. Pyth oracle for USDC SpotMarket [verify: USDC SpotMarket may use a stub oracle]

Account count: ~10 forwarded + 6 ABI fixed = **~16 total**. Comfortably under ALT threshold.

### 5.2 `WithdrawCollateral`

CPI target: `Drift.withdraw(market_index = 0, amount, reduce_only = false)`.

`remaining_accounts` mirrors §5.1, with destination = `adapter_out_ta` and the adapter then forwarding `adapter_out_ta` → `out_vault`. Drift may require additional perp-market oracles in remaining_accounts if the user has open perp positions (Drift recomputes margin requirement on withdraw). Adapter must forward all `PerpMarket` and `Oracle` accounts for any market the User has a position in.

Worst-case (user with positions in 3 perp markets): ~10 base + 6 (3 markets × 2 accounts) = **~16 forwarded + 6 fixed = 22**.

### 5.3 `PlacePerpOrder`

CPI target: `Drift.placePerpOrder(OrderParams)`.

`remaining_accounts`:
1. Drift program
2. `State` PDA
3. `User` PDA
4. `UserStats` PDA (read-only here)
5. `authority` (signer)
6. Target `PerpMarket` PDA
7. Target `PerpMarket` oracle (Pyth)
8–N. Every `PerpMarket` and `SpotMarket` (and their oracles) for which the user has an open position or collateral, because Drift recomputes total margin on every order. [verify: Drift's `place_perp_order` documents the exact remaining_accounts requirement against the IDL.]

Worst case: a user with collateral in 1 spot market (USDC) and positions in 3 perp markets, opening a 4th position: 6 base accounts + 4 spot-related (1 spot market + vault + oracle + meta) + 8 perp-related (4 markets × 2) = **~18 forwarded + 6 fixed = 24**.

### 5.4 Tx-size pressure and ALT

Drift's `placePerpOrder` with all required accounts for a user holding positions in 3+ markets pushes the raw account list past 24 entries. Combined with the b402 pool's 6 ABI-fixed accounts plus circuit public signals (~600 B in instruction data), we are within 100 B of the 1232 B tx limit before any ALT.

**ALTs are not optional for Drift**. The b402-owned ALT (PRD-04 §5.2) must include:
- Drift program ID
- Drift `State` PDA
- All `PerpMarket` PDAs we support at launch (SOL-PERP, BTC-PERP, ETH-PERP at minimum)
- All `SpotMarket` PDAs we support (USDC at launch)
- The oracle accounts those markets reference
- The Drift token-vault PDAs

With ALT: a 4-position `placePerpOrder` collapses to ~6 dynamic accounts + ALT-resolved entries, fitting in ~900 B total. Comfortable.

If a user accumulates positions in more markets than fit in one tx even with ALT, they must `settlePerpPnl` and close some positions before opening new ones. The SDK enforces this at quote-build time.

### 5.5 `CancelPerpOrder`, `ClosePerpPosition`, `SettlePerpPnl`

- `CancelPerpOrder` accounts mirror `PlacePerpOrder` minus the order params. ~12 forwarded.
- `ClosePerpPosition` is a reduce-only `placePerpOrder` at oracle ± `slippage_bps`; same accounts as §5.3.
- `SettlePerpPnl` requires the target `PerpMarket` + its oracle + the USDC `SpotMarket` + its vault. ~10 forwarded.

---

## §6. Action payload format

`action_payload: Vec<u8>` is Borsh-encoded:

```rust
pub enum DriftAction {
    DepositCollateral {
        market_index: u16,        // SpotMarket index; 0 for USDC v1
        amount: u64,              // base units of in_mint
    },
    WithdrawCollateral {
        market_index: u16,
        amount: u64,
    },
    PlacePerpOrder {
        market_index: u16,        // PerpMarket index; SOL-PERP=0, BTC-PERP=1, ETH-PERP=2 [verify]
        direction: u8,            // 0=long, 1=short
        order_type: u8,           // 0=market, 1=limit
        base_amount: u64,         // base-asset units (perp size)
        price: u64,               // limit price (Drift PRICE_PRECISION); 0 for market
        reduce_only: bool,
        slippage_bps: u16,        // adapter-enforced floor/ceiling at oracle ± bps
        health_factor_floor_bps: u16,  // §8.2; 0 to disable
    },
    CancelPerpOrder {
        order_id: u32,
    },
    ClosePerpPosition {
        market_index: u16,
        slippage_bps: u16,
    },
    SettlePerpPnl {
        market_index: u16,
    },
}
```

`action_hash` = `Poseidon_2(adaptBindTag, keccak256(action_payload), expectedOutMint_Fr)` per PRD-04 §2.1. The Drift adapter inherits this.

### 6.1 `expected_out_mint` and `expected_out_value` per op

Phase 2a's `adapt_execute` requires non-zero `out_vault` delta ≥ `expected_out_value`. Three of six Drift ops have zero token motion. We resolve this by:

1. The pool's handler treats `expected_out_mint = Pubkey::default()` as the "delta-zero" sentinel. When set, the post-CPI balance check is skipped and `expected_out_value` must be 0. This is a small extension to PRD-03 §4.6's handler logic.
2. Adapter registry gains an `allows_delta_zero: bool` flag. Set true for Drift, false for Jupiter/Kamino. Pool rejects delta-zero adapts against adapters that don't allow them.

Per-op assignment:

| Op | `expected_out_mint` | `expected_out_value` | Notes |
|---|---|---|---|
| `DepositCollateral` | default (zero) | 0 | Pool sends USDC → adapter → Drift; no return |
| `WithdrawCollateral` | USDC | requested amount minus fee buffer | Pool gets USDC back |
| `PlacePerpOrder` | default | 0 | No token motion |
| `CancelPerpOrder` | default | 0 | No token motion |
| `ClosePerpPosition` | default | 0 | PnL not realized until `SettlePerpPnl` |
| `SettlePerpPnl` | default | 0 (v1) | PnL lands in collateral, not in pool. See §10. |

### 6.2 `expected_in_mint` for ops that send to Drift

`DepositCollateral` consumes a USDC note. `expected_in_mint = USDC`. All other ops consume **a zero-value placeholder note** spent purely to authorize the action. The placeholder note construct is already used by PRD-02's transact circuit for self-spends; we reuse it.

This is the design's asymmetry: Drift ops are *authorizations*, not *transfers*, for everything except deposit/withdraw. The shielded-note layer expresses the authorization by spending a tiny note bound to the user's spending key, with the note's binding to the action via `action_hash`.

---

## §7. Funding rate handling

Drift charges or credits funding hourly on every open perp position. Funding accrues to the position itself (as a delta to the position's PnL); it does not move tokens until settlement.

For shielded positions:

1. Funding accrues **on the per-user `User` PDA's position state**, untouched by the pool.
2. When the user calls `SettlePerpPnl`, Drift folds accumulated funding into realized PnL and writes the net delta to the user's collateral balance on the `User` account.
3. The pool sees no token motion at this step (v1: `expected_out_value = 0`). The user's "collateral" in shielded form is logically updated by the SDK, which queries the Drift `User` account at settlement time and re-derives the user's post-settlement collateral note.

Implication: **funding is a silent debit/credit at the Drift level**, surfaced to the user only when they next `SettlePerpPnl` or `WithdrawCollateral`. The shielded note for collateral is regenerated at withdrawal time, not continuously. This is a UX limitation, not a security issue — the user always sees current state via SDK reads against their `User` PDA, gated by their viewing key.

---

## §8. Liquidation risk separation

This is the most consequential section after §4.

### 8.1 Liquidation is user-protective, not pool-protective

In Path B (chosen), each user owns their own `User` PDA. Drift liquidates the position if maintenance margin is breached. Liquidators (anyone) call Drift's `liquidatePerp` against the specific `User` PDA. The user loses their collateral up to the liquidation amount; the b402 pool is unaffected — `out_vault` and `in_vault` are not touched, no other user's `User` PDA is touched.

The shielded note representing collateral becomes, post-liquidation, a claim on a `User` PDA whose collateral has been decremented (or zeroed). The SDK reflects this when the user next attempts `WithdrawCollateral`: the recoverable amount equals what's actually in the `User` PDA.

### 8.2 Health monitoring is the user's problem

A shielded user cannot poll a public dashboard for "my position's health" because there is no public mapping from their wallet to their `User` PDA. They must:

- Run the SDK locally with their viewing key, which derives their `User` PDA and queries Drift's read-only state. SDK exposes `getHealthFactor(viewingKey)`.
- Or pre-commit at order time to a health-factor floor (see §8.3).

External liquidator bots, though, have no privacy advantage — they scan all `User` PDAs derived from `(b"b402/v1", b"drift_user", *)` (the seed prefix is public; the hash bytes are not invertible but the PDAs are walkable as Drift indexes them) and liquidate any below maintenance. This is fine for solvency but means **shielded users get liquidated as fast as any Drift user**.

### 8.3 `health_factor_floor_bps` guardrail in `PlacePerpOrder`

The payload (§6) carries an optional `health_factor_floor_bps`. The adapter, before the Drift CPI, computes the user's health factor that *would result from filling this order at the slippage-bound worst price*, and aborts if it falls below the floor. Mechanism:

1. Adapter reads the user's `User` PDA + relevant `PerpMarket` + oracle account (already in `remaining_accounts`).
2. Adapter calls a Drift view function (or replicates the calculation — Drift's margin-calc is documented in `drift-rs::math::margin`).
3. If projected health < `health_factor_floor_bps`, fail with `HealthFactorFloorBreached`.

This is an order-time guardrail, not a continuous one. Funding rates and oracle moves can still liquidate the user later. But it prevents the foot-gun of "I clicked 50× and got liquidated on the entry candle."

`health_factor_floor_bps = 0` disables the check (default for power users / bots that manage their own risk).

### 8.4 Private bankruptcy claim — v3 placeholder

If a user is liquidated and Drift's insurance fund has a payout owed (bankruptcy edge cases), the user holds a claim on the insurance fund. Surfacing this privately requires:

- A circuit that proves "I am the owner of `User` PDA X (via viewing key), and Drift's state shows X has an outstanding insurance-fund claim of amount Y."
- An adapter op `ClaimInsuranceFundPayout` that consumes the proof and routes the payout to a fresh shielded note.

This is complex and rare. We spec only the **placeholder hook**: the adapter program reserves a `DriftAction::ClaimInsuranceFund { ... }` discriminator (unimplemented in v1, returns `NotImplemented`). v3 fills it in.

---

## §9. Oracle dependencies

Drift relies on Pyth (primary) and Switchboard (fallback) for every perp market. The oracle account is referenced by `PerpMarket.amm.oracle` and `SpotMarket.oracle`.

### 9.1 Required oracle accounts per op

- `DepositCollateral` / `WithdrawCollateral`: USDC SpotMarket oracle (often a stub returning 1.0; still required by Drift's IDL [verify]).
- `PlacePerpOrder`, `ClosePerpPosition`, `SettlePerpPnl`: target `PerpMarket` oracle, plus oracles for every other market in which the user has a position or collateral (Drift recomputes total margin on every order).
- `CancelPerpOrder`: same as `PlacePerpOrder` (Drift validates margin even on cancel because cancel can free collateral).

The adapter does not parse oracle accounts; it forwards them and lets Drift's CPI handler validate freshness.

### 9.2 Stale-price handling

Drift internally rejects stale prices (configurable `oracle_max_staleness_slots` per market). If the oracle is stale, Drift's CPI returns `Err`; the adapter CPI returns `Err`; the pool reverts the whole `adapt_execute`. No partial state.

The adapter does **not** re-validate staleness on its own. Trusting Drift's check avoids duplication and avoids divergence if Drift updates its staleness rules.

### 9.3 Circuit binding for oracle prices — explicitly out of scope for v1

Should the circuit prove anything about the oracle price at order time (e.g., "I am committing to open at price ≤ P")? No. Reasons:

1. The oracle price is mutable between proof generation and tx submission.
2. Slippage bound (`slippage_bps` in payload) handles the same concern at the handler level — the adapter checks `oracle_price * (1 ± slippage_bps)` against the order's effective price.
3. Adding a price commitment to the circuit's public signals would require re-proving on every quote refresh, blowing UX.

If a future version wants tighter oracle-price binding, it goes in v2.

---

## §10. PnL settlement and shielded-note accounting

This is where the cross-collateral model meets the UTXO model. Care required.

### 10.1 The base case: `WithdrawCollateral` after a profitable trade

1. User opens long, closes long, `settlePerpPnl` — collateral on `User` PDA is now `initial + realized_pnl + funding_net`.
2. User calls `WithdrawCollateral { amount: X }`.
3. Drift moves X USDC from `User` PDA → `adapter_in_ta` → adapter forwards to `out_vault`.
4. Pool's post-CPI balance check confirms `out_vault.amount ≥ pre_balance_out + expected_out_value` where `expected_out_value = X` minus relayer-fee buffer.
5. Pool appends a new shielded note to the user's spending key with value X. The user's prior collateral note (a zero-value placeholder spent to authorize) is nullified. Net: user has a new USDC shielded note worth X.

The delta-invariant proves the gain — the pool sees X USDC arrive in `out_vault`, regardless of whether X reflects original deposit, profit, or both. The shielded layer doesn't track "principal vs. profit"; it tracks total claimed.

### 10.2 The harder case: post-settlement, pre-withdrawal

Between `SettlePerpPnl` and the next `WithdrawCollateral`, the user's "true" collateral on the `User` PDA differs from what any shielded note represents. There is no shielded note in flight — the user's authority on the `User` PDA is via viewing-key-derived PDA, and the SDK reconstructs the user's collateral by reading the `User` PDA directly.

This is fine. The shielded note layer represents **claims to withdraw**, not **continuously-marked positions**. The user's wallet UI shows:

- Shielded balances (notes): X SOL, Y USDC.
- Drift positions (read from `User` PDA via SDK): SOL-PERP +0.5 size, $1234 collateral, $23 unrealized PnL.

These are two views into two different ledgers. `WithdrawCollateral` is the bridge.

### 10.3 The loss case

User opens long, market drops, `settlePerpPnl` debits collateral. `WithdrawCollateral` returns whatever's left. If collateral is zero (full liquidation), `WithdrawCollateral` reverts at Drift's check; the user has no claim and no shielded note is created. The shielded layer represents this naturally — there's nothing to spend.

### 10.4 Note-binding to `User` PDA

When a user spends a shielded note to authorize a Drift op that doesn't move tokens (like `PlacePerpOrder`), the note must be bound to the specific `User` PDA the action targets. Otherwise relayer could substitute a different `User` PDA.

Mechanism: the shielded note that authorizes a Drift action carries a `bound_user_pda` field in its plaintext (encrypted under the viewing key, hashed into the note commitment). The transact circuit (PRD-02) is extended for adapter-spends to expose this binding as a public input, which the adapter handler verifies against the actual `User` PDA in `remaining_accounts`.

[verify against PRD-02 §X — may require an amendment if the existing transact circuit doesn't already expose adapter-bound auxiliary fields. If it doesn't, this is a circuit change of similar scope to §4.4's `drift_user_binding` and may be folded into the same circuit revision.]

### 10.5 SettlePerpPnl realizing into a shielded note (v2)

v1 `SettlePerpPnl` is delta-zero: it updates the `User` PDA collateral but does not move tokens to `out_vault`. v2 may extend this to **immediately mint a shielded "PnL note"** representing the realized PnL, eliminating the need for a separate `WithdrawCollateral`. This requires:

- A circuit that proves "the prior shielded position commitment + this PnL value = post-settlement state."
- A more invasive interaction between the adapter and the pool's tree-append logic.

Out of scope for v1. v1 ships the simpler `SettlePerpPnl` → `WithdrawCollateral` two-step.

---

## §11. Circuit binding summary

The Phase 2a `b402_verifier_adapt` circuit needs the following extensions to support Drift (all conditional on the adapter registry's `requires_user_binding` and `requires_action_aux_binding` flags):

| Public signal | Source | Used by |
|---|---|---|
| `drift_user_binding` | `Poseidon(driftUserBindTag, viewing_pub_hash)` | Path B `User` PDA derivation (§4.4) |
| `note_aux_binding` | Note plaintext's `bound_user_pda` field, hashed | Note → `User` PDA binding (§10.4) |

Constraint cost: ~60 additional circom constraints total (two Poseidon calls). Negligible relative to the ~150k-constraint adapt circuit.

The handler logic gain: ~30 LoC of additional checks in the `adapt_execute` handler, gated by the registry flags.

---

## §12. Test strategy

Mirror `examples/swap-e2e-jupiter.ts`'s pattern: a mainnet-fork local validator with Drift v2 program cloned, plus the required oracle accounts (Pyth SOL/USD, BTC/USD, ETH/USD) cloned, plus the canonical USDC mint and a few funded wallets.

### 12.1 Fork setup

- `solana-test-validator` with `--clone dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH`, the Drift `State` PDA, the SOL-PERP `PerpMarket` PDA, USDC `SpotMarket` PDA, and the relevant Pyth oracle accounts.
- Fork from a recent mainnet slot to capture realistic AMM state.

### 12.2 Required E2E tests

1. **Happy path (gain).** Shield 100 USDC → `DepositCollateral` 100 USDC → `PlacePerpOrder` 1× SOL-PERP long, market — wait — `ClosePerpPosition` — `SettlePerpPnl` — `WithdrawCollateral` → unshield. Assert PnL realized correctly, no on-chain link between deposit and withdrawal addresses.
2. **Happy path (loss).** Same flow, opposite side, mock-oracle-move adversely. Assert collateral decremented at settlement, withdrawal returns reduced amount.
3. **Liquidation.** Open 50× position; manually advance oracle past liquidation threshold; trigger liquidation via a separate signer simulating an external liquidator. Assert user's `User` PDA collateral is zeroed, other test users' `User` PDAs are unaffected (Path B isolation).
4. **Cancel.** `PlacePerpOrder` (limit, far from oracle) → `CancelPerpOrder` → assert `User` PDA has no open orders.
5. **Health-factor floor.** `PlacePerpOrder` with `health_factor_floor_bps` set high enough to fail; assert revert with `HealthFactorFloorBreached`.
6. **Funding accrual.** Open position, advance time enough for funding to accrue [verify: Drift's funding update cadence on a fork may need explicit advance], settle, assert collateral reflects funding delta.
7. **Privacy invariant.** Run two independent shielded users through (1) and (3) on the same fork; assert their `User` PDAs are distinct and that no on-chain account other than the b402 pool itself sees both users' authority pubkeys.
8. **Nullifier accounting.** Run (1) twice with the same shielded note; second attempt must fail with `NullifierAlreadySpent`.

### 12.3 Property tests

- Adapter ABI conformance: random `action_payload` bytes that decode to invalid `DriftAction` must return a clean error, not panic.
- Slippage: `slippage_bps` boundary cases (0, max). Order at exact bound succeeds; order one bp beyond fails.

---

## §13. Effort estimate

| Component | Estimate |
|---|---|
| Adapter Anchor program (~400–500 LoC) | 4–6 days |
| Per-user `User` PDA wiring + initialization flow | 1–2 days |
| Circuit additions (`drift_user_binding`, `note_aux_binding`) + Rust parity tests | 2–3 days |
| Pool handler extensions (delta-zero, registry flags, conditional circuit checks) | 2 days |
| E2E tests against mainnet-fork validator | 2–3 days |
| SDK additions (`privatePerpOpen`, `privatePerpClose`, `privateCollateralWithdraw`, health-factor read) | 2–3 days |
| Example script (`examples/perp-e2e-drift.ts`) | 1 day |
| **Total** | **2–3 weeks** |

This is tighter than Jupiter (~1 week) and Kamino (~1.5 weeks) because tx-size pressure forces ALT engineering and because the per-user PDA design touches both the program and the circuit.

---

## §14. Deferred to v2 / v3

- **v2:**
  - Spot orders.
  - `SettlePerpPnl` realizing directly into a shielded PnL note (eliminates the separate `WithdrawCollateral` step).
  - TPSL, OracleOrder, and other advanced order types.
  - Multi-collateral deposits (SOL, mSOL, JitoSOL alongside USDC).
- **v3:**
  - Private bankruptcy / insurance-fund payout claims (§8.4).
  - Cross-margin sub-account migration.
  - Drift Vaults (delegated strategy vaults) integration.
  - Prediction markets (Drift BET).

---

## §15. Open questions

1. **`User` rent reimbursement model.** Path B requires ~0.035 SOL of rent per user. Relayer pays it; users reimburse via the in-mint fee on first deposit. Confirm fee math holds at small deposit sizes (e.g., a $10 deposit shouldn't be priced out by rent reimbursement). [verify exact rent at Drift's current `User` account size]
2. **`UserStats` PDA reuse.** `UserStats` is derived from `authority` only, not `sub_account_id`. With Path B, every shielded user has the same `authority` (the adapter PDA), so they all share one `UserStats`. This matters because `UserStats` accrues taker volume and referrer rebates — those will pool across all b402 users. Acceptable; aligns with shared-authority model. Confirm this doesn't break Drift's invariants. [verify via Drift IDL — `UserStats` is normally one per authority across sub-accounts]
3. **Sub-account exhaustion.** Drift caps sub-accounts per authority at 8 [verify]. Path B uses sub-account 0 always (PDA differentiation comes from the seed, not the sub-account ID). Confirm Drift accepts arbitrarily many `User` PDAs under one authority pubkey when each has sub-account 0.
4. **Circuit revision packaging.** §4.4 and §10.4 both add public signals. Are they shipped as one circuit upgrade or two? Recommend one — single trusted-setup contribution, single audit cycle.
5. **Devnet Drift availability.** Drift v2 is deployed on devnet but with limited markets and shallow oracle freshness guarantees. Confirm devnet rehearsal path; mainnet-fork tests are the real validation.

---

## §16. Per-adapter review checklist (per PRD-04 §11)

| Item | Drift |
|---|---|
| Downstream program pinned | `dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH` |
| IDL pinned by hash | TBD at impl time |
| Out-mint can differ from promised? | No — handler enforces `expected_out_mint` per op (§6.1) |
| Delta-zero ops allowed? | Yes — registry flag `allows_delta_zero = true` |
| Oracle dependency | Pyth (mandatory); Switchboard fallback per Drift's config |
| Per-user PDA required? | Yes — registry flag `requires_user_binding = true` |
| Note-aux binding required? | Yes — registry flag `requires_action_aux_binding = true` |
| Account count worst case | ~24 with 4 open positions; mitigated by ALT |
| CU worst case | ~850k (place_perp_order with full margin recompute) |
| Upgrade cadence (external) | ~monthly (Drift) |
| Rent burden | ~0.035 SOL per new shielded user (one-time) |
| Reviewed by | |
| Audit status | |

---

## §17. Drift-specific gotchas

These are non-obvious points worth surfacing for the implementer:

1. **Drift's `place_perp_order` requires every `PerpMarket` and `SpotMarket` (and oracle) for which the user has exposure** — not just the one being traded. Margin is recomputed globally. Misreading the IDL here costs days of debugging.
2. **`UserStats` is shared across sub-accounts of the same authority.** With Path B's shared authority, all b402 users will appear as one entity to `UserStats`-derived metrics (referrer rebates, taker volume tiers). Not a privacy issue (the metrics belong to a meaningless adapter PDA) but worth documenting.
3. **Drift's funding rate updates are not on a fixed schedule** — they're triggered lazily by the next interaction with the market. A position held alone for an hour with no other interaction will see funding applied at the next order; integrating this into shielded-note bookkeeping requires reading the `User` PDA fresh, not assuming a clock.
4. **Drift's `withdraw` fails if it would breach maintenance margin.** Users can be unable to withdraw collateral they "logically" own because of an open position. SDK must surface this; adapter does not pre-check (Drift's check is authoritative).
5. **`oracleMaxStalenessSlots` varies per market.** A market with low liquidity may have stricter staleness rules than SOL-PERP. Adapter does not normalize; we let Drift error.
6. **Reduce-only orders can fail if the position is already zero by the time the order fills.** Race condition: `ClosePerpPosition` after another op already closed the position. Handler returns Drift's error; the adapt reverts. Surface via SDK as "position already closed."

---

## §18. Revision history

| Version | Date | Author | Changes |
|---|---|---|---|
| 0.1 | 2026-04-24 | b402 core | Initial draft. Supersedes PRD-05 §3. |

---

## §19. Sign-off

| Role | Name | Date | Status |
|---|---|---|---|
| Solana/Anchor review | | | |
| Circuit review (Path B binding, note-aux) | | | |
| Drift integration review | | | |
| Protocol lead | | | |
| Final approval | | | |

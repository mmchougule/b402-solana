# PRD-05 — DeFi Adapters (Jupiter, Kamino, Drift, Orca)

| Field | Value |
|---|---|
| **Status** | Draft — awaiting review |
| **Owner** | b402 core |
| **Date** | 2026-04-23 |
| **Version** | 0.1 |
| **Depends on** | PRD-04 |
| **Gates** | Adapter implementation |

Per-adapter specifications. Each conforms to the adapter ABI in PRD-04 §2. Addresses and account layouts are mainnet-accurate as of the document date; any drift is caught by the CI integration test suite running against mainnet forks.

All adapters live in the `b402_adapters` workspace, but each is a **separate on-chain program**, independently deployed and upgradable. This bounds blast radius.

---

## 1. Jupiter — DEX swap aggregator

### 1.1 Rationale

Jupiter routes ~95% of Solana DEX volume. Integrating Jupiter gives access to Orca, Raydium, Meteora, Phoenix, and every other venue without per-venue adapters. Kamino already uses Jupiter Swap API internally.

### 1.2 On-chain programs used

- **Jupiter V6 program ID:** `JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4`
- **Jupiter's `route` instruction** — performs the multi-hop swap defined by the quote response.

### 1.3 Adapter payload

```rust
pub struct JupiterAdaptPayload {
    pub in_mint: Pubkey,
    pub out_mint: Pubkey,
    pub in_amount: u64,
    pub minimum_out_amount: u64,        // redundant with circuit but explicit
    pub route_plan: Vec<RouteStep>,     // from Jupiter quote API response
    pub platform_fee_bps: u8,           // always 0 — b402 does not take Jupiter platform fee
}
```

### 1.4 Accounts required (passed through)

Standard Jupiter V6 `route` accounts:
- Jupiter program
- User token accounts (= adapter's `adapter_in_ta` / `adapter_out_ta`)
- User transfer authority (= adapter PDA)
- Per-DEX-hop accounts (variable; Jupiter API returns them)

Lookup tables critical: a typical 3-hop Jupiter route uses ~25 accounts → requires our ALT (PRD-04 §5.2) + Jupiter's own ALTs.

### 1.5 Flow

```
1. Pool transfers in_amount of in_mint → adapter_in_ta.
2. Adapter CPIs Jupiter route with:
   - source = adapter_in_ta
   - destination = adapter_out_ta
   - transfer_authority = adapter_pda
   - route_plan opaque
3. Post-route: adapter transfers adapter_out_ta balance → out_vault (pool's).
4. Return Ok.
5. Pool verifies out_vault balance ≥ pre_balance_out + expected_out_value.
```

### 1.6 Slippage

Two-layer slippage bound:
- Adapter's `minimum_out_amount` passed to Jupiter — Jupiter enforces.
- Circuit's `expected_out_value` — pool enforces post-CPI.

Set `minimum_out_amount = expected_out_value` for defense-in-depth.

### 1.7 CU estimate

- Jupiter route 2-hop: ~400k CU.
- Jupiter route 3-hop: ~600k CU.
- Adapter overhead: ~30k.
- Pool verify + state: ~250k.
- Total 2-hop adapt_execute: ~680k. Fits in 1.4M with headroom.

### 1.8 Edge cases

- **Route becomes invalid between quote and submission.** Jupiter quotes expire; if the CPI fails, pool reverts. SDK fetches fresh quote each time.
- **Mid-tx price change.** Covered by slippage bounds.
- **Jupiter program paused.** Adapter CPI fails; pool reverts. Users unaffected except for the failed attempt.

### 1.9 Security invariants

- Adapter never transfers to anything other than `adapter_out_ta` or `out_vault`.
- Route plan accounts are whitelisted to Jupiter-known programs via a registry check (v2; v1 relies on Jupiter returning safe plans).

---

## 2. Kamino — lending vault deposit/withdraw

### 2.1 Rationale

Kamino is the largest lending protocol on Solana with concentrated CLMM + vault products. Kamino Liquid Vaults accept USDC and return vault shares accruing yield. This is Solana's analog to Morpho vaults on EVM (which b402-sdk uses for `privateLend`).

### 2.2 On-chain programs used

- **Kamino Lend program:** `KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD`
- **Kamino Vault program:** `KVauNgLDJh45thcJCkhAdUYkfBp4TEQJqJX8LkXHt4a` (subject to verification pre-launch)
- Instructions: `deposit_reserve_liquidity`, `redeem_reserve_collateral`.

### 2.3 Adapter payload

```rust
pub struct KaminoAdaptPayload {
    pub action: KaminoAction,           // Deposit | Withdraw
    pub market: Pubkey,                 // e.g., Kamino Main Market
    pub reserve: Pubkey,                // USDC reserve
    pub amount: u64,
    pub minimum_out: u64,               // share amount for deposit; USDC amount for withdraw
}

pub enum KaminoAction { Deposit, Withdraw }
```

### 2.4 Accounts

- Kamino market state
- Kamino reserve state
- Reserve liquidity supply (SPL token account)
- Reserve collateral mint (cToken mint)
- User's liquidity account (= adapter_in_ta)
- User's collateral account (= adapter_out_ta, holds cTokens)
- Pool's out_vault = cToken account

### 2.5 Flow (Deposit)

```
1. Pool transfers USDC → adapter_in_ta.
2. Adapter CPIs Kamino.deposit_reserve_liquidity(amount).
3. cTokens land in adapter_out_ta.
4. Adapter transfers cTokens → out_vault (pool).
5. Pool's shielded output note represents cTokens.
```

Pool's `TokenConfig` must whitelist the cToken mint as a pool-recognized asset. When user later wants to exit, they call `adapt_execute` with `KaminoAction::Withdraw`, in_mint = cToken, out_mint = USDC.

### 2.6 Yield accrual

Yield accrues to cTokens passively — cToken-to-USDC redemption ratio increases. The user's shielded notes remain valid; yield is realized on withdraw.

### 2.7 CU estimate

- Kamino deposit CPI: ~250k.
- Adapter overhead: ~30k.
- Pool verify + state: ~250k.
- Total: ~530k.

### 2.8 Edge cases

- **Reserve at borrow-cap.** Deposit still succeeds; withdraw may fail if utilization is pegged. User retries after utilization drops.
- **cToken mint changes (Kamino upgrade).** Adapter pinned to a specific reserve. Kamino upgrades that rotate the cToken mint require a new adapter version + registry update.

### 2.9 Security invariants

- Only the exact Kamino market/reserve in payload is touched. Validated in adapter against registry.
- cTokens returned match `out_vault`'s mint.

---

## 3. Drift — perpetual futures

### 3.1 Rationale

Drift V2 is Solana's deepest perp orderbook. b402-sdk on EVM supports SynFutures perps; Drift is the Solana equivalent. Unique b402 value prop: **private perp trading** — position size, entry, and direction are invisible to chain observers.

### 3.2 On-chain programs used

- **Drift V2 program:** `dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH`
- Instructions: `deposit`, `withdraw`, `place_perp_order`, `cancel_order`, `settle_pnl`.

### 3.3 Adapter payload

```rust
pub struct DriftAdaptPayload {
    pub action: DriftAction,
    pub market_index: u16,              // BTC = 1, ETH = 2, SOL = 0, etc.
    pub direction: PerpDirection,       // Long | Short
    pub base_asset_amount: i64,         // sized for the perp
    pub price_limit: u64,               // entry price ceiling (long) / floor (short)
    pub reduce_only: bool,
    pub margin_amount: u64,             // USDC for open; 0 for close
}

pub enum DriftAction { OpenPerp, ClosePerp, SettlePnl }
```

### 3.4 Per-user Drift account

> **SUPERSEDED 2026-04-25 by PRD-10 §4** — see `docs/prds/PRD-10-drift-adapter.md`.
>
> The original 0.1 draft picked option (b), a shared adapter-PDA `User` account
> with off-chain position accounting. PRD-10 reverses that decision in favor
> of a deterministic per-user `User` PDA derived from
> `(adapter_authority, viewing_pub_hash, market_index)`, with the binding
> proven in-circuit via the new `drift_user_binding` public input gated by
> the `AllowedInstruction.circuit_binding_flags` field added in PRD-04 §7.2.
>
> Reason for the reversal: option (b) turned the adapter into a fund —
> one user's loss could eat all users' collateral, breaking the privacy-
> product framing. PRD-09's Kamino spec independently arrived at the
> same per-user-PDA conclusion (PRD-09 §7), so the pattern is
> consistent across all margin/obligation-based adapters.
>
> The original (b) text is preserved below for historical context only;
> implementers must follow PRD-10.

---

Drift requires a per-user account (`User` PDA). Options:

**(a) Per-shield Drift account.** Adapter creates a fresh Drift user account for each adapt call. Expensive (rent + account creation CU).

**(b) Shared adapter-PDA Drift account.** All b402 private perps accrue to one Drift account owned by the adapter PDA. Simpler, cheaper, but positions are aggregated across all users.

Decision: **(b) with position-level off-chain accounting.** The adapter maintains an internal mapping: commitment → position size. When a user wants to close, their shielded commitment proves the position they're closing. This mirrors how centralized order-flow aggregation works.

**Trade-off:** adapter must track positions honestly. We make it non-custodial by requiring that every open/close goes through a circuit proof binding position size to the spent/created commitment. Adapter cannot invent positions because proofs are required.

### 3.5 Flow (OpenPerp)

```
1. Pool transfers margin_amount USDC → adapter_in_ta.
2. Adapter deposits USDC → Drift user account (shared adapter PDA).
3. Adapter CPIs Drift.place_perp_order(...).
4. On fill (or partial), Drift updates position.
5. Adapter writes to its own PositionRegistry:
   position_id = commitment_hash
   position_size = base_asset_amount_filled
   direction
   margin = margin_amount
6. Adapter returns (no out_vault tokens yet — position tokens don't exist).
7. Pool's out_mint is a synthetic "PositionReceipt" token minted by the adapter — a non-transferable SPL token whose quantity equals position size + margin, representing the open position.
```

### 3.6 Flow (ClosePerp)

```
1. User proves ownership of the PositionReceipt commitment via circuit.
2. Pool transfers PositionReceipt → adapter_in_ta (burn).
3. Adapter looks up position_id in its registry, gets original position.
4. Adapter CPIs Drift.place_perp_order (reduce-only, opposite direction, same size).
5. On fill, Drift settles; USDC PnL lands in Drift user account.
6. Adapter withdraws USDC from Drift → adapter_out_ta → out_vault.
7. Position removed from registry.
```

### 3.7 PositionReceipt design

- Synthetic SPL token. Non-transferable outside the adapter (mint authority = adapter, no user-facing transfer).
- Shielded as a normal note in the pool with `mint = PositionReceipt_mint`, `value = position_size` (encoded), `random`, `spendingPub`.
- User's wallet sees the receipt as a note; UX can show "open BTC long, 0.5 size, 1,000 USDC margin."

### 3.8 CU estimate

- Drift deposit: ~150k.
- Drift place_perp_order: ~300k.
- Adapter overhead: ~40k.
- Pool: ~250k.
- Total open: ~740k.

### 3.9 Edge cases

- **Drift oracle unavailable.** Order fails; pool reverts.
- **Market paused.** Same.
- **Liquidation between open and close.** User's PositionReceipt becomes zero-value. Pool has no special handling; user's shielded position simply has a 0-value redeemable claim. Informational UX via adapter's public read endpoint.
- **Funding rate accrual.** Accrues to the shared Drift account; adapter's PositionRegistry debits/credits per-position on close.

### 3.10 Security invariants

- Adapter cannot mint PositionReceipt without a corresponding Drift position opened in the same tx.
- Adapter's PositionRegistry writes are gated by successful Drift CPIs.
- Closing uses reduce_only to avoid unintended new exposure.

### 3.11 v1 scope note

Drift adapter is the most complex. If v1 scope pressure requires scope cuts, Drift ships last. Jupiter + Kamino + Orca are simpler paths and provide the "private DeFi" core narrative.

---

## 4. Orca — concentrated liquidity LP

### 4.1 Rationale

Orca Whirlpools are the dominant Solana concentrated liquidity venue. Adds a fourth primitive: private LP. Matches b402-sdk EVM's Aerodrome integration.

### 4.2 On-chain programs used

- **Orca Whirlpool program:** `whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc`
- Instructions: `increase_liquidity`, `decrease_liquidity`, `collect_fees`.

### 4.3 Adapter payload

```rust
pub struct OrcaAdaptPayload {
    pub action: OrcaAction,
    pub whirlpool: Pubkey,
    pub tick_lower: i32,
    pub tick_upper: i32,
    pub liquidity_amount: u128,
    pub token_max_a: u64,               // max of mint A committed
    pub token_max_b: u64,               // max of mint B committed
    pub position_mint: Pubkey,          // existing position NFT, or new
}

pub enum OrcaAction { OpenPosition, IncreaseLiquidity, DecreaseLiquidity, CollectFees, ClosePosition }
```

### 4.4 Position NFT

Orca represents LP positions as NFTs. In the shielded context:

- The NFT's mint address is used as a note's `mint` field.
- Pool treats it like any SPL token (value = 1 for NFTs).
- The position NFT is custodied in a pool vault under the pool's PDA; shielded-note ownership determines user control.

### 4.5 Flow (OpenPosition)

```
1. User shields tokens A and B.
2. adapt_execute:
   - inputs: 2 notes (token A, token B).
   - payload: OrcaAction::OpenPosition, whirlpool, ticks, liquidity.
3. Adapter mints Orca position NFT (receives NFT in adapter vault).
4. Adapter transfers NFT → pool's position vault.
5. Pool mints an output note with mint = nft_mint, value = 1, random.
6. User now has one "position NFT note" in their wallet.
```

### 4.6 Closing & fees

User can `adapt_execute` with OrcaAction::CollectFees — adapter pulls accrued fees, returns them as two new shielded notes.

Or `DecreaseLiquidity`, or `ClosePosition` (burn NFT, release all tokens).

### 4.7 CU estimate

- Orca increase_liquidity: ~250k.
- Adapter: ~30k.
- Pool: ~250k.
- Total: ~530k.

### 4.8 Edge cases

- **Out-of-range position.** No fees accrue; position-NFT note is still valid; user can adjust ticks via a `adapt_execute` sequence (close + open).
- **Rebalance.** v1 users handle at client level via multiple adapts.

### 4.9 Security invariants

- NFT custody transfers only to `position_vault`, never to arbitrary addresses.
- CollectFees routes all fee tokens to `out_vault` (pool) atomically.

---

## 5. Adapter scope for Track B hackathon

Track B ships with **Jupiter only**. Jupiter covers the core "private swap" story which is the demo's centerpiece. Kamino + Drift + Orca ship in Track A.

Why Jupiter for Track B:
- Simplest adapter (single-CPI, no internal accounting).
- Covers the most compelling demo ("swap 10 USDC → SOL privately").
- Jupiter is universally recognized; judges don't need protocol context.
- ~3 days of focused work, leaves time for circuit / SDK / submission.

---

## 6. Per-adapter review checklist (instantiated from PRD-04 §11)

For each adapter, the `ops/adapter-review.md` doc must record:

| Adapter | Jupiter | Kamino | Drift | Orca |
|---|---|---|---|---|
| Downstream program pinned | JUP6Lkb... | KLend2g3... | dRiftyHA... | whirLbMi... |
| Out-mint can differ from promised? | No (Jupiter enforces) | No | No (PositionReceipt) | No |
| Oracle dependency | No | Pyth (for liquidation only, not deposit) | Pyth (mandatory) | None |
| Upgrade cadence (external) | ~quarterly | ~monthly | ~monthly | ~quarterly |
| Account count worst case | 32 | 18 | 27 | 22 |
| CU worst case | 700k | 550k | 780k | 560k |
| Reviewed by | | | | |
| Audit status | | | | |

---

## 7. Open questions

1. **Jupiter Swap API vs. Jupiter Route CPI.** We're using the on-chain `route` instruction. Jupiter also offers a Swap API that returns a pre-built tx; we can't use that because we need the route inside our own adapt_execute. Confirm.
2. **Kamino reserve choice.** Kamino Main Market vs. JLP Market — both hold USDC. Main Market has deeper liquidity; JLP has higher APY. Start with Main Market.
3. **Drift v2 vs. Drift Vault.** We use Drift V2 directly. Drift Vaults (delegated vault strategies) are out of scope.
4. **Orca Whirlpool vs. Orca V1 AMM.** V1 AMM is deprecated; we use Whirlpool.
5. **Position transfers between users (private secondary market).** Not in v1. Opens interesting questions for later.

---

## 8. Revision history

| Version | Date | Author | Changes |
|---|---|---|---|
| 0.1 | 2026-04-23 | b402 core | Initial draft |

---

## 9. Sign-off

| Role | Name | Date | Status |
|---|---|---|---|
| Protocol lead | | | |
| Adapter lead | | | |
| Final approval | | | |

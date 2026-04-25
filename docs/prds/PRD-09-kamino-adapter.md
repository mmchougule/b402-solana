# PRD-09 — Kamino Lend/Borrow Adapter

| Field | Value |
|---|---|
| **Status** | Draft — awaiting review |
| **Owner** | b402 core |
| **Date** | 2026-04-24 |
| **Version** | 0.1 |
| **Depends on** | PRD-01, 02, 03, 04, 05 |
| **Gates** | Adapter program implementation, circuit additions for per-user obligations |

PRD-05 §2 sketched a minimal Kamino adapter limited to single-reserve deposit/withdraw of a `cToken`-style vault share. This PRD specifies the **full Kamino Lend integration** — deposit collateral, withdraw collateral, borrow against collateral, repay debt — preserving shielded-pool semantics end-to-end. This is the first b402 adapter with non-trivial protocol state (a borrowing obligation), and the design choices below are load-bearing for any future adapter that mutates protocol state on a per-user basis (Drift, Marginfi, Solend).

---

## §1. Goal

Vanilla Kamino Lend exposes every action — collateral deposits, debt balances, health factors, liquidation events — as on-chain state tied to a user-owned `Obligation` PDA, fully linkable across actions. A user who deposits 100k USDC and borrows 30k SOL is a permanent on-chain record.

A private Kamino adapter lets a shielded-pool user:

1. Deposit collateral as a shielded note (no on-chain link to their wallet).
2. Borrow against that collateral and receive the loan as a shielded note in a different mint.
3. Repay debt without revealing identity.
4. Withdraw collateral when over-collateralised.

What this unlocks that vanilla Kamino cannot: **private leveraged positions**, **private hedging via borrow-and-swap**, **anonymous treasury management** (a DAO can borrow stables against ETH without exposing sizing), and **privacy-preserving liquidations** (the liquidator sees a generic pool obligation, not a person).

The hard problem is that Kamino's `Obligation` is per-owner state, but the pool's `adapter_authority` is a single PDA shared across all users. Resolving that without sacrificing privacy or risk-pooling is the bulk of this spec (§7).

---

## §2. Protocol overview

Programs touched:

- **Kamino Lend program:** `KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD` [verify against current mainnet IDL — Kamino has rotated program IDs in past upgrades].
- **Kamino Farms program** (rewards): `FarmsPZpWu9i7Kky8tPN37rs2TpmMrAZrC7S7vJaNk2W` [verify].

Relevant on-chain accounts:

| Account | Role | Owner |
|---|---|---|
| `LendingMarket` | Top-level market config (e.g., Kamino Main Market) | Kamino program |
| `Reserve` | One per asset (USDC reserve, SOL reserve, JitoSOL reserve, etc.) | Kamino program |
| `Reserve.liquidity_supply_vault` | SPL token account holding deposited liquidity | Kamino PDA |
| `Reserve.collateral_mint` | SPL mint of the reserve's `cToken` (collateral receipt) | Kamino PDA |
| `Reserve.collateral_supply_vault` | Vault holding deposited cTokens (only for borrowers) | Kamino PDA |
| `Obligation` | Per-borrower state: deposits[], borrows[], owner | User-derived PDA |
| Pyth/Switchboard price feeds | Oracle accounts referenced per-reserve | Pyth/Switchboard |

Relevant instructions (Kamino IDL discriminators):

- `init_obligation` — creates an `Obligation` PDA.
- `deposit_reserve_liquidity_and_obligation_collateral` — combined: deposit underlying into reserve, mint cTokens, deposit cTokens as collateral on the obligation.
- `withdraw_obligation_collateral_and_redeem_reserve_collateral` — combined: withdraw cTokens from obligation, burn for underlying.
- `borrow_obligation_liquidity` — borrow against obligation.
- `repay_obligation_liquidity` — repay debt.
- `refresh_reserve` / `refresh_obligation` — update accrued interest using oracle prices. Required as a precursor instruction before any state-changing op.

[verify discriminators and exact account ordering against the on-chain IDL at deploy time.]

---

## §3. Operations supported in v1

The adapter program (`programs/b402-kamino-adapter/`) exposes a single `execute(action_payload: Vec<u8>)` entrypoint per the PRD-04 §2 ABI. The payload deserialises into one of four variants:

```rust
pub enum KaminoAction {
    Deposit { reserve: Pubkey, in_amount: u64, min_kt_out: u64 },
    Withdraw { reserve: Pubkey, kt_in: u64, min_underlying_out: u64 },
    Borrow { reserve: Pubkey, amount_out: u64, max_collateral_used: u64 },
    Repay { reserve: Pubkey, amount_in: u64 },
}
```

Operation semantics:

| Op | in_mint | out_mint | Effect |
|---|---|---|---|
| Deposit | underlying (e.g. USDC) | reserve.collateral_mint (kUSDC) | Mint cToken-equivalent shielded note proportional to deposit. |
| Withdraw | reserve.collateral_mint (kUSDC) | underlying (USDC) | Burn cToken note, receive underlying back as a shielded note. |
| Borrow | reserve.collateral_mint (kUSDC, used as proof of position) | borrowed asset (e.g. SOL) | Receive borrowed asset as a new shielded note. The cToken note is **not consumed** — it is re-emitted unchanged (see §6). |
| Repay | borrowed asset (e.g. SOL) | underlying (e.g. SOL — refund vault) | Reduce obligation's debt by `amount_in`. Excess refunded to the pool's refund vault and reshielded. |

**Interest accrual** is deferred to v2. In v1, the cToken-to-underlying ratio is read at withdraw time; deposit-time and withdraw-time rates differ as accrued interest. The shielded note carries cToken units, not underlying — yield is realised passively on the redemption ratio, identical to PRD-05 §2.6. **Borrow-side interest** is more delicate: a borrowed note created at t=0 represents a fixed debt of `amount_out` underlying, but the obligation accrues interest continuously. v1 handling: §8.

Multi-reserve obligations (e.g. deposit USDC, borrow SOL, deposit JitoSOL, borrow USDC) are supported on the protocol level but not in v1 SDK ergonomics — each call mutates a single reserve at a time. v2 may bundle.

---

## §4. Account layout

Per PRD-04 §2, the pool passes the standard 6 ABI accounts (`adapter_authority`, `in_vault`, `out_vault`, `adapter_in_ta`, `adapter_out_ta`, `token_program`) plus protocol-specific accounts as `remaining_accounts`. The Kamino-specific list per operation:

### §4.1 Deposit

```
remaining_accounts:
  0: lending_market                       (Kamino market state)
  1: lending_market_authority             (Kamino PDA)
  2: reserve                              (writable)
  3: reserve.liquidity_supply_vault       (writable)
  4: reserve.collateral_mint              (writable)
  5: reserve.collateral_supply_vault      (writable)
  6: obligation                           (writable; see §7)
  7: pyth_price_feed (or switchboard)     (read-only)
  8: kamino_lend_program
  9: instruction_sysvar                   (Kamino requires this for some ixs)
```

The adapter executes:

1. CPI `refresh_reserve` (uses oracle).
2. CPI `refresh_obligation` (refreshes all positions on the obligation).
3. CPI `deposit_reserve_liquidity_and_obligation_collateral` with:
   - `source_liquidity = adapter_in_ta`
   - `destination_collateral = adapter_out_ta`
   - `obligation_owner = adapter_authority` (with seeds; see §7)
4. Transfer `adapter_out_ta` cToken balance → `out_vault`.

### §4.2 Withdraw

Same accounts as Deposit. The adapter:

1. Refresh reserve + obligation.
2. CPI `withdraw_obligation_collateral_and_redeem_reserve_collateral` with `kt_in` as the cToken amount; underlying lands in `adapter_out_ta`.
3. Transfer `adapter_out_ta` underlying → `out_vault`.

If the obligation has outstanding borrows, Kamino enforces the post-withdraw LTV check; failure reverts the CPI and the pool reverts the tx (no partial state).

### §4.3 Borrow

```
remaining_accounts:
  0: lending_market
  1: lending_market_authority
  2: collateral_reserve                   (writable)  — the reserve user deposited into
  3: borrow_reserve                       (writable)
  4: borrow_reserve.liquidity_supply_vault (writable)
  5: borrow_reserve.liquidity_fee_receiver (writable)
  6: obligation                           (writable)
  7: collateral_pyth_feed
  8: borrow_pyth_feed
  9: kamino_lend_program
```

Adapter executes:

1. Refresh both reserves + obligation.
2. CPI `borrow_obligation_liquidity` — borrowed underlying lands in `adapter_out_ta`.
3. Transfer `adapter_out_ta` → `out_vault`.

The `in_vault` for Borrow is the cToken vault — but **no cTokens move**. The pool's `adapt_execute` still records the input note as spent and emits an output cToken note of identical value (see §6 on Borrow's "passthrough input"). This is the most novel part of the design and motivates a circuit constraint addition (§5).

### §4.4 Repay

```
remaining_accounts:
  0: lending_market
  1: borrow_reserve                       (writable)
  2: borrow_reserve.liquidity_supply_vault (writable)
  3: obligation                           (writable)
  4: borrow_pyth_feed
  5: kamino_lend_program
```

Adapter:

1. Refresh reserve + obligation.
2. CPI `repay_obligation_liquidity` with `amount_in` from `adapter_in_ta`. Excess (if user overpays past current debt) stays in `adapter_in_ta` because Kamino caps repay at outstanding debt.
3. Transfer remaining `adapter_in_ta` balance → `out_vault` (the refund vault, same mint as input).

Worst-case refund = full `amount_in` if obligation already had zero debt for that reserve. Acceptable; user just gets their tokens back as a fresh shielded note.

---

## §5. Action payload format

Borsh-encoded. Total payload ≤ 80 B for any variant — well under the 400 B cap from PRD-04 §5.3.

```rust
#[derive(BorshSerialize, BorshDeserialize)]
pub enum KaminoAction {
    Deposit  { reserve: Pubkey, in_amount: u64, min_kt_out: u64 },        // 1 + 32 + 8 + 8
    Withdraw { reserve: Pubkey, kt_in: u64, min_underlying_out: u64 },    // 1 + 32 + 8 + 8
    Borrow   { reserve: Pubkey, amount_out: u64, max_collateral_used: u64 }, // 1 + 32 + 8 + 8
    Repay    { reserve: Pubkey, amount_in: u64 },                         // 1 + 32 + 8
}
```

The pool's circuit binds `actionHash = Poseidon_3(adaptBindTag, keccak256(action_payload), expectedOutMint_Fr)` per PRD-04 §2.1. Per operation, what `expected_out_mint` and `expected_out_value` carry:

| Op | expected_out_mint | expected_out_value | Justification |
|---|---|---|---|
| Deposit | reserve.collateral_mint | `min_kt_out` | The pool's out_vault is the cToken vault; delta ≥ minted cTokens ≥ `min_kt_out` is the user's slippage floor. |
| Withdraw | underlying mint | `min_underlying_out` | Pool's out_vault holds underlying; delta is redemption proceeds. |
| Borrow | borrowed-asset mint | `amount_out` | User wants exactly `amount_out` borrowed; Kamino enforces ≥ amount with no slippage on borrow itself. |
| Repay | underlying mint (= in_mint) | 0 | No tokens returned in the success case. Refund path produces a separate output via the refund-vault delta — not enforced as a floor. See §6. |

Repay's `expected_out_value = 0` is correct: a successful repay returns zero in the standard case. The circuit still binds the action, so the relayer cannot substitute Repay for Borrow.

---

## §6. Delta-invariant strategy per operation

Pool's `adapt_execute` enforces `out_vault.amount_after - out_vault.amount_before ≥ expected_out_value`. Per op:

### §6.1 Deposit
- **out_vault**: pool's cToken vault for the reserve.
- **Delta**: `min_kt_out` units of cToken minted by Kamino + transferred by adapter.
- **Risk**: Kamino's mint ratio (`underlying / cToken`) shifts on every refresh; if it shifts adversely, fewer cTokens are minted than the user expects. Mitigation: SDK fetches current ratio and sets `min_kt_out` with a small buffer; if ratio shifts past the buffer between proof gen and submission, tx reverts cleanly.

### §6.2 Withdraw
- **out_vault**: pool's underlying vault.
- **Delta**: `min_underlying_out` underlying redeemed.
- **Risk**: same — redemption ratio drift.

### §6.3 Borrow — load-bearing design call
- **out_vault**: pool's borrowed-asset vault.
- **Delta**: `amount_out` of borrowed mint received.
- **The cryptographic problem**: the borrow is recorded against the obligation owned by `adapter_authority`. The shielded user spent a note proving "I have collateral on this obligation," but Kamino doesn't know which fraction of the obligation's collateral is "theirs." If two users share the obligation, what stops user A from spending the proof and walking away with user B's borrowing capacity?

**Resolution: per-user obligation PDAs.** Each shielded user binds a `viewing_pub_hash` to a unique `Obligation` PDA derived as:

```
obligation = PDA([b"b402/v1", b"kamino-obligation", viewing_pub_hash, reserve_market], adapter_program)
```

The `viewing_pub_hash` is the Poseidon hash of the user's viewing public key (already part of the shielded note schema, PRD-02). The circuit additionally constrains: the `obligation` account address public-input matches Poseidon of (viewing_pub_hash, reserve_market). The pool passes `obligation` as a public input to the verifier, so a relayer cannot substitute a different obligation.

This adds **two new public inputs** to the adapt circuit:
- `obligation_pubkey_lo` (16 bytes of obligation pubkey as field element)
- `obligation_pubkey_hi` (16 bytes)

Cost: ~2 extra Poseidon hashes in the circuit, ~50 extra constraints. Negligible vs. the existing ~80k-constraint adapt circuit.

This means **no cross-user borrowing capacity sharing** — each shielded user has their own Kamino obligation. The trade-off is rent (~0.005 SOL per obligation, paid once at first deposit per (user, market) pair). Acceptable.

### §6.4 Repay
- **out_vault**: pool's refund vault (same mint as in).
- **Delta**: 0 in normal case; positive only if user overpaid (e.g. interest accrued less than expected, or another path repaid the same debt between proof gen and submission).
- **Invariant**: `expected_out_value = 0`, so any non-negative delta passes. The pool emits an output note for the refund delta automatically per the standard reshield path.

---

## §7. Obligation account ownership — the design decision

Two options were on the table:

### §7.1 Option A: Shared obligation per market
One `Obligation` PDA owned by `adapter_authority`, derived as `PDA([b"b402/v1", b"kamino-obligation-shared", market], program)`. All shielded users' deposits and borrows aggregate here.

**Pros:**
- One-time rent.
- Single obligation to monitor for liquidation.
- Slightly cheaper CU per op (no per-user PDA derivation).

**Cons:**
- **Risk pooling**: User A's reckless borrow can liquidate the entire shared obligation, taking User B's collateral with it.
- **Circuit must track per-user collateral and debt off-chain via shielded notes** — feasible but reintroduces the bookkeeping the cToken-note model was designed to avoid.
- **No per-user health factor** — adapter cannot enforce a per-user LTV floor when borrowing.
- **Privacy degraded**: an observer correlating obligation state changes with adapt_execute timestamps gets weak deanonymisation signals.

### §7.2 Option B: Per-user obligation PDA (recommended)

`obligation = PDA([b"b402/v1", b"kamino-obligation", viewing_pub_hash, market], program)`.

**Pros:**
- Risk isolation: each user's positions live in their own Kamino obligation. Liquidation of one user does not touch any other.
- Per-user health factor enforced natively by Kamino — no in-circuit re-implementation.
- Clean privacy story: each obligation looks like an independent unrelated Kamino user from the outside.
- Maps cleanly to the cToken-shielded-note model.

**Cons:**
- Rent: ~0.005 SOL × number of unique (user, market) pairs. Paid by relayer at first deposit, recovered through the standard relayer fee.
- One extra Poseidon hash in circuit (binding viewing_pub_hash to obligation pubkey).
- Adapter must `init_obligation` lazily on first deposit per user.
- `viewing_pub_hash` becomes a public input — does this leak? **No**: viewing_pub is already published on-chain as part of every shielded note (it's the encryption target). The hash adds nothing.

### §7.3 Decision

**We choose Option B.** Risk-pooling under Option A is unacceptable for a privacy product — the value proposition is "private DeFi without compromising safety," and shared-liquidation explicitly compromises safety. The extra ~50 circuit constraints and per-user rent are a small price.

This decision propagates: **any future adapter with per-user protocol state** (Drift positions, Marginfi, Solend) **must follow the same per-user-PDA pattern**. The Drift adapter in PRD-05 §3.4 currently picks Option A (shared Drift account); that decision should be revisited in light of this PRD.

---

## §8. Liquidation handling

Kamino liquidates obligations when LTV exceeds the reserve's `liquidation_threshold`. With per-user obligations, a liquidation affects exactly one shielded user.

When user X's obligation is liquidated:
- Kamino's liquidation instruction transfers some of X's collateral to the liquidator and reduces X's debt accordingly.
- The shielded notes representing X's cTokens are **still valid** — they encode cToken amounts, not protocol-state pointers. But when X next withdraws, the redemption ratio reflects the post-liquidation reserve state, and the obligation's recorded collateral is lower than the cToken note total. Result: X's withdraw of `kt_in` cTokens reverts because the obligation no longer holds that many.

**Three options for handling this:**

### §8.1 Option L1: Accept liquidation; document the failure mode
On liquidation, X's notes remain in their wallet but become un-redeemable. SDK's `status` endpoint cross-references shielded balances against on-chain obligation state and surfaces "this position was liquidated; current redeemable: 0".

Simple, honest, matches Kamino UX (vanilla Kamino users see liquidations on their positions too). User retains all upside before liquidation.

### §8.2 Option L2: In-circuit health-factor floor
Adapt circuit additionally proves: post-borrow LTV ≤ user-chosen `safe_ltv` < `liquidation_threshold`. User can borrow less than Kamino would technically allow, in exchange for a bigger safety margin. Optional input; defaults to `min(liquidation_threshold - 5%, 65%)`.

Doesn't prevent liquidation (oracle-driven), only reduces probability. Adds a Pyth price reading to the circuit, which is non-trivial: Pyth on Solana is not directly compatible with circuit-friendly arithmetic. We'd need to expose the price as a verifier public input and trust the on-chain `refresh_reserve` to have used it. Doable but a chunk of work.

### §8.3 Option L3: Insurance pool (out of v1)
A small fee on every borrow funds a shielded insurance vault. On liquidation, the user can submit a proof claiming partial reimbursement. Heavy product surface.

### §8.4 Decision for v1

**Ship with Option L1.** Document liquidation risk in SDK and UI. Users accept identical risk to vanilla Kamino, plus the additional risk that an opaque pool obligation can be liquidated without user-facing alerts (mitigation: SDK polls obligation health and emits warnings).

**Plan Option L2 for v2** once we've validated the basic flow on devnet and seen the operational shape of liquidations.

**Option L3 is a v3+ research item.**

---

## §9. Oracle dependencies

Kamino reserves use Pyth or Switchboard. Per supported reserve, the adapter MUST forward the correct oracle account.

| Reserve | Oracle | Account | Notes |
|---|---|---|---|
| USDC (Main Market) | Pyth | `Gnt27xtC473ZT2Mw5u8wZ68Z3gULkSTb5DuxJy7eJotD` | [verify] |
| SOL (Main Market) | Pyth | `H6ARHf6YXhGYeQfUzQNGk6rDNnLBQKrenN712K4AQJEG` | [verify] |
| JitoSOL (Main Market) | Pyth + Pull oracle | needs both | [verify] |
| USDT (Main Market) | Switchboard | `3vxLXJqLqF3JG5TCbYycbKWRBbCJQLxQmBGCkyqEEefL` | [verify] |
| mSOL | Pyth | `E4v1BBgoso9s64TQvmyownAVJbhbEPGyzA3qn4n46qj9` | [verify] |

[All addresses verify against current Kamino reserve config at deploy time. Kamino has been known to migrate oracle accounts during upgrades; SDK fetches the live oracle pubkey from `Reserve.config.token_info` at proof-gen time.]

**Stale-price risk inside `adapt_execute`:** Kamino's `refresh_reserve` instruction fails if the oracle is stale (configurable per-reserve, typically 30-60 slots). Adapter calls `refresh_reserve` before every state-changing op; stale oracle → CPI fails → pool reverts cleanly. No partial state. The post-CPI delta check in the pool catches any case where Kamino's internal handling silently degrades to a stale price, because the resulting amounts won't meet the user's slippage floor.

---

## §10. Test strategy

Mirror `examples/swap-e2e-jupiter.ts` (the working Phase 2a Jupiter integration).

**Mainnet-fork validator setup:**
```
solana-test-validator \
  --clone KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD \      # Kamino program
  --clone <USDC_RESERVE> \
  --clone <SOL_RESERVE> \
  --clone <USDC_MINT> \
  --clone <SOL_MINT> \
  --clone <PYTH_USDC> \
  --clone <PYTH_SOL> \
  --clone <LENDING_MARKET> \
  --url https://api.mainnet-beta.solana.com
```

**Test cases:**

1. `kamino-deposit-e2e.ts` — shield USDC, adapt-deposit into USDC reserve, verify cToken note in user wallet, verify obligation initialised on-chain.
2. `kamino-withdraw-e2e.ts` — withdraw cTokens, verify USDC note returned with correct redemption ratio.
3. `kamino-borrow-e2e.ts` — deposit USDC, borrow SOL, verify SOL note appears, verify obligation has both collateral and debt.
4. `kamino-repay-e2e.ts` — partial repay, verify obligation debt reduced, verify refund note for any overpayment.
5. `kamino-borrow-then-withdraw-blocked.ts` — borrow against deposit, attempt withdraw beyond LTV → tx reverts.
6. `kamino-fuzz-deltas.ts` — randomised slippage values, asserts pool delta-check rejects under-floor returns.
7. `kamino-stale-oracle.ts` — set oracle to stale, verify graceful revert, no state mutation.
8. `kamino-cross-user-isolation.ts` — two users in same market, liquidate user A, verify user B unaffected.

CI runs all 8 against the fork on every adapter PR.

---

## §11. Effort estimate

| Component | LoC | Effort |
|---|---|---|
| Adapter program (`programs/b402-kamino-adapter/`) | ~250-350 | 2-3 days |
| Per-user obligation PDA derivation + lazy `init_obligation` | ~80 | 0.5 day (folded into adapter) |
| Circuit additions: bind `viewing_pub_hash` → obligation pubkey | ~30 lines Circom | 1-2 days (incl. parity tests) |
| Verifier-key regeneration + on-chain rotation | n/a | 0.5 day |
| 8 e2e tests (mainnet-fork) | ~600 | 2 days |
| SDK integration: `privateLend`, `privateBorrow`, `privateRepay`, `privateLendingStatus` | ~400 | 1-1.5 days |
| Devnet rehearsal + ops runbook | n/a | 0.5 day |
| **Total** | | **~8-10 days** |

Single engineer, assuming Phase 2a (Jupiter adapter) is fully understood. Two engineers can parallelise circuit + adapter; not a 2x speedup because of integration friction.

---

## §12. Deferred to v2

1. **Borrow-side interest accrual reflected in shielded notes.** A borrowed note carries fixed `amount_out`; the obligation's debt grows. v1 punts: at repay time, user pays current obligation debt, not original `amount_out`. The SDK exposes current debt via `privateLendingStatus`.
2. **Position migration across reserves.** E.g. swap USDC collateral for SOL collateral without unwinding through underlying. v1: do it via withdraw → swap → deposit (three adapt calls).
3. **Liquidation insurance** (§8.3).
4. **Multi-collateral obligations** in a single instruction. v1 uses one collateral reserve at a time; user can manually layer multiple.
5. **In-circuit health-factor floor** (§8.2).
6. **kToken transferability between shielded users.** Today a shielded cToken note is equivalent to a transferable shielded token; cross-obligation transfers are not supported because each cToken-note is bound to the depositor's obligation. v2 would need a "rebind" flow.
7. **Kamino Vaults** (delegated multi-strategy products). PRD-05 §2.2 referenced these as a separate program; out of v1 scope.
8. **Kamino Farms rewards.** Adapter doesn't currently claim or compound farm rewards. v2 adds a `claim_rewards` action variant.

---

## §13. Open questions

1. **Obligation rent recovery on full close.** When a user fully exits their position, can we close the per-user obligation PDA and reclaim the rent? Kamino's `close_obligation` instruction exists; need to confirm it works when called by adapter PDA, and decide whether the rent is refunded to the user (as a shielded SOL note? Awkward) or absorbed into the relayer fee pool.
2. **Reserve config caching.** SDK currently re-fetches reserve state per quote. Should we cache and refresh on-demand? Affects p99 quote latency by ~200ms.
3. **Migration when Kamino rotates a reserve.** Kamino has historically deprecated reserves with a forced migration path. Adapter must handle this gracefully — proposal: registry can be updated to mark a reserve as deprecated, blocking new deposits but allowing withdraws.
4. **Reverting Drift adapter to per-user accounts.** PRD-05 §3.4 currently chooses Option A (shared) for Drift. After this PRD, the consistency argument says Drift should use Option B too. Out of scope here but worth a follow-up.

---

## §14. Revision history

| Version | Date | Author | Changes |
|---|---|---|---|
| 0.1 | 2026-04-24 | b402 core | Initial draft. Replaces and supersedes PRD-05 §2 for any operation beyond simple deposit/withdraw. |

---

## §15. Sign-off

| Role | Name | Date | Status |
|---|---|---|---|
| Protocol lead | | | |
| Adapter lead | | | |
| Circuit lead (for §6.3 / §7) | | | |
| Final approval | | | |

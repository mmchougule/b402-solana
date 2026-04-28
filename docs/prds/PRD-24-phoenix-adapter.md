# PRD-24 — Phoenix Adapter (Spot CLOB → Maker → Rise Perps)

| Field | Value |
|---|---|
| **Status** | Draft — spike, awaiting review |
| **Owner** | b402 core |
| **Date** | 2026-04-28 |
| **Version** | 0.1 |
| **Depends on** | PRD-04, PRD-12, PRD-13, PRD-14, PRD-15 |
| **Tracks** | issue #18 (Phoenix DEX adapter) |

---

## 1. Goal

Bring private orderbook execution on Solana to b402 by adapting the Phoenix family of programs. Phoenix is the only credible non-AMM venue on Solana — copy-trade-bot front-running of resting limit orders is a real pain point, and a privacy-preserving CLOB taker/maker pair is the most differentiated thing the b402 adapter set can ship after Adrena.

This PRD scopes the integration into three phases of *increasing* protocol-coupling and infrastructure cost. Each phase is independently shippable. Phase A and Phase B target Phoenix v1 (the open-source spot CLOB). Phase C targets Phoenix Rise (perpetuals) and is gated on Phoenix publishing a public CPI surface.

---

## 2. Phoenix product clarification

There are **two distinct on-chain products** behind `phoenix.trade`. They have different program IDs, different account models, and different integration shapes. This PRD treats them separately.

| Product | What it is | Program ID | Source | License | CPI-able today? |
|---|---|---|---|---|---|
| **Phoenix v1** ("Phoenix Legacy") | Spot CLOB DEX | `PhoeNiXZ8ByJGLkxNfZRnkUfjvmuYqLR89jjFHGqdXY` | [`Ellipsis-Labs/phoenix-v1`](https://github.com/Ellipsis-Labs/phoenix-v1) | BUSL-1.1 | **Yes** |
| **Phoenix Rise** (Phoenix Perpetuals) | On-chain perps, FIFO orderbook + spline liquidity | Not published | Not open source | Unknown | **No — private beta, HTTP-first SDK only** |

`docs.phoenix.trade/sdk/rise` describes the *Rise* SDK. The page text "Phoenix is live in private beta; an access code is required to access Phoenix" applies to Rise only — `phoenix-v1` is and has been mainnet-public since 2023. Issue #18 explicitly targets Phoenix v1, and that remains the right v1-of-this-adapter scope.

### 2.1 Why this distinction matters for the spike

The b402 adapter ABI requires a CPI target. Without a published program ID, instruction discriminators, and account model, no adapter is buildable — there is nothing to call. The Rise SDK published at `docs.phoenix.trade/sdk/rise` is an HTTP/WebSocket client (`PhoenixHttpClient`, `client.streams`, `client.ixs` builders); its instructions ultimately resolve to one of Phoenix's on-chain programs, but the program ID is not part of the public surface and access is gated by an "access code" + waitlist. We do not integrate against bytecode we cannot legally inspect.

Phase C is therefore **explicitly deferred until** at least one of:
1. Phoenix Foundation publishes the Rise mainnet program ID and an open IDL.
2. Rise exits private beta with documented CPI examples.
3. b402 reaches a direct partnership and gets a signed integration brief.

---

## 3. Architecture mapping (current b402 already anticipates this)

The repo's existing PRDs already name Phoenix in three places. This PRD does not introduce new infrastructure — it consumes infrastructure already specified.

| Hook | Where it's specified | What this PRD uses it for |
|---|---|---|
| `phoenix:trader:v1` scope_tag | PRD-13 §4 (table row) | Phase B shadow PDA seed |
| "Phoenix orderbook adapter — pure CPI wrapper" | PRD-12 §example list | Phase A action-hash binding |
| "Phoenix limit order — match-conditional" | PRD-14 §6 (table row) | Phase B + (optional) two-phase claim |
| Delta-zero exemption | PRD-04 §7.1, PRD-15 | Phase B `CancelOrder`, `ClaimSeat` shapes |

Concretely, **no new pool changes, no new circuit, no new ABI version** is required for Phase A. Phase B reuses the already-specified shadow-PDA + delta-zero plumbing originally drafted for Adrena/Kamino. Phase C is the only one that would force new spec work, and only if the Rise CPI surface looks materially different from a normal CPI-wrapper adapter.

---

## 4. Phase A — Phoenix v1 spot taker (`Swap`)

### 4.1 Scope

One adapter program, one action variant, one CPI target. Ships under the existing PRD-04 v1 ABI.

### 4.2 Action set

```rust
pub enum PhoenixAction {
    /// Atomic IOC swap against a Phoenix v1 market. Equivalent to a market
    /// order: fills as much as possible against the book at execution time
    /// and returns unmatched-input + matched-output to the adapter's
    /// scratch ATAs. Adapter then sweeps both back to pool vaults.
    Swap {
        /// Phoenix v1 market header PDA (bytes 8..40 of the market account
        /// = base/quote mint pair + tick_size). Adapter passes through;
        /// pool does not bind it (Phoenix enforces).
        market: Pubkey,
        /// Side: 0 = buy base with quote, 1 = sell base for quote.
        side: u8,
        /// Amount in (in base or quote depending on `side`). Must equal
        /// `pi.public_amount_in`.
        amount_in: u64,
        /// Slippage cap as `min_amount_out` in the destination mint.
        /// Adapter forwards this as Phoenix's `SelfTradeBehavior::Abort`
        /// + `match_limit` derived from market metadata.
        min_amount_out: u64,
    },
}
```

The Phoenix v1 instruction enum exposes `Swap = 0` (verified against `src/program/instruction.rs` upstream); this is the *only* taker-side instruction Phase A uses. Variants `SwapWithFreeFunds`, `PlaceLimitOrder*`, `Reduce*`, `Cancel*`, `WithdrawFunds`, `DepositFunds`, `RequestSeat`, `Log`, `PlaceMultiplePostOnlyOrders*` are out of scope for Phase A.

### 4.3 Why `Swap` is a perfect fit for the v1 ABI

Phoenix's `Swap` is **synchronous, fill-or-revert against the book at the current slot, no seat required**. It maps cleanly onto the b402 v1 adapter ABI:

- `pre_balance_in/out` measured before CPI.
- Adapter forwards `amount_in` to Phoenix via `Swap`.
- Phoenix returns matched output to `adapter_out_ta` (and unmatched input to `adapter_in_ta` if the book did not have enough depth).
- Adapter sweeps both back to pool vaults.
- Pool's post-CPI delta check enforces `out_vault.amount ≥ pre_balance_out + min_amount_out`.

If the book is shallow and Phoenix matches less than `min_amount_out` of output, the post-CPI check fails and the entire tx reverts — exactly the same shape as the Jupiter adapter's slippage failure. The user's notes are not spent.

### 4.4 Account model (Phase A)

Per PRD-04 §2 fixed prefix + Phoenix v1 `Swap` accounts via `remaining_accounts`:

```
fixed prefix (6):
  adapter_authority    (PDA, signer-via-invoke_signed)
  in_vault             (pool's input vault)
  out_vault            (pool's output vault)
  adapter_in_ta        (scratch, owner = adapter_authority)
  adapter_out_ta       (scratch, owner = adapter_authority)
  token_program

remaining_accounts (Phoenix v1 Swap, ~9):
  phoenix_program           (PhoeNiXZ8...)
  log_authority             (Phoenix's PDA)
  market                    (writable; the market account)
  trader                    (= adapter_authority — IOC swappers don't need a Seat)
  base_account              (= adapter scratch for the base mint)
  quote_account             (= adapter scratch for the quote mint)
  base_vault                (Phoenix's market base vault)
  quote_vault               (Phoenix's market quote vault)
  token_program (already in fixed prefix; passed as remaining-account dup if Phoenix expects it twice — TBD on integration)
```

Total: ~15 accounts. Comfortably under the 35-ish pre-ALT budget. Adding `(market, base_vault, quote_vault, log_authority, phoenix_program)` to the b402 ALT (`ops/alt/`) drops 5 entries from the per-tx account list — recommended but not required for v1.

### 4.5 Adapter program shell

Modeled on `programs/b402-jupiter-adapter/src/lib.rs` — same `invoke_signed` pattern, same scratch-ATA → vault sweep at the end. Only differences:

- `PHOENIX_V1_PROGRAM_ID = PhoeNiXZ8ByJGLkxNfZRnkUfjvmuYqLR89jjFHGqdXY`
- Borsh-decode `PhoenixAction` from `action_payload` (vs. Jupiter's opaque-byte forwarding) so the adapter can re-encode the Phoenix `SwapParams` cleanly and reject unknown variants.
- Two-mint sweep at the end (input residual + output) vs. Jupiter's single-mint output sweep.

### 4.6 Discriminators

Phoenix v1 instructions are dispatched by a single u8 leading byte (not Anchor 8-byte discriminator). Adapter registry's `AllowedInstruction.discriminator: [u8;8]` field stores the byte left-padded: `[0x00, 0, 0, 0, 0, 0, 0, 0]` for `Swap`. Pool's pre-CPI discriminator check (PRD-04 §7) extracts the first 8 bytes of CPI ix data and compares — matches naturally because the trailing 7 bytes will be the rest of the `SwapParams` struct. **Note:** if the pool's check is strictly equal-on-all-8-bytes, this needs a per-adapter "discriminator length" field. Open question, see §10.

### 4.7 Validation plan (Phase A)

Mirror `tests/onchain/tests/kamino_deposit.rs` and `examples/kamino-adapter-fork-deposit.ts`:

1. **Litesvm dispatch test** — `tests/onchain/tests/phoenix_swap.rs`. Loads adapter only, drives `execute(Swap{..})`, asserts Borsh-decode + `invoke_signed` reaches the right CPI dispatch path (no real Phoenix loaded). Pins CU.
2. **Mainnet-fork integration test** — `examples/phoenix-adapter-fork-swap.ts`. Boots `solana-test-validator` with Phoenix v1 cloned from mainnet (`ops/setup-phoenix-fork.sh`, new). Shields USDC, calls `B402Solana.privateSwap({ inMint: USDC, outMint: SOL, ..., venue: 'phoenix' })`, asserts settlement.
3. **Assurance probe** — new scenario `phoenix_swap_full_path` in `b402-solana-assurance/onchain-probes/src/main.rs`, parallel to the Kamino probe in issue #24. Pins CU + tx size.

### 4.8 CU budget projection

Based on Phoenix v1 published CU costs (~115k for a single-level `Swap`) + adapter overhead (~16k modeled on `b402-jupiter-adapter`) + pool's `adapt_execute` handler (~325k including ZK verify):

- Best case (single price level): **~456k CU**.
- 5-level book sweep: **~520k CU**.

Both well under Solana's 1.4M CU per-tx cap, and under PRD-04 §5's account budget.

---

## 5. Phase B — Phoenix v1 maker (`PlaceLimitOrder`, `CancelMultipleOrdersById`, `WithdrawFunds`)

### 5.1 Scope

Resting limit orders. The thing that copy-trade bots actually snipe. This is where Phoenix's privacy proposition is strongest.

### 5.2 Why this needs more than Phase A

Phoenix's `PlaceLimitOrder` (variant 2 in the upstream enum) requires:

1. A claimed **Seat** (via `RequestSeat` + governance approval, or `RequestSeatAuthorized` via Phoenix's seat-manager program). The seat is a per-trader-per-market PDA owned by Phoenix. Rent ~0.005 SOL per seat.
2. The order, when placed, may **not match immediately** — it rests on the book until a counter-side taker fills it (in whole or in part).
3. Fills accrue into a **TraderState** PDA (free funds), which the trader withdraws via `WithdrawFunds` (variant 12) at a later slot.

This violates PRD-04's standard post-CPI delta invariant: the user's input is moved to Phoenix's market vault (not back to the pool), and the output (matched fills) is realised over multiple subsequent transactions. Phase A's "atomic or revert" model does not apply.

### 5.3 Two infrastructure pieces this Phase consumes

Both are already specified for other adapters; Phase B is the first realisation for Phoenix.

**(a) Shadow PDA — PRD-13.**

```
phoenix_shadow = PDA(["b402-shadow", PHOENIX_V1_PROGRAM_ID,
                       b"phoenix:trader:v1", viewing_key_commitment])
```

`viewing_key_commitment = Poseidon(viewing_pub_x, viewing_pub_y)` per PRD-13 §3.

The shadow PDA's seeds *equal* what Phoenix v1 itself uses to derive the `Seat` and `TraderState` PDAs (modulo b402's prefix), so the adapter program signs all Phoenix calls as `phoenix_shadow`. Phoenix sees a stable per-shielded-user trader, with no link to any wallet.

PRD-13 §4 already lists `phoenix:trader:v1` as the canonical scope_tag for this adapter — this PRD is the first PRD to actually consume that table row.

**(b) Delta-zero exemption — PRD-04 §7.1, PRD-15.**

`PlaceLimitOrder` moves input into Phoenix's market vault but does not return any output in the same tx. From b402's perspective, the post-CPI `out_vault` delta is zero. With `AllowedInstruction.allows_delta_zero = true` set for `PlaceLimitOrder`'s discriminator and the proof's `expected_out_mint = Pubkey::default()` + `expected_out_value = 0`, the pool skips the post-CPI delta check (PRD-04 §7.1).

The user's note is spent (input is consumed) but no new output note is created in this tx. The output side is realised at withdrawal time via `WithdrawFunds`, which has the standard non-zero delta shape and creates a new note for the matched proceeds.

The same exemption applies to `CancelMultipleOrdersById` (frees a resting order back into TraderState free-funds without an immediate token movement to the pool).

### 5.4 Action set (Phase B)

```rust
pub enum PhoenixAction {
    Swap { /* Phase A */ ... },

    /// Place a resting limit order. Delta-zero on input/output —
    /// proceeds are realised later via WithdrawFunds.
    PlaceLimitOrder {
        market: Pubkey,
        side: u8,
        price_in_ticks: u64,
        size_in_base_lots: u64,
        client_order_id: u128,
        /// SelfTradeBehavior — `Abort | DecrementTake | CancelProvide`.
        self_trade_behavior: u8,
        /// Optional time-in-force in slots (0 = GTC).
        last_valid_slot: u64,
    },

    /// Cancel one or more open orders by client_order_id. Frees their
    /// committed base/quote back into the trader's free-funds. Delta-zero.
    CancelOrdersById {
        market: Pubkey,
        client_order_ids: Vec<u128>,    // bounded — see §5.6
    },

    /// Withdraw all matched proceeds + unmatched residual from the trader's
    /// free-funds back into the pool. Standard non-zero delta shape:
    /// `expected_out_mint` is bound to either base or quote mint of the
    /// market; `expected_out_value` is the user's floor.
    WithdrawFunds {
        market: Pubkey,
        /// Which side to withdraw — base, quote, or both (encoded as bitmask).
        sides: u8,
    },
}
```

`PlaceMultiplePostOnlyOrders` (Phoenix variant 16) is intentionally deferred — it's a maker-grid primitive useful for market makers, but the single-order path is the right MVP.

### 5.5 Optional: PRD-14 two-phase claim

PRD-14 §6 lists "Phoenix limit order — match-conditional" as a target use case. There are two ways to model the maker flow:

**(b.1) — Without two-phase (recommended for v1).** `PlaceLimitOrder` spends the input note immediately (delta-zero out). The user's *expectation* of a fill is purely off-chain. If the order never fills, the user calls `CancelOrdersById` then `WithdrawFunds` to recover the input. No claim notes, no settle circuit. Simpler.

**(b.2) — With two-phase.** `PlaceLimitOrder` spends the input note but issues a *claim note* per PRD-14 §3. On match, `WithdrawFunds` settles the claim into a normal output note. On no-match past `deadline_slot`, user redeems the claim note for the original input. Higher infrastructure cost (settle + redeem circuits) but cleaner UX and preserves atomicity-style guarantees.

**Recommendation:** ship (b.1) for Phase B. PRD-14 §1 explicitly says "no implementation work is scheduled until a real async adapter is the next integration target" — Phase B *is* that target, but the simpler model is enough to validate the pattern and get private maker orders in users' hands. (b.2) becomes Phase B.5 after Phase B mainnet-fork tests are green and we know the actual cancel-rate distribution.

### 5.6 Bounding `Vec<u128>` cancellations

`action_payload` is capped at 400 B (PRD-04 §5.3). 32 client-order-ids = 32 × 16 = 512 B — over budget. Phase B caps `CancelOrdersById::client_order_ids.len() <= 16` for a per-tx cancellation budget of 256 B. SDK chunks larger cancellation sets across multiple txs.

### 5.7 Validation plan (Phase B)

In addition to Phase A's tests:

4. **Litesvm: place + cancel + withdraw** path against the adapter only (no real Phoenix); pins CU per phase.
5. **Mainnet-fork: place an order, simulate a counter-side taker fill via a second test wallet, withdraw, assert matched proceeds.**
6. **Mainnet-fork: place an order, never fill, cancel after N slots, withdraw, assert input fully recovered minus Phoenix's per-cancel rent reclaim.**
7. **Assurance probe: `phoenix_maker_full_path`** — same shape as the `kamino_deposit_full_path` issue (#24).

### 5.8 CU budget projection (Phase B)

| Op | Phoenix CPI CU | Adapter overhead | Pool handler | Total |
|---|---|---|---|---|
| `PlaceLimitOrder` | ~85k | ~16k | ~325k | ~426k |
| `CancelOrdersById` (1 id) | ~30k | ~16k | ~325k | ~371k |
| `WithdrawFunds` | ~50k | ~16k | ~325k | ~391k |

All under cap.

---

## 6. Phase C — Phoenix Rise (perpetuals)

### 6.1 Scope

Private perpetuals via Phoenix Rise. Equivalent feature surface to PRD-16 (Adrena), targeted at Phoenix Rise's specific account model.

### 6.2 Why this is gated

Per §2 — the Rise on-chain program is currently in private beta with no published program ID, no open-source release, and no documented CPI integration path. The published Rise SDK (`docs.phoenix.trade/sdk/rise`) is HTTP-first (`PhoenixHttpClient`, `PhoenixTxBuilder`, `client.streams`), oriented at retail / wallet integrations, not at on-chain composability.

We **explicitly reject** any path where b402's adapter would relay user actions through Phoenix's centralized HTTP endpoints — that breaks the trust model. b402's privacy property is that *no third party* (relayer, indexer, HTTP gateway) learns the (action, user) linkage. Routing through `perp-api.phoenix.trade` would put Phoenix's server squarely in that link.

### 6.3 Triggers to start Phase C

This PRD remains in spike state for Phase C until **at least one** of the following is true:

1. Phoenix Foundation publishes:
   - Mainnet program ID(s) for the Rise on-chain program(s).
   - Open IDL or source under any OSS license.
   - At least one example of CPI invocation from a non-Phoenix program.
2. b402 reaches a direct partnership with Phoenix and gets a signed integration brief covering ABI stability and audit access.
3. The Rise program is upgraded to permissionless / open-CPI mode (the Adrena precedent).

When any trigger fires, this section is replaced with an Adrena-style PRD-16-shaped spec, likely as a separate PRD-25 to keep this one tractable.

### 6.4 Architectural fit (forward-look)

Provisionally, Rise looks like an Adrena-shaped adapter (per-user position PDA, synchronous fills against book + spline liquidity, no keeper). If that holds, the existing PRD-13 + PRD-15 + PRD-04 §7 machinery is sufficient — same as Adrena. A reserved scope_tag `phoenix-rise:position:v1` is suggested in this PRD's open questions for PRD-13's table.

---

## 7. SDK surface

The SDK adds one new venue parameter to `B402Solana.privateSwap`:

```ts
const result = await b402.privateSwap({
  inMint: USDC,
  outMint: WSOL,
  amount: 100_000_000n,
  slippageBps: 50,
  venue: 'phoenix',  // 'jupiter' (default) | 'phoenix'
});
```

Phase B adds a new top-level method:

```ts
// Phase B
const orderId = await b402.placeLimitOrder({
  venue: 'phoenix',
  market: SOL_USDC_MARKET,
  side: 'buy',
  priceTicks: 14_500_000n,
  sizeBaseLots: 1_000n,
  selfTradeBehavior: 'abort',
});

const cancelTx = await b402.cancelOrders({ venue: 'phoenix', orderIds: [orderId] });

const withdrawTx = await b402.withdrawFromVenue({ venue: 'phoenix', market: SOL_USDC_MARKET });
```

Method shape kept generic on `venue` to leave room for additional CLOB venues (Manifest, OpenBook v2) without further public-API change.

---

## 8. Hard vs soft

**Hard:**
- Phase split (A → B → C). Phase A ships under existing v1 ABI with no spec changes.
- `phoenix:trader:v1` scope_tag (already reserved in PRD-13 §4).
- BUSL-1.1 license posture: b402 adapter does **not** redistribute Phoenix v1 source — it CPIs the deployed program. BUSL-1.1's "use limitation" forbids running a derivative service that competes; b402 runs the original Phoenix bytecode unmodified, so the use limitation does not apply to the adapter. Same legal posture as Adrena's GPL-3.0 (PRD-16 §2.1).

**Soft:**
- Whether `WithdrawFunds` is a separate `PhoenixAction` variant or auto-bundled into `Swap` / `PlaceLimitOrder` post-amble. Tentative: separate, for explicit two-phase semantics.
- Whether to register two adapters (taker vs maker) or one with all variants. Tentative: one adapter, multiple `AllowedInstruction` registry rows.

---

## 9. Rejected alternatives

- **Aggregate Phoenix routing through Jupiter only.** Already happens implicitly (Jupiter does route through Phoenix when liquid). But Jupiter does not expose Phoenix maker primitives, and Phase B's "private resting order" use case is the one users actually ask for.
- **Wait for Manifest/OpenBook v2.** Manifest is younger and lower volume; OpenBook v2 has slower throughput than Phoenix v1. Phoenix v1 is the right CLOB to integrate first.
- **Build Phase C against a reverse-engineered Rise IDL.** Bytecode access without license clearance is bad form and fragile to upgrades. Wait for a public surface.

---

## 10. Open questions

1. **Pool's CPI discriminator check length.** PRD-04 §7's `AllowedInstruction.discriminator: [u8; 8]` assumes Anchor's 8-byte discriminator. Phoenix v1 uses a 1-byte enum tag. Either (a) extend `AllowedInstruction` with `discriminator_len: u8`, or (b) require the registry entry to encode `[0x00, ..first_7_bytes_of_typical_SwapParams..]` and accept that two distinct `Swap` calls with different params land at different registry entries (bad). Tentative: (a). Cost is one byte per registry row.
2. **Phoenix v1 Seat lifecycle.** `RequestSeat` requires governance approval (or `RequestSeatAuthorized` via Phoenix's seat-manager program). Phase B needs an automatic seat-claim path — does the adapter call `RequestSeatAuthorized` lazily on first `PlaceLimitOrder`, or do we pre-claim seats at adapter-deploy time for top-N markets?
3. **Withdraw atomicity vs frequency.** Maker fills accrue into TraderState. Forcing per-fill withdrawals is gas-expensive; accumulating across many fills means the user's free-funds sit on Phoenix between actions. Tentative: lazy withdraw (user-triggered or batched by SDK). Documents the privacy trade-off (Phoenix sees the user's free-funds balance over time).
4. **Phase C trigger criteria.** Are the §6.3 triggers the right ones? Worth a separate Phoenix-team conversation before this PRD is signed off.
5. **Reservation of `phoenix-rise:position:v1` in PRD-13 §4.** Add as a "reserved" row now to prevent collision, even though Phase C is deferred?

---

## 11. Revision history

| Version | Date | Author | Changes |
|---|---|---|---|
| 0.1 | 2026-04-28 | b402 core | Initial spike. Phased plan A/B/C; Rise (perps) explicitly deferred until public CPI surface. |

---

## 12. Sign-off

| Role | Name | Date | Status |
|---|---|---|---|
| Solana/Anchor review |  |  |  |
| Adapter lead |  |  |  |
| Circuit lead |  |  |  |
| Final approval |  |  |  |

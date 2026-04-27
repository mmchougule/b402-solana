//! b402_adrena_adapter — Adrena perpetuals adapter for the b402 shielded pool.
//!
//! Per PRD-16. First adapter on the new ABI (PRD-11..15). Called by `b402_pool`
//! via CPI after IN-mint tokens (USDC collateral) have been moved into this
//! adapter's `adapter_in_ta`. The adapter then composes Adrena's open /
//! increase / close / liquidate-guardrail instructions and transfers any
//! released collateral and realised PnL back to the pool's `out_vault`.
//!
//! ABI per PRD-04 §2 — unified `execute(in_amount, min_out, action_payload)`.
//! The `action_payload` is the Borsh-serialised `AdrenaAction` enum.
//!
//! Honesty is verified post-CPI by the pool's balance-delta invariant —
//! the adapter is trusted only to "try hard"; not to report honestly.
//!
//! ## Status (v0.0.1)
//!
//! Payload type + RED test scaffold only. Handler returns
//! `AdrenaAdapterError::NotYetImplemented`. The next PR will implement
//! `execute()` against a fork validator using the per-ix account lists
//! documented inline below.
//!
//! ## Adrena facts (verified 2026-04-26)
//!
//! - Program ID: `13gDzEXCdocbj8iAiqrScGo47NiSuYENGsRqi3SEAwet` (verified
//!   against `AdrenaFoundation/adrena-abi/idl/adrena.json` `address` field).
//! - License: GPL-3.0. CPI is not a derivative work — adapter ships under
//!   b402's chosen license (PRD-16 §2.1).
//! - Audit: Ottersec (one shipped, second in progress per Adrena docs).
//! - Architecture: synchronous on-chain, no off-chain keeper, no request
//!   queue — fits PRD-15's sync-only constraint cleanly.
//!
//! ## Position PDA seeds (verified 2026-04-26 against
//! `AdrenaFoundation/adrena-abi/src/pda.rs::get_position_pda`)
//!
//! ```text
//! position = PDA(
//!     ["position", owner, pool, custody, &[side]],
//!     ADRENA_PROGRAM_ID,
//! )
//! ```
//!
//! NOTE: PRD-16 spec listed seeds as `["position", owner, custody, side]`
//! (missing `pool`). The IDL repo's `get_position_pda` includes `pool` as
//! the third seed. This adapter ships against the verified IDL scheme.
//! See `// TODO(verify):` notes below.
//!
//! ## Per-user shadow PDA (PRD-13)
//!
//! ```text
//! shadow_pda = PDA(
//!     ["b402-shadow", ADRENA_PROGRAM_ID, "adrena:position:v1", viewing_key_commitment],
//!     b402_adrena_adapter,
//! )
//! ```
//!
//! Per PRD-16 §4. The shadow PDA *is* the Adrena Position PDA — Adrena's
//! own program owns it; b402 binds via `note_aux_binding` (PRD-04 §7.2).

use anchor_lang::prelude::*;

declare_id!("9aUp3UKHk4JuHsLJm33Why7RhuW6CQCyQh6UEJeynKKZ");

// ---------------------------------------------------------------------------
// Adrena-specific addresses + discriminators.
//
// All instruction discriminators below are first-8-bytes of the IDL's own
// declared discriminator array, verified 2026-04-26 against
// `AdrenaFoundation/adrena-abi/idl/adrena.json` (`address: 13gDzEXCdocbj8...`).
//
// Anchor's standard scheme is `sha256("global:<snake_case_ix_name>")[..8]`.
// Adrena's IDL-declared discriminators MATCH that scheme for the ones we
// audited (open/close/increase/liquidate share the Anchor framing).
// ---------------------------------------------------------------------------

/// Adrena perpetuals program ID.
/// IDL: verified 2026-04-26 — `idl/adrena.json::address` =
/// `13gDzEXCdocbj8iAiqrScGo47NiSuYENGsRqi3SEAwet`.
pub const ADRENA_PROGRAM_ID: Pubkey =
    anchor_lang::pubkey!("13gDzEXCdocbj8iAiqrScGo47NiSuYENGsRqi3SEAwet");

// --------- Verified IDL ix discriminators (per AdrenaFoundation/adrena-abi) ---
//
// IMPORTANT: Adrena does NOT expose generic `open_position` / `close_position`
// / `liquidate_position` instructions. Long and short are separate ixs.
// Partial close is `close_position_*` with `params.percentage`. The
// `AdrenaAction` enum in this crate dispatches to the correct long/short
// pair via the `side` byte at handler time.
//
// Each discriminator below is the IDL's `instructions[*].discriminator`
// field — Anchor's `sha256("global:<ix_name>")[..8]`, confirmed by the
// Adrena maintainers' own tooling.

/// `open_position_long` discriminator.
/// IDL: verified 2026-04-26 against AdrenaFoundation/adrena-abi master.
pub const ADRENA_IX_OPEN_POSITION_LONG: [u8; 8] = [224, 114, 146, 60, 127, 166, 244, 56];

/// `open_position_short` discriminator.
/// IDL: verified 2026-04-26 against AdrenaFoundation/adrena-abi master.
pub const ADRENA_IX_OPEN_POSITION_SHORT: [u8; 8] = [196, 212, 161, 82, 250, 39, 201, 102];

/// `increase_position_long` discriminator.
/// IDL: verified 2026-04-26 against AdrenaFoundation/adrena-abi master.
pub const ADRENA_IX_INCREASE_POSITION_LONG: [u8; 8] = [253, 45, 99, 159, 1, 124, 132, 43];

/// `increase_position_short` discriminator.
/// IDL: verified 2026-04-26 against AdrenaFoundation/adrena-abi master.
pub const ADRENA_IX_INCREASE_POSITION_SHORT: [u8; 8] = [115, 188, 112, 206, 233, 246, 231, 166];

/// `close_position_long` discriminator. Adrena uses `params.percentage` (u64,
/// 1e10 = 100%) for partial closes — no separate `decrease_position` ix.
/// IDL: verified 2026-04-26 against AdrenaFoundation/adrena-abi master.
pub const ADRENA_IX_CLOSE_POSITION_LONG: [u8; 8] = [50, 66, 35, 214, 218, 31, 152, 68];

/// `close_position_short` discriminator.
/// IDL: verified 2026-04-26 against AdrenaFoundation/adrena-abi master.
pub const ADRENA_IX_CLOSE_POSITION_SHORT: [u8; 8] = [158, 216, 38, 16, 140, 37, 15, 131];

/// `liquidate_long` discriminator. Permissionless on Adrena — anyone can call
/// once `get_liquidation_state` returns liquidatable. b402's
/// `LiquidateGuardrail` action front-runs Adrena's own keepers when the
/// adapter caller specifies a health-factor floor.
/// IDL: verified 2026-04-26 against AdrenaFoundation/adrena-abi master.
pub const ADRENA_IX_LIQUIDATE_LONG: [u8; 8] = [132, 118, 230, 137, 241, 193, 136, 93];

/// `liquidate_short` discriminator.
/// IDL: verified 2026-04-26 against AdrenaFoundation/adrena-abi master.
pub const ADRENA_IX_LIQUIDATE_SHORT: [u8; 8] = [197, 62, 252, 198, 25, 93, 177, 131];

// --------- Anchor-namespace discriminators per PRD-16 brief ----------------
//
// The brief asked for `sha256("global:<name>")[..8]` for the abstract names
// `open_position` / `increase_position` / `decrease_position` /
// `close_position` / `liquidate_position`. These are NOT actual Adrena ixs —
// kept here for review parity with the brief; do NOT use in CPI dispatch.
//
// IDL: pending verification — Adrena does not define these names. Confirm
// that no Adrena release introduces a generic `open_position` umbrella ix.

/// `sha256("global:open_position")[..8]` — NOT an Adrena ix; reference only.
/// IDL: pending verification — confirm against AdrenaFoundation/adrena-program master.
#[doc(hidden)]
pub const ADRENA_IX_OPEN_POSITION_GENERIC: [u8; 8] = [135, 128, 47, 77, 15, 152, 240, 49];

/// `sha256("global:increase_position")[..8]` — NOT an Adrena ix; reference only.
/// IDL: pending verification — confirm against AdrenaFoundation/adrena-program master.
#[doc(hidden)]
pub const ADRENA_IX_INCREASE_POSITION_GENERIC: [u8; 8] = [253, 234, 128, 104, 192, 188, 45, 91];

/// `sha256("global:decrease_position")[..8]` — NOT an Adrena ix; reference only.
/// Adrena uses `close_position_*` with `percentage` instead.
/// IDL: pending verification — confirm against AdrenaFoundation/adrena-program master.
#[doc(hidden)]
pub const ADRENA_IX_DECREASE_POSITION_GENERIC: [u8; 8] = [57, 125, 21, 59, 200, 137, 179, 108];

/// `sha256("global:close_position")[..8]` — NOT an Adrena ix; reference only.
/// IDL: pending verification — confirm against AdrenaFoundation/adrena-program master.
#[doc(hidden)]
pub const ADRENA_IX_CLOSE_POSITION_GENERIC: [u8; 8] = [123, 134, 81, 0, 49, 68, 98, 98];

/// `sha256("global:liquidate_position")[..8]` — NOT an Adrena ix; reference only.
/// IDL: pending verification — confirm against AdrenaFoundation/adrena-program master.
#[doc(hidden)]
pub const ADRENA_IX_LIQUIDATE_POSITION_GENERIC: [u8; 8] = [187, 74, 229, 149, 102, 81, 221, 68];

/// PDA seed prefix for the Adrena scope (PRD-13 / PRD-16 §4).
pub const SEED_ADRENA_SHADOW: &[u8] = b"adrena:position:v1";
/// Versioned namespace shared with the rest of b402.
pub const VERSION_PREFIX: &[u8] = b"b402/v1";
/// PDA seed for adapter authority. Same scheme as every b402 adapter.
pub const SEED_ADAPTER: &[u8] = b"adapter";

/// Action variants the adapter exposes. Borsh-encoded inside `action_payload`.
///
/// Each variant maps to one Adrena state-changing ix. Note that Adrena
/// has separate `*_long` / `*_short` ixs; the `side` byte routes the
/// dispatch at handler time. The pool binds `keccak(action_payload)` and
/// `expected_out_mint` into the proof's `action_hash`, so a relayer cannot
/// substitute one variant for another.
///
/// ### `expected_out_mint` / `expected_out_value` semantics (PRD-16 §3)
///
/// - `OpenPosition`: **delta-zero** for the success path — collateral flows
///   IN-vault → adapter_in_ta → Adrena custody; nothing comes back.
///   `expected_out_mint = default()` triggers the pool's delta-zero
///   exemption (PRD-04 §7.1).
/// - `IncreasePosition`: same delta-zero shape as OpenPosition.
/// - `DecreasePosition`: dual-delta — Adrena releases collateral plus
///   realised PnL on the closed slice. **Adrena does not have a
///   `decrease_position` ix; the handler dispatches to
///   `close_position_long/short` with `params.percentage < 1e10`.**
/// - `ClosePosition`: full close — Adrena releases all remaining collateral
///   plus realised PnL. Handler dispatches to `close_position_long/short`
///   with `params.percentage = 1e10` (100%).
/// - `LiquidateGuardrail`: opt-in pre-liquidation close. Handler validates
///   that Adrena's `get_liquidation_state` would return liquidatable; if
///   so, dispatches `close_position_*` (NOT `liquidate_*` — liquidation
///   pays a keeper fee that the user wants to avoid). PRD-16 §3 row.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq, Eq)]
pub enum AdrenaAction {
    /// Open a new perp position. Maps to `open_position_long` (side=0) or
    /// `open_position_short` (side=1).
    OpenPosition {
        /// Adrena custody account (per-asset PDA derived under the Adrena
        /// program). Identifies the underlying market (SOL/ETH/BTC perp).
        /// Adapter passes through; pool does not bind it (Adrena enforces).
        custody: Pubkey,
        /// 0 = long, 1 = short. Adapter rejects any other value.
        side: u8,
        /// Collateral amount in the collateral mint (typically USDC).
        /// Must equal `pi.public_amount_in`.
        collateral_amount: u64,
        /// Notional position size in USD (Adrena's `params.collateral *
        /// (leverage / 1e4)` — adapter computes Adrena's `leverage: u32`
        /// from `size_usd` and `collateral_amount` at handler time).
        size_usd: u64,
        /// Slippage cap on entry price in basis points
        /// (10000 = 100%, typical 50 = 0.5%). Adapter converts to Adrena's
        /// `params.price` (u64) limit at handler time.
        slippage_bps: u16,
    },

    /// Add collateral and/or notional size to an existing position.
    /// Maps to `increase_position_long/short`.
    IncreasePosition {
        /// Position PDA (derived from `["position", owner, pool, custody,
        /// &[side]]` under the Adrena program — see module doc). Adapter
        /// passes through; pool binds via `note_aux_binding`.
        position: Pubkey,
        /// Additional collateral to deposit. May be zero if only sizing up.
        collateral_delta: u64,
        /// Additional notional size in USD. May be zero if only adding
        /// collateral (margin top-up).
        size_delta_usd: u64,
        /// Slippage cap on the new portion in bps.
        slippage_bps: u16,
    },

    /// Reduce an existing position partially. Adrena releases proportional
    /// collateral plus realised PnL on the closed slice. Handler dispatches
    /// to `close_position_long/short` with `params.percentage < 1e10`.
    DecreasePosition {
        position: Pubkey,
        /// Collateral to release (independent of size change). Used by the
        /// adapter to compute the percentage to close.
        collateral_delta: u64,
        /// Notional size in USD to close.
        size_delta_usd: u64,
        /// Slippage cap on exit price in bps.
        slippage_bps: u16,
    },

    /// Close the entire position. Handler dispatches `close_position_*`
    /// with `params.percentage = 1e10` (100% — Adrena's full-close
    /// convention).
    ClosePosition {
        position: Pubkey,
        /// Slippage cap on exit price in bps.
        slippage_bps: u16,
    },

    /// Pre-liquidation guardrail: close the position iff Adrena's
    /// `get_liquidation_state` reports a health factor at or below
    /// `max_health_factor_bps`. Lets the user exit before Adrena's
    /// permissionless liquidator does (which keeps a fee — see PRD-16 §3).
    /// Adapter rejects with `HealthAboveThreshold` if Adrena's runtime
    /// would not actually liquidate at execution time.
    LiquidateGuardrail {
        position: Pubkey,
        /// Health-factor threshold in bps (10000 = 100%, fully healthy).
        /// Adapter aborts with `HealthAboveThreshold` if Adrena reports a
        /// higher value at execution time.
        max_health_factor_bps: u16,
    },
}

#[program]
pub mod b402_adrena_adapter {
    use super::*;

    /// Execute the Adrena action encoded in `action_payload`.
    ///
    /// Not yet implemented. See PRD-16 §6 for the per-action delta strategy
    /// and §5 for the action payload semantics.
    ///
    /// Once implemented, the handler MUST:
    ///   1. Borsh-decode `action_payload` → `AdrenaAction` variant.
    ///   2. Sanity-check `side` ∈ {0, 1}; reject `InvalidSide` otherwise.
    ///   3. Dispatch to the long or short ix based on `side` (or the
    ///      position's recorded side for the variants that don't carry one).
    ///   4. CPI Adrena under the adapter PDA's signer seeds. Adrena
    ///      validates oracles + custody + position PDA membership.
    ///   5. Post-CPI sweep: `adapter_out_ta → out_vault` for Decrease /
    ///      Close / LiquidateGuardrail releases. For Open / Increase the
    ///      delta-invariant is delta-zero (collateral fully consumed); on
    ///      partial-fill failure Adrena refunds to `adapter_in_ta`.
    ///
    /// Honesty is verified post-CPI by the pool's `out_vault.amount` delta
    /// invariant against `expected_out_value`. Adapter only needs to "try
    /// hard"; under-delivery causes the pool to revert atomically.
    pub fn execute(
        _ctx: Context<Execute>,
        _in_amount: u64,
        _min_out_amount: u64,
        _action_payload: Vec<u8>,
    ) -> Result<()> {
        err!(AdrenaAdapterError::NotYetImplemented)
    }
}

/// Account layout per PRD-04 §2 — first 6 are pool-managed; remainder
/// forwarded. Adrena-specific accounts (transfer_authority, cortex, pool,
/// position, custody, collateral_custody, oracle, collateral_custody_token_account,
/// optional user_profile / referrer_profile, plus adrena_program / system_program /
/// token_program) come in via `remaining_accounts` and are passed verbatim
/// to Adrena CPIs.
///
/// ## Per-ix account ordering (verified 2026-04-26 against
/// `AdrenaFoundation/adrena-abi/idl/adrena.json`)
///
/// ### `open_position_long` / `open_position_short` (17 accounts, last 2 optional)
/// ```text
///   0: owner                                  [          ]   (signer iff caller != transfer_authority)
///   1: caller                                 [        si]
///   2: payer                                  [   mut, si]
///   3: funding_account                        [   mut    ]
///   4: transfer_authority                     [          ]   pda=["transfer_authority"]
///   5: cortex                                 [   mut    ]   pda=["cortex"]
///   6: pool                                   [   mut    ]   pda=["pool", account:pool]
///   7: position                               [   mut    ]   pda=["position", owner, pool, custody, &[side]]
///   8: custody                                [   mut    ]
///   9: collateral_custody                     [   mut    ]   (= custody for non-synthetic longs; stable for synthetic)
///  10: oracle                                 [   mut    ]   pda=["oracle"]
///  11: collateral_custody_token_account       [   mut    ]
///  12: system_program                         [          ]
///  13: token_program                          [          ]
///  14: adrena_program                         [          ]
///  15: user_profile                           [   mut, op]   pda=["user_profile", account:owner]
///  16: referrer_profile                       [   mut, op]
/// ```
/// Args: `params: OpenPosition{Long,Short}Params { price: u64, collateral: u64, leverage: u32,
///        oracle_prices: Option<BatchPrices>, multi_oracle_prices: Option<MultiBatchPrices> }`
/// NOTE: AdrenaAction has `size_usd` + `slippage_bps`; the handler converts to
/// `(price, collateral, leverage)` at CPI time. `leverage` is u32 in 1e4 scale
/// (e.g. 50000 = 5x). `price` is the limit-price floor (long) or ceiling (short)
/// in 1e10 fixed-point.
/// `// TODO(verify):` confirm leverage / price scaling factors at impl time.
///
/// ### `increase_position_long` / `increase_position_short` (17 accounts, mirrors open)
/// Same shape as open. Same params struct (`IncreasePosition{Long,Short}Params`).
///
/// ### `close_position_long` / `close_position_short` (16 accounts, last 2 optional)
/// ```text
///   0: caller                                 [   mut, si]
///   1: owner                                  [   mut    ]
///   2: receiving_account                      [   mut    ]
///   3: transfer_authority                     [          ]   pda=["transfer_authority"]
///   4: cortex                                 [   mut    ]   pda=["cortex"]
///   5: pool                                   [   mut    ]   pda=["pool", account:pool]
///   6: position                               [   mut    ]
///   7: custody                                [   mut    ]
///   8: oracle                                 [   mut    ]   pda=["oracle"]
///   9: collateral_custody                     [   mut    ]
///  10: collateral_custody_token_account       [   mut    ]
///  11: user_profile                           [   mut, op]   pda=["user_profile", account:owner]
///  12: referrer_profile                       [   mut, op]
///  13: token_program                          [          ]
///  14: adrena_program                         [          ]
///  15: system_program                         [          ]
/// ```
/// Args: `params: ClosePosition{Long,Short}Params { price: Option<u64>,
///        oracle_prices: Option<BatchPrices>, multi_oracle_prices: Option<MultiBatchPrices>,
///        percentage: u64 }` — `percentage` is u64 in 1e10 scale; `1e10 = 100%`.
/// AdrenaAction::ClosePosition → percentage = 10_000_000_000 (full close).
/// AdrenaAction::DecreasePosition → percentage = (size_delta_usd / current_size) * 1e10,
/// computed at handler time (or passed via slippage_bps mapping — see PRD §5).
/// `// TODO(verify):` confirm percentage scaling factor (1e10) at impl time.
///
/// ### `liquidate_long` / `liquidate_short` (15 accounts, last 2 optional)
/// ```text
///   0: signer                                 [   mut, si]
///   1: receiving_account                      [   mut    ]
///   2: transfer_authority                     [          ]   pda=["transfer_authority"]
///   3: cortex                                 [   mut    ]   pda=["cortex"]
///   4: pool                                   [   mut    ]   pda=["pool", account:pool]
///   5: position                               [   mut    ]
///   6: custody                                [   mut    ]
///   7: oracle                                 [   mut    ]   pda=["oracle"]
///   8: collateral_custody                     [   mut    ]
///   9: collateral_custody_token_account       [   mut    ]
///  10: user_profile                           [   mut, op]   pda=["user_profile", account:position]
///  11: referrer_profile                       [   mut, op]
///  12: token_program                          [          ]
///  13: adrena_program                         [          ]
///  14: system_program                         [          ]
/// ```
/// Args: `params: Liquidate{Long,Short}Params { oracle_prices: Option<BatchPrices>,
///        multi_oracle_prices: Option<MultiBatchPrices> }` — no quantity args.
/// NOTE: b402's `LiquidateGuardrail` does NOT call `liquidate_*` — calling
/// liquidate pays the keeper fee to the signer. The user wants to avoid
/// that, so the handler dispatches `close_position_*` with `percentage=1e10`
/// AFTER verifying via `get_liquidation_state` that Adrena's runtime would
/// in fact liquidate. `liquidate_*` discriminators kept here in case the
/// adapter eventually offers a "liquidate-others" mode for keepers.
#[derive(Accounts)]
pub struct Execute<'info> {
    /// Adapter's PDA signer for any token movements and position auth.
    /// CHECK: seeds enforced; not deserialised.
    #[account(seeds = [VERSION_PREFIX, SEED_ADAPTER], bump)]
    pub adapter_authority: SystemAccount<'info>,

    /// CHECK: pool's IN-mint vault. Adapter never writes here directly —
    /// pool moves `in_amount` before the CPI; adapter only reads if
    /// needed for refund accounting.
    #[account(mut)]
    pub in_vault: AccountInfo<'info>,

    /// CHECK: pool's OUT-mint vault. Adapter writes here on
    /// Decrease / Close / LiquidateGuardrail releases and on partial-fill
    /// refunds from Open / Increase.
    #[account(mut)]
    pub out_vault: AccountInfo<'info>,

    /// CHECK: adapter's IN-mint scratch ATA, owned by `adapter_authority`.
    /// Pool pre-transferred `in_amount` here.
    #[account(mut)]
    pub adapter_in_ta: AccountInfo<'info>,

    /// CHECK: adapter's OUT-mint scratch ATA. Receives Adrena's CPI output
    /// before being swept to `out_vault`.
    #[account(mut)]
    pub adapter_out_ta: AccountInfo<'info>,

    /// CHECK: SPL Token program.
    pub token_program: AccountInfo<'info>,
}

#[error_code]
pub enum AdrenaAdapterError {
    #[msg("Adrena adapter not yet implemented — PRD-16 awaiting impl sign-off")]
    NotYetImplemented,
    #[msg("Unrecognised action_payload (Borsh decode failed)")]
    InvalidActionPayload,
    #[msg("expected_out_mint does not match the position's collateral mint")]
    MintMismatch,
    #[msg("Adrena CPI failed; oracle stale, custody disabled, or position unhealthy")]
    AdrenaCpiFailed,
    #[msg("side byte must be 0 (long) or 1 (short)")]
    InvalidSide,
    #[msg("invalid amount (must be > 0)")]
    InvalidAmount,
    #[msg("adapter_in_ta has insufficient balance for the requested op")]
    InsufficientInput,
    #[msg("scratch ATA owner is not the adapter PDA")]
    ScratchAtaOwnerMismatch,
    #[msg("missing Adrena-side accounts in remaining_accounts (see lib.rs per-ix list)")]
    MissingRemainingAccounts,
    #[msg("post-Adrena delivery below the user's slippage floor")]
    SlippageExceeded,
    #[msg("AdrenaAction.amount field disagrees with ABI in_amount")]
    AmountMismatch,
    #[msg("LiquidateGuardrail aborted: Adrena reports health factor above threshold")]
    HealthAboveThreshold,
    #[msg("Adrena custody is currently disabled for trades / swaps")]
    CustodyDisabled,
    #[msg("Adrena leverage parameter out of allowed range (per custody config)")]
    LeverageOutOfRange,
}

// ---------------------------------------------------------------------------
// Helper: per-user shadow PDA derivation (PRD-13 / PRD-16 §4).
//
// Used by the SDK to compute the shadow pubkey that anchors note_aux_binding.
// Exposed at the crate level so the SDK and tests can derive it without
// duplicating the seed scheme.
// ---------------------------------------------------------------------------

/// Derive the per-user Adrena shadow PDA from `viewing_key_commitment`.
/// Per PRD-16 §4:
///
/// ```text
/// shadow_pda = PDA(
///     [b"b402/v1", b"b402-shadow", ADRENA_PROGRAM_ID, b"adrena:position:v1", viewing_key_commitment],
///     b402_adrena_adapter,
/// )
/// ```
///
/// The pool's circuit binds `viewing_key_commitment` to the shadow PDA via
/// `note_aux_binding`, so a relayer cannot substitute another user's
/// position.
pub fn derive_shadow_pda(viewing_key_commitment: &[u8; 32]) -> (Pubkey, u8) {
    Pubkey::find_program_address(
        &[
            VERSION_PREFIX,
            b"b402-shadow",
            ADRENA_PROGRAM_ID.as_ref(),
            SEED_ADRENA_SHADOW,
            viewing_key_commitment.as_ref(),
        ],
        &crate::ID,
    )
}

/// Derive the Adrena Position PDA per
/// `AdrenaFoundation/adrena-abi/src/pda.rs::get_position_pda` (verified
/// 2026-04-26):
///
/// ```text
/// position = PDA(
///     [b"position", owner, pool, custody, &[side]],
///     ADRENA_PROGRAM_ID,
/// )
/// ```
///
/// `// TODO(verify):` confirm seed order against on-chain Position account
/// at first integration test (mainnet-fork open + read-back).
pub fn derive_adrena_position_pda(
    owner: &Pubkey,
    pool: &Pubkey,
    custody: &Pubkey,
    side: u8,
) -> (Pubkey, u8) {
    Pubkey::find_program_address(
        &[
            b"position",
            owner.as_ref(),
            pool.as_ref(),
            custody.as_ref(),
            &[side],
        ],
        &ADRENA_PROGRAM_ID,
    )
}

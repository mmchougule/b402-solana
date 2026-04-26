//! b402_jupiter_perps_adapter — Jupiter Perpetuals adapter for the b402
//! shielded pool.
//!
//! Replaces PRD-10 (Drift) as the lead perps target while Drift completes
//! its post-hack reboot (April 2026 incident, $285M loss, audits pending).
//! PRD-10 is kept on file as the eventual second perps adapter once Drift
//! re-launches; this crate is the new lead.
//!
//! Per the per-protocol adapter model (PRD-04 §2 + PRD-09 pattern, applied
//! to Jupiter Perps). Called by `b402_pool` via CPI after IN-mint tokens
//! (collateral, typically USDC) have been moved into this adapter's
//! `adapter_in_ta`. The adapter then composes Jupiter Perps' position-open
//! / size-modify / close instructions and transfers any released collateral
//! and PnL back to the pool's `out_vault`.
//!
//! ABI per PRD-04 §2. Post-CPI balance check is performed by the pool — the
//! adapter is trusted only to try hard; honesty is verified by delta.
//!
//! ## Status
//!
//! v0.0.1 — payload type + RED test scaffold. Handler not yet implemented.
//! See `tests/payload.rs` for the TDD test list. Implementation lands when
//! the Jupiter-Perps-adapter PRD §6 (account layout, custody discovery,
//! oracle list) is signed off.
//!
//! ## Per-user position PDA
//!
//! Jupiter Perps positions are PDA-derived from the position owner. For
//! shielded perps the adapter owns the position PDA, derived from the
//! user's viewing-key hash so the relayer cannot grief by touching other
//! users' positions:
//!
//! ```text
//! [b"b402/v1", b"jup-perps-pos", viewing_pub_hash[..32], market_index.to_le_bytes()]
//! ```
//!
//! The hash binding lands in the proof's `note_aux_binding` public input
//! (PRD-04 §7.2) — the relayer cannot forge `viewing_pub_hash` without the
//! user's viewing key.

use anchor_lang::prelude::*;

declare_id!("GRAiy9K5w2GCbicwJKNbKzaKRcr3PmvSqYGp4XZgfBYm");

/// Jupiter Perpetuals program ID (verify against live IDL at deploy time).
pub const JUPITER_PERPS_PROGRAM_ID: Pubkey = anchor_lang::pubkey!(
    "PERPHjGBqRHArX4DySjwM6UJHiR3sWAatqfdBS2qQJu"
);

/// Action variants the adapter exposes. Borsh-encoded inside `action_payload`.
///
/// Each variant corresponds to a single Jupiter Perps state-changing
/// operation. The pool binds `keccak(action_payload)` and `expected_out_mint`
/// into the proof's `action_hash`, so a relayer cannot substitute one
/// variant for another.
///
/// ### `expected_out_mint` / `expected_out_value` semantics
///
/// - `OpenPosition`: **delta-zero** for the success path (collateral flows
///   IN-vault → adapter_in_ta → Jupiter custody; nothing comes back). On
///   the failure / partial-fill path Jupiter refunds unused collateral to
///   `adapter_out_ta`; the pool's delta-invariant accepts a refund up to
///   `collateral_amount`. `expected_out_mint = collateral_mint`,
///   `expected_out_value = 0` (floor only — refund welcome).
/// - `IncreasePosition`: same shape as OpenPosition's add-collateral path.
/// - `DecreasePosition`: **dual-delta** — Jupiter releases collateral plus
///   any realised PnL (which can be negative on a loss-taking close). The
///   pool's two-vault delta-invariant must accept a non-negative net
///   release; final accounting lives in the PRD.
/// - `ClosePosition`: same shape as DecreasePosition for full close.
/// - `LiquidateGuardrail`: opt-in pre-liquidation close. Same delta shape
///   as ClosePosition. Triggered when health factor falls below
///   `max_health_factor_bps` so the user front-runs Jupiter's liquidator
///   (which keeps a fee).
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq, Eq)]
pub enum JupPerpsAction {
    /// Open a new perp position.
    OpenPosition {
        /// Jupiter market index (SOL-PERP, ETH-PERP, BTC-PERP, ...).
        market_index: u16,
        /// 0 = long, 1 = short. Adapter rejects any other value.
        side: u8,
        /// Collateral amount in the collateral mint (typically USDC).
        /// Must equal `pi.public_amount_in`.
        collateral_amount: u64,
        /// Notional position size in USD (6-decimal fixed-point matching
        /// Jupiter's pricing oracle).
        size_usd: u64,
        /// Slippage cap on entry price in basis points
        /// (10000 = 100%, typical 50 = 0.5%).
        slippage_bps: u16,
    },

    /// Add collateral and/or notional size to an existing position.
    IncreasePosition {
        /// Position PDA (derived per the per-user PDA seeds — see module
        /// doc). Adapter passes through; pool binds via
        /// `note_aux_binding`.
        position: Pubkey,
        /// Additional collateral to deposit. May be zero if only sizing up.
        collateral_delta: u64,
        /// Additional notional size in USD. May be zero if only adding
        /// collateral (margin top-up).
        size_delta_usd: u64,
        /// Slippage cap on the new portion in bps.
        slippage_bps: u16,
    },

    /// Reduce an existing position partially. Jupiter releases proportional
    /// collateral plus realised PnL on the closed slice.
    DecreasePosition {
        position: Pubkey,
        /// Collateral to release (independent of size change).
        collateral_delta: u64,
        /// Notional size in USD to close.
        size_delta_usd: u64,
        /// Slippage cap on exit price in bps.
        slippage_bps: u16,
    },

    /// Close the entire position. Jupiter releases all remaining collateral
    /// plus realised PnL.
    ClosePosition {
        position: Pubkey,
        /// Slippage cap on exit price in bps.
        slippage_bps: u16,
    },

    /// Pre-liquidation guardrail: close the position iff Jupiter reports a
    /// health factor at or below `max_health_factor_bps`. Lets the user
    /// exit before Jupiter's liquidator does (and keeps the fee).
    LiquidateGuardrail {
        position: Pubkey,
        /// Health-factor threshold in bps (10000 = 100%, fully healthy).
        /// Adapter aborts with `HealthAboveThreshold` if Jupiter reports a
        /// higher value at execution time.
        max_health_factor_bps: u16,
    },
}

#[program]
pub mod b402_jupiter_perps_adapter {
    use super::*;

    /// Execute the Jupiter Perps action encoded in `action_payload`.
    ///
    /// Not yet implemented. See the Jupiter-Perps-adapter PRD §5 for
    /// account layout and §6 for the per-action delta-invariant strategy.
    /// The handler MUST:
    ///   1. Borsh-decode `action_payload` into `JupPerpsAction`.
    ///   2. Refresh Jupiter's oracle / custody accounts (or rely on
    ///      Jupiter's own refresh inside the position ix).
    ///   3. CPI the chosen action.
    ///   4. Transfer `adapter_out_ta` → pool `out_vault` (collateral +
    ///      realised-PnL release for Decrease/Close/Liquidate variants;
    ///      refund-on-fail for Open/Increase).
    /// Honesty is verified post-CPI by the pool's balance-delta invariant.
    pub fn execute(_ctx: Context<Execute>, _action_payload: Vec<u8>) -> Result<()> {
        err!(JupPerpsAdapterError::NotYetImplemented)
    }
}

/// Account layout per PRD-04 §2 — first 6 are pool-managed; remainder
/// forwarded. Jupiter-Perps-specific accounts (perpetuals state, custody,
/// custody oracle, position PDA, transfer authority) come in via
/// `remaining_accounts` and are passed verbatim to Jupiter CPIs.
#[derive(Accounts)]
pub struct Execute<'info> {
    /// Adapter's PDA signer for any token movements and position auth.
    #[account(seeds = [b"b402/v1", b"adapter"], bump)]
    pub adapter_authority: SystemAccount<'info>,

    /// CHECK: pool's IN-mint vault. Adapter never writes here — pool moves
    /// in_amount before the CPI; adapter only reads if needed for refund.
    #[account(mut)]
    pub in_vault: AccountInfo<'info>,

    /// CHECK: pool's OUT-mint vault. Adapter writes here on
    /// Decrease / Close / Liquidate releases and on partial-fill refunds
    /// from Open / Increase.
    #[account(mut)]
    pub out_vault: AccountInfo<'info>,

    /// CHECK: adapter's IN-mint scratch ATA, owned by `adapter_authority`.
    #[account(mut)]
    pub adapter_in_ta: AccountInfo<'info>,

    /// CHECK: adapter's OUT-mint scratch ATA.
    #[account(mut)]
    pub adapter_out_ta: AccountInfo<'info>,

    /// CHECK: SPL Token program.
    pub token_program: AccountInfo<'info>,
}

#[error_code]
pub enum JupPerpsAdapterError {
    #[msg("Jupiter Perps adapter not yet implemented — PRD awaiting impl sign-off")]
    NotYetImplemented,
    #[msg("Unrecognised action_payload (Borsh decode failed)")]
    InvalidActionPayload,
    #[msg("expected_out_mint does not match the position's collateral mint")]
    MintMismatch,
    #[msg("Jupiter Perps CPI failed; oracle stale or position underwater")]
    JupiterPerpsCpiFailed,
    #[msg("side byte must be 0 (long) or 1 (short)")]
    InvalidSide,
    #[msg("LiquidateGuardrail aborted: health factor above threshold")]
    HealthAboveThreshold,
    #[msg("Slippage exceeded on perp open / close")]
    SlippageExceeded,
}

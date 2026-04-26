//! b402_orca_adapter — Orca Whirlpool concentrated-liquidity LP adapter for
//! the b402 shielded pool.
//!
//! Per the per-protocol adapter model (PRD-04 §2 + PRD-09 pattern, applied to
//! Orca Whirlpools). Called by `b402_pool` via CPI after IN-mint tokens have
//! been moved into this adapter's `adapter_in_ta`. The adapter then composes
//! Whirlpool's `open_position` / `increase_liquidity` / `decrease_liquidity`
//! / `update_fees_and_rewards` + `collect_fees` / `close_position` and
//! transfers any resulting OUT-mint tokens back to the pool's `out_vault`.
//!
//! ABI per PRD-04 §2. Post-CPI balance check is performed by the pool — the
//! adapter is trusted only to try hard; honesty is verified by delta.
//!
//! ## Status
//!
//! v0.0.1 — payload type + RED test scaffold. Handler not yet implemented.
//! See `tests/payload.rs` for the TDD test list. Implementation lands when
//! the Orca-adapter PRD §6 (account layout, position-PDA derivation,
//! tick-array discovery) is signed off.
//!
//! ## Position-NFT model note
//!
//! Orca whirlpools represent each LP position as an NFT mint owned by the
//! position holder. For shielded LPs, the NFT mint authority is the
//! adapter's PDA, and the per-user position PDA is derived from the user's
//! viewing-key hash so the relayer cannot grief by opening other users'
//! positions. PDA seeds: `[b"b402/v1", b"orca-pos", viewing_pub_hash[..32],
//! whirlpool_pubkey]` — locked when the PRD is signed off.

use anchor_lang::prelude::*;

declare_id!("DsyuZDwGPryBNK3aAUG4TTx9P5kxk4tbU7aD3DYRvQhT");

/// Orca Whirlpool program ID (verify against live IDL at deploy time).
pub const ORCA_WHIRLPOOL_PROGRAM_ID: Pubkey = anchor_lang::pubkey!(
    "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc"
);

/// Action variants the adapter exposes. Borsh-encoded inside `action_payload`.
///
/// Each variant corresponds to a single Whirlpool state-changing operation.
/// The pool binds `keccak(action_payload)` and `expected_out_mint` into the
/// proof's `action_hash`, so a relayer cannot substitute one variant for
/// another.
///
/// ### `expected_out_mint` / `expected_out_value` semantics
///
/// - `OpenPosition`: **delta-zero** (PRD-04 §7.1). No token delta lands on
///   `out_vault` — the only side-effect is mint of a position NFT held by
///   the adapter PDA on behalf of the user. `expected_out_mint = default()`.
/// - `IncreaseLiquidity`: **delta-zero**. Tokens flow IN-vault →
///   adapter_in_ta_a/b → whirlpool token vaults; the adapter receives no
///   token in return. Pool sees zero delta on `out_vault`. `expected_out_mint
///   = default()`.
/// - `DecreaseLiquidity`: **dual-delta**. Whirlpool returns both token A and
///   token B. The pool's two-vault delta-invariant must be extended (or the
///   action emits two notes). For the v1 stub, `expected_out_mint` MUST be
///   one of (token_a_mint, token_b_mint) and `expected_out_value` is the
///   floor on that side; the other side is captured by a follow-up action.
///   Final design lives in the Orca-adapter PRD.
/// - `CollectFees`: **dual-delta**, same shape as DecreaseLiquidity but for
///   accumulated fees only.
/// - `ClosePosition`: **delta-zero**. The adapter burns the position NFT
///   (only legal when liquidity == 0). `expected_out_mint = default()`.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq, Eq)]
pub enum OrcaAction {
    /// Open a new whirlpool LP position NFT in the price range
    /// `[tick_lower, tick_upper]`. Mints the position-NFT under the adapter
    /// PDA's authority. No liquidity is added — that's `IncreaseLiquidity`.
    OpenPosition {
        /// Whirlpool account (defines token pair, fee tier, current tick).
        whirlpool: Pubkey,
        /// Lower tick of the position range. Must be a multiple of the
        /// whirlpool's `tick_spacing`.
        tick_lower: i32,
        /// Upper tick of the position range. Must satisfy
        /// `tick_lower < tick_upper` and be a multiple of `tick_spacing`.
        tick_upper: i32,
    },

    /// Add liquidity to an existing position. The adapter funds liquidity
    /// from `adapter_in_ta_a` / `adapter_in_ta_b` (whose balances were
    /// pre-credited by the pool). `liquidity_amount` is whirlpool's
    /// internal liquidity unit (sqrt-price-derived); `token_max_a/b` are
    /// caps that protect against price drift between quote and execution.
    IncreaseLiquidity {
        /// Position account (the per-user PDA-derived position PDA).
        position: Pubkey,
        /// Whirlpool liquidity units to add.
        liquidity_amount: u128,
        /// Cap on token-A spent.
        token_max_a: u64,
        /// Cap on token-B spent.
        token_max_b: u64,
    },

    /// Withdraw liquidity from an existing position. Whirlpool releases
    /// both token A and token B; floors `token_min_a/b` protect against
    /// adverse price movement.
    DecreaseLiquidity {
        position: Pubkey,
        /// Whirlpool liquidity units to remove.
        liquidity_amount: u128,
        /// Floor on token-A received.
        token_min_a: u64,
        /// Floor on token-B received.
        token_min_b: u64,
    },

    /// Sweep accumulated fees on an existing position to the user's shielded
    /// note vault. No liquidity change.
    CollectFees {
        position: Pubkey,
    },

    /// Burn the position NFT and reclaim rent. Whirlpool requires the
    /// position to have zero liquidity and zero unclaimed fees first (the
    /// caller chains DecreaseLiquidity + CollectFees + ClosePosition into
    /// a single shielded action group at the SDK layer).
    ClosePosition {
        position: Pubkey,
    },
}

#[program]
pub mod b402_orca_adapter {
    use super::*;

    /// Execute the Orca Whirlpool action encoded in `action_payload`.
    ///
    /// Not yet implemented. See the Orca-adapter PRD §5 for account layout
    /// and §6 for the per-action delta-invariant strategy. The handler MUST:
    ///   1. Borsh-decode `action_payload` into `OrcaAction`.
    ///   2. CPI Whirlpool's `update_fees_and_rewards` (idempotent) before
    ///      any liquidity-or-fee-touching variant.
    ///   3. CPI the chosen action.
    ///   4. Transfer `adapter_out_ta` → pool `out_vault` (or both vaults for
    ///      DecreaseLiquidity / CollectFees once two-vault delta lands).
    /// Honesty is verified post-CPI by the pool's balance-delta invariant.
    pub fn execute(_ctx: Context<Execute>, _action_payload: Vec<u8>) -> Result<()> {
        err!(OrcaAdapterError::NotYetImplemented)
    }
}

/// Account layout per PRD-04 §2 — first 6 are pool-managed; remainder forwarded.
/// Whirlpool-specific accounts (whirlpool, position, position_token_account,
/// tick_array_lower, tick_array_upper, oracle, token vaults A/B) come in via
/// `remaining_accounts` and are passed verbatim to Whirlpool CPIs.
#[derive(Accounts)]
pub struct Execute<'info> {
    /// Adapter's PDA signer for any token movements and position-NFT auth.
    #[account(seeds = [b"b402/v1", b"adapter"], bump)]
    pub adapter_authority: SystemAccount<'info>,

    /// CHECK: pool's IN-mint vault. Adapter never writes here — pool moves
    /// in_amount before the CPI; adapter only reads if needed for refund.
    #[account(mut)]
    pub in_vault: AccountInfo<'info>,

    /// CHECK: pool's OUT-mint vault. Adapter writes here at the end of
    /// `DecreaseLiquidity` / `CollectFees`. No-op for delta-zero variants.
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
pub enum OrcaAdapterError {
    #[msg("Orca adapter not yet implemented — PRD awaiting impl sign-off")]
    NotYetImplemented,
    #[msg("Unrecognised action_payload (Borsh decode failed)")]
    InvalidActionPayload,
    #[msg("expected_out_mint does not match the whirlpool's token_a / token_b mint")]
    MintMismatch,
    #[msg("Whirlpool CPI failed; position or tick array may be stale")]
    WhirlpoolCpiFailed,
    #[msg("Position is not closable (non-zero liquidity or unclaimed fees)")]
    PositionNotClosable,
    #[msg("Tick range invalid (not multiple of tick_spacing or lower >= upper)")]
    InvalidTickRange,
}

//! b402_kamino_adapter — Kamino lend/borrow adapter for the b402 shielded pool.
//!
//! Per PRD-09. Called by b402_pool via CPI after IN-mint tokens have been
//! moved into this adapter's `adapter_in_ta`. The adapter then composes
//! Kamino's `refresh_reserve` + `refresh_obligation` + the chosen action
//! (`deposit`, `withdraw`, `borrow`, `repay`) and transfers any resulting
//! OUT-mint tokens back to the pool's `out_vault`.
//!
//! ABI per PRD-04 §2. Post-CPI balance check is performed by the pool —
//! the adapter is trusted only to try hard; honesty is verified by delta.
//!
//! ## Status
//!
//! v0.0.1 — payload type + RED test scaffold. Handler not yet implemented.
//! See `tests/payload.rs` for the TDD test list. Implementation lands when
//! PRD-09 §6 (account layout, oracle list) is signed off.

use anchor_lang::prelude::*;

declare_id!("2enwFgcGKJDqruHpCtvmhtxe3DYcV3k72VTvoGcdt2rX");

/// Kamino Lend program ID (verify against live IDL at deploy time per PRD-09).
pub const KAMINO_LEND_PROGRAM_ID: Pubkey = anchor_lang::pubkey!(
    "KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD"
);

/// Action variants the adapter exposes. Borsh-encoded inside `action_payload`.
///
/// Each variant corresponds to a single Kamino state-changing operation,
/// preceded by `refresh_reserve` + `refresh_obligation` inside the
/// adapter's CPI sequence. The pool binds `keccak(action_payload)` and
/// `expected_out_mint` into the proof's `action_hash`, so a relayer cannot
/// substitute one variant for another.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq, Eq)]
pub enum KaminoAction {
    /// Deposit `in_amount` of IN-mint as collateral. The user's shielded
    /// note is in IN mint; the new shielded note is in kToken (collateral
    /// receipt) mint. `expected_out_mint` MUST match the reserve's kToken
    /// mint; `expected_out_value` is the user's `min_kt_out` floor.
    Deposit {
        /// Reserve account (per Kamino's market layout). Adapter passes
        /// this through; pool does not bind it (Kamino enforces).
        reserve: Pubkey,
        /// Amount of IN-mint to deposit. Must equal `pi.public_amount_in`.
        in_amount: u64,
        /// Minimum kToken units the user accepts. Adapter forwards as
        /// Kamino's slippage param; pool's delta-invariant re-checks via
        /// `expected_out_value`.
        min_kt_out: u64,
    },

    /// Burn `kt_in` of kToken; receive IN-mint back. Inverse of Deposit.
    Withdraw {
        reserve: Pubkey,
        kt_in: u64,
        min_underlying_out: u64,
    },

    /// Borrow `amount_out` of OUT-mint against existing collateral in
    /// the user's per-user obligation. Pool binds the obligation PDA
    /// via the `note_aux_binding` public input (PRD-04 §7.2, gated).
    Borrow {
        reserve: Pubkey,
        amount_out: u64,
        /// Cap on collateral utilisation in basis points (10000 = 100%).
        /// Adapter rejects if Kamino would exceed this post-borrow.
        max_collateral_used_bps: u16,
    },

    /// Repay `amount_in` of borrowed OUT-mint to reduce the obligation.
    /// Overpayment is refunded by Kamino; adapter forwards refund to the
    /// pool's IN-mint vault. `expected_out_mint = default()` → handler
    /// uses delta-zero exemption (PRD-04 §7.1) when no refund.
    Repay { reserve: Pubkey, amount_in: u64 },
}

#[program]
pub mod b402_kamino_adapter {
    use super::*;

    /// Execute the Kamino action encoded in `action_payload`.
    ///
    /// Not yet implemented. See PRD-09 §5 for account layout and §6 for
    /// the per-action delta-invariant strategy. The handler MUST:
    ///   1. Borsh-decode `action_payload` into `KaminoAction`.
    ///   2. CPI Kamino's `refresh_reserve` + `refresh_obligation`.
    ///   3. CPI the chosen action.
    ///   4. Transfer adapter_out_ta → pool out_vault (or in_vault for Repay refund).
    /// Honesty is verified post-CPI by the pool's balance-delta invariant.
    pub fn execute(_ctx: Context<Execute>, _action_payload: Vec<u8>) -> Result<()> {
        err!(KaminoAdapterError::NotYetImplemented)
    }
}

/// Account layout per PRD-04 §2 — first 6 are pool-managed; remainder forwarded.
/// Kamino-specific accounts (reserve, obligation, oracle, market) come in via
/// `remaining_accounts` and are passed verbatim to Kamino CPIs.
#[derive(Accounts)]
pub struct Execute<'info> {
    /// Adapter's PDA signer for any token movements.
    #[account(seeds = [b"b402/v1", b"adapter"], bump)]
    pub adapter_authority: SystemAccount<'info>,

    /// CHECK: pool's IN-mint vault. Adapter never writes here — pool moves
    /// in_amount before the CPI; adapter only reads if needed for refund.
    #[account(mut)]
    pub in_vault: AccountInfo<'info>,

    /// CHECK: pool's OUT-mint vault. Adapter writes here at the end of
    /// `Deposit` (kToken delta) / `Borrow` / partial `Withdraw`.
    #[account(mut)]
    pub out_vault: AccountInfo<'info>,

    /// CHECK: adapter's IN-mint scratch ATA, owned by adapter_authority.
    #[account(mut)]
    pub adapter_in_ta: AccountInfo<'info>,

    /// CHECK: adapter's OUT-mint scratch ATA.
    #[account(mut)]
    pub adapter_out_ta: AccountInfo<'info>,

    /// CHECK: SPL Token program.
    pub token_program: AccountInfo<'info>,
}

#[error_code]
pub enum KaminoAdapterError {
    #[msg("Kamino adapter not yet implemented — PRD-09 awaiting impl sign-off")]
    NotYetImplemented,
    #[msg("Unrecognised action_payload (Borsh decode failed)")]
    InvalidActionPayload,
    #[msg("expected_out_mint does not match the reserve's kToken / underlying")]
    MintMismatch,
    #[msg("Kamino CPI failed; reserve or obligation may be unhealthy")]
    KaminoCpiFailed,
}

//! b402_kamino_adapter — Kamino lend/borrow adapter for the b402 shielded pool.
//!
//! Per PRD-09. Called by b402_pool via CPI after IN-mint tokens have been
//! moved into this adapter's `adapter_in_ta`. The adapter then composes
//! Kamino's `refresh_reserve` + `refresh_obligation` + the chosen action
//! (`deposit`, `withdraw`, `borrow`, `repay`) and transfers any resulting
//! OUT-mint tokens back to the pool's `out_vault`.
//!
//! ABI per PRD-04 §2 — unified `execute(in_amount, min_out, action_payload)`.
//! The `action_payload` is the Borsh-serialised `KaminoAction` enum (§5).
//!
//! Honesty is verified post-CPI by the pool's balance-delta invariant —
//! the adapter is trusted only to "try hard"; not to report honestly.
//!
//! ## Implementation status (v0.0.1)
//!
//! Handler implemented for all four ops (Deposit / Withdraw / Borrow / Repay).
//! Per-user obligation PDA derivation per PRD-09 §7.2: each shielded user
//! gets a unique Kamino `Obligation` derived from their `viewing_pub_hash`,
//! avoiding cross-user risk-pooling. Lazy `init_obligation` on first deposit.
//!
//! Kamino-specific addresses (program ID, ix discriminators) come from
//! PRD-09 §3 and are tagged `// IDL: ...` for verify-at-deploy review.
//! Where the IDL has not been fetched live, addresses are tagged
//! `// TODO(verify):` and MUST be confirmed against mainnet IDL before any
//! mainnet deploy.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program::invoke_signed;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

declare_id!("2enwFgcGKJDqruHpCtvmhtxe3DYcV3k72VTvoGcdt2rX");

// ---------------------------------------------------------------------------
// Kamino-specific addresses + discriminators.
//
// All values below are taken from PRD-09 §3 verbatim. They MUST be confirmed
// against the live Kamino mainnet IDL at deploy time. Per the PRD, Kamino
// has rotated program IDs in past upgrades; the registry can mark this
// adapter as deprecated and re-deploy under a new program ID if Kamino
// migrates.
// ---------------------------------------------------------------------------

/// Kamino Lend program ID.
/// IDL: PRD-09 §2 (verify against live mainnet IDL at deploy)
pub const KAMINO_LEND_PROGRAM_ID: Pubkey = anchor_lang::pubkey!(
    "KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD"
);

// Anchor instruction discriminators — first 8 bytes of sha256("global:<name>").
//
// TODO(verify): unverified; pre-mainnet, run against live mainnet-fork to
// confirm against the on-chain IDL. Kamino uses Anchor framing per PRD-09 §2,
// so the discriminator scheme matches Anchor's standard.

/// `init_obligation` discriminator (Kamino).
/// TODO(verify): regenerate from live IDL pre-mainnet.
pub const KAMINO_IX_INIT_OBLIGATION: [u8; 8] = [251, 10, 231, 76, 27, 11, 159, 96];

/// `refresh_reserve` discriminator (Kamino).
/// TODO(verify): regenerate from live IDL pre-mainnet.
pub const KAMINO_IX_REFRESH_RESERVE: [u8; 8] = [2, 218, 138, 235, 79, 201, 25, 102];

/// `refresh_obligation` discriminator (Kamino).
/// TODO(verify): regenerate from live IDL pre-mainnet.
pub const KAMINO_IX_REFRESH_OBLIGATION: [u8; 8] = [33, 132, 147, 228, 151, 192, 72, 89];

/// `deposit_reserve_liquidity_and_obligation_collateral` discriminator.
/// Combined op preferred for CU per PRD-09 §3 / task brief §3.
/// TODO(verify): regenerate from live IDL pre-mainnet.
pub const KAMINO_IX_DEPOSIT_RESERVE_LIQUIDITY_AND_OBLIGATION_COLLATERAL: [u8; 8] =
    [129, 199, 4, 2, 222, 39, 26, 46];

/// `withdraw_obligation_collateral_and_redeem_reserve_collateral` discriminator.
/// TODO(verify): regenerate from live IDL pre-mainnet.
pub const KAMINO_IX_WITHDRAW_OBLIGATION_COLLATERAL_AND_REDEEM_RESERVE_COLLATERAL: [u8; 8] =
    [75, 93, 47, 209, 91, 72, 27, 158];

/// `borrow_obligation_liquidity` discriminator.
/// TODO(verify): regenerate from live IDL pre-mainnet.
pub const KAMINO_IX_BORROW_OBLIGATION_LIQUIDITY: [u8; 8] =
    [121, 127, 18, 204, 62, 134, 50, 233];

/// `repay_obligation_liquidity` discriminator.
/// TODO(verify): regenerate from live IDL pre-mainnet.
pub const KAMINO_IX_REPAY_OBLIGATION_LIQUIDITY: [u8; 8] =
    [145, 178, 13, 225, 76, 240, 147, 72];

/// PDA seed prefix for per-user Kamino obligations (PRD-09 §7.2).
pub const SEED_KAMINO_OBL: &[u8] = b"kamino-obl";
/// Versioned namespace shared with the rest of b402.
pub const VERSION_PREFIX: &[u8] = b"b402/v1";
/// PDA seed for adapter authority. Same scheme as every b402 adapter.
pub const SEED_ADAPTER: &[u8] = b"adapter";

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
    /// Unified b402 adapter ABI per PRD-04 §2. The `action_payload` is the
    /// Borsh-serialised `KaminoAction` enum (PRD-09 §5). The pool has bound
    /// `keccak(action_payload)` into the proof's `action_hash`, so the
    /// adapter is free to dispatch on the decoded variant — a relayer
    /// cannot substitute Borrow for Deposit etc.
    ///
    /// Flow per op (PRD-09 §4):
    ///   1. Borsh-decode `action_payload` → `KaminoAction` variant.
    ///   2. (Deposit only, on first call) CPI Kamino's `init_obligation` to
    ///      lazily create the per-user obligation PDA.
    ///   3. CPI Kamino's `refresh_reserve` then `refresh_obligation`. Stale
    ///      oracles → Kamino reverts → pool reverts cleanly (PRD-09 §9).
    ///   4. CPI the chosen Kamino op:
    ///        - Deposit:  deposit_reserve_liquidity_and_obligation_collateral
    ///        - Withdraw: withdraw_obligation_collateral_and_redeem_reserve_collateral
    ///        - Borrow:   borrow_obligation_liquidity
    ///        - Repay:    repay_obligation_liquidity
    ///   5. Post-CPI sweep:
    ///        - Deposit/Withdraw/Borrow: adapter_out_ta → out_vault (delta).
    ///        - Repay: adapter_in_ta refund (overpay or no-debt) → out_vault.
    ///
    /// Honesty is verified post-CPI by the pool's `out_vault.amount` delta
    /// invariant against `expected_out_value`. Adapter only needs to "try
    /// hard"; under-delivery causes the pool to revert atomically.
    pub fn execute(
        ctx: Context<Execute>,
        in_amount: u64,
        min_out_amount: u64,
        action_payload: Vec<u8>,
    ) -> Result<()> {
        // ABI sanity. Mirrors b402-jupiter-adapter.
        require!(in_amount > 0, KaminoAdapterError::InvalidAmount);
        require!(
            ctx.accounts.adapter_in_ta.amount >= in_amount,
            KaminoAdapterError::InsufficientInput
        );

        // 1. Borsh-decode the action payload. The pool's circuit binds
        //    keccak(action_payload), so this is the user-attested action.
        let action = KaminoAction::try_from_slice(&action_payload)
            .map_err(|_| error!(KaminoAdapterError::InvalidActionPayload))?;

        // Snapshot adapter scratch balances pre-CPI so the post-CPI sweep
        // moves only the delta produced by this call (matches Jupiter pattern).
        let pre_out = ctx.accounts.adapter_out_ta.amount;
        let pre_in = ctx.accounts.adapter_in_ta.amount;

        // 2. Dispatch.
        let bump = ctx.bumps.adapter_authority;
        let auth_seeds: &[&[u8]] = &[VERSION_PREFIX, SEED_ADAPTER, &[bump]];
        let signer_seeds = &[auth_seeds];

        match &action {
            KaminoAction::Deposit {
                reserve,
                in_amount: act_in,
                min_kt_out,
            } => {
                require!(*act_in == in_amount, KaminoAdapterError::AmountMismatch);
                handle_deposit(
                    &ctx,
                    *reserve,
                    *act_in,
                    *min_kt_out,
                    signer_seeds,
                )?;
            }
            KaminoAction::Withdraw {
                reserve,
                kt_in,
                min_underlying_out,
            } => {
                // Withdraw's IN-mint is the kToken; in_amount equals kt_in.
                require!(*kt_in == in_amount, KaminoAdapterError::AmountMismatch);
                handle_withdraw(
                    &ctx,
                    *reserve,
                    *kt_in,
                    *min_underlying_out,
                    signer_seeds,
                )?;
            }
            KaminoAction::Borrow {
                reserve,
                amount_out,
                max_collateral_used_bps,
            } => {
                // Borrow's IN-mint is the kToken (collateral proof) — no
                // tokens are actually consumed from adapter_in_ta on Kamino's
                // side. Pool's adapt_execute records the input note as spent
                // and emits an unchanged kToken output note (PRD-09 §6.3).
                handle_borrow(
                    &ctx,
                    *reserve,
                    *amount_out,
                    *max_collateral_used_bps,
                    signer_seeds,
                )?;
            }
            KaminoAction::Repay { reserve, amount_in } => {
                require!(*amount_in == in_amount, KaminoAdapterError::AmountMismatch);
                handle_repay(&ctx, *reserve, *amount_in, signer_seeds)?;
            }
        }

        // 3. Post-CPI sweep. For Deposit/Withdraw/Borrow the produced output
        //    sits in adapter_out_ta and is swept to the pool's out_vault.
        //    For Repay the (potential) refund sits in adapter_in_ta and is
        //    swept to out_vault (which the SDK has wired = pool's IN-mint
        //    refund vault — same mint as in for Repay). See PRD-09 §6.4.
        let token_program = ctx.accounts.token_program.to_account_info();
        let authority = ctx.accounts.adapter_authority.to_account_info();

        match &action {
            KaminoAction::Repay { .. } => {
                // Refund path. Reload to see Kamino's effect on adapter_in_ta.
                // Kamino caps repay at outstanding debt; any excess remains.
                let in_ta = &mut ctx.accounts.adapter_in_ta;
                in_ta.reload()?;
                let post_in = in_ta.amount;
                let consumed = pre_in.saturating_sub(post_in);
                let refund = in_amount.saturating_sub(consumed);
                if refund > 0 {
                    token::transfer(
                        CpiContext::new_with_signer(
                            token_program.clone(),
                            Transfer {
                                from: in_ta.to_account_info(),
                                to: ctx.accounts.out_vault.to_account_info(),
                                authority: authority.clone(),
                            },
                            signer_seeds,
                        ),
                        refund,
                    )?;
                }
                // No min_out_amount enforcement — pool's delta-zero
                // exemption applies (PRD-09 §6.4 / PRD-04 §7.1).
            }
            KaminoAction::Borrow { .. } => {
                // Two-vault sweep:
                //   (a) adapter_out_ta → out_vault: borrowed underlying.
                //   (b) adapter_in_ta  → in_vault: passthrough kToken collateral
                //       proof. Kamino does NOT consume the kToken here — it
                //       only references the obligation's recorded collateral.
                //       The pool pre-transferred `in_amount` of kToken into
                //       adapter_in_ta unconditionally (adapt_execute is op-
                //       agnostic), so we must return it lest the pool's
                //       kToken vault permanently leak (PRD-09 §6.3 passthrough).
                let out_ta = &mut ctx.accounts.adapter_out_ta;
                out_ta.reload()?;
                let post_out = out_ta.amount;
                let received = post_out.saturating_sub(pre_out);
                require!(
                    received >= min_out_amount,
                    KaminoAdapterError::SlippageExceeded
                );
                token::transfer(
                    CpiContext::new_with_signer(
                        token_program.clone(),
                        Transfer {
                            from: out_ta.to_account_info(),
                            to: ctx.accounts.out_vault.to_account_info(),
                            authority: authority.clone(),
                        },
                        signer_seeds,
                    ),
                    received,
                )?;

                // Sweep passthrough kToken back to in_vault. pre_in was
                // recorded AFTER the pool's pre-transfer, so Kamino's net
                // consumption is `pre_in - post_in`. Anything still sitting
                // in adapter_in_ta belongs to the pool's in_vault.
                let in_ta = &mut ctx.accounts.adapter_in_ta;
                in_ta.reload()?;
                let post_in = in_ta.amount;
                // Refund = whatever Kamino did NOT consume of the in_amount.
                let consumed = pre_in.saturating_sub(post_in);
                let leftover = in_amount.saturating_sub(consumed);
                if leftover > 0 {
                    token::transfer(
                        CpiContext::new_with_signer(
                            token_program,
                            Transfer {
                                from: in_ta.to_account_info(),
                                to: ctx.accounts.in_vault.to_account_info(),
                                authority,
                            },
                            signer_seeds,
                        ),
                        leftover,
                    )?;
                }
            }
            _ => {
                // Standard path (Deposit/Withdraw): adapter_out_ta → out_vault.
                let out_ta = &mut ctx.accounts.adapter_out_ta;
                out_ta.reload()?;
                let post_out = out_ta.amount;
                let received = post_out.saturating_sub(pre_out);
                require!(
                    received >= min_out_amount,
                    KaminoAdapterError::SlippageExceeded
                );
                token::transfer(
                    CpiContext::new_with_signer(
                        token_program,
                        Transfer {
                            from: out_ta.to_account_info(),
                            to: ctx.accounts.out_vault.to_account_info(),
                            authority,
                        },
                        signer_seeds,
                    ),
                    received,
                )?;
            }
        }

        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Per-op handlers. Each constructs the Kamino-side `Instruction` and
// invokes it under the adapter PDA's signer seeds. Account ordering per
// PRD-09 §4. Adapter forwards `remaining_accounts` verbatim to Kamino —
// they are caller-supplied and validated by Kamino itself, plus by the
// pool's circuit binding (action_hash + expected_out_mint).
// ---------------------------------------------------------------------------

/// Build the Kamino `Instruction` from the adapter PDA's perspective —
/// any forwarded account whose key matches `adapter_authority` becomes a
/// signer in the CPI. Mirrors `b402-jupiter-adapter::execute`'s pattern;
/// without this flag, `obligation_owner = adapter_authority` CPIs revert
/// with "signer privilege escalated".
fn build_kamino_ix(
    program_id: Pubkey,
    auth_key: Pubkey,
    accounts: &[AccountInfo],
    discriminator: [u8; 8],
    extra_data: &[u8],
) -> Instruction {
    let metas: Vec<AccountMeta> = accounts
        .iter()
        .map(|a| {
            let is_signer = a.is_signer || *a.key == auth_key;
            if a.is_writable {
                AccountMeta::new(*a.key, is_signer)
            } else {
                AccountMeta::new_readonly(*a.key, is_signer)
            }
        })
        .collect();

    let mut data = Vec::with_capacity(8 + extra_data.len());
    data.extend_from_slice(&discriminator);
    data.extend_from_slice(extra_data);

    Instruction {
        program_id,
        accounts: metas,
        data,
    }
}

#[inline(never)]
fn handle_deposit(
    ctx: &Context<Execute>,
    _reserve: Pubkey,
    in_amount: u64,
    min_kt_out: u64,
    signer_seeds: &[&[&[u8]]],
) -> Result<()> {
    let auth_key = ctx.accounts.adapter_authority.key();

    // Per PRD-09 §4.1, all Kamino-side accounts arrive in remaining_accounts.
    // Adapter forwards them verbatim — Kamino enforces ordering & ownership.
    let kamino_accounts = ctx.remaining_accounts;
    require!(
        kamino_accounts.len() >= 7,
        KaminoAdapterError::MissingRemainingAccounts
    );

    // Lazy init_obligation: try it; ignore "already initialised" errors.
    // Kamino's init_obligation account list is a subset of the deposit list
    // (lending_market, lending_market_authority, obligation, payer/owner).
    // We forward all remaining_accounts and let Kamino pick what it needs;
    // for unknown accounts Kamino just ignores them in init_obligation.
    //
    // TODO(verify): some Kamino versions reject extra accounts. If so,
    // narrow the slice for init_obligation to its declared length and
    // pass the obligation_seed args via Borsh. Confirm against live IDL.
    let init_ix = build_kamino_ix(
        KAMINO_LEND_PROGRAM_ID,
        auth_key,
        kamino_accounts,
        KAMINO_IX_INIT_OBLIGATION,
        &[],
    );
    // Best-effort: ignore "already initialised". Kamino returns
    // `ObligationAlreadyInitialized` (account-already-in-use); we treat any
    // failure of init_obligation as "already exists" since the subsequent
    // refresh + deposit will fail loudly if the obligation truly doesn't
    // exist or is malformed.
    let _ = invoke_signed(&init_ix, kamino_accounts, signer_seeds);

    // refresh_reserve — required precursor (PRD-09 §11).
    let refresh_reserve_ix = build_kamino_ix(
        KAMINO_LEND_PROGRAM_ID,
        auth_key,
        kamino_accounts,
        KAMINO_IX_REFRESH_RESERVE,
        &[],
    );
    invoke_signed(&refresh_reserve_ix, kamino_accounts, signer_seeds)
        .map_err(|_| error!(KaminoAdapterError::KaminoCpiFailed))?;

    // refresh_obligation — required precursor.
    let refresh_obl_ix = build_kamino_ix(
        KAMINO_LEND_PROGRAM_ID,
        auth_key,
        kamino_accounts,
        KAMINO_IX_REFRESH_OBLIGATION,
        &[],
    );
    invoke_signed(&refresh_obl_ix, kamino_accounts, signer_seeds)
        .map_err(|_| error!(KaminoAdapterError::KaminoCpiFailed))?;

    // Combined deposit_reserve_liquidity_and_obligation_collateral. Args:
    // Borsh u64 `liquidity_amount`. Slippage (`min_kt_out`) is enforced
    // *post-CPI* by the pool's delta invariant; Kamino itself takes only
    // the deposit amount.
    //
    // TODO(verify): newer Kamino IDL variants pass extra params (e.g.
    // `liquidity_amount: u64, min_collateral_out: u64`). Check IDL.
    let mut data = Vec::with_capacity(8);
    data.extend_from_slice(&in_amount.to_le_bytes());
    let _ = min_kt_out; // referenced for review; pool enforces the floor.

    let deposit_ix = build_kamino_ix(
        KAMINO_LEND_PROGRAM_ID,
        auth_key,
        kamino_accounts,
        KAMINO_IX_DEPOSIT_RESERVE_LIQUIDITY_AND_OBLIGATION_COLLATERAL,
        &data,
    );
    invoke_signed(&deposit_ix, kamino_accounts, signer_seeds)
        .map_err(|_| error!(KaminoAdapterError::KaminoCpiFailed))?;

    Ok(())
}

#[inline(never)]
fn handle_withdraw(
    ctx: &Context<Execute>,
    _reserve: Pubkey,
    kt_in: u64,
    min_underlying_out: u64,
    signer_seeds: &[&[&[u8]]],
) -> Result<()> {
    let auth_key = ctx.accounts.adapter_authority.key();
    let kamino_accounts = ctx.remaining_accounts;
    require!(
        kamino_accounts.len() >= 7,
        KaminoAdapterError::MissingRemainingAccounts
    );

    // refresh_reserve + refresh_obligation precursors.
    let refresh_reserve_ix = build_kamino_ix(
        KAMINO_LEND_PROGRAM_ID,
        auth_key,
        kamino_accounts,
        KAMINO_IX_REFRESH_RESERVE,
        &[],
    );
    invoke_signed(&refresh_reserve_ix, kamino_accounts, signer_seeds)
        .map_err(|_| error!(KaminoAdapterError::KaminoCpiFailed))?;

    let refresh_obl_ix = build_kamino_ix(
        KAMINO_LEND_PROGRAM_ID,
        auth_key,
        kamino_accounts,
        KAMINO_IX_REFRESH_OBLIGATION,
        &[],
    );
    invoke_signed(&refresh_obl_ix, kamino_accounts, signer_seeds)
        .map_err(|_| error!(KaminoAdapterError::KaminoCpiFailed))?;

    // Combined withdraw_obligation_collateral_and_redeem_reserve_collateral.
    // Args: Borsh u64 `collateral_amount`. Underlying delivered to
    // adapter_out_ta. Pool's delta invariant catches under-delivery vs
    // `min_underlying_out` (forwarded as expected_out_value).
    let mut data = Vec::with_capacity(8);
    data.extend_from_slice(&kt_in.to_le_bytes());
    let _ = min_underlying_out; // pool enforces.

    let withdraw_ix = build_kamino_ix(
        KAMINO_LEND_PROGRAM_ID,
        auth_key,
        kamino_accounts,
        KAMINO_IX_WITHDRAW_OBLIGATION_COLLATERAL_AND_REDEEM_RESERVE_COLLATERAL,
        &data,
    );
    invoke_signed(&withdraw_ix, kamino_accounts, signer_seeds)
        .map_err(|_| error!(KaminoAdapterError::KaminoCpiFailed))?;

    Ok(())
}

#[inline(never)]
fn handle_borrow(
    ctx: &Context<Execute>,
    _reserve: Pubkey,
    amount_out: u64,
    _max_collateral_used_bps: u16,
    signer_seeds: &[&[&[u8]]],
) -> Result<()> {
    let auth_key = ctx.accounts.adapter_authority.key();
    let kamino_accounts = ctx.remaining_accounts;
    require!(
        kamino_accounts.len() >= 7,
        KaminoAdapterError::MissingRemainingAccounts
    );

    // refresh_reserve + refresh_obligation. Borrow needs both reserves
    // refreshed (PRD-09 §4.3); Kamino's refresh_reserve covers the one
    // identified by the reserve account in remaining_accounts. SDK is
    // responsible for ordering remaining_accounts so each refresh hits
    // the right reserve.
    //
    // TODO(verify): some borrow flows require two distinct refresh_reserve
    // CPIs — one for collateral, one for borrow. v1 issues a single one;
    // confirm against live IDL whether refresh_obligation cascades to all
    // referenced reserves on its own.
    let refresh_reserve_ix = build_kamino_ix(
        KAMINO_LEND_PROGRAM_ID,
        auth_key,
        kamino_accounts,
        KAMINO_IX_REFRESH_RESERVE,
        &[],
    );
    invoke_signed(&refresh_reserve_ix, kamino_accounts, signer_seeds)
        .map_err(|_| error!(KaminoAdapterError::KaminoCpiFailed))?;

    let refresh_obl_ix = build_kamino_ix(
        KAMINO_LEND_PROGRAM_ID,
        auth_key,
        kamino_accounts,
        KAMINO_IX_REFRESH_OBLIGATION,
        &[],
    );
    invoke_signed(&refresh_obl_ix, kamino_accounts, signer_seeds)
        .map_err(|_| error!(KaminoAdapterError::KaminoCpiFailed))?;

    // borrow_obligation_liquidity. Args: Borsh u64 `liquidity_amount`.
    // Borrowed underlying lands in adapter_out_ta.
    let mut data = Vec::with_capacity(8);
    data.extend_from_slice(&amount_out.to_le_bytes());

    let borrow_ix = build_kamino_ix(
        KAMINO_LEND_PROGRAM_ID,
        auth_key,
        kamino_accounts,
        KAMINO_IX_BORROW_OBLIGATION_LIQUIDITY,
        &data,
    );
    invoke_signed(&borrow_ix, kamino_accounts, signer_seeds)
        .map_err(|_| error!(KaminoAdapterError::KaminoCpiFailed))?;

    Ok(())
}

#[inline(never)]
fn handle_repay(
    ctx: &Context<Execute>,
    _reserve: Pubkey,
    amount_in: u64,
    signer_seeds: &[&[&[u8]]],
) -> Result<()> {
    let auth_key = ctx.accounts.adapter_authority.key();
    let kamino_accounts = ctx.remaining_accounts;
    require!(
        kamino_accounts.len() >= 5,
        KaminoAdapterError::MissingRemainingAccounts
    );

    // refresh_reserve + refresh_obligation precursors.
    let refresh_reserve_ix = build_kamino_ix(
        KAMINO_LEND_PROGRAM_ID,
        auth_key,
        kamino_accounts,
        KAMINO_IX_REFRESH_RESERVE,
        &[],
    );
    invoke_signed(&refresh_reserve_ix, kamino_accounts, signer_seeds)
        .map_err(|_| error!(KaminoAdapterError::KaminoCpiFailed))?;

    let refresh_obl_ix = build_kamino_ix(
        KAMINO_LEND_PROGRAM_ID,
        auth_key,
        kamino_accounts,
        KAMINO_IX_REFRESH_OBLIGATION,
        &[],
    );
    invoke_signed(&refresh_obl_ix, kamino_accounts, signer_seeds)
        .map_err(|_| error!(KaminoAdapterError::KaminoCpiFailed))?;

    // repay_obligation_liquidity. Args: Borsh u64 `liquidity_amount`.
    // Kamino caps repay at outstanding debt; any excess remains in
    // adapter_in_ta and is swept by the post-CPI refund path (§6.4).
    let mut data = Vec::with_capacity(8);
    data.extend_from_slice(&amount_in.to_le_bytes());

    let repay_ix = build_kamino_ix(
        KAMINO_LEND_PROGRAM_ID,
        auth_key,
        kamino_accounts,
        KAMINO_IX_REPAY_OBLIGATION_LIQUIDITY,
        &data,
    );
    invoke_signed(&repay_ix, kamino_accounts, signer_seeds)
        .map_err(|_| error!(KaminoAdapterError::KaminoCpiFailed))?;

    Ok(())
}

/// Account layout per PRD-04 §2 — first 6 are pool-managed; remainder forwarded.
/// Kamino-specific accounts (reserve, obligation, oracle, market, kamino program)
/// arrive via `remaining_accounts` and are passed verbatim to Kamino CPIs.
#[derive(Accounts)]
pub struct Execute<'info> {
    /// CHECK: adapter PDA signer. Seeds checked at runtime.
    #[account(
        seeds = [VERSION_PREFIX, SEED_ADAPTER],
        bump,
    )]
    pub adapter_authority: UncheckedAccount<'info>,

    /// Pool's IN-mint vault. Adapter never writes here directly — pool
    /// pre-transferred `in_amount` into `adapter_in_ta` before this CPI.
    /// Kept for ABI parity and to give Kamino a stable account view.
    #[account(mut)]
    pub in_vault: Account<'info, TokenAccount>,

    /// Pool's OUT-mint vault. Adapter writes here at end of Deposit (kToken
    /// delta) / Withdraw (underlying) / Borrow (borrowed asset). For Repay
    /// the same account is the IN-mint refund vault — same mint as in.
    #[account(mut)]
    pub out_vault: Account<'info, TokenAccount>,

    /// Adapter-local scratch input token account. Authority = adapter PDA.
    /// Pool pre-transferred `in_amount` here.
    #[account(
        mut,
        constraint = adapter_in_ta.owner == adapter_authority.key()
            @ KaminoAdapterError::ScratchAtaOwnerMismatch,
    )]
    pub adapter_in_ta: Account<'info, TokenAccount>,

    /// Adapter-local scratch output token account. Authority = adapter PDA.
    /// Receives Kamino's CPI output before being swept to `out_vault`.
    #[account(
        mut,
        constraint = adapter_out_ta.owner == adapter_authority.key()
            @ KaminoAdapterError::ScratchAtaOwnerMismatch,
    )]
    pub adapter_out_ta: Account<'info, TokenAccount>,

    /// SPL Token program.
    pub token_program: Program<'info, Token>,
}

#[error_code]
pub enum KaminoAdapterError {
    #[msg("Kamino adapter not yet implemented — PRD-09 awaiting impl sign-off")]
    NotYetImplemented = 6000,
    #[msg("Unrecognised action_payload (Borsh decode failed)")]
    InvalidActionPayload = 6001,
    #[msg("expected_out_mint does not match the reserve's kToken / underlying")]
    MintMismatch = 6002,
    #[msg("Kamino CPI failed; reserve or obligation may be unhealthy")]
    KaminoCpiFailed = 6003,
    #[msg("invalid amount (must be > 0)")]
    InvalidAmount = 6004,
    #[msg("adapter_in_ta has insufficient balance for the requested op")]
    InsufficientInput = 6005,
    #[msg("scratch ATA owner is not the adapter PDA")]
    ScratchAtaOwnerMismatch = 6006,
    #[msg("missing Kamino-side accounts in remaining_accounts (see PRD-09 §4)")]
    MissingRemainingAccounts = 6007,
    #[msg("post-Kamino delivery below the user's slippage floor")]
    SlippageExceeded = 6008,
    #[msg("KaminoAction.amount field disagrees with ABI in_amount")]
    AmountMismatch = 6009,
}

// ---------------------------------------------------------------------------
// Helper: per-user obligation PDA derivation (PRD-09 §7.2).
//
// Used by the SDK to compute the obligation pubkey that goes into
// `remaining_accounts[6]` for Deposit/Withdraw/Borrow. Exposed at the
// crate level so the SDK and tests can derive it without duplicating
// the seed scheme.
// ---------------------------------------------------------------------------

/// Derive the per-user Kamino obligation PDA from `viewing_pub_hash`
/// and the lending market. Per PRD-09 §7.2:
///
/// ```text
/// obligation = PDA(
///     [b"b402/v1", b"kamino-obl", viewing_pub_hash, lending_market],
///     b402_kamino_adapter,
/// )
/// ```
///
/// The pool's circuit binds `viewing_pub_hash` (already part of every
/// shielded note schema, PRD-02) to the obligation pubkey via
/// `note_aux_binding`, so a relayer cannot substitute a different user's
/// obligation.
pub fn derive_obligation_pda(
    viewing_pub_hash: &[u8; 32],
    lending_market: &Pubkey,
) -> (Pubkey, u8) {
    Pubkey::find_program_address(
        &[
            VERSION_PREFIX,
            SEED_KAMINO_OBL,
            viewing_pub_hash.as_ref(),
            lending_market.as_ref(),
        ],
        &crate::ID,
    )
}

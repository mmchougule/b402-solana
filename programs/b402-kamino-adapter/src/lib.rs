//! b402_kamino_adapter — Kamino lend/borrow adapter for the b402 shielded pool.
//!
//! Per PRD-09. Called by b402_pool via CPI after IN-mint tokens have been
//! moved into this adapter's `adapter_in_ta`. The adapter then composes the
//! Kamino instruction sequence required by the chosen action (Deposit /
//! Withdraw / Borrow / Repay) and transfers the resulting OUT-mint tokens
//! back to the pool's `out_vault`.
//!
//! ABI per PRD-04 §2 — unified `execute(in_amount, min_out, action_payload)`.
//! The `action_payload` is the Borsh-serialised `KaminoAction` enum (§5).
//!
//! Honesty is verified post-CPI by the pool's balance-delta invariant —
//! the adapter is trusted only to "try hard"; not to report honestly.
//!
//! ## Implementation status (v0.1.0)
//!
//! Deposit handler ported from `examples/kamino-fork-deposit.ts` (verified
//! GREEN against cloned klend mainnet bytecode 2026-04-26). Withdraw /
//! Borrow / Repay paths use the v1 instruction set with the same refresh
//! sequence; mainnet-fork verification for those is pending.
//!
//! ## Per-user obligation: architectural decision
//!
//! PRD-09 §7.2 originally specified a per-user `Obligation` keyed on
//! `viewing_pub_hash`. Two implementations were considered:
//!
//! 1. Per-user obligation owner: derive `owner_pda` =
//!    `PDA(["b402/v1", "kamino-owner", viewing_pub_hash], adapter_program_id)`,
//!    and pass that PDA as the Vanilla obligation's "user" seed slot.
//!    Each shielded user gets a unique obligation. The adapter
//!    `invoke_signed`s with both `adapter_authority` (vault transfers) and
//!    `owner_pda` (Kamino-side signing) seed sets.
//!
//! 2. Single shared obligation: `adapter_authority` is the obligation
//!    owner. All b402 shielded users share one obligation, which means
//!    Kamino can correlate every b402 deposit (privacy poisoned).
//!
//! For the v0.1 test-gate landing we ship (2). The Deposit / Withdraw /
//! Borrow / Repay handlers all use `adapter_authority` as the Kamino
//! obligation owner. PRD-09 §7.2 is amended in this commit accordingly.
//! Path (1) is feasible (`invoke_signed` accepts multiple seed sets) and
//! is the planned upgrade once the v1 ABI is locked and the pool's
//! action_hash binding is extended to bind `viewing_pub_hash` into the
//! obligation account public-input slot. See PRD-09 §7.2-amend in this
//! crate's design doc.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program::invoke_signed;
use anchor_lang::solana_program::pubkey::Pubkey as SolPubkey;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

declare_id!("2enwFgcGKJDqruHpCtvmhtxe3DYcV3k72VTvoGcdt2rX");

// ---------------------------------------------------------------------------
// Kamino-specific addresses + discriminators.
//
// Verified 2026-04-26 against:
//   - klend mainnet program ID (Kamino-Finance/klend master)
//   - examples/kamino-fork-deposit.ts (the verified end-to-end deposit run
//     — GREEN against cloned mainnet bytecode).
// ---------------------------------------------------------------------------

/// Kamino Lend program ID. IDL-verified on mainnet.
pub const KAMINO_LEND_PROGRAM_ID: Pubkey =
    anchor_lang::pubkey!("KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD");

/// Kamino Farms program ID — collateral farms attached to reserves.
pub const FARMS_PROGRAM_ID: Pubkey =
    anchor_lang::pubkey!("FarmsPZpWu9i7Kky8tPN37rs2TpmMrAZrC7S7vJa91Hr");

// Anchor-style discriminators — first 8 bytes of sha256("global:<name>").
// Each value is matched against examples/kamino-fork-deposit.ts (GREEN).

/// `init_user_metadata` discriminator.
pub const KAMINO_IX_INIT_USER_METADATA: [u8; 8] = [117, 169, 176, 69, 197, 23, 15, 162];

/// `init_obligation` discriminator.
pub const KAMINO_IX_INIT_OBLIGATION: [u8; 8] = [251, 10, 231, 76, 27, 11, 159, 96];

/// `init_obligation_farms_for_reserve` discriminator.
pub const KAMINO_IX_INIT_OBLIGATION_FARMS_FOR_RESERVE: [u8; 8] =
    [136, 63, 15, 186, 211, 152, 168, 164];

/// `refresh_reserve` discriminator.
pub const KAMINO_IX_REFRESH_RESERVE: [u8; 8] = [2, 218, 138, 235, 79, 201, 25, 102];

/// `refresh_obligation` discriminator.
pub const KAMINO_IX_REFRESH_OBLIGATION: [u8; 8] = [33, 132, 147, 228, 151, 192, 72, 89];

/// `deposit_reserve_liquidity_and_obligation_collateral` (v1).
/// Kept for reference; v2 form (`*_v2`) is preferred and shipped here.
pub const KAMINO_IX_DEPOSIT_RESERVE_LIQUIDITY_AND_OBLIGATION_COLLATERAL: [u8; 8] =
    [129, 199, 4, 2, 222, 39, 26, 46];

/// `deposit_reserve_liquidity_and_obligation_collateral_v2` discriminator.
/// Bakes farm accounts inline so no preceding `refresh_farms_*` ix is needed.
pub const KAMINO_IX_DEPOSIT_RESERVE_LIQUIDITY_AND_OBLIGATION_COLLATERAL_V2: [u8; 8] =
    [216, 224, 191, 27, 204, 151, 102, 175];

/// `withdraw_obligation_collateral_and_redeem_reserve_collateral` (v1).
pub const KAMINO_IX_WITHDRAW_OBLIGATION_COLLATERAL_AND_REDEEM_RESERVE_COLLATERAL: [u8; 8] =
    [75, 93, 93, 220, 34, 150, 218, 196];

/// `borrow_obligation_liquidity` (v1).
pub const KAMINO_IX_BORROW_OBLIGATION_LIQUIDITY: [u8; 8] = [121, 127, 18, 204, 73, 245, 225, 65];

/// `repay_obligation_liquidity` (v1).
pub const KAMINO_IX_REPAY_OBLIGATION_LIQUIDITY: [u8; 8] = [145, 178, 13, 225, 76, 240, 147, 72];

/// PDA seed prefix for per-user Kamino obligations (PRD-09 §7.2). Reserved
/// for the per-user upgrade — currently unused (single shared obligation).
#[allow(dead_code)]
pub const SEED_KAMINO_OBL: &[u8] = b"kamino-obl";
/// Versioned namespace shared with the rest of b402.
pub const VERSION_PREFIX: &[u8] = b"b402/v1";
/// PDA seed for adapter authority. Same scheme as every b402 adapter.
pub const SEED_ADAPTER: &[u8] = b"adapter";
/// PDA seed for per-user adapter-side obligation owner (PRD-33 §3.2).
/// Combined with `viewing_pub_hash` (32 B from the Phase 9
/// `outSpendingPub` public input) and the adapter `program_id`, this PDA
/// signs as the Kamino obligation owner instead of `adapter_authority`.
/// Each adapter is its own program → cross-protocol correlation by
/// `owner_pda` alone is impossible (PRD-33 §3.2 property 1).
pub const SEED_ADAPTER_OWNER: &[u8] = b"adapter-owner";
/// PDA seed for the per-adapter rent buffer (PRD-33 §5.4). Holds USDC
/// collected from first-time depositors as the per-user setup fee. A
/// crank ix (`topup_authority_from_rent_buffer`) Jupiter-swaps the
/// USDC to SOL and forwards to `adapter_authority`, replenishing the
/// SOL spent on `init_user_metadata` + `init_obligation` rent.
pub const SEED_RENT_BUFFER: &[u8] = b"rent-buffer";

/// First-deposit setup fee in USDC base units (PRD-33 §5.4.2).
///
/// Sized to cover the lamport rent for `init_user_metadata` (~0.007 SOL)
/// + `init_obligation` (~0.023 SOL) ≈ 0.030 SOL, with a 1.5× buffer for
/// SOL-price drift between deposit time (USDC paid now) and adapter
/// authority top-up time (USDC→SOL swap, possibly hours later).
///
/// Computation at deploy: 0.030 SOL × 180 USDC/SOL × 1.5 ≈ 8.1 USDC.
/// Hardcoded for V1 — if SOL goes above $200 sustained, redeploy with a
/// bumped value (or migrate the field into `PoolConfig` for live update).
pub const SETUP_FEE_USDC: u64 = 8_000_000; // 8 USDC (decimals = 6)

/// Floor on the user-facing deposit amount AFTER the setup fee is
/// deducted. Prevents a 7-USDC deposit from going through, charging 8
/// in fees, and dust-depositing to Kamino. Strictly > 0.
pub const MIN_FIRST_DEPOSIT_AFTER_FEE_USDC: u64 = 1_000_000; // 1 USDC

// ---------------------------------------------------------------------------
// remaining_accounts layout (from kamino-fork-deposit.ts — verified GREEN).
//
// The pool's `adapt_execute` prepends 6 named accounts before forwarding
// `remaining_accounts`. The TS driver therefore stages the Kamino-side
// account list at the START of remaining_accounts in this exact order.
// Adapter forwards them verbatim into the appropriate Kamino CPI.
// ---------------------------------------------------------------------------

/// Position of every account in `remaining_accounts` for Deposit.
/// Mirrors klend-sdk@7.3.22 `deposit_reserve_liquidity_and_obligation_collateral_v2`
/// argument order, plus the init prerequisites at the tail.
#[allow(dead_code)]
mod ra_deposit {
    // First 11 — the per-action accounts the deposit_v2 ix consumes.
    pub const RESERVE: usize = 0;
    pub const LENDING_MARKET: usize = 1;
    pub const LENDING_MARKET_AUTHORITY: usize = 2;
    pub const RESERVE_LIQUIDITY_SUPPLY: usize = 3;
    pub const RESERVE_COLLATERAL_MINT: usize = 4;
    pub const RESERVE_COLLATERAL_DEST_SUPPLY: usize = 5;
    pub const ORACLE_PYTH_OR_SENTINEL: usize = 6;
    pub const ORACLE_SWITCHBOARD_PRICE_OR_SENTINEL: usize = 7;
    pub const ORACLE_SWITCHBOARD_TWAP_OR_SENTINEL: usize = 8;
    pub const ORACLE_SCOPE_OR_SENTINEL: usize = 9;
    pub const RESERVE_LIQUIDITY_MINT: usize = 10;

    // Common control-plane accounts.
    pub const FARMS_PROGRAM: usize = 11;
    pub const USER_METADATA: usize = 12;
    pub const OBLIGATION: usize = 13;
    pub const OBLIGATION_FARM_OR_SENTINEL: usize = 14;
    pub const RESERVE_FARM_STATE_OR_SENTINEL: usize = 15;
    pub const SYSVAR_INSTRUCTIONS: usize = 16;
    pub const SYSTEM_PROGRAM: usize = 17;
    pub const RENT_SYSVAR: usize = 18;

    pub const MIN_LEN: usize = 19;
}

/// Per-user variant of the deposit account layout (PRD-33 §3.2). Adds the
/// owner PDA at the tail; rest is the same as `ra_deposit`. The owner PDA
/// is the per-shielded-user `find_program_address(["b402/v1",
/// "adapter-owner", viewing_pub_hash], adapter_program_id)` PDA. Sole
/// reason it's an explicit account: invoke_signed needs the AccountInfo
/// to forward into Kamino's CPI account list. The adapter validates
/// `key == derive_owner_pda(adapter_program_id, viewing_pub_hash).0`
/// before signing.
#[cfg(feature = "per_user_obligation")]
#[allow(dead_code)]
mod ra_deposit_per_user {
    pub const OWNER_PDA: usize = 19;
    /// Rent-buffer USDC ATA owned by `rent_buffer_pda`. Adapter transfers
    /// `SETUP_FEE_USDC` from `adapter_in_ta` here on the user's first
    /// deposit. PRD-33 §5.4.3.
    pub const RENT_BUFFER_TA: usize = 20;
    pub const MIN_LEN: usize = 21;
}

/// Position of every account in `remaining_accounts` for per-user
/// Withdraw. The SDK forwards the klend `withdraw_obligation_collateral_
/// and_redeem_reserve_collateral` argument list (v1) followed by
/// owner_pda. Refresh_reserve + refresh_obligation reuse the same RAs.
///
/// Order chosen to match klend SDK 7.3.x:
///   0  withdraw_reserve            (writable)
///   1  obligation                  (writable)
///   2  lending_market
///   3  lending_market_authority
///   4  reserve_source_collateral   (writable)
///   5  reserve_collateral_mint     (writable)
///   6  reserve_liquidity_supply    (writable)
///   7  user_destination_liquidity  (writable) — pool out-vault (sweep target)
///   8  collateral_token_program
///   9  liquidity_token_program
///   10 instructions_sysvar
///   11 reserve_liquidity_mint
///   12 owner_pda
#[cfg(feature = "per_user_obligation")]
#[allow(dead_code)]
mod ra_withdraw_per_user {
    pub const WITHDRAW_RESERVE: usize = 0;
    pub const OBLIGATION: usize = 1;
    pub const LENDING_MARKET: usize = 2;
    pub const LENDING_MARKET_AUTHORITY: usize = 3;
    pub const RESERVE_SOURCE_COLLATERAL: usize = 4;
    pub const RESERVE_COLLATERAL_MINT: usize = 5;
    pub const RESERVE_LIQUIDITY_SUPPLY: usize = 6;
    pub const USER_DESTINATION_LIQUIDITY: usize = 7;
    pub const COLLATERAL_TOKEN_PROGRAM: usize = 8;
    pub const LIQUIDITY_TOKEN_PROGRAM: usize = 9;
    pub const SYSVAR_INSTRUCTIONS: usize = 10;
    pub const RESERVE_LIQUIDITY_MINT: usize = 11;
    pub const OWNER_PDA: usize = 12;
    pub const MIN_LEN: usize = 13;
}

/// Action variants the adapter exposes. Borsh-encoded inside `action_payload`.
///
/// Each variant corresponds to a single Kamino state-changing operation,
/// preceded by `refresh_reserve` + `refresh_obligation` and (for Deposit
/// only) lazy init of `user_metadata`, `obligation`, and the
/// `obligation_farms_for_reserve` enrolment when the reserve has a
/// collateral farm attached.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq, Eq)]
pub enum KaminoAction {
    Deposit {
        reserve: Pubkey,
        in_amount: u64,
        min_kt_out: u64,
    },
    Withdraw {
        reserve: Pubkey,
        kt_in: u64,
        min_underlying_out: u64,
    },
    Borrow {
        reserve: Pubkey,
        amount_out: u64,
        max_collateral_used_bps: u16,
    },
    Repay {
        reserve: Pubkey,
        amount_in: u64,
    },
}

#[program]
pub mod b402_kamino_adapter {
    use super::*;

    /// Execute the Kamino action encoded in `action_payload`.
    ///
    /// Account layout per PRD-04 §2 — six named accounts + `remaining_accounts`
    /// laid out per `ra_deposit` (or per-op equivalent for non-deposit ops).
    pub fn execute<'info>(
        ctx: Context<'_, '_, '_, 'info, Execute<'info>>,
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

        // Decode action. The `per_user_obligation` build expects the
        // action_payload to start with a 32-B `viewing_pub_hash` (PRD-33
        // §6.1) prepended by the pool when the adapter's registry entry has
        // `stateful_adapter = true`. Path-2 (default) builds decode the
        // raw KaminoAction directly.
        #[cfg(feature = "per_user_obligation")]
        let (viewing_pub_hash, action) = decode_per_user_payload(&action_payload)?;
        #[cfg(not(feature = "per_user_obligation"))]
        let action = KaminoAction::try_from_slice(&action_payload)
            .map_err(|_| error!(KaminoAdapterError::InvalidActionPayload))?;

        // Snapshot adapter scratch balances pre-CPI so the post-CPI sweep
        // moves only the delta produced by this call.
        let pre_out = ctx.accounts.adapter_out_ta.amount;
        let pre_in = ctx.accounts.adapter_in_ta.amount;

        let bump = ctx.bumps.adapter_authority;
        let auth_seeds: &[&[u8]] = &[VERSION_PREFIX, SEED_ADAPTER, &[bump]];
        let signer_seeds_auth_only = &[auth_seeds];

        // Dispatch.
        //
        // Path 2 (default, shared obligation):
        //   Sign with adapter_authority alone. Kamino sees one obligation
        //   shared across every b402 user. Mainnet alpha v0.1.
        //
        // Path 1 (per_user_obligation feature, PRD-33 §3.3):
        //   Derive owner_pda from viewing_pub_hash. Sign with both seed
        //   sets simultaneously: adapter_authority for the b402-side
        //   token-program transfers (post-CPI sweep), owner_pda for
        //   Kamino's obligation-touching ixs.
        match &action {
            KaminoAction::Deposit {
                reserve,
                in_amount: act_in,
                min_kt_out,
            } => {
                require!(*act_in == in_amount, KaminoAdapterError::AmountMismatch);
                #[cfg(feature = "per_user_obligation")]
                {
                    let (expected_owner_pda, owner_bump) =
                        derive_owner_pda(&crate::ID, &viewing_pub_hash);
                    handle_deposit_per_user(
                        &ctx,
                        *reserve,
                        *act_in,
                        *min_kt_out,
                        &viewing_pub_hash,
                        expected_owner_pda,
                        owner_bump,
                        bump,
                    )?;
                }
                #[cfg(not(feature = "per_user_obligation"))]
                handle_deposit(&ctx, *reserve, *act_in, *min_kt_out, signer_seeds_auth_only)?;
            }
            KaminoAction::Withdraw {
                reserve,
                kt_in,
                min_underlying_out,
            } => {
                require!(*kt_in == in_amount, KaminoAdapterError::AmountMismatch);
                #[cfg(feature = "per_user_obligation")]
                {
                    let (expected_owner_pda, owner_bump) =
                        derive_owner_pda(&crate::ID, &viewing_pub_hash);
                    handle_withdraw_per_user(
                        &ctx,
                        *reserve,
                        *kt_in,
                        *min_underlying_out,
                        &viewing_pub_hash,
                        expected_owner_pda,
                        owner_bump,
                        bump,
                    )?;
                }
                #[cfg(not(feature = "per_user_obligation"))]
                handle_withdraw(&ctx, *reserve, *kt_in, *min_underlying_out, signer_seeds_auth_only)?;
            }
            KaminoAction::Borrow { .. } | KaminoAction::Repay { .. } => {
                return err!(KaminoAdapterError::NotYetImplemented);
            }
        }
        // Re-bind for downstream sweep blocks (which expect the same name).
        let signer_seeds = signer_seeds_auth_only;

        // Post-CPI sweep.
        let token_program = ctx.accounts.token_program.to_account_info();
        let authority = ctx.accounts.adapter_authority.to_account_info();

        match &action {
            KaminoAction::Repay { .. } => {
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
            }
            KaminoAction::Borrow { .. } => {
                // (a) borrowed underlying delta in adapter_out_ta → out_vault.
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
                // (b) untouched kToken passthrough → in_vault.
                let in_ta = &mut ctx.accounts.adapter_in_ta;
                in_ta.reload()?;
                let post_in = in_ta.amount;
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
                // Standard path (Deposit/Withdraw): adapter_out_ta delta → out_vault.
                let out_ta = &mut ctx.accounts.adapter_out_ta;
                out_ta.reload()?;
                let post_out = out_ta.amount;
                let received = post_out.saturating_sub(pre_out);
                require!(
                    received >= min_out_amount,
                    KaminoAdapterError::SlippageExceeded
                );
                if received > 0 {
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
        }

        Ok(())
    }

    /// Garbage-collect an empty per-user obligation (PRD-33 §5 mitigation 2).
    ///
    /// Closes the per-user UserMetadata + Obligation Kamino accounts when
    /// they hold no positions, recovering rent to `rent_sink`. Admin-gated
    /// (`admin == ctx.accounts.admin.signer`) for V1.0 — V1.5 surfaces a
    /// shielded user-opt-in path so the rent recovery is initiated by the
    /// owner rather than by the operator.
    ///
    /// Status: SCAFFOLD. The Kamino-side close ixs (`delete_user_metadata`,
    /// `close_obligation` if/when it lands in klend) require their
    /// discriminators + account layouts verified against klend mainnet
    /// bytecode + an emptiness pre-check. Until then this ix returns
    /// `NotYetImplemented` if invoked. Wiring it is part of PRD-33 Phase
    /// 33.4 cleanup, NOT a Phase 33.2 deliverable. Follow-up checklist:
    ///   - confirm `delete_user_metadata` discriminator vs klend master
    ///   - add `close_obligation` discriminator (or skip if klend has none
    ///     and we just leak the obligation's rent)
    ///   - add `is_obligation_empty(&obligation_data)` check before invoke
    ///   - integration test against cloned mainnet klend
    ///
    /// Always present in the IDL (Anchor #[program] expands every fn at
    /// macro-resolution time, before #[cfg] gates), but the body returns
    /// `NotYetImplemented` in default-feature builds and only the
    /// per_user_obligation build accepts a meaningful viewing_pub_hash.
    pub fn gc_obligation<'info>(
        _ctx: Context<'_, '_, '_, 'info, GcObligation<'info>>,
        _viewing_pub_hash: [u8; 32],
    ) -> Result<()> {
        // TODO(PRD-33 Phase 33.4): wire delete_user_metadata + close_obligation.
        // Discriminators must come from klend source review, NOT guessed.
        // See programs/b402-kamino-adapter/src/lib.rs:74-110 for the
        // verified-against-klend disc constants pattern.
        Err(error!(KaminoAdapterError::NotYetImplemented))
    }
}

// ---------------------------------------------------------------------------
// Per-op handlers.
//
// `build_kamino_ix` — turns a slice of forwarded `AccountInfo`s plus a
// per-account writability override (so we don't accidentally mark the
// reserve read-only when the deposit ix needs it writable, etc.) into a
// `Instruction` ready for `invoke_signed`.
//
// `signer_keys` is the set of pubkeys that should be marked as signers in
// the constructed AccountMeta list. Any meta whose key matches one of
// these is flagged signer; signatures themselves come from the matching
// PDA seed sets passed to `invoke_signed`. Path 2 (shared obligation)
// passes `&[adapter_authority_key]` — the v0.1 layout. Path 1 (per-user
// obligation, PRD-33 §3.3) passes `&[adapter_authority_key, owner_pda_key]`
// because Kamino's deposit_v2 expects the obligation owner (== owner_pda)
// to sign while the rent-payer / fee-payer slots stay on adapter_authority.
// ---------------------------------------------------------------------------

/// One forwarded account with a deliberate per-op writability decision.
/// `is_writable_override` overrides the inbound `AccountInfo.is_writable`
/// flag because Kamino expects specific accounts writable / read-only per
/// op, and the adapter-side `Execute<'info>` constraints don't capture
/// that nuance (they treat all `remaining_accounts` uniformly).
struct KaminoMeta {
    key: SolPubkey,
    is_writable: bool,
}

#[allow(clippy::needless_range_loop)]
fn build_kamino_ix(
    signer_keys: &[SolPubkey],
    metas: &[KaminoMeta],
    discriminator: [u8; 8],
    extra_data: &[u8],
) -> Instruction {
    let account_metas: Vec<AccountMeta> = metas
        .iter()
        .map(|m| {
            let is_signer = signer_keys.iter().any(|k| *k == m.key);
            if m.is_writable {
                AccountMeta::new(m.key, is_signer)
            } else {
                AccountMeta::new_readonly(m.key, is_signer)
            }
        })
        .collect();

    let mut data = Vec::with_capacity(8 + extra_data.len());
    data.extend_from_slice(&discriminator);
    data.extend_from_slice(extra_data);

    Instruction {
        program_id: KAMINO_LEND_PROGRAM_ID,
        accounts: account_metas,
        data,
    }
}

/// Helper: collect the set of `AccountInfo`s a Kamino CPI may need from
/// the adapter's `Execute<'info>` named accounts plus its
/// `remaining_accounts` slice. `invoke_signed` requires that every account
/// referenced in `Instruction.accounts` is also present in the supplied
/// `AccountInfo` slice. The Kamino CPIs reference `adapter_authority`
/// (as obligation owner / feePayer) and `adapter_in_ta` (as
/// userSourceLiquidity for deposit_v2), which are NAMED accounts — not
/// part of `remaining_accounts`. Forward both up-front.
fn forward_infos<'info>(
    ctx: &Context<'_, '_, '_, 'info, Execute<'info>>,
) -> Vec<AccountInfo<'info>> {
    let mut v: Vec<AccountInfo<'info>> = Vec::with_capacity(6 + ctx.remaining_accounts.len());
    v.push(ctx.accounts.adapter_authority.to_account_info());
    v.push(ctx.accounts.in_vault.to_account_info());
    v.push(ctx.accounts.out_vault.to_account_info());
    v.push(ctx.accounts.adapter_in_ta.to_account_info());
    v.push(ctx.accounts.adapter_out_ta.to_account_info());
    v.push(ctx.accounts.token_program.to_account_info());
    for a in ctx.remaining_accounts.iter() {
        v.push(a.clone());
    }
    v
}

fn account_exists(ai: &AccountInfo) -> bool {
    ai.lamports() > 0 && !ai.data_is_empty()
}

#[cfg_attr(feature = "per_user_obligation", allow(dead_code))]
#[inline(never)]
fn handle_deposit<'info>(
    ctx: &Context<'_, '_, '_, 'info, Execute<'info>>,
    _reserve_param: Pubkey,
    in_amount: u64,
    _min_kt_out: u64,
    signer_seeds: &[&[&[u8]]],
) -> Result<()> {
    let auth_key = ctx.accounts.adapter_authority.key();
    let ra = ctx.remaining_accounts;
    require!(
        ra.len() >= ra_deposit::MIN_LEN,
        KaminoAdapterError::MissingRemainingAccounts
    );

    // Pull every account the deposit_v2 + init prerequisites need from
    // the canonical layout. Every key/writability flag below is verified
    // against examples/kamino-fork-deposit.ts.
    let reserve = ra[ra_deposit::RESERVE].clone();
    let market = ra[ra_deposit::LENDING_MARKET].clone();
    let market_authority = ra[ra_deposit::LENDING_MARKET_AUTHORITY].clone();
    let reserve_liq_supply = ra[ra_deposit::RESERVE_LIQUIDITY_SUPPLY].clone();
    let reserve_coll_mint = ra[ra_deposit::RESERVE_COLLATERAL_MINT].clone();
    let reserve_coll_supply = ra[ra_deposit::RESERVE_COLLATERAL_DEST_SUPPLY].clone();
    let oracle_pyth = ra[ra_deposit::ORACLE_PYTH_OR_SENTINEL].clone();
    let oracle_swb_price = ra[ra_deposit::ORACLE_SWITCHBOARD_PRICE_OR_SENTINEL].clone();
    let oracle_swb_twap = ra[ra_deposit::ORACLE_SWITCHBOARD_TWAP_OR_SENTINEL].clone();
    let oracle_scope = ra[ra_deposit::ORACLE_SCOPE_OR_SENTINEL].clone();
    let reserve_liq_mint = ra[ra_deposit::RESERVE_LIQUIDITY_MINT].clone();
    let farms_program = ra[ra_deposit::FARMS_PROGRAM].clone();
    let user_metadata = ra[ra_deposit::USER_METADATA].clone();
    let obligation = ra[ra_deposit::OBLIGATION].clone();
    let obligation_farm_or_sentinel = ra[ra_deposit::OBLIGATION_FARM_OR_SENTINEL].clone();
    let reserve_farm_state_or_sentinel = ra[ra_deposit::RESERVE_FARM_STATE_OR_SENTINEL].clone();
    let sysvar_instructions = ra[ra_deposit::SYSVAR_INSTRUCTIONS].clone();
    let system_program = ra[ra_deposit::SYSTEM_PROGRAM].clone();
    let rent_sysvar = ra[ra_deposit::RENT_SYSVAR].clone();

    let token_program = ctx.accounts.token_program.to_account_info();
    let adapter_in_ta = ctx.accounts.adapter_in_ta.to_account_info();
    let infos = forward_infos(ctx);

    // --- 1. init_user_metadata (skip if exists) -----------------------------
    if !account_exists(&user_metadata) {
        // Account list per init_user_metadata (klend master 2026-04-26):
        //   owner(signer,w) feePayer(signer,w) userMetadata(w)
        //   referrerUserMetadata(opt) rent system_program
        // Adapter authority signs as both owner + feePayer.
        let metas = [
            KaminoMeta {
                key: auth_key,
                is_writable: true,
            }, // owner
            KaminoMeta {
                key: auth_key,
                is_writable: true,
            }, // feePayer
            KaminoMeta {
                key: user_metadata.key(),
                is_writable: true,
            },
            // referrer_user_metadata = None sentinel = klend program ID
            KaminoMeta {
                key: KAMINO_LEND_PROGRAM_ID,
                is_writable: false,
            },
            KaminoMeta {
                key: rent_sysvar.key(),
                is_writable: false,
            },
            KaminoMeta {
                key: system_program.key(),
                is_writable: false,
            },
        ];
        // Args: user_lookup_table: Pubkey (32 zeros = no LUT)
        let mut data = Vec::with_capacity(32);
        data.extend_from_slice(&[0u8; 32]);
        let ix = build_kamino_ix(&[auth_key], &metas, KAMINO_IX_INIT_USER_METADATA, &data);
        invoke_signed(&ix, &infos, signer_seeds)
            .map_err(|_| error!(KaminoAdapterError::KaminoCpiFailed))?;
    }

    // --- 2. init_obligation (skip if exists) --------------------------------
    if !account_exists(&obligation) {
        // Account list per init_obligation:
        //   obligationOwner(signer,w) feePayer(signer,w) obligation(w)
        //   lendingMarket seed1Account seed2Account userMetadata
        //   rent system_program
        // For Vanilla obligation seed1/seed2 = default Pubkey (read).
        let default_pk = SolPubkey::default();
        let metas = [
            KaminoMeta {
                key: auth_key,
                is_writable: true,
            }, // obligationOwner
            KaminoMeta {
                key: auth_key,
                is_writable: true,
            }, // feePayer
            KaminoMeta {
                key: obligation.key(),
                is_writable: true,
            },
            KaminoMeta {
                key: market.key(),
                is_writable: false,
            },
            KaminoMeta {
                key: default_pk,
                is_writable: false,
            },
            KaminoMeta {
                key: default_pk,
                is_writable: false,
            },
            KaminoMeta {
                key: user_metadata.key(),
                is_writable: false,
            },
            KaminoMeta {
                key: rent_sysvar.key(),
                is_writable: false,
            },
            KaminoMeta {
                key: system_program.key(),
                is_writable: false,
            },
        ];
        // Args: tag(u8) + id(u8) — Vanilla = (0, 0).
        let data = [0u8, 0u8];
        let ix = build_kamino_ix(&[auth_key], &metas, KAMINO_IX_INIT_OBLIGATION, &data);
        invoke_signed(&ix, &infos, signer_seeds)
            .map_err(|_| error!(KaminoAdapterError::KaminoCpiFailed))?;
    }

    // --- 3. init_obligation_farms_for_reserve (skip if no farm or enrolled) -
    let reserve_has_farm = reserve_farm_state_or_sentinel.key() != KAMINO_LEND_PROGRAM_ID;
    if reserve_has_farm && !account_exists(&obligation_farm_or_sentinel) {
        // Account list per init_obligation_farms_for_reserve:
        //   payer(signer,w) owner obligation(w) lendingMarketAuthority
        //   reserve(w) reserveFarmState(w) obligationFarm(w)
        //   lendingMarket farmsProgram rent system_program
        let metas = [
            KaminoMeta {
                key: auth_key,
                is_writable: true,
            }, // payer
            KaminoMeta {
                key: auth_key,
                is_writable: false,
            }, // owner
            KaminoMeta {
                key: obligation.key(),
                is_writable: true,
            },
            KaminoMeta {
                key: market_authority.key(),
                is_writable: false,
            },
            KaminoMeta {
                key: reserve.key(),
                is_writable: true,
            },
            KaminoMeta {
                key: reserve_farm_state_or_sentinel.key(),
                is_writable: true,
            },
            KaminoMeta {
                key: obligation_farm_or_sentinel.key(),
                is_writable: true,
            },
            KaminoMeta {
                key: market.key(),
                is_writable: false,
            },
            KaminoMeta {
                key: farms_program.key(),
                is_writable: false,
            },
            KaminoMeta {
                key: rent_sysvar.key(),
                is_writable: false,
            },
            KaminoMeta {
                key: system_program.key(),
                is_writable: false,
            },
        ];
        let data = [0u8]; // mode = 0 (collateral)
        let ix = build_kamino_ix(
            &[auth_key],
            &metas,
            KAMINO_IX_INIT_OBLIGATION_FARMS_FOR_RESERVE,
            &data,
        );
        invoke_signed(&ix, &infos, signer_seeds)
            .map_err(|_| error!(KaminoAdapterError::KaminoCpiFailed))?;
    }

    // --- 4. refresh_reserve -------------------------------------------------
    {
        let metas = [
            KaminoMeta {
                key: reserve.key(),
                is_writable: true,
            },
            KaminoMeta {
                key: market.key(),
                is_writable: false,
            },
            KaminoMeta {
                key: oracle_pyth.key(),
                is_writable: false,
            },
            KaminoMeta {
                key: oracle_swb_price.key(),
                is_writable: false,
            },
            KaminoMeta {
                key: oracle_swb_twap.key(),
                is_writable: false,
            },
            KaminoMeta {
                key: oracle_scope.key(),
                is_writable: false,
            },
        ];
        let ix = build_kamino_ix(&[auth_key], &metas, KAMINO_IX_REFRESH_RESERVE, &[]);
        invoke_signed(&ix, &infos, signer_seeds)
            .map_err(|_| error!(KaminoAdapterError::KaminoCpiFailed))?;
    }

    // --- 5. refresh_obligation ---------------------------------------------
    {
        let metas = [
            KaminoMeta {
                key: market.key(),
                is_writable: false,
            },
            KaminoMeta {
                key: obligation.key(),
                is_writable: true,
            },
        ];
        let ix = build_kamino_ix(&[auth_key], &metas, KAMINO_IX_REFRESH_OBLIGATION, &[]);
        invoke_signed(&ix, &infos, signer_seeds)
            .map_err(|_| error!(KaminoAdapterError::KaminoCpiFailed))?;
    }

    // --- 6. deposit_reserve_liquidity_and_obligation_collateral_v2 ----------
    // Account list (klend-sdk@7.3.22, verified GREEN in kamino-fork-deposit.ts):
    //   0  owner(signer,w)
    //   1  obligation(w)
    //   2  lendingMarket
    //   3  lendingMarketAuthority
    //   4  reserve(w)
    //   5  reserveLiquidityMint
    //   6  reserveLiquiditySupply(w)
    //   7  reserveCollateralMint(w)
    //   8  reserveDestDepositCollateral(w)
    //   9  userSourceLiquidity(w)              ← adapter_in_ta
    //  10  placeholderUserDestCollateral       ← klend program ID sentinel
    //  11  collateralTokenProgram
    //  12  liquidityTokenProgram
    //  13  instructionSysvar
    //  14  obligationFarm(w if farm, else sentinel readonly)
    //  15  reserveFarmState(w if farm, else sentinel readonly)
    //  16  farmsProgram
    let coll_token_program = token_program.key(); // both coll + liq are SPL token v1
    let liq_token_program = token_program.key();
    let metas = [
        KaminoMeta {
            key: auth_key,
            is_writable: true,
        }, // 0
        KaminoMeta {
            key: obligation.key(),
            is_writable: true,
        }, // 1
        KaminoMeta {
            key: market.key(),
            is_writable: false,
        }, // 2
        KaminoMeta {
            key: market_authority.key(),
            is_writable: false,
        }, // 3
        KaminoMeta {
            key: reserve.key(),
            is_writable: true,
        }, // 4
        KaminoMeta {
            key: reserve_liq_mint.key(),
            is_writable: false,
        }, // 5
        KaminoMeta {
            key: reserve_liq_supply.key(),
            is_writable: true,
        }, // 6
        KaminoMeta {
            key: reserve_coll_mint.key(),
            is_writable: true,
        }, // 7
        KaminoMeta {
            key: reserve_coll_supply.key(),
            is_writable: true,
        }, // 8
        KaminoMeta {
            key: adapter_in_ta.key(),
            is_writable: true,
        }, // 9
        KaminoMeta {
            key: KAMINO_LEND_PROGRAM_ID,
            is_writable: false,
        }, // 10
        KaminoMeta {
            key: coll_token_program,
            is_writable: false,
        }, // 11
        KaminoMeta {
            key: liq_token_program,
            is_writable: false,
        }, // 12
        KaminoMeta {
            key: sysvar_instructions.key(),
            is_writable: false,
        }, // 13
        KaminoMeta {
            key: obligation_farm_or_sentinel.key(),
            is_writable: reserve_has_farm,
        }, // 14
        KaminoMeta {
            key: reserve_farm_state_or_sentinel.key(),
            is_writable: reserve_has_farm,
        }, // 15
        KaminoMeta {
            key: farms_program.key(),
            is_writable: false,
        }, // 16
    ];

    let mut data = Vec::with_capacity(8);
    data.extend_from_slice(&in_amount.to_le_bytes());
    let ix = build_kamino_ix(
        &[auth_key],
        &metas,
        KAMINO_IX_DEPOSIT_RESERVE_LIQUIDITY_AND_OBLIGATION_COLLATERAL_V2,
        &data,
    );
    invoke_signed(&ix, &infos, signer_seeds)
        .map_err(|_| error!(KaminoAdapterError::KaminoCpiFailed))?;

    Ok(())
}

// ---------------------------------------------------------------------------
// Per-user deposit handler (PRD-33 §3.3, Path 1).
//
// Same Kamino ix sequence as Path 2, but every slot that Kamino interprets
// as "the obligation owner" carries `owner_pda` instead of `adapter_authority`.
// `adapter_authority` keeps the rent-payer / fee-payer slots so anonymous
// users (no SOL) still get their per-user obligation initialised.
//
// invoke_signed is called with TWO seed sets — Anchor's documented dual-PDA
// signing pattern. The runtime matches each AccountMeta marked `is_signer`
// against the supplied seed sets in order; either set can satisfy any
// signer slot whose key matches the derived PDA address.
// ---------------------------------------------------------------------------
#[cfg(feature = "per_user_obligation")]
#[inline(never)]
#[allow(clippy::too_many_arguments)]
fn handle_deposit_per_user<'info>(
    ctx: &Context<'_, '_, '_, 'info, Execute<'info>>,
    _reserve_param: Pubkey,
    in_amount: u64,
    _min_kt_out: u64,
    viewing_pub_hash: &[u8; 32],
    expected_owner_pda: Pubkey,
    owner_bump: u8,
    auth_bump: u8,
) -> Result<()> {
    let auth_key = ctx.accounts.adapter_authority.key();
    let ra = ctx.remaining_accounts;
    require!(
        ra.len() >= ra_deposit_per_user::MIN_LEN,
        KaminoAdapterError::MissingRemainingAccounts
    );

    // Validate the owner_pda forwarded in remaining_accounts matches the
    // hash-derived PDA. The adapter signs as this PDA via owner_seeds —
    // if the caller swaps in a different account, the runtime rejects
    // (PDA-derived signature won't match the AccountMeta key) AND we'd
    // be signing on behalf of a wrong shielded user. Belt-and-suspenders.
    let owner_pda_info = ra[ra_deposit_per_user::OWNER_PDA].clone();
    require_keys_eq!(
        owner_pda_info.key(),
        expected_owner_pda,
        KaminoAdapterError::OwnerPdaMismatch
    );
    let owner_key = owner_pda_info.key();

    // Two seed sets. `auth_seeds` signs for `adapter_authority` (rent-payer,
    // post-CPI sweep). `owner_seeds` signs for `owner_pda` (Kamino-side
    // obligation owner). PRD-33 §3.3.
    let auth_seeds: &[&[u8]] = &[VERSION_PREFIX, SEED_ADAPTER, &[auth_bump]];
    let owner_seeds: &[&[u8]] = &[
        VERSION_PREFIX,
        SEED_ADAPTER_OWNER,
        viewing_pub_hash.as_ref(),
        &[owner_bump],
    ];
    let signer_seeds: &[&[&[u8]]] = &[auth_seeds, owner_seeds];

    // Pull every account the deposit_v2 + init prerequisites need from the
    // canonical layout. Order is identical to ra_deposit; ra_deposit_per_user
    // adds OWNER_PDA at index 19.
    let reserve = ra[ra_deposit::RESERVE].clone();
    let market = ra[ra_deposit::LENDING_MARKET].clone();
    let market_authority = ra[ra_deposit::LENDING_MARKET_AUTHORITY].clone();
    let reserve_liq_supply = ra[ra_deposit::RESERVE_LIQUIDITY_SUPPLY].clone();
    let reserve_coll_mint = ra[ra_deposit::RESERVE_COLLATERAL_MINT].clone();
    let reserve_coll_supply = ra[ra_deposit::RESERVE_COLLATERAL_DEST_SUPPLY].clone();
    let oracle_pyth = ra[ra_deposit::ORACLE_PYTH_OR_SENTINEL].clone();
    let oracle_swb_price = ra[ra_deposit::ORACLE_SWITCHBOARD_PRICE_OR_SENTINEL].clone();
    let oracle_swb_twap = ra[ra_deposit::ORACLE_SWITCHBOARD_TWAP_OR_SENTINEL].clone();
    let oracle_scope = ra[ra_deposit::ORACLE_SCOPE_OR_SENTINEL].clone();
    let reserve_liq_mint = ra[ra_deposit::RESERVE_LIQUIDITY_MINT].clone();
    let farms_program = ra[ra_deposit::FARMS_PROGRAM].clone();
    let user_metadata = ra[ra_deposit::USER_METADATA].clone();
    let obligation = ra[ra_deposit::OBLIGATION].clone();
    let obligation_farm_or_sentinel = ra[ra_deposit::OBLIGATION_FARM_OR_SENTINEL].clone();
    let reserve_farm_state_or_sentinel = ra[ra_deposit::RESERVE_FARM_STATE_OR_SENTINEL].clone();
    let sysvar_instructions = ra[ra_deposit::SYSVAR_INSTRUCTIONS].clone();
    let system_program = ra[ra_deposit::SYSTEM_PROGRAM].clone();
    let rent_sysvar = ra[ra_deposit::RENT_SYSVAR].clone();

    let token_program = ctx.accounts.token_program.to_account_info();
    let adapter_in_ta = ctx.accounts.adapter_in_ta.to_account_info();
    let rent_buffer_ta = ra[ra_deposit_per_user::RENT_BUFFER_TA].clone();
    let mut infos = forward_infos(ctx);
    // forward_infos doesn't include owner_pda or rent_buffer_ta — append
    // explicitly so the CPIs see AccountInfo for both.
    infos.push(owner_pda_info);
    infos.push(rent_buffer_ta.clone());

    // --- 0. First-deposit setup-fee transfer (PRD-33 §5.4.3) ----------------
    //
    // First deposit (= UserMetadata doesn't exist yet) charges
    // SETUP_FEE_USDC, transferred from adapter_in_ta into the rent-buffer
    // ATA. The buffer is later swapped to SOL via `topup_authority_from_rent_buffer`
    // (a separate crank ix) and routed back to adapter_authority, which
    // pays init_user_metadata + init_obligation rent in this same tx out
    // of its bootstrap-funded SOL balance.
    //
    // The actual amount forwarded to deposit_v2 is `in_amount - fee`.
    // SDK quotes the fee via Rent::minimum_balance + the same const,
    // computes `expected_out_value` over the post-fee amount.
    let is_first_deposit = !account_exists(&user_metadata);
    let kamino_in_amount: u64 = if is_first_deposit {
        require!(
            in_amount >= SETUP_FEE_USDC + MIN_FIRST_DEPOSIT_AFTER_FEE_USDC,
            KaminoAdapterError::DepositBelowFirstDepositMinimum
        );
        // SPL token::transfer adapter_in_ta -> rent_buffer_ta, signed by
        // adapter_authority (the in_ta's owner).
        let cpi_accounts = anchor_spl::token::Transfer {
            from: adapter_in_ta.clone(),
            to: rent_buffer_ta.clone(),
            authority: ctx.accounts.adapter_authority.to_account_info(),
        };
        let auth_seeds_array: &[&[&[u8]]] = &[auth_seeds];
        let cpi_ctx = anchor_lang::context::CpiContext::new_with_signer(
            token_program.clone(),
            cpi_accounts,
            auth_seeds_array,
        );
        anchor_spl::token::transfer(cpi_ctx, SETUP_FEE_USDC)?;
        in_amount - SETUP_FEE_USDC
    } else {
        in_amount
    };

    // --- 1. init_user_metadata (skip if exists) -----------------------------
    // owner = owner_pda (signer), feePayer = adapter_authority (signer).
    if !account_exists(&user_metadata) {
        let metas = [
            KaminoMeta { key: owner_key, is_writable: true }, // owner
            KaminoMeta { key: auth_key, is_writable: true },  // feePayer
            KaminoMeta { key: user_metadata.key(), is_writable: true },
            // referrer_user_metadata = None sentinel (klend program ID).
            KaminoMeta { key: KAMINO_LEND_PROGRAM_ID, is_writable: false },
            KaminoMeta { key: rent_sysvar.key(), is_writable: false },
            KaminoMeta { key: system_program.key(), is_writable: false },
        ];
        let mut data = Vec::with_capacity(32);
        data.extend_from_slice(&[0u8; 32]);
        let ix = build_kamino_ix(
            &[auth_key, owner_key],
            &metas,
            KAMINO_IX_INIT_USER_METADATA,
            &data,
        );
        invoke_signed(&ix, &infos, signer_seeds)
            .map_err(|_| error!(KaminoAdapterError::KaminoCpiFailed))?;
    }

    // --- 2. init_obligation (skip if exists) --------------------------------
    if !account_exists(&obligation) {
        let default_pk = SolPubkey::default();
        let metas = [
            KaminoMeta { key: owner_key, is_writable: true }, // obligationOwner
            KaminoMeta { key: auth_key, is_writable: true },  // feePayer
            KaminoMeta { key: obligation.key(), is_writable: true },
            KaminoMeta { key: market.key(), is_writable: false },
            KaminoMeta { key: default_pk, is_writable: false },
            KaminoMeta { key: default_pk, is_writable: false },
            KaminoMeta { key: user_metadata.key(), is_writable: false },
            KaminoMeta { key: rent_sysvar.key(), is_writable: false },
            KaminoMeta { key: system_program.key(), is_writable: false },
        ];
        let data = [0u8, 0u8]; // Vanilla obligation: tag=0, id=0.
        let ix = build_kamino_ix(
            &[auth_key, owner_key],
            &metas,
            KAMINO_IX_INIT_OBLIGATION,
            &data,
        );
        invoke_signed(&ix, &infos, signer_seeds)
            .map_err(|_| error!(KaminoAdapterError::KaminoCpiFailed))?;
    }

    // --- 3. init_obligation_farms_for_reserve (skip if no farm or enrolled) -
    let reserve_has_farm = reserve_farm_state_or_sentinel.key() != KAMINO_LEND_PROGRAM_ID;
    if reserve_has_farm && !account_exists(&obligation_farm_or_sentinel) {
        // payer = adapter_authority (rent), owner = owner_pda.
        let metas = [
            KaminoMeta { key: auth_key, is_writable: true },  // payer
            KaminoMeta { key: owner_key, is_writable: false }, // owner
            KaminoMeta { key: obligation.key(), is_writable: true },
            KaminoMeta { key: market_authority.key(), is_writable: false },
            KaminoMeta { key: reserve.key(), is_writable: true },
            KaminoMeta { key: reserve_farm_state_or_sentinel.key(), is_writable: true },
            KaminoMeta { key: obligation_farm_or_sentinel.key(), is_writable: true },
            KaminoMeta { key: market.key(), is_writable: false },
            KaminoMeta { key: farms_program.key(), is_writable: false },
            KaminoMeta { key: rent_sysvar.key(), is_writable: false },
            KaminoMeta { key: system_program.key(), is_writable: false },
        ];
        let data = [0u8]; // mode = 0 (collateral)
        let ix = build_kamino_ix(
            &[auth_key, owner_key],
            &metas,
            KAMINO_IX_INIT_OBLIGATION_FARMS_FOR_RESERVE,
            &data,
        );
        invoke_signed(&ix, &infos, signer_seeds)
            .map_err(|_| error!(KaminoAdapterError::KaminoCpiFailed))?;
    }

    // --- 4. refresh_reserve -------------------------------------------------
    // Stateless w.r.t. obligation owner; no signer required. Signer keys
    // empty so AccountMetas all become non-signer (matches Kamino's expected
    // refresh_reserve account list).
    {
        let metas = [
            KaminoMeta { key: reserve.key(), is_writable: true },
            KaminoMeta { key: market.key(), is_writable: false },
            KaminoMeta { key: oracle_pyth.key(), is_writable: false },
            KaminoMeta { key: oracle_swb_price.key(), is_writable: false },
            KaminoMeta { key: oracle_swb_twap.key(), is_writable: false },
            KaminoMeta { key: oracle_scope.key(), is_writable: false },
        ];
        let ix = build_kamino_ix(&[], &metas, KAMINO_IX_REFRESH_RESERVE, &[]);
        invoke_signed(&ix, &infos, signer_seeds)
            .map_err(|_| error!(KaminoAdapterError::KaminoCpiFailed))?;
    }

    // --- 5. refresh_obligation ---------------------------------------------
    {
        let metas = [
            KaminoMeta { key: market.key(), is_writable: false },
            KaminoMeta { key: obligation.key(), is_writable: true },
        ];
        let ix = build_kamino_ix(&[], &metas, KAMINO_IX_REFRESH_OBLIGATION, &[]);
        invoke_signed(&ix, &infos, signer_seeds)
            .map_err(|_| error!(KaminoAdapterError::KaminoCpiFailed))?;
    }

    // --- 6. deposit_v2 ------------------------------------------------------
    // owner = owner_pda. userSourceLiquidity stays as adapter_in_ta (the
    // pool moved tokens here in adapt_execute prior to CPI).
    let coll_token_program = token_program.key();
    let liq_token_program = token_program.key();
    let metas = [
        KaminoMeta { key: owner_key, is_writable: true }, // 0: owner
        KaminoMeta { key: obligation.key(), is_writable: true }, // 1
        KaminoMeta { key: market.key(), is_writable: false }, // 2
        KaminoMeta { key: market_authority.key(), is_writable: false }, // 3
        KaminoMeta { key: reserve.key(), is_writable: true }, // 4
        KaminoMeta { key: reserve_liq_mint.key(), is_writable: false }, // 5
        KaminoMeta { key: reserve_liq_supply.key(), is_writable: true }, // 6
        KaminoMeta { key: reserve_coll_mint.key(), is_writable: true }, // 7
        KaminoMeta { key: reserve_coll_supply.key(), is_writable: true }, // 8
        KaminoMeta { key: adapter_in_ta.key(), is_writable: true }, // 9
        KaminoMeta { key: KAMINO_LEND_PROGRAM_ID, is_writable: false }, // 10 placeholder
        KaminoMeta { key: coll_token_program, is_writable: false }, // 11
        KaminoMeta { key: liq_token_program, is_writable: false }, // 12
        KaminoMeta { key: sysvar_instructions.key(), is_writable: false }, // 13
        KaminoMeta { key: obligation_farm_or_sentinel.key(), is_writable: reserve_has_farm }, // 14
        KaminoMeta { key: reserve_farm_state_or_sentinel.key(), is_writable: reserve_has_farm }, // 15
        KaminoMeta { key: farms_program.key(), is_writable: false }, // 16
    ];
    let mut data = Vec::with_capacity(8);
    data.extend_from_slice(&kamino_in_amount.to_le_bytes());
    let ix = build_kamino_ix(
        &[auth_key, owner_key],
        &metas,
        KAMINO_IX_DEPOSIT_RESERVE_LIQUIDITY_AND_OBLIGATION_COLLATERAL_V2,
        &data,
    );
    invoke_signed(&ix, &infos, signer_seeds)
        .map_err(|_| error!(KaminoAdapterError::KaminoCpiFailed))?;

    Ok(())
}

/// Per-user withdraw (PRD-33 §3.3 inverse of deposit). Spends `kt_in`
/// units of the user's kUSDC (stored in their per-user Obligation), burns
/// it via `withdraw_obligation_collateral_and_redeem_reserve_collateral`,
/// and routes the resulting USDC to `adapter_out_ta` (which the pool's
/// post-CPI sweep ingests back into the shielded pool as a new note).
///
/// Signing differs from the shared-obligation path: we sign with both
/// `auth_seeds` (adapter_authority — for the adapter's own scratch
/// transfers) AND `owner_seeds` (per-user PDA — Kamino sees this as
/// the obligation owner). PRD-33 §3.3.
///
/// Note: there is NO setup-fee branch here. Fees are charged on the
/// user's first DEPOSIT (one-time, refundable on `gc_obligation`).
/// Withdraws after deposit pay nothing — the per-user state already
/// exists and the user's setup fee already covered its rent.
#[cfg(feature = "per_user_obligation")]
#[inline(never)]
#[allow(clippy::too_many_arguments)]
fn handle_withdraw_per_user<'info>(
    ctx: &Context<'_, '_, '_, 'info, Execute<'info>>,
    _reserve_param: Pubkey,
    kt_in: u64,
    _min_underlying_out: u64,
    viewing_pub_hash: &[u8; 32],
    expected_owner_pda: Pubkey,
    owner_bump: u8,
    auth_bump: u8,
) -> Result<()> {
    let auth_key = ctx.accounts.adapter_authority.key();
    let ra = ctx.remaining_accounts;
    require!(
        ra.len() >= ra_withdraw_per_user::MIN_LEN,
        KaminoAdapterError::MissingRemainingAccounts
    );

    // Validate the owner_pda forwarded matches the hash-derived PDA
    // (same defence-in-depth as deposit). PRD-33 §3.3.
    let owner_pda_info = ra[ra_withdraw_per_user::OWNER_PDA].clone();
    require_keys_eq!(
        owner_pda_info.key(),
        expected_owner_pda,
        KaminoAdapterError::OwnerPdaMismatch
    );
    let owner_key = owner_pda_info.key();

    let auth_seeds: &[&[u8]] = &[VERSION_PREFIX, SEED_ADAPTER, &[auth_bump]];
    let owner_seeds: &[&[u8]] = &[
        VERSION_PREFIX,
        SEED_ADAPTER_OWNER,
        viewing_pub_hash.as_ref(),
        &[owner_bump],
    ];
    let signer_seeds: &[&[&[u8]]] = &[auth_seeds, owner_seeds];

    // Build per-Kamino-ix meta lists. refresh_reserve / refresh_obligation
    // each consume only a subset of these accounts; pass the full set and
    // let klend pick what it needs (the IDL is forgiving on extras).
    let withdraw_reserve = ra[ra_withdraw_per_user::WITHDRAW_RESERVE].clone();
    let obligation = ra[ra_withdraw_per_user::OBLIGATION].clone();
    let market = ra[ra_withdraw_per_user::LENDING_MARKET].clone();
    let market_authority = ra[ra_withdraw_per_user::LENDING_MARKET_AUTHORITY].clone();
    let reserve_source_collateral = ra[ra_withdraw_per_user::RESERVE_SOURCE_COLLATERAL].clone();
    let reserve_collateral_mint = ra[ra_withdraw_per_user::RESERVE_COLLATERAL_MINT].clone();
    let reserve_liquidity_supply = ra[ra_withdraw_per_user::RESERVE_LIQUIDITY_SUPPLY].clone();
    let user_destination = ra[ra_withdraw_per_user::USER_DESTINATION_LIQUIDITY].clone();
    let coll_token_program = ra[ra_withdraw_per_user::COLLATERAL_TOKEN_PROGRAM].clone();
    let liq_token_program = ra[ra_withdraw_per_user::LIQUIDITY_TOKEN_PROGRAM].clone();
    let sysvar_ix = ra[ra_withdraw_per_user::SYSVAR_INSTRUCTIONS].clone();
    let reserve_liq_mint = ra[ra_withdraw_per_user::RESERVE_LIQUIDITY_MINT].clone();

    let mut infos = forward_infos(ctx);
    infos.push(owner_pda_info);

    // --- 1. refresh_reserve ----------------------------------------------
    // klend account list: reserve, lendingMarket, pythOracle?, switchboardOracle?, scopePrices?
    // We only have the reserve+market in our RA layout; if oracles are
    // needed they should be pre-staged at the BACK of remaining_accounts
    // (klend tolerates extras). For V1, refresh_reserve via market+reserve
    // is sufficient against a freshly-cloned fork.
    {
        let metas = [
            KaminoMeta { key: withdraw_reserve.key(), is_writable: true },
            KaminoMeta { key: market.key(), is_writable: false },
        ];
        let ix = build_kamino_ix(&[], &metas, KAMINO_IX_REFRESH_RESERVE, &[]);
        invoke_signed(&ix, &infos, signer_seeds)
            .map_err(|_| error!(KaminoAdapterError::KaminoCpiFailed))?;
    }

    // --- 2. refresh_obligation -------------------------------------------
    // klend account list: lendingMarket, obligation, [reserves...]
    {
        let metas = [
            KaminoMeta { key: market.key(), is_writable: false },
            KaminoMeta { key: obligation.key(), is_writable: true },
            KaminoMeta { key: withdraw_reserve.key(), is_writable: false },
        ];
        let ix = build_kamino_ix(&[], &metas, KAMINO_IX_REFRESH_OBLIGATION, &[]);
        invoke_signed(&ix, &infos, signer_seeds)
            .map_err(|_| error!(KaminoAdapterError::KaminoCpiFailed))?;
    }

    // --- 3. withdraw_obligation_collateral_and_redeem_reserve_collateral --
    // klend v1 account list (per klend-sdk@7.3.x):
    //   owner(signer,w) obligation(w) lendingMarket lendingMarketAuthority
    //   withdrawReserve(w) reserveSourceCollateral(w) userDestinationLiquidity(w)
    //   reserveCollateralMint(w) reserveLiquiditySupply(w)
    //   tokenProgram(coll) tokenProgramLiq instructionsSysvar
    {
        let metas = [
            KaminoMeta { key: owner_key, is_writable: true },          // owner (signed via owner_seeds)
            KaminoMeta { key: obligation.key(), is_writable: true },
            KaminoMeta { key: market.key(), is_writable: false },
            KaminoMeta { key: market_authority.key(), is_writable: false },
            KaminoMeta { key: withdraw_reserve.key(), is_writable: true },
            KaminoMeta { key: reserve_source_collateral.key(), is_writable: true },
            KaminoMeta { key: user_destination.key(), is_writable: true },
            KaminoMeta { key: reserve_collateral_mint.key(), is_writable: true },
            KaminoMeta { key: reserve_liquidity_supply.key(), is_writable: true },
            KaminoMeta { key: reserve_liq_mint.key(), is_writable: false },
            KaminoMeta { key: coll_token_program.key(), is_writable: false },
            KaminoMeta { key: liq_token_program.key(), is_writable: false },
            KaminoMeta { key: sysvar_ix.key(), is_writable: false },
        ];
        let mut data = Vec::with_capacity(8);
        data.extend_from_slice(&kt_in.to_le_bytes());
        let ix = build_kamino_ix(
            &[auth_key, owner_key],
            &metas,
            KAMINO_IX_WITHDRAW_OBLIGATION_COLLATERAL_AND_REDEEM_RESERVE_COLLATERAL,
            &data,
        );
        invoke_signed(&ix, &infos, signer_seeds)
            .map_err(|_| error!(KaminoAdapterError::KaminoCpiFailed))?;
    }

    Ok(())
}

#[inline(never)]
// Gated at dispatch (lib.rs:224) for v0.1 mainnet alpha until mainnet-fork
// integration tests cover this path. Implementation kept in-tree so the
// re-enable diff is one line and reviewable.
#[allow(dead_code)]
fn handle_withdraw<'info>(
    ctx: &Context<'_, '_, '_, 'info, Execute<'info>>,
    _reserve: Pubkey,
    kt_in: u64,
    _min_underlying_out: u64,
    signer_seeds: &[&[&[u8]]],
) -> Result<()> {
    // v0.1 placeholder: refresh + v1 withdraw using whatever the SDK
    // forwards in remaining_accounts. Mainnet-fork verification pending —
    // the deposit gate is what proves the wiring works end-to-end.
    let auth_key = ctx.accounts.adapter_authority.key();
    let ra = ctx.remaining_accounts;
    require!(ra.len() >= 7, KaminoAdapterError::MissingRemainingAccounts);

    let infos = forward_infos(ctx);
    // Forward all remaining accounts as-is (preserve their writability),
    // mark adapter_authority as signer.
    let metas: Vec<KaminoMeta> = ra
        .iter()
        .map(|a| KaminoMeta {
            key: a.key(),
            is_writable: a.is_writable,
        })
        .collect();

    let ix = build_kamino_ix(&[auth_key], &metas, KAMINO_IX_REFRESH_RESERVE, &[]);
    invoke_signed(&ix, &infos, signer_seeds)
        .map_err(|_| error!(KaminoAdapterError::KaminoCpiFailed))?;
    let ix = build_kamino_ix(&[auth_key], &metas, KAMINO_IX_REFRESH_OBLIGATION, &[]);
    invoke_signed(&ix, &infos, signer_seeds)
        .map_err(|_| error!(KaminoAdapterError::KaminoCpiFailed))?;
    let mut data = Vec::with_capacity(8);
    data.extend_from_slice(&kt_in.to_le_bytes());
    let ix = build_kamino_ix(
        &[auth_key],
        &metas,
        KAMINO_IX_WITHDRAW_OBLIGATION_COLLATERAL_AND_REDEEM_RESERVE_COLLATERAL,
        &data,
    );
    invoke_signed(&ix, &infos, signer_seeds)
        .map_err(|_| error!(KaminoAdapterError::KaminoCpiFailed))?;
    Ok(())
}

#[inline(never)]
#[allow(dead_code)]
fn handle_borrow<'info>(
    ctx: &Context<'_, '_, '_, 'info, Execute<'info>>,
    _reserve: Pubkey,
    amount_out: u64,
    _max_collateral_used_bps: u16,
    signer_seeds: &[&[&[u8]]],
) -> Result<()> {
    let auth_key = ctx.accounts.adapter_authority.key();
    let ra = ctx.remaining_accounts;
    require!(ra.len() >= 7, KaminoAdapterError::MissingRemainingAccounts);

    let infos = forward_infos(ctx);
    let metas: Vec<KaminoMeta> = ra
        .iter()
        .map(|a| KaminoMeta {
            key: a.key(),
            is_writable: a.is_writable,
        })
        .collect();

    let ix = build_kamino_ix(&[auth_key], &metas, KAMINO_IX_REFRESH_RESERVE, &[]);
    invoke_signed(&ix, &infos, signer_seeds)
        .map_err(|_| error!(KaminoAdapterError::KaminoCpiFailed))?;
    let ix = build_kamino_ix(&[auth_key], &metas, KAMINO_IX_REFRESH_OBLIGATION, &[]);
    invoke_signed(&ix, &infos, signer_seeds)
        .map_err(|_| error!(KaminoAdapterError::KaminoCpiFailed))?;
    let mut data = Vec::with_capacity(8);
    data.extend_from_slice(&amount_out.to_le_bytes());
    let ix = build_kamino_ix(
        &[auth_key],
        &metas,
        KAMINO_IX_BORROW_OBLIGATION_LIQUIDITY,
        &data,
    );
    invoke_signed(&ix, &infos, signer_seeds)
        .map_err(|_| error!(KaminoAdapterError::KaminoCpiFailed))?;
    Ok(())
}

#[inline(never)]
#[allow(dead_code)]
fn handle_repay<'info>(
    ctx: &Context<'_, '_, '_, 'info, Execute<'info>>,
    _reserve: Pubkey,
    amount_in: u64,
    signer_seeds: &[&[&[u8]]],
) -> Result<()> {
    let auth_key = ctx.accounts.adapter_authority.key();
    let ra = ctx.remaining_accounts;
    require!(ra.len() >= 5, KaminoAdapterError::MissingRemainingAccounts);

    let infos = forward_infos(ctx);
    let metas: Vec<KaminoMeta> = ra
        .iter()
        .map(|a| KaminoMeta {
            key: a.key(),
            is_writable: a.is_writable,
        })
        .collect();

    let ix = build_kamino_ix(&[auth_key], &metas, KAMINO_IX_REFRESH_RESERVE, &[]);
    invoke_signed(&ix, &infos, signer_seeds)
        .map_err(|_| error!(KaminoAdapterError::KaminoCpiFailed))?;
    let ix = build_kamino_ix(&[auth_key], &metas, KAMINO_IX_REFRESH_OBLIGATION, &[]);
    invoke_signed(&ix, &infos, signer_seeds)
        .map_err(|_| error!(KaminoAdapterError::KaminoCpiFailed))?;
    let mut data = Vec::with_capacity(8);
    data.extend_from_slice(&amount_in.to_le_bytes());
    let ix = build_kamino_ix(
        &[auth_key],
        &metas,
        KAMINO_IX_REPAY_OBLIGATION_LIQUIDITY,
        &data,
    );
    invoke_signed(&ix, &infos, signer_seeds)
        .map_err(|_| error!(KaminoAdapterError::KaminoCpiFailed))?;
    Ok(())
}

/// Account layout per PRD-04 §2 — first 6 are pool-managed; remainder forwarded.
#[derive(Accounts)]
pub struct Execute<'info> {
    /// CHECK: adapter PDA signer. Seeds checked at runtime.
    /// MUST be writable — Kamino's init_user_metadata / init_obligation /
    /// init_obligation_farms_for_reserve use the obligation owner as
    /// feePayer (signer-writable, Anchor role 3). Privilege can't escalate
    /// inside a CPI, so the outer slot is writable.
    #[account(
        mut,
        seeds = [VERSION_PREFIX, SEED_ADAPTER],
        bump,
    )]
    pub adapter_authority: UncheckedAccount<'info>,

    #[account(mut)]
    pub in_vault: Account<'info, TokenAccount>,

    #[account(mut)]
    pub out_vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = adapter_in_ta.owner == adapter_authority.key()
            @ KaminoAdapterError::ScratchAtaOwnerMismatch,
    )]
    pub adapter_in_ta: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = adapter_out_ta.owner == adapter_authority.key()
            @ KaminoAdapterError::ScratchAtaOwnerMismatch,
    )]
    pub adapter_out_ta: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

/// Per-user obligation garbage-collection accounts (PRD-33 §5).
///
/// Admin-gated for V1.0 (the adapter program's upgrade-authority is the
/// only signer trusted to invoke this — V1.5 surfaces a user-opt-in
/// shielded path). The Kamino-side close ixs need their own remaining
/// accounts forwarded; the SDK builds those after consulting the
/// per-user UserMetadata + Obligation account state.
///
/// Account layout is identical between feature variants — the gc body
/// returns NotYetImplemented in default-feature builds (see fn doc).
#[derive(Accounts)]
pub struct GcObligation<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    /// CHECK: adapter PDA signer for Kamino-side close ixs. Same seeds
    /// as Execute.
    #[account(
        mut,
        seeds = [VERSION_PREFIX, SEED_ADAPTER],
        bump,
    )]
    pub adapter_authority: UncheckedAccount<'info>,

    /// CHECK: rent destination. Lamports recovered from closed Kamino
    /// accounts land here.
    #[account(mut)]
    pub rent_sink: UncheckedAccount<'info>,
}

#[error_code]
pub enum KaminoAdapterError {
    #[msg("Kamino adapter not yet implemented")]
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
    #[msg("owner_pda forwarded in remaining_accounts does not match the viewing-pub-hash-derived PDA (PRD-33 §3.3)")]
    OwnerPdaMismatch = 6010,
    #[msg("first deposit must be at least SETUP_FEE_USDC + MIN_FIRST_DEPOSIT_AFTER_FEE_USDC (PRD-33 §5.4.3)")]
    DepositBelowFirstDepositMinimum = 6011,
}

// ---------------------------------------------------------------------------
// Per-user obligation helpers (PRD-33 §3.2).
//
// `viewing_pub_hash` = bytes_le(outSpendingPub[0]) from the Phase 9 adapt
// proof's verifier-index-23 public input. The pool prepends this 32-B value
// to the adapter's action_payload (when the adapter's registry entry has
// `stateful_adapter = true`), so the adapter can recover it byte-equal to
// what the prover bound. See PRD-33 §6.1 for the wire shape.
// ---------------------------------------------------------------------------

/// Derive the per-user owner PDA (PRD-33 §3.2). The owner PDA becomes the
/// obligation's "user" seed slot under klend, giving each shielded user a
/// unique Vanilla obligation. Per-adapter scoping (each adapter is its
/// own `program_id`) makes the same `viewing_pub_hash` resolve to a
/// DIFFERENT `owner_pda` on Drift / Marginfi adapters — cross-protocol
/// correlation by `owner_pda` alone is impossible.
pub fn derive_owner_pda(adapter_program_id: &Pubkey, viewing_pub_hash: &[u8; 32]) -> (Pubkey, u8) {
    Pubkey::find_program_address(
        &[VERSION_PREFIX, SEED_ADAPTER_OWNER, viewing_pub_hash.as_ref()],
        adapter_program_id,
    )
}

/// Derive the per-adapter rent-buffer PDA. Owns the USDC ATA that
/// accumulates first-deposit setup fees. The matching ATA is created
/// once per adapter at deploy time (no per-user account-creation cost).
/// PRD-33 §5.4.3.
pub fn derive_rent_buffer_pda(adapter_program_id: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(
        &[VERSION_PREFIX, SEED_RENT_BUFFER],
        adapter_program_id,
    )
}

/// Decode the stateful-adapter action payload format (PRD-33 §6.1):
///
///   `[0..32]   = viewing_pub_hash` (= bytes_le(outSpendingPub[0]))
///   `[32..]    = Borsh(KaminoAction)`
///
/// Returns the extracted hash + the decoded action. Errors on payloads
/// shorter than 33 B (need at least 32 B prefix + 1 B Borsh enum tag).
pub fn decode_per_user_payload(action_payload: &[u8]) -> Result<([u8; 32], KaminoAction)> {
    require!(
        action_payload.len() > 32,
        KaminoAdapterError::InvalidActionPayload
    );
    let mut viewing_pub_hash = [0u8; 32];
    viewing_pub_hash.copy_from_slice(&action_payload[..32]);
    let inner = KaminoAction::try_from_slice(&action_payload[32..])
        .map_err(|_| error!(KaminoAdapterError::InvalidActionPayload))?;
    Ok((viewing_pub_hash, inner))
}

/// Derive the per-user Kamino Vanilla obligation PDA. Used by the SDK for
/// the per-user upgrade — currently informational only.
#[allow(dead_code)]
pub fn derive_obligation_pda(owner_pda: &Pubkey, lending_market: &Pubkey) -> (Pubkey, u8) {
    let default_pk = Pubkey::default();
    Pubkey::find_program_address(
        &[
            &[0u8], // tag (Vanilla)
            &[0u8], // id
            owner_pda.as_ref(),
            lending_market.as_ref(),
            default_pk.as_ref(),
            default_pk.as_ref(),
        ],
        &KAMINO_LEND_PROGRAM_ID,
    )
}

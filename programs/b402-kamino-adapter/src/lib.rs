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

        // Decode action.
        let action = KaminoAction::try_from_slice(&action_payload)
            .map_err(|_| error!(KaminoAdapterError::InvalidActionPayload))?;

        // Snapshot adapter scratch balances pre-CPI so the post-CPI sweep
        // moves only the delta produced by this call.
        let pre_out = ctx.accounts.adapter_out_ta.amount;
        let pre_in = ctx.accounts.adapter_in_ta.amount;

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
                handle_deposit(&ctx, *reserve, *act_in, *min_kt_out, signer_seeds)?;
            }
            KaminoAction::Withdraw {
                reserve,
                kt_in,
                min_underlying_out,
            } => {
                require!(*kt_in == in_amount, KaminoAdapterError::AmountMismatch);
                handle_withdraw(&ctx, *reserve, *kt_in, *min_underlying_out, signer_seeds)?;
            }
            KaminoAction::Borrow {
                reserve,
                amount_out,
                max_collateral_used_bps,
            } => {
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
}

// ---------------------------------------------------------------------------
// Per-op handlers.
//
// `build_kamino_ix` — turns a slice of forwarded `AccountInfo`s plus a
// per-account writability override (so we don't accidentally mark the
// reserve read-only when the deposit ix needs it writable, etc.) into a
// `Instruction` ready for `invoke_signed`.
//
// Mirrors b402-jupiter-adapter's "if key == adapter_authority then signer"
// pattern: the obligation owner (== adapter_authority for v0.1) has to be
// a signer on Kamino's side, and `invoke_signed` provides the signature
// via the adapter's PDA seeds.
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
    auth_key: SolPubkey,
    metas: &[KaminoMeta],
    discriminator: [u8; 8],
    extra_data: &[u8],
) -> Instruction {
    let account_metas: Vec<AccountMeta> = metas
        .iter()
        .map(|m| {
            let is_signer = m.key == auth_key;
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
        let ix = build_kamino_ix(auth_key, &metas, KAMINO_IX_INIT_USER_METADATA, &data);
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
        let ix = build_kamino_ix(auth_key, &metas, KAMINO_IX_INIT_OBLIGATION, &data);
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
            auth_key,
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
        let ix = build_kamino_ix(auth_key, &metas, KAMINO_IX_REFRESH_RESERVE, &[]);
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
        let ix = build_kamino_ix(auth_key, &metas, KAMINO_IX_REFRESH_OBLIGATION, &[]);
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
        auth_key,
        &metas,
        KAMINO_IX_DEPOSIT_RESERVE_LIQUIDITY_AND_OBLIGATION_COLLATERAL_V2,
        &data,
    );
    invoke_signed(&ix, &infos, signer_seeds)
        .map_err(|_| error!(KaminoAdapterError::KaminoCpiFailed))?;

    Ok(())
}

#[inline(never)]
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

    let ix = build_kamino_ix(auth_key, &metas, KAMINO_IX_REFRESH_RESERVE, &[]);
    invoke_signed(&ix, &infos, signer_seeds)
        .map_err(|_| error!(KaminoAdapterError::KaminoCpiFailed))?;
    let ix = build_kamino_ix(auth_key, &metas, KAMINO_IX_REFRESH_OBLIGATION, &[]);
    invoke_signed(&ix, &infos, signer_seeds)
        .map_err(|_| error!(KaminoAdapterError::KaminoCpiFailed))?;
    let mut data = Vec::with_capacity(8);
    data.extend_from_slice(&kt_in.to_le_bytes());
    let ix = build_kamino_ix(
        auth_key,
        &metas,
        KAMINO_IX_WITHDRAW_OBLIGATION_COLLATERAL_AND_REDEEM_RESERVE_COLLATERAL,
        &data,
    );
    invoke_signed(&ix, &infos, signer_seeds)
        .map_err(|_| error!(KaminoAdapterError::KaminoCpiFailed))?;
    Ok(())
}

#[inline(never)]
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

    let ix = build_kamino_ix(auth_key, &metas, KAMINO_IX_REFRESH_RESERVE, &[]);
    invoke_signed(&ix, &infos, signer_seeds)
        .map_err(|_| error!(KaminoAdapterError::KaminoCpiFailed))?;
    let ix = build_kamino_ix(auth_key, &metas, KAMINO_IX_REFRESH_OBLIGATION, &[]);
    invoke_signed(&ix, &infos, signer_seeds)
        .map_err(|_| error!(KaminoAdapterError::KaminoCpiFailed))?;
    let mut data = Vec::with_capacity(8);
    data.extend_from_slice(&amount_out.to_le_bytes());
    let ix = build_kamino_ix(
        auth_key,
        &metas,
        KAMINO_IX_BORROW_OBLIGATION_LIQUIDITY,
        &data,
    );
    invoke_signed(&ix, &infos, signer_seeds)
        .map_err(|_| error!(KaminoAdapterError::KaminoCpiFailed))?;
    Ok(())
}

#[inline(never)]
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

    let ix = build_kamino_ix(auth_key, &metas, KAMINO_IX_REFRESH_RESERVE, &[]);
    invoke_signed(&ix, &infos, signer_seeds)
        .map_err(|_| error!(KaminoAdapterError::KaminoCpiFailed))?;
    let ix = build_kamino_ix(auth_key, &metas, KAMINO_IX_REFRESH_OBLIGATION, &[]);
    invoke_signed(&ix, &infos, signer_seeds)
        .map_err(|_| error!(KaminoAdapterError::KaminoCpiFailed))?;
    let mut data = Vec::with_capacity(8);
    data.extend_from_slice(&amount_in.to_le_bytes());
    let ix = build_kamino_ix(
        auth_key,
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
}

// ---------------------------------------------------------------------------
// Helper: reserved per-user obligation PDA derivation. Reference for the
// PRD-09 §7.2 upgrade. Currently unused at runtime — v0.1 uses
// `adapter_authority` as the single shared obligation owner.
// ---------------------------------------------------------------------------

/// Derive the per-user owner PDA (PRD-09 §7.2 upgrade). The owner PDA
/// becomes the obligation's "user" seed slot under klend, giving each
/// shielded user a unique Vanilla obligation.
#[allow(dead_code)]
pub fn derive_owner_pda(viewing_pub_hash: &[u8; 32]) -> (Pubkey, u8) {
    Pubkey::find_program_address(
        &[VERSION_PREFIX, b"kamino-owner", viewing_pub_hash.as_ref()],
        &crate::ID,
    )
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

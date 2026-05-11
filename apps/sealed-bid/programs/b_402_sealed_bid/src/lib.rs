//! b402 sealed-bid matcher — on-chain Anchor wrapper for the Arcis
//! `match_pair` MPC circuit.
//!
//! Flow:
//!   1. `init_match_pair_comp_def` — one-time setup that registers the
//!      Arcis circuit with the MXE.
//!   2. `submit_pair(ciphertexts_a, pubkey_a, nonce_a, ciphertexts_b,
//!      pubkey_b, nonce_b)` — accepts two independently-encrypted
//!      `SwapIntent`s, queues the MPC computation.
//!   3. `match_pair_callback` — fires when the MPC node cluster
//!      finishes. Emits a `PairMatched` event carrying the cleared
//!      terms; off-chain settlement (the b402 relayer + each user's
//!      ZK-prover) reads the event and submits the b402 `privateSwap`
//!      tx for the matched pair.
//!
//! Why settlement is two-step (not inline-CPI in callback):
//!   `b402_pool::adapt_execute_v2` requires a Groth16 proof that the
//!   spender owns the shielded note being spent. The proof binds to the
//!   user's `spending_priv` — secret data the MXE never sees. So the
//!   callback can't construct the settlement tx itself. Instead it
//!   emits the cleared terms publicly; each winning bidder builds their
//!   own ZK proof off-chain and settles via the existing b402 relayer
//!   (wallet never appears on chain).
//!
//! See `docs/spikes/SPIKE-sealed-bid-architecture.md` (local) for the
//! end-to-end flow.

use anchor_lang::prelude::*;
use arcium_anchor::prelude::*;

const COMP_DEF_OFFSET_MATCH_PAIR: u32 = comp_def_offset("match_pair");

declare_id!("8pq15sh91b48FZymok9jR1WFi2fFiNWUPHPpmfCZptmq");

#[arcium_program]
pub mod b_402_sealed_bid {
    use super::*;

    /// One-time registration of the Arcis `match_pair` circuit with the
    /// MXE. Called once after deploy.
    pub fn init_match_pair_comp_def(ctx: Context<InitMatchPairCompDef>) -> Result<()> {
        init_comp_def(ctx.accounts, None, None)?;
        Ok(())
    }

    /// Submit two independently-encrypted `SwapIntent`s for pair-match.
    ///
    /// Each bidder client encrypts their `SwapIntent` to the MXE's
    /// pubkey using their own x25519 key + a fresh nonce. The b402
    /// relayer batches the two ciphertexts and submits them in a single
    /// `submit_pair` tx — so the submitter on chain is the relayer, not
    /// either bidder.
    ///
    /// The encrypted `SwapIntent` struct (see encrypted-ixs) has 5
    /// fields:  bid_idx u8, in_mint_id u8, out_mint_id u8,
    /// in_amount u64, min_out_amount u64. Each field is encrypted
    /// independently — Arcium's wire format is one ciphertext per
    /// primitive field, so 5 ciphertexts per bid.
    pub fn submit_pair(
        ctx: Context<SubmitPair>,
        computation_offset: u64,
        // Bidder A — 5 ciphertexts (one per SwapIntent field) + pubkey + nonce
        a_bid_idx_ct: [u8; 32],
        a_in_mint_ct: [u8; 32],
        a_out_mint_ct: [u8; 32],
        a_in_amount_ct: [u8; 32],
        a_min_out_amount_ct: [u8; 32],
        a_pubkey: [u8; 32],
        a_nonce: u128,
        // Bidder B — same layout
        b_bid_idx_ct: [u8; 32],
        b_in_mint_ct: [u8; 32],
        b_out_mint_ct: [u8; 32],
        b_in_amount_ct: [u8; 32],
        b_min_out_amount_ct: [u8; 32],
        b_pubkey: [u8; 32],
        b_nonce: u128,
    ) -> Result<()> {
        ctx.accounts.sign_pda_account.bump = ctx.bumps.sign_pda_account;

        // Arcium's ArgBuilder constructs the encrypted-input bundle the
        // MXE consumes. Each bidder's pubkey + nonce + 5 field
        // ciphertexts form one Enc<Mxe, SwapIntent>.
        let args = ArgBuilder::new()
            // Bidder A
            .x25519_pubkey(a_pubkey)
            .plaintext_u128(a_nonce)
            .encrypted_u8(a_bid_idx_ct)
            .encrypted_u8(a_in_mint_ct)
            .encrypted_u8(a_out_mint_ct)
            .encrypted_u64(a_in_amount_ct)
            .encrypted_u64(a_min_out_amount_ct)
            // Bidder B
            .x25519_pubkey(b_pubkey)
            .plaintext_u128(b_nonce)
            .encrypted_u8(b_bid_idx_ct)
            .encrypted_u8(b_in_mint_ct)
            .encrypted_u8(b_out_mint_ct)
            .encrypted_u64(b_in_amount_ct)
            .encrypted_u64(b_min_out_amount_ct)
            .build();

        queue_computation(
            ctx.accounts,
            computation_offset,
            args,
            vec![MatchPairCallback::callback_ix(
                computation_offset,
                &ctx.accounts.mxe_account,
                &[],
            )?],
            1,
            0,
        )?;
        Ok(())
    }

    /// Fires when the MPC cluster finishes the match computation.
    /// Verifies the MPC signature, parses the plaintext `MatchResult`,
    /// emits a `PairMatched` event. Off-chain settlement watchers
    /// pick up the event and drive `b402_pool::adapt_execute_v2` for
    /// each winning bidder.
    #[arcium_callback(encrypted_ix = "match_pair")]
    pub fn match_pair_callback(
        ctx: Context<MatchPairCallback>,
        output: SignedComputationOutputs<MatchPairOutput>,
    ) -> Result<()> {
        // Arcis renames Arcis-defined struct fields to positional
        // identifiers (field_0..field_N) in the Anchor-side generated
        // type. Field order matches the declaration in encrypted-ixs:
        //   field_0 = matched, field_1 = a_idx, field_2 = b_idx,
        //   field_3 = a_in,    field_4 = a_out, field_5 = b_in,
        //   field_6 = b_out,   field_7 = a_in_mint, field_8 = a_out_mint
        let result = match output
            .verify_output(&ctx.accounts.cluster_account, &ctx.accounts.computation_account)
        {
            Ok(MatchPairOutput { field_0 }) => field_0,
            Err(_) => return Err(ErrorCode::AbortedComputation.into()),
        };

        emit!(PairMatched {
            matched: result.field_0,
            a_idx: result.field_1,
            b_idx: result.field_2,
            a_in: result.field_3,
            a_out: result.field_4,
            b_in: result.field_5,
            b_out: result.field_6,
            a_in_mint: result.field_7,
            a_out_mint: result.field_8,
        });
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Account contexts. Mirrors the hello-world template, retitled for our ix.
// ---------------------------------------------------------------------------

#[queue_computation_accounts("match_pair", payer)]
#[derive(Accounts)]
#[instruction(computation_offset: u64)]
pub struct SubmitPair<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        init_if_needed,
        space = 9,
        payer = payer,
        seeds = [&SIGN_PDA_SEED],
        bump,
        address = derive_sign_pda!(),
    )]
    pub sign_pda_account: Account<'info, ArciumSignerAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Account<'info, MXEAccount>,
    /// CHECK: arcium-validated.
    #[account(mut, address = derive_mempool_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    pub mempool_account: UncheckedAccount<'info>,
    /// CHECK: arcium-validated.
    #[account(mut, address = derive_execpool_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    pub executing_pool: UncheckedAccount<'info>,
    /// CHECK: arcium-validated.
    #[account(mut, address = derive_comp_pda!(computation_offset, mxe_account, ErrorCode::ClusterNotSet))]
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_MATCH_PAIR))]
    pub comp_def_account: Account<'info, ComputationDefinitionAccount>,
    #[account(mut, address = derive_cluster_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    pub cluster_account: Account<'info, Cluster>,
    #[account(mut, address = ARCIUM_FEE_POOL_ACCOUNT_ADDRESS)]
    pub pool_account: Account<'info, FeePool>,
    #[account(mut, address = ARCIUM_CLOCK_ACCOUNT_ADDRESS)]
    pub clock_account: Account<'info, ClockAccount>,
    pub system_program: Program<'info, System>,
    pub arcium_program: Program<'info, Arcium>,
}

#[callback_accounts("match_pair")]
#[derive(Accounts)]
pub struct MatchPairCallback<'info> {
    pub arcium_program: Program<'info, Arcium>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_MATCH_PAIR))]
    pub comp_def_account: Account<'info, ComputationDefinitionAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Account<'info, MXEAccount>,
    /// CHECK: arcium-validated.
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_cluster_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    pub cluster_account: Account<'info, Cluster>,
    /// CHECK: pinned to canonical ix sysvar.
    #[account(address = ::anchor_lang::solana_program::sysvar::instructions::ID)]
    pub instructions_sysvar: AccountInfo<'info>,
}

#[init_computation_definition_accounts("match_pair", payer)]
#[derive(Accounts)]
pub struct InitMatchPairCompDef<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    /// CHECK: not yet initialized; arcium program creates it.
    #[account(mut)]
    pub comp_def_account: UncheckedAccount<'info>,
    /// CHECK: arcium-validated.
    #[account(mut, address = derive_mxe_lut_pda!(mxe_account.lut_offset_slot))]
    pub address_lookup_table: UncheckedAccount<'info>,
    /// CHECK: solana LUT program.
    #[account(address = LUT_PROGRAM_ID)]
    pub lut_program: UncheckedAccount<'info>,
    pub arcium_program: Program<'info, Arcium>,
    pub system_program: Program<'info, System>,
}

// ---------------------------------------------------------------------------
// Events + errors.
// ---------------------------------------------------------------------------

#[event]
pub struct PairMatched {
    /// 1 = cleared; 0 = no match (mints or slippage incompatible).
    pub matched: u8,
    pub a_idx: u8,
    pub b_idx: u8,
    pub a_in: u64,
    pub a_out: u64,
    pub b_in: u64,
    pub b_out: u64,
    pub a_in_mint: u8,
    pub a_out_mint: u8,
}

#[error_code]
pub enum ErrorCode {
    #[msg("the MPC computation was aborted")]
    AbortedComputation,
    #[msg("MXE cluster not set")]
    ClusterNotSet,
}

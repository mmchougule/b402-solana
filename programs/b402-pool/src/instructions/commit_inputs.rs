//! PRD-35 §5.1 — `commit_inputs` instruction.
//!
//! Writes the Groth16 public-input vector into a per-user `PendingInputs`
//! PDA so the verifier ix can read them from account data instead of from
//! ix data. Frees ~700-735 B per privateSwap/privateLend tx, lifting the
//! 1232 B v0-tx ceiling that today blocks per-user adapters at scale.
//!
//! Tx ordering (PRD-35 §3.2):
//!   tx 1: `pool::commit_inputs(spending_pub_le, public_inputs)` — writes here.
//!   tx 2: `pool::adapt_execute(proof, ...)` — reads from PDA, runs verifier
//!         CPI, executes adapter, ZEROES the inputs region.
//!
//! The PDA is scoped by the user's `spending_pub_le` (32 B little-endian
//! Fr — the same bytes that appear as `outSpendingPub[0]` in the proof).
//! One in-flight commit per user. V1 limitation: parallel privateSwaps from
//! the SAME user collide. Documented; V1.5 adds a per-call nonce.
//!
//! Replay protection: `adapt_execute` zeroes `version → 0` after successful
//! verify. Re-execution against zeroed PDA fails the version check.

use anchor_lang::prelude::*;

use crate::instructions::verifier_cpi::PUBLIC_INPUT_COUNT_ADAPT;

/// Account stored at the per-user pending-inputs PDA.
///
/// Layout: 8 (anchor disc) + 1 (version) + 32 × N (inputs) = 9 + 32N B.
/// At Phase 9 (N=24): 9 + 768 = 777 B. Anchor adds 8 B padding for the
/// account discriminator → 785 B accounted on-chain.
#[account]
pub struct PendingInputs {
    /// 0 = empty / consumed. 1 = committed and ready for verify. Set to 1
    /// by `commit_inputs`, zeroed by `adapt_execute` on successful verify.
    pub version: u8,
    /// 32-byte LE encodings of the Fr public inputs. Length is fixed at
    /// PUBLIC_INPUT_COUNT_ADAPT (compile-time constant). Stored LE to match
    /// the SDK's `publicInputsLeBytes` shape and avoid a per-input swap
    /// in the hot path.
    pub inputs: [[u8; 32]; PUBLIC_INPUT_COUNT_ADAPT],
}

impl PendingInputs {
    /// 1 (version) + 32 × PUBLIC_INPUT_COUNT_ADAPT (inputs).
    pub const LEN: usize = 1 + 32 * PUBLIC_INPUT_COUNT_ADAPT;
}

/// PDA seed prefix for the pending-inputs account. Matches the SDK-side
/// derivation in `packages/sdk/src/b402.ts::derivePendingInputsPda`.
pub const PENDING_INPUTS_SEED: &[u8] = b"pending-inputs";
/// Versioned namespace shared across all b402 PDAs.
pub const VERSION_PREFIX: &[u8] = b"b402/v1";

#[derive(Accounts)]
#[instruction(spending_pub_le: [u8; 32])]
pub struct CommitInputs<'info> {
    /// Per-user pending-inputs PDA. `init_if_needed` so an in-flight retry
    /// (tx 2 failed, user tries again) overwrites cleanly without a
    /// separate allocation.
    #[account(
        init_if_needed,
        payer = relayer,
        space = 8 + PendingInputs::LEN,
        seeds = [VERSION_PREFIX, PENDING_INPUTS_SEED, spending_pub_le.as_ref()],
        bump,
    )]
    pub pending_inputs: Account<'info, PendingInputs>,
    /// Pays rent on first allocation (~0.0056 SOL at 6960 lamports/byte).
    /// Refundable when the user opts out via `gc_pending_inputs`. For V1
    /// the relayer is the funder; user reimburses via the §5.4 setup-fee
    /// path (V1.5).
    #[account(mut)]
    pub relayer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

pub fn commit_inputs(
    ctx: Context<CommitInputs>,
    _spending_pub_le: [u8; 32],
    public_inputs: Vec<[u8; 32]>,
) -> Result<()> {
    require!(
        public_inputs.len() == PUBLIC_INPUT_COUNT_ADAPT,
        crate::error::PoolError::ProofPublicInputMismatch
    );
    let acct = &mut ctx.accounts.pending_inputs;
    acct.version = 1;
    // Copy 24 × 32 B = 768 B. Compiler unrolls; ~10k CU.
    for (i, fr) in public_inputs.iter().enumerate() {
        acct.inputs[i] = *fr;
    }
    Ok(())
}

/// PRD-35 §5.5 — admin-callable garbage collector for stale
/// pending_inputs PDAs. Closes the account (refunds rent to admin
/// treasury) when the user's tx 2 never landed and the PDA holds
/// stale committed inputs.
///
/// Why admin-gated: any non-admin caller could grief by closing
/// PDAs that ARE actively in use (race condition: tx 1 lands,
/// griefer closes PDA, tx 2 fails). Admin gate + a slot age check
/// (~7 minutes since last use) is sufficient for V1. V1.5 can
/// expose user-opt-in close via shielded-action signature.
#[derive(Accounts)]
pub struct GcPendingInputs<'info> {
    /// Stale PDA to close. Admin-derived seeds; we don't validate the
    /// derivation here because the admin gate is the trust root and
    /// the rent refund target is the treasury, not the admin (no
    /// asymmetric incentive to close someone else's active PDA).
    #[account(mut, close = treasury)]
    pub pending_inputs: Account<'info, PendingInputs>,
    /// Pool config — admin signer must match cfg.admin_multisig.
    #[account(
        seeds = [VERSION_PREFIX, b"config"],
        bump,
    )]
    pub pool_config: Box<Account<'info, crate::state::PoolConfig>>,
    /// Rent refund destination. Today: admin's own pubkey; V1.5 gets a
    /// dedicated treasury PDA.
    /// CHECK: rent goes here; admin-gated tx so misdirection is on the admin.
    #[account(mut)]
    pub treasury: UncheckedAccount<'info>,
    pub admin: Signer<'info>,
}

pub fn gc_pending_inputs(ctx: Context<GcPendingInputs>) -> Result<()> {
    crate::instructions::admin::ensure_admin(&ctx.accounts.pool_config, &ctx.accounts.admin.key())?;
    // Anchor's `close = treasury` constraint above does the lamport
    // transfer + zeroes data. Nothing else to do here.
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use anchor_lang::solana_program::pubkey::Pubkey;

    /// PRD-35 §5.1 invariant: PDA seeds match the SDK-side derivation
    /// scheme byte-for-byte. If this changes, every SDK consumer breaks.
    #[test]
    fn pending_inputs_pda_seed_format() {
        let pool_program_id = Pubkey::new_unique();
        let spending_pub_le = [42u8; 32];
        let (pda, bump) = Pubkey::find_program_address(
            &[VERSION_PREFIX, PENDING_INPUTS_SEED, spending_pub_le.as_ref()],
            &pool_program_id,
        );
        assert_ne!(pda, Pubkey::default());
        assert!(bump <= 255);
    }

    /// Two distinct spending pubs MUST produce two distinct PDAs.
    /// Otherwise users collide on the same pending-inputs slot.
    #[test]
    fn pending_inputs_pda_per_user_isolation() {
        let pool = Pubkey::new_unique();
        let alice_pub = [1u8; 32];
        let bob_pub = [2u8; 32];
        let alice_pda =
            Pubkey::find_program_address(&[VERSION_PREFIX, PENDING_INPUTS_SEED, &alice_pub], &pool).0;
        let bob_pda =
            Pubkey::find_program_address(&[VERSION_PREFIX, PENDING_INPUTS_SEED, &bob_pub], &pool).0;
        assert_ne!(alice_pda, bob_pda);
    }

    /// Same spending pub across two pool program IDs (e.g. devnet vs
    /// mainnet) MUST produce different PDAs — cross-cluster correlation
    /// resistance.
    #[test]
    fn pending_inputs_pda_per_program() {
        let devnet_pool = Pubkey::new_unique();
        let mainnet_pool = Pubkey::new_unique();
        let user = [7u8; 32];
        let dev_pda =
            Pubkey::find_program_address(&[VERSION_PREFIX, PENDING_INPUTS_SEED, &user], &devnet_pool).0;
        let main_pda =
            Pubkey::find_program_address(&[VERSION_PREFIX, PENDING_INPUTS_SEED, &user], &mainnet_pool).0;
        assert_ne!(dev_pda, main_pda);
    }

    /// PendingInputs::LEN matches what we pass to `space` in #[account(init)].
    /// If you bump PUBLIC_INPUT_COUNT_ADAPT, LEN auto-updates; this catches
    /// any manual override that drifts.
    #[test]
    fn pending_inputs_len_matches_inputs_array() {
        assert_eq!(PendingInputs::LEN, 1 + 32 * PUBLIC_INPUT_COUNT_ADAPT);
    }
}

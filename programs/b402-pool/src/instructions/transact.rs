//! v2 transact — internal-only spend (no public amount movement).
//!
//! v2 vs v1: the pool no longer writes nullifiers into PDA shards itself.
//! Instead, the calling tx is required to contain a sibling
//! `b402_nullifier::create_nullifier` ix per non-dummy nullifier, which
//! lands the nullifier in Light Protocol's address tree V2. The pool
//! verifies presence + matching `id` via the instructions sysvar.
//!
//! This drops per-unshield gas from ~$13 (PDA shard rent on first hit) to
//! ~$0.003 (tx fee + Light rollover). See `docs/spikes/SPIKE-v2-nullifier-imt.md`
//! and `docs/prds/PRD-30-v2-nullifier-imt.md`.
//!
//! Out of scope: encryption-tag publication, public-amount transit, fee
//! binding logic — all unchanged from v1 transact.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::sysvar::instructions::{
    self, load_current_index_checked,
};
use anchor_spl::token::Token;

use crate::constants::{
    SEED_CONFIG, SEED_TREE, TAG_COMMIT, TAG_FEE_BIND, TAG_MK_NODE, TAG_NULLIFIER,
    TAG_RECIPIENT_BIND, TAG_SPEND_KEY_PUB, VERSION_PREFIX,
};
use crate::error::PoolError;
use crate::events::{CommitmentAppended, NullifierSpent};
use crate::state::{PoolConfig, TreeState};
use crate::util;

use super::shield::{EncryptedNote, TransactPublicInputs};
use super::verifier_cpi;

/// Hardcoded program ID of our forked nullifier program.
/// Matches `programs/b402-nullifier/src/lib.rs::declare_id!`.
// Base58 "2AnRZwWu6CTurZs1yQpqrcJWo4yRYL1xpeV78b2siweq" decoded.
pub const B402_NULLIFIER_PROGRAM_ID: Pubkey = Pubkey::new_from_array([
    0x11, 0x5d, 0x46, 0x5a, 0x8f, 0x1e, 0x5f, 0xc4,
    0x09, 0x4e, 0xef, 0x6b, 0xf0, 0x57, 0x45, 0x1d,
    0xbe, 0x79, 0xa8, 0xa2, 0xf9, 0xc9, 0x39, 0xa2,
    0xdd, 0xc3, 0xa7, 0x4e, 0x5d, 0xcc, 0x79, 0x52,
]);

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct TransactArgs {
    pub proof: Vec<u8>, // must be 256 bytes
    pub public_inputs: TransactPublicInputs,
    pub encrypted_notes: Vec<EncryptedNote>, // must be ≤ 2 entries
    pub in_dummy_mask: u8,
    pub out_dummy_mask: u8,
}

#[derive(Accounts)]
#[instruction(args: TransactArgs)]
pub struct Transact<'info> {
    #[account(mut)]
    pub relayer: Signer<'info>,

    #[account(
        seeds = [VERSION_PREFIX, SEED_CONFIG],
        bump,
    )]
    pub pool_config: Account<'info, PoolConfig>,

    #[account(
        mut,
        seeds = [VERSION_PREFIX, SEED_TREE],
        bump,
    )]
    pub tree_state: AccountLoader<'info, TreeState>,

    /// CHECK: address verified against `pool_config.verifier_transact`.
    pub verifier_program: AccountInfo<'info>,

    /// Sysvar inspected by `verify_nullifier_ix_in_tx` to confirm a
    /// matching `b402_nullifier::create_nullifier` ix is in the same tx
    /// for each non-dummy nullifier.
    /// CHECK: address constraint enforces the canonical sysvar pubkey.
    #[account(address = instructions::ID)]
    pub instructions_sysvar: AccountInfo<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[inline(never)]
pub fn handler(ctx: Context<Transact>, args: TransactArgs) -> Result<()> {
    require!(args.proof.len() == 256, PoolError::InvalidInstructionData);
    require!(
        args.encrypted_notes.len() <= 2,
        PoolError::InvalidInstructionData
    );

    let cfg = &ctx.accounts.pool_config;
    require!(!cfg.paused_transacts, PoolError::PoolPaused);
    require!(
        ctx.accounts.verifier_program.key() == cfg.verifier_transact,
        PoolError::ProofVerificationFailed
    );

    let pi = &args.public_inputs;

    // Internal-only: both public amounts must be 0.
    require!(pi.public_amount_in == 0, PoolError::PublicAmountExclusivity);
    require!(
        pi.public_amount_out == 0,
        PoolError::PublicAmountExclusivity
    );
    require!(pi.relayer_fee == 0, PoolError::InvalidFeeBinding);

    // Root must be in recent ring.
    {
        let tree = ctx.accounts.tree_state.load()?;
        require!(
            util::tree_has_recent_root(&tree, &pi.merkle_root),
            PoolError::InvalidMerkleRoot
        );
    }

    // Dummy nullifier values must be zero.
    for i in 0..2 {
        let is_dummy = (args.in_dummy_mask >> i) & 1 == 1;
        if is_dummy {
            require!(
                pi.nullifier[i] == [0u8; 32],
                PoolError::ProofPublicInputMismatch
            );
        }
    }

    // Verify proof. Build public inputs on the heap to conserve BPF stack.
    let public_inputs: Vec<[u8; 32]> = build_public_inputs(pi);

    let mut proof_bytes = [0u8; 256];
    proof_bytes.copy_from_slice(&args.proof);
    verifier_cpi::invoke_verify_transact(
        &ctx.accounts.verifier_program,
        &proof_bytes,
        &public_inputs,
    )?;

    // Sibling-ix check: for each non-dummy nullifier, find the matching
    // b402_nullifier::create_nullifier ix in this tx. Light's verifier
    // (called by that sibling ix) will reject double-spends — this check
    // only enforces presence. Walk forward from the current ix.
    let ix_sysvar = &ctx.accounts.instructions_sysvar;
    let current_ix_index = load_current_index_checked(ix_sysvar)? as usize;
    let mut search_from = current_ix_index + 1;
    let clock = Clock::get()?;
    for i in 0..2 {
        let is_dummy = (args.in_dummy_mask >> i) & 1 == 1;
        if is_dummy {
            continue;
        }
        let found_at = util::verify_nullifier_ix_in_tx(
            ix_sysvar,
            &B402_NULLIFIER_PROGRAM_ID,
            &pi.nullifier[i],
            search_from,
        )?;
        search_from = found_at + 1; // next nullifier search past this match
        emit!(NullifierSpent {
            nullifier: pi.nullifier[i],
            shard: 0, // legacy field; meaningful only for v1, kept for event ABI compat
            slot: clock.slot
        });
    }

    // Ordering: if both real, nullifier[0] < nullifier[1].
    if (args.in_dummy_mask & 0b11) == 0 {
        require!(
            pi.nullifier[0] < pi.nullifier[1],
            PoolError::NullifierOrderingViolation
        );
    }

    // Append commitments. (Unchanged from v1.)
    {
        let mut tree = ctx.accounts.tree_state.load_mut()?;
        for (i, commitment) in pi.commitment_out.iter().enumerate() {
            let is_dummy = (args.out_dummy_mask >> i) & 1 == 1;
            if is_dummy {
                require!(
                    *commitment == [0u8; 32],
                    PoolError::ProofPublicInputMismatch
                );
                continue;
            }
            let leaf_index = tree.leaf_count;
            let new_root = util::tree_append(&mut tree, *commitment)?;
            let (ct, ep, vt) = match args.encrypted_notes.get(i) {
                Some(n) => (n.ciphertext, n.ephemeral_pub, n.viewing_tag),
                None => ([0u8; 89], [0u8; 32], [0u8; 2]),
            };
            emit!(CommitmentAppended {
                leaf_index,
                commitment: *commitment,
                ciphertext: ct,
                ephemeral_pub: ep,
                viewing_tag: vt,
                tree_root_after: new_root,
                slot: clock.slot,
            });
        }
    }

    Ok(())
}

fn u64_to_fr_le(v: u64) -> [u8; 32] {
    let mut out = [0u8; 32];
    out[..8].copy_from_slice(&v.to_le_bytes());
    out
}

/// Build the 18-element public-input vector on the heap. Never inlined so the
/// stack array is not materialized inside the caller's frame.
#[inline(never)]
fn build_public_inputs(pi: &TransactPublicInputs) -> Vec<[u8; 32]> {
    let mut v: Vec<[u8; 32]> = Vec::with_capacity(verifier_cpi::PUBLIC_INPUT_COUNT);
    v.push(pi.merkle_root);
    v.push(pi.nullifier[0]);
    v.push(pi.nullifier[1]);
    v.push(pi.commitment_out[0]);
    v.push(pi.commitment_out[1]);
    v.push(u64_to_fr_le(pi.public_amount_in));
    v.push(u64_to_fr_le(pi.public_amount_out));
    v.push(crate::util::reduce_le_mod_p(
        &pi.public_token_mint.to_bytes(),
    ));
    v.push(u64_to_fr_le(pi.relayer_fee));
    v.push(pi.relayer_fee_bind);
    v.push(pi.root_bind);
    v.push(pi.recipient_bind);
    v.push(TAG_COMMIT);
    v.push(TAG_NULLIFIER);
    v.push(TAG_MK_NODE);
    v.push(TAG_SPEND_KEY_PUB);
    v.push(TAG_FEE_BIND);
    v.push(TAG_RECIPIENT_BIND);
    v
}

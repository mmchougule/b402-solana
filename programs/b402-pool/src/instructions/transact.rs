use anchor_lang::prelude::*;
use anchor_spl::token::{Token, TokenAccount};

use crate::constants::{
    SEED_CONFIG, SEED_NULL, SEED_TREE, VERSION_PREFIX,
    TAG_COMMIT, TAG_NULLIFIER, TAG_MK_NODE, TAG_SPEND_KEY_PUB, TAG_FEE_BIND, TAG_RECIPIENT_BIND,
};
use crate::error::PoolError;
use crate::events::{CommitmentAppended, NullifierSpent};
use crate::state::{NullifierShard, PoolConfig, TreeState};
use crate::util;

use super::shield::{EncryptedNote, TransactPublicInputs};
use super::verifier_cpi;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct TransactArgs {
    pub proof: Vec<u8>,                  // must be 256 bytes
    pub public_inputs: TransactPublicInputs,
    pub encrypted_notes: Vec<EncryptedNote>, // must be 2 entries
    pub in_dummy_mask: u8,
    pub out_dummy_mask: u8,
    pub nullifier_shard_prefix: [u16; 2],
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

    #[account(
        init_if_needed,
        payer = relayer,
        space = NullifierShard::LEN,
        seeds = [VERSION_PREFIX, SEED_NULL, &args.nullifier_shard_prefix[0].to_le_bytes()],
        bump,
    )]
    pub nullifier_shard_0: AccountLoader<'info, NullifierShard>,

    #[account(
        init_if_needed,
        payer = relayer,
        space = NullifierShard::LEN,
        seeds = [VERSION_PREFIX, SEED_NULL, &args.nullifier_shard_prefix[1].to_le_bytes()],
        bump,
    )]
    pub nullifier_shard_1: AccountLoader<'info, NullifierShard>,

    /// Vault is not moved by `transact` (internal only) but included so callers
    /// can later extend to public-amount variants without account-list churn.
    /// In pure transact, this field is unused; ensure pool_config.paused_transacts is false.
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[inline(never)]
pub fn handler(ctx: Context<Transact>, args: TransactArgs) -> Result<()> {
    require!(args.proof.len() == 256, PoolError::InvalidInstructionData);
    require!(args.encrypted_notes.len() <= 2, PoolError::InvalidInstructionData);

    let cfg = &ctx.accounts.pool_config;
    require!(!cfg.paused_transacts, PoolError::PoolPaused);
    require!(
        ctx.accounts.verifier_program.key() == cfg.verifier_transact,
        PoolError::ProofVerificationFailed
    );

    let pi = &args.public_inputs;

    // Internal-only: both public amounts must be 0.
    require!(pi.public_amount_in == 0, PoolError::PublicAmountExclusivity);
    require!(pi.public_amount_out == 0, PoolError::PublicAmountExclusivity);
    require!(pi.relayer_fee == 0, PoolError::InvalidFeeBinding);

    // Root must be in recent ring.
    {
        let tree = ctx.accounts.tree_state.load()?;
        require!(
            util::tree_has_recent_root(&tree, &pi.merkle_root),
            PoolError::InvalidMerkleRoot
        );
    }

    // Verify shard prefix matches nullifier values (unless dummy).
    for i in 0..2 {
        let is_dummy = (args.in_dummy_mask >> i) & 1 == 1;
        if is_dummy {
            require!(pi.nullifier[i] == [0u8; 32], PoolError::ProofPublicInputMismatch);
            continue;
        }
        let actual_prefix = util::shard_prefix(&pi.nullifier[i]);
        require!(
            actual_prefix == args.nullifier_shard_prefix[i],
            PoolError::NullifierShardMismatch
        );
    }

    // Verify proof. Build public inputs on the heap to conserve BPF stack.
    let public_inputs: Vec<[u8; 32]> = build_public_inputs(&pi);

    let mut proof_bytes = [0u8; 256];
    proof_bytes.copy_from_slice(&args.proof);
    verifier_cpi::invoke_verify_transact(
        &ctx.accounts.verifier_program,
        &proof_bytes,
        &public_inputs,
    )?;

    // Insert nullifiers via AccountLoader.
    let clock = Clock::get()?;
    if (args.in_dummy_mask >> 0) & 1 == 0 {
        let mut shard = load_or_init_shard(&ctx.accounts.nullifier_shard_0, args.nullifier_shard_prefix[0])?;
        require!(shard.prefix == args.nullifier_shard_prefix[0], PoolError::NullifierShardMismatch);
        util::nullifier_insert(&mut shard, pi.nullifier[0])?;
        emit!(NullifierSpent { nullifier: pi.nullifier[0], shard: shard.prefix, slot: clock.slot });
    }
    if (args.in_dummy_mask >> 1) & 1 == 0 {
        let mut shard = load_or_init_shard(&ctx.accounts.nullifier_shard_1, args.nullifier_shard_prefix[1])?;
        require!(shard.prefix == args.nullifier_shard_prefix[1], PoolError::NullifierShardMismatch);
        util::nullifier_insert(&mut shard, pi.nullifier[1])?;
        emit!(NullifierSpent { nullifier: pi.nullifier[1], shard: shard.prefix, slot: clock.slot });
    }

    // Ordering: if both real, nullifier[0] < nullifier[1].
    if (args.in_dummy_mask & 0b11) == 0 {
        require!(
            pi.nullifier[0] < pi.nullifier[1],
            PoolError::NullifierOrderingViolation
        );
    }

    // Append commitments.
    {
        let mut tree = ctx.accounts.tree_state.load_mut()?;
        for (i, commitment) in pi.commitment_out.iter().enumerate() {
            let is_dummy = (args.out_dummy_mask >> i) & 1 == 1;
            if is_dummy {
                require!(*commitment == [0u8; 32], PoolError::ProofPublicInputMismatch);
                continue;
            }
            let leaf_index = tree.leaf_count;
            let new_root = util::tree_append(&mut tree, *commitment)?;
            let (ct, ep, vt) = match args.encrypted_notes.get(i) {
                Some(n) => (n.ciphertext, n.ephemeral_pub, n.viewing_tag),
                None => ([0u8; 89], [0u8; 32], [0u8; 2]),
            };
            emit!(CommitmentAppended {
                leaf_index, commitment: *commitment,
                ciphertext: ct, ephemeral_pub: ep, viewing_tag: vt,
                tree_root_after: new_root, slot: clock.slot,
            });
        }
    }

    Ok(())
}

/// Load a nullifier shard, setting its prefix if this is first-time init.
/// Anchor's `AccountLoader::load_mut` requires `load_init` for fresh accounts
/// but `init_if_needed` wraps that automatically — we still need to detect
/// the fresh case and write the prefix.
fn load_or_init_shard<'a, 'info>(
    loader: &'a AccountLoader<'info, NullifierShard>,
    expected_prefix: u16,
) -> Result<std::cell::RefMut<'a, NullifierShard>> {
    // Try load_mut first — works for already-initialized accounts.
    if let Ok(mut shard) = loader.load_mut() {
        if shard.count == 0 && shard.prefix == 0 {
            shard.prefix = expected_prefix;
        }
        return Ok(shard);
    }
    // Otherwise treat as fresh init.
    let mut shard = loader.load_init()?;
    shard.prefix = expected_prefix;
    Ok(shard)
}

fn u64_to_fr_le(v: u64) -> [u8; 32] {
    let mut out = [0u8; 32];
    out[..8].copy_from_slice(&v.to_le_bytes());
    out
}

/// Build the 16-element public-input vector on the heap. Never inlined so the
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
    v.push(crate::util::reduce_le_mod_p(&pi.public_token_mint.to_bytes()));
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

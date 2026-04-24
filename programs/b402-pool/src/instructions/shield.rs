use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use crate::constants::{
    SEED_CONFIG, SEED_TOKEN, SEED_TREE, SEED_VAULT, VERSION_PREFIX,
    TAG_COMMIT, TAG_NULLIFIER, TAG_MK_NODE, TAG_SPEND_KEY_PUB, TAG_FEE_BIND, TAG_RECIPIENT_BIND,
};
use crate::error::PoolError;
use crate::events::{CommitmentAppended, ShieldExecuted};
use crate::state::{PoolConfig, TokenConfig, TreeState};
use crate::util;

use super::verifier_cpi;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct TransactPublicInputs {
    pub merkle_root: [u8; 32],
    pub nullifier: [[u8; 32]; 2],
    pub commitment_out: [[u8; 32]; 2],
    pub public_amount_in: u64,
    pub public_amount_out: u64,
    pub public_token_mint: Pubkey,
    pub relayer_fee: u64,
    pub relayer_fee_bind: [u8; 32],
    pub root_bind: [u8; 32],
    /// Binds the unshield recipient's owner pubkey. For shield, can be any
    /// Poseidon_3(recipientBindTag, low, high) value; handler doesn't check.
    pub recipient_bind: [u8; 32],
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct EncryptedNote {
    pub ciphertext: [u8; 89],
    pub ephemeral_pub: [u8; 32],
    pub viewing_tag: [u8; 2],
}

/// Args passed to `shield`.
///
/// `proof_bytes` and `encrypted_notes_bytes` are `Vec<u8>` (heap-allocated by
/// Borsh) rather than fixed arrays to keep BPF stack usage under the 4 KiB
/// frame limit. The handler asserts their lengths on entry.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct ShieldArgs {
    pub proof: Vec<u8>,                  // must be 256 bytes
    pub public_inputs: TransactPublicInputs,
    pub encrypted_notes: Vec<EncryptedNote>, // must be 2 entries
    pub note_dummy_mask: u8,
}

#[derive(Accounts)]
pub struct Shield<'info> {
    #[account(mut)]
    pub relayer: Signer<'info>,

    #[account(mut)]
    pub depositor: Signer<'info>,

    #[account(
        mut,
        constraint = depositor_token_account.owner == depositor.key(),
        constraint = depositor_token_account.mint == token_config.mint,
    )]
    pub depositor_token_account: Account<'info, TokenAccount>,

    #[account(
        seeds = [VERSION_PREFIX, SEED_TOKEN, token_config.mint.as_ref()],
        bump,
        constraint = token_config.enabled @ PoolError::TokenNotWhitelisted,
    )]
    pub token_config: Account<'info, TokenConfig>,

    #[account(
        mut,
        seeds = [VERSION_PREFIX, SEED_VAULT, token_config.mint.as_ref()],
        bump,
        constraint = vault.key() == token_config.vault @ PoolError::VaultMismatch,
    )]
    pub vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        seeds = [VERSION_PREFIX, SEED_TREE],
        bump,
    )]
    pub tree_state: AccountLoader<'info, TreeState>,

    #[account(
        seeds = [VERSION_PREFIX, SEED_CONFIG],
        bump,
    )]
    pub pool_config: Account<'info, PoolConfig>,

    /// CHECK: validated by address comparison against `pool_config.verifier_transact`.
    pub verifier_program: AccountInfo<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[inline(never)]
pub fn handler(ctx: Context<Shield>, args: ShieldArgs) -> Result<()> {
    require!(args.proof.len() == 256, PoolError::InvalidInstructionData);
    // Accept 0..=2 encrypted_notes. Missing entries emit zero ciphertext on
    // chain; receiver-discovery for those notes happens via off-chain channel.
    require!(args.encrypted_notes.len() <= 2, PoolError::InvalidInstructionData);

    let cfg = &ctx.accounts.pool_config;
    require!(!cfg.paused_shields, PoolError::PoolPaused);
    require!(
        ctx.accounts.verifier_program.key() == cfg.verifier_transact,
        PoolError::ProofVerificationFailed
    );

    // Shield constraints: public_amount_in > 0, public_amount_out == 0, fee == 0.
    let pi = &args.public_inputs;
    require!(pi.public_amount_in > 0, PoolError::PublicAmountExclusivity);
    require!(pi.public_amount_out == 0, PoolError::PublicAmountExclusivity);
    require!(pi.relayer_fee == 0, PoolError::InvalidFeeBinding);

    // Mint must match token_config.
    require!(
        pi.public_token_mint == ctx.accounts.token_config.mint,
        PoolError::MintMismatch
    );

    // Nullifiers must both be zero for shield (no input notes).
    require!(
        pi.nullifier[0] == [0u8; 32] && pi.nullifier[1] == [0u8; 32],
        PoolError::ProofPublicInputMismatch
    );

    // Root must be in recent ring.
    {
        let tree = ctx.accounts.tree_state.load()?;
        require!(
            util::tree_has_recent_root(&tree, &pi.merkle_root),
            PoolError::InvalidMerkleRoot
        );
    }

    // Public inputs on the heap to conserve BPF stack.
    let public_inputs: Vec<[u8; 32]> = build_public_inputs_for_shield(&pi);

    // Verify proof.
    let mut proof_bytes = [0u8; 256];
    proof_bytes.copy_from_slice(&args.proof);
    verifier_cpi::invoke_verify_transact(
        &ctx.accounts.verifier_program,
        &proof_bytes,
        &public_inputs,
    )?;

    // Transfer tokens from depositor to vault.
    let cpi_accounts = Transfer {
        from: ctx.accounts.depositor_token_account.to_account_info(),
        to: ctx.accounts.vault.to_account_info(),
        authority: ctx.accounts.depositor.to_account_info(),
    };
    token::transfer(
        CpiContext::new(ctx.accounts.token_program.to_account_info(), cpi_accounts),
        pi.public_amount_in,
    )?;

    // Append non-dummy commitments to the tree and emit events.
    let clock = Clock::get()?;
    {
        let mut tree = ctx.accounts.tree_state.load_mut()?;
        for (i, commitment) in pi.commitment_out.iter().enumerate() {
            let is_dummy = (args.note_dummy_mask >> i) & 1 == 1;
            if is_dummy {
                require!(*commitment == [0u8; 32], PoolError::ProofPublicInputMismatch);
                continue;
            }
            require!(*commitment != [0u8; 32], PoolError::InvalidCommitment);

            let leaf_index = tree.leaf_count;
            let new_root = util::tree_append(&mut tree, *commitment)?;

            // Missing encrypted_notes[i] => zero ciphertext (off-chain delivery).
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

    emit!(ShieldExecuted {
        mint: ctx.accounts.token_config.mint,
        amount: pi.public_amount_in,
        slot: clock.slot,
    });

    Ok(())
}

fn u64_to_fr_le(v: u64) -> [u8; 32] {
    let mut out = [0u8; 32];
    out[..8].copy_from_slice(&v.to_le_bytes());
    out
}

#[inline(never)]
fn build_public_inputs_for_shield(pi: &TransactPublicInputs) -> Vec<[u8; 32]> {
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

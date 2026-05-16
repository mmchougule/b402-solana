use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    self as token_interface_cpi, Mint, TokenAccount, TokenInterface, TransferChecked,
};

use crate::constants::{
    SEED_CONFIG, SEED_TOKEN, SEED_TREE, SEED_VAULT, TAG_COMMIT, TAG_FEE_BIND, TAG_MK_NODE,
    TAG_NULLIFIER, TAG_RECIPIENT_BIND, TAG_SPEND_KEY_PUB, VERSION_PREFIX,
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
    pub proof: Vec<u8>, // must be 256 bytes
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
    pub depositor_token_account: InterfaceAccount<'info, TokenAccount>,

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
    pub vault: InterfaceAccount<'info, TokenAccount>,

    /// Mint account — required by `transfer_checked`. Constrained to match
    /// `token_config.mint` so the SDK can't redirect the decimals/mint check
    /// to a different mint than what the token config says. Token-2022 needs
    /// this slot because its transfer-checked path validates decimals against
    /// the on-chain mint header; classic SPL token program ignores it but
    /// Anchor's `InterfaceAccount<Mint>` deserialization stays uniform across
    /// both programs.
    #[account(
        address = token_config.mint @ PoolError::MintMismatch,
    )]
    pub mint: InterfaceAccount<'info, Mint>,

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

    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[inline(never)]
pub fn handler<'info>(
    ctx: Context<'_, '_, '_, 'info, Shield<'info>>,
    args: ShieldArgs,
) -> Result<()> {
    require!(args.proof.len() == 256, PoolError::InvalidInstructionData);
    // Accept 0..=2 encrypted_notes. Missing entries emit zero ciphertext on
    // chain; receiver-discovery for those notes happens via off-chain channel.
    require!(
        args.encrypted_notes.len() <= 2,
        PoolError::InvalidInstructionData
    );

    let cfg = &ctx.accounts.pool_config;
    require!(!cfg.paused_shields, PoolError::PoolPaused);
    require!(
        ctx.accounts.verifier_program.key() == cfg.verifier_transact,
        PoolError::ProofVerificationFailed
    );

    // Shield constraints: public_amount_in > 0, public_amount_out == 0, fee == 0.
    let pi = &args.public_inputs;
    require!(pi.public_amount_in > 0, PoolError::PublicAmountExclusivity);
    require!(
        pi.public_amount_out == 0,
        PoolError::PublicAmountExclusivity
    );
    require!(pi.relayer_fee == 0, PoolError::InvalidFeeBinding);

    // Mint must match token_config.
    require!(
        pi.public_token_mint == ctx.accounts.token_config.mint,
        PoolError::MintMismatch
    );

    // TVL cap. Vault balance + this shield amount must not exceed the cap.
    // max_tvl == 0 means "no shielding allowed" (fail-closed default).
    let new_tvl = ctx
        .accounts
        .vault
        .amount
        .checked_add(pi.public_amount_in)
        .ok_or(PoolError::MaxTvlExceeded)?;
    require!(
        new_tvl <= ctx.accounts.token_config.max_tvl,
        PoolError::MaxTvlExceeded
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
    let public_inputs: Vec<[u8; 32]> = build_public_inputs_for_shield(pi);

    // Verify proof.
    let mut proof_bytes = [0u8; 256];
    proof_bytes.copy_from_slice(&args.proof);
    verifier_cpi::invoke_verify_transact(
        &ctx.accounts.verifier_program,
        &proof_bytes,
        &public_inputs,
    )?;

    // Transfer tokens from depositor to vault.
    //
    // `spl_token_2022::onchain::invoke_transfer_checked` handles:
    //   1. Classic SPL Token mints — equivalent to `transfer_checked`.
    //   2. Token-2022 mints — same, plus auto-resolves transferHook extension
    //      by reading the mint's `transfer_hook` extension to find the hook
    //      program, deriving the `ExtraAccountMetaList` PDA, and pulling the
    //      hook's required extra accounts from `additional_accounts` (here:
    //      ctx.remaining_accounts).
    //   3. `transfer_checked` validates decimals to block mint-confusion attacks.
    //
    // For mints with transferHook, the SDK appends the hook program + its
    // declared extra metas to `remaining_accounts` so this call finds them.
    // For mints without a hook, remaining_accounts is empty and the helper
    // degrades to plain transfer_checked.
    let decimals = ctx.accounts.mint.decimals;
    spl_token_2022::onchain::invoke_transfer_checked(
        ctx.accounts.token_program.key,
        ctx.accounts.depositor_token_account.to_account_info(),
        ctx.accounts.mint.to_account_info(),
        ctx.accounts.vault.to_account_info(),
        ctx.accounts.depositor.to_account_info(),
        ctx.remaining_accounts,
        pi.public_amount_in,
        decimals,
        &[], // depositor signs directly; no PDA seeds needed.
    )?;

    // Append non-dummy commitments to the tree and emit events.
    let clock = Clock::get()?;
    {
        let mut tree = ctx.accounts.tree_state.load_mut()?;
        for (i, commitment) in pi.commitment_out.iter().enumerate() {
            let is_dummy = (args.note_dummy_mask >> i) & 1 == 1;
            if is_dummy {
                require!(
                    *commitment == [0u8; 32],
                    PoolError::ProofPublicInputMismatch
                );
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

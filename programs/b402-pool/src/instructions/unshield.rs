use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use anchor_lang::solana_program::poseidon::{hashv, Endianness, Parameters};

use crate::constants::{
    SEED_CONFIG, SEED_NULL, SEED_TOKEN, SEED_TREE, SEED_VAULT, TAG_COMMIT, TAG_FEE_BIND,
    TAG_MK_NODE, TAG_NULLIFIER, TAG_RECIPIENT_BIND, TAG_SPEND_KEY_PUB, VERSION_PREFIX,
};
use crate::error::PoolError;
use crate::events::{CommitmentAppended, NullifierSpent, UnshieldExecuted};
use crate::state::{NullifierShard, PoolConfig, TokenConfig, TreeState};
use crate::util;

use super::shield::{EncryptedNote, TransactPublicInputs};
use super::verifier_cpi;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct UnshieldArgs {
    pub proof: Vec<u8>, // must be 256 bytes
    pub public_inputs: TransactPublicInputs,
    pub encrypted_notes: Vec<EncryptedNote>, // must be 2 entries
    pub in_dummy_mask: u8,
    pub out_dummy_mask: u8,
    pub nullifier_shard_prefix: [u16; 2],
    pub relayer_fee_recipient: Pubkey,
}

#[derive(Accounts)]
#[instruction(args: UnshieldArgs)]
pub struct Unshield<'info> {
    #[account(mut)]
    pub relayer: Signer<'info>,

    #[account(
        seeds = [VERSION_PREFIX, SEED_CONFIG],
        bump,
    )]
    pub pool_config: Account<'info, PoolConfig>,

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
        constraint = recipient_token_account.mint == token_config.mint @ PoolError::MintMismatch,
    )]
    pub recipient_token_account: Account<'info, TokenAccount>,

    /// Relayer fee destination. Zero-amount fee transactions may pass the
    /// vault address here as a sentinel to avoid an extra ATA; handler rejects
    /// fee > 0 in that case.
    #[account(mut)]
    pub relayer_fee_token_account: Account<'info, TokenAccount>,

    #[account(
        mut,
        seeds = [VERSION_PREFIX, SEED_TREE],
        bump,
    )]
    pub tree_state: AccountLoader<'info, TreeState>,

    /// CHECK: verified against pool_config.verifier_transact.
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

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[inline(never)]
pub fn handler(ctx: Context<Unshield>, args: UnshieldArgs) -> Result<()> {
    require!(args.proof.len() == 256, PoolError::InvalidInstructionData);
    require!(
        args.encrypted_notes.len() <= 2,
        PoolError::InvalidInstructionData
    );

    // NOTE: unshield is NEVER paused — PRD-03 §4.5.

    let cfg = &ctx.accounts.pool_config;
    require!(
        ctx.accounts.verifier_program.key() == cfg.verifier_transact,
        PoolError::ProofVerificationFailed
    );

    let pi = &args.public_inputs;

    require!(pi.public_amount_in == 0, PoolError::PublicAmountExclusivity);
    require!(pi.public_amount_out > 0, PoolError::PublicAmountExclusivity);
    require!(
        pi.relayer_fee <= pi.public_amount_out,
        PoolError::InvalidFeeBinding
    );
    require!(
        pi.public_token_mint == ctx.accounts.token_config.mint,
        PoolError::MintMismatch
    );

    // Root ring membership.
    {
        let tree = ctx.accounts.tree_state.load()?;
        require!(
            util::tree_has_recent_root(&tree, &pi.merkle_root),
            PoolError::InvalidMerkleRoot
        );
    }

    // Shard prefix consistency (where nullifier is non-zero).
    for i in 0..2 {
        let is_dummy = (args.in_dummy_mask >> i) & 1 == 1;
        if is_dummy {
            require!(
                pi.nullifier[i] == [0u8; 32],
                PoolError::ProofPublicInputMismatch
            );
            continue;
        }
        let actual_prefix = util::shard_prefix(&pi.nullifier[i]);
        require!(
            actual_prefix == args.nullifier_shard_prefix[i],
            PoolError::NullifierShardMismatch
        );
    }

    // Verify relayer fee recipient ATA matches relayer_fee_recipient pubkey.
    // SDK computes the ATA; we check ownership matches.
    if pi.relayer_fee > 0 {
        require!(
            ctx.accounts.relayer_fee_token_account.owner == args.relayer_fee_recipient,
            PoolError::InvalidFeeBinding
        );
    }

    // CRITICAL: bind the recipient ATA's owner into the proof. Without this,
    // a malicious relayer could swap `recipient_token_account` in the accounts
    // list for their own ATA and redirect funds. The circuit commits to
    // recipient_bind = Poseidon_3(tag, ownerLow, ownerHigh) over the recipient
    // owner's pubkey split into two 128-bit halves (collision-free).
    let recipient_owner = ctx.accounts.recipient_token_account.owner.to_bytes();
    let mut low_bytes = [0u8; 32];
    low_bytes[..16].copy_from_slice(&recipient_owner[..16]);
    let mut high_bytes = [0u8; 32];
    high_bytes[..16].copy_from_slice(&recipient_owner[16..32]);
    let expected_bind = hashv(
        Parameters::Bn254X5,
        Endianness::LittleEndian,
        &[&TAG_RECIPIENT_BIND[..], &low_bytes[..], &high_bytes[..]],
    )
    .map_err(|_| error!(PoolError::InvalidInstructionData))?
    .to_bytes();
    require!(
        pi.recipient_bind == expected_bind,
        PoolError::InvalidFeeBinding // reusing close-enough error code for v1; dedicated code in v2
    );

    // Public inputs on the heap to conserve BPF stack.
    let public_inputs: Vec<[u8; 32]> = build_public_inputs_for_unshield(pi);

    let mut proof_bytes = [0u8; 256];
    proof_bytes.copy_from_slice(&args.proof);
    verifier_cpi::invoke_verify_transact(
        &ctx.accounts.verifier_program,
        &proof_bytes,
        &public_inputs,
    )?;

    // Nullifier ordering when both real.
    if (args.in_dummy_mask & 0b11) == 0 {
        require!(
            pi.nullifier[0] < pi.nullifier[1],
            PoolError::NullifierOrderingViolation
        );
    }

    let clock = Clock::get()?;

    if (args.in_dummy_mask & 0b01) == 0 {
        let mut shard = load_or_init_shard(
            &ctx.accounts.nullifier_shard_0,
            args.nullifier_shard_prefix[0],
        )?;
        require!(
            shard.prefix == args.nullifier_shard_prefix[0],
            PoolError::NullifierShardMismatch
        );
        util::nullifier_insert(&mut shard, pi.nullifier[0])?;
        emit!(NullifierSpent {
            nullifier: pi.nullifier[0],
            shard: shard.prefix,
            slot: clock.slot
        });
    }
    if (args.in_dummy_mask & 0b10) == 0 {
        let mut shard = load_or_init_shard(
            &ctx.accounts.nullifier_shard_1,
            args.nullifier_shard_prefix[1],
        )?;
        require!(
            shard.prefix == args.nullifier_shard_prefix[1],
            PoolError::NullifierShardMismatch
        );
        util::nullifier_insert(&mut shard, pi.nullifier[1])?;
        emit!(NullifierSpent {
            nullifier: pi.nullifier[1],
            shard: shard.prefix,
            slot: clock.slot
        });
    }

    // Append change commitments.
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

    // Transfer recipient amount (public_amount_out - relayer_fee).
    let net = pi
        .public_amount_out
        .checked_sub(pi.relayer_fee)
        .ok_or(error!(PoolError::ValueOverflow))?;

    let pool_config_info = ctx.accounts.pool_config.to_account_info();
    let cpi_accounts = Transfer {
        from: ctx.accounts.vault.to_account_info(),
        to: ctx.accounts.recipient_token_account.to_account_info(),
        authority: pool_config_info.clone(),
    };
    let seeds: &[&[u8]] = &[VERSION_PREFIX, SEED_CONFIG, &[ctx.bumps.pool_config]];
    let signer = &[seeds];
    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            cpi_accounts,
            signer,
        ),
        net,
    )?;

    // Relayer fee transfer (if non-zero).
    if pi.relayer_fee > 0 {
        let cpi_fee = Transfer {
            from: ctx.accounts.vault.to_account_info(),
            to: ctx.accounts.relayer_fee_token_account.to_account_info(),
            authority: pool_config_info.clone(),
        };
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                cpi_fee,
                signer,
            ),
            pi.relayer_fee,
        )?;
    }

    emit!(UnshieldExecuted {
        mint: ctx.accounts.token_config.mint,
        recipient: ctx.accounts.recipient_token_account.owner,
        amount: net,
        relayer_fee: pi.relayer_fee,
        slot: clock.slot,
    });

    Ok(())
}

fn u64_to_fr_le(v: u64) -> [u8; 32] {
    let mut out = [0u8; 32];
    out[..8].copy_from_slice(&v.to_le_bytes());
    out
}

fn load_or_init_shard<'a, 'info>(
    loader: &'a AccountLoader<'info, NullifierShard>,
    expected_prefix: u16,
) -> Result<std::cell::RefMut<'a, NullifierShard>> {
    if let Ok(mut shard) = loader.load_mut() {
        if shard.count == 0 && shard.prefix == 0 {
            shard.prefix = expected_prefix;
        }
        return Ok(shard);
    }
    let mut shard = loader.load_init()?;
    shard.prefix = expected_prefix;
    Ok(shard)
}

#[inline(never)]
fn build_public_inputs_for_unshield(pi: &TransactPublicInputs) -> Vec<[u8; 32]> {
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

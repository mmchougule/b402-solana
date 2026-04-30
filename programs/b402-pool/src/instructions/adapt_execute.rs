//! `adapt_execute` — ZK-bound composable execution path (PRD-04 §3).
//!
//! Full flow, with all cryptographic bindings:
//!   1. Parse AdaptPublicInputs (the wire-slim subset; v2.1 dropped two
//!      Pubkey fields that travel as account-derived values instead).
//!   2. Bind to pool state:
//!        - public_token_mint           is set from token_config_in.mint
//!                                      when reconstructing the verifier's
//!                                      23-element public-input vector.
//!        - expected_out_mint           is set from token_config_out.mint
//!                                      same way.
//!        - adapter_program             is registered + enabled
//!        - adapter_program ix disc    is allowlisted
//!        - adapter_id (public input)  == keccak(adapter_program.key) mod p
//!        - action_hash (public input) == Poseidon_3(
//!                                           adaptBindTag,
//!                                           keccak(action_payload) mod p,
//!                                           expected_out_mint Fr,
//!                                       )
//!        - merkle_root                 is in the 128-root recent ring
//!   3. Verify Groth16 proof via b402_verifier_adapt CPI (23 public inputs).
//!   4. Burn input nullifiers (same sharded insert as unshield).
//!   5. Pool-signed transfer: in_vault → adapter_in_ta (amount = public_amount_in).
//!   6. Snapshot out_vault pre-balance.
//!   7. CPI the adapter with caller-supplied raw ix data + remaining_accounts.
//!   8. Post-CPI invariant: out_vault delta ≥ expected_out_value (I4).
//!   9. Append output commitments to the tree (same pattern as transact).
//!  10. Pay relayer fee in IN mint from in_vault (pool-signed).
//!  11. Emit AdaptExecuted event.
//!
//! Replaces the earlier feature-gated `adapt_execute_devnet` handler. That
//! stub trusted caller-supplied output commitments; the circuit binding
//! above closes the cross-mint hole described in docs/PHASE-2.md.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::keccak;
use anchor_lang::solana_program::poseidon::{hashv, Endianness, Parameters};
use anchor_lang::solana_program::program::invoke;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use crate::constants::{
    SEED_ADAPTERS, SEED_CONFIG, SEED_TOKEN, SEED_TREE, SEED_VAULT, TAG_ADAPT_BIND,
    TAG_COMMIT, TAG_FEE_BIND, TAG_MK_NODE, TAG_NULLIFIER, TAG_RECIPIENT_BIND, TAG_SPEND_KEY_PUB,
    VERSION_PREFIX,
};
use crate::error::PoolError;
use crate::events::{AdaptExecuted, CommitmentAppended, NullifierSpent};
use crate::state::{AdapterRegistry, PoolConfig, TokenConfig, TreeState};
use crate::util;

use super::shield::EncryptedNote;
use super::verifier_cpi;

/// v2.1 ix-data trim: dropped `public_token_mint` and `expected_out_mint`
/// (32B each) from the wire. The handler validates these against the
/// already-trusted `token_config_*.mint` PDAs and re-injects them when
/// reconstructing the verifier's 23-element public-input vector. The
/// circuit + proof shape is unchanged; only the wire shape shrinks by 64B,
/// letting v0+ALT swap/lend/redeem/perpOpen txs fit under 1232 bytes.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct AdaptPublicInputs {
    pub merkle_root: [u8; 32],
    pub nullifier: [[u8; 32]; 2],
    pub commitment_out: [[u8; 32]; 2],
    pub public_amount_in: u64,
    pub public_amount_out: u64,    // adapt requires this to be zero
    pub relayer_fee: u64,
    pub relayer_fee_bind: [u8; 32],
    pub root_bind: [u8; 32],
    pub recipient_bind: [u8; 32],
    // Phase 7B trim: adapter_id (= keccak(adapter_program_id) mod p) is no
    // longer carried on the wire. Pool reconstructs it on-chain from the
    // adapter_program account at line ~258 and feeds the recomputed value
    // into the verifier vector — same circuit, same proof binding, just
    // -32 wire bytes per adapt_execute.
    pub action_hash: [u8; 32], // Poseidon_3(adaptBindTag, keccakFr, expectedOutMint_Fr)
    pub expected_out_value: u64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct AdaptExecuteArgs {
    pub proof: Vec<u8>, // must be 256 bytes
    pub public_inputs: AdaptPublicInputs,
    pub encrypted_notes: Vec<EncryptedNote>, // 0..=2 entries
    pub in_dummy_mask: u8,
    pub out_dummy_mask: u8,
    pub relayer_fee_recipient: Pubkey,
    /// Exact bytes forwarded as the adapter's Anchor instruction data.
    /// First 8 bytes are the adapter's ix discriminator, checked against
    /// the registry's allowlist.
    pub raw_adapter_ix_data: Vec<u8>,
    /// The action_payload the proof was generated over. Pool recomputes
    /// keccak256(action_payload) mod p and checks it matches the
    /// circuit's action_hash public input.
    pub action_payload: Vec<u8>,
    /// Phase 7 (`inline_cpi_nullifier`) ONLY: per-non-dummy-nullifier
    /// validity-proof + address-tree-info bytes. See
    /// `unshield::UnshieldArgs::nullifier_cpi_payloads` for the layout
    /// (134 B per entry). v2.1 builds (sibling-ix) do not carry this on
    /// the wire — the field is feature-gated.
    #[cfg(feature = "inline_cpi_nullifier")]
    pub nullifier_cpi_payloads: Vec<[u8; 134]>,
}

#[derive(Accounts)]
#[instruction(args: AdaptExecuteArgs)]
pub struct AdaptExecute<'info> {
    #[account(mut)]
    pub relayer: Signer<'info>,

    #[account(
        seeds = [VERSION_PREFIX, SEED_CONFIG],
        bump,
    )]
    pub pool_config: Box<Account<'info, PoolConfig>>,

    #[account(
        seeds = [VERSION_PREFIX, SEED_ADAPTERS],
        bump,
    )]
    pub adapter_registry: Box<Account<'info, AdapterRegistry>>,

    #[account(
        seeds = [VERSION_PREFIX, SEED_TOKEN, token_config_in.mint.as_ref()],
        bump,
        constraint = token_config_in.enabled @ PoolError::TokenNotWhitelisted,
    )]
    pub token_config_in: Box<Account<'info, TokenConfig>>,

    #[account(
        seeds = [VERSION_PREFIX, SEED_TOKEN, token_config_out.mint.as_ref()],
        bump,
        constraint = token_config_out.enabled @ PoolError::TokenNotWhitelisted,
    )]
    pub token_config_out: Box<Account<'info, TokenConfig>>,

    #[account(
        mut,
        seeds = [VERSION_PREFIX, SEED_VAULT, token_config_in.mint.as_ref()],
        bump,
        constraint = in_vault.key() == token_config_in.vault @ PoolError::VaultMismatch,
    )]
    pub in_vault: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        seeds = [VERSION_PREFIX, SEED_VAULT, token_config_out.mint.as_ref()],
        bump,
        constraint = out_vault.key() == token_config_out.vault @ PoolError::VaultMismatch,
    )]
    pub out_vault: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        seeds = [VERSION_PREFIX, SEED_TREE],
        bump,
    )]
    pub tree_state: AccountLoader<'info, TreeState>,

    /// CHECK: validated against pool_config.verifier_adapt.
    pub verifier_program: AccountInfo<'info>,

    /// CHECK: validated against adapter_registry.
    pub adapter_program: UncheckedAccount<'info>,

    /// CHECK: adapter's own PDA signer. The adapter validates its own seeds.
    pub adapter_authority: UncheckedAccount<'info>,

    #[account(
        mut,
        constraint = adapter_in_ta.mint == token_config_in.mint @ PoolError::MintMismatch,
        constraint = adapter_in_ta.owner == adapter_authority.key() @ PoolError::VaultMismatch,
    )]
    pub adapter_in_ta: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        constraint = adapter_out_ta.mint == token_config_out.mint @ PoolError::MintMismatch,
        constraint = adapter_out_ta.owner == adapter_authority.key() @ PoolError::VaultMismatch,
    )]
    pub adapter_out_ta: Box<Account<'info, TokenAccount>>,

    /// Relayer fee destination (IN mint). Zero-fee txs may pass any
    /// TokenAccount owned by the relayer as a sentinel; handler enforces
    /// owner == args.relayer_fee_recipient when fee > 0.
    #[account(
        mut,
        constraint = relayer_fee_ta.mint == token_config_in.mint @ PoolError::MintMismatch,
    )]
    pub relayer_fee_ta: Box<Account<'info, TokenAccount>>,

    /// v2: pool no longer writes nullifier shard PDAs. Instead, it
    /// verifies the same tx contains a `b402_nullifier::create_nullifier`
    /// ix per non-dummy nullifier (which lands the nullifier in Light's
    /// address tree). Sysvar lets us walk the tx's ix list.
    /// CHECK: address constraint enforces the canonical sysvar pubkey.
    #[account(address = anchor_lang::solana_program::sysvar::instructions::ID)]
    pub instructions_sysvar: AccountInfo<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[inline(never)]
pub fn handler<'info>(
    ctx: Context<'_, '_, '_, 'info, AdaptExecute<'info>>,
    args: Box<AdaptExecuteArgs>,
) -> Result<()> {
    require!(args.proof.len() == 256, PoolError::InvalidInstructionData);
    require!(
        args.encrypted_notes.len() <= 2,
        PoolError::InvalidInstructionData
    );
    require!(
        args.raw_adapter_ix_data.len() >= 8,
        PoolError::InvalidInstructionData
    );

    let cfg = &ctx.accounts.pool_config;
    require!(!cfg.paused_adapts, PoolError::PoolPaused);
    require!(
        ctx.accounts.verifier_program.key() == cfg.verifier_adapt,
        PoolError::ProofVerificationFailed
    );
    let pi = &args.public_inputs;

    require!(
        pi.public_amount_out == 0,
        PoolError::PublicAmountExclusivity
    );
    require!(pi.public_amount_in > 0, PoolError::PublicAmountExclusivity);

    // Mint bindings: token_config PDAs are validated by their seeds, so
    // their .mint fields are the trusted on-chain values. We bind the
    // proof to these mints (not to wire-supplied pubkeys) by injecting
    // them into the public-input vector during build_public_inputs_for_adapt.
    let in_mint = ctx.accounts.token_config_in.mint;
    let out_mint = ctx.accounts.token_config_out.mint;

    // Adapter registry + ix discriminator allowlist.
    let adapter_program_key = ctx.accounts.adapter_program.key();
    let adapter_ix_disc: [u8; 8] = args.raw_adapter_ix_data[0..8]
        .try_into()
        .map_err(|_| error!(PoolError::InvalidInstructionData))?;
    {
        let registry = &ctx.accounts.adapter_registry;
        let info = registry
            .adapters
            .iter()
            .find(|a| a.program_id == adapter_program_key && a.enabled)
            .ok_or(error!(PoolError::AdapterNotRegistered))?;
        let allowed = &info.allowed_instructions[..info.allowed_instruction_count as usize];
        require!(
            allowed.contains(&adapter_ix_disc),
            PoolError::AdapterNotRegistered
        );

        // adapter_id (= keccak(adapter_program_id) mod p) — the pool
        // reconstructs it from the adapter_program account and feeds the
        // recomputed value to the verifier (see build_public_inputs_for_adapt).
        // Phase 7B trim: no longer in args — pool is the source of truth.
    }

    // action_hash binding: circuit proved Poseidon_3 over (adaptBindTag,
    // keccak(action_payload) mod p, expected_out_mint Fr). Pool recomputes
    // and rejects any tampering between proof gen and submission.
    {
        let payload_keccak = keccak::hash(&args.action_payload).0;
        let payload_keccak_fr = util::reduce_le_mod_p(&payload_keccak);
        let expected_out_mint_fr = util::reduce_le_mod_p(&out_mint.to_bytes());
        let expected_action_hash = hashv(
            Parameters::Bn254X5,
            Endianness::LittleEndian,
            &[
                &TAG_ADAPT_BIND[..],
                &payload_keccak_fr[..],
                &expected_out_mint_fr[..],
            ],
        )
        .map_err(|_| error!(PoolError::InvalidInstructionData))?
        .to_bytes();
        require!(
            pi.action_hash == expected_action_hash,
            PoolError::InvalidAdapterBinding
        );
    }

    // Root ring membership.
    {
        let tree = ctx.accounts.tree_state.load()?;
        require!(
            util::tree_has_recent_root(&tree, &pi.merkle_root),
            PoolError::InvalidMerkleRoot
        );
    }

    // Dummy nullifier values must be zero. Sibling-ix verification
    // for non-dummy nullifiers happens after proof verify (below).
    for i in 0..2 {
        let is_dummy = (args.in_dummy_mask >> i) & 1 == 1;
        if is_dummy {
            require!(
                pi.nullifier[i] == [0u8; 32],
                PoolError::ProofPublicInputMismatch
            );
        }
    }

    // Relayer fee binding: fee comes out of in_vault (IN mint), so cap it
    // at public_amount_in. SDK encodes args.relayer_fee_recipient; circuit
    // proved Poseidon over (TAG_FEE_BIND, fee, recipient) into pi.relayer_fee_bind.
    require!(
        pi.relayer_fee <= pi.public_amount_in,
        PoolError::InvalidFeeBinding
    );
    if pi.relayer_fee > 0 {
        require!(
            ctx.accounts.relayer_fee_ta.owner == args.relayer_fee_recipient,
            PoolError::InvalidFeeBinding
        );
    }

    // Verify proof.
    let public_inputs: Vec<[u8; 32]> = build_public_inputs_for_adapt(pi, &in_mint, &out_mint, &adapter_program_key);
    let mut proof_bytes = [0u8; 256];
    proof_bytes.copy_from_slice(&args.proof);
    verifier_cpi::invoke_verify_adapt(
        &ctx.accounts.verifier_program,
        &proof_bytes,
        &public_inputs,
    )?;

    // Nullifier ordering check (when both input slots are non-dummy).
    if (args.in_dummy_mask & 0b11) == 0 {
        require!(
            pi.nullifier[0] < pi.nullifier[1],
            PoolError::NullifierOrderingViolation
        );
    }

    let clock = Clock::get()?;

    // Nullifier insert into Light's address tree V2.
    //
    // v2.1 default (sibling-ix): walk the instructions sysvar; for each
    // non-dummy nullifier confirm a matching b402_nullifier::create_nullifier
    // ix is present in the same atomic tx.
    //
    // Phase 7 (`inline_cpi_nullifier`): pool CPIs into b402_nullifier
    // directly. `remaining_accounts` layout in this mode:
    //   [0]                       = b402_nullifier program AccountInfo
    //   [1 .. 1+ACCT*real_count]  = b402_nullifier accounts (9 per real slot)
    //   [1+ACCT*real_count ..]    = adapter-specific remaining accounts
    //                                (forwarded verbatim to the adapter CPI)
    // The adapter-CPI section is sliced AFTER the nullifier section below.
    let nullifier_remaining_consumed: usize;
    #[cfg(not(feature = "inline_cpi_nullifier"))]
    {
        use anchor_lang::solana_program::sysvar::instructions::load_current_index_checked;
        let ix_sysvar = &ctx.accounts.instructions_sysvar;
        let current_ix_index = load_current_index_checked(ix_sysvar)? as usize;
        let mut search_from = current_ix_index + 1;
        for i in 0..2 {
            let is_dummy = (args.in_dummy_mask >> i) & 1 == 1;
            if is_dummy {
                continue;
            }
            let found_at = util::verify_nullifier_ix_in_tx(
                ix_sysvar,
                &super::transact::B402_NULLIFIER_PROGRAM_ID,
                &pi.nullifier[i],
                search_from,
            )?;
            search_from = found_at + 1;
            emit!(NullifierSpent {
                nullifier: pi.nullifier[i],
                shard: 0, // legacy field; meaningful only for v1
                slot: clock.slot,
            });
        }
        nullifier_remaining_consumed = 0;
    }
    #[cfg(feature = "inline_cpi_nullifier")]
    {
        use super::nullifier_cpi::{invoke_create_nullifier, B402_NULLIFIER_PROGRAM_ID};
        // 1 payer + 1 ix sysvar + 8 Light accounts = 10 per nullifier insert
        // (matches `b402_nullifier --features cpi-only` Accounts layout).
        const ACCT_PER_NULL: usize = 10;

        let remaining = ctx.remaining_accounts;
        require!(!remaining.is_empty(), PoolError::NullifierIxMalformed);
        let nullifier_program = &remaining[0];
        require!(
            nullifier_program.key == &B402_NULLIFIER_PROGRAM_ID,
            PoolError::NullifierIxMalformed
        );

        let real_count = (0..2)
            .filter(|i| (args.in_dummy_mask >> i) & 1 == 0)
            .count();
        require!(
            args.nullifier_cpi_payloads.len() == real_count,
            PoolError::NullifierIxMalformed
        );
        require!(
            remaining.len() >= 1 + real_count * ACCT_PER_NULL,
            PoolError::NullifierIxMalformed
        );

        let mut payload_idx = 0usize;
        let mut acct_cursor = 1usize;
        for i in 0..2 {
            let is_dummy = (args.in_dummy_mask >> i) & 1 == 1;
            if is_dummy {
                continue;
            }
            let payload = &args.nullifier_cpi_payloads[payload_idx];
            payload_idx += 1;
            let null_accts = &remaining[acct_cursor..acct_cursor + ACCT_PER_NULL];
            acct_cursor += ACCT_PER_NULL;
            invoke_create_nullifier(
                nullifier_program,
                null_accts,
                payload,
                &pi.nullifier[i],
            )?;
            emit!(NullifierSpent {
                nullifier: pi.nullifier[i],
                shard: 0, // legacy field
                slot: clock.slot,
            });
        }

        nullifier_remaining_consumed = 1 + real_count * ACCT_PER_NULL;
    }

    // Pool transfers public_amount_in to adapter_in_ta (pool PDA signs the vault).
    let pool_config_info = ctx.accounts.pool_config.to_account_info();
    let signer_seeds: &[&[u8]] = &[VERSION_PREFIX, SEED_CONFIG, &[ctx.bumps.pool_config]];
    let signer = &[signer_seeds];
    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.in_vault.to_account_info(),
                to: ctx.accounts.adapter_in_ta.to_account_info(),
                authority: pool_config_info.clone(),
            },
            signer,
        ),
        pi.public_amount_in,
    )?;

    // Relayer fee transfer (in IN mint, from in_vault). Circuit binding via
    // pi.relayer_fee_bind = Poseidon(TAG_FEE_BIND, fee, recipient).
    if pi.relayer_fee > 0 {
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.in_vault.to_account_info(),
                    to: ctx.accounts.relayer_fee_ta.to_account_info(),
                    authority: pool_config_info.clone(),
                },
                signer,
            ),
            pi.relayer_fee,
        )?;
    }

    // Pre-CPI snapshot for the delta invariant.
    ctx.accounts.out_vault.reload()?;
    let pre = ctx.accounts.out_vault.amount;

    // Build + CPI adapter. Unified ABI: six named accounts, then remaining.
    //
    // In `inline_cpi_nullifier` builds, the front of `remaining_accounts`
    // belongs to the b402_nullifier CPI block above; only the tail past
    // `nullifier_remaining_consumed` is forwarded to the adapter.
    let adapter_remaining = &ctx.remaining_accounts[nullifier_remaining_consumed..];

    let adapter_metas: Vec<AccountMeta> = {
        let mut m = Vec::with_capacity(6 + adapter_remaining.len());
        m.push(AccountMeta::new_readonly(
            ctx.accounts.adapter_authority.key(),
            false,
        ));
        m.push(AccountMeta::new(ctx.accounts.in_vault.key(), false));
        m.push(AccountMeta::new(ctx.accounts.out_vault.key(), false));
        m.push(AccountMeta::new(ctx.accounts.adapter_in_ta.key(), false));
        m.push(AccountMeta::new(ctx.accounts.adapter_out_ta.key(), false));
        m.push(AccountMeta::new_readonly(
            ctx.accounts.token_program.key(),
            false,
        ));
        for a in adapter_remaining.iter() {
            if a.is_writable {
                m.push(AccountMeta::new(*a.key, a.is_signer));
            } else {
                m.push(AccountMeta::new_readonly(*a.key, a.is_signer));
            }
        }
        m
    };
    let mut adapter_infos: Vec<AccountInfo<'info>> =
        Vec::with_capacity(6 + adapter_remaining.len());
    adapter_infos.push(ctx.accounts.adapter_authority.to_account_info());
    adapter_infos.push(ctx.accounts.in_vault.to_account_info());
    adapter_infos.push(ctx.accounts.out_vault.to_account_info());
    adapter_infos.push(ctx.accounts.adapter_in_ta.to_account_info());
    adapter_infos.push(ctx.accounts.adapter_out_ta.to_account_info());
    adapter_infos.push(ctx.accounts.token_program.to_account_info());
    for a in adapter_remaining.iter() {
        adapter_infos.push(a.clone());
    }

    let ix = Instruction {
        program_id: adapter_program_key,
        accounts: adapter_metas,
        data: args.raw_adapter_ix_data.clone(),
    };
    invoke(&ix, &adapter_infos).map_err(|_| error!(PoolError::AdapterCallReverted))?;

    // Post-CPI balance-delta invariant (I4).
    ctx.accounts.out_vault.reload()?;
    let post = ctx.accounts.out_vault.amount;
    let delta = post.saturating_sub(pre);
    require!(
        delta >= pi.expected_out_value,
        PoolError::AdapterReturnedLessThanMin
    );

    // Append output commitments to the tree.
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

    emit!(AdaptExecuted {
        adapter_program: adapter_program_key,
        in_mint: ctx.accounts.token_config_in.mint,
        out_mint: ctx.accounts.token_config_out.mint,
        public_amount_in: pi.public_amount_in,
        out_delta: delta,
        expected_out_value: pi.expected_out_value,
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

#[inline(never)]
fn build_public_inputs_for_adapt(
    pi: &AdaptPublicInputs,
    in_mint: &Pubkey,
    out_mint: &Pubkey,
    adapter_program: &Pubkey,
) -> Vec<[u8; 32]> {
    let mut v: Vec<[u8; 32]> = Vec::with_capacity(verifier_cpi::PUBLIC_INPUT_COUNT_ADAPT);
    // First 18 — identical layout to transact.
    v.push(pi.merkle_root);
    v.push(pi.nullifier[0]);
    v.push(pi.nullifier[1]);
    v.push(pi.commitment_out[0]);
    v.push(pi.commitment_out[1]);
    v.push(u64_to_fr_le(pi.public_amount_in));
    v.push(u64_to_fr_le(pi.public_amount_out));
    // public_token_mint: derived from token_config_in. Same value the
    // circuit was generated against; just no longer travels on the wire.
    v.push(util::reduce_le_mod_p(&in_mint.to_bytes()));
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
    // Adapt-specific — 5 more.
    // adapter_id: pool reconstructs from adapter_program account.
    let adapter_id_digest = anchor_lang::solana_program::keccak::hash(adapter_program.as_ref()).0;
    v.push(util::reduce_le_mod_p(&adapter_id_digest));
    v.push(pi.action_hash);
    v.push(u64_to_fr_le(pi.expected_out_value));
    // expected_out_mint: derived from token_config_out, same circuit binding.
    v.push(util::reduce_le_mod_p(&out_mint.to_bytes()));
    v.push(TAG_ADAPT_BIND);
    v
}

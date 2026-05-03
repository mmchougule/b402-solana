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
    TAG_COMMIT, TAG_FEE_BIND, TAG_MK_NODE, TAG_NULLIFIER, TAG_RECIPIENT_BIND,
    TAG_SPEND_KEY_PUB, VERSION_PREFIX,
};
#[cfg(feature = "phase_9_dual_note")]
use crate::constants::TAG_EXCESS;
use crate::error::PoolError;
use crate::events::{AdaptExecuted, CommitmentAppended, NullifierSpent};
#[cfg(feature = "phase_9_dual_note")]
use crate::events::ExcessNoteMinted;
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
    // adapter_program account and feeds the recomputed value into the
    // verifier vector.
    //
    // Phase 9 wire-size compensator: action_hash (= Poseidon_3(adaptBindTag,
    // keccak(action_payload) mod p, expected_out_mint Fr)) is also dropped
    // from the wire. Pool already reconstructs `expected_action_hash` for
    // the binding check below; the same value is passed to the verifier.
    // Saves 32B per adapt_execute, offsetting the +32B from out_spending_pub
    // so net wire stays at the Phase 7B size.
    pub expected_out_value: u64,
    /// Phase 9 dual-note: outSpendingPub[0] (the real OUT note's spending
    /// pub) lifted to a public input by the circuit so the pool can
    /// recompute the excess-output commitment in Rust. 32-byte little-endian
    /// Fr — same encoding as every other Fr public input. Feature-gated;
    /// Phase 7B (default) builds do not carry this field.
    #[cfg(feature = "phase_9_dual_note")]
    pub out_spending_pub: [u8; 32],
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

    /// PRD-35 §5.3 — per-user pending-inputs PDA. Pool validates it's
    /// the canonical PDA derived from `pi.out_spending_pub` (the same
    /// 32 B that appear as Phase 9's outSpendingPub[0] public input),
    /// reads the inputs through verifier-adapt's new ix variant, and
    /// zeroes `version` after successful verify (replay protection).
    /// Only required under `prd_35_pending_inputs`. Default builds use
    /// the inline-inputs verify path and ignore this account.
    /// CHECK: handler validates seeds + version field.
    #[cfg(feature = "prd_35_pending_inputs")]
    #[account(mut)]
    pub pending_inputs: UncheckedAccount<'info>,

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

    // action_hash: circuit proved Poseidon_3 over (adaptBindTag,
    // keccak(action_payload) mod p, expected_out_mint Fr). Pool reconstructs
    // it from on-chain values (action_payload + token_config_out.mint) and
    // feeds the recomputed value to the verifier — same proof binding,
    // 32 fewer wire bytes per adapt_execute (Phase 9 trim, mirrors the
    // adapter_id removal from Phase 7B).
    let computed_action_hash: [u8; 32] = {
        let payload_keccak = keccak::hash(&args.action_payload).0;
        let payload_keccak_fr = util::reduce_le_mod_p(&payload_keccak);
        let expected_out_mint_fr = util::reduce_le_mod_p(&out_mint.to_bytes());
        hashv(
            Parameters::Bn254X5,
            Endianness::LittleEndian,
            &[
                &TAG_ADAPT_BIND[..],
                &payload_keccak_fr[..],
                &expected_out_mint_fr[..],
            ],
        )
        .map_err(|_| error!(PoolError::InvalidInstructionData))?
        .to_bytes()
    };

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
    //
    // PRD-35 §5.3 — pending_inputs path. Pool validates the per-user
    // pending_inputs PDA matches the canonical derivation from
    // pi.out_spending_pub, then asks verifier-adapt to read the inputs
    // from account.data instead of carrying them inline. Saves ~768 B of
    // ix data, lifting the v0-tx 1232 B ceiling for per-user adapters.
    //
    // The pool ALSO recomputes the inputs vector via build_public_inputs_
    // for_adapt and asserts it matches the bytes the verifier will see.
    // Otherwise a malicious caller could write OTHER inputs to a different
    // PDA and pass that PDA in. Defence-in-depth: PDA derivation pins
    // who-owns-the-inputs; byte-equality pins what-they-are.
    let public_inputs: Vec<[u8; 32]> = build_public_inputs_for_adapt(pi, &in_mint, &out_mint, &adapter_program_key, &computed_action_hash);
    let mut proof_bytes = [0u8; 256];
    proof_bytes.copy_from_slice(&args.proof);

    #[cfg(feature = "prd_35_pending_inputs")]
    {
        // Phase 9 outSpendingPub is the per-user identifier. Pre-Phase-9
        // builds don't carry this input; the prd_35 path requires Phase 9.
        #[cfg(not(feature = "phase_9_dual_note"))]
        compile_error!("prd_35_pending_inputs requires phase_9_dual_note (out_spending_pub is the PDA-scoping input)");

        #[cfg(feature = "phase_9_dual_note")]
        {
            use crate::instructions::commit_inputs::{
                PendingInputs, PENDING_INPUTS_SEED, VERSION_PREFIX,
            };
            let pending_acct = &ctx.accounts.pending_inputs;
            // (1) Validate PDA derivation. Seeds match commit_inputs.rs.
            let spending_pub_le = pi.out_spending_pub;
            let (expected_pda, _bump) = Pubkey::find_program_address(
                &[VERSION_PREFIX, PENDING_INPUTS_SEED, spending_pub_le.as_ref()],
                &crate::ID,
            );
            require_keys_eq!(
                pending_acct.key(),
                expected_pda,
                PoolError::ProofVerificationFailed
            );
            // (2) Validate the bytes match what we computed. Pool refuses to
            // verify against an account whose contents disagree with the
            // pool's recomputed pi vector — defends against PDA-hijack /
            // wrong-inputs-substitution.
            {
                let acct_data = pending_acct.try_borrow_data()?;
                require!(
                    acct_data.len() >= 8 + PendingInputs::LEN,
                    PoolError::ProofVerificationFailed
                );
                require!(acct_data[8] == 1, PoolError::ProofVerificationFailed);
                for (i, want) in public_inputs.iter().enumerate() {
                    let off = 8 + 1 + i * 32;
                    let on_chain = &acct_data[off..off + 32];
                    require!(on_chain == want.as_slice(), PoolError::ProofVerificationFailed);
                }
            }
            // (3) Verify via account-inputs CPI.
            verifier_cpi::invoke_verify_adapt_with_account_inputs(
                &ctx.accounts.verifier_program,
                &pending_acct.to_account_info(),
                &proof_bytes,
            )?;
            // (4) Replay protection: zero the version byte. Subsequent
            // verify attempts against this PDA fail (PendingInputsNotCommitted).
            // We zero ONLY the version (1 byte) instead of the full 768 B
            // inputs region — saves ~10k CU and is sufficient for replay
            // protection (verifier requires version == 1 to read).
            let mut acct_data = pending_acct.try_borrow_mut_data()?;
            acct_data[8] = 0;
        }
    }

    #[cfg(not(feature = "prd_35_pending_inputs"))]
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

    // PRD-33 Phase 33.1: stateful-adapter forwarding. When the target
    // adapter is in the stateful list AND the pool is built with
    // phase_9_dual_note (so `pi.out_spending_pub` is available), the inner
    // action_payload is prefixed with the user's viewing_pub_hash before
    // forwarding. Stateless adapters get the bytes verbatim. Path-2 builds
    // (no phase_9_dual_note) skip the rewrite and ship the v0.1 wire
    // unchanged — there's no out_spending_pub to forward.
    #[cfg(feature = "phase_9_dual_note")]
    let cpi_ix_data: Vec<u8> = if is_stateful_adapter(&adapter_program_key) {
        prepend_viewing_pub_hash_to_action_payload(
            &args.raw_adapter_ix_data,
            &pi.out_spending_pub,
        )?
    } else {
        args.raw_adapter_ix_data.clone()
    };
    #[cfg(not(feature = "phase_9_dual_note"))]
    let cpi_ix_data: Vec<u8> = args.raw_adapter_ix_data.clone();

    let ix = Instruction {
        program_id: adapter_program_key,
        accounts: adapter_metas,
        data: cpi_ix_data,
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

    // Append output commitments to the tree, then (Phase 9 dual-note) any
    // excess delta as a SECOND commitment owned by the same spending_pub.
    //
    // Invariant chain that makes the excess leaf safe:
    //   1. `delta` is read from this program's own out_vault PDA (post-CPI
    //      reload + saturating_sub of the snapshot). Adapter cannot forge it.
    //   2. `pi.expected_out_value` and `pi.out_spending_pub` are bound to
    //      the verified Groth16 proof — see circuit constraints
    //      `outSum === expectedOutValue` and
    //      `outSpendingPubA === outSpendingPub[0]` in adapt.circom.
    //   3. `random_b = Poseidon(commitment_a, TAG_EXCESS)` is deterministic
    //      from a public, proof-bound value plus a fixed tag. The SDK
    //      derives the same value off-chain so it can spend the leaf later.
    //   4. `commitment_b` mirrors the SDK's `commitmentHash` exactly:
    //      Poseidon(TAG_COMMIT, outMintFr, valueFr, randomB, spendingPub)
    //      with `Endianness::LittleEndian` (same convention as every other
    //      Poseidon call in this program — see PHASE-9 spike notes §5).
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

        // Phase 9 dual-note: mint the excess delta into a second leaf. The
        // canonical OUT note slot is index 0 (slot 1 is the dummy in the
        // current swap shape — outIsDummy[1]=1 in the witness). The excess
        // note is bound to the same spending_pub as the main note via the
        // Poseidon commitment, so only the holder of `spending_priv` can
        // ever spend it.
        // Feature-gated: Phase 7B builds (default) leave excess in the
        // shared vault and skip this block. Phase 9 builds opt in by
        // compiling with `--features phase_9_dual_note`, which also bumps
        // PUBLIC_INPUT_COUNT to 24 and requires the matching VK.
        #[cfg(feature = "phase_9_dual_note")]
        {
        let excess: u64 = delta
            .checked_sub(pi.expected_out_value)
            .ok_or(error!(PoolError::ArithmeticUnderflow))?;
        if excess > 0 {
            let out_mint_fr = util::reduce_le_mod_p(&out_mint.to_bytes());
            let commitment_a = pi.commitment_out[0];

            // random_b = Poseidon(TAG_EXCESS, commitment_a) LE.
            // Tag-first ordering matches `poseidonTagged` convention used by
            // every other domain-tagged Poseidon call (commitment, nullifier,
            // recipient_bind, ...). SDK mirrors this in
            // packages/sdk/src/excess.ts::deriveExcessRandom which calls
            // poseidonTagged('excess', commitmentA) = Poseidon(TAG, commitmentA).
            // Reversing this order produces different bytes (Poseidon is a
            // sponge construction; permuting inputs changes the digest).
            let random_b = hashv(
                Parameters::Bn254X5,
                Endianness::LittleEndian,
                &[&TAG_EXCESS[..], &commitment_a[..]],
            )
            .map_err(|_| error!(PoolError::ProofVerificationFailed))?
            .to_bytes();

            // commitment_b matches packages/sdk/src/poseidon.ts::commitmentHash:
            //   Poseidon([TAG_COMMIT, outMintFr, valueFr, random, spendingPub])
            // The SDK passes inputs in this exact order (see commitmentHash in
            // poseidon.ts:32-39). Any reordering breaks parity silently.
            let value_fr = u64_to_fr_le(excess);
            let commitment_b = hashv(
                Parameters::Bn254X5,
                Endianness::LittleEndian,
                &[
                    &TAG_COMMIT[..],
                    &out_mint_fr[..],
                    &value_fr[..],
                    &random_b[..],
                    &pi.out_spending_pub[..],
                ],
            )
            .map_err(|_| error!(PoolError::ProofVerificationFailed))?
            .to_bytes();

            let excess_leaf_index = tree.leaf_count;
            let new_root = util::tree_append(&mut tree, commitment_b)?;
            // Excess leaf: we don't publish a ciphertext for it. The SDK
            // reconstructs the note locally from on-chain inputs. Pass
            // zero-padding for the encrypted-note fields so off-chain
            // indexers see a consistent shape across both leaves.
            emit!(CommitmentAppended {
                leaf_index: excess_leaf_index,
                commitment: commitment_b,
                ciphertext: [0u8; 89],
                ephemeral_pub: [0u8; 32],
                viewing_tag: [0u8; 2],
                tree_root_after: new_root,
                slot: clock.slot,
            });
            emit!(ExcessNoteMinted {
                leaf_index: excess_leaf_index,
                excess,
            });
        }
        } // end #[cfg(feature = "phase_9_dual_note")] block
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

// ---------------------------------------------------------------------------
// PRD-33 Phase 33.1 — stateful-adapter forwarding.
//
// Stateful DeFi adapters (Kamino lend, Drift perps, Marginfi) require the
// per-user `viewing_pub_hash` to derive their per-user owner PDA before
// composing the protocol-level ix. The pool surfaces this value to the
// adapter by surgically rewriting the adapter ix data: the inner
// `action_payload` field is prefixed with the 32 B `pi.out_spending_pub`,
// and the ix-data length prefix is bumped by 32. Stateless adapters
// (Jupiter, Sanctum, mock) are forwarded byte-for-byte unchanged.
//
// `is_stateful_adapter` is a hardcoded const list rather than a registry
// flag because:
//   1. Adding a field to AdapterInfo would reshape the on-chain
//      AdapterRegistry account, requiring a full re-init at upgrade time.
//   2. New stateful adapters land alongside their adapter-program
//      deployment — bumping the pool to add one entry to this list at the
//      same time has equivalent operational cost (one upgrade tx).
//   3. The list is auditable in source review; an off-chain registry
//      flag is not.
//
// Adapter ix data layout (the universal b402 adapter ABI):
//   [8 disc][8 in_amount][8 min_out][4 payload_len LE][payload bytes ...]
// The transformation prepends the 32 B viewing_pub_hash to the payload
// portion AND bumps the u32 length prefix accordingly.
// ---------------------------------------------------------------------------

/// Hardcoded list of stateful adapter program IDs (PRD-33 §6.1 — Choice C).
/// Adding a stateful adapter = add its program ID here + bump the pool.
fn is_stateful_adapter(program_id: &Pubkey) -> bool {
    // Kamino lend adapter — per-user Obligation under PRD-33 §3.3.
    const KAMINO_ADAPTER: Pubkey =
        anchor_lang::pubkey!("2enwFgcGKJDqruHpCtvmhtxe3DYcV3k72VTvoGcdt2rX");
    program_id == &KAMINO_ADAPTER
}

/// Offset in the adapter ix data at which the action_payload's u32 LE
/// length prefix sits. Layout: `[8 disc][8 in_amount][8 min_out]
/// [4 payload_len][payload bytes]`. Pinned by the b402 adapter ABI; any
/// drift in the SDK's `concat(executeDisc, u64Le(amount), u64Le(out),
/// vecU8(actionPayload))` builder mirrors here.
const ACTION_PAYLOAD_LEN_OFFSET: usize = 8 + 8 + 8;
const ACTION_PAYLOAD_BODY_OFFSET: usize = ACTION_PAYLOAD_LEN_OFFSET + 4;

/// Surgically prepend `viewing_pub_hash` (32 B) to the action_payload
/// embedded in `raw_ix_data`. Returns the new ix-data byte string.
///
/// Errors if `raw_ix_data` is shorter than the fixed prefix or if the
/// embedded length prefix would overflow / overrun the input. Errors
/// flow up as `InvalidInstructionData` so a malformed adapter ix from a
/// buggy SDK aborts the tx cleanly instead of producing a silently-wrong
/// CPI payload.
fn prepend_viewing_pub_hash_to_action_payload(
    raw_ix_data: &[u8],
    viewing_pub_hash: &[u8; 32],
) -> Result<Vec<u8>> {
    require!(
        raw_ix_data.len() >= ACTION_PAYLOAD_BODY_OFFSET,
        crate::error::PoolError::InvalidInstructionData
    );
    let len_bytes: [u8; 4] = raw_ix_data
        [ACTION_PAYLOAD_LEN_OFFSET..ACTION_PAYLOAD_BODY_OFFSET]
        .try_into()
        .map_err(|_| error!(crate::error::PoolError::InvalidInstructionData))?;
    let original_payload_len = u32::from_le_bytes(len_bytes) as usize;
    require!(
        raw_ix_data.len() >= ACTION_PAYLOAD_BODY_OFFSET + original_payload_len,
        crate::error::PoolError::InvalidInstructionData
    );
    // Defence against u32 overflow on the bumped length prefix — payloads
    // are far below 4 GiB so this is paranoia, but it's free.
    let new_payload_len: u32 = (original_payload_len as u32)
        .checked_add(32)
        .ok_or(error!(crate::error::PoolError::InvalidInstructionData))?;

    let mut out = Vec::with_capacity(raw_ix_data.len() + 32);
    out.extend_from_slice(&raw_ix_data[..ACTION_PAYLOAD_LEN_OFFSET]);
    out.extend_from_slice(&new_payload_len.to_le_bytes());
    out.extend_from_slice(viewing_pub_hash);
    out.extend_from_slice(&raw_ix_data[ACTION_PAYLOAD_BODY_OFFSET..]);
    Ok(out)
}

#[inline(never)]
fn build_public_inputs_for_adapt(
    pi: &AdaptPublicInputs,
    in_mint: &Pubkey,
    out_mint: &Pubkey,
    adapter_program: &Pubkey,
    action_hash: &[u8; 32],
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
    // Adapt-specific — 5 entries.
    // adapter_id: pool reconstructs from adapter_program account.
    let adapter_id_digest = anchor_lang::solana_program::keccak::hash(adapter_program.as_ref()).0;
    v.push(util::reduce_le_mod_p(&adapter_id_digest));
    // action_hash: pool reconstructs (Phase 9 trim — see handler).
    v.push(*action_hash);
    v.push(u64_to_fr_le(pi.expected_out_value));
    // expected_out_mint: derived from token_config_out, same circuit binding.
    v.push(util::reduce_le_mod_p(&out_mint.to_bytes()));
    v.push(TAG_ADAPT_BIND);
    // Phase 9 dual-note (verifier index 23): outSpendingPub[0]. Forwarded
    // straight from the wire — the verifier rejects any value that wasn't
    // the prover's real outSpendingPub[0] because the circuit constrains
    // outSpendingPubA === outSpendingPub[0]. Only emitted when the
    // matching VK has the 24-input shape (post-ceremony).
    #[cfg(feature = "phase_9_dual_note")]
    v.push(pi.out_spending_pub);
    v
}

#[cfg(test)]
mod stateful_adapter_forwarding_tests {
    //! PRD-33 Phase 33.1 — pool-side action_payload rewrite.
    //!
    //! Pins:
    //!   1. The 32-B viewing_pub_hash lands at the start of the inner
    //!      action_payload byte-for-byte (so the adapter's
    //!      `decode_per_user_payload` recovers it equal to what the prover
    //!      bound).
    //!   2. The u32 length prefix is bumped by exactly +32.
    //!   3. The discriminator + in_amount + min_out + trailing bytes are
    //!      preserved unchanged.
    //!   4. Malformed inputs (too short, bad length prefix) error cleanly
    //!      with `InvalidInstructionData` instead of panicking.
    //!   5. The Kamino adapter program ID is recognised as stateful;
    //!      arbitrary other program IDs are not.
    use super::*;

    fn build_adapter_ix_data(in_amount: u64, min_out: u64, payload: &[u8]) -> Vec<u8> {
        // Mirrors examples/kamino-adapter-fork-deposit.ts and
        // packages/sdk/src/b402.ts:911 default builder.
        const EXECUTE_DISC: [u8; 8] = [130, 221, 242, 154, 13, 193, 189, 29];
        let mut out = Vec::with_capacity(8 + 8 + 8 + 4 + payload.len());
        out.extend_from_slice(&EXECUTE_DISC);
        out.extend_from_slice(&in_amount.to_le_bytes());
        out.extend_from_slice(&min_out.to_le_bytes());
        out.extend_from_slice(&(payload.len() as u32).to_le_bytes());
        out.extend_from_slice(payload);
        out
    }

    #[test]
    fn prepend_inserts_hash_and_bumps_length() {
        let original_payload: Vec<u8> = (0..49u8).collect(); // 49 B (KaminoAction::Deposit size).
        let raw = build_adapter_ix_data(1_000_000, 950_000, &original_payload);
        let h: [u8; 32] = [0xA1; 32];

        let out = prepend_viewing_pub_hash_to_action_payload(&raw, &h).unwrap();

        // Length prefix bumped by +32.
        let new_len = u32::from_le_bytes(out[24..28].try_into().unwrap()) as usize;
        assert_eq!(new_len, original_payload.len() + 32);

        // Hash is byte-equal at offset 28..60.
        assert_eq!(&out[28..60], &h);

        // Original payload follows verbatim.
        assert_eq!(&out[60..], original_payload.as_slice());

        // Disc + in_amount + min_out untouched.
        assert_eq!(&out[..24], &raw[..24]);

        // Total grew by exactly 32.
        assert_eq!(out.len(), raw.len() + 32);
    }

    #[test]
    fn prepend_preserves_empty_payload_case() {
        let raw = build_adapter_ix_data(1, 0, &[]);
        let h: [u8; 32] = [0xBB; 32];
        let out = prepend_viewing_pub_hash_to_action_payload(&raw, &h).unwrap();
        assert_eq!(u32::from_le_bytes(out[24..28].try_into().unwrap()), 32);
        assert_eq!(&out[28..60], &h);
        assert_eq!(out.len(), raw.len() + 32);
    }

    #[test]
    fn prepend_rejects_short_input() {
        // Just the 8-B disc — way short of the 28-B minimum.
        let raw = vec![0u8; 8];
        let h = [0u8; 32];
        assert!(prepend_viewing_pub_hash_to_action_payload(&raw, &h).is_err());
    }

    #[test]
    fn prepend_rejects_truncated_payload() {
        // Length prefix says payload is 100 B, but only 10 B follow.
        let mut raw = vec![0u8; 24]; // disc + in + out
        raw.extend_from_slice(&100u32.to_le_bytes());
        raw.extend_from_slice(&[0u8; 10]);
        let h = [0u8; 32];
        assert!(prepend_viewing_pub_hash_to_action_payload(&raw, &h).is_err());
    }

    #[test]
    fn kamino_adapter_id_is_stateful() {
        let kamino: Pubkey =
            anchor_lang::pubkey!("2enwFgcGKJDqruHpCtvmhtxe3DYcV3k72VTvoGcdt2rX");
        assert!(is_stateful_adapter(&kamino));
    }

    #[test]
    fn arbitrary_adapter_id_is_not_stateful() {
        // The Jupiter adapter ID — stateless.
        let arbitrary = Pubkey::new_unique();
        assert!(!is_stateful_adapter(&arbitrary));
    }

    #[test]
    fn round_trip_through_kamino_decoder_recovers_hash() {
        // End-to-end: build adapter ix data, prepend, then verify the
        // kamino-adapter-side decoder (replicated here as a standalone
        // step) extracts the same hash. Catches subtle layout drift
        // (e.g. wrong length-prefix endianness) without needing to load
        // the kamino adapter as a workspace dep.
        let inner_action: Vec<u8> = (0..49u8).collect();
        let raw = build_adapter_ix_data(123, 0, &inner_action);
        let h: [u8; 32] = [0x33; 32];
        let rewritten = prepend_viewing_pub_hash_to_action_payload(&raw, &h).unwrap();

        // Replicate kamino_adapter::decode_per_user_payload's prefix
        // extraction. The adapter sees its own action_payload field
        // (which, post-rewrite, starts with the 32-B hash followed by
        // the original KaminoAction borsh).
        let new_len =
            u32::from_le_bytes(rewritten[24..28].try_into().unwrap()) as usize;
        let action_payload = &rewritten[28..28 + new_len];
        assert!(action_payload.len() > 32);
        let recovered_hash: [u8; 32] = action_payload[..32].try_into().unwrap();
        assert_eq!(recovered_hash, h);
        assert_eq!(&action_payload[32..], inner_action.as_slice());
    }
}

#[cfg(test)]
mod excess_parity_tests {
    //! Phase 9 dual-note minting — Rust ↔ TS parity.
    //!
    //! Frozen fixture matches `tests/v2/integration/dual_note_vector.test.ts`.
    //! Both files must agree on `EXPECTED_COMMITMENT_B_HEX` after the first
    //! run; if they diverge, the SDK and pool will mint commitments that
    //! the user's wallet cannot recompute → the excess leaf becomes
    //! unspendable. Treat any drift as a P0 bug.
    use super::*;
    use crate::constants::{TAG_COMMIT, TAG_EXCESS};
    use anchor_lang::solana_program::poseidon::{hashv, Endianness, Parameters};
    use std::convert::TryInto;
    fn hex_to_le32(hex: &str) -> [u8; 32] {
        // Decode without pulling in a hex crate dependency. 64-char input.
        assert_eq!(hex.len(), 64, "expected 32-byte hex");
        let mut out = [0u8; 32];
        for i in 0..32 {
            let byte = u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16).unwrap();
            out[i] = byte;
        }
        out
    }
    fn bigint_le32(hi: u64, b: u64, c: u64, lo: u64) -> [u8; 32] {
        // Pack four u64 limbs (BIG-endian conceptually: hi is the most
        // significant) into a 32-byte little-endian buffer. The TS fixture
        // uses 0x_aabbccdd... literals which big-int interpretation builds
        // most-significant-first; we mirror that here.
        let mut out = [0u8; 32];
        out[0..8].copy_from_slice(&lo.to_le_bytes());
        out[8..16].copy_from_slice(&c.to_le_bytes());
        out[16..24].copy_from_slice(&b.to_le_bytes());
        out[24..32].copy_from_slice(&hi.to_le_bytes());
        out
    }
    /// Frozen fixture — keep in lockstep with `dual_note_vector.test.ts`.
    /// All four bigints fit < BN254 Fr modulus (top byte ≤ 0x2A).
    fn fixture() -> ([u8; 32], [u8; 32], [u8; 32], u64) {
        // commitmentA = 0x1122334455667788_99aabbccddeeff00_1122334455667788_99aabbccddeeff00
        let commitment_a = bigint_le32(
            0x1122_3344_5566_7788,
            0x99aa_bbcc_ddee_ff00,
            0x1122_3344_5566_7788,
            0x99aa_bbcc_ddee_ff00,
        );
        // outMintFr = 0x0102030405060708_090a0b0c0d0e0f10_1112131415161718_191a1b1c1d1e1f20
        let out_mint_fr = bigint_le32(
            0x0102_0304_0506_0708,
            0x090a_0b0c_0d0e_0f10,
            0x1112_1314_1516_1718,
            0x191a_1b1c_1d1e_1f20,
        );
        // spendingPub = 0x2a2b2c2d2e2f3031_3233343536373839_3a3b3c3d3e3f4041_4243444546474849
        let spending_pub = bigint_le32(
            0x2a2b_2c2d_2e2f_3031,
            0x3233_3435_3637_3839,
            0x3a3b_3c3d_3e3f_4041,
            0x4243_4445_4647_4849,
        );
        let excess: u64 = 1_234_567;
        (commitment_a, out_mint_fr, spending_pub, excess)
    }
    fn compute_random_b(commitment_a: &[u8; 32]) -> [u8; 32] {
        // Tag-first — must match the production handler at line ~616 and the
        // SDK's deriveExcessRandom (poseidonTagged('excess', commitmentA)).
        hashv(
            Parameters::Bn254X5,
            Endianness::LittleEndian,
            &[&TAG_EXCESS[..], &commitment_a[..]],
        )
        .unwrap()
        .to_bytes()
    }
    fn compute_commitment_b(
        out_mint_fr: &[u8; 32],
        excess: u64,
        random_b: &[u8; 32],
        spending_pub: &[u8; 32],
    ) -> [u8; 32] {
        let value_fr = u64_to_fr_le(excess);
        hashv(
            Parameters::Bn254X5,
            Endianness::LittleEndian,
            &[
                &TAG_COMMIT[..],
                &out_mint_fr[..],
                &value_fr[..],
                &random_b[..],
                &spending_pub[..],
            ],
        )
        .unwrap()
        .to_bytes()
    }
    /// Pinned LE-hex commitment_b for the frozen fixture, generated against
    /// the tag-first Poseidon ordering. Verified bit-equal between SDK
    /// (circomlibjs) and on-chain hashv (light-poseidon). Update both this
    /// file AND `tests/v2/integration/dual_note_vector.test.ts` at the
    /// same time, never one without the other.
    const EXPECTED_COMMITMENT_B_HEX: &str =
        "e7c90af0bf88c9e1ceb3ed40a4f9151982b38b4b61d34b6bcec5a55aab472315";
    #[test]
    fn commitment_b_is_deterministic() {
        let (commitment_a, out_mint_fr, spending_pub, excess) = fixture();
        let r1 = compute_random_b(&commitment_a);
        let r2 = compute_random_b(&commitment_a);
        assert_eq!(r1, r2);
        let c1 = compute_commitment_b(&out_mint_fr, excess, &r1, &spending_pub);
        let c2 = compute_commitment_b(&out_mint_fr, excess, &r2, &spending_pub);
        assert_eq!(c1, c2);
    }
    #[test]
    fn commitment_b_matches_pinned_vector() {
        let (commitment_a, out_mint_fr, spending_pub, excess) = fixture();
        let random_b = compute_random_b(&commitment_a);
        let commitment_b =
            compute_commitment_b(&out_mint_fr, excess, &random_b, &spending_pub);
        let actual_hex = commitment_b
            .iter()
            .map(|b| format!("{:02x}", b))
            .collect::<String>();
        if EXPECTED_COMMITMENT_B_HEX.is_empty() {
            panic!(
                "EXPECTED_COMMITMENT_B_HEX not yet pinned. Set it (here AND \
                 in tests/v2/integration/dual_note_vector.test.ts) to: \"{}\"",
                actual_hex
            );
        }
        let expected: [u8; 32] = hex_to_le32(EXPECTED_COMMITMENT_B_HEX);
        assert_eq!(
            commitment_b, expected,
            "Rust commitment_b drifted from pinned TS value. Hex: {}",
            actual_hex
        );
    }
    #[test]
    fn random_b_changes_with_commitment_a() {
        let (mut commitment_a, _, _, _) = fixture();
        let r_orig = compute_random_b(&commitment_a);
        // Flip one bit in commitment_a.
        commitment_a[0] ^= 0x01;
        let r_perturbed = compute_random_b(&commitment_a);
        assert_ne!(r_orig, r_perturbed);
    }
    /// Make sure `try_into` is reachable in this scope (avoids dead-code lint
    /// when the helpers above are inlined).
    #[test]
    fn _smoke_imports() {
        let arr: [u8; 4] = [1, 2, 3, 4];
        let _: [u8; 4] = arr.as_slice().try_into().unwrap();
    }
}

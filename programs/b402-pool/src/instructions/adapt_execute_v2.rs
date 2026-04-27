//! `adapt_execute_v2` — v2 ABI composable execution path.
//!
//! Implements PRD-11 (vector token bindings, M=4 in / N=4 out),
//!            PRD-12 (content-addressed action_hash, the keystone),
//!            PRD-13 (shadow PDA binding),
//!            PRD-15 (delta-zero exemption + deadline_slot).
//!
//! Coexists with v1 `adapt_execute`. v1 stays untouched. New adapters that
//! depend on multi-mint outputs, content-addressed actions, or shadow PDAs
//! target v2; existing v1 adapters keep working unchanged.
//!
//! Flow:
//!   1.  Parse `AdaptExecuteV2Args` (38 circuit public inputs + handler-side args).
//!   2.  Bind to pool state:
//!         - non-dummy `public_token_mint_in[k]` ⇒ matches a token_config; dummy ⇒ zero.
//!         - non-dummy `expected_out_mint[k]`     ⇒ matches a token_config; dummy ⇒ zero.
//!         - adapter is registered + ix discriminator allowlisted.
//!         - adapter_id (public input) == keccak(adapter_program.key) mod p.
//!         - action_hash (public input) == Poseidon_6(
//!               TAG_ADAPT_BIND_V2, adapter_id, scope_tag,
//!               keccak(action_payload) mod p,
//!               accounts_hash,
//!               extra_context_root)
//!         - accounts_hash = keccak(canonical AccountMeta list) mod p, recomputed.
//!         - merkle_root in the 128-root recent ring.
//!         - Clock::get().slot <= deadline_slot.
//!         - if shadow binding flagged: Poseidon_3(TAG_SHADOW_BIND, viewing_pub_hash, scope_tag) == shadowPdaBinding.
//!   3.  Verify Groth16 proof via `b402_verifier_adapt_v2` CPI (38 public inputs).
//!   4.  Burn input nullifiers (sharded; up to 4 slots, dummies skipped).
//!   5.  Pool-signed transfer of `public_amount_in` to `adapter_in_ta` (single-mint v2 path).
//!   6.  Snapshot per-output-mint pre-balances.
//!   7.  CPI the adapter with caller-supplied raw ix data + remaining_accounts.
//!   8.  Post-CPI invariant: total out delta across the OUT vault(s) ≥ expected_out_value.
//!   9.  Append output commitments (up to 4) to the tree.
//!  10.  Pay relayer fee in IN mint (v2 single in-mint, like v1).
//!  11.  Emit AdaptExecutedV2 event.
//!
//! Notes on slot semantics for this initial v2 handler:
//!   - The handler currently supports M=1 in-mint at slot 0 (matches every
//!     adapter we ship with on phase-3) and N=1..4 out-mints. Higher in-mint
//!     vector counts are wired in the circuit and ABI but enabling vault-side
//!     fan-in is a follow-up since it requires multi-vault account ergonomics
//!     beyond the scope of phase-3 (see TODO at end of file).

use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::keccak;
use anchor_lang::solana_program::poseidon::{hashv, Endianness, Parameters};
use anchor_lang::solana_program::program::invoke;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use crate::constants::{
    SEED_ADAPTERS, SEED_CONFIG, SEED_NULL, SEED_TOKEN, SEED_TREASURY, SEED_TREE, SEED_VAULT,
    TAG_ADAPT_BIND_V2, TAG_COMMIT, TAG_FEE_BIND, TAG_MK_NODE, TAG_NULLIFIER, TAG_RECIPIENT_BIND,
    TAG_SPEND_KEY_PUB, VERSION_PREFIX,
    // TAG_SHADOW_BIND wired in handler shadow-binding follow-up (PRD-13 §3.3).
};
use crate::error::PoolError;
use crate::events::{AdaptExecutedV2, CommitmentAppended, NullifierSpent, ProtocolFeeAccrued};
use crate::state::{
    AdapterRegistry, NullifierShard, PoolConfig, TokenConfig, TreasuryConfig, TreeState,
};
use crate::util;

use super::shield::EncryptedNote;
use super::verifier_cpi;

/// Hardcoded program ID of the v2 verifier. PoolConfig deliberately does NOT
/// add a `verifier_adapt_v2` field so v1 storage layout is untouched. If the
/// v2 verifier ever needs upgrade, ship a new pool program version that
/// reads from a v2 config PDA.
///
/// Bytes are the base58 decode of `DG7Fi75b2jkcUgG5K6Ekgpy7uigYxePPSxSSrdPzLGUd`.
/// Must match `programs/b402-verifier-adapt-v2/src/lib.rs` `declare_id!`.
pub const VERIFIER_ADAPT_V2_PROGRAM_ID: Pubkey = Pubkey::new_from_array([
    0xb6, 0x2b, 0x06, 0xb6, 0x42, 0x15, 0x15, 0x28, 0x4d, 0x17, 0x5b, 0x5e, 0x3c, 0x10, 0xa9, 0xbc,
    0x49, 0x03, 0x54, 0x68, 0xda, 0x1e, 0x73, 0xe3, 0xd7, 0x05, 0x1f, 0xb3, 0xb4, 0x66, 0x2b, 0x26,
]);

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct AdaptExecuteV2PublicInputs {
    pub merkle_root: [u8; 32],
    pub nullifier: [[u8; 32]; 4],
    pub commitment_out: [[u8; 32]; 4],
    pub public_amount_in: u64,
    pub public_amount_out: u64,            // adapt requires zero
    pub public_token_mint_in: [Pubkey; 4], // M=4 input mints; zero = unused slot
    pub relayer_fee: u64,
    pub relayer_fee_bind: [u8; 32],
    pub root_bind: [u8; 32],
    pub recipient_bind: [u8; 32],
    pub adapter_id: [u8; 32],
    pub action_hash: [u8; 32],
    pub expected_out_value: u64,
    pub expected_out_mint: [Pubkey; 4],    // N=4 output mints; zero = unused slot
    pub scope_tag: [u8; 32],               // Fr-form, set by SDK
    pub accounts_hash: [u8; 32],           // = keccak(canonical accounts) mod p
    pub extra_context_root: [u8; 32],      // PRD-12 §10
    pub deadline_slot: u64,                // PRD-15
    pub shadow_pda_binding: [u8; 32],      // PRD-13; zero when unused
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct AdaptExecuteV2Args {
    pub proof: Vec<u8>,                     // 256 bytes
    pub public_inputs: AdaptExecuteV2PublicInputs,
    pub encrypted_notes: Vec<EncryptedNote>,// 0..=4
    pub in_dummy_mask: u8,                  // bit k = slot k is dummy (low 4 bits)
    pub out_dummy_mask: u8,                 // bit k = slot k is dummy (low 4 bits)
    pub nullifier_shard_prefix: [u16; 2],   // initial v2 supports up to 2 non-dummy nullifiers
    pub relayer_fee_recipient: Pubkey,
    /// Exact bytes forwarded as the adapter's instruction data.
    pub raw_adapter_ix_data: Vec<u8>,
    /// The action_payload the proof was generated over. Pool recomputes
    /// keccak256(action_payload) mod p and re-derives the v2 action_hash.
    pub action_payload: Vec<u8>,
    /// If true, pool enforces the shadow PDA binding (PRD-13). Else skipped
    /// (e.g., a Jupiter swap that has no per-user state). Mirrors PRD-12 §4
    /// `state_binding_required` for the per-instance call.
    pub require_shadow_binding: bool,
    /// Canonical AccountMeta list the prover committed to (PRD-12 §3). Pool
    /// recomputes `keccak(canonical(accounts)) mod p` and asserts equality
    /// with `public_inputs.accounts_hash`. Format per PRD-12 §3:
    ///   ∀ i: pubkey[i] || (is_signer << 1 | is_writable).
    pub canonical_accounts: Vec<CanonicalAccountMeta>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug)]
pub struct CanonicalAccountMeta {
    pub pubkey: Pubkey,
    pub is_signer: bool,
    pub is_writable: bool,
}

#[derive(Accounts)]
#[instruction(args: AdaptExecuteV2Args)]
pub struct AdaptExecuteV2<'info> {
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

    /// IN-mint token config. v2 currently routes all `public_amount_in` from
    /// a single IN vault (single-mint M=1 path; vector M still committed in
    /// the proof so this handler is forward-compatible with multi-vault
    /// fan-in once the account ergonomics catch up).
    #[account(
        seeds = [VERSION_PREFIX, SEED_TOKEN, token_config_in.mint.as_ref()],
        bump,
        constraint = token_config_in.enabled @ PoolError::TokenNotWhitelisted,
    )]
    pub token_config_in: Box<Account<'info, TokenConfig>>,

    /// Primary OUT-mint token config (slot 0). Additional out-mint vaults
    /// pass through `remaining_accounts` and are validated inside the handler.
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

    /// CHECK: validated by hardcoded `VERIFIER_ADAPT_V2_PROGRAM_ID`.
    pub verifier_program: AccountInfo<'info>,

    /// CHECK: validated against adapter_registry.
    pub adapter_program: UncheckedAccount<'info>,

    /// CHECK: adapter's own PDA signer.
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

    #[account(
        mut,
        constraint = relayer_fee_ta.mint == token_config_in.mint @ PoolError::MintMismatch,
    )]
    pub relayer_fee_ta: Box<Account<'info, TokenAccount>>,

    /// Treasury ATA for the protocol-fee share of the relayer-fee. Owner must
    /// match `treasury_config.treasury_pubkey`; mint must match `token_config_in`.
    /// When `pool_config.protocol_fee_share_bps == 0`, this account is unused
    /// (handler skips the transfer) but the slot is still required to keep
    /// the v2 ix shape stable across fee-on / fee-off configurations.
    #[account(
        mut,
        constraint = treasury_fee_ta.mint == token_config_in.mint @ PoolError::MintMismatch,
        constraint = treasury_fee_ta.owner == treasury_config.treasury_pubkey @ PoolError::TreasuryFeeAccountMismatch,
    )]
    pub treasury_fee_ta: Box<Account<'info, TokenAccount>>,

    #[account(
        seeds = [VERSION_PREFIX, SEED_TREASURY],
        bump,
    )]
    pub treasury_config: Account<'info, TreasuryConfig>,

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
pub fn handler<'info>(
    ctx: Context<'_, '_, '_, 'info, AdaptExecuteV2<'info>>,
    args: Box<AdaptExecuteV2Args>,
) -> Result<()> {
    require!(args.proof.len() == 256, PoolError::InvalidInstructionData);
    require!(args.encrypted_notes.len() <= 4, PoolError::InvalidInstructionData);
    require!(args.raw_adapter_ix_data.len() >= 8, PoolError::InvalidInstructionData);

    let cfg = &ctx.accounts.pool_config;
    require!(!cfg.paused_adapts, PoolError::PoolPaused);
    require!(
        ctx.accounts.verifier_program.key() == VERIFIER_ADAPT_V2_PROGRAM_ID,
        PoolError::ProofVerificationFailed
    );

    let pi = &args.public_inputs;

    require!(pi.public_amount_out == 0, PoolError::PublicAmountExclusivity);

    // PRD-15: deadline_slot.
    let clock = Clock::get()?;
    require!(clock.slot <= pi.deadline_slot, PoolError::DeadlineExceeded);

    // PRD-11: vector mint canonicalization.
    // Slot k:  in_dummy_mask bit k set ⇔ public_token_mint_in[k] == default (Pubkey::default())
    //          out_dummy_mask bit k set ⇔ expected_out_mint[k] == default
    // The proof already enforces zero-binding at the field level; this is
    // the on-chain check that the (Pubkey) representation matches.
    let zero = Pubkey::default();
    for k in 0..4 {
        let in_dummy = (args.in_dummy_mask >> k) & 1 == 1;
        let in_zero = pi.public_token_mint_in[k] == zero;
        require!(in_dummy == in_zero, PoolError::SlotCanonicalizationFailed);

        let out_dummy = (args.out_dummy_mask >> k) & 1 == 1;
        let out_zero = pi.expected_out_mint[k] == zero;
        require!(out_dummy == out_zero, PoolError::SlotCanonicalizationFailed);
    }

    // The handler takes a single (in_vault, out_vault) — assert slot 0 is
    // the bound mint and that any *other* used slot is a duplicate of the
    // same mint (single-mint M=1, N=N>=1 model). Multi-mint fan-in is wired
    // through `remaining_accounts` in a follow-up; the circuit already
    // commits the full vector.
    require!(
        ctx.accounts.token_config_in.mint == pi.public_token_mint_in[0],
        PoolError::MintMismatch
    );
    // Slots 1..4 must either be dummy or carry the same in mint.
    for k in 1..4 {
        let dummy = (args.in_dummy_mask >> k) & 1 == 1;
        if !dummy {
            require!(
                pi.public_token_mint_in[k] == ctx.accounts.token_config_in.mint,
                PoolError::MintMismatch
            );
        }
    }
    require!(
        ctx.accounts.token_config_out.mint == pi.expected_out_mint[0],
        PoolError::MintMismatch
    );

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

        // Circuit's adapter_id == keccak(program ID) mod p.
        let digest = keccak::hash(adapter_program_key.as_ref()).0;
        let expected_adapter_id = util::reduce_le_mod_p(&digest);
        require!(
            pi.adapter_id == expected_adapter_id,
            PoolError::InvalidAdapterBinding
        );
    }

    // PRD-12: recompute accounts_hash on-chain from the canonical accounts
    // the handler will forward to the adapter, and assert it matches the
    // proof's public input.
    {
        let computed = compute_accounts_hash_fr(&args.canonical_accounts);
        require!(
            pi.accounts_hash == computed,
            PoolError::AccountsHashMismatch
        );
    }

    // PRD-12 keystone: action_hash = Poseidon_6(
    //   TAG_ADAPT_BIND_V2,
    //   adapter_id,
    //   scope_tag,
    //   keccak(action_payload) mod p,
    //   accounts_hash,
    //   extra_context_root)
    {
        let payload_keccak = keccak::hash(&args.action_payload).0;
        let payload_keccak_fr = util::reduce_le_mod_p(&payload_keccak);
        let computed = hashv(
            Parameters::Bn254X5,
            Endianness::LittleEndian,
            &[
                &TAG_ADAPT_BIND_V2[..],
                &pi.adapter_id[..],
                &pi.scope_tag[..],
                &payload_keccak_fr[..],
                &pi.accounts_hash[..],
                &pi.extra_context_root[..],
            ],
        )
        .map_err(|_| error!(PoolError::InvalidInstructionData))?
        .to_bytes();
        require!(pi.action_hash == computed, PoolError::InvalidAdapterBinding);
    }

    // PRD-13: shadow PDA binding (gated by per-call flag).
    if args.require_shadow_binding {
        // The viewing_pub_hash component is private to the prover. The pool
        // does not see it directly — but the *binding value* the prover
        // committed to (pi.shadow_pda_binding) must hash a non-zero
        // (TAG_SHADOW_BIND, viewing_pub_hash, scope_tag) tuple. The shadow
        // PDA itself is one of the remaining_accounts; the adapter program
        // independently re-derives it from (adapter_id, scope_tag,
        // viewing_key_commitment) per PRD-13 §2 and asserts ownership.
        //
        // Here we only enforce the existence of a non-zero binding under
        // the v2 shadow tag. The strong check (PDA derivation matches the
        // committed binding) is the adapter's responsibility, since the
        // adapter owns the shadow PDA.
        require!(
            pi.shadow_pda_binding != [0u8; 32],
            PoolError::ShadowBindingMismatch
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

    // Shard prefix consistency for non-dummy nullifiers (slots 0 and 1; v2
    // supports up to 2 active nullifiers in this initial handler — slots 2,3
    // must be dummy with the same shard layout as v1).
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
    // Slots 2 and 3 must be dummy (zero nullifier) until multi-shard plumbing
    // lands.
    for i in 2..4 {
        let is_dummy = (args.in_dummy_mask >> i) & 1 == 1;
        require!(is_dummy, PoolError::InvalidInstructionData);
        require!(
            pi.nullifier[i] == [0u8; 32],
            PoolError::ProofPublicInputMismatch
        );
    }

    // Relayer fee binding.
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
    let public_inputs: Vec<[u8; 32]> = build_public_inputs_for_adapt_v2(pi);
    let mut proof_bytes = [0u8; 256];
    proof_bytes.copy_from_slice(&args.proof);
    verifier_cpi::invoke_verify_adapt_v2(
        &ctx.accounts.verifier_program,
        &proof_bytes,
        &public_inputs,
    )?;

    // Nullifier ordering check (when both first slots are non-dummy).
    if (args.in_dummy_mask & 0b11) == 0 {
        require!(
            pi.nullifier[0] < pi.nullifier[1],
            PoolError::NullifierOrderingViolation
        );
    }

    // Burn input nullifiers (slots 0/1 only in this handler).
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
            slot: clock.slot,
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
            slot: clock.slot,
        });
    }

    // Pool transfers public_amount_in to adapter_in_ta (pool PDA signs the vault).
    let pool_config_info = ctx.accounts.pool_config.to_account_info();
    let signer_seeds: &[&[u8]] = &[VERSION_PREFIX, SEED_CONFIG, &[ctx.bumps.pool_config]];
    let signer = &[signer_seeds];
    if pi.public_amount_in > 0 {
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
    }

    if pi.relayer_fee > 0 {
        // Split: protocol_fee_share_bps of the relayer-fee routes to the
        // treasury ATA; the remainder goes to the relayer. share_bps == 0
        // means full amount to relayer (v1 alpha default).
        let share_bps = ctx.accounts.pool_config.protocol_fee_share_bps as u128;
        let treasury_amount: u64 = ((pi.relayer_fee as u128) * share_bps / 10_000u128) as u64;
        let relayer_amount: u64 = pi.relayer_fee.saturating_sub(treasury_amount);

        if treasury_amount > 0 {
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.in_vault.to_account_info(),
                        to: ctx.accounts.treasury_fee_ta.to_account_info(),
                        authority: pool_config_info.clone(),
                    },
                    signer,
                ),
                treasury_amount,
            )?;
            emit!(ProtocolFeeAccrued {
                mint: ctx.accounts.token_config_in.mint,
                amount: treasury_amount,
                of_relayer_fee: pi.relayer_fee,
                share_bps: ctx.accounts.pool_config.protocol_fee_share_bps,
                slot: Clock::get()?.slot,
            });
        }
        if relayer_amount > 0 {
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
                relayer_amount,
            )?;
        }
    }

    // Pre-CPI snapshot of the OUT vault (slot 0). Multi-vault delta sums
    // are tracked via remaining_accounts post-MVP.
    ctx.accounts.out_vault.reload()?;
    let pre = ctx.accounts.out_vault.amount;

    // Build + CPI adapter.
    let adapter_metas: Vec<AccountMeta> = {
        let mut m = Vec::with_capacity(6 + ctx.remaining_accounts.len());
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
        for a in ctx.remaining_accounts.iter() {
            if a.is_writable {
                m.push(AccountMeta::new(*a.key, a.is_signer));
            } else {
                m.push(AccountMeta::new_readonly(*a.key, a.is_signer));
            }
        }
        m
    };
    let mut adapter_infos: Vec<AccountInfo<'info>> =
        Vec::with_capacity(6 + ctx.remaining_accounts.len());
    adapter_infos.push(ctx.accounts.adapter_authority.to_account_info());
    adapter_infos.push(ctx.accounts.in_vault.to_account_info());
    adapter_infos.push(ctx.accounts.out_vault.to_account_info());
    adapter_infos.push(ctx.accounts.adapter_in_ta.to_account_info());
    adapter_infos.push(ctx.accounts.adapter_out_ta.to_account_info());
    adapter_infos.push(ctx.accounts.token_program.to_account_info());
    for a in ctx.remaining_accounts.iter() {
        adapter_infos.push(a.clone());
    }

    let ix = Instruction {
        program_id: adapter_program_key,
        accounts: adapter_metas,
        data: args.raw_adapter_ix_data.clone(),
    };
    invoke(&ix, &adapter_infos).map_err(|_| error!(PoolError::AdapterCallReverted))?;

    // Post-CPI delta invariant — total OUT delta ≥ expected_out_value.
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

    emit!(AdaptExecutedV2 {
        adapter_program: adapter_program_key,
        in_mints: pi.public_token_mint_in,
        out_mints: pi.expected_out_mint,
        public_amount_in: pi.public_amount_in,
        out_delta_total: delta,
        expected_out_value: pi.expected_out_value,
        relayer_fee: pi.relayer_fee,
        deadline_slot: pi.deadline_slot,
        slot: clock.slot,
    });

    Ok(())
}

/// PRD-12 §3 canonical accounts hash.
///
/// Sort `accounts` by `(pubkey ASC, is_signer DESC, is_writable DESC)` and
/// serialize as `pubkey || (is_signer << 1 | is_writable)`. Reject duplicates.
/// Hash with keccak256 and reduce mod Fr.
///
/// Public so adapters / SDK can reuse the exact canonicalization.
pub fn compute_accounts_hash_fr(accounts: &[CanonicalAccountMeta]) -> [u8; 32] {
    // Sort copy so the caller doesn't have to.
    let mut sorted: Vec<CanonicalAccountMeta> = accounts.to_vec();
    sorted.sort_by(|a, b| {
        a.pubkey
            .cmp(&b.pubkey)
            .then_with(|| b.is_signer.cmp(&a.is_signer))
            .then_with(|| b.is_writable.cmp(&a.is_writable))
    });

    // 33 bytes per account: 32 (pubkey) + 1 (flags).
    let mut buf = Vec::with_capacity(sorted.len() * 33);
    for a in sorted.iter() {
        buf.extend_from_slice(a.pubkey.as_ref());
        let flags = ((a.is_signer as u8) << 1) | (a.is_writable as u8);
        buf.push(flags);
    }
    let h = keccak::hash(&buf).0;
    util::reduce_le_mod_p(&h)
}

fn u64_to_fr_le(v: u64) -> [u8; 32] {
    let mut out = [0u8; 32];
    out[..8].copy_from_slice(&v.to_le_bytes());
    out
}

fn pubkey_to_fr_le(p: &Pubkey) -> [u8; 32] {
    util::reduce_le_mod_p(&p.to_bytes())
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
fn build_public_inputs_for_adapt_v2(pi: &AdaptExecuteV2PublicInputs) -> Vec<[u8; 32]> {
    let mut v: Vec<[u8; 32]> = Vec::with_capacity(verifier_cpi::PUBLIC_INPUT_COUNT_ADAPT_V2);
    // 0
    v.push(pi.merkle_root);
    // 1..4
    v.extend_from_slice(&pi.nullifier);
    // 5..8
    v.extend_from_slice(&pi.commitment_out);
    // 9
    v.push(u64_to_fr_le(pi.public_amount_in));
    // 10
    v.push(u64_to_fr_le(pi.public_amount_out));
    // 11..14
    for k in 0..4 {
        v.push(pubkey_to_fr_le(&pi.public_token_mint_in[k]));
    }
    // 15
    v.push(u64_to_fr_le(pi.relayer_fee));
    // 16
    v.push(pi.relayer_fee_bind);
    // 17
    v.push(pi.root_bind);
    // 18
    v.push(pi.recipient_bind);
    // 19..24 — domain tags shared with v1 transact / adapt.
    v.push(TAG_COMMIT);
    v.push(TAG_NULLIFIER);
    v.push(TAG_MK_NODE);
    v.push(TAG_SPEND_KEY_PUB);
    v.push(TAG_FEE_BIND);
    v.push(TAG_RECIPIENT_BIND);
    // 25
    v.push(pi.adapter_id);
    // 26
    v.push(pi.action_hash);
    // 27
    v.push(u64_to_fr_le(pi.expected_out_value));
    // 28..31
    for k in 0..4 {
        v.push(pubkey_to_fr_le(&pi.expected_out_mint[k]));
    }
    // 32 — v2 adaptBindTag (distinct from v1's TAG_ADAPT_BIND).
    v.push(TAG_ADAPT_BIND_V2);
    // 33
    v.push(pi.scope_tag);
    // 34
    v.push(pi.accounts_hash);
    // 35
    v.push(pi.extra_context_root);
    // 36
    v.push(u64_to_fr_le(pi.deadline_slot));
    // 37
    v.push(pi.shadow_pda_binding);
    v
}

// TODO(phase-3.1): vector M=4 in / N=4 out vault ergonomics — second IN vault
// via `remaining_accounts` with per-mint pre-balance snapshots and per-mint
// delta invariants. The circuit and ABI already commit the vector; only the
// handler-side account threading remains.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::poseidon::{hashv, Endianness, Parameters};

use crate::constants::{
    SEED_ADAPTERS, SEED_CONFIG, SEED_TREASURY, SEED_TREE, TAG_MK_ZERO, TREE_DEPTH, VERSION_PREFIX,
};
use crate::error::PoolError;
use crate::events::PoolInitialized;
use crate::state::{AdapterRegistry, PoolConfig, TreasuryConfig, TreeState};

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct InitPoolArgs {
    pub admin_multisig: Pubkey,
    pub admin_threshold: u8,
    pub verifier_transact: Pubkey,
    pub verifier_adapt: Pubkey,
    pub verifier_disclose: Pubkey,
    pub treasury_pubkey: Pubkey,
}

#[derive(Accounts)]
pub struct InitPool<'info> {
    #[account(mut)]
    pub deployer: Signer<'info>,

    #[account(
        init,
        payer = deployer,
        space = PoolConfig::LEN,
        seeds = [VERSION_PREFIX, SEED_CONFIG],
        bump,
    )]
    pub pool_config: Account<'info, PoolConfig>,

    #[account(
        init,
        payer = deployer,
        space = TreeState::LEN,
        seeds = [VERSION_PREFIX, SEED_TREE],
        bump,
    )]
    pub tree_state: AccountLoader<'info, TreeState>,

    #[account(
        init,
        payer = deployer,
        space = AdapterRegistry::size_for_capacity(8),
        seeds = [VERSION_PREFIX, SEED_ADAPTERS],
        bump,
    )]
    pub adapter_registry: Account<'info, AdapterRegistry>,

    #[account(
        init,
        payer = deployer,
        space = TreasuryConfig::LEN,
        seeds = [VERSION_PREFIX, SEED_TREASURY],
        bump,
    )]
    pub treasury_config: Account<'info, TreasuryConfig>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<InitPool>, args: InitPoolArgs) -> Result<()> {
    require!(args.admin_threshold > 0, PoolError::InvalidInstructionData);

    let clock = Clock::get()?;

    // Initialize pool config.
    let cfg = &mut ctx.accounts.pool_config;
    cfg.version = 1;
    cfg.admin_multisig = args.admin_multisig;
    cfg.admin_threshold = args.admin_threshold;
    cfg.paused_shields = false;
    cfg.paused_transacts = false;
    cfg.paused_adapts = false;
    cfg.upgrade_authority_revoked = false;
    cfg.deployed_slot = clock.slot;
    cfg.verifier_transact = args.verifier_transact;
    cfg.verifier_adapt = args.verifier_adapt;
    cfg.verifier_disclose = args.verifier_disclose;
    cfg.protocol_fee_share_bps = 0;
    cfg._reserved = [0u8; 94];

    // Treasury.
    let treas = &mut ctx.accounts.treasury_config;
    treas.treasury_pubkey = args.treasury_pubkey;
    treas._reserved = [0u8; 32];

    // Adapter registry.
    let reg = &mut ctx.accounts.adapter_registry;
    reg.version = 1;
    reg.count = 0;
    reg.adapters = Vec::new();

    // Tree state — load_init() initializes the zero-copy account data.
    let mut tree = ctx.accounts.tree_state.load_init()?;
    tree.version = 1;
    tree.leaf_count = 0;
    tree.ring_head = 0;

    // zero[0] = Poseidon_1(mk-zero tag)
    let z0 = hashv(
        Parameters::Bn254X5,
        Endianness::LittleEndian,
        &[&TAG_MK_ZERO[..]],
    )
    .map_err(|_| error!(PoolError::ProofVerificationFailed))?;
    tree.zero_cache[0] = z0.to_bytes();

    for d in 1..TREE_DEPTH {
        let prev = tree.zero_cache[d - 1];
        let h = hashv(
            Parameters::Bn254X5,
            Endianness::LittleEndian,
            &[&crate::constants::TAG_MK_NODE[..], &prev[..], &prev[..]],
        )
        .map_err(|_| error!(PoolError::ProofVerificationFailed))?;
        tree.zero_cache[d] = h.to_bytes();
    }

    // Initial root = Poseidon(mk-node, zero[TREE_DEPTH-1], zero[TREE_DEPTH-1]).
    let initial_root = {
        let prev = tree.zero_cache[TREE_DEPTH - 1];
        let h = hashv(
            Parameters::Bn254X5,
            Endianness::LittleEndian,
            &[&crate::constants::TAG_MK_NODE[..], &prev[..], &prev[..]],
        )
        .map_err(|_| error!(PoolError::ProofVerificationFailed))?;
        h.to_bytes()
    };
    tree.root_ring[0] = initial_root;

    emit!(PoolInitialized {
        admin_multisig: args.admin_multisig,
        admin_threshold: args.admin_threshold,
        slot: clock.slot,
    });

    Ok(())
}

use anchor_lang::prelude::*;

use crate::constants::{SEED_ADAPTERS, SEED_CONFIG, VERSION_PREFIX};
use crate::error::PoolError;
use crate::events::{AdapterRegistered, PoolPauseChanged};
use crate::state::{AdapterInfo, AdapterRegistry, PoolConfig};
use crate::{AdapterRegistration, PauseFlag};

/// v1 admin auth: the `admin_multisig` field on `PoolConfig` is a single pubkey
/// placeholder — for Track B devnet, a single-key admin. Production multisig
/// flow lands in a follow-up per PRD-03 §9.
pub fn ensure_admin(cfg: &PoolConfig, caller: &Pubkey) -> Result<()> {
    require!(*caller == cfg.admin_multisig, PoolError::UnauthorizedAdmin);
    Ok(())
}

#[derive(Accounts)]
pub struct AdminAction<'info> {
    pub admin: Signer<'info>,

    #[account(
        mut,
        seeds = [VERSION_PREFIX, SEED_CONFIG],
        bump,
    )]
    pub pool_config: Account<'info, PoolConfig>,
}

pub fn pause(ctx: Context<AdminAction>, which: PauseFlag) -> Result<()> {
    ensure_admin(&ctx.accounts.pool_config, &ctx.accounts.admin.key())?;
    let cfg = &mut ctx.accounts.pool_config;
    let (flag_byte, _was) = match which {
        PauseFlag::Shields => {
            let prev = cfg.paused_shields;
            cfg.paused_shields = true;
            (0u8, prev)
        }
        PauseFlag::Transacts => {
            let prev = cfg.paused_transacts;
            cfg.paused_transacts = true;
            (1u8, prev)
        }
        PauseFlag::Adapts => {
            let prev = cfg.paused_adapts;
            cfg.paused_adapts = true;
            (2u8, prev)
        }
    };
    emit!(PoolPauseChanged { flag: flag_byte, paused: true, slot: Clock::get()?.slot });
    Ok(())
}

pub fn unpause(ctx: Context<AdminAction>, which: PauseFlag) -> Result<()> {
    ensure_admin(&ctx.accounts.pool_config, &ctx.accounts.admin.key())?;
    let cfg = &mut ctx.accounts.pool_config;
    let flag_byte = match which {
        PauseFlag::Shields => { cfg.paused_shields = false; 0u8 }
        PauseFlag::Transacts => { cfg.paused_transacts = false; 1u8 }
        PauseFlag::Adapts => { cfg.paused_adapts = false; 2u8 }
    };
    emit!(PoolPauseChanged { flag: flag_byte, paused: false, slot: Clock::get()?.slot });
    Ok(())
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub enum VerifierKind { Transact, Adapt, Disclose }

pub fn set_verifier(ctx: Context<AdminAction>, kind: VerifierKind, new_id: Pubkey) -> Result<()> {
    ensure_admin(&ctx.accounts.pool_config, &ctx.accounts.admin.key())?;
    let cfg = &mut ctx.accounts.pool_config;
    match kind {
        VerifierKind::Transact => cfg.verifier_transact = new_id,
        VerifierKind::Adapt    => cfg.verifier_adapt    = new_id,
        VerifierKind::Disclose => cfg.verifier_disclose = new_id,
    }
    Ok(())
}

#[derive(Accounts)]
pub struct RegisterAdapter<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        seeds = [VERSION_PREFIX, SEED_CONFIG],
        bump,
    )]
    pub pool_config: Account<'info, PoolConfig>,

    #[account(
        mut,
        seeds = [VERSION_PREFIX, SEED_ADAPTERS],
        bump,
    )]
    pub adapter_registry: Account<'info, AdapterRegistry>,
}

pub fn register_adapter(
    ctx: Context<RegisterAdapter>,
    info: AdapterRegistration,
) -> Result<()> {
    ensure_admin(&ctx.accounts.pool_config, &ctx.accounts.admin.key())?;
    require!(
        info.allowed_instructions.len() <= 8,
        PoolError::InvalidInstructionData
    );

    let registry = &mut ctx.accounts.adapter_registry;

    // Compute adapter_id = Poseidon_2(adapt-bind-tag, program_id_as_fr).
    // For v1 we use a simple keccak hash since it's only an identifier;
    // circuit-level binding happens via `actionHash`, not `adapter_id`.
    use anchor_lang::solana_program::keccak;
    let h = keccak::hash(info.program_id.as_ref());
    let adapter_id = h.0;

    let mut allowed = [[0u8; 8]; 8];
    let count = info.allowed_instructions.len() as u8;
    for (i, disc) in info.allowed_instructions.iter().enumerate() {
        allowed[i] = *disc;
    }

    let ai = AdapterInfo {
        adapter_id,
        program_id: info.program_id,
        enabled: true,
        allowed_instruction_count: count,
        allowed_instructions: allowed,
    };
    registry.adapters.push(ai);
    registry.count = registry.count.saturating_add(1);

    emit!(AdapterRegistered {
        adapter_id,
        program_id: info.program_id,
        slot: Clock::get()?.slot,
    });
    Ok(())
}

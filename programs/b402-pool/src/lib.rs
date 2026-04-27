//! b402_pool — the shielded pool program.
//!
//! Implements PRD-03. Owns pool state (tree, nullifier shards, adapter
//! registry), mediates CPIs to the verifier and adapters, and holds token
//! custody.
//!
//! Invariants (see PRD-04 §10 for the full list, enforced across handlers):
//! 1. No nullifier insertion without a successful verifier CPI prior in the
//!    same instruction.
//! 2. No vault transfer without balance conservation enforced by the proof.
//! 3. Unshield cannot be paused.
//! 4. Adapt CPIs are followed by a post-call balance-delta check.

use anchor_lang::prelude::*;

pub mod constants;
pub mod error;
pub mod events;
pub mod instructions;
pub mod state;
pub mod util;

use instructions::*;

declare_id!("42a3hsCXtQLWonyxWZosaaCJCweYYKMrvNd25p1Jrt2y");

#[program]
pub mod b402_pool {
    use super::*;

    pub fn init_pool(ctx: Context<InitPool>, args: InitPoolArgs) -> Result<()> {
        instructions::init_pool::handler(ctx, args)
    }

    pub fn add_token_config(ctx: Context<AddTokenConfig>) -> Result<()> {
        instructions::add_token_config::handler(ctx)
    }

    // Heavy fields inside ShieldArgs/TransactArgs/UnshieldArgs are `Vec<u8>`
    // (heap-allocated by Borsh) to keep the BPF stack frame below 4 KiB.
    // Handlers assert the expected lengths on entry.
    pub fn shield(ctx: Context<Shield>, args: ShieldArgs) -> Result<()> {
        instructions::shield::handler(ctx, args)
    }

    pub fn transact(ctx: Context<Transact>, args: TransactArgs) -> Result<()> {
        instructions::transact::handler(ctx, args)
    }

    pub fn unshield(ctx: Context<Unshield>, args: UnshieldArgs) -> Result<()> {
        instructions::unshield::handler(ctx, args)
    }

    pub fn pause(ctx: Context<AdminAction>, which: PauseFlag) -> Result<()> {
        instructions::admin::pause(ctx, which)
    }

    pub fn unpause(ctx: Context<AdminAction>, which: PauseFlag) -> Result<()> {
        instructions::admin::unpause(ctx, which)
    }

    pub fn set_verifier(
        ctx: Context<AdminAction>,
        kind: instructions::admin::VerifierKind,
        new_id: Pubkey,
    ) -> Result<()> {
        instructions::admin::set_verifier(ctx, kind, new_id)
    }

    pub fn register_adapter(
        ctx: Context<RegisterAdapter>,
        info: AdapterRegistration,
    ) -> Result<()> {
        instructions::admin::register_adapter(ctx, info)
    }

    /// TEST-ONLY: exercises the adapter balance-delta invariant without the
    /// full adapt_execute flow. See `instructions/adapt_mock.rs`.
    ///
    /// Dispatched only when compiled with `--features test-mock`. In a
    /// non-test build, calling this instruction returns an error immediately
    /// without executing the handler body — Anchor's instruction dispatcher
    /// enumerates all fns at macro-expansion time (before cfg is applied), so
    /// we can't simply omit the fn. The runtime check via `cfg!(feature = ...)`
    /// is optimized away by the compiler in both branches.
    pub fn check_adapter_delta_mock(
        ctx: Context<CheckAdapterDeltaMock>,
        args: CheckAdapterDeltaArgs,
    ) -> Result<()> {
        require!(
            cfg!(feature = "test-mock"),
            error::PoolError::InvalidInstructionData
        );
        instructions::adapt_mock::handler(ctx, args)
    }

    /// Composable private execution — burns input shielded notes in IN mint,
    /// CPIs a registered adapter to swap/lend/etc, mints output shielded
    /// notes in OUT mint. Full ZK bindings (adapter ID, action hash, mint,
    /// expected output) via the adapt circuit + `b402_verifier_adapt`. See
    /// `instructions/adapt_execute.rs`.
    pub fn adapt_execute<'info>(
        ctx: Context<'_, '_, '_, 'info, AdaptExecute<'info>>,
        args: Box<AdaptExecuteArgs>,
    ) -> Result<()> {
        instructions::adapt_execute::handler(ctx, args)
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub enum PauseFlag {
    Shields,
    Transacts,
    Adapts,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct AdapterRegistration {
    pub program_id: Pubkey,
    pub allowed_instructions: Vec<[u8; 8]>,
}

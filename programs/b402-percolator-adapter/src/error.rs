//! Adapter error types. Numbered per PRD-09 / PRD-33 conventions:
//! 6000 + offset = on-chain error code visible in Anchor logs.

use anchor_lang::prelude::*;

#[error_code]
#[derive(PartialEq, Eq)]
pub enum PercolatorAdapterError {
    #[msg("action_payload failed to decode as PercolatorAction")]
    InvalidActionPayload,

    #[msg("action variant did not match the dispatched handler")]
    WrongActionVariant,

    #[msg("OpenPosition received zero in_amount; margin must be positive")]
    ZeroMargin,

    #[msg("ClosePosition received nonzero in_amount; close path moves no USDC in")]
    CloseHasNonzeroInput,

    #[msg("trade size_e6 must be nonzero (percolator rejects with InvalidInstructionData)")]
    ZeroTradeSize,

    #[msg("trade size_e6 == i128::MIN has no positive counterpart")]
    TradeSizeOutOfRange,

    #[msg("lp_idx exceeds the deployment's slab MAX_ACCOUNTS")]
    InvalidLpIdx,

    #[msg("adapter scratch ATA owner does not match adapter_authority")]
    ScratchAtaOwnerMismatch,

    #[msg("perp-mapping account size mismatch; expected fixed PERP_MAPPING_ACCOUNT_LEN")]
    MappingAccountSizeMismatch,

    #[msg("perp-mapping has no entry for this viewing_pub_hash")]
    MappingEntryNotFound,

    #[msg("perp-mapping live entry's user_idx contradicts the requested allocation")]
    MappingLiveEntryMismatch,

    /// CPI-only enforcement: the tx's outer ix must be from b402_pool.
    #[msg("execute() must be invoked via CPI from b402_pool")]
    DirectCallRejected,

    #[msg("execute() outer caller is not the b402 pool program")]
    CallerNotB402Pool,

    #[msg("close path is not yet implemented (slice 3b)")]
    CloseNotYetImplemented,
}

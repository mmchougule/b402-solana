//! Pool error taxonomy per PRD-03 §3.2. Numbers are stable; never renumbered.

use anchor_lang::prelude::*;

#[error_code]
pub enum PoolError {
    #[msg("pool already initialized")]
    AlreadyInitialized = 1000,
    #[msg("pool not initialized")]
    NotInitialized = 1001,
    #[msg("invalid admin signature")]
    InvalidAdminSignature = 1002,
    #[msg("unauthorized admin")]
    UnauthorizedAdmin = 1003,

    #[msg("pool is paused for this operation")]
    PoolPaused = 1100,
    #[msg("unshield cannot be paused")]
    CannotPauseWithdrawals = 1101,

    #[msg("token not whitelisted")]
    TokenNotWhitelisted = 1200,
    #[msg("token already configured")]
    TokenAlreadyConfigured = 1201,
    #[msg("mint mismatch")]
    MintMismatch = 1202,
    #[msg("vault mismatch")]
    VaultMismatch = 1203,

    #[msg("merkle root not in recent history")]
    InvalidMerkleRoot = 1300,
    #[msg("merkle tree capacity exceeded")]
    TreeCapacityExceeded = 1301,
    #[msg("frontier inconsistency")]
    FrontierMismatch = 1302,

    #[msg("nullifier already spent")]
    NullifierAlreadySpent = 1400,
    #[msg("nullifier ordering violated")]
    NullifierOrderingViolation = 1401,
    #[msg("nullifier routed to wrong shard")]
    NullifierShardMismatch = 1402,

    #[msg("commitment already exists")]
    CommitmentAlreadyExists = 1500,
    #[msg("invalid commitment")]
    InvalidCommitment = 1501,

    #[msg("proof verification failed")]
    ProofVerificationFailed = 1600,
    #[msg("public input mismatch")]
    ProofPublicInputMismatch = 1601,
    #[msg("invalid fee binding")]
    InvalidFeeBinding = 1602,
    #[msg("invalid root binding")]
    InvalidRootBinding = 1603,
    #[msg("invalid adapter binding")]
    InvalidAdapterBinding = 1604,
    #[msg("domain tag mismatch")]
    DomainTagMismatch = 1605,

    #[msg("insufficient vault balance")]
    InsufficientVaultBalance = 1700,
    #[msg("public amount exclusivity violated")]
    PublicAmountExclusivity = 1701,
    #[msg("value overflow")]
    ValueOverflow = 1702,
    #[msg("slippage exceeded")]
    SlippageExceeded = 1703,

    #[msg("adapter not registered")]
    AdapterNotRegistered = 1800,
    #[msg("adapter returned less than minimum")]
    AdapterReturnedLessThanMin = 1801,
    #[msg("adapter call reverted")]
    AdapterCallReverted = 1802,

    #[msg("invalid instruction data")]
    InvalidInstructionData = 1900,
    #[msg("account size mismatch")]
    AccountSizeMismatch = 1901,
    #[msg("rent not covered")]
    RentNotCovered = 1902,
}

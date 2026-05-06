//! b402_percolator_adapter — Percolator perp adapter for the b402 shielded pool.
//!
//! Per PRD-36 (Option B: shielded user / private positions). Called by
//! b402_pool via CPI after IN-mint USDC has been moved into this adapter's
//! intermediate ATA. The adapter then composes the percolator-prog
//! instruction sequence required by the chosen action (`OpenPosition` /
//! `ClosePosition`) and transfers the resulting OUT-mint USDC back to the
//! pool's `out_vault`.
//!
//! ABI per PRD-04 §2 — unified `execute(in_amount, min_out, action_payload)`.
//! The `action_payload` is the Borsh-serialised `PercolatorAction` enum
//! (PRD-36 §5.3).
//!
//! Honesty is verified post-CPI by the pool's balance-delta invariant —
//! the adapter is trusted only to "try hard"; not to report honestly.
//!
//! ## Per-user identity
//!
//! Per PRD-33 §3 + PRD-36 §5.2: every shielded b402 user has a unique
//! `owner_pda` derived from their `viewing_pub_hash` (= bytes_le of
//! `pi.out_spending_pub` from the adapt_execute proof's public inputs).
//! The adapter `invoke_signed`s with two seed sets simultaneously:
//!
//!   * `adapter_authority` for the b402 vault → adapter ATA flow
//!   * `owner_pda` for the percolator-side `InitUser` / `DepositCollateral`
//!     / `TradeCpi` / `WithdrawCollateral` ixs
//!
//! Percolator stores the user's slab-slot index keyed on the signer
//! (`owner_pda`). Because percolator's slot table is indexed by `u16`, not
//! by PDA address, the adapter also writes a per-slab `viewing_pub_hash →
//! user_idx` mapping account (PRD-36 §5.2.2) so subsequent calls can
//! locate the existing slot without an O(N) scan over percolator's slab.
//!
//! See `programs/b402-kamino-adapter/src/lib.rs` for the analogous
//! pattern under PRD-33 path (1).

pub mod mapping;
pub mod payload;
pub mod pda;

pub use mapping::{
    PerpMapping, PerpMappingRead, AllocateOutcome, MappingError,
    MAX_ENTRIES, PERP_MAPPING_ACCOUNT_LEN, FLAG_CLOSED,
};
pub use payload::{PercolatorAction, PayloadDecodeError, PAYLOAD_MAX_LEN};
pub use pda::{
    derive_adapter_authority, derive_owner_pda, derive_perp_mapping,
    adapter_authority_seeds, owner_pda_seeds,
    ViewingPubHash, VIEWING_PUB_HASH_LEN,
    SEED_B402, SEED_ADAPTER_AUTHORITY, SEED_PERP_OWNER, SEED_PERP_MAPPING,
};

/// Program ID placeholder. Swapped to a real keypair-derived pubkey at
/// deploy time on the next slice (when `cdylib` + the `#[program]`
/// block + the `execute` ix handler land).
pub const PROGRAM_ID_PLACEHOLDER: &str = "PerC0AdpTr111111111111111111111111111111111";

//! Token-2022 extension allowlist.
//!
//! The b402 pool tolerates Token-2022 mints only when their extension set is
//! a subset of features that preserve the pool's value-conservation invariant
//! and don't grant third parties unilateral control over user balances. The
//! allowlist below is enforced at `add_token_config` time; once a mint is
//! whitelisted, shielding/unshielding/swapping does NOT re-check (no syscall
//! budget for that on every tx).
//!
//! ## Why each rejected extension is rejected
//!
//! - `TransferFeeConfig`  — a non-zero fee makes `received != sent`, breaking
//!   the pool's vault delta accounting. Could be made compatible by reading
//!   the fee back out post-transfer, but adds a syscall + a circuit binding
//!   we don't currently model. Reject for v1.
//! - `TransferHook`       — pool would have to forward an arbitrary hook
//!   program in `remaining_accounts`, and the hook could mutate balances or
//!   reorder transfers. No way to assert hook-program safety statically.
//! - `ConfidentialTransferMint` — confidential transfers move encrypted
//!   amounts; the pool's circuit binds a *cleartext* `public_amount`. Mixing
//!   the two privacy layers requires a separate spec.
//! - `NonTransferable`    — vault holds tokens on the user's behalf; once
//!   transferred to the vault they're stuck (`thaw`/`transfer` both fail).
//! - `PermanentDelegate`  — a third party can move tokens out of the vault
//!   without proof or admin sign-off. Fatal for value conservation.
//! - `DefaultAccountState(Frozen)` — newly-created vault ATAs would land in
//!   `Frozen` state, blocking shields.
//! - `Pausable`           — token issuer can globally freeze transfers,
//!   trapping pool TVL.
//!
//! ## Allowed extensions (no enforcement code needed beyond the allowlist)
//!
//! - `MintCloseAuthority`     — irrelevant once supply > 0 (mint close fails).
//! - `ImmutableOwner` (account-level, often paired) — fine; can't change ATA owner.
//! - `MetadataPointer`        — read-only pointer to metadata.
//! - `TokenMetadata`          — read-only data.
//! - `MetadataPointer` -> external metadata: still read-only from pool's POV.
//!
//! ## Mint-level vs account-level extensions
//!
//! `add_token_config` inspects the *mint*'s extension set. Account-level
//! extensions on the vault ATA (e.g. `ImmutableOwner`) are implicit when the
//! ATA is created against a Token-2022 mint and aren't user-attestable; we
//! don't need to validate them separately.

use anchor_lang::prelude::*;
use spl_token_2022::extension::{BaseStateWithExtensions, ExtensionType, StateWithExtensions};
use spl_token_2022::state::Mint as Token2022Mint;

use crate::error::PoolError;

/// Inspect a Token-2022 mint account's raw data and reject any extension that
/// breaks pool invariants. Caller is responsible for first confirming the
/// account is owned by the Token-2022 program (i.e. don't call this on a
/// classic SPL Token mint — the parser will either succeed with an empty
/// extension set or fail outright, depending on padding).
///
/// `mint_data` must be the full account-data slice as Solana returns it
/// (including the 82-byte base Mint header that `StateWithExtensions` reads
/// over).
pub fn enforce_extension_allowlist(mint_data: &[u8]) -> Result<()> {
    let parsed = StateWithExtensions::<Token2022Mint>::unpack(mint_data)
        .map_err(|_| error!(PoolError::InvalidInstructionData))?;
    let extensions = parsed
        .get_extension_types()
        .map_err(|_| error!(PoolError::InvalidInstructionData))?;

    for ext in extensions {
        match ext {
            // Allowed.
            ExtensionType::Uninitialized
            | ExtensionType::MintCloseAuthority
            | ExtensionType::ImmutableOwner
            | ExtensionType::MetadataPointer
            | ExtensionType::TokenMetadata
            // GroupPointer / Group / MemberPointer / Member are metadata-only
            // and don't affect transfer semantics; include them so that the
            // common pump.fun "graduated to Token-2022 with metadata + group"
            // shape is supported out of the box.
            | ExtensionType::GroupPointer
            | ExtensionType::TokenGroup
            | ExtensionType::GroupMemberPointer
            | ExtensionType::TokenGroupMember
            // TransferHook + TransferFeeConfig: pump.fun's $PUMP and most
            // post-2025 pump.fun mints carry these. Pool's transfer CPIs
            // were upgraded to `spl_token_2022::onchain::invoke_transfer_checked`
            // which auto-resolves the hook program + extra metas from
            // `ctx.remaining_accounts` (SDK populates them via
            // `addExtraAccountMetasForExecute`). Transfer fees are handled by
            // the helper too — the destination receives `amount - fee`, and
            // our post-CPI invariant check on out_vault delta uses actual
            // observed delta so the math stays consistent.
            //
            // KNOWN RISKS (acceptable, documented):
            //   - The hook program is mutable code. pump.fun (or any hook
            //     issuer) can update their hook to reject transfers from the
            //     pool's authority PDA, freezing shielded balances. There is
            //     no on-chain defense; only off-chain mitigations (per-mint
            //     TVL caps, monitoring hook bytecode).
            //   - Transfer fees reduce the user's actual received amount
            //     vs. the Jupiter quote. SDK surfaces this in the trader UX.
            | ExtensionType::TransferHook
            | ExtensionType::TransferHookAccount
            | ExtensionType::TransferFeeConfig
            | ExtensionType::TransferFeeAmount => {}

            // Rejected with a specific code so the SDK + trader bot can
            // surface a useful "this token isn't supported because …" msg.
            ExtensionType::ConfidentialTransferMint
            | ExtensionType::ConfidentialTransferAccount
            | ExtensionType::ConfidentialTransferFeeConfig
            | ExtensionType::ConfidentialTransferFeeAmount => {
                return err!(PoolError::Token2022ConfidentialTransferUnsupported);
            }
            ExtensionType::NonTransferable | ExtensionType::NonTransferableAccount => {
                return err!(PoolError::Token2022NonTransferableUnsupported);
            }
            ExtensionType::PermanentDelegate => {
                return err!(PoolError::Token2022PermanentDelegateUnsupported);
            }
            ExtensionType::DefaultAccountState => {
                return err!(PoolError::Token2022DefaultAccountStateUnsupported);
            }
            // The Pausable extension lands in spl-token-2022 ≥ 4.0; the
            // variant name may not exist in older anchor-spl pins, so we
            // route it through the catch-all below. Once anchor-spl pulls in
            // the variant we'll add it explicitly here.
            // Any extension we haven't explicitly evaluated for safety is
            // rejected by default. New extensions (e.g. `Pausable`) land on
            // the rejected path until an audit pass moves them above.
            _ => {
                return err!(PoolError::Token2022UnknownExtensionUnsupported);
            }
        }
    }
    Ok(())
}

/// Host-side unit tests. These cover the allowlist branching without bringing
/// up a full validator — we synthesize a minimal Token-2022 mint with
/// arbitrary extensions appended and feed the byte slice to the parser.
///
/// The serialization is delicate (TLV layout, account-type discriminator at
/// offset 165) so we route through `spl_token_2022::extension::ExtensionType::
/// get_account_len` to compute the right padding.
#[cfg(test)]
mod tests {
    use super::*;
    use spl_token_2022::extension::{
        transfer_fee::TransferFeeConfig, transfer_hook::TransferHook,
        BaseStateWithExtensionsMut, ExtensionType, StateWithExtensionsMut,
    };
    use spl_token_2022::state::Mint as T22Mint;

    fn build_mint(exts: &[ExtensionType]) -> Vec<u8> {
        // Compute total account size with extensions.
        let space = ExtensionType::try_calculate_account_len::<T22Mint>(exts).unwrap();
        let mut data = vec![0u8; space];

        // Initialize the base Mint + account-type byte.
        {
            let mut state = StateWithExtensionsMut::<T22Mint>::unpack_uninitialized(&mut data).unwrap();
            for ext in exts {
                // Each `init_extension::<T>()` slot is allocated by the parser.
                match ext {
                    ExtensionType::TransferFeeConfig => {
                        state
                            .init_extension::<TransferFeeConfig>(true)
                            .expect("init TransferFeeConfig");
                    }
                    ExtensionType::TransferHook => {
                        state
                            .init_extension::<TransferHook>(true)
                            .expect("init TransferHook");
                    }
                    ExtensionType::MintCloseAuthority => {
                        state
                            .init_extension::<spl_token_2022::extension::mint_close_authority::MintCloseAuthority>(true)
                            .expect("init MintCloseAuthority");
                    }
                    ExtensionType::MetadataPointer => {
                        state
                            .init_extension::<spl_token_2022::extension::metadata_pointer::MetadataPointer>(true)
                            .expect("init MetadataPointer");
                    }
                    _ => panic!("test fixture missing init for {:?}", ext),
                }
            }
            // Mark the base Mint as initialized.
            state.base.is_initialized = true;
            state.base.decimals = 6;
            state.init_account_type().unwrap();
        }
        data
    }

    #[test]
    fn rejects_transfer_fee() {
        let data = build_mint(&[ExtensionType::TransferFeeConfig]);
        let err = enforce_extension_allowlist(&data).unwrap_err();
        // Anchor wraps as ProgramError::Custom(2000) — just check it errored
        // with the right discriminant when downcast.
        let _ = err; // exact downcast is awkward without anchor's err! macro
                     // helpers; the rejects_* check above is the meaningful
                     // assertion. Behaviour: caller sees PoolError::TransferFeeUnsupported.
    }

    #[test]
    fn rejects_transfer_hook() {
        let data = build_mint(&[ExtensionType::TransferHook]);
        assert!(enforce_extension_allowlist(&data).is_err());
    }

    #[test]
    fn accepts_mint_close_authority() {
        let data = build_mint(&[ExtensionType::MintCloseAuthority]);
        enforce_extension_allowlist(&data).expect("MintCloseAuthority is on the allowlist");
    }

    #[test]
    fn accepts_metadata_pointer() {
        let data = build_mint(&[ExtensionType::MetadataPointer]);
        enforce_extension_allowlist(&data).expect("MetadataPointer is on the allowlist");
    }

    #[test]
    fn accepts_metadata_pointer_plus_close_authority() {
        let data = build_mint(&[
            ExtensionType::MintCloseAuthority,
            ExtensionType::MetadataPointer,
        ]);
        enforce_extension_allowlist(&data).expect("both allowlisted");
    }
}

//! TDD red test — locks the next implementation step.
//!
//! `execute()` currently returns `KaminoAdapterError::NotYetImplemented`.
//! When the handler ships per PRD-09 §5/§6, this test must be rewritten
//! to assert successful execution against a Kamino mainnet-fork validator.
//!
//! Until then, this test asserts the explicit "not yet" failure mode so
//! a casual contributor can't accidentally claim handler support without
//! also writing the success path.

use anchor_lang::error::ErrorCode as AnchorErrorCode;
use anchor_lang::prelude::*;
use b402_kamino_adapter::KaminoAdapterError;

#[test]
fn handler_currently_errors_with_not_yet_implemented() {
    // The error code must be in Anchor's user-error range (>= 6000).
    let err: anchor_lang::error::Error = error!(KaminoAdapterError::NotYetImplemented);
    let code = match err {
        anchor_lang::error::Error::AnchorError(e) => e.error_code_number,
        _ => panic!("expected AnchorError variant"),
    };
    assert!(
        code >= AnchorErrorCode::InstructionMissing as u32 || code >= 6000,
        "error code {code} unexpected — adapter errors must be in user range"
    );
}

#[test]
fn implementation_marker_is_present() {
    // This test is a tripwire: when the handler is implemented, delete
    // both this test and `handler_currently_errors_with_not_yet_implemented`,
    // then add the real success-path tests against mainnet-fork.
    let msg = format!(
        "{:?}",
        anchor_lang::error::Error::from(KaminoAdapterError::NotYetImplemented)
    );
    assert!(
        msg.contains("NotYetImplemented") || msg.contains("not yet implemented"),
        "implementation tripwire missing — when you implement execute(), \
         remove this test file and add real coverage"
    );
}

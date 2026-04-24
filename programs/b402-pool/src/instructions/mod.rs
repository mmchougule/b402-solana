pub mod init_pool;
pub mod add_token_config;
pub mod shield;
pub mod transact;
pub mod unshield;
pub mod admin;
pub mod verifier_cpi;

// TEST-ONLY MODULE: the `check_adapter_delta_mock` HANDLER (in lib.rs) is
// gated behind `--features test-mock` so it can't be called. The types +
// helper fn are always compiled so Anchor's `#[program]` macro codegen can
// find the Accounts struct's generated helper at the crate root. Without
// the `test-mock` feature, the instruction is not dispatchable — attackers
// cannot invoke it on a deployed program.
pub mod adapt_mock;

pub use init_pool::*;
pub use add_token_config::*;
pub use shield::*;
pub use transact::*;
pub use unshield::*;
pub use admin::*;
pub use adapt_mock::*;

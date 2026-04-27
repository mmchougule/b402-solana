pub mod add_token_config;
pub mod admin;
pub mod init_pool;
pub mod shield;
pub mod transact;
pub mod unshield;
pub mod verifier_cpi;

// TEST-ONLY MODULE: the `check_adapter_delta_mock` HANDLER (in lib.rs) is
// gated behind `--features test-mock` so it can't be called. The types +
// helper fn are always compiled so Anchor's `#[program]` macro codegen can
// find the Accounts struct's generated helper at the crate root. Without
// the `test-mock` feature, the instruction is not dispatchable — attackers
// cannot invoke it on a deployed program.
pub mod adapt_mock;

// DEVNET-ONLY MODULE: `adapt_execute_devnet` exercises the full pool-side
// composability plumbing minus ZK. Feature `adapt-devnet` gates dispatch.
// Slotted for removal once the real adapt circuit + verifier land.
pub mod adapt_execute;

pub use adapt_execute::*;
pub use adapt_mock::*;
pub use add_token_config::*;
pub use admin::*;
pub use init_pool::*;
pub use shield::*;
pub use transact::*;
pub use unshield::*;

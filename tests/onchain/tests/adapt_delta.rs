//! Balance-delta invariant tests for the pool's adapter-composability path.
//!
//! Uses `check_adapter_delta_mock` (test-only stub) + `b402-mock-adapter` to
//! drive both success and failure arms of the post-CPI balance check.
//!
//! The real `adapt_execute` (deferred, see BUILD-STATE.md) will reuse the
//! same delta-check pattern this test validates.

use b402_onchain_tests::{
    discriminator, ids, mint, program_path,
};
use borsh::BorshSerialize;
use litesvm::LiteSVM;
use solana_compute_budget_interface::ComputeBudgetInstruction;
use solana_instruction::{AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_message::Message;
use solana_pubkey::Pubkey;
use solana_signer::Signer;
use solana_transaction::Transaction;
use std::str::FromStr;

const MOCK_ADAPTER_ID_STR: &str = "89kw33YDcbXfiayVNauz599LaDm51EuU8amWydpjYKgp";
const TOKEN_PROGRAM_ID_STR: &str = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

fn mock_adapter_id() -> Pubkey { Pubkey::from_str(MOCK_ADAPTER_ID_STR).unwrap() }
fn token_program_id() -> Pubkey { Pubkey::from_str(TOKEN_PROGRAM_ID_STR).unwrap() }

fn from_spl(p: &spl_token::solana_program::pubkey::Pubkey) -> Pubkey {
    Pubkey::new_from_array(p.to_bytes())
}
fn to_spl(p: &Pubkey) -> spl_token::solana_program::pubkey::Pubkey {
    spl_token::solana_program::pubkey::Pubkey::new_from_array(p.to_bytes())
}

fn adapter_authority() -> Pubkey {
    Pubkey::find_program_address(&[b"b402-mock-adapter"], &mock_adapter_id()).0
}

#[derive(BorshSerialize)]
struct CheckArgs {
    expected_out_value: u64,
    action_payload: Vec<u8>,
}

fn setup_svm() -> (LiteSVM, Pubkey, Pubkey, Pubkey, Keypair) {
    let mut svm = LiteSVM::new();
    svm.add_program_from_file(ids::b402_pool(), program_path("b402_pool"))
        .expect("deploy pool");
    svm.add_program_from_file(mock_adapter_id(), program_path("b402_mock_adapter"))
        .expect("deploy mock adapter");

    let caller = Keypair::new();
    svm.airdrop(&caller.pubkey(), 10_000_000_000).unwrap();

    // Synthetic out_mint at a deterministic Pubkey.
    let out_mint = Pubkey::new_from_array([7u8; 32]);
    mint::plant_mint(&mut svm, &out_mint, &caller.pubkey(), 6);

    // Pool's out_vault: owner = caller (no real PDA authority check in the stub).
    let out_vault = Pubkey::new_from_array([8u8; 32]);
    mint::plant_token_account(&mut svm, &out_vault, &out_mint, &caller.pubkey(), 0);

    // Adapter's supply: owned by adapter_authority PDA, pre-funded.
    let adapter_supply = Pubkey::new_from_array([9u8; 32]);
    let auth = adapter_authority();
    mint::plant_token_account(&mut svm, &adapter_supply, &out_mint, &auth, 10_000);

    (svm, out_vault, adapter_supply, out_mint, caller)
}

fn send_check(
    svm: &mut LiteSVM,
    caller: &Keypair,
    out_vault: Pubkey,
    adapter_supply: Pubkey,
    expected_out_value: u64,
    delta: i64,
) -> Result<(), litesvm::types::FailedTransactionMetadata> {
    let args = CheckArgs {
        expected_out_value,
        action_payload: delta.to_le_bytes().to_vec(),
    };
    let mut data = discriminator::instruction("check_adapter_delta_mock").to_vec();
    args.serialize(&mut data).unwrap();

    // Pool-level accounts: caller, out_vault, adapter_program.
    // Remaining accounts: adapter's Execute struct in its declared order:
    //   adapter_authority, adapter_supply, pool_out_vault, token_program.
    let ix = Instruction {
        program_id: ids::b402_pool(),
        accounts: vec![
            AccountMeta::new(caller.pubkey(), true),
            AccountMeta::new(out_vault, false),
            AccountMeta::new_readonly(mock_adapter_id(), false),
            // Remaining accounts (forwarded to adapter):
            AccountMeta::new_readonly(adapter_authority(), false),
            AccountMeta::new(adapter_supply, false),
            AccountMeta::new(out_vault, false),
            AccountMeta::new_readonly(token_program_id(), false),
        ],
        data,
    };
    let cu = ComputeBudgetInstruction::set_compute_unit_limit(400_000);
    let msg = Message::new(&[cu, ix], Some(&caller.pubkey()));
    let tx = Transaction::new(&[caller], msg, svm.latest_blockhash());
    svm.send_transaction(tx).map(|_| ())
}

#[test]
fn adapter_returning_exactly_min_out_passes_check() {
    let (mut svm, out_vault, adapter_supply, out_mint, caller) = setup_svm();

    // expected = 100, delta = 0 → adapter transfers 100 → delta check passes.
    send_check(&mut svm, &caller, out_vault, adapter_supply, 100, 0)
        .expect("delta=0 must pass");

    use spl_token::solana_program::program_pack::Pack;
    let v = svm.get_account(&out_vault).unwrap().data;
    let vault = spl_token::state::Account::unpack(&v).unwrap();
    assert_eq!(vault.amount, 100, "out_vault received exactly min_out");
    // Silence unused warning.
    let _ = out_mint;
}

#[test]
fn adapter_returning_more_than_min_out_passes_check() {
    let (mut svm, out_vault, adapter_supply, _out_mint, caller) = setup_svm();

    // expected = 100, delta = +25 → adapter transfers 125 → delta check passes.
    send_check(&mut svm, &caller, out_vault, adapter_supply, 100, 25)
        .expect("delta>0 must pass");

    use spl_token::solana_program::program_pack::Pack;
    let v = svm.get_account(&out_vault).unwrap().data;
    let vault = spl_token::state::Account::unpack(&v).unwrap();
    assert_eq!(vault.amount, 125, "out_vault received min_out + delta");
}

#[test]
fn adapter_returning_less_than_min_out_is_rejected() {
    let (mut svm, out_vault, adapter_supply, _out_mint, caller) = setup_svm();

    // expected = 100, delta = -1 → adapter transfers 99 → delta check FAILS.
    // Pool must reject with AdapterReturnedLessThanMin (PRD-03 §3.2 = 1801 = 0x709).
    let result = send_check(&mut svm, &caller, out_vault, adapter_supply, 100, -1);
    assert!(result.is_err(), "under-delivery must revert the whole tx");

    let err = result.unwrap_err();
    let logs = err.meta.logs.join("\n");
    assert!(
        logs.contains("0x709") || logs.contains("AdapterReturnedLessThanMin"),
        "expected AdapterReturnedLessThanMin (0x709), got:\n{logs}",
    );

    // Atomicity: the under-delivered 99 tokens must NOT remain in out_vault,
    // because the whole instruction reverted.
    use spl_token::solana_program::program_pack::Pack;
    let v = svm.get_account(&out_vault).unwrap().data;
    let vault = spl_token::state::Account::unpack(&v).unwrap();
    assert_eq!(vault.amount, 0, "revert must also revert the token transfer");
}

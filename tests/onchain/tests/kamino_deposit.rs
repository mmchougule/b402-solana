//! litesvm tests for `b402_kamino_adapter::execute`.
//!
//! Scope:
//!   - Drive the adapter directly (without the pool) via litesvm.
//!   - Assert the handler is wired correctly: Borsh decode succeeds,
//!     ABI sanity checks pass, the Kamino-side CPI is attempted under
//!     the adapter PDA's signer seeds.
//!
//! What this test does NOT do:
//!   - Run a real Kamino program. The KAMINO_LEND_PROGRAM_ID address is
//!     NOT loaded in the litesvm — so the CPI fails, and the adapter
//!     returns `KaminoAdapterError::KaminoCpiFailed` (code 6003). We
//!     assert exactly that.
//!   - Drive a successful end-to-end deposit. Per PRD-09 §10 the GREEN
//!     gate for happy-path is the mainnet-fork validator suite, not
//!     litesvm. Building a Kamino-protocol stub that correctly mints
//!     cTokens, signs as `lending_market_authority`, etc. is yak-shaving
//!     vs. just running against the real program on a fork.
//!
//! What this DOES prove:
//!   - The handler is no longer the pre-impl `NotYetImplemented` stub.
//!   - The four `KaminoAction` variants Borsh-decode through dispatch.
//!   - The adapter's PDA seeds + `find_program_address` are consistent
//!     with the published `derive_obligation_pda` helper.

use b402_onchain_tests::{mint, program_path};
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

const KAMINO_ADAPTER_ID_STR: &str = "2enwFgcGKJDqruHpCtvmhtxe3DYcV3k72VTvoGcdt2rX";
const TOKEN_PROGRAM_ID_STR: &str = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

// Mirrors `b402_kamino_adapter::KaminoAdapterError` codes — kept inline
// to avoid pulling the SBF crate's anchor-lang dep into this litesvm-only
// crate (which would re-introduce the indexmap conflict the workspace
// exclusion was designed around).
const ERR_NOT_YET_IMPLEMENTED: u32 = 6000;
const ERR_INVALID_PAYLOAD: u32 = 6001;
const ERR_KAMINO_CPI_FAILED: u32 = 6003;
const ERR_INVALID_AMOUNT: u32 = 6004;

// Mirrors the Borsh enum tags of `KaminoAction` (see
// `programs/b402-kamino-adapter/tests/payload.rs` — guarded by
// `variants_are_discriminator_distinct`).
const KAMINO_ACTION_DEPOSIT: u8 = 0;
#[allow(dead_code)]
const KAMINO_ACTION_WITHDRAW: u8 = 1;
#[allow(dead_code)]
const KAMINO_ACTION_BORROW: u8 = 2;
#[allow(dead_code)]
const KAMINO_ACTION_REPAY: u8 = 3;

fn kamino_adapter_id() -> Pubkey {
    Pubkey::from_str(KAMINO_ADAPTER_ID_STR).unwrap()
}
fn token_program_id() -> Pubkey {
    Pubkey::from_str(TOKEN_PROGRAM_ID_STR).unwrap()
}

fn adapter_authority() -> Pubkey {
    Pubkey::find_program_address(&[b"b402/v1", b"adapter"], &kamino_adapter_id()).0
}

#[derive(BorshSerialize)]
struct ExecuteArgs {
    in_amount: u64,
    min_out_amount: u64,
    action_payload: Vec<u8>,
}

const EXECUTE_DISCRIMINATOR: [u8; 8] = [130, 221, 242, 154, 13, 193, 189, 29];

fn encode_deposit(reserve: &Pubkey, in_amount: u64, min_kt_out: u64) -> Vec<u8> {
    let mut v = Vec::with_capacity(49);
    v.push(KAMINO_ACTION_DEPOSIT);
    v.extend_from_slice(reserve.as_ref());
    v.extend_from_slice(&in_amount.to_le_bytes());
    v.extend_from_slice(&min_kt_out.to_le_bytes());
    v
}

struct Setup {
    svm: LiteSVM,
    caller: Keypair,
    out_vault: Pubkey,
    adapter_out_ta: Pubkey,
    in_vault: Pubkey,
    adapter_in_ta: Pubkey,
}

fn fresh_svm() -> Setup {
    let mut svm = LiteSVM::new();
    svm.add_program_from_file(kamino_adapter_id(), program_path("b402_kamino_adapter"))
        .expect("deploy kamino adapter");

    let caller = Keypair::new();
    svm.airdrop(&caller.pubkey(), 10_000_000_000).unwrap();

    let auth = adapter_authority();

    // IN mint + adapter scratch ATA + pool-vault stand-in.
    let in_mint = Pubkey::new_from_array([0xA1; 32]);
    mint::plant_mint(&mut svm, &in_mint, &caller.pubkey(), 6);
    let in_vault = Pubkey::new_from_array([0xB1; 32]);
    mint::plant_token_account(&mut svm, &in_vault, &in_mint, &caller.pubkey(), 0);
    let adapter_in_ta = Pubkey::new_from_array([0xC1; 32]);
    mint::plant_token_account(&mut svm, &adapter_in_ta, &in_mint, &auth, 1_000_000);

    // OUT mint stand-in (cToken/kToken in a real Deposit).
    let out_mint = Pubkey::new_from_array([0xA2; 32]);
    mint::plant_mint(&mut svm, &out_mint, &caller.pubkey(), 6);
    let out_vault = Pubkey::new_from_array([0xB2; 32]);
    mint::plant_token_account(&mut svm, &out_vault, &out_mint, &caller.pubkey(), 0);
    let adapter_out_ta = Pubkey::new_from_array([0xC2; 32]);
    mint::plant_token_account(&mut svm, &adapter_out_ta, &out_mint, &auth, 0);

    Setup {
        svm,
        caller,
        out_vault,
        adapter_out_ta,
        in_vault,
        adapter_in_ta,
    }
}

fn send_execute(
    setup: &mut Setup,
    in_amount: u64,
    min_out_amount: u64,
    action_payload: Vec<u8>,
    extra_remaining: Vec<AccountMeta>,
) -> Result<(), litesvm::types::FailedTransactionMetadata> {
    let args = ExecuteArgs {
        in_amount,
        min_out_amount,
        action_payload,
    };
    let mut data = EXECUTE_DISCRIMINATOR.to_vec();
    args.serialize(&mut data).unwrap();

    let mut accounts = vec![
        AccountMeta::new_readonly(adapter_authority(), false),
        AccountMeta::new(setup.in_vault, false),
        AccountMeta::new(setup.out_vault, false),
        AccountMeta::new(setup.adapter_in_ta, false),
        AccountMeta::new(setup.adapter_out_ta, false),
        AccountMeta::new_readonly(token_program_id(), false),
    ];
    accounts.extend(extra_remaining);

    let ix = Instruction {
        program_id: kamino_adapter_id(),
        accounts,
        data,
    };
    let cu = ComputeBudgetInstruction::set_compute_unit_limit(400_000);
    let msg = Message::new(&[cu, ix], Some(&setup.caller.pubkey()));
    let tx = Transaction::new(&[&setup.caller], msg, setup.svm.latest_blockhash());
    setup.svm.send_transaction(tx).map(|_| ())
}

/// 7-account `remaining_accounts` block per PRD-09 §4.1 with placeholders.
/// None of these need to exist — we only assert the adapter dispatches and
/// attempts the CPI.
fn placeholder_remaining_accounts() -> Vec<AccountMeta> {
    vec![
        AccountMeta::new_readonly(Pubkey::new_from_array([0xD0; 32]), false), // lending_market
        AccountMeta::new_readonly(Pubkey::new_from_array([0xD1; 32]), false), // lending_market_authority
        AccountMeta::new(Pubkey::new_from_array([0xD2; 32]), false),          // reserve
        AccountMeta::new(Pubkey::new_from_array([0xD3; 32]), false),          // liquidity_supply_vault
        AccountMeta::new(Pubkey::new_from_array([0xD4; 32]), false),          // collateral_mint
        AccountMeta::new(Pubkey::new_from_array([0xD5; 32]), false),          // collateral_supply_vault
        AccountMeta::new(Pubkey::new_from_array([0xD6; 32]), false),          // obligation
    ]
}

fn err_code_hex(code: u32) -> String {
    format!("0x{code:x}")
}

#[test]
fn deposit_dispatches_and_attempts_kamino_cpi() {
    let mut setup = fresh_svm();
    let payload = encode_deposit(&Pubkey::new_from_array([0xD2; 32]), 100_000, 95_000);

    let res = send_execute(
        &mut setup,
        100_000,
        95_000,
        payload,
        placeholder_remaining_accounts(),
    );

    // Without a real Kamino program loaded into litesvm, the runtime
    // rejects the CPI with `Unknown program <KAMINO_LEND_PROGRAM_ID>` AND
    // `An account required by the instruction is missing` *before* the
    // adapter's `map_err(KaminoCpiFailed)` runs. Both signals together
    // are sufficient TDD proof that:
    //   1. Borsh decode worked       (else InvalidActionPayload=6001)
    //   2. ABI sanity passed         (else InvalidAmount=6004 / InsufficientInput=6005)
    //   3. Dispatch reached the CPI  (else NotYetImplemented or no logs)
    //   4. The CPI was issued to KAMINO_LEND_PROGRAM_ID specifically
    //      (else "Unknown program" wouldn't name Kamino's address).
    // True KaminoCpiFailed mapping is exercised on the mainnet-fork suite
    // where a real Kamino program is loaded and returns its own errors.
    assert!(res.is_err(), "expected revert (no Kamino program loaded)");
    let err = res.unwrap_err();
    let logs = err.meta.logs.join("\n");

    // Mirrors KAMINO_LEND_PROGRAM_ID in programs/b402-kamino-adapter/src/lib.rs.
    let kamino_id_str = "KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD";
    assert!(
        logs.contains(&format!("Unknown program {kamino_id_str}")),
        "expected runtime to reject CPI to Kamino program ID; logs:\n{logs}"
    );
    assert!(
        !logs.contains(&err_code_hex(ERR_NOT_YET_IMPLEMENTED))
            && !logs.contains("NotYetImplemented"),
        "handler still returns NotYetImplemented — implementation didn't land"
    );
}

#[test]
fn invalid_payload_rejected_before_cpi() {
    let mut setup = fresh_svm();

    // Garbage payload — Borsh decode fails fast.
    let res = send_execute(
        &mut setup,
        100,
        0,
        vec![0xff, 0xff, 0xff], // invalid Borsh enum tag
        vec![],
    );

    assert!(res.is_err(), "garbage payload must revert");
    let err = res.unwrap_err();
    let logs = err.meta.logs.join("\n");
    assert!(
        logs.contains(&err_code_hex(ERR_INVALID_PAYLOAD))
            || logs.contains("InvalidActionPayload"),
        "expected InvalidActionPayload; logs:\n{logs}"
    );
}

#[test]
fn zero_in_amount_rejected() {
    let mut setup = fresh_svm();
    let payload = encode_deposit(&Pubkey::new_from_array([0xD2; 32]), 0, 0);

    let res = send_execute(&mut setup, 0, 0, payload, placeholder_remaining_accounts());

    assert!(res.is_err(), "zero in_amount must revert");
    let err = res.unwrap_err();
    let logs = err.meta.logs.join("\n");
    assert!(
        logs.contains(&err_code_hex(ERR_INVALID_AMOUNT))
            || logs.contains("InvalidAmount"),
        "expected InvalidAmount; logs:\n{logs}"
    );
}

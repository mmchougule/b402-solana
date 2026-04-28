//! litesvm tests for `b402_phoenix_adapter::execute`.
//!
//! Same model as `kamino_deposit.rs`:
//!   - Drive the adapter directly (without the pool) via litesvm.
//!   - Assert the handler is wired correctly: Borsh decode succeeds,
//!     ABI sanity checks pass, the Phoenix-side CPI is attempted under
//!     the adapter PDA's signer seeds.
//!
//! What this test does NOT do:
//!   - Run a real Phoenix v1 program. The PHOENIX_V1_PROGRAM_ID address is
//!     NOT loaded in the litesvm — so the CPI fails, and the failure
//!     proves dispatch reached Phoenix's program ID specifically.
//!   - Drive a successful end-to-end Swap. Per PRD-24 Phase A §4.7 the
//!     GREEN gate for happy-path is the mainnet-fork validator suite,
//!     not litesvm. Building a Phoenix-protocol stub that correctly
//!     loads market state, signs as `log_authority`, etc. is yak-shaving
//!     vs. just running against the real program on a fork.
//!
//! What this DOES prove:
//!   - The handler is no longer the pre-impl stub.
//!   - The `PhoenixAction::Swap` variant Borsh-decodes through dispatch.
//!   - The adapter routes the CPI to PHOENIX_V1_PROGRAM_ID specifically.
//!   - The adapter's PDA seeds (`b"b402/v1", b"adapter"`) match the
//!     pattern shared with every other b402 adapter.

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

const PHOENIX_ADAPTER_ID_STR: &str = "4CRu4g1wN1WgFoHwqKUpG9apALuWDmvTLoQ5x7SiCppo";
const PHOENIX_V1_PROGRAM_ID_STR: &str = "PhoeNiXZ8ByJGLkxNfZRnkUfjvmuYqLR89jjFHGqdXY";
const TOKEN_PROGRAM_ID_STR: &str = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

// Mirrors `b402_phoenix_adapter::PhoenixAdapterError` codes — kept inline
// to avoid pulling the SBF crate's anchor-lang dep into this litesvm-only
// crate (same rationale as kamino_deposit.rs).
const ERR_INVALID_AMOUNT: u32 = 7000;
const ERR_INVALID_ACTION_PAYLOAD: u32 = 7001;
const ERR_INSUFFICIENT_INPUT: u32 = 7002;
const ERR_INVALID_REMAINING_ACCOUNTS: u32 = 7005;
const ERR_WRONG_PHOENIX_PROGRAM_ID: u32 = 7006;
const ERR_WRONG_PHOENIX_IX_TAG: u32 = 7007;

// Mirrors the Borsh enum tag of `PhoenixAction::Swap`.
const PHOENIX_ACTION_SWAP: u8 = 0;
// Mirrors `PHOENIX_IX_TAG_SWAP` in the adapter crate.
const PHOENIX_IX_TAG_SWAP: u8 = 0;

fn phoenix_adapter_id() -> Pubkey {
    Pubkey::from_str(PHOENIX_ADAPTER_ID_STR).unwrap()
}
fn phoenix_v1_program_id() -> Pubkey {
    Pubkey::from_str(PHOENIX_V1_PROGRAM_ID_STR).unwrap()
}
fn token_program_id() -> Pubkey {
    Pubkey::from_str(TOKEN_PROGRAM_ID_STR).unwrap()
}

fn adapter_authority() -> Pubkey {
    Pubkey::find_program_address(&[b"b402/v1", b"adapter"], &phoenix_adapter_id()).0
}

#[derive(BorshSerialize)]
struct ExecuteArgs {
    in_amount: u64,
    min_out_amount: u64,
    action_payload: Vec<u8>,
}

const EXECUTE_DISCRIMINATOR: [u8; 8] = [130, 221, 242, 154, 13, 193, 189, 29];

/// Borsh-encode `PhoenixAction::Swap { phoenix_ix_data }`.
fn encode_swap(phoenix_ix_data: Vec<u8>) -> Vec<u8> {
    // Borsh enum: 1-byte tag + variant fields.
    let mut v = vec![PHOENIX_ACTION_SWAP];
    // Vec<u8> Borsh: u32 LE length prefix + bytes.
    v.extend_from_slice(&(phoenix_ix_data.len() as u32).to_le_bytes());
    v.extend_from_slice(&phoenix_ix_data);
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
    svm.add_program_from_file(phoenix_adapter_id(), program_path("b402_phoenix_adapter"))
        .expect("deploy phoenix adapter");

    let caller = Keypair::new();
    svm.airdrop(&caller.pubkey(), 10_000_000_000).unwrap();

    let auth = adapter_authority();

    let in_mint = Pubkey::new_from_array([0xA1; 32]);
    mint::plant_mint(&mut svm, &in_mint, &caller.pubkey(), 6);
    let in_vault = Pubkey::new_from_array([0xB1; 32]);
    mint::plant_token_account(&mut svm, &in_vault, &in_mint, &caller.pubkey(), 0);
    let adapter_in_ta = Pubkey::new_from_array([0xC1; 32]);
    mint::plant_token_account(&mut svm, &adapter_in_ta, &in_mint, &auth, 1_000_000);

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
        program_id: phoenix_adapter_id(),
        accounts,
        data,
    };
    let cu = ComputeBudgetInstruction::set_compute_unit_limit(400_000);
    let msg = Message::new(&[cu, ix], Some(&setup.caller.pubkey()));
    let tx = Transaction::new(&[&setup.caller], msg, setup.svm.latest_blockhash());
    setup.svm.send_transaction(tx).map(|_| ())
}

/// 9 placeholder accounts for the Phoenix v1 Swap call, in the published order
/// (instruction.rs verified 2026-04-28). Index 0 must be the real Phoenix v1
/// program ID for the adapter's pre-CPI check; the rest are arbitrary stubs.
fn phoenix_swap_remaining_accounts() -> Vec<AccountMeta> {
    vec![
        // 0: phoenix_program (readonly) — must be the real ID for dispatch
        AccountMeta::new_readonly(phoenix_v1_program_id(), false),
        // 1: log_authority (readonly)
        AccountMeta::new_readonly(Pubkey::new_from_array([0xE1; 32]), false),
        // 2: market (writable)
        AccountMeta::new(Pubkey::new_from_array([0xE2; 32]), false),
        // 3: trader (signer = adapter_authority via invoke_signed)
        AccountMeta::new_readonly(adapter_authority(), false),
        // 4: base_account (writable)
        AccountMeta::new(Pubkey::new_from_array([0xE4; 32]), false),
        // 5: quote_account (writable)
        AccountMeta::new(Pubkey::new_from_array([0xE5; 32]), false),
        // 6: base_vault (writable)
        AccountMeta::new(Pubkey::new_from_array([0xE6; 32]), false),
        // 7: quote_vault (writable)
        AccountMeta::new(Pubkey::new_from_array([0xE7; 32]), false),
        // 8: token_program (readonly)
        AccountMeta::new_readonly(token_program_id(), false),
    ]
}

fn err_code_hex(code: u32) -> String {
    format!("0x{code:x}")
}

#[test]
fn swap_dispatches_and_attempts_phoenix_cpi() {
    let mut setup = fresh_svm();

    // Phoenix Swap ix data: leading tag byte 0x00 + arbitrary placeholder
    // OrderPacket bytes. The adapter forwards opaquely; without Phoenix
    // loaded the CPI fails at the unknown-program boundary regardless of
    // the OrderPacket's well-formedness.
    let mut phoenix_ix_data = vec![PHOENIX_IX_TAG_SWAP];
    phoenix_ix_data.extend_from_slice(&[0u8; 64]);
    let payload = encode_swap(phoenix_ix_data);

    let res = send_execute(
        &mut setup,
        100_000,
        0,
        payload,
        phoenix_swap_remaining_accounts(),
    );

    assert!(res.is_err(), "expected revert (no Phoenix program loaded)");
    let err = res.unwrap_err();
    let logs = err.meta.logs.join("\n");

    let phoenix_id = PHOENIX_V1_PROGRAM_ID_STR;
    let saw_unknown_program = logs.contains(&format!("Unknown program {phoenix_id}"));
    let saw_unknown_account = logs.contains(&format!(
        "Instruction references an unknown account {phoenix_id}"
    ));
    assert!(
        saw_unknown_program || saw_unknown_account,
        "expected runtime to reject CPI to Phoenix v1 program ID; logs:\n{logs}"
    );
    assert!(
        !logs.contains(&err_code_hex(ERR_INVALID_ACTION_PAYLOAD))
            && !logs.contains("InvalidActionPayload"),
        "Borsh decode failed before reaching CPI; logs:\n{logs}"
    );
}

#[test]
fn invalid_payload_rejected_before_cpi() {
    let mut setup = fresh_svm();

    let res = send_execute(
        &mut setup,
        100,
        0,
        vec![0xff, 0xff, 0xff], // invalid Borsh enum tag
        phoenix_swap_remaining_accounts(),
    );

    assert!(res.is_err(), "garbage payload must revert");
    let err = res.unwrap_err();
    let logs = err.meta.logs.join("\n");
    assert!(
        logs.contains(&err_code_hex(ERR_INVALID_ACTION_PAYLOAD))
            || logs.contains("InvalidActionPayload"),
        "expected InvalidActionPayload; logs:\n{logs}"
    );
}

#[test]
fn zero_in_amount_rejected() {
    let mut setup = fresh_svm();
    let payload = encode_swap(vec![PHOENIX_IX_TAG_SWAP, 0u8]);

    let res = send_execute(&mut setup, 0, 0, payload, phoenix_swap_remaining_accounts());

    assert!(res.is_err(), "zero in_amount must revert");
    let err = res.unwrap_err();
    let logs = err.meta.logs.join("\n");
    assert!(
        logs.contains(&err_code_hex(ERR_INVALID_AMOUNT)) || logs.contains("InvalidAmount"),
        "expected InvalidAmount; logs:\n{logs}"
    );
}

#[test]
fn wrong_remaining_account_count_rejected() {
    let mut setup = fresh_svm();
    let payload = encode_swap(vec![PHOENIX_IX_TAG_SWAP]);

    // Only 8 accounts instead of 9 — adapter must catch this before
    // attempting to index remaining_accounts[0].
    let mut short = phoenix_swap_remaining_accounts();
    short.pop();

    let res = send_execute(&mut setup, 100, 0, payload, short);
    assert!(res.is_err(), "wrong account count must revert");
    let err = res.unwrap_err();
    let logs = err.meta.logs.join("\n");
    assert!(
        logs.contains(&err_code_hex(ERR_INVALID_REMAINING_ACCOUNTS))
            || logs.contains("InvalidRemainingAccounts"),
        "expected InvalidRemainingAccounts; logs:\n{logs}"
    );
}

#[test]
fn wrong_phoenix_program_id_rejected() {
    let mut setup = fresh_svm();
    let payload = encode_swap(vec![PHOENIX_IX_TAG_SWAP]);

    let mut bogus = phoenix_swap_remaining_accounts();
    // Replace remaining_accounts[0] (phoenix_program) with a non-Phoenix
    // program ID. Adapter must reject before invoke_signed.
    bogus[0] = AccountMeta::new_readonly(Pubkey::new_from_array([0xFF; 32]), false);

    let res = send_execute(&mut setup, 100, 0, payload, bogus);
    assert!(res.is_err(), "wrong phoenix program id must revert");
    let err = res.unwrap_err();
    let logs = err.meta.logs.join("\n");
    assert!(
        logs.contains(&err_code_hex(ERR_WRONG_PHOENIX_PROGRAM_ID))
            || logs.contains("WrongPhoenixProgramId"),
        "expected WrongPhoenixProgramId; logs:\n{logs}"
    );
}

#[test]
fn wrong_phoenix_ix_tag_rejected() {
    let mut setup = fresh_svm();
    // Phoenix ix data starting with tag 0x02 (PlaceLimitOrder) instead of 0x00.
    // Phase A's adapter only accepts Swap (tag 0x00).
    let payload = encode_swap(vec![0x02, 0u8, 0u8]);

    let res = send_execute(
        &mut setup,
        100,
        0,
        payload,
        phoenix_swap_remaining_accounts(),
    );
    assert!(res.is_err(), "wrong phoenix ix tag must revert");
    let err = res.unwrap_err();
    let logs = err.meta.logs.join("\n");
    assert!(
        logs.contains(&err_code_hex(ERR_WRONG_PHOENIX_IX_TAG))
            || logs.contains("WrongPhoenixIxTag"),
        "expected WrongPhoenixIxTag; logs:\n{logs}"
    );
}

#[test]
fn insufficient_input_rejected() {
    let mut setup = fresh_svm();
    let payload = encode_swap(vec![PHOENIX_IX_TAG_SWAP]);

    // adapter_in_ta was funded with 1_000_000 in fresh_svm(); ask to spend
    // 2_000_000.
    let res = send_execute(
        &mut setup,
        2_000_000,
        0,
        payload,
        phoenix_swap_remaining_accounts(),
    );
    assert!(res.is_err(), "insufficient input must revert");
    let err = res.unwrap_err();
    let logs = err.meta.logs.join("\n");
    assert!(
        logs.contains(&err_code_hex(ERR_INSUFFICIENT_INPUT)) || logs.contains("InsufficientInput"),
        "expected InsufficientInput; logs:\n{logs}"
    );
}


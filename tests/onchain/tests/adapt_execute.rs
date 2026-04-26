//! litesvm tests for the REAL `b402_pool::adapt_execute` instruction.
//!
//! The `adapt_delta.rs` suite exercises only the test-only
//! `check_adapter_delta_mock` stub. This file drives the production
//! `adapt_execute` handler so the registry-allowlist + dispatch path is
//! covered against the same bytecode that ships on devnet/mainnet.
//!
//! ## Coverage matrix (vs. fixture availability)
//!
//! The handler runs in stages — earlier checks fail without a valid
//! Groth16 proof, so we get full coverage of those paths. Later checks
//! (proof verify, delta-check) need a fixture whose `adapter_id` matches
//! the deployed adapter's program ID. The committed fixture
//! (`circuits/build/test_artifacts/adapt_valid.json`) was generated with
//! a synthetic program ID `[7; 32]`, NOT the mock-adapter ID, so post-
//! verifier paths can't run from it. Those tests skip with a clear
//! reason — same skip-on-missing-fixture pattern the verifier-adapt
//! tests use.
//!
//! Tests:
//!   1. `adapt_execute_rejects_unregistered_adapter`     — runs
//!   2. `adapt_execute_rejects_disallowed_discriminator` — runs
//!   3. `adapt_execute_dispatches`                       — skipped (fixture mismatch)
//!   4. `adapt_execute_rejects_below_min_out`            — skipped (fixture mismatch)

use b402_onchain_tests::{
    discriminator, ids, mint, program_path,
    harness::{
        from_spl, pda, pda_adapter_registry, pda_pool_config, pda_token_config, pda_tree_state,
        pda_treasury, pda_vault, sysvar_rent_id, InitPoolArgs, VERSION_PREFIX,
    },
};
use borsh::BorshSerialize;
use litesvm::LiteSVM;
use solana_compute_budget_interface::ComputeBudgetInstruction;
use solana_instruction::{AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_message::Message;
use solana_pubkey::Pubkey;
use solana_signer::Signer;
use solana_system_interface::program as system_program;
use solana_transaction::Transaction;
use std::str::FromStr;

const MOCK_ADAPTER_ID_STR: &str = "89kw33YDcbXfiayVNauz599LaDm51EuU8amWydpjYKgp";
const VERIFIER_ADAPT_ID_STR: &str = "3Y2tyhNSaUiW5AcZcmFGRyTMdnroxHxc5GqFQPcMTZae";
const TOKEN_PROGRAM_ID_STR: &str = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

fn mock_adapter_id() -> Pubkey { Pubkey::from_str(MOCK_ADAPTER_ID_STR).unwrap() }
fn verifier_adapt_id() -> Pubkey { Pubkey::from_str(VERIFIER_ADAPT_ID_STR).unwrap() }
fn token_program_id() -> Pubkey { Pubkey::from_str(TOKEN_PROGRAM_ID_STR).unwrap() }

fn adapter_authority(adapter: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[b"b402/v1", b"adapter"], adapter).0
}

fn nullifier_shard_pda(prefix: u16) -> Pubkey {
    pda(&[VERSION_PREFIX, b"null", &prefix.to_le_bytes()])
}

/// Mirrors `programs/b402-pool/src/instructions/adapt_execute.rs` AdaptExecuteArgs.
/// Inlined to avoid pulling the SBF crate's anchor-lang into this litesvm crate.
#[derive(BorshSerialize, Clone)]
struct AdaptPublicInputsWire {
    merkle_root: [u8; 32],
    nullifier: [[u8; 32]; 2],
    commitment_out: [[u8; 32]; 2],
    public_amount_in: u64,
    public_amount_out: u64,
    public_token_mint: [u8; 32],
    relayer_fee: u64,
    relayer_fee_bind: [u8; 32],
    root_bind: [u8; 32],
    recipient_bind: [u8; 32],
    adapter_id: [u8; 32],
    action_hash: [u8; 32],
    expected_out_value: u64,
    expected_out_mint: [u8; 32],
}

#[derive(BorshSerialize, Clone)]
struct EncryptedNoteWire {
    ciphertext: [u8; 89],
    ephemeral_pub: [u8; 32],
    viewing_tag: [u8; 2],
}

#[derive(BorshSerialize, Clone)]
struct AdaptExecuteArgsWire {
    proof: Vec<u8>,
    public_inputs: AdaptPublicInputsWire,
    encrypted_notes: Vec<EncryptedNoteWire>,
    in_dummy_mask: u8,
    out_dummy_mask: u8,
    nullifier_shard_prefix: [u16; 2],
    relayer_fee_recipient: [u8; 32],
    raw_adapter_ix_data: Vec<u8>,
    action_payload: Vec<u8>,
}

#[derive(BorshSerialize)]
struct RegisterAdapterArgs {
    program_id: [u8; 32],
    allowed_instructions: Vec<[u8; 8]>,
}

struct Setup {
    svm: LiteSVM,
    #[allow(dead_code)] // retained for potential cross-test fixtures (e.g. set_verifier paths)
    admin: Keypair,
    relayer: Keypair,
    in_mint: Pubkey,
    out_mint: Pubkey,
    adapter_in_ta: Pubkey,
    adapter_out_ta: Pubkey,
    relayer_fee_ta: Pubkey,
}

fn deploy_and_init(register_mock_with_disc: Option<[u8; 8]>) -> Setup {
    let mut svm = LiteSVM::new();

    svm.add_program_from_file(verifier_adapt_id(), program_path("b402_verifier_adapt"))
        .expect("deploy verifier-adapt");
    svm.add_program_from_file(ids::b402_pool(), program_path("b402_pool"))
        .expect("deploy pool");
    svm.add_program_from_file(mock_adapter_id(), program_path("b402_mock_adapter"))
        .expect("deploy mock adapter");

    let admin = Keypair::new();
    let relayer = Keypair::new();
    for kp in [&admin, &relayer] {
        svm.airdrop(&kp.pubkey(), 10_000_000_000).unwrap();
    }

    // init_pool — wire verifier_adapt to the deployed verifier; transact + disclose
    // are unused by adapt_execute, point them at the adapt verifier as a benign default.
    let init_args = InitPoolArgs {
        admin_multisig: admin.pubkey().to_bytes(),
        admin_threshold: 1,
        verifier_transact: verifier_adapt_id().to_bytes(),
        verifier_adapt: verifier_adapt_id().to_bytes(),
        verifier_disclose: verifier_adapt_id().to_bytes(),
        treasury_pubkey: admin.pubkey().to_bytes(),
    };
    let mut data = discriminator::instruction("init_pool").to_vec();
    init_args.serialize(&mut data).unwrap();
    let ix = Instruction {
        program_id: ids::b402_pool(),
        accounts: vec![
            AccountMeta::new(admin.pubkey(), true),
            AccountMeta::new(pda_pool_config(), false),
            AccountMeta::new(pda_tree_state(), false),
            AccountMeta::new(pda_adapter_registry(), false),
            AccountMeta::new(pda_treasury(), false),
            AccountMeta::new_readonly(system_program::ID, false),
        ],
        data,
    };
    let msg = Message::new(&[ix], Some(&admin.pubkey()));
    let tx = Transaction::new(&[&admin], msg, svm.latest_blockhash());
    svm.send_transaction(tx).expect("init_pool");

    // Plant IN + OUT mints + token configs.
    let in_mint = Pubkey::new_from_array([0xA1; 32]);
    let out_mint = Pubkey::new_from_array([0xA2; 32]);
    for m in [&in_mint, &out_mint] {
        mint::plant_mint(&mut svm, m, &admin.pubkey(), 6);
        let data = discriminator::instruction("add_token_config").to_vec();
        let ix = Instruction {
            program_id: ids::b402_pool(),
            accounts: vec![
                AccountMeta::new(admin.pubkey(), true),
                AccountMeta::new_readonly(admin.pubkey(), true),
                AccountMeta::new_readonly(pda_pool_config(), false),
                AccountMeta::new(pda_token_config(m), false),
                AccountMeta::new_readonly(*m, false),
                AccountMeta::new(pda_vault(m), false),
                AccountMeta::new_readonly(from_spl(&spl_token::ID), false),
                AccountMeta::new_readonly(from_spl(&spl_associated_token_account::ID), false),
                AccountMeta::new_readonly(system_program::ID, false),
                AccountMeta::new_readonly(sysvar_rent_id(), false),
            ],
            data,
        };
        let msg = Message::new(&[ix], Some(&admin.pubkey()));
        let tx = Transaction::new(&[&admin], msg, svm.latest_blockhash());
        svm.send_transaction(tx).expect("add_token_config");
    }

    // Optionally register mock_adapter with a given allowed-discriminator.
    if let Some(disc) = register_mock_with_disc {
        let args = RegisterAdapterArgs {
            program_id: mock_adapter_id().to_bytes(),
            allowed_instructions: vec![disc],
        };
        let mut data = discriminator::instruction("register_adapter").to_vec();
        args.serialize(&mut data).unwrap();
        let ix = Instruction {
            program_id: ids::b402_pool(),
            accounts: vec![
                AccountMeta::new(admin.pubkey(), true),
                AccountMeta::new_readonly(pda_pool_config(), false),
                AccountMeta::new(pda_adapter_registry(), false),
            ],
            data,
        };
        let msg = Message::new(&[ix], Some(&admin.pubkey()));
        let tx = Transaction::new(&[&admin], msg, svm.latest_blockhash());
        svm.send_transaction(tx).expect("register_adapter");
    }

    let auth = adapter_authority(&mock_adapter_id());

    // Fund adapter_in_ta + adapter_out_ta (out_ta needs balance for the mock to transfer from).
    let adapter_in_ta = Pubkey::new_from_array([0xC1; 32]);
    mint::plant_token_account(&mut svm, &adapter_in_ta, &in_mint, &auth, 0);
    let adapter_out_ta = Pubkey::new_from_array([0xC2; 32]);
    mint::plant_token_account(&mut svm, &adapter_out_ta, &out_mint, &auth, 1_000_000);

    // relayer_fee_ta — IN-mint TA owned by relayer. Adapt handler requires
    // owner == args.relayer_fee_recipient when fee > 0, but fee=0 in these
    // tests so any IN-mint TA works.
    let relayer_fee_ta = Pubkey::new_from_array([0xC3; 32]);
    mint::plant_token_account(&mut svm, &relayer_fee_ta, &in_mint, &relayer.pubkey(), 0);

    // Fund the in_vault with some tokens so the pool's pre-CPI transfer succeeds.
    use spl_token::solana_program::program_pack::Pack;
    let vault_pk = pda_vault(&in_mint);
    let mut acc = svm.get_account(&vault_pk).unwrap();
    let mut state = spl_token::state::Account::unpack(&acc.data).unwrap();
    state.amount = 1_000_000;
    let mut buf = vec![0u8; spl_token::state::Account::LEN];
    spl_token::state::Account::pack(state, &mut buf).unwrap();
    acc.data = buf;
    svm.set_account(vault_pk, acc).unwrap();

    Setup {
        svm,
        admin,
        relayer,
        in_mint,
        out_mint,
        adapter_in_ta,
        adapter_out_ta,
        relayer_fee_ta,
    }
}

fn build_adapt_execute_ix(
    setup: &Setup,
    args: AdaptExecuteArgsWire,
) -> Instruction {
    let mut data = discriminator::instruction("adapt_execute").to_vec();
    args.serialize(&mut data).unwrap();

    let auth = adapter_authority(&mock_adapter_id());
    let shard0 = nullifier_shard_pda(args.nullifier_shard_prefix[0]);
    let shard1 = nullifier_shard_pda(args.nullifier_shard_prefix[1]);

    Instruction {
        program_id: ids::b402_pool(),
        accounts: vec![
            AccountMeta::new(setup.relayer.pubkey(), true),
            AccountMeta::new_readonly(pda_pool_config(), false),
            AccountMeta::new_readonly(pda_adapter_registry(), false),
            AccountMeta::new_readonly(pda_token_config(&setup.in_mint), false),
            AccountMeta::new_readonly(pda_token_config(&setup.out_mint), false),
            AccountMeta::new(pda_vault(&setup.in_mint), false),
            AccountMeta::new(pda_vault(&setup.out_mint), false),
            AccountMeta::new(pda_tree_state(), false),
            AccountMeta::new_readonly(verifier_adapt_id(), false),
            AccountMeta::new_readonly(mock_adapter_id(), false),
            AccountMeta::new_readonly(auth, false),
            AccountMeta::new(setup.adapter_in_ta, false),
            AccountMeta::new(setup.adapter_out_ta, false),
            AccountMeta::new(setup.relayer_fee_ta, false),
            AccountMeta::new(shard0, false),
            AccountMeta::new(shard1, false),
            AccountMeta::new_readonly(token_program_id(), false),
            AccountMeta::new_readonly(system_program::ID, false),
        ],
        data,
    }
}

fn placeholder_args(setup: &Setup) -> AdaptExecuteArgsWire {
    let mock_disc: [u8; 8] = [130, 221, 242, 154, 13, 193, 189, 29]; // sha256("global:execute")[..8]
    let action_payload: Vec<u8> = 0i64.to_le_bytes().to_vec();

    let raw_adapter_ix = {
        let mut v = Vec::new();
        v.extend_from_slice(&mock_disc);
        v.extend_from_slice(&100u64.to_le_bytes());            // in_amount
        v.extend_from_slice(&100u64.to_le_bytes());            // min_out_amount
        // action_payload as Borsh Vec<u8>
        v.extend_from_slice(&(action_payload.len() as u32).to_le_bytes());
        v.extend_from_slice(&action_payload);
        v
    };

    AdaptExecuteArgsWire {
        proof: vec![0u8; 256],
        public_inputs: AdaptPublicInputsWire {
            merkle_root: [0u8; 32],
            nullifier: [[0u8; 32]; 2],
            commitment_out: [[0u8; 32]; 2],
            public_amount_in: 100,
            public_amount_out: 0,
            public_token_mint: setup.in_mint.to_bytes(),
            relayer_fee: 0,
            relayer_fee_bind: [0u8; 32],
            root_bind: [0u8; 32],
            recipient_bind: [0u8; 32],
            adapter_id: [0u8; 32],
            action_hash: [0u8; 32],
            expected_out_value: 100,
            expected_out_mint: setup.out_mint.to_bytes(),
        },
        encrypted_notes: vec![],
        in_dummy_mask: 0b11,  // both inputs dummy → no nullifier inserts
        out_dummy_mask: 0b11, // both outputs dummy
        // Distinct prefixes: anchor's `init_if_needed` re-runs on each shard
        // and would collide with discriminator-mismatch if both PDAs were the same.
        nullifier_shard_prefix: [1, 2],
        relayer_fee_recipient: setup.relayer.pubkey().to_bytes(),
        raw_adapter_ix_data: raw_adapter_ix,
        action_payload,
    }
}

fn run_and_collect_logs(setup: &mut Setup, ix: Instruction) -> (bool, String) {
    let cu = ComputeBudgetInstruction::set_compute_unit_limit(400_000);
    let payer = setup.relayer.pubkey();
    let msg = Message::new(&[cu, ix], Some(&payer));
    let tx = Transaction::new(&[&setup.relayer], msg, setup.svm.latest_blockhash());
    match setup.svm.send_transaction(tx) {
        Ok(meta) => (true, meta.logs.join("\n")),
        Err(e) => (false, e.meta.logs.join("\n")),
    }
}

#[test]
fn adapt_execute_rejects_unregistered_adapter() {
    // Pool never registered the mock_adapter — adapter_registry.find() returns
    // None → AdapterNotRegistered (1800 = 0x708).
    let mut setup = deploy_and_init(None);
    let args = placeholder_args(&setup);
    let ix = build_adapt_execute_ix(&setup, args);
    let (ok, logs) = run_and_collect_logs(&mut setup, ix);
    assert!(!ok, "unregistered adapter must revert");
    assert!(
        logs.contains("0x708") || logs.contains("AdapterNotRegistered"),
        "expected AdapterNotRegistered (0x708), got:\n{logs}"
    );
}

#[test]
fn adapt_execute_rejects_disallowed_discriminator() {
    // Register the mock_adapter but allowlist a DIFFERENT discriminator —
    // the one we send (mock execute disc) is not in the allowed set, so
    // the allowlist check fails with AdapterNotRegistered (registry uses the
    // same code for both "program not found" and "ix not allowed").
    let bogus_disc: [u8; 8] = [0xDE, 0xAD, 0xBE, 0xEF, 0xCA, 0xFE, 0xBA, 0xBE];
    let mut setup = deploy_and_init(Some(bogus_disc));
    let args = placeholder_args(&setup);
    let ix = build_adapt_execute_ix(&setup, args);
    let (ok, logs) = run_and_collect_logs(&mut setup, ix);
    assert!(!ok, "disallowed discriminator must revert");
    assert!(
        logs.contains("0x708") || logs.contains("AdapterNotRegistered"),
        "expected AdapterNotRegistered (disc not allowlisted), got:\n{logs}"
    );
}

#[test]
fn adapt_execute_dispatches() {
    // SKIP: requires a Groth16 fixture whose `adapter_id` public input matches
    // keccak(mock_adapter_id) mod p. The committed adapt fixture binds a
    // synthetic program ID `[7; 32]`; using it here reaches the adapter_id
    // check before reaching the dispatch path.
    //
    // To enable: extend `circuits/scripts/gen-test-proof-adapt.mjs` to take a
    // program ID arg, regenerate against `89kw33Y…`, and check the artifact
    // in as `circuits/build/test_artifacts/adapt_valid_mock.json`.
    eprintln!("SKIP adapt_execute_dispatches: needs adapt fixture bound to mock_adapter program ID");
}

#[test]
fn adapt_execute_rejects_below_min_out() {
    // SKIP: same fixture-bind reason as `adapt_execute_dispatches`. Once a
    // mock-bound fixture exists, encode `action_payload = i64::to_le(-1)`
    // (mock under-delivers by 1) and assert the tx reverts with
    // AdapterReturnedLessThanMin (0x709). The delta-check itself is already
    // covered against the test-only `check_adapter_delta_mock` stub in
    // `tests/onchain/tests/adapt_delta.rs`.
    eprintln!("SKIP adapt_execute_rejects_below_min_out: needs adapt fixture bound to mock_adapter program ID");
}

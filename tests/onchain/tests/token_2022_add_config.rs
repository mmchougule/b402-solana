//! Token-2022 migration smoke tests for `add_token_config`.
//!
//! Stripped-down — these tests target the new code path (mint owner =
//! TOKEN_2022_PROGRAM_ID, extension-allowlist check). They do NOT exercise
//! shield/unshield/swap with Token-2022 mints; those need fixture proofs
//! over the new mint and are tracked separately.

use b402_onchain_tests::{
    discriminator,
    harness::{
        from_spl, pda_pool_config, pda_token_config, pda_tree_state, pda_vault,
        spl_pk, sysvar_rent_id, Harness, VERSION_PREFIX,
    },
    ids, mint,
};
use solana_instruction::{AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_message::Message;
use solana_pubkey::Pubkey;
use solana_signer::Signer;
use solana_system_interface::program as system_program;
use solana_transaction::Transaction;

fn add_token_config_ix(admin: &Pubkey, mint_pk: &Pubkey, max_tvl: u64, token_program: Pubkey) -> Instruction {
    let mut data = discriminator::instruction("add_token_config").to_vec();
    data.extend_from_slice(&max_tvl.to_le_bytes());
    Instruction {
        program_id: ids::b402_pool(),
        accounts: vec![
            AccountMeta::new(*admin, true),
            AccountMeta::new_readonly(*admin, true),
            AccountMeta::new_readonly(pda_pool_config(), false),
            AccountMeta::new(pda_token_config(mint_pk), false),
            AccountMeta::new_readonly(*mint_pk, false),
            AccountMeta::new(pda_vault(mint_pk), false),
            AccountMeta::new_readonly(token_program, false),
            AccountMeta::new_readonly(from_spl(&spl_associated_token_account::ID), false),
            AccountMeta::new_readonly(system_program::ID, false),
            AccountMeta::new_readonly(sysvar_rent_id(), false),
        ],
        data,
    }
}

/// Setup the harness pointing at a fresh Token-2022 mint (no extensions).
fn setup_t22() -> Harness {
    use litesvm::LiteSVM;
    // Build a minimal harness manually since `Harness::setup` plants the
    // mint via the classic-SPL helper. We only need init_pool + airdrops
    // here; the add_token_config call is the unit under test.
    let mut svm = LiteSVM::new();
    svm.add_program_from_file(
        ids::b402_verifier_transact(),
        b402_onchain_tests::program_path("b402_verifier_transact"),
    ).expect("verifier deploy");
    svm.add_program_from_file(
        ids::b402_pool(),
        b402_onchain_tests::program_path("b402_pool"),
    ).expect("pool deploy");

    let admin = Keypair::new();
    let relayer = Keypair::new();
    let depositor = Keypair::new();
    for kp in [&admin, &relayer, &depositor] {
        svm.airdrop(&kp.pubkey(), 10_000_000_000).unwrap();
    }

    use borsh::BorshSerialize;
    #[derive(BorshSerialize)]
    struct InitPoolArgs {
        admin_multisig: [u8; 32],
        admin_threshold: u8,
        verifier_transact: [u8; 32],
        verifier_adapt: [u8; 32],
        verifier_disclose: [u8; 32],
        treasury_pubkey: [u8; 32],
    }
    let args = InitPoolArgs {
        admin_multisig: admin.pubkey().to_bytes(),
        admin_threshold: 1,
        verifier_transact: ids::b402_verifier_transact().to_bytes(),
        verifier_adapt: ids::b402_verifier_transact().to_bytes(),
        verifier_disclose: ids::b402_verifier_transact().to_bytes(),
        treasury_pubkey: admin.pubkey().to_bytes(),
    };
    let mut data = discriminator::instruction("init_pool").to_vec();
    args.serialize(&mut data).unwrap();
    let ix = Instruction {
        program_id: ids::b402_pool(),
        accounts: vec![
            AccountMeta::new(admin.pubkey(), true),
            AccountMeta::new(b402_onchain_tests::harness::pda_pool_config(), false),
            AccountMeta::new(b402_onchain_tests::harness::pda_tree_state(), false),
            AccountMeta::new(b402_onchain_tests::harness::pda_adapter_registry(), false),
            AccountMeta::new(b402_onchain_tests::harness::pda_treasury(), false),
            AccountMeta::new_readonly(system_program::ID, false),
        ],
        data,
    };
    let msg = Message::new(&[ix], Some(&admin.pubkey()));
    let tx = Transaction::new(&[&admin], msg, svm.latest_blockhash());
    svm.send_transaction(tx).expect("init_pool");

    Harness {
        svm,
        admin,
        relayer,
        depositor,
        mint: Pubkey::new_unique(), // overwritten per-test
    }
}

#[test]
fn add_token_config_accepts_t22_mint_no_extensions() {
    let mut h = setup_t22();
    let mint_pk = Pubkey::new_unique();
    h.mint = mint_pk;
    mint::plant_t22_mint_no_extensions(&mut h.svm, &mint_pk, &h.admin.pubkey(), 6);

    let ix = add_token_config_ix(
        &h.admin.pubkey(),
        &mint_pk,
        u64::MAX,
        mint::TOKEN_2022_PROGRAM_ID,
    );
    let msg = Message::new(&[ix], Some(&h.admin.pubkey()));
    let tx = Transaction::new(&[&h.admin], msg, h.svm.latest_blockhash());
    let result = h.svm.send_transaction(tx);
    assert!(
        result.is_ok(),
        "Token-2022 mint without extensions must be accepted: {:?}",
        result.err()
    );
}

// NOTE: Tests for extension-rejected cases (TransferFee, TransferHook, etc.)
// require planting the full TLV-encoded mint with the specific extension
// initialized. That goes through spl-token-2022's StateWithExtensionsMut,
// which the host-side unit tests in
// `programs/b402-pool/src/instructions/token_ext.rs` exercise directly.
// Litesvm coverage for those cases is tracked as a follow-up.

//! litesvm tests for `b402_percolator_adapter::execute`.
//!
//! Mirrors `kamino_deposit.rs` shape — drive the adapter directly via
//! litesvm without loading percolator-prog. The test proves dispatch +
//! arg validation + sign-as-owner_pda all work; the inner CPI fails
//! (because percolator-prog isn't loaded) and we assert exactly that
//! signal — proof that the adapter reached the CPI step.
//!
//! Deeper coverage (real percolator-prog state machine, real matcher
//! fills, real PnL settle) lives in slice 5 / surfpool — yak-shaving a
//! percolator stub here is the wrong tradeoff.

use b402_onchain_tests::{mint, program_path};
use borsh::BorshSerialize;
use litesvm::LiteSVM;
use solana_account::Account;
use solana_compute_budget_interface::ComputeBudgetInstruction;
use solana_instruction::{AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_message::Message;
use solana_pubkey::Pubkey;
use solana_signer::Signer;
use solana_transaction::Transaction;
use std::str::FromStr;

// ─── Constants pinned against the adapter source ───────────────────────

const PERCOLATOR_ADAPTER_ID_STR: &str = "65NRt6GpeakqXhqvKcN3knohzKEZT37arUyQi3SZwfxv";
const PERCOLATOR_PROG_ID_STR: &str = "Perco1ator111111111111111111111111111111111";
const TOKEN_PROGRAM_ID_STR: &str = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

// PercolatorAdapterError codes (mirror programs/b402-percolator-adapter/src/error.rs).
const ERR_INVALID_ACTION_PAYLOAD: u32 = 6000;
const ERR_ZERO_MARGIN: u32 = 6002;
const ERR_CLOSE_HAS_NONZERO_INPUT: u32 = 6003;
const ERR_ZERO_TRADE_SIZE: u32 = 6004;
const ERR_INVALID_LP_IDX: u32 = 6006;
const ERR_MAPPING_ENTRY_NOT_FOUND: u32 = 6009;

// PercolatorAction discriminants (mirror payload::tag).
const TAG_OPEN_POSITION: u8 = 0;
const TAG_CLOSE_POSITION: u8 = 1;

// `PERP_MAPPING_ACCOUNT_LEN` from mapping.rs: HEADER_SIZE (48) + MAX_ENTRIES (2048) * ENTRY_SIZE (40).
const PERP_MAPPING_ACCOUNT_LEN: usize = 48 + 2048 * 40;
// `SLAB_MAGIC` from slab.rs — percolator-prog writes its u64 MAGIC in native
// LE byte order; the bytes on disk read "TALOCREP" (= "PERCOLAT" reversed).
const SLAB_MAGIC_LE: [u8; 8] = *b"TALOCREP";
// Minimum slab buffer size — `verify_slab_magic` reads up to
// `HEADER_LEN` = `size_of::<SlabHeader>()` ≈ 136 bytes. Round to 256
// to leave headroom for any helper that reads farther into the header
// without forcing the test to grow.
const MIN_SLAB_LEN: usize = 256;

// `EXECUTE_DISCRIMINATOR` — anchor's sha256("global:execute")[..8]. Same
// for every program with a function named `execute` (kamino-adapter
// confirms).
const EXECUTE_DISCRIMINATOR: [u8; 8] = [130, 221, 242, 154, 13, 193, 189, 29];

// ─── ID helpers ────────────────────────────────────────────────────────

fn percolator_adapter_id() -> Pubkey {
    Pubkey::from_str(PERCOLATOR_ADAPTER_ID_STR).unwrap()
}
fn percolator_prog_id() -> Pubkey {
    Pubkey::from_str(PERCOLATOR_PROG_ID_STR).unwrap()
}
fn token_program_id() -> Pubkey {
    Pubkey::from_str(TOKEN_PROGRAM_ID_STR).unwrap()
}

fn adapter_authority() -> Pubkey {
    Pubkey::find_program_address(&[b"b402/v1", b"adapter"], &percolator_adapter_id()).0
}
fn derive_owner_pda(viewing_pub_hash: &[u8; 32]) -> (Pubkey, u8) {
    Pubkey::find_program_address(
        &[b"b402/v1", b"perp-owner", viewing_pub_hash.as_ref()],
        &percolator_adapter_id(),
    )
}
fn derive_mapping_pda(slab: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(
        &[b"b402/v1", b"perp-mapping", slab.as_ref()],
        &percolator_adapter_id(),
    )
}

// ─── Action payload builders ───────────────────────────────────────────

fn encode_open(
    viewing_pub_hash: &[u8; 32],
    lp_idx: u16,
    size_e6: i128,
    limit_price_e6: u64,
    fee_payment_if_init: u64,
) -> Vec<u8> {
    // [viewing_pub_hash (32B), tag (1B), lp_idx (2B LE), size_e6 (16B LE),
    //  limit_price_e6 (8B LE), fee_payment_if_init (8B LE)]
    let mut v = Vec::with_capacity(32 + 1 + 2 + 16 + 8 + 8);
    v.extend_from_slice(viewing_pub_hash);
    v.push(TAG_OPEN_POSITION);
    v.extend_from_slice(&lp_idx.to_le_bytes());
    v.extend_from_slice(&size_e6.to_le_bytes());
    v.extend_from_slice(&limit_price_e6.to_le_bytes());
    v.extend_from_slice(&fee_payment_if_init.to_le_bytes());
    v
}

fn encode_close(
    viewing_pub_hash: &[u8; 32],
    lp_idx: u16,
    limit_price_e6: u64,
) -> Vec<u8> {
    // [viewing_pub_hash (32B), tag (1B), lp_idx (2B LE), limit_price_e6 (8B LE)]
    let mut v = Vec::with_capacity(32 + 1 + 2 + 8);
    v.extend_from_slice(viewing_pub_hash);
    v.push(TAG_CLOSE_POSITION);
    v.extend_from_slice(&lp_idx.to_le_bytes());
    v.extend_from_slice(&limit_price_e6.to_le_bytes());
    v
}

#[derive(BorshSerialize)]
struct ExecuteArgs {
    in_amount: u64,
    min_out_amount: u64,
    action_payload: Vec<u8>,
}

// ─── Setup ─────────────────────────────────────────────────────────────

struct Setup {
    svm: LiteSVM,
    caller: Keypair,
    in_mint: Pubkey,
    in_vault: Pubkey,
    adapter_in_ta: Pubkey,
    out_vault: Pubkey,
    adapter_out_ta: Pubkey,
    /// Synthetic slab account with valid SLAB_MAGIC.
    slab: Pubkey,
    /// Initialized empty mapping at the per-slab PDA.
    mapping: Pubkey,
    /// Synthetic viewing_pub_hash + derived owner_pda + bump.
    viewing_pub_hash: [u8; 32],
    owner_pda: Pubkey,
    /// owner_pda's USDC ATA (the "user_percolator_ata" in the open path).
    user_pcl_ata: Pubkey,
}

fn fresh_svm() -> Setup {
    let mut svm = LiteSVM::new();
    svm.add_program_from_file(percolator_adapter_id(), program_path("b402_percolator_adapter"))
        .expect("deploy percolator adapter");

    let caller = Keypair::new();
    svm.airdrop(&caller.pubkey(), 10_000_000_000).unwrap();

    let auth = adapter_authority();

    // USDC stand-in mint + scratch ATAs at deterministic pubkeys.
    let in_mint = Pubkey::new_from_array([0xA1; 32]);
    mint::plant_mint(&mut svm, &in_mint, &caller.pubkey(), 6);

    let in_vault = Pubkey::new_from_array([0xB1; 32]);
    mint::plant_token_account(&mut svm, &in_vault, &in_mint, &caller.pubkey(), 0);

    let adapter_in_ta = Pubkey::new_from_array([0xC1; 32]);
    mint::plant_token_account(&mut svm, &adapter_in_ta, &in_mint, &auth, 1_000_000);

    let out_vault = Pubkey::new_from_array([0xB2; 32]);
    mint::plant_token_account(&mut svm, &out_vault, &in_mint, &caller.pubkey(), 0);

    let adapter_out_ta = Pubkey::new_from_array([0xC2; 32]);
    mint::plant_token_account(&mut svm, &adapter_out_ta, &in_mint, &auth, 0);

    // Slab — minimal. percolator-prog would own a real slab account; we
    // plant a 96-byte buffer with the right MAGIC to satisfy the
    // adapter's slab::verify_slab_magic check. The Solana account
    // owner is set to percolator_prog so future deeper tests can add a
    // real percolator slab — for the dispatch tests, this is purely
    // metadata.
    let slab = Pubkey::new_from_array([0xD0; 32]);
    let mut slab_data = vec![0u8; MIN_SLAB_LEN];
    slab_data[0..8].copy_from_slice(&SLAB_MAGIC_LE);
    svm.set_account(
        slab,
        Account {
            lamports: 1_000_000_000,
            data: slab_data,
            owner: percolator_prog_id(),
            executable: false,
            rent_epoch: 0,
        },
    )
    .unwrap();

    // Mapping — initialized at the right PDA. Empty entries.
    let (mapping, _bump) = derive_mapping_pda(&slab);
    let mut mapping_data = vec![0u8; PERP_MAPPING_ACCOUNT_LEN];
    // Header: bump (1) + pad (7) + slab pubkey (32) + ... — leave zero,
    // initialize() in the adapter is idempotent and accepts a zero slab
    // field as fresh-init. Mapping lookup against zero entry_count
    // returns None.
    svm.set_account(
        mapping,
        Account {
            lamports: 1_000_000_000,
            data: mapping_data.clone(),
            owner: percolator_adapter_id(),
            executable: false,
            rent_epoch: 0,
        },
    )
    .unwrap();
    let _ = mapping_data;

    // Viewing pub hash + owner_pda + ATA for the user.
    let viewing_pub_hash = [0x42u8; 32];
    let (owner_pda, _bump) = derive_owner_pda(&viewing_pub_hash);
    let user_pcl_ata = Pubkey::new_from_array([0xE0; 32]);
    mint::plant_token_account(&mut svm, &user_pcl_ata, &in_mint, &owner_pda, 0);

    Setup {
        svm,
        caller,
        in_mint,
        in_vault,
        adapter_in_ta,
        out_vault,
        adapter_out_ta,
        slab,
        mapping,
        viewing_pub_hash,
        owner_pda,
        user_pcl_ata,
    }
}

fn send_execute(
    setup: &mut Setup,
    in_amount: u64,
    min_out_amount: u64,
    action_payload: Vec<u8>,
) -> Result<(), litesvm::types::FailedTransactionMetadata> {
    let args = ExecuteArgs {
        in_amount,
        min_out_amount,
        action_payload,
    };
    let mut data = EXECUTE_DISCRIMINATOR.to_vec();
    args.serialize(&mut data).unwrap();

    // Named accounts (Execute<'info>). Order matches the struct.
    let mut accounts = vec![
        AccountMeta::new(adapter_authority(), false),
        AccountMeta::new(setup.in_vault, false),
        AccountMeta::new(setup.out_vault, false),
        AccountMeta::new(setup.adapter_in_ta, false),
        AccountMeta::new(setup.adapter_out_ta, false),
        AccountMeta::new_readonly(token_program_id(), false),
    ];
    // Variadic remaining_accounts at pinned offsets (open.rs RA_*).
    let lp_owner = Pubkey::new_from_array([0xF0; 32]);
    let oracle = Pubkey::new_from_array([0xF1; 32]);
    let matcher_program = Pubkey::new_from_array([0xF2; 32]);
    let matcher_context = Pubkey::new_from_array([0xF3; 32]);
    let lp_pda = Pubkey::new_from_array([0xF4; 32]);
    let clock = Pubkey::from_str("SysvarC1ock11111111111111111111111111111111").unwrap();
    let slab_vault = Pubkey::new_from_array([0xF5; 32]);
    accounts.extend(vec![
        AccountMeta::new(setup.mapping, false),         // 0 RA_MAPPING
        AccountMeta::new(setup.owner_pda, false),       // 1 RA_OWNER_PDA
        AccountMeta::new(setup.user_pcl_ata, false),    // 2 RA_USER_PERCOLATOR_ATA
        AccountMeta::new(setup.slab, false),            // 3 RA_SLAB
        AccountMeta::new(slab_vault, false),            // 4 RA_SLAB_VAULT
        AccountMeta::new_readonly(percolator_prog_id(), false), // 5 RA_PERCOLATOR_PROGRAM
        AccountMeta::new_readonly(clock, false),        // 6 RA_CLOCK
        AccountMeta::new_readonly(lp_owner, false),     // 7 RA_LP_OWNER
        AccountMeta::new_readonly(oracle, false),       // 8 RA_ORACLE
        AccountMeta::new_readonly(matcher_program, false), // 9 RA_MATCHER_PROGRAM
        AccountMeta::new(matcher_context, false),       // 10 RA_MATCHER_CONTEXT
        AccountMeta::new_readonly(lp_pda, false),       // 11 RA_LP_PDA
        AccountMeta::new_readonly(setup.slab, false),   // 12 RA_SLAB_VAULT_AUTHORITY (placeholder; close-only)
    ]);

    let ix = Instruction {
        program_id: percolator_adapter_id(),
        accounts,
        data,
    };
    let cu = ComputeBudgetInstruction::set_compute_unit_limit(400_000);
    let msg = Message::new(&[cu, ix], Some(&setup.caller.pubkey()));
    let tx = Transaction::new(&[&setup.caller], msg, setup.svm.latest_blockhash());
    setup.svm.send_transaction(tx).map(|_| ())
}

fn err_code_hex(code: u32) -> String {
    format!("0x{code:x}")
}

// ─── Tests ─────────────────────────────────────────────────────────────

#[test]
fn open_dispatches_and_attempts_percolator_cpi() {
    let mut setup = fresh_svm();
    let payload = encode_open(&setup.viewing_pub_hash, 7, 1_500_000, 200_000_000, 1000);

    let res = send_execute(&mut setup, 100_000, 0, payload);

    assert!(res.is_err(), "expected revert (no percolator-prog loaded)");
    let err = res.unwrap_err();
    let logs = err.meta.logs.join("\n");

    // The adapter reaches `allocate_fresh_slot` → invoke_init_user →
    // fails because percolator-prog isn't loaded. litesvm signals this
    // as "Unsupported program id" (newer version) or "Unknown program
    // <id>" / "Instruction references an unknown account <id>" (older
    // versions). Any of these proves dispatch + Borsh decode + arg
    // validation + sign-as-owner_pda all worked through to the
    // unloaded-program rejection.
    let saw_unsupported = logs.contains("Unsupported program id");
    let saw_unknown_program = logs.contains(&format!(
        "Unknown program {PERCOLATOR_PROG_ID_STR}"
    ));
    let saw_unknown_account = logs.contains(&format!(
        "Instruction references an unknown account {PERCOLATOR_PROG_ID_STR}"
    ));
    assert!(
        saw_unsupported || saw_unknown_program || saw_unknown_account,
        "expected runtime to reject the CPI to percolator-prog; logs:\n{logs}"
    );
    // Negative: handler must NOT short-circuit on validation.
    assert!(
        !logs.contains(&err_code_hex(ERR_INVALID_ACTION_PAYLOAD))
            && !logs.contains(&err_code_hex(ERR_ZERO_TRADE_SIZE))
            && !logs.contains(&err_code_hex(ERR_INVALID_LP_IDX)),
        "validator must not have rejected this valid open payload; logs:\n{logs}"
    );
    let _ = (setup.in_mint, setup.in_vault, setup.adapter_in_ta, setup.adapter_out_ta, setup.out_vault);
}

#[test]
fn invalid_payload_rejected_before_cpi() {
    let mut setup = fresh_svm();
    // Garbage payload — no per-user prefix and the inner discriminant is
    // unknown. peek_variant_tag returns InvalidActionPayload.
    let res = send_execute(&mut setup, 100, 0, vec![0xff; 33]);

    assert!(res.is_err());
    let err = res.unwrap_err();
    let logs = err.meta.logs.join("\n");
    assert!(
        logs.contains(&err_code_hex(ERR_INVALID_ACTION_PAYLOAD))
            || logs.contains("InvalidActionPayload"),
        "expected InvalidActionPayload; logs:\n{logs}"
    );
}

#[test]
fn zero_in_amount_rejected_on_open() {
    let mut setup = fresh_svm();
    let payload = encode_open(&setup.viewing_pub_hash, 0, 1, 0, 0);
    let res = send_execute(&mut setup, 0, 0, payload);
    assert!(res.is_err());
    let logs = res.unwrap_err().meta.logs.join("\n");
    assert!(
        logs.contains(&err_code_hex(ERR_ZERO_MARGIN)) || logs.contains("ZeroMargin"),
        "expected ZeroMargin; logs:\n{logs}"
    );
}

#[test]
fn zero_size_rejected_on_open() {
    let mut setup = fresh_svm();
    let payload = encode_open(&setup.viewing_pub_hash, 0, 0, 0, 0);
    let res = send_execute(&mut setup, 1000, 0, payload);
    assert!(res.is_err());
    let logs = res.unwrap_err().meta.logs.join("\n");
    assert!(
        logs.contains(&err_code_hex(ERR_ZERO_TRADE_SIZE)) || logs.contains("ZeroTradeSize"),
        "expected ZeroTradeSize; logs:\n{logs}"
    );
}

#[test]
fn lp_idx_beyond_max_rejected_on_open() {
    let mut setup = fresh_svm();
    let payload = encode_open(&setup.viewing_pub_hash, 9999, 1, 0, 0);
    let res = send_execute(&mut setup, 1000, 0, payload);
    assert!(res.is_err());
    let logs = res.unwrap_err().meta.logs.join("\n");
    assert!(
        logs.contains(&err_code_hex(ERR_INVALID_LP_IDX)) || logs.contains("InvalidLpIdx"),
        "expected InvalidLpIdx; logs:\n{logs}"
    );
}

#[test]
fn close_with_nonzero_input_rejected() {
    let mut setup = fresh_svm();
    let payload = encode_close(&setup.viewing_pub_hash, 0, 0);
    let res = send_execute(&mut setup, 1, 0, payload);
    assert!(res.is_err());
    let logs = res.unwrap_err().meta.logs.join("\n");
    assert!(
        logs.contains(&err_code_hex(ERR_CLOSE_HAS_NONZERO_INPUT))
            || logs.contains("CloseHasNonzeroInput"),
        "expected CloseHasNonzeroInput; logs:\n{logs}"
    );
}

#[test]
fn close_with_no_mapping_entry_rejects() {
    let mut setup = fresh_svm();
    let payload = encode_close(&setup.viewing_pub_hash, 0, 0);
    let res = send_execute(&mut setup, 0, 0, payload);
    assert!(res.is_err());
    let logs = res.unwrap_err().meta.logs.join("\n");
    assert!(
        logs.contains(&err_code_hex(ERR_MAPPING_ENTRY_NOT_FOUND))
            || logs.contains("MappingEntryNotFound"),
        "expected MappingEntryNotFound; logs:\n{logs}"
    );
}

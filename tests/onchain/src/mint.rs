//! Plant SPL Mint and Token accounts at arbitrary addresses via litesvm's
//! `set_account`. Uses the new split `solana_*` crates; converts between
//! litesvm's `solana_pubkey::Pubkey` and `spl_token`'s internal pubkey type
//! at the boundary (different crate types, identical byte layout).

use litesvm::LiteSVM;
use solana_account::Account;
use solana_pubkey::Pubkey;

use spl_token::{
    state::{Account as TokenAccount, AccountState, Mint},
    solana_program::{program_option::COption, program_pack::Pack},
    ID as TOKEN_PROGRAM_ID,
};

type SplPubkey = spl_token::solana_program::pubkey::Pubkey;

fn to_spl(p: &Pubkey) -> SplPubkey {
    SplPubkey::new_from_array(p.to_bytes())
}
fn from_spl(p: &SplPubkey) -> Pubkey {
    Pubkey::new_from_array(p.to_bytes())
}

pub fn plant_mint(svm: &mut LiteSVM, mint: &Pubkey, mint_authority: &Pubkey, decimals: u8) {
    let mut data = vec![0u8; Mint::LEN];
    let m = Mint {
        mint_authority: COption::Some(to_spl(mint_authority)),
        supply: 0,
        decimals,
        is_initialized: true,
        freeze_authority: COption::None,
    };
    m.pack_into_slice(&mut data);
    svm.set_account(*mint, Account {
        lamports: 1_461_600,
        data,
        owner: from_spl(&TOKEN_PROGRAM_ID),
        executable: false,
        rent_epoch: 0,
    }).unwrap();
}

pub fn plant_token_account(
    svm: &mut LiteSVM,
    ata: &Pubkey,
    mint: &Pubkey,
    owner: &Pubkey,
    amount: u64,
) {
    let mut data = vec![0u8; TokenAccount::LEN];
    let acct = TokenAccount {
        mint: to_spl(mint),
        owner: to_spl(owner),
        amount,
        delegate: COption::None,
        state: AccountState::Initialized,
        is_native: COption::None,
        delegated_amount: 0,
        close_authority: COption::None,
    };
    acct.pack_into_slice(&mut data);
    svm.set_account(*ata, Account {
        lamports: 2_039_280,
        data,
        owner: from_spl(&TOKEN_PROGRAM_ID),
        executable: false,
        rent_epoch: 0,
    }).unwrap();
}

// ----------------------------------------------------------------------
// Token-2022 helpers. Used by the Token-2022 migration tests; non-Token-2022
// flows keep using the helpers above unchanged.
// ----------------------------------------------------------------------

/// Token-2022 program ID — `TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb`.
/// Hardcoded as raw bytes so we don't pull in spl-token-2022 just for the ID.
pub const TOKEN_2022_PROGRAM_ID: Pubkey = Pubkey::new_from_array([
    0x06, 0xdd, 0xf6, 0xe1, 0xee, 0x75, 0x8f, 0xde, 0x18, 0x42, 0x5d, 0xbc, 0xe4, 0x6c, 0xcd, 0xda,
    0xb6, 0x1a, 0xfc, 0x4d, 0x83, 0xb9, 0x0d, 0x27, 0xfe, 0xbd, 0xf9, 0x28, 0xd8, 0xa1, 0x8b, 0xfc,
]);

/// Plant a vanilla Token-2022 mint (no extensions) at an arbitrary address.
/// Mirrors `plant_mint` but stamps the account's `owner` field with the
/// Token-2022 program ID so `InterfaceAccount<Mint>` resolves through the
/// Token-2022 program path.
pub fn plant_t22_mint_no_extensions(
    svm: &mut LiteSVM,
    mint: &Pubkey,
    mint_authority: &Pubkey,
    decimals: u8,
) {
    // Token-2022 vanilla mints share the same on-chain byte layout as
    // classic SPL mints (the extension TLV section is empty). What
    // differs is the `Account::owner` pubkey on the SVM side.
    let mut data = vec![0u8; Mint::LEN];
    let m = Mint {
        mint_authority: COption::Some(to_spl(mint_authority)),
        supply: 0,
        decimals,
        is_initialized: true,
        freeze_authority: COption::None,
    };
    m.pack_into_slice(&mut data);
    svm.set_account(*mint, Account {
        lamports: 1_461_600,
        data,
        owner: TOKEN_2022_PROGRAM_ID,
        executable: false,
        rent_epoch: 0,
    }).unwrap();
}

/// Plant a Token-2022 TokenAccount owned by `owner`. Identical layout to
/// the classic ATA; only the SVM account `owner` differs.
pub fn plant_t22_token_account(
    svm: &mut LiteSVM,
    ata: &Pubkey,
    mint: &Pubkey,
    owner: &Pubkey,
    amount: u64,
) {
    let mut data = vec![0u8; TokenAccount::LEN];
    let acct = TokenAccount {
        mint: to_spl(mint),
        owner: to_spl(owner),
        amount,
        delegate: COption::None,
        state: AccountState::Initialized,
        is_native: COption::None,
        delegated_amount: 0,
        close_authority: COption::None,
    };
    acct.pack_into_slice(&mut data);
    svm.set_account(*ata, Account {
        lamports: 2_039_280,
        data,
        owner: TOKEN_2022_PROGRAM_ID,
        executable: false,
        rent_epoch: 0,
    }).unwrap();
}

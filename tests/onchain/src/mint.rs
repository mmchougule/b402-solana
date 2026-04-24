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

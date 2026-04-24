//! Shared on-chain test harness. Wraps litesvm + program deploy + init flow so
//! each `#[test]` stays focused on the scenario it's exercising.

use borsh::BorshSerialize;
use litesvm::LiteSVM;
use solana_instruction::{AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_message::Message;
use solana_pubkey::Pubkey;
use solana_signer::Signer;
use solana_system_interface::program as system_program;
use solana_transaction::Transaction;

use crate::{discriminator, ids, mint, program_path};

pub const VERSION_PREFIX: &[u8] = b"b402/v1";

pub fn pda(seeds: &[&[u8]]) -> Pubkey {
    Pubkey::find_program_address(seeds, &ids::b402_pool()).0
}
pub fn pda_pool_config() -> Pubkey { pda(&[VERSION_PREFIX, b"config"]) }
pub fn pda_tree_state()  -> Pubkey { pda(&[VERSION_PREFIX, b"tree"]) }
pub fn pda_adapter_registry() -> Pubkey { pda(&[VERSION_PREFIX, b"adapters"]) }
pub fn pda_treasury()   -> Pubkey { pda(&[VERSION_PREFIX, b"treasury"]) }
pub fn pda_token_config(mint: &Pubkey) -> Pubkey { pda(&[VERSION_PREFIX, b"token", mint.as_ref()]) }
pub fn pda_vault(mint: &Pubkey) -> Pubkey { pda(&[VERSION_PREFIX, b"vault", mint.as_ref()]) }

pub fn spl_pk(p: &Pubkey) -> spl_token::solana_program::pubkey::Pubkey {
    spl_token::solana_program::pubkey::Pubkey::new_from_array(p.to_bytes())
}
pub fn from_spl(p: &spl_token::solana_program::pubkey::Pubkey) -> Pubkey {
    Pubkey::new_from_array(p.to_bytes())
}
pub fn sysvar_rent_id() -> Pubkey {
    Pubkey::new_from_array([
        0x06, 0xa7, 0xd5, 0x17, 0x19, 0x2c, 0x5c, 0x51, 0x21, 0x8c, 0xc9, 0x4c, 0x3d, 0x4a, 0xf1,
        0x7f, 0x58, 0xda, 0xee, 0x08, 0x9b, 0xa1, 0xfd, 0x44, 0xe3, 0xdb, 0xd9, 0x8a, 0x00, 0x00,
        0x00, 0x00,
    ])
}

#[derive(BorshSerialize)]
pub struct InitPoolArgs {
    pub admin_multisig: [u8; 32],
    pub admin_threshold: u8,
    pub verifier_transact: [u8; 32],
    pub verifier_adapt: [u8; 32],
    pub verifier_disclose: [u8; 32],
    pub treasury_pubkey: [u8; 32],
}

pub struct Harness {
    pub svm: LiteSVM,
    pub admin: Keypair,
    pub relayer: Keypair,
    pub depositor: Keypair,
    pub mint: Pubkey,
}

impl Harness {
    /// Fresh VM + deploy programs + init_pool + add_token_config + fund depositor.
    pub fn setup(mint: Pubkey, depositor_balance: u64) -> Self {
        let mut svm = LiteSVM::new();

        svm.add_program_from_file(
            ids::b402_verifier_transact(), program_path("b402_verifier_transact"),
        ).expect("deploy verifier");
        svm.add_program_from_file(
            ids::b402_pool(), program_path("b402_pool"),
        ).expect("deploy pool");

        let admin = Keypair::new();
        let relayer = Keypair::new();
        let depositor = Keypair::new();
        for kp in [&admin, &relayer, &depositor] {
            svm.airdrop(&kp.pubkey(), 10_000_000_000).unwrap();
        }

        // init_pool
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

        // Plant mint + token config
        mint::plant_mint(&mut svm, &mint, &admin.pubkey(), 6);
        let data = discriminator::instruction("add_token_config").to_vec();
        let ix = Instruction {
            program_id: ids::b402_pool(),
            accounts: vec![
                AccountMeta::new(admin.pubkey(), true),
                AccountMeta::new_readonly(admin.pubkey(), true),
                AccountMeta::new_readonly(pda_pool_config(), false),
                AccountMeta::new(pda_token_config(&mint), false),
                AccountMeta::new_readonly(mint, false),
                AccountMeta::new(pda_vault(&mint), false),
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

        // Fund depositor
        let depositor_ata = from_spl(
            &spl_associated_token_account::get_associated_token_address(
                &spl_pk(&depositor.pubkey()),
                &spl_pk(&mint),
            ),
        );
        mint::plant_token_account(&mut svm, &depositor_ata, &mint, &depositor.pubkey(), depositor_balance);

        Self { svm, admin, relayer, depositor, mint }
    }

    pub fn depositor_ata(&self) -> Pubkey {
        from_spl(
            &spl_associated_token_account::get_associated_token_address(
                &spl_pk(&self.depositor.pubkey()),
                &spl_pk(&self.mint),
            ),
        )
    }

    pub fn vault_balance(&self) -> u64 {
        use spl_token::solana_program::program_pack::Pack;
        let data = self.svm.get_account(&pda_vault(&self.mint)).unwrap().data;
        spl_token::state::Account::unpack(&data).unwrap().amount
    }

    pub fn depositor_balance(&self) -> u64 {
        use spl_token::solana_program::program_pack::Pack;
        let data = self.svm.get_account(&self.depositor_ata()).unwrap().data;
        spl_token::state::Account::unpack(&data).unwrap().amount
    }

    pub fn tree_leaf_count(&self) -> u64 {
        let data = self.svm.get_account(&pda_tree_state()).unwrap().data;
        u64::from_le_bytes(data[16..24].try_into().unwrap())
    }
}

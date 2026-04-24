//! Build and submit shield instructions. Reusable across tests.

use borsh::{BorshDeserialize, BorshSerialize};
use litesvm::types::FailedTransactionMetadata;
use solana_compute_budget_interface::ComputeBudgetInstruction;
use solana_instruction::{AccountMeta, Instruction};
use solana_message::Message;
use solana_pubkey::Pubkey;
use solana_signer::Signer;
use solana_system_interface::program as system_program;
use solana_transaction::Transaction;

use crate::{
    discriminator,
    fixtures::ShieldFixture,
    harness::{from_spl, pda_pool_config, pda_token_config, pda_tree_state, pda_vault, Harness},
    ids,
};

#[derive(BorshSerialize, BorshDeserialize, Clone, Debug)]
pub struct TransactPublicInputs {
    pub merkle_root: [u8; 32],
    pub nullifier: [[u8; 32]; 2],
    pub commitment_out: [[u8; 32]; 2],
    pub public_amount_in: u64,
    pub public_amount_out: u64,
    pub public_token_mint: [u8; 32],
    pub relayer_fee: u64,
    pub relayer_fee_bind: [u8; 32],
    pub root_bind: [u8; 32],
    pub recipient_bind: [u8; 32],
}

#[derive(BorshSerialize, BorshDeserialize, Clone, Debug)]
pub struct EncryptedNote {
    pub ciphertext: [u8; 89],
    pub ephemeral_pub: [u8; 32],
    pub viewing_tag: [u8; 2],
}

#[derive(BorshSerialize, BorshDeserialize, Clone, Debug)]
pub struct ShieldArgs {
    pub proof: Vec<u8>,
    pub public_inputs: TransactPublicInputs,
    pub encrypted_notes: Vec<EncryptedNote>,
    pub note_dummy_mask: u8,
}

impl ShieldArgs {
    /// Build args from a fixture with the pool's expected mint.
    pub fn from_fixture(fx: &ShieldFixture, mint: &Pubkey) -> Self {
        let pi = fx.public_inputs_le();
        let public_amount_in = u64::from_le_bytes(pi[5][..8].try_into().unwrap());
        let empty = EncryptedNote {
            ciphertext: [0u8; 89],
            ephemeral_pub: [0u8; 32],
            viewing_tag: [0u8; 2],
        };
        Self {
            proof: fx.proof_bytes(),
            public_inputs: TransactPublicInputs {
                merkle_root: pi[0],
                nullifier: [pi[1], pi[2]],
                commitment_out: [pi[3], pi[4]],
                public_amount_in,
                public_amount_out: 0,
                public_token_mint: mint.to_bytes(),
                relayer_fee: 0,
                relayer_fee_bind: pi[9],
                root_bind: pi[10],
                recipient_bind: pi[11],
            },
            encrypted_notes: vec![empty.clone(), empty],
            note_dummy_mask: 0b10,
        }
    }
}

/// Send a shield tx. Returns `Ok(())` on success, `Err(meta)` on failure for
/// granular rejection assertions.
pub fn send_shield(
    h: &mut Harness,
    args: ShieldArgs,
) -> Result<(), FailedTransactionMetadata> {
    let mut data = discriminator::instruction("shield").to_vec();
    args.serialize(&mut data).unwrap();

    let ix = Instruction {
        program_id: ids::b402_pool(),
        accounts: vec![
            AccountMeta::new(h.relayer.pubkey(), true),
            AccountMeta::new(h.depositor.pubkey(), true),
            AccountMeta::new(h.depositor_ata(), false),
            AccountMeta::new_readonly(pda_token_config(&h.mint), false),
            AccountMeta::new(pda_vault(&h.mint), false),
            AccountMeta::new(pda_tree_state(), false),
            AccountMeta::new_readonly(pda_pool_config(), false),
            AccountMeta::new_readonly(ids::b402_verifier_transact(), false),
            AccountMeta::new_readonly(from_spl(&spl_token::ID), false),
            AccountMeta::new_readonly(system_program::ID, false),
        ],
        data,
    };
    let cu = ComputeBudgetInstruction::set_compute_unit_limit(1_400_000);
    let msg = Message::new(&[cu, ix], Some(&h.relayer.pubkey()));
    let tx = Transaction::new(&[&h.relayer, &h.depositor], msg, h.svm.latest_blockhash());
    h.svm.send_transaction(tx).map(|_| ())
}

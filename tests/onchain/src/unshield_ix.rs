//! Build and submit unshield instructions.

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
    harness::{from_spl, pda_pool_config, pda_token_config, pda_tree_state, pda_vault, Harness, VERSION_PREFIX},
    ids,
};
use crate::shield_ix::{EncryptedNote, TransactPublicInputs};

#[derive(BorshSerialize, BorshDeserialize, Clone, Debug)]
pub struct UnshieldArgs {
    pub proof: Vec<u8>,
    pub public_inputs: TransactPublicInputs,
    pub encrypted_notes: Vec<EncryptedNote>,
    pub in_dummy_mask: u8,
    pub out_dummy_mask: u8,
    pub nullifier_shard_prefix: [u16; 2],
    pub relayer_fee_recipient: [u8; 32],
}

impl UnshieldArgs {
    pub fn from_fixture(fx: &ShieldFixture, mint: &Pubkey) -> Self {
        let pi = fx.public_inputs_le();
        let public_amount_out = u64::from_le_bytes(pi[6][..8].try_into().unwrap());
        let empty = EncryptedNote {
            ciphertext: [0u8; 89],
            ephemeral_pub: [0u8; 32],
            viewing_tag: [0u8; 2],
        };

        // Shard prefix = high 16 bits of nullifier[0] in LE encoding (pool util::shard_prefix).
        let n0 = pi[1];
        let prefix0 = u16::from_le_bytes([n0[30], n0[31]]);

        Self {
            proof: fx.proof_bytes(),
            public_inputs: TransactPublicInputs {
                merkle_root: pi[0],
                nullifier: [pi[1], pi[2]],
                commitment_out: [pi[3], pi[4]],
                public_amount_in: 0,
                public_amount_out,
                public_token_mint: mint.to_bytes(),
                relayer_fee: 0,
                relayer_fee_bind: pi[9],
                root_bind: pi[10],
                recipient_bind: pi[11],
            },
            encrypted_notes: vec![empty.clone(), empty],
            in_dummy_mask: 0b10,   // nullifier[0] real, nullifier[1] dummy
            out_dummy_mask: 0b11,  // no change notes
            nullifier_shard_prefix: [prefix0, 0],
            relayer_fee_recipient: [0u8; 32],
        }
    }
}

fn pda_nullifier_shard(prefix: u16) -> Pubkey {
    Pubkey::find_program_address(
        &[VERSION_PREFIX, b"null", &prefix.to_le_bytes()],
        &ids::b402_pool(),
    ).0
}

pub fn send_unshield(
    h: &mut Harness,
    args: UnshieldArgs,
    recipient_ata: Pubkey,
) -> Result<(), FailedTransactionMetadata> {
    let mut data = discriminator::instruction("unshield").to_vec();
    args.serialize(&mut data).unwrap();

    // Relayer fee ATA — when fee=0 we still need an account; reuse recipient's ATA.
    let fee_ata = recipient_ata;

    let shard_0 = pda_nullifier_shard(args.nullifier_shard_prefix[0]);
    let shard_1 = pda_nullifier_shard(args.nullifier_shard_prefix[1]);

    let ix = Instruction {
        program_id: ids::b402_pool(),
        accounts: vec![
            AccountMeta::new(h.relayer.pubkey(), true),
            AccountMeta::new_readonly(pda_pool_config(), false),
            AccountMeta::new_readonly(pda_token_config(&h.mint), false),
            AccountMeta::new(pda_vault(&h.mint), false),
            AccountMeta::new(recipient_ata, false),
            AccountMeta::new(fee_ata, false),
            AccountMeta::new(pda_tree_state(), false),
            AccountMeta::new_readonly(ids::b402_verifier_transact(), false),
            AccountMeta::new(shard_0, false),
            AccountMeta::new(shard_1, false),
            AccountMeta::new_readonly(from_spl(&spl_token::ID), false),
            AccountMeta::new_readonly(system_program::ID, false),
        ],
        data,
    };
    let cu = ComputeBudgetInstruction::set_compute_unit_limit(1_400_000);
    let msg = Message::new(&[cu, ix], Some(&h.relayer.pubkey()));
    let tx = Transaction::new(&[&h.relayer], msg, h.svm.latest_blockhash());
    h.svm.send_transaction(tx).map(|_| ())
}

/// Expose the computed shard PDA for tests that want to inspect state.
pub fn shard_pda(prefix: u16) -> Pubkey {
    pda_nullifier_shard(prefix)
}

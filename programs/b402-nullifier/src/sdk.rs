//! SDK for building nullifier instructions.
//!
//! Provides helpers for fetching validity proofs and building instructions
//! that work with any `Rpc`-compatible client (LightProgramTest or LightClient).

use light_program_test::{AddressWithTree, Indexer, Rpc, RpcError};
use light_sdk::{
    address::v2::derive_address,
    instruction::{PackedAccounts, PackedAddressTreeInfo, SystemAccountMetaConfig, ValidityProof},
};
use solana_sdk::{
    instruction::{AccountMeta, Instruction},
    pubkey::Pubkey,
};

/// The deployed program ID.
pub const PROGRAM_ID: Pubkey = crate::ID;

/// Returns the address tree pubkey (static for v2).
pub fn address_tree() -> Pubkey {
    Pubkey::new_from_array(light_sdk::constants::ADDRESS_TREE_V2)
}

/// Output queue pubkey (V2 batch queue 5: oq5oh5ZR3yGomuQgFduNDzjtGvVWfDRGLuDVjv9a96P).
pub fn output_queue() -> Pubkey {
    solana_sdk::pubkey!("oq5oh5ZR3yGomuQgFduNDzjtGvVWfDRGLuDVjv9a96P")
}

/// Derives the nullifier address for a given ID. Must use the same domain-
/// tagged seed (`SEED_NULL = b"b402/v1/null"`) as the on-chain handler in
/// `lib.rs::create_nullifier`, otherwise SDK-derived addresses won't match
/// the addresses the program actually inserts.
pub fn derive_nullifier_address(id: &[u8; 32]) -> [u8; 32] {
    let (address, _) = derive_address(&[crate::SEED_NULL, id], &address_tree(), &PROGRAM_ID);
    address
}

/// Result from fetching validity proof - contains all data needed to build the instruction.
pub struct ProofResult {
    pub proof: ValidityProof,
    pub address_tree_info: PackedAddressTreeInfo,
    pub output_state_tree_index: u8,
    pub remaining_accounts: Vec<AccountMeta>,
}

/// Fetches validity proof and packs accounts for a nullifier creation.
///
/// Works with any `Rpc + Indexer` client (LightProgramTest or LightClient).
pub async fn fetch_proof<R: Rpc + Indexer>(rpc: &mut R, id: &[u8; 32]) -> Result<ProofResult, RpcError> {
    let address = derive_nullifier_address(id);
    let tree = address_tree();

    let config = SystemAccountMetaConfig::new(PROGRAM_ID);
    let mut packed = PackedAccounts::default();
    packed.add_system_accounts_v2(config)?;

    let rpc_result = rpc
        .get_validity_proof(vec![], vec![AddressWithTree { address, tree }], None)
        .await?
        .value;

    let tree_infos = rpc_result.pack_tree_infos(&mut packed);

    // Hardcode output queue (oq5) - index 1 in packed accounts after address tree
    let output_state_tree_index = packed.insert_or_get(output_queue());

    let (remaining_accounts, _, _) = packed.to_account_metas();

    Ok(ProofResult {
        proof: rpc_result.proof,
        address_tree_info: tree_infos.address_trees[0],
        output_state_tree_index,
        remaining_accounts,
    })
}

/// Builds the create_nullifier instruction from proof data.
///
/// This is sync and requires no RPC calls.
pub fn build_instruction(payer: Pubkey, id: [u8; 32], proof_result: ProofResult) -> Instruction {
    use anchor_lang::InstructionData;

    let data = crate::instruction::CreateNullifier {
        proof: proof_result.proof,
        address_tree_info: proof_result.address_tree_info,
        output_state_tree_index: proof_result.output_state_tree_index,
        id,
    }
    .data();

    let mut accounts = vec![AccountMeta::new(payer, true)];
    accounts.extend(proof_result.remaining_accounts);

    Instruction {
        program_id: PROGRAM_ID,
        accounts,
        data,
    }
}

/// Creates a nullifier instruction in one call.
///
/// Combines `fetch_proof` and `build_instruction` for convenience.
/// Works with any `Rpc + Indexer` client (LightProgramTest or LightClient).
pub async fn create_nullifier_ix<R: Rpc + Indexer>(
    rpc: &mut R,
    payer: Pubkey,
    id: [u8; 32],
) -> Result<Instruction, RpcError> {
    let proof_result = fetch_proof(rpc, &id).await?;
    Ok(build_instruction(payer, id, proof_result))
}

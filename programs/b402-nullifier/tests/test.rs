#![cfg(feature = "test-sbf")]

use b402_nullifier::sdk::{
    build_instruction, create_nullifier_ix, derive_nullifier_address, fetch_proof,
    PROGRAM_ID,
};
use light_program_test::{program_test::LightProgramTest, Indexer, ProgramTestConfig, Rpc};
use solana_sdk::signature::Signer;

#[tokio::test]
async fn test_create_nullifier() {
    let config = ProgramTestConfig::new(true, Some(vec![("b402_nullifier", PROGRAM_ID)]));
    let mut rpc = LightProgramTest::new(config).await.unwrap();
    let payer = rpc.get_payer().insecure_clone();

    let id: [u8; 32] = [
        1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25,
        26, 27, 28, 29, 30, 31, 32,
    ];

    // Use the all-in-one helper
    let ix = create_nullifier_ix(&mut rpc, payer.pubkey(), id)
        .await
        .unwrap();

    rpc.create_and_send_transaction(&[ix], &payer.pubkey(), &[&payer])
        .await
        .unwrap();

    // Verify account exists
    let address = derive_nullifier_address(&id);
    let compressed_account = rpc
        .get_compressed_account(address, None)
        .await
        .unwrap()
        .value
        .unwrap();

    assert!(
        compressed_account.data.is_none()
            || compressed_account.data.as_ref().unwrap().data.is_empty(),
        "Nullifier account should be empty"
    );
}

#[tokio::test]
async fn test_create_nullifier_step_by_step() {
    let config = ProgramTestConfig::new(true, Some(vec![("light_nullifier_program", PROGRAM_ID)]));
    let mut rpc = LightProgramTest::new(config).await.unwrap();
    let payer = rpc.get_payer().insecure_clone();

    let id: [u8; 32] = [7u8; 32];

    // Step 1: fetch proof (async)
    let proof_result = fetch_proof(&mut rpc, &id).await.unwrap();

    // Step 2: build instruction (sync)
    let ix = build_instruction(payer.pubkey(), id, proof_result);

    // Step 3: send transaction
    rpc.create_and_send_transaction(&[ix], &payer.pubkey(), &[&payer])
        .await
        .unwrap();

    // Verify
    let address = derive_nullifier_address(&id);
    let account = rpc
        .get_compressed_account(address, None)
        .await
        .unwrap()
        .value;
    assert!(account.is_some(), "Nullifier account should exist");
}

#[tokio::test]
async fn test_create_nullifier_duplicate_fails() {
    let config = ProgramTestConfig::new(true, Some(vec![("light_nullifier_program", PROGRAM_ID)]));
    let mut rpc = LightProgramTest::new(config).await.unwrap();
    let payer = rpc.get_payer().insecure_clone();

    let id: [u8; 32] = [42u8; 32];

    // First creation should succeed
    let ix = create_nullifier_ix(&mut rpc, payer.pubkey(), id)
        .await
        .unwrap();
    rpc.create_and_send_transaction(&[ix], &payer.pubkey(), &[&payer])
        .await
        .unwrap();

    // Second creation with same id should fail at transaction level
    let ix = create_nullifier_ix(&mut rpc, payer.pubkey(), id)
        .await
        .unwrap();
    let result = rpc
        .create_and_send_transaction(&[ix], &payer.pubkey(), &[&payer])
        .await;
    assert!(result.is_err(), "Duplicate nullifier creation should fail");
}

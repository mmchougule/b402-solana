//! Unshield end-to-end + double-spend rejection.

use b402_onchain_tests::{
    fixtures::ShieldFixture,
    harness::{from_spl, Harness},
    mint,
    shield_ix::{send_shield, ShieldArgs},
    unshield_ix::{send_unshield, shard_pda, UnshieldArgs},
};

fn shield_once() -> (Harness, ShieldFixture) {
    let shield_fx = ShieldFixture::load();
    let mint_pk = shield_fx.token_mint_pubkey();
    let mut h = Harness::setup(mint_pk, 100);
    let args = ShieldArgs::from_fixture(&shield_fx, &h.mint);
    send_shield(&mut h, args).expect("initial shield");
    assert_eq!(h.vault_balance(), 100);
    assert_eq!(h.tree_leaf_count(), 1);
    (h, shield_fx)
}

/// Plant a recipient ATA owned by the pubkey that the unshield fixture commits
/// to via recipient_bind. Must match — otherwise the pool rejects with
/// InvalidFeeBinding (reused error for recipient_bind mismatch in v1).
fn plant_fixture_recipient_ata(h: &mut Harness) -> solana_pubkey::Pubkey {
    let owner = ShieldFixture::test_recipient_pubkey();
    let recipient_ata = from_spl(
        &spl_associated_token_account::get_associated_token_address(
            &spl_token::solana_program::pubkey::Pubkey::new_from_array(owner.to_bytes()),
            &spl_token::solana_program::pubkey::Pubkey::new_from_array(h.mint.to_bytes()),
        ),
    );
    mint::plant_token_account(&mut h.svm, &recipient_ata, &h.mint, &owner, 0);
    recipient_ata
}

#[test]
fn unshield_succeeds_after_shield() {
    let (mut h, _) = shield_once();
    let unshield_fx = ShieldFixture::load_named("shield_unshield.json");
    let recipient_ata = plant_fixture_recipient_ata(&mut h);

    let args = UnshieldArgs::from_fixture(&unshield_fx, &h.mint);
    let prefix = args.nullifier_shard_prefix[0];

    send_unshield(&mut h, args, recipient_ata).expect("valid unshield must succeed");

    assert_eq!(h.vault_balance(), 0, "vault should be empty after unshield");
    use spl_token::solana_program::program_pack::Pack;
    let r = h.svm.get_account(&recipient_ata).unwrap().data;
    let recipient_acct = spl_token::state::Account::unpack(&r).unwrap();
    assert_eq!(recipient_acct.amount, 100, "recipient should receive 100");

    let shard_account = h.svm.get_account(&shard_pda(prefix))
        .expect("shard should have been created");
    // Zero-copy NullifierShard: 8B disc + 2B prefix + 2B pad + 4B count + bytes.
    let count = u32::from_le_bytes(shard_account.data[12..16].try_into().unwrap());
    assert_eq!(count, 1, "exactly one nullifier inserted");
}

#[test]
fn double_spend_is_rejected() {
    let (mut h, _) = shield_once();
    let unshield_fx = ShieldFixture::load_named("shield_unshield.json");
    let recipient_ata = plant_fixture_recipient_ata(&mut h);

    let args1 = UnshieldArgs::from_fixture(&unshield_fx, &h.mint);
    send_unshield(&mut h, args1, recipient_ata).expect("first unshield succeeds");
    assert_eq!(h.vault_balance(), 0);

    h.svm.expire_blockhash();

    let args2 = UnshieldArgs::from_fixture(&unshield_fx, &h.mint);
    let result = send_unshield(&mut h, args2, recipient_ata);
    assert!(result.is_err(), "double-spend must be rejected");

    let err = result.unwrap_err();
    let logs = err.meta.logs.join("\n");
    assert!(
        logs.contains("0x578") || logs.contains("NullifierAlreadySpent"),
        "expected NullifierAlreadySpent error, got logs:\n{logs}",
    );
}

#[test]
fn unshield_rejects_wrong_recipient() {
    // If a malicious relayer swaps the recipient_token_account to their own,
    // the pool's recipient_bind check must reject.
    let (mut h, _) = shield_once();
    let unshield_fx = ShieldFixture::load_named("shield_unshield.json");

    // Create an ATA owned by a DIFFERENT pubkey than the fixture commits to.
    let attacker_owner = solana_pubkey::Pubkey::new_from_array([0xee; 32]);
    let attacker_ata = from_spl(
        &spl_associated_token_account::get_associated_token_address(
            &spl_token::solana_program::pubkey::Pubkey::new_from_array(attacker_owner.to_bytes()),
            &spl_token::solana_program::pubkey::Pubkey::new_from_array(h.mint.to_bytes()),
        ),
    );
    mint::plant_token_account(&mut h.svm, &attacker_ata, &h.mint, &attacker_owner, 0);

    let args = UnshieldArgs::from_fixture(&unshield_fx, &h.mint);
    let result = send_unshield(&mut h, args, attacker_ata);
    assert!(result.is_err(), "wrong recipient must be rejected");

    let err = result.unwrap_err();
    let logs = err.meta.logs.join("\n");
    // InvalidFeeBinding = 1602 = 0x642 (reused for recipient binding in v1)
    assert!(
        logs.contains("0x642") || logs.contains("InvalidFeeBinding"),
        "expected recipient bind mismatch, got logs:\n{logs}",
    );
    assert_eq!(h.vault_balance(), 100, "funds stay in vault on rejected unshield");
}

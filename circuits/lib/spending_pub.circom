pragma circom 2.2.0;

include "circomlib/circuits/poseidon.circom";

/*
 * spendingPub = Poseidon_2(spendKeyPubTag, spendingPriv)
 * Arity 2 (single input + domain tag).
 */
template SpendingPub() {
    signal input spendKeyPubTag;
    signal input spendingPriv;
    signal output out;

    component h = Poseidon(2);
    h.inputs[0] <== spendKeyPubTag;
    h.inputs[1] <== spendingPriv;

    out <== h.out;
}

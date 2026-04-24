pragma circom 2.2.0;

include "circomlib/circuits/poseidon.circom";

/*
 * Nullifier = Poseidon_3(nullTag, spendingPriv, leafIndex)
 * Arity 3.
 */
template Nullifier() {
    signal input nullTag;
    signal input spendingPriv;
    signal input leafIndex;
    signal output out;

    component h = Poseidon(3);
    h.inputs[0] <== nullTag;
    h.inputs[1] <== spendingPriv;
    h.inputs[2] <== leafIndex;

    out <== h.out;
}

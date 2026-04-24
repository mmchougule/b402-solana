pragma circom 2.2.0;

include "circomlib/circuits/poseidon.circom";

/*
 * Commitment = Poseidon_5(commitTag, tokenMint, value, random, spendingPub)
 *
 * Matches packages/crypto poseidon::commitment.
 * Arity 5 (4 inputs + domain tag).
 */
template Commitment() {
    signal input commitTag;
    signal input tokenMint;
    signal input value;
    signal input random;
    signal input spendingPub;
    signal output out;

    component h = Poseidon(5);
    h.inputs[0] <== commitTag;
    h.inputs[1] <== tokenMint;
    h.inputs[2] <== value;
    h.inputs[3] <== random;
    h.inputs[4] <== spendingPub;

    out <== h.out;
}

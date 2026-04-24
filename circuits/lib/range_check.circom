pragma circom 2.2.0;

include "circomlib/circuits/bitify.circom";

/*
 * Range check: value < 2^bits.
 * Implemented by decomposing to bits and reconstructing — if decomposition
 * succeeds with `bits` bits, value fits.
 */
template RangeCheck(bits) {
    signal input in;
    component n2b = Num2Bits(bits);
    n2b.in <== in;
}

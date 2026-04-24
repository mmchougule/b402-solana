pragma circom 2.2.0;

include "circomlib/circuits/poseidon.circom";

/*
 * MerkleRoot — computes the merkle root from a leaf + sibling path.
 *
 * Does NOT enforce equality against an expected root. Caller checks
 * `computedRoot === expectedRoot` (or a selector-guarded version for
 * dummy-input paths).
 *
 * This split lets transact.circom skip the root check when the input
 * is a dummy note — required for correctness when the tree is non-empty.
 *
 * For each level:
 *   leftMix  = pathBits[i] == 0 ? cur : sibling
 *   rightMix = pathBits[i] == 0 ? sibling : cur
 *   next     = Poseidon_3(mkNodeTag, leftMix, rightMix)
 */
template MerkleRoot(depth) {
    signal input leaf;
    signal input mkNodeTag;
    signal input siblings[depth];
    signal input pathBits[depth];
    signal output computedRoot;

    signal cur[depth + 1];
    signal leftMix[depth];
    signal rightMix[depth];

    cur[0] <== leaf;

    component hashers[depth];

    for (var i = 0; i < depth; i++) {
        // pathBits[i] must be 0 or 1.
        pathBits[i] * (pathBits[i] - 1) === 0;

        hashers[i] = Poseidon(3);
        hashers[i].inputs[0] <== mkNodeTag;

        // Arithmetic selector: left = (1-b)*cur + b*sib, right = (1-b)*sib + b*cur.
        // One constraint each via the `<==` assignment.
        leftMix[i]  <== cur[i] + pathBits[i] * (siblings[i] - cur[i]);
        rightMix[i] <== siblings[i] + pathBits[i] * (cur[i] - siblings[i]);

        hashers[i].inputs[1] <== leftMix[i];
        hashers[i].inputs[2] <== rightMix[i];

        cur[i + 1] <== hashers[i].out;
    }

    computedRoot <== cur[depth];
}

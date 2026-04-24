pragma circom 2.2.0;

include "./lib/commitment.circom";
include "./lib/nullifier.circom";
include "./lib/spending_pub.circom";
include "./lib/merkle_verify.circom";
include "./lib/range_check.circom";
include "circomlib/circuits/poseidon.circom";

/*
 * Transact circuit (N=2 in, M=2 out), per PRD-02 §6.2.
 *
 * Handles shield, unshield, and internal transfer as special cases of
 * the general 2-in / 2-out shielded transaction.
 *
 * Public inputs (order MUST match TransactPublicInputs in PRD-03 §4.3):
 *   0:  merkleRoot
 *   1:  nullifier[0]
 *   2:  nullifier[1]
 *   3:  commitmentOut[0]
 *   4:  commitmentOut[1]
 *   5:  publicAmountIn
 *   6:  publicAmountOut
 *   7:  publicTokenMint
 *   8:  relayerFee
 *   9:  relayerFeeBind
 *   10: rootBind
 *   11: recipientBind
 *   12: commitTag
 *   13: nullTag
 *   14: mkNodeTag
 *   15: spendKeyPubTag
 *   16: feeBindTag
 *   17: recipientBindTag
 *
 * recipientBind = Poseidon_3(recipientBindTag, recipientOwnerLow, recipientOwnerHigh)
 * where owner pubkey is split into two 128-bit halves. Unshield binds the
 * destination ATA's owner to the proof so a malicious relayer can't redirect
 * funds by swapping out `recipient_token_account` in the accounts list.
 * Shield sets both halves to zero — the handler doesn't check it.
 */
template Transact(depth) {
    // --- Public inputs ---
    signal input merkleRoot;
    signal input nullifier[2];
    signal input commitmentOut[2];
    signal input publicAmountIn;
    signal input publicAmountOut;
    signal input publicTokenMint;
    signal input relayerFee;
    signal input relayerFeeBind;
    signal input rootBind;
    signal input recipientBind;

    // --- Domain tags (public; program verifies they match canonical values) ---
    signal input commitTag;
    signal input nullTag;
    signal input mkNodeTag;
    signal input spendKeyPubTag;
    signal input feeBindTag;
    signal input recipientBindTag;

    // --- Private inputs ---
    signal input inTokenMint[2];
    signal input inValue[2];
    signal input inRandom[2];
    signal input inSpendingPriv[2];
    signal input inLeafIndex[2];
    signal input inSiblings[2][depth];
    signal input inPathBits[2][depth];
    signal input inIsDummy[2];

    signal input outTokenMint[2];
    signal input outValue[2];
    signal input outRandom[2];
    signal input outSpendingPub[2];
    signal input outIsDummy[2];

    signal input relayerFeeRecipient;
    // Recipient owner, split into two 128-bit halves so the encoding is
    // collision-free (unlike a single mod-p reduction of a 32-byte pubkey).
    signal input recipientOwnerLow;
    signal input recipientOwnerHigh;

    // ===== Template-scope signal arrays (MUST be declared outside for loops) =====

    // Spent-note intermediates
    signal spendPubInOut[2];
    signal commitInOut[2];
    signal nullSelected[2];
    signal merkleDelta[2];          // (1 - isDummy) * (computedRoot - merkleRoot)

    // Created-note intermediates
    signal commitOutComputed[2];
    signal commitSelected[2];

    // Token-mint consistency bindings
    signal tokenBindingIn[2];
    signal tokenBindingOut[2];

    // Balance aggregates — intermediate per-slot weighted values + final sums.
    signal inWeighted[2];
    signal outWeighted[2];
    signal inSum;
    signal outSum;

    // Sub-components (must be named arrays to be indexable in loops)
    component rcIn0   = RangeCheck(64);
    component rcIn1   = RangeCheck(64);
    component rcOut0  = RangeCheck(64);
    component rcOut1  = RangeCheck(64);
    component rcPubIn = RangeCheck(64);
    component rcPubOut = RangeCheck(64);
    component rcFee   = RangeCheck(64);

    component spendPubIn[2];
    component commitIn[2];
    component nullHash[2];
    component mkRoot[2];
    component commitOut[2];

    // ========== Constraints ==========

    // Range-check all 64-bit values.
    rcIn0.in   <== inValue[0];
    rcIn1.in   <== inValue[1];
    rcOut0.in  <== outValue[0];
    rcOut1.in  <== outValue[1];
    rcPubIn.in <== publicAmountIn;
    rcPubOut.in <== publicAmountOut;
    rcFee.in   <== relayerFee;

    // Boolean constraints on dummy selectors.
    inIsDummy[0]  * (inIsDummy[0]  - 1) === 0;
    inIsDummy[1]  * (inIsDummy[1]  - 1) === 0;
    outIsDummy[0] * (outIsDummy[0] - 1) === 0;
    outIsDummy[1] * (outIsDummy[1] - 1) === 0;

    // Spent notes — ownership, commitment recompute, merkle (selector-guarded), nullifier.
    for (var i = 0; i < 2; i++) {
        // spendingPub = Poseidon_2(tag, spendingPriv)
        spendPubIn[i] = SpendingPub();
        spendPubIn[i].spendKeyPubTag <== spendKeyPubTag;
        spendPubIn[i].spendingPriv   <== inSpendingPriv[i];
        spendPubInOut[i] <== spendPubIn[i].out;

        // Recompute commitment from spent note fields.
        commitIn[i] = Commitment();
        commitIn[i].commitTag   <== commitTag;
        commitIn[i].tokenMint   <== inTokenMint[i];
        commitIn[i].value       <== inValue[i];
        commitIn[i].random      <== inRandom[i];
        commitIn[i].spendingPub <== spendPubInOut[i];
        commitInOut[i] <== commitIn[i].out;

        // Compute merkle root from the supplied path. Does NOT enforce equality
        // (so dummy inputs don't need a valid path).
        mkRoot[i] = MerkleRoot(depth);
        mkRoot[i].leaf      <== commitInOut[i];
        mkRoot[i].mkNodeTag <== mkNodeTag;
        for (var j = 0; j < depth; j++) {
            mkRoot[i].siblings[j] <== inSiblings[i][j];
            mkRoot[i].pathBits[j] <== inPathBits[i][j];
        }

        // Selector-guarded equality: if !isDummy, computedRoot must match merkleRoot.
        // If isDummy, constraint trivially holds regardless of the path.
        merkleDelta[i] <== (1 - inIsDummy[i]) * (mkRoot[i].computedRoot - merkleRoot);
        merkleDelta[i] === 0;

        // Nullifier derivation.
        nullHash[i] = Nullifier();
        nullHash[i].nullTag      <== nullTag;
        nullHash[i].spendingPriv <== inSpendingPriv[i];
        nullHash[i].leafIndex    <== inLeafIndex[i];

        // Public nullifier must equal (1 - isDummy) * nullHash.
        nullSelected[i] <== (1 - inIsDummy[i]) * nullHash[i].out;
        nullifier[i] === nullSelected[i];
    }

    // Created notes.
    for (var k = 0; k < 2; k++) {
        commitOut[k] = Commitment();
        commitOut[k].commitTag   <== commitTag;
        commitOut[k].tokenMint   <== outTokenMint[k];
        commitOut[k].value       <== outValue[k];
        commitOut[k].random      <== outRandom[k];
        commitOut[k].spendingPub <== outSpendingPub[k];
        commitOutComputed[k] <== commitOut[k].out;

        commitSelected[k] <== (1 - outIsDummy[k]) * commitOutComputed[k];
        commitmentOut[k] === commitSelected[k];
    }

    // Token-mint consistency: every non-dummy note shares publicTokenMint.
    for (var t = 0; t < 2; t++) {
        tokenBindingIn[t]  <== (1 - inIsDummy[t])  * (inTokenMint[t]  - publicTokenMint);
        tokenBindingIn[t]  === 0;
        tokenBindingOut[t] <== (1 - outIsDummy[t]) * (outTokenMint[t] - publicTokenMint);
        tokenBindingOut[t] === 0;
    }

    // Balance conservation — decompose to single-product constraints.
    inWeighted[0]  <== (1 - inIsDummy[0])  * inValue[0];
    inWeighted[1]  <== (1 - inIsDummy[1])  * inValue[1];
    outWeighted[0] <== (1 - outIsDummy[0]) * outValue[0];
    outWeighted[1] <== (1 - outIsDummy[1]) * outValue[1];
    inSum  <== inWeighted[0] + inWeighted[1];
    outSum <== outWeighted[0] + outWeighted[1];
    inSum + publicAmountIn === outSum + publicAmountOut + relayerFee;

    // Public amount exclusivity: not both non-zero.
    publicAmountIn * publicAmountOut === 0;

    // Relayer fee bind: relayerFeeBind = Poseidon_3(feeBindTag, recipient, fee).
    component feeBindHasher = Poseidon(3);
    feeBindHasher.inputs[0] <== feeBindTag;
    feeBindHasher.inputs[1] <== relayerFeeRecipient;
    feeBindHasher.inputs[2] <== relayerFee;
    relayerFeeBind === feeBindHasher.out;

    // Recipient bind: recipientBind = Poseidon_3(recipientBindTag, ownerLow, ownerHigh).
    // Range-check each half fits in 128 bits so the collision-free split is honest.
    component rcLow  = RangeCheck(128); rcLow.in  <== recipientOwnerLow;
    component rcHigh = RangeCheck(128); rcHigh.in <== recipientOwnerHigh;
    component recipBindHasher = Poseidon(3);
    recipBindHasher.inputs[0] <== recipientBindTag;
    recipBindHasher.inputs[1] <== recipientOwnerLow;
    recipBindHasher.inputs[2] <== recipientOwnerHigh;
    recipientBind === recipBindHasher.out;

    // Nullifier ordering deferred to on-chain program (PRD-02 §12 Q2).

    // rootBind is a passthrough public input. No circuit constraint; the program
    // checks it against Poseidon_2(rootBindTag, merkleRoot, blockExpiry) when
    // time-bound proofs are enabled. Unused when set to 0.
    // Explicitly touch rootBind so circom does not flag an unused signal.
    signal _rootBindAck;
    _rootBindAck <== rootBind * 1;
}

component main {
    public [
        merkleRoot,
        nullifier,
        commitmentOut,
        publicAmountIn,
        publicAmountOut,
        publicTokenMint,
        relayerFee,
        relayerFeeBind,
        rootBind,
        recipientBind,
        commitTag,
        nullTag,
        mkNodeTag,
        spendKeyPubTag,
        feeBindTag,
        recipientBindTag
    ]
} = Transact(26);

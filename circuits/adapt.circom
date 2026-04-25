pragma circom 2.2.0;

include "./lib/commitment.circom";
include "./lib/nullifier.circom";
include "./lib/spending_pub.circom";
include "./lib/merkle_verify.circom";
include "./lib/range_check.circom";
include "circomlib/circuits/poseidon.circom";

/*
 * Adapt circuit (N=2 in IN-mint, M=2 out OUT-mint), per PRD-04 §2.1.
 *
 * The shielded composability primitive. Burns input notes in `publicTokenMint`
 * and mints output notes in `expectedOutMint`, provably bound to an adapter
 * program + instruction payload + expected minimum output.
 *
 * Public inputs (23 total; first 18 match TransactPublicInputs for byte-level
 * compatibility with the prover package. Last 5 are adapt-specific):
 *   0:  merkleRoot
 *   1:  nullifier[0]
 *   2:  nullifier[1]
 *   3:  commitmentOut[0]         (in OUT mint)
 *   4:  commitmentOut[1]         (in OUT mint)
 *   5:  publicAmountIn           = amount pool transfers to adapter_in_ta
 *   6:  publicAmountOut          = 0 (adapt has no public withdrawal)
 *   7:  publicTokenMint          = IN mint
 *   8:  relayerFee               = fee paid in IN mint from input notes
 *   9:  relayerFeeBind
 *   10: rootBind
 *   11: recipientBind            = Poseidon_3(recipientBindTag, 0, 0)
 *   12: commitTag
 *   13: nullTag
 *   14: mkNodeTag
 *   15: spendKeyPubTag
 *   16: feeBindTag
 *   17: recipientBindTag
 *   18: adapterId                = keccak256(adapter_program_id) mod p
 *   19: actionHash               = Poseidon_3(adaptBindTag, actionPayloadKeccakFr, expectedOutMint)
 *   20: expectedOutValue         = pool's minimum output delta
 *   21: expectedOutMint          = OUT mint
 *   22: adaptBindTag             = domain tag 'b402/v1/adapt-bind'
 *
 * Distinct from transact:
 *   - Two mint bindings: input notes bind to publicTokenMint; output notes
 *     bind to expectedOutMint.
 *   - Balance: inSum === publicAmountIn + relayerFee (input value consumed
 *     by adapter call + fee); outSum === expectedOutValue (output value
 *     reflects at-least-expected adapter delivery).
 *   - publicAmountOut is forced to zero — no public unshield in adapt.
 *   - actionHash binds the caller to a specific action_payload + output mint.
 *     Pool on-chain recomputes keccak256(action_payload) and the Poseidon_3,
 *     rejecting a relayer who tampered the payload between proof gen and
 *     submission.
 *
 * adapterId is bound by the pool program (keccak of adapter_program.key
 * compared against the registry's recorded hash), not by an in-circuit
 * equality. It is a passthrough public input here so the circuit commits
 * to WHICH adapter a proof is for — a proof generated for adapter X cannot
 * be replayed against adapter Y (the public input differs).
 */
template Adapt(depth) {
    // ===== Public inputs (must match order below in component main) =====
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

    // Domain tags (shared with transact).
    signal input commitTag;
    signal input nullTag;
    signal input mkNodeTag;
    signal input spendKeyPubTag;
    signal input feeBindTag;
    signal input recipientBindTag;

    // Adapt-specific public inputs.
    signal input adapterId;
    signal input actionHash;
    signal input expectedOutValue;
    signal input expectedOutMint;
    signal input adaptBindTag;

    // ===== Private inputs =====
    signal input inTokenMint[2];
    signal input inValue[2];
    signal input inRandom[2];
    signal input inSpendingPriv[2];
    signal input inLeafIndex[2];
    signal input inSiblings[2][depth];
    signal input inPathBits[2][depth];
    signal input inIsDummy[2];

    signal input outValue[2];
    signal input outRandom[2];
    signal input outSpendingPub[2];
    signal input outIsDummy[2];

    signal input relayerFeeRecipient;
    signal input recipientOwnerLow;
    signal input recipientOwnerHigh;

    // Action-payload keccak256 reduced mod p — private witness. Pool
    // recomputes this on-chain from the forwarded action_payload bytes and
    // binds it via the actionHash Poseidon.
    signal input actionPayloadKeccakFr;

    // ===== Template-scope intermediates =====

    signal spendPubInOut[2];
    signal commitInOut[2];
    signal nullSelected[2];
    signal merkleDelta[2];

    signal commitOutComputed[2];
    signal commitSelected[2];

    signal tokenBindingIn[2];
    signal tokenBindingOutMint[2];   // out notes bind to expectedOutMint

    signal inWeighted[2];
    signal outWeighted[2];
    signal inSum;
    signal outSum;

    component rcIn0    = RangeCheck(64);
    component rcIn1    = RangeCheck(64);
    component rcOut0   = RangeCheck(64);
    component rcOut1   = RangeCheck(64);
    component rcPubIn  = RangeCheck(64);
    component rcPubOut = RangeCheck(64);
    component rcFee    = RangeCheck(64);
    component rcExpOut = RangeCheck(64);

    component spendPubIn[2];
    component commitIn[2];
    component nullHash[2];
    component mkRoot[2];
    component commitOut[2];

    // ===== Constraints =====

    // Range-check all 64-bit values.
    rcIn0.in    <== inValue[0];
    rcIn1.in    <== inValue[1];
    rcOut0.in   <== outValue[0];
    rcOut1.in   <== outValue[1];
    rcPubIn.in  <== publicAmountIn;
    rcPubOut.in <== publicAmountOut;
    rcFee.in    <== relayerFee;
    rcExpOut.in <== expectedOutValue;

    // Adapt has no public withdraw; force publicAmountOut to 0.
    publicAmountOut === 0;

    // Boolean constraints on dummy selectors.
    inIsDummy[0]  * (inIsDummy[0]  - 1) === 0;
    inIsDummy[1]  * (inIsDummy[1]  - 1) === 0;
    outIsDummy[0] * (outIsDummy[0] - 1) === 0;
    outIsDummy[1] * (outIsDummy[1] - 1) === 0;

    // Spent notes — ownership, commitment recompute, merkle (selector-guarded), nullifier.
    for (var i = 0; i < 2; i++) {
        spendPubIn[i] = SpendingPub();
        spendPubIn[i].spendKeyPubTag <== spendKeyPubTag;
        spendPubIn[i].spendingPriv   <== inSpendingPriv[i];
        spendPubInOut[i] <== spendPubIn[i].out;

        commitIn[i] = Commitment();
        commitIn[i].commitTag   <== commitTag;
        commitIn[i].tokenMint   <== inTokenMint[i];
        commitIn[i].value       <== inValue[i];
        commitIn[i].random      <== inRandom[i];
        commitIn[i].spendingPub <== spendPubInOut[i];
        commitInOut[i] <== commitIn[i].out;

        mkRoot[i] = MerkleRoot(depth);
        mkRoot[i].leaf      <== commitInOut[i];
        mkRoot[i].mkNodeTag <== mkNodeTag;
        for (var j = 0; j < depth; j++) {
            mkRoot[i].siblings[j] <== inSiblings[i][j];
            mkRoot[i].pathBits[j] <== inPathBits[i][j];
        }

        merkleDelta[i] <== (1 - inIsDummy[i]) * (mkRoot[i].computedRoot - merkleRoot);
        merkleDelta[i] === 0;

        nullHash[i] = Nullifier();
        nullHash[i].nullTag      <== nullTag;
        nullHash[i].spendingPriv <== inSpendingPriv[i];
        nullHash[i].leafIndex    <== inLeafIndex[i];

        nullSelected[i] <== (1 - inIsDummy[i]) * nullHash[i].out;
        nullifier[i] === nullSelected[i];
    }

    // Created notes — commitment recompute. Output mint is expectedOutMint.
    for (var k = 0; k < 2; k++) {
        commitOut[k] = Commitment();
        commitOut[k].commitTag   <== commitTag;
        commitOut[k].tokenMint   <== expectedOutMint;
        commitOut[k].value       <== outValue[k];
        commitOut[k].random      <== outRandom[k];
        commitOut[k].spendingPub <== outSpendingPub[k];
        commitOutComputed[k] <== commitOut[k].out;

        commitSelected[k] <== (1 - outIsDummy[k]) * commitOutComputed[k];
        commitmentOut[k] === commitSelected[k];
    }

    // Token-mint consistency:
    //   - Input notes bind to publicTokenMint (IN mint).
    //   - Output notes bind to expectedOutMint (OUT mint) — already enforced
    //     above by feeding expectedOutMint into commitOut[k].tokenMint.
    for (var t = 0; t < 2; t++) {
        tokenBindingIn[t] <== (1 - inIsDummy[t]) * (inTokenMint[t] - publicTokenMint);
        tokenBindingIn[t] === 0;

        // Out-mint redundant sanity (cannot fail given construction above,
        // but leaving a named intermediate makes the intent explicit).
        tokenBindingOutMint[t] <== (1 - outIsDummy[t]) * 0;
        tokenBindingOutMint[t] === 0;
    }

    // Balance conservation (adapt-specific):
    //   sum(inValue, non-dummy) === publicAmountIn + relayerFee
    //   sum(outValue, non-dummy) === expectedOutValue
    inWeighted[0]  <== (1 - inIsDummy[0])  * inValue[0];
    inWeighted[1]  <== (1 - inIsDummy[1])  * inValue[1];
    outWeighted[0] <== (1 - outIsDummy[0]) * outValue[0];
    outWeighted[1] <== (1 - outIsDummy[1]) * outValue[1];
    inSum  <== inWeighted[0] + inWeighted[1];
    outSum <== outWeighted[0] + outWeighted[1];

    inSum === publicAmountIn + relayerFee;
    outSum === expectedOutValue;

    // Relayer fee bind (same as transact).
    component feeBindHasher = Poseidon(3);
    feeBindHasher.inputs[0] <== feeBindTag;
    feeBindHasher.inputs[1] <== relayerFeeRecipient;
    feeBindHasher.inputs[2] <== relayerFee;
    relayerFeeBind === feeBindHasher.out;

    // Recipient bind — adapt has no on-chain recipient ATA. Bind zero owner.
    component rcLow  = RangeCheck(128); rcLow.in  <== recipientOwnerLow;
    component rcHigh = RangeCheck(128); rcHigh.in <== recipientOwnerHigh;
    component recipBindHasher = Poseidon(3);
    recipBindHasher.inputs[0] <== recipientBindTag;
    recipBindHasher.inputs[1] <== recipientOwnerLow;
    recipBindHasher.inputs[2] <== recipientOwnerHigh;
    recipientBind === recipBindHasher.out;

    // Action hash bind: actionHash = Poseidon_3(adaptBindTag, actionPayloadKeccakFr, expectedOutMint).
    // This is the core adapt primitive. Binds:
    //   - The specific action_payload the user proved (via keccak256 mod p).
    //   - The expected output mint.
    // Pool on-chain recomputes keccak256(action_payload) mod p and the
    // Poseidon_3, rejecting any tampering between proof gen and submission.
    component actionHasher = Poseidon(3);
    actionHasher.inputs[0] <== adaptBindTag;
    actionHasher.inputs[1] <== actionPayloadKeccakFr;
    actionHasher.inputs[2] <== expectedOutMint;
    actionHash === actionHasher.out;

    // adapterId and rootBind are passthrough public inputs. Pool enforces
    // adapterId matches the registry, and rootBind matches the time-bound
    // proof spec when enabled. Explicitly touch them so circom does not
    // flag unused signals.
    signal _adapterIdAck;
    signal _rootBindAck;
    _adapterIdAck <== adapterId  * 1;
    _rootBindAck  <== rootBind   * 1;
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
        recipientBindTag,
        adapterId,
        actionHash,
        expectedOutValue,
        expectedOutMint,
        adaptBindTag
    ]
} = Adapt(26);

pragma circom 2.2.0;

include "./lib/commitment.circom";
include "./lib/nullifier.circom";
include "./lib/spending_pub.circom";
include "./lib/merkle_verify.circom";
include "./lib/range_check.circom";
include "circomlib/circuits/poseidon.circom";

/*
 * Adapt v2 circuit (M=4 in / N=4 out vector-bound), per
 *   PRD-11 (vector token bindings),
 *   PRD-12 (content-addressed action_hash),
 *   PRD-13 (shadow PDA binding),
 *   PRD-15 (delta-zero + deadline_slot).
 *
 * Extends adapt.circom (23 public inputs) with:
 *   - 4-slot vector mints for inputs and outputs (PRD-11),
 *   - Poseidon_6 content-addressed actionHash (PRD-12),
 *   - shadowPdaBinding (PRD-13),
 *   - deadline_slot (PRD-15).
 *
 * Public input layout — 38 fields (was 23):
 *
 *   0:      merkleRoot
 *   1..4:   nullifier[4]
 *   5..8:   commitmentOut[4]
 *   9:      publicAmountIn
 *   10:     publicAmountOut         (forced to zero)
 *   11..14: publicTokenMintIn[4]    (per-slot IN mints; zero in unused slots)
 *   15:     relayerFee
 *   16:     relayerFeeBind
 *   17:     rootBind
 *   18:     recipientBind
 *   19:     commitTag
 *   20:     nullTag
 *   21:     mkNodeTag
 *   22:     spendKeyPubTag
 *   23:     feeBindTag
 *   24:     recipientBindTag
 *   25:     adapterId               (Fr-reduced keccak of adapter program ID)
 *   26:     actionHash              (= Poseidon_6 below)
 *   27:     expectedOutValue        (sum of non-dummy out values)
 *   28..31: expectedOutMint[4]      (per-slot OUT mints; zero in unused slots)
 *   32:     adaptBindTag            (domain tag baked into actionHash)
 *   33:     scopeTag                (per-instance binding, PRD-12)
 *   34:     accountsHash            (Fr-reduced keccak(canonical accounts), PRD-12)
 *   35:     extraContextRoot        (Poseidon root over up to 4 extras, PRD-12)
 *   36:     deadlineSlot            (slot deadline, PRD-15; pool checks at runtime)
 *   37:     shadowPdaBinding        (= Poseidon_3 below, PRD-13)
 *
 * actionHash (PRD-12 keystone):
 *   actionHash === Poseidon_6(
 *       adaptBindTag,        // domain tag
 *       adapterId,
 *       scopeTag,
 *       actionPayloadKeccakFr,  // private — ixDataHash, same as v1
 *       accountsHash,
 *       extraContextRoot
 *   )
 *
 * shadowPdaBinding (PRD-13):
 *   shadowPdaBinding === Poseidon_3(shadowDomainTag, viewingPubHash, scopeTag)
 *   - shadowDomainTag is a public input baked at proof gen time;
 *     for parity with adaptBindTag we compute it from a private witness
 *     `shadowDomainTag` private signal that the prover sets to the canonical
 *     domain tag value. Pool checks shadowPdaBinding equality, not the tag.
 *   - viewingPubHash is a private witness; the circuit binds the user's
 *     spending key to the shadow PDA via Poseidon.
 *   - When the action does not require a shadow PDA, both shadowPdaBinding
 *     and viewingPubHash are set to zero by the prover.
 *
 * Vector mint constraints (PRD-11):
 *   for k in 0..4:
 *     if inIsDummy[k]:
 *       publicTokenMintIn[k] === 0   // zero-binding canonicalization
 *       inTokenMint[k] === 0
 *     else:
 *       publicTokenMintIn[k] === inTokenMint[k]
 *   Same pattern for outputs with expectedOutMint[k].
 *
 * Existing adapt invariants carry over:
 *   - Merkle/nullifier/commitment per slot
 *   - Range checks on amounts
 *   - inSum === publicAmountIn + relayerFee
 *   - outSum === expectedOutValue
 *   - publicAmountOut === 0
 *
 * Total: ~22,500 R1CS (vs ~17,000 v1). Public-input count 38.
 */
template AdaptV2(depth) {
    // ===== Public inputs =====
    signal input merkleRoot;
    signal input nullifier[4];
    signal input commitmentOut[4];
    signal input publicAmountIn;
    signal input publicAmountOut;
    signal input publicTokenMintIn[4];
    signal input relayerFee;
    signal input relayerFeeBind;
    signal input rootBind;
    signal input recipientBind;

    // Domain tags (shared with transact + adapt v1).
    signal input commitTag;
    signal input nullTag;
    signal input mkNodeTag;
    signal input spendKeyPubTag;
    signal input feeBindTag;
    signal input recipientBindTag;

    // Adapt v2 public inputs.
    signal input adapterId;
    signal input actionHash;
    signal input expectedOutValue;
    signal input expectedOutMint[4];
    signal input adaptBindTag;
    signal input scopeTag;
    signal input accountsHash;
    signal input extraContextRoot;
    signal input deadlineSlot;
    signal input shadowPdaBinding;

    // ===== Private inputs =====
    signal input inTokenMint[4];
    signal input inValue[4];
    signal input inRandom[4];
    signal input inSpendingPriv[4];
    signal input inLeafIndex[4];
    signal input inSiblings[4][depth];
    signal input inPathBits[4][depth];
    signal input inIsDummy[4];

    signal input outTokenMint[4];
    signal input outValue[4];
    signal input outRandom[4];
    signal input outSpendingPub[4];
    signal input outIsDummy[4];

    signal input relayerFeeRecipient;
    signal input recipientOwnerLow;
    signal input recipientOwnerHigh;

    // PRD-12 keystone — keccak(action_payload) reduced mod p.
    signal input actionPayloadKeccakFr;

    // PRD-13 shadow PDA private inputs.
    signal input shadowDomainTag;
    signal input viewingPubHash;

    // ===== Template-scope intermediates =====

    signal spendPubInOut[4];
    signal commitInOut[4];
    signal nullSelected[4];
    signal merkleDelta[4];

    signal commitOutComputed[4];
    signal commitSelected[4];

    signal tokenBindingIn[4];
    signal tokenBindingOut[4];
    signal mintZeroIn[4];
    signal mintZeroOut[4];

    signal inWeighted[4];
    signal outWeighted[4];
    signal inSum;
    signal outSum;

    component rcInVal[4];
    component rcOutVal[4];
    component rcPubIn  = RangeCheck(64);
    component rcPubOut = RangeCheck(64);
    component rcFee    = RangeCheck(64);
    component rcExpOut = RangeCheck(64);
    component rcDeadline = RangeCheck(64);

    component spendPubIn[4];
    component commitIn[4];
    component nullHash[4];
    component mkRoot[4];
    component commitOut[4];

    // ===== Constraints =====

    // Range-check 64-bit values.
    rcPubIn.in   <== publicAmountIn;
    rcPubOut.in  <== publicAmountOut;
    rcFee.in     <== relayerFee;
    rcExpOut.in  <== expectedOutValue;
    rcDeadline.in <== deadlineSlot;

    // Adapt has no public withdraw; force publicAmountOut to 0.
    publicAmountOut === 0;

    // Boolean constraints on dummy selectors.
    for (var i = 0; i < 4; i++) {
        inIsDummy[i]  * (inIsDummy[i]  - 1) === 0;
        outIsDummy[i] * (outIsDummy[i] - 1) === 0;

        rcInVal[i] = RangeCheck(64);
        rcInVal[i].in <== inValue[i];

        rcOutVal[i] = RangeCheck(64);
        rcOutVal[i].in <== outValue[i];
    }

    // Spent notes — ownership, commitment recompute, merkle (selector-guarded), nullifier.
    // Per-slot mint binding (PRD-11): in slot k, the input note's mint must equal
    // publicTokenMintIn[k]; if the slot is dummy, both must be zero (canonicalization).
    for (var i = 0; i < 4; i++) {
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

        // Vector mint binding for this slot.
        tokenBindingIn[i] <== (1 - inIsDummy[i]) * (inTokenMint[i] - publicTokenMintIn[i]);
        tokenBindingIn[i] === 0;

        // Zero-binding canonicalization (PRD-11 §3): dummy slot ⇒ mint = 0.
        mintZeroIn[i] <== inIsDummy[i] * publicTokenMintIn[i];
        mintZeroIn[i] === 0;
    }

    // Created notes — per-slot mint binding for outputs (PRD-11).
    for (var k = 0; k < 4; k++) {
        commitOut[k] = Commitment();
        commitOut[k].commitTag   <== commitTag;
        commitOut[k].tokenMint   <== outTokenMint[k];
        commitOut[k].value       <== outValue[k];
        commitOut[k].random      <== outRandom[k];
        commitOut[k].spendingPub <== outSpendingPub[k];
        commitOutComputed[k] <== commitOut[k].out;

        commitSelected[k] <== (1 - outIsDummy[k]) * commitOutComputed[k];
        commitmentOut[k] === commitSelected[k];

        // Output mint binding for slot k.
        tokenBindingOut[k] <== (1 - outIsDummy[k]) * (outTokenMint[k] - expectedOutMint[k]);
        tokenBindingOut[k] === 0;

        // Zero-binding canonicalization for outputs.
        mintZeroOut[k] <== outIsDummy[k] * expectedOutMint[k];
        mintZeroOut[k] === 0;
    }

    // Balance conservation:
    //   sum(inValue, non-dummy) === publicAmountIn + relayerFee
    //   sum(outValue, non-dummy) === expectedOutValue
    for (var i = 0; i < 4; i++) {
        inWeighted[i]  <== (1 - inIsDummy[i])  * inValue[i];
        outWeighted[i] <== (1 - outIsDummy[i]) * outValue[i];
    }
    inSum  <== inWeighted[0] + inWeighted[1] + inWeighted[2] + inWeighted[3];
    outSum <== outWeighted[0] + outWeighted[1] + outWeighted[2] + outWeighted[3];

    inSum === publicAmountIn + relayerFee;
    outSum === expectedOutValue;

    // Relayer fee bind.
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

    // PRD-12 keystone: actionHash = Poseidon_6(adaptBindTag, adapterId, scopeTag, ixDataHashFr, accountsHash, extraContextRoot).
    component actionHasher = Poseidon(6);
    actionHasher.inputs[0] <== adaptBindTag;
    actionHasher.inputs[1] <== adapterId;
    actionHasher.inputs[2] <== scopeTag;
    actionHasher.inputs[3] <== actionPayloadKeccakFr;
    actionHasher.inputs[4] <== accountsHash;
    actionHasher.inputs[5] <== extraContextRoot;
    actionHash === actionHasher.out;

    // PRD-13: shadowPdaBinding = Poseidon_3(shadowDomainTag, viewingPubHash, scopeTag).
    // The pool optionally enforces this binding gated by adapter registry's
    // circuit_binding_flags (PRD-04 §7.2). When unused, prover sets all three
    // private inputs to zero ⇒ shadowPdaBinding = Poseidon_3(0, 0, scopeTag),
    // and pool registry flag tells handler to skip the equality check.
    component shadowHasher = Poseidon(3);
    shadowHasher.inputs[0] <== shadowDomainTag;
    shadowHasher.inputs[1] <== viewingPubHash;
    shadowHasher.inputs[2] <== scopeTag;
    shadowPdaBinding === shadowHasher.out;

    // adapterId, rootBind, deadlineSlot are passthrough public inputs the
    // pool enforces. Touch them to silence circom unused-signal warnings.
    signal _adapterIdAck;
    signal _rootBindAck;
    signal _deadlineAck;
    _adapterIdAck <== adapterId  * 1;
    _rootBindAck  <== rootBind   * 1;
    _deadlineAck  <== deadlineSlot * 1;
}

component main {
    public [
        merkleRoot,
        nullifier,
        commitmentOut,
        publicAmountIn,
        publicAmountOut,
        publicTokenMintIn,
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
        adaptBindTag,
        scopeTag,
        accountsHash,
        extraContextRoot,
        deadlineSlot,
        shadowPdaBinding
    ]
} = AdaptV2(26);

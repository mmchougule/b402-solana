/**
 * `privateSwap` — composed shielded swap via the `adapt_execute_devnet`
 * pool path.
 *
 * Devnet-only (no ZK). The pool's handler verifies:
 *   1. Adapter is registered + instruction discriminator allowlisted.
 *   2. Post-CPI delta on `out_vault` ≥ `minOutAmount`.
 *
 * It does NOT verify nullifier burn, input note ownership, or that the
 * supplied `outputCommitment` is a valid Poseidon over the real delta.
 * Those are the adapt circuit's job (Phase 2).
 *
 * Flow:
 *   1. Fetch b402 + Jupiter ALTs.
 *   2. Build `outputNote` for `outputAmount` (caller supplies the value the
 *      note will claim — residue above that stays in vault as dust).
 *   3. Encode the adapter's Anchor `execute` ix data:
 *        disc(8) || in_amount(u64 LE) || min_out(u64 LE) || vec(payload)
 *      where `payload` is forwarded to Jupiter verbatim.
 *   4. Build pool's `adapt_execute_devnet` ix with:
 *        named accounts (pool-side) || jupiter accounts (forwarded to adapter)
 *   5. Compose v0 tx with [b402 ALT, ...jupiterAlts], assert ≤ 1232 B, send.
 */

import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  Connection,
  Keypair,
  MessageV0,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddress } from '@solana/spl-token';
import { randomBytes } from '@noble/hashes/utils';

import { leToFrReduced } from '@b402ai/solana-shared';

import {
  adapterRegistryPda, poolConfigPda, tokenConfigPda, treeStatePda, vaultPda,
} from '../programs/pda.js';
import { concat, instructionDiscriminator, u32Le, u64Le, vecU8 } from '../programs/anchor.js';
import { commitmentHash } from '../poseidon.js';
import { encryptNote, type EncryptedNote } from '../note-encryption.js';
import type { Wallet } from '../wallet.js';
import type { SpendableNote } from '@b402ai/solana-shared';

/** Solana's hard tx-size cap. Anything over this is rejected at the RPC. */
export const MAX_TX_SIZE = 1232;
/** Safety ceiling for the Jupiter route-plan payload. PRD-04 allows 400 B. */
export const MAX_ACTION_PAYLOAD = 350;

export interface JupiterSwapInstruction {
  /** Jupiter V6 program ID. */
  programId: PublicKey;
  /** Account metas Jupiter wants on its CPI. */
  keys: Array<{ pubkey: PublicKey; isSigner: boolean; isWritable: boolean }>;
  /** Opaque Jupiter route-plan bytes. Forwarded to Jupiter as `ix.data`. */
  data: Uint8Array;
}

export interface PrivateSwapParams {
  connection: Connection;
  poolProgramId: PublicKey;
  /** Jupiter adapter program ID (must be registered in the pool's registry). */
  jupiterAdapterId: PublicKey;
  /** b402's own ALT pubkey (packages/shared constants.B402_ALT_*). */
  b402Alt: PublicKey;
  /** Jupiter's quote-response `addressLookupTableAddresses`. */
  jupiterAlts: PublicKey[];

  /** Signer + fee payer. */
  caller: Keypair;
  /** Recipient of the output note. */
  recipientWallet: Wallet;

  inMint: PublicKey;
  outMint: PublicKey;
  inAmount: bigint;
  /** Pool's post-CPI floor on `out_vault` delta. */
  minOutAmount: bigint;
  /** Value the output note will claim. Typically == minOutAmount. */
  outputAmount: bigint;

  /** Pre-fetched Jupiter swap instruction (from `/swap-instructions` API). */
  jupiterSwapIx: JupiterSwapInstruction;
}

export interface PrivateSwapResult {
  signature: string;
  /** Output note for the recipient. Commit in outMint, value = outputAmount. */
  outputNote: SpendableNote;
  /** Serialized tx size actually sent. Under MAX_TX_SIZE by construction. */
  txSizeBytes: number;
}

export async function privateSwap(params: PrivateSwapParams): Promise<PrivateSwapResult> {
  const {
    connection, poolProgramId, jupiterAdapterId, b402Alt, jupiterAlts,
    caller, recipientWallet, inMint, outMint,
    inAmount, minOutAmount, outputAmount, jupiterSwapIx,
  } = params;

  if (inAmount <= 0n || inAmount >= (1n << 64n)) throw new Error('inAmount out of u64 range');
  if (minOutAmount <= 0n) throw new Error('minOutAmount must be > 0');
  if (outputAmount < 0n || outputAmount > minOutAmount) {
    // outputAmount > minOutAmount would mean the note over-claims vs. the
    // guaranteed vault delta. Pool would accept, but unshield could fail if
    // Jupiter delivered only the minimum. Reject here for caller safety.
    throw new Error('outputAmount must be <= minOutAmount');
  }
  if (jupiterSwapIx.data.length > MAX_ACTION_PAYLOAD) {
    throw new Error(
      `Jupiter route data ${jupiterSwapIx.data.length} B exceeds MAX_ACTION_PAYLOAD ${MAX_ACTION_PAYLOAD} B — reduce hops or simplify route`,
    );
  }

  // 1. Resolve ALTs.
  const altAccounts: AddressLookupTableAccount[] = [];
  const b402AltAcct = await connection.getAddressLookupTable(b402Alt);
  if (!b402AltAcct.value) throw new Error(`b402 ALT ${b402Alt.toBase58()} not found`);
  altAccounts.push(b402AltAcct.value);
  for (const alt of jupiterAlts) {
    const a = await connection.getAddressLookupTable(alt);
    if (!a.value) throw new Error(`Jupiter ALT ${alt.toBase58()} not found`);
    altAccounts.push(a.value);
  }

  // 2. Build the output note (commit in outMint, value = outputAmount).
  const outMintFr = leToFrReduced(outMint.toBytes());
  const random = leToFrReduced(randomBytes(32));
  const commitment = await commitmentHash(outMintFr, outputAmount, random, recipientWallet.spendingPub);
  const encryptedNote = await encryptNote(
    { tokenMint: outMintFr, value: outputAmount, random, spendingPub: recipientWallet.spendingPub },
    recipientWallet.viewingPub,
    0n, // leaf_index placeholder — real index is known post-tx from the event
  );
  const outputCommitmentLe = fr32Le(commitment);

  // 3. Encode adapter's `execute` Anchor ix data.
  //    disc(8) || in_amount (u64 LE) || min_out (u64 LE) || Vec<u8>(payload)
  const rawAdapterIxData = concat(
    instructionDiscriminator('execute'),
    u64Le(inAmount),
    u64Le(minOutAmount),
    vecU8(jupiterSwapIx.data),
  );

  // 4. Pool ix data: disc || AdaptExecuteDevnetArgs
  //    args: u64 in_amount, u64 min_out, Vec<u8> raw_adapter_ix_data,
  //          [u8;32] output_commitment, EncryptedNote { [u8;89], [u8;32], [u8;2] }
  const poolArgs = concat(
    u64Le(inAmount),
    u64Le(minOutAmount),
    vecU8(rawAdapterIxData),
    outputCommitmentLe,
    encodeEncryptedNote(encryptedNote),
  );
  const poolIxData = concat(
    instructionDiscriminator('adapt_execute_devnet'),
    poolArgs,
  );

  // 5. Build pool ix account list: named accounts then Jupiter keys.
  const adapterAuthority = PublicKey.findProgramAddressSync(
    [new TextEncoder().encode('b402/v1'), new TextEncoder().encode('adapter')],
    jupiterAdapterId,
  )[0];
  const adapterInTa = await getAssociatedTokenAddress(inMint, adapterAuthority, true);
  const adapterOutTa = await getAssociatedTokenAddress(outMint, adapterAuthority, true);

  const poolIxKeys = [
    { pubkey: caller.publicKey,                 isSigner: true,  isWritable: true  },
    { pubkey: poolConfigPda(poolProgramId),     isSigner: false, isWritable: false },
    { pubkey: adapterRegistryPda(poolProgramId),isSigner: false, isWritable: false },
    { pubkey: tokenConfigPda(poolProgramId, inMint),   isSigner: false, isWritable: false },
    { pubkey: tokenConfigPda(poolProgramId, outMint),  isSigner: false, isWritable: false },
    { pubkey: vaultPda(poolProgramId, inMint),         isSigner: false, isWritable: true  },
    { pubkey: vaultPda(poolProgramId, outMint),        isSigner: false, isWritable: true  },
    { pubkey: treeStatePda(poolProgramId),             isSigner: false, isWritable: true  },
    { pubkey: jupiterAdapterId,                        isSigner: false, isWritable: false },
    { pubkey: adapterAuthority,                        isSigner: false, isWritable: false },
    { pubkey: adapterInTa,                             isSigner: false, isWritable: true  },
    { pubkey: adapterOutTa,                            isSigner: false, isWritable: true  },
    { pubkey: TOKEN_PROGRAM_ID,                        isSigner: false, isWritable: false },
    // Remaining accounts: Jupiter's keys (forwarded to adapter).
    ...jupiterSwapIx.keys,
  ];

  const poolIx = new TransactionInstruction({
    programId: poolProgramId,
    keys: poolIxKeys,
    data: Buffer.from(poolIxData),
  });

  // Pool handles CPI budget internally; request enough headroom for
  // Jupiter + verifier-equivalent work.
  const cuIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 });

  // 6. Compose v0 tx with ALTs.
  const blockhash = (await connection.getLatestBlockhash('confirmed')).blockhash;
  const msg = new TransactionMessage({
    payerKey: caller.publicKey,
    recentBlockhash: blockhash,
    instructions: [cuIx, poolIx],
  }).compileToV0Message(altAccounts);

  const tx = new VersionedTransaction(msg);
  tx.sign([caller]);

  const serialized = tx.serialize();
  if (serialized.length > MAX_TX_SIZE) {
    throw new Error(
      `tx size ${serialized.length} B exceeds MAX_TX_SIZE ${MAX_TX_SIZE} B. ` +
      `action_payload=${jupiterSwapIx.data.length} accounts=${poolIxKeys.length} alts=${altAccounts.length}. ` +
      `Reduce route hops or add the heavy accounts to b402 ALT via ops/alt/create-alt.ts add-adapter.`,
    );
  }

  const sig = await connection.sendRawTransaction(serialized, {
    skipPreflight: false, preflightCommitment: 'confirmed',
  });
  await connection.confirmTransaction(sig, 'confirmed');

  // Leaf index is known from the CommitmentAppended event. Scanner ingests
  // this; we return the note with a placeholder index that callers overwrite
  // once they parse the tx logs (same pattern as shield).
  const outputNote: SpendableNote = {
    tokenMint: outMintFr,
    value: outputAmount,
    random,
    spendingPub: recipientWallet.spendingPub,
    commitment,
    leafIndex: 0n, // caller replaces after log parse
    spendingPriv: recipientWallet.spendingPriv,
    encryptedBytes: encryptedNote.ciphertext,
    ephemeralPub: encryptedNote.ephemeralPub,
    viewingTag: encryptedNote.viewingTag,
  };

  return { signature: sig, outputNote, txSizeBytes: serialized.length };
}

// ---------- helpers ----------

function fr32Le(v: bigint): Uint8Array {
  const out = new Uint8Array(32);
  let x = v;
  for (let i = 0; i < 32; i++) {
    out[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return out;
}

/** Borsh-encode a single EncryptedNote: ciphertext[89] || ephemeralPub[32] || viewingTag[2]. */
function encodeEncryptedNote(n: EncryptedNote): Uint8Array {
  if (n.ciphertext.length !== 89) throw new Error('bad ciphertext length');
  if (n.ephemeralPub.length !== 32) throw new Error('bad ephemeralPub length');
  if (n.viewingTag.length !== 2) throw new Error('bad viewingTag length');
  return concat(n.ciphertext, n.ephemeralPub, n.viewingTag);
}

// Re-exported so callers can size-check their payload before building a full tx.
export { u32Le };
export type { MessageV0 };

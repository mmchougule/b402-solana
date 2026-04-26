/**
 * Tx assembly + submission.
 *
 * The relayer assembles a v0 (versioned) tx from a client-supplied raw
 * instruction. The client is responsible for everything that's bound by the
 * proof — ix data, account list, ALT contents, amounts. The relayer only:
 *   1. Slots itself in as fee payer.
 *   2. Forces account[0].pubkey = relayer.publicKey when the client marks it
 *      as a signer (the pool's `relayer: Signer<'info>` constraint).
 *   3. Adds a ComputeBudget setComputeUnitLimit ix in front.
 *   4. Signs with the relayer keypair and (optionally) attaches a
 *      caller-provided pre-signed user signature for ops with a second signer.
 *   5. Submits via JSON-RPC (skipPreflight) or via Jito bundle endpoint.
 *
 * Returns confirmation context for the response body.
 */

import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import type { AccountMetaInput } from './validate.js';
import { Errors } from './errors.js';

export interface SubmitInput {
  programId: PublicKey;
  ixData: Uint8Array;
  accountKeys: AccountMetaInput[];
  altAddresses: PublicKey[];
  computeUnitLimit: number;
  /** Optional pre-signed user signature: base64 64-byte ed25519 sig + signing pubkey. */
  userSignature?: { signature: Uint8Array; pubkey: PublicKey };
}

export interface SubmitResult {
  signature: string;
  slot: number;
  confirmedAt: string; // ISO-8601
}

export interface Submitter {
  submit(input: SubmitInput): Promise<SubmitResult>;
}

export interface SubmitDeps {
  connection: Connection;
  relayer: Keypair;
  maxTxSize: number;
  jitoBundleUrl: string | null;
  /** Override fetch impl in tests. */
  fetchImpl?: typeof fetch;
}

export class RpcSubmitter implements Submitter {
  constructor(private readonly deps: SubmitDeps) {}

  async submit(input: SubmitInput): Promise<SubmitResult> {
    const tx = await this.buildAndSign(input);
    const wire = tx.serialize();
    if (wire.length > this.deps.maxTxSize) {
      throw Errors.txTooLarge(wire.length, this.deps.maxTxSize);
    }

    if (this.deps.jitoBundleUrl) {
      return this.submitViaJito(wire);
    }
    return this.submitViaRpc(wire);
  }

  private async buildAndSign(input: SubmitInput): Promise<VersionedTransaction> {
    const { connection, relayer } = this.deps;

    const cuIx = ComputeBudgetProgram.setComputeUnitLimit({ units: input.computeUnitLimit });

    // Resolve any ALTs the client referenced.
    const luts: AddressLookupTableAccount[] = [];
    for (const addr of input.altAddresses) {
      const acc = await connection.getAddressLookupTable(addr);
      if (!acc.value) {
        throw Errors.badRequest(`unknown address lookup table ${addr.toBase58()}`);
      }
      luts.push(acc.value);
    }

    // Reshape the client account list:
    //   - the pool requires account[0] = relayer (signer + writable);
    //     overwrite the pubkey there with our relayer key so the client can
    //     pass any placeholder.
    //   - everything else is forwarded verbatim.
    if (input.accountKeys.length === 0) {
      throw Errors.badRequest('accountKeys must include at least the fee payer');
    }
    const first = input.accountKeys[0]!;
    if (!first.isSigner || !first.isWritable) {
      throw Errors.badRequest('accountKeys[0] must be marked isSigner=true, isWritable=true (relayer slot)');
    }

    const keys = input.accountKeys.map((k, i) => ({
      pubkey: i === 0 ? relayer.publicKey : new PublicKey(k.pubkey),
      isSigner: k.isSigner,
      isWritable: k.isWritable,
    }));

    const ix = new TransactionInstruction({
      programId: input.programId,
      keys,
      data: Buffer.from(input.ixData),
    });

    const blockhash = (await connection.getLatestBlockhash('confirmed')).blockhash;
    const msg = new TransactionMessage({
      payerKey: relayer.publicKey,
      recentBlockhash: blockhash,
      instructions: [cuIx, ix],
    }).compileToV0Message(luts);

    const vtx = new VersionedTransaction(msg);

    // Collect signers. Relayer always signs. If the client supplied a user
    // signature for a second signer slot, attach it directly via addSignature
    // so we don't need the user's keypair in this process.
    vtx.sign([relayer]);

    if (input.userSignature) {
      vtx.addSignature(input.userSignature.pubkey, input.userSignature.signature);
    }

    return vtx;
  }

  private async submitViaRpc(wire: Uint8Array): Promise<SubmitResult> {
    const { connection } = this.deps;
    let sig: string;
    try {
      sig = await connection.sendRawTransaction(wire, {
        skipPreflight: true,
        maxRetries: 3,
        preflightCommitment: 'confirmed',
      });
    } catch (e) {
      throw Errors.rpcFailure(`sendRawTransaction failed: ${(e as Error).message}`);
    }
    const conf = await connection.confirmTransaction(sig, 'confirmed');
    if (conf.value.err) {
      throw Errors.rpcFailure(`tx failed on-chain: ${JSON.stringify(conf.value.err)}`, { signature: sig });
    }
    return {
      signature: sig,
      slot: conf.context.slot,
      confirmedAt: new Date().toISOString(),
    };
  }

  private async submitViaJito(wire: Uint8Array): Promise<SubmitResult> {
    const url = this.deps.jitoBundleUrl;
    if (!url) throw Errors.internal('jito url missing');
    const fetchFn = this.deps.fetchImpl ?? fetch;
    const b58Tx = base58Encode(wire);
    const body = {
      jsonrpc: '2.0',
      id: 1,
      method: 'sendBundle',
      params: [[b58Tx]],
    };
    const res = await fetchFn(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw Errors.rpcFailure(`jito sendBundle ${res.status}`, { status: res.status });
    }
    const json = (await res.json()) as { result?: string; error?: { message: string } };
    if (json.error || !json.result) {
      throw Errors.rpcFailure(`jito error: ${json.error?.message ?? 'no result'}`);
    }
    // Jito returns a bundle id, not a tx signature. Confirmation has to be
    // polled via getSignatureStatuses against the embedded tx — here we
    // recompute the signature locally from the wire bytes.
    const sig = recoverFirstSignature(wire);
    const confirmed = await this.deps.connection.confirmTransaction(sig, 'confirmed');
    if (confirmed.value.err) {
      throw Errors.rpcFailure(`tx failed on-chain (jito): ${JSON.stringify(confirmed.value.err)}`, { signature: sig });
    }
    return {
      signature: sig,
      slot: confirmed.context.slot,
      confirmedAt: new Date().toISOString(),
    };
  }
}

/** Recover the first signature from a serialised v0 tx — the fee-payer sig.
 *  Layout: u8 numRequiredSignatures shortvec || sig[0..64] ... */
function recoverFirstSignature(wire: Uint8Array): string {
  // shortvec varint: high bit continuation. For numSigs typically < 128, 1 byte.
  let off = 0;
  let count = 0;
  let shift = 0;
  while (true) {
    const b = wire[off++]!;
    count |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) break;
    shift += 7;
    if (shift > 21) throw new Error('shortvec too long');
  }
  if (count < 1) throw new Error('no signatures in tx');
  const sig = wire.slice(off, off + 64);
  return base58Encode(sig);
}

// Minimal base58 encoder (Solana alphabet) — avoids pulling in bs58.
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58Encode(bytes: Uint8Array): string {
  // count leading zero bytes
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;

  // convert to base 58
  const digits: number[] = [0];
  for (let i = zeros; i < bytes.length; i++) {
    let carry = bytes[i]!;
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j]! * 256;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let out = '';
  for (let i = 0; i < zeros; i++) out += '1';
  for (let i = digits.length - 1; i >= 0; i--) out += B58[digits[i]!];
  return out;
}

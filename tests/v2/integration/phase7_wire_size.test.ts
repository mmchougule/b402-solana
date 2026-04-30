/**
 * Phase 7 — wire-size delta measurement.
 *
 * Constructs synthetic v2.1 (sibling-ix) and Phase 7 (inline-CPI) shapes
 * for unshield + adapt_execute, serializes them as v0 messages, and prints
 * the delta. Real validity proofs aren't required — we only care about the
 * Borsh + AccountMeta layout's encoded byte cost. Fake 134-B payloads and
 * fake account keys are sufficient: Solana's wire format is purely
 * structural at this layer.
 *
 * The numbers reported here go straight into docs/prds/PHASE-7-HANDOFF.md.
 *
 * Run:
 *   pnpm --filter @b402ai/solana-v2-tests vitest run integration/phase7_wire_size
 */

import { describe, it } from 'vitest';
import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
} from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';

// --------- helpers (wire encoding only — no proofs/photon needed) ---------

function fakeProof(): Uint8Array {
  // 256 zero bytes — the verifier-side proof shape, matches what the SDK
  // would emit. Only its byte count contributes to the wire-size measurement.
  return new Uint8Array(256);
}
function fakeBytes(n: number): Uint8Array {
  return new Uint8Array(n);
}
function u32Le(n: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, n, true);
  return out;
}
function u64Le(n: bigint): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, n, true);
  return out;
}
function vecU8(b: Uint8Array): Uint8Array {
  const len = u32Le(b.length);
  const out = new Uint8Array(len.length + b.length);
  out.set(len, 0);
  out.set(b, len.length);
  return out;
}
function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((a, b) => a + b.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

// Generate a deterministic-ish set of fake pubkeys for the test.
function fkey(tag: string): PublicKey {
  // Hash via deterministic Keypair from seed for stability.
  const seed = new Uint8Array(32);
  const enc = new TextEncoder().encode(tag);
  seed.set(enc.subarray(0, Math.min(enc.length, 32)));
  return Keypair.fromSeed(seed).publicKey;
}

const SYSVAR_INSTRUCTIONS = new PublicKey(
  'Sysvar1nstructions1111111111111111111111111',
);
const B402_NULLIFIER_PROGRAM_ID = new PublicKey(
  '2AnRZwWu6CTurZs1yQpqrcJWo4yRYL1xpeV78b2siweq',
);
const B402_POOL = fkey('b402_pool');
const VERIFIER = fkey('verifier_transact');
const ADAPT_VERIFIER = fkey('verifier_adapt');
const RELAYER = fkey('relayer');
const POOL_CONFIG = fkey('pool_config');
const TREE_STATE = fkey('tree_state');
const TOKEN_CONFIG = fkey('token_config');
const VAULT = fkey('vault');
const RECIPIENT_TA = fkey('recipient_ta');

// ---- Build the 9 / 10 nullifier-side accounts (matches SDK's helpers) ----

function buildLightAccounts9(): { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[] {
  return [
    { pubkey: RELAYER, isSigner: true, isWritable: true },
    { pubkey: fkey('light_system_program'), isSigner: false, isWritable: false },
    { pubkey: fkey('cpi_authority'), isSigner: false, isWritable: false },
    { pubkey: fkey('registered_program_pda'), isSigner: false, isWritable: false },
    { pubkey: fkey('account_compression_authority'), isSigner: false, isWritable: false },
    { pubkey: fkey('account_compression_program'), isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: fkey('address_tree'), isSigner: false, isWritable: true },
    { pubkey: fkey('output_queue'), isSigner: false, isWritable: true },
  ];
}
function buildLightAccounts10(): { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[] {
  const a = buildLightAccounts9();
  return [
    a[0], // payer
    { pubkey: SYSVAR_INSTRUCTIONS, isSigner: false, isWritable: false },
    ...a.slice(1),
  ];
}

// ---- Build a synthetic create_nullifier sibling ix ----

function buildSiblingNullifierIx(): TransactionInstruction {
  // Discriminator (8) + ValidityProof Borsh (1+32+64+32 = 129) + tree info (4)
  // + state idx (1) + id (32) = 174 bytes. Matches buildCreateNullifierIx.
  const data = new Uint8Array(8 + 129 + 4 + 1 + 32);
  return new TransactionInstruction({
    programId: B402_NULLIFIER_PROGRAM_ID,
    keys: buildLightAccounts9(),
    data: Buffer.from(data),
  });
}

// ---- Build synthetic Unshield ix: v2.1 (sibling) and Phase 7 (inline) ----

function buildUnshieldIxData(inline: boolean): Uint8Array {
  const parts: Uint8Array[] = [
    fakeBytes(8),               // ix discriminator
    vecU8(fakeProof()),         // proof: 4 + 256
    fakeBytes(32),              // merkle_root
    fakeBytes(32),              // nullifier[0]
    fakeBytes(32),              // nullifier[1]
    fakeBytes(32),              // commitment_out[0]
    fakeBytes(32),              // commitment_out[1]
    u64Le(0n),                  // public_amount_in
    u64Le(100_000n),            // public_amount_out
    fakeBytes(32),              // public_token_mint
    u64Le(0n),                  // relayer_fee
    fakeBytes(32),              // relayer_fee_bind
    fakeBytes(32),              // root_bind
    fakeBytes(32),              // recipient_bind
    u32Le(0),                   // encrypted_notes vec len = 0
    new Uint8Array([0b10]),     // in_dummy_mask
    new Uint8Array([0b11]),     // out_dummy_mask
    fakeBytes(32),              // relayer_fee_recipient
  ];
  if (inline) {
    parts.push(u32Le(1));                       // outer Vec<Vec<u8>> len
    parts.push(vecU8(fakeBytes(134)));          // single 134 B payload
  }
  return concat(...parts);
}

function buildUnshieldIx(inline: boolean): TransactionInstruction {
  const baseKeys = [
    { pubkey: RELAYER, isSigner: true, isWritable: true },
    { pubkey: POOL_CONFIG, isSigner: false, isWritable: false },
    { pubkey: TOKEN_CONFIG, isSigner: false, isWritable: false },
    { pubkey: VAULT, isSigner: false, isWritable: true },
    { pubkey: RECIPIENT_TA, isSigner: false, isWritable: true },
    { pubkey: RECIPIENT_TA, isSigner: false, isWritable: true },
    { pubkey: TREE_STATE, isSigner: false, isWritable: true },
    { pubkey: VERIFIER, isSigner: false, isWritable: false },
    { pubkey: SYSVAR_INSTRUCTIONS, isSigner: false, isWritable: false },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ];
  const inlineExtras = inline
    ? [
        { pubkey: B402_NULLIFIER_PROGRAM_ID, isSigner: false, isWritable: false },
        ...buildLightAccounts10(),
      ]
    : [];
  return new TransactionInstruction({
    programId: B402_POOL,
    keys: [...baseKeys, ...inlineExtras],
    data: Buffer.from(buildUnshieldIxData(inline)),
  });
}

// ---- Build a synthetic adapt_execute ix (1 real nullifier, single adapter
//      with N adapter remaining accounts to mimic Jupiter / Kamino routes). ----

function buildAdaptIxData(inline: boolean, adapterIxDataLen: number, actionPayloadLen: number): Uint8Array {
  const parts: Uint8Array[] = [
    fakeBytes(8),                              // disc
    vecU8(fakeProof()),                        // proof
    fakeBytes(32),                             // merkle_root
    fakeBytes(32),                             // nullifier[0]
    fakeBytes(32),                             // nullifier[1]
    fakeBytes(32),                             // commitment_out[0]
    fakeBytes(32),                             // commitment_out[1]
    u64Le(100_000n),                           // public_amount_in
    u64Le(0n),                                 // public_amount_out
    u64Le(0n),                                 // relayer_fee
    fakeBytes(32),                             // relayer_fee_bind
    fakeBytes(32),                             // root_bind
    fakeBytes(32),                             // recipient_bind
    fakeBytes(32),                             // adapter_id
    fakeBytes(32),                             // action_hash
    u64Le(0n),                                 // expected_out_value
    u32Le(0),                                  // encrypted_notes vec len
    new Uint8Array([0b10]),                    // in_dummy_mask
    new Uint8Array([0b10]),                    // out_dummy_mask
    fakeBytes(32),                             // relayer_fee_recipient
    vecU8(fakeBytes(adapterIxDataLen)),        // raw_adapter_ix_data
    vecU8(fakeBytes(actionPayloadLen)),        // action_payload
  ];
  if (inline) {
    parts.push(u32Le(1));
    parts.push(vecU8(fakeBytes(134)));
  }
  return concat(...parts);
}

function buildAdaptIx(
  inline: boolean,
  adapterRemainingCount: number,
  adapterIxDataLen: number,
  actionPayloadLen: number,
): TransactionInstruction {
  const namedKeys = [
    { pubkey: RELAYER, isSigner: true, isWritable: true },
    { pubkey: POOL_CONFIG, isSigner: false, isWritable: false },
    { pubkey: fkey('adapter_registry'), isSigner: false, isWritable: false },
    { pubkey: fkey('token_config_in'), isSigner: false, isWritable: false },
    { pubkey: fkey('token_config_out'), isSigner: false, isWritable: false },
    { pubkey: fkey('in_vault'), isSigner: false, isWritable: true },
    { pubkey: fkey('out_vault'), isSigner: false, isWritable: true },
    { pubkey: TREE_STATE, isSigner: false, isWritable: true },
    { pubkey: ADAPT_VERIFIER, isSigner: false, isWritable: false },
    { pubkey: fkey('adapter_program'), isSigner: false, isWritable: false },
    { pubkey: fkey('adapter_authority'), isSigner: false, isWritable: false },
    { pubkey: fkey('adapter_in_ta'), isSigner: false, isWritable: true },
    { pubkey: fkey('adapter_out_ta'), isSigner: false, isWritable: true },
    { pubkey: fkey('relayer_fee_ta'), isSigner: false, isWritable: true },
    { pubkey: SYSVAR_INSTRUCTIONS, isSigner: false, isWritable: false },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ];
  const inlineExtras = inline
    ? [
        { pubkey: B402_NULLIFIER_PROGRAM_ID, isSigner: false, isWritable: false },
        ...buildLightAccounts10(),
      ]
    : [];
  const adapterRemaining = Array.from({ length: adapterRemainingCount }, (_, i) => ({
    pubkey: fkey(`adapter_remaining_${i}`),
    isSigner: false,
    isWritable: i % 2 === 0,
  }));
  return new TransactionInstruction({
    programId: B402_POOL,
    keys: [...namedKeys, ...inlineExtras, ...adapterRemaining],
    data: Buffer.from(buildAdaptIxData(inline, adapterIxDataLen, actionPayloadLen)),
  });
}

// ---- Compose v0 message + measure with an ALT containing every key ----

function measureV0(ixs: TransactionInstruction[]): number {
  // Build a synthetic ALT that covers every static key referenced by the
  // ixs, so the measurement matches the production path where everything is
  // ALT-compressed. Anything signer/writable still has to live in the
  // static keys table; readonly non-signer keys can be ALT-indexed.
  const allKeys = new Set<string>();
  for (const ix of ixs) {
    allKeys.add(ix.programId.toBase58());
    for (const k of ix.keys) allKeys.add(k.pubkey.toBase58());
  }
  const altKeys = [...allKeys]
    .filter((k) => {
      // Don't put the fee payer or any signer/writable key in the ALT —
      // those must live in the static account list. Approximate by
      // excluding RELAYER (only writable signer in our shapes).
      return k !== RELAYER.toBase58();
    })
    .map((k) => new PublicKey(k));
  const alt: AddressLookupTableAccount = new AddressLookupTableAccount({
    key: fkey('alt'),
    state: {
      deactivationSlot: BigInt('18446744073709551615'),
      lastExtendedSlot: 1,
      lastExtendedSlotStartIndex: 0,
      addresses: altKeys,
      authority: undefined,
    },
  });
  const msg = new TransactionMessage({
    payerKey: RELAYER,
    recentBlockhash: '11111111111111111111111111111111',
    instructions: ixs,
  }).compileToV0Message([alt]);
  return msg.serialize().length;
}

const cuIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 });

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

describe('Phase 7 — wire-size delta (v2.1 sibling vs Phase 7 inline-CPI)', () => {
  it('measures unshield + privateSwap + privateLend tx bytes', () => {
    // -------- Unshield --------
    const unshieldSibling = measureV0([
      cuIx,
      buildUnshieldIx(false),
      buildSiblingNullifierIx(),
    ]);
    const unshieldInline = measureV0([cuIx, buildUnshieldIx(true)]);

    // -------- privateSwap (Jupiter-ish: 24 adapter remaining accounts,
    //          ~80 B raw_adapter_ix_data, 8 B action_payload) --------
    const swapSibling = measureV0([
      cuIx,
      buildAdaptIx(false, 24, 80, 8),
      buildSiblingNullifierIx(),
    ]);
    const swapInline = measureV0([cuIx, buildAdaptIx(true, 24, 80, 8)]);

    // -------- privateLend (Kamino-ish: 19 adapter remaining accounts,
    //          ~32 B raw_adapter_ix_data, 16 B action_payload) --------
    const lendSibling = measureV0([
      cuIx,
      buildAdaptIx(false, 19, 32, 16),
      buildSiblingNullifierIx(),
    ]);
    const lendInline = measureV0([cuIx, buildAdaptIx(true, 19, 32, 16)]);

    // -------- Report --------
    /* eslint-disable no-console */
    console.log('\n=== Phase 7 wire-size delta (v0 + ALT, every-key-in-ALT) ===');
    console.log(`${pad('flow', 14)} ${pad('sibling', 10)} ${pad('inline', 10)} ${pad('delta', 10)} cap=1232`);
    const row = (name: string, sib: number, inl: number) => {
      const delta = inl - sib;
      const sign = delta > 0 ? '+' : '';
      console.log(
        `${pad(name, 14)} ${pad(String(sib) + ' B', 10)} ${pad(String(inl) + ' B', 10)} ${pad(sign + String(delta) + ' B', 10)}` +
        `  ${sib > 1232 ? 'OVER' : 'OK'} → ${inl > 1232 ? 'OVER' : 'OK'}`,
      );
    };
    row('unshield', unshieldSibling, unshieldInline);
    row('swap (24 ra)', swapSibling, swapInline);
    row('lend (19 ra)', lendSibling, lendInline);
    /* eslint-enable no-console */
  });
});

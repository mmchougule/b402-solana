/**
 * Borsh round-trip tests for the SDK's on-the-wire instruction encoders.
 *
 * The SDK builds instruction data inline with `concat()` + the small
 * helpers in `programs/anchor.ts`. The on-chain pool program decodes the
 * same bytes via Anchor's Borsh derive on `ShieldArgs` / `UnshieldArgs` /
 * `TransactArgs` / `AdaptExecuteArgs`.
 *
 * If the SDK encoder and the on-chain decoder ever disagree on field
 * order, length prefixes, or struct layout, every transaction fails with
 * an opaque deserialization error after fee deduction. These tests pin
 * the byte-for-byte contract by:
 *   1. Encoding a fixture struct via the same primitives (`u32Le`, `u64Le`,
 *      `concat`, etc.) the SDK uses.
 *   2. Re-parsing the bytes with a parser that mirrors the on-chain struct.
 *   3. Asserting the parsed values match the fixture exactly.
 *
 * Reference layouts (kept in sync with the on-chain handlers):
 *   - `ShieldArgs`     : programs/b402-pool/src/instructions/shield.rs §15
 *   - `TransactArgs`   : programs/b402-pool/src/instructions/transact.rs §16
 *   - `UnshieldArgs`   : programs/b402-pool/src/instructions/unshield.rs §18
 *   - `AdaptExecuteArgs`: programs/b402-pool/src/instructions/adapt_execute.rs §69
 */

import { describe, it, expect } from 'vitest';
import { concat, u16Le, u32Le, u64Le, vecU8 } from '../programs/anchor.js';

// ---------- Reference Borsh primitive parsers ----------

class Reader {
  private off = 0;
  constructor(private readonly buf: Uint8Array) {}

  read(n: number): Uint8Array {
    if (this.off + n > this.buf.length) {
      throw new Error(`read past end: need ${n} at ${this.off}, have ${this.buf.length}`);
    }
    const out = this.buf.slice(this.off, this.off + n);
    this.off += n;
    return out;
  }
  readU8(): number { return this.read(1)[0]; }
  readU16Le(): number {
    const b = this.read(2);
    return b[0] | (b[1] << 8);
  }
  readU32Le(): number {
    const b = this.read(4);
    return (b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24)) >>> 0;
  }
  readU64Le(): bigint {
    const b = this.read(8);
    let v = 0n;
    for (let i = 0; i < 8; i++) v |= BigInt(b[i]) << BigInt(8 * i);
    return v;
  }
  readArr32(): Uint8Array { return this.read(32); }
  readVecU8(): Uint8Array { return this.read(this.readU32Le()); }
  readVecArr<T>(parseOne: () => T): T[] {
    const n = this.readU32Le();
    const out: T[] = [];
    for (let i = 0; i < n; i++) out.push(parseOne());
    return out;
  }
  remaining(): number { return this.buf.length - this.off; }
  consumed(): number { return this.off; }
}

// ---------- Reference structs (mirror the on-chain Borsh derives) ----------

interface EncryptedNote {
  ciphertext: Uint8Array;     // [u8; 89]
  ephemeralPub: Uint8Array;   // [u8; 32]
  viewingTag: Uint8Array;     // [u8; 2]
}

interface TransactPublicInputs {
  merkleRoot: Uint8Array;
  nullifier0: Uint8Array;
  nullifier1: Uint8Array;
  commitmentOut0: Uint8Array;
  commitmentOut1: Uint8Array;
  publicAmountIn: bigint;
  publicAmountOut: bigint;
  publicTokenMint: Uint8Array;
  relayerFee: bigint;
  relayerFeeBind: Uint8Array;
  rootBind: Uint8Array;
  recipientBind: Uint8Array;
}

interface AdaptPublicInputs extends TransactPublicInputs {
  adapterId: Uint8Array;
  actionHash: Uint8Array;
  expectedOutValue: bigint;
  expectedOutMint: Uint8Array;
}

function readEncryptedNote(r: Reader): EncryptedNote {
  return {
    ciphertext: r.read(89),
    ephemeralPub: r.read(32),
    viewingTag: r.read(2),
  };
}

function readTransactPublicInputs(r: Reader): TransactPublicInputs {
  return {
    merkleRoot: r.readArr32(),
    nullifier0: r.readArr32(),
    nullifier1: r.readArr32(),
    commitmentOut0: r.readArr32(),
    commitmentOut1: r.readArr32(),
    publicAmountIn: r.readU64Le(),
    publicAmountOut: r.readU64Le(),
    publicTokenMint: r.readArr32(),
    relayerFee: r.readU64Le(),
    relayerFeeBind: r.readArr32(),
    rootBind: r.readArr32(),
    recipientBind: r.readArr32(),
  };
}

function readAdaptPublicInputs(r: Reader): AdaptPublicInputs {
  const base = readTransactPublicInputs(r);
  return {
    ...base,
    adapterId: r.readArr32(),
    actionHash: r.readArr32(),
    expectedOutValue: r.readU64Le(),
    expectedOutMint: r.readArr32(),
  };
}

// ---------- Encoder (mirrors what shield.ts / unshield.ts / swap-e2e.ts emit) ----------

function encodeTransactPublicInputs(p: TransactPublicInputs): Uint8Array {
  return concat(
    p.merkleRoot,
    p.nullifier0,
    p.nullifier1,
    p.commitmentOut0,
    p.commitmentOut1,
    u64Le(p.publicAmountIn),
    u64Le(p.publicAmountOut),
    p.publicTokenMint,
    u64Le(p.relayerFee),
    p.relayerFeeBind,
    p.rootBind,
    p.recipientBind,
  );
}

function encodeAdaptPublicInputs(p: AdaptPublicInputs): Uint8Array {
  return concat(
    encodeTransactPublicInputs(p),
    p.adapterId,
    p.actionHash,
    u64Le(p.expectedOutValue),
    p.expectedOutMint,
  );
}

function encodeEncryptedNotes(notes: EncryptedNote[]): Uint8Array {
  const parts: Uint8Array[] = [u32Le(notes.length)];
  for (const n of notes) {
    parts.push(n.ciphertext, n.ephemeralPub, n.viewingTag);
  }
  return concat(...parts);
}

// ---------- Fixtures ----------

function fillBytes(seed: number, len: number): Uint8Array {
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) out[i] = (seed + i) & 0xFF;
  return out;
}

function fixtureTransactPublicInputs(seed: number): TransactPublicInputs {
  return {
    merkleRoot:       fillBytes(seed + 0,  32),
    nullifier0:       fillBytes(seed + 1,  32),
    nullifier1:       fillBytes(seed + 2,  32),
    commitmentOut0:   fillBytes(seed + 3,  32),
    commitmentOut1:   fillBytes(seed + 4,  32),
    publicAmountIn:   1_000_000n,
    publicAmountOut:  0n,
    publicTokenMint:  fillBytes(seed + 5,  32),
    relayerFee:       0n,
    relayerFeeBind:   fillBytes(seed + 6,  32),
    rootBind:         fillBytes(seed + 7,  32),
    recipientBind:    fillBytes(seed + 8,  32),
  };
}

function fixtureEncryptedNote(seed: number): EncryptedNote {
  return {
    ciphertext:   fillBytes(seed + 100, 89),
    ephemeralPub: fillBytes(seed + 101, 32),
    viewingTag:   fillBytes(seed + 102, 2),
  };
}

function fixtureProof(): Uint8Array {
  // 256 = 64 (A) + 128 (B) + 64 (C). Realistic length the on-chain handler
  // asserts via `require!(args.proof.len() == 256, ...)`.
  return fillBytes(0xAA, 256);
}

function expectBytesEqual(actual: Uint8Array, expected: Uint8Array, label: string): void {
  expect(actual.length, `${label} length`).toBe(expected.length);
  for (let i = 0; i < expected.length; i++) {
    if (actual[i] !== expected[i]) {
      throw new Error(`${label} mismatch at byte ${i}: got 0x${actual[i].toString(16)}, want 0x${expected[i].toString(16)}`);
    }
  }
}

// ---------- Tests ----------

describe('Borsh round-trip — ShieldArgs', () => {
  it('encodes and re-parses byte-identical', () => {
    // ShieldArgs { proof: Vec<u8>, public_inputs, encrypted_notes: Vec<EncryptedNote>, note_dummy_mask: u8 }
    const proof = fixtureProof();
    const pi = fixtureTransactPublicInputs(0x10);
    const note = fixtureEncryptedNote(0x10);
    const noteDummyMask = 0b10;

    const encoded = concat(
      vecU8(proof),
      encodeTransactPublicInputs(pi),
      encodeEncryptedNotes([note]),
      new Uint8Array([noteDummyMask]),
    );

    // Re-parse.
    const r = new Reader(encoded);
    const decodedProof = r.readVecU8();
    const decodedPi = readTransactPublicInputs(r);
    const decodedNotes = r.readVecArr(() => readEncryptedNote(r));
    const decodedMask = r.readU8();

    expect(r.remaining()).toBe(0);
    expectBytesEqual(decodedProof, proof, 'proof');
    expect(decodedPi.publicAmountIn).toBe(pi.publicAmountIn);
    expectBytesEqual(decodedPi.merkleRoot, pi.merkleRoot, 'merkleRoot');
    expectBytesEqual(decodedPi.recipientBind, pi.recipientBind, 'recipientBind');
    expect(decodedNotes.length).toBe(1);
    expectBytesEqual(decodedNotes[0].ciphertext, note.ciphertext, 'ciphertext');
    expectBytesEqual(decodedNotes[0].ephemeralPub, note.ephemeralPub, 'ephemeralPub');
    expectBytesEqual(decodedNotes[0].viewingTag, note.viewingTag, 'viewingTag');
    expect(decodedMask).toBe(noteDummyMask);
  });
});

describe('Borsh round-trip — TransactArgs', () => {
  it('encodes and re-parses byte-identical', () => {
    // TransactArgs { proof, public_inputs, encrypted_notes, in_dummy_mask, out_dummy_mask, nullifier_shard_prefix: [u16; 2] }
    const proof = fixtureProof();
    const pi: TransactPublicInputs = {
      ...fixtureTransactPublicInputs(0x20),
      // Internal-only constraints (handler enforces; fixture must not violate).
      publicAmountIn: 0n,
      publicAmountOut: 0n,
    };
    const inDummy = 0b00;
    const outDummy = 0b00;
    const shardPrefixes: [number, number] = [0x1234, 0x5678];

    const encoded = concat(
      vecU8(proof),
      encodeTransactPublicInputs(pi),
      encodeEncryptedNotes([]),
      new Uint8Array([inDummy]),
      new Uint8Array([outDummy]),
      u16Le(shardPrefixes[0]),
      u16Le(shardPrefixes[1]),
    );

    const r = new Reader(encoded);
    const decodedProof = r.readVecU8();
    const decodedPi = readTransactPublicInputs(r);
    const decodedNotes = r.readVecArr(() => readEncryptedNote(r));
    const decodedInMask = r.readU8();
    const decodedOutMask = r.readU8();
    const decodedShard0 = r.readU16Le();
    const decodedShard1 = r.readU16Le();

    expect(r.remaining()).toBe(0);
    expect(decodedProof.length).toBe(256);
    expect(decodedPi.publicAmountIn).toBe(0n);
    expect(decodedNotes.length).toBe(0);
    expect(decodedInMask).toBe(inDummy);
    expect(decodedOutMask).toBe(outDummy);
    expect(decodedShard0).toBe(shardPrefixes[0]);
    expect(decodedShard1).toBe(shardPrefixes[1]);
  });
});

describe('Borsh round-trip — UnshieldArgs', () => {
  it('encodes and re-parses byte-identical', () => {
    // UnshieldArgs adds relayer_fee_recipient: Pubkey ([u8; 32]) at the end.
    const proof = fixtureProof();
    const pi: TransactPublicInputs = {
      ...fixtureTransactPublicInputs(0x30),
      publicAmountIn: 0n,
      publicAmountOut: 250_000n,
      relayerFee: 1_000n,
    };
    const inMask = 0b10;
    const outMask = 0b11;
    const shardPrefixes: [number, number] = [0xABCD, 0x0000];
    const relayerFeeRecipient = fillBytes(0xEE, 32);

    const encoded = concat(
      vecU8(proof),
      encodeTransactPublicInputs(pi),
      encodeEncryptedNotes([]),
      new Uint8Array([inMask]),
      new Uint8Array([outMask]),
      u16Le(shardPrefixes[0]),
      u16Le(shardPrefixes[1]),
      relayerFeeRecipient,
    );

    const r = new Reader(encoded);
    r.readVecU8(); // proof
    const decodedPi = readTransactPublicInputs(r);
    r.readVecArr(() => readEncryptedNote(r));
    expect(r.readU8()).toBe(inMask);
    expect(r.readU8()).toBe(outMask);
    expect(r.readU16Le()).toBe(shardPrefixes[0]);
    expect(r.readU16Le()).toBe(shardPrefixes[1]);
    const decodedRecipient = r.readArr32();

    expect(r.remaining()).toBe(0);
    expect(decodedPi.publicAmountOut).toBe(250_000n);
    expect(decodedPi.relayerFee).toBe(1_000n);
    expectBytesEqual(decodedRecipient, relayerFeeRecipient, 'relayer_fee_recipient');
  });
});

describe('Borsh round-trip — AdaptExecuteArgs', () => {
  it('encodes and re-parses byte-identical (v1 layout per swap-e2e.ts)', () => {
    // AdaptExecuteArgs {
    //   proof, public_inputs (AdaptPublicInputs — 23 fields),
    //   encrypted_notes, in_dummy_mask, out_dummy_mask,
    //   nullifier_shard_prefix: [u16; 2], relayer_fee_recipient: Pubkey,
    //   raw_adapter_ix_data: Vec<u8>, action_payload: Vec<u8>
    // }
    const proof = fixtureProof();
    const pi: AdaptPublicInputs = {
      ...fixtureTransactPublicInputs(0x40),
      publicAmountIn: 100_000n,
      publicAmountOut: 0n,
      adapterId:   fillBytes(0x40 + 20, 32),
      actionHash:  fillBytes(0x40 + 21, 32),
      expectedOutValue: 95_000n,
      expectedOutMint:  fillBytes(0x40 + 22, 32),
    };
    const inMask = 0b10;
    const outMask = 0b10;
    const shardPrefixes: [number, number] = [0x4242, 0x0000];
    const relayerFeeRecipient = fillBytes(0xFE, 32);
    // First 8 bytes = adapter ix discriminator (registry-allowlisted).
    const rawAdapterIxData = concat(
      new Uint8Array([130, 221, 242, 154, 13, 193, 189, 29]), // mock_adapter::execute disc
      u64Le(100_000n),  // in_amount
      u64Le(95_000n),   // min_out_amount
      vecU8(new Uint8Array(8).fill(0)), // action_payload (empty for sanity)
    );
    const actionPayload = fillBytes(0xCD, 32);

    const encoded = concat(
      vecU8(proof),
      encodeAdaptPublicInputs(pi),
      encodeEncryptedNotes([]),
      new Uint8Array([inMask]),
      new Uint8Array([outMask]),
      u16Le(shardPrefixes[0]),
      u16Le(shardPrefixes[1]),
      relayerFeeRecipient,
      vecU8(rawAdapterIxData),
      vecU8(actionPayload),
    );

    const r = new Reader(encoded);
    r.readVecU8(); // proof
    const decodedPi = readAdaptPublicInputs(r);
    r.readVecArr(() => readEncryptedNote(r));
    expect(r.readU8()).toBe(inMask);
    expect(r.readU8()).toBe(outMask);
    expect(r.readU16Le()).toBe(shardPrefixes[0]);
    expect(r.readU16Le()).toBe(shardPrefixes[1]);
    const decodedRecipient = r.readArr32();
    const decodedRawIx = r.readVecU8();
    const decodedAction = r.readVecU8();

    expect(r.remaining()).toBe(0);
    expect(decodedPi.publicAmountIn).toBe(100_000n);
    expect(decodedPi.expectedOutValue).toBe(95_000n);
    expectBytesEqual(decodedPi.adapterId, pi.adapterId, 'adapterId');
    expectBytesEqual(decodedPi.actionHash, pi.actionHash, 'actionHash');
    expectBytesEqual(decodedPi.expectedOutMint, pi.expectedOutMint, 'expectedOutMint');
    expectBytesEqual(decodedRecipient, relayerFeeRecipient, 'relayer_fee_recipient');
    expectBytesEqual(decodedRawIx, rawAdapterIxData, 'raw_adapter_ix_data');
    expectBytesEqual(decodedAction, actionPayload, 'action_payload');
  });
});

import { describe, it, expect } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import {
  RelayRequestSchema,
  decodeIxData,
  extractRelayerFee,
  isAllowedProgram,
  RELAYER_FEE_OFFSET,
  readU64Le,
} from '../src/validate.js';

describe('RelayRequestSchema', () => {
  it('accepts a minimal valid body', () => {
    const body = {
      ixData: Buffer.from(new Uint8Array(500)).toString('base64'),
      accountKeys: [
        { pubkey: '11111111111111111111111111111111', isSigner: true, isWritable: true },
      ],
    };
    const r = RelayRequestSchema.safeParse(body);
    expect(r.success).toBe(true);
  });

  it('rejects non-base64 ixData', () => {
    const body = {
      ixData: 'not!base64!!',
      accountKeys: [
        { pubkey: '11111111111111111111111111111111', isSigner: true, isWritable: true },
      ],
    };
    const r = RelayRequestSchema.safeParse(body);
    expect(r.success).toBe(false);
  });

  it('rejects empty accountKeys', () => {
    const body = {
      ixData: Buffer.from(new Uint8Array(500)).toString('base64'),
      accountKeys: [],
    };
    const r = RelayRequestSchema.safeParse(body);
    expect(r.success).toBe(false);
  });

  it('caps accountKeys at 64', () => {
    const body = {
      ixData: Buffer.from(new Uint8Array(500)).toString('base64'),
      accountKeys: Array.from({ length: 65 }, () => ({
        pubkey: '11111111111111111111111111111111',
        isSigner: false,
        isWritable: false,
      })),
    };
    const r = RelayRequestSchema.safeParse(body);
    expect(r.success).toBe(false);
  });

  it('accepts additionalIxs (v2 sibling ix)', () => {
    const body = {
      ixData: Buffer.from(new Uint8Array(500)).toString('base64'),
      accountKeys: [
        { pubkey: '11111111111111111111111111111111', isSigner: true, isWritable: true },
      ],
      additionalIxs: [
        {
          programId: 'SysvarRent111111111111111111111111111111111',
          ixData: Buffer.from(new Uint8Array(64)).toString('base64'),
          accountKeys: [
            { pubkey: '11111111111111111111111111111111', isSigner: true, isWritable: true },
            { pubkey: 'SysvarRent111111111111111111111111111111111', isSigner: false, isWritable: false },
          ],
        },
      ],
    };
    const r = RelayRequestSchema.safeParse(body);
    expect(r.success).toBe(true);
  });

  it('caps additionalIxs at 4', () => {
    const body = {
      ixData: Buffer.from(new Uint8Array(500)).toString('base64'),
      accountKeys: [
        { pubkey: '11111111111111111111111111111111', isSigner: true, isWritable: true },
      ],
      additionalIxs: Array.from({ length: 5 }, () => ({
        programId: 'SysvarRent111111111111111111111111111111111',
        ixData: Buffer.from(new Uint8Array(8)).toString('base64'),
        accountKeys: [
          { pubkey: '11111111111111111111111111111111', isSigner: true, isWritable: true },
        ],
      })),
    };
    const r = RelayRequestSchema.safeParse(body);
    expect(r.success).toBe(false);
  });
});

describe('readU64Le', () => {
  it('decodes little-endian u64', () => {
    const b = new Uint8Array(8);
    // 0x1122334455667788 in LE
    b[0] = 0x88; b[1] = 0x77; b[2] = 0x66; b[3] = 0x55;
    b[4] = 0x44; b[5] = 0x33; b[6] = 0x22; b[7] = 0x11;
    expect(readU64Le(b, 0)).toBe(0x1122334455667788n);
  });

  it('throws on out-of-bounds read', () => {
    expect(() => readU64Le(new Uint8Array(4), 0)).toThrow();
  });
});

describe('extractRelayerFee', () => {
  it('returns null when buffer too short', () => {
    expect(extractRelayerFee(new Uint8Array(100))).toBeNull();
  });

  it('reads u64 LE from RELAYER_FEE_OFFSET', () => {
    const buf = new Uint8Array(RELAYER_FEE_OFFSET + 8 + 100);
    // Set fee = 12345 at the offset.
    let v = 12345n;
    for (let i = 0; i < 8; i++) {
      buf[RELAYER_FEE_OFFSET + i] = Number(v & 0xffn);
      v >>= 8n;
    }
    expect(extractRelayerFee(buf)).toBe(12345n);
  });
});

describe('decodeIxData', () => {
  it('decodes round-trip', () => {
    const original = Uint8Array.from([1, 2, 3, 4, 250, 99]);
    const b64 = Buffer.from(original).toString('base64');
    const out = decodeIxData(b64);
    expect(Array.from(out)).toEqual([1, 2, 3, 4, 250, 99]);
  });
});

describe('isAllowedProgram', () => {
  it('matches by PublicKey equality', () => {
    const a = new PublicKey('11111111111111111111111111111111');
    const b = new PublicKey('SysvarRent111111111111111111111111111111111');
    expect(isAllowedProgram(a, [a, b])).toBe(true);
    expect(isAllowedProgram(b, [a])).toBe(false);
  });
});

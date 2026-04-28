import { describe, it, expect } from 'vitest';
import { bech32 } from '@scure/base';
import { FR_MODULUS } from '@b402ai/solana-shared';
import {
  encodeStealthAddress,
  decodeStealthAddress,
  STEALTH_ADDRESS_HRP,
  STEALTH_ADDRESS_VERSION,
} from '../stealth/address.js';
import { B402Error, B402ErrorCode } from '../errors.js';

function bytes(b: number): Uint8Array {
  return new Uint8Array(32).fill(b);
}

describe('stealth-address bech32', () => {
  it('round-trips a representative key pair', () => {
    const spendingPub = 0x0123456789abcdefn * (1n << 64n) + 0xfeedfacecafebaben;
    const viewingPub = bytes(0x42);

    const s = encodeStealthAddress(spendingPub, viewingPub);

    expect(s.startsWith(`${STEALTH_ADDRESS_HRP}1`)).toBe(true);

    const back = decodeStealthAddress(s);
    expect(back.spendingPub).toBe(spendingPub);
    expect(Array.from(back.viewingPub)).toEqual(Array.from(viewingPub));
  });

  it('round-trips many random valid pairs', () => {
    for (let i = 0; i < 32; i++) {
      const spendingPub = BigInt(i) * 0xdeadbeefn + 1n;
      const view = new Uint8Array(32);
      for (let j = 0; j < 32; j++) view[j] = (i * 7 + j) & 0xff;
      const s = encodeStealthAddress(spendingPub, view);
      const back = decodeStealthAddress(s);
      expect(back.spendingPub).toBe(spendingPub);
      expect(Array.from(back.viewingPub)).toEqual(Array.from(view));
    }
  });

  it('rejects a tampered checksum', () => {
    const s = encodeStealthAddress(7n, bytes(1));
    // Flip the last data char before the checksum tail. Bech32 checksum is the
    // last 6 chars; flipping any earlier data char invalidates it.
    const tampered = s.slice(0, -7) + flipChar(s[s.length - 7]) + s.slice(-6);
    expect(() => decodeStealthAddress(tampered)).toThrow(B402Error);
  });

  it('rejects wrong HRP (checksum-aware: existing string under a wrong prefix)', () => {
    // This case exercises the checksum branch — bech32's checksum is a function
    // of HRP, so swapping the prefix while keeping the same data part fails
    // checksum first.
    const s = encodeStealthAddress(7n, bytes(1));
    const dataPart = s.slice(STEALTH_ADDRESS_HRP.length);
    const wrongHrpStr = 'b402evm' + dataPart;
    expect(() => decodeStealthAddress(wrongHrpStr)).toThrow(B402Error);
  });

  it('rejects wrong HRP (valid checksum: re-encoded under a different HRP)', () => {
    // This case exercises the explicit `prefix !== STEALTH_ADDRESS_HRP` branch
    // — same payload re-encoded under another HRP has a *valid* checksum but
    // wrong prefix.
    const payload = new Uint8Array(1 + 32 + 32);
    payload[0] = STEALTH_ADDRESS_VERSION;
    payload.set(bytes(0x07), 1);
    payload.set(bytes(0x01), 33);
    const wrongHrp = bech32.encode('b402evm', bech32.toWords(payload), 256);

    try {
      decodeStealthAddress(wrongHrp);
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(B402Error);
      const err = e as B402Error;
      expect(err.code).toBe(B402ErrorCode.InvalidRecipient);
      expect(err.message).toContain('wrong HRP');
    }
  });

  it('rejects non-canonical Fr in decode (spending bytes >= FR_MODULUS)', () => {
    // Construct a payload whose spending-key bytes encode 2^254 (well above
    // FR_MODULUS). leToFr rejects this; the wrapper must surface it as
    // InvalidRecipient, not as a raw Error.
    const payload = new Uint8Array(1 + 32 + 32);
    payload[0] = STEALTH_ADDRESS_VERSION;
    // 32-byte LE: bit 254 set ⇒ value 2^254, > FR_MODULUS
    payload[1 + 31] = 0x40;
    // viewing key bytes irrelevant; default zeros are fine
    const bad = bech32.encode(STEALTH_ADDRESS_HRP, bech32.toWords(payload), 256);

    try {
      decodeStealthAddress(bad);
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(B402Error);
      const err = e as B402Error;
      expect(err.code).toBe(B402ErrorCode.InvalidRecipient);
      expect(err.message).toContain('non-canonical');
    }
  });

  it('rejects out-of-range spending key on encode', () => {
    expect(() => encodeStealthAddress(FR_MODULUS, bytes(1))).toThrow();
    expect(() => encodeStealthAddress(-1n, bytes(1))).toThrow();
  });

  it('rejects wrong-length viewing key on encode', () => {
    expect(() => encodeStealthAddress(7n, new Uint8Array(31))).toThrow(B402Error);
    expect(() => encodeStealthAddress(7n, new Uint8Array(33))).toThrow(B402Error);
  });

  it('frozen reference vector — detects accidental layout changes', () => {
    // spendingPub = 1, viewingPub = 0x02 repeated 32 times.
    // If the layout (HRP, version, byte order, key order) ever changes,
    // this assertion is the canary.
    const s = encodeStealthAddress(1n, bytes(0x02));
    expect(s).toBe(
      'b402sol1qqqsqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszjqdaeh',
    );
    const back = decodeStealthAddress(s);
    expect(back.spendingPub).toBe(1n);
    expect(Array.from(back.viewingPub)).toEqual(Array.from(bytes(0x02)));
  });

  it('error code is InvalidRecipient on decode failures', () => {
    try {
      decodeStealthAddress('not-a-valid-bech32-string');
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(B402Error);
      expect((e as B402Error).code).toBe(B402ErrorCode.InvalidRecipient);
    }
  });
});

/** Flip a bech32 charset character to a different valid one. */
function flipChar(c: string): string {
  const charset = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
  const idx = charset.indexOf(c);
  if (idx < 0) throw new Error(`not a bech32 char: ${c}`);
  return charset[(idx + 1) % charset.length];
}

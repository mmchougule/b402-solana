/**
 * Percolator-adapter helper unit tests (slice 4-α).
 *
 * Byte-level parity with the Rust adapter is asserted via fixtures that
 * mirror `programs/b402-percolator-adapter/src/payload.rs::tests::FIXTURE_*_HEX`.
 * Both sides pin the same hex strings; if the wire format drifts on
 * either side, both test suites break loudly.
 *
 * RA layout parity is asserted against the Rust constants in
 * `programs/b402-percolator-adapter/src/actions/open.rs::RA_*` (which
 * `close.rs` re-exports). If those constants change, this test breaks.
 *
 * PDA derivation tests cross-check the seed string + program-id scoping
 * properties from PRD-33 §3.2 (cross-adapter identity isolation).
 */
import { describe, it, expect } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import {
  buildPercolatorOpenActionPayload,
  buildPercolatorCloseActionPayload,
  buildPercolatorPerUserPayload,
  buildPercolatorExecuteIxData,
  buildPercolatorPerUserRemainingAccounts,
  derivePercolatorAdapterAuthority,
  derivePercolatorOwnerPda,
  derivePercolatorPerpMapping,
  VIEWING_PUB_HASH_PREFIX_LEN,
  PAYLOAD_MAX_LEN,
  PERCOLATOR_MAX_ACCOUNTS_DEFAULT,
} from '../percolator.js';

// ─── byte-pin fixtures, lifted verbatim from
//     programs/b402-percolator-adapter/src/payload.rs::tests ───
//
// To regenerate after an intentional wire-format change:
//   1. Update Rust `FIXTURE_*_HEX` consts + `fixture_*` builders.
//   2. Mirror the changes here.
//   3. Run `cargo test fixture_` and `pnpm --filter @b402ai/solana test percolator`.

const FIXTURE_OPEN_A_INPUT = {
  lpIdx: 7,
  sizeE6: 1_500_000n,
  limitPriceE6: 200_000_000n,
  feePaymentIfInit: 100_000n,
};
const FIXTURE_OPEN_A_HEX =
  '000700' +
  '60e31600000000000000000000000000' +
  '00c2eb0b00000000' +
  'a086010000000000';

const FIXTURE_OPEN_B_INPUT = {
  lpIdx: 0,
  sizeE6: -1_000_000n,
  limitPriceE6: 100_000_000n,
  feePaymentIfInit: 0n,
};
const FIXTURE_OPEN_B_HEX =
  '000000' +
  'c0bdf0ffffffffffffffffffffffffff' +
  '00e1f50500000000' +
  '0000000000000000';

const FIXTURE_CLOSE_A_INPUT = { lpIdx: 3, limitPriceE6: 199_000_000n };
const FIXTURE_CLOSE_A_HEX = '010300' + 'c07fdc0b00000000';

function hexNoWs(s: string): Uint8Array {
  const cleaned = s.replace(/\s+/g, '');
  const out = new Uint8Array(cleaned.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(cleaned.slice(2 * i, 2 * i + 2), 16);
  }
  return out;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

describe('buildPercolatorOpenActionPayload', () => {
  it('byte-pin: fixture_open_a matches Rust encoder', () => {
    const bytes = buildPercolatorOpenActionPayload(FIXTURE_OPEN_A_INPUT);
    expect(toHex(bytes)).toBe(FIXTURE_OPEN_A_HEX);
    expect(bytes.length).toBe(35);
  });

  it('byte-pin: fixture_open_b (negative size) matches two\'s-complement i128 LE', () => {
    const bytes = buildPercolatorOpenActionPayload(FIXTURE_OPEN_B_INPUT);
    expect(toHex(bytes)).toBe(FIXTURE_OPEN_B_HEX);
  });

  it('starts with OpenPosition discriminant 0x00', () => {
    const bytes = buildPercolatorOpenActionPayload(FIXTURE_OPEN_A_INPUT);
    expect(bytes[0]).toBe(0);
  });

  it('rejects out-of-range u16 lp_idx', () => {
    expect(() =>
      buildPercolatorOpenActionPayload({ ...FIXTURE_OPEN_A_INPUT, lpIdx: 65_536 }),
    ).toThrow(/u16 out of range/);
    expect(() =>
      buildPercolatorOpenActionPayload({ ...FIXTURE_OPEN_A_INPUT, lpIdx: -1 }),
    ).toThrow(/u16 out of range/);
  });

  it('rejects out-of-range u64 limit_price_e6', () => {
    expect(() =>
      buildPercolatorOpenActionPayload({ ...FIXTURE_OPEN_A_INPUT, limitPriceE6: -1n }),
    ).toThrow(/u64 out of range/);
  });

  it('rejects out-of-range i128 size_e6', () => {
    const tooBig = (1n << 128n);
    expect(() =>
      buildPercolatorOpenActionPayload({ ...FIXTURE_OPEN_A_INPUT, sizeE6: tooBig }),
    ).toThrow(/i128 out of range/);
  });

  it('encodes i128::MAX size (sanity for type-system bounds)', () => {
    const I128_MAX = (1n << 127n) - 1n;
    const bytes = buildPercolatorOpenActionPayload({
      ...FIXTURE_OPEN_A_INPUT,
      sizeE6: I128_MAX,
    });
    // Last byte of size_e6 should be 0x7f (sign bit cleared in MSB).
    expect(bytes[3 + 15]).toBe(0x7f);
  });
});

describe('buildPercolatorCloseActionPayload', () => {
  it('byte-pin: fixture_close_a matches Rust encoder', () => {
    const bytes = buildPercolatorCloseActionPayload(FIXTURE_CLOSE_A_INPUT);
    expect(toHex(bytes)).toBe(FIXTURE_CLOSE_A_HEX);
    expect(bytes.length).toBe(11);
  });

  it('starts with ClosePosition discriminant 0x01', () => {
    const bytes = buildPercolatorCloseActionPayload(FIXTURE_CLOSE_A_INPUT);
    expect(bytes[0]).toBe(1);
  });
});

describe('buildPercolatorPerUserPayload', () => {
  it('prepends the 32-byte viewing_pub_hash', () => {
    const hash = new Uint8Array(32).fill(0xab);
    const inner = buildPercolatorCloseActionPayload(FIXTURE_CLOSE_A_INPUT);
    const wrapped = buildPercolatorPerUserPayload(hash, inner);
    expect(wrapped.length).toBe(32 + 11);
    expect(wrapped.slice(0, 32)).toEqual(hash);
    expect(toHex(wrapped.slice(32))).toBe(FIXTURE_CLOSE_A_HEX);
  });

  it('rejects wrong-length viewing_pub_hash', () => {
    const inner = buildPercolatorCloseActionPayload(FIXTURE_CLOSE_A_INPUT);
    expect(() =>
      buildPercolatorPerUserPayload(new Uint8Array(31), inner),
    ).toThrow(/must be 32 bytes/);
    expect(() =>
      buildPercolatorPerUserPayload(new Uint8Array(33), inner),
    ).toThrow(/must be 32 bytes/);
  });

  it('rejects oversized payload', () => {
    const hash = new Uint8Array(32);
    const tooBig = new Uint8Array(PAYLOAD_MAX_LEN); // 32 + 350 > 350
    expect(() => buildPercolatorPerUserPayload(hash, tooBig)).toThrow(/exceeds/);
  });

  it('VIEWING_PUB_HASH_PREFIX_LEN pinned to 32 (wire-compat sentinel)', () => {
    expect(VIEWING_PUB_HASH_PREFIX_LEN).toBe(32);
  });
});

describe('buildPercolatorExecuteIxData', () => {
  it('emits disc(8) | in_amount(8) | min_out(8) | len(4) | payload', () => {
    const payload = buildPercolatorOpenActionPayload(FIXTURE_OPEN_A_INPUT);
    const data = buildPercolatorExecuteIxData({
      inAmount: 50_000_000n,
      expectedOut: 0n,
      actionPayload: payload,
    });
    // Anchor "global:execute" sha256[..8] = 82 dd f2 9a 0d c1 bd 1d
    expect(toHex(data.slice(0, 8))).toBe('82ddf29a0dc1bd1d');
    // u64 LE inAmount = 50_000_000 = 0x02FAF080
    expect(toHex(data.slice(8, 16))).toBe('80f0fa0200000000');
    expect(toHex(data.slice(16, 24))).toBe('0000000000000000');
    // u32 LE len = payload.length = 35 = 0x23
    expect(toHex(data.slice(24, 28))).toBe('23000000');
    expect(data.slice(28)).toEqual(payload);
    expect(data.length).toBe(8 + 8 + 8 + 4 + payload.length);
  });
});

// ─── PDA derivations (PRD-36 §5.2) ───

const ADAPTER_PROGRAM_ID = new PublicKey('Brp48gh1WcS6EtuKYFmK49Ldd55F9cdDkrYbfvh6RCq6');
const KAMINO_ADAPTER_ID_PLACEHOLDER = new PublicKey(
  // Just a deterministic-but-distinct stand-in for the cross-adapter test below.
  '11111111111111111111111111111112',
);

describe('derivePercolatorAdapterAuthority', () => {
  it('is deterministic for a given program id', () => {
    const [a, ba] = derivePercolatorAdapterAuthority(ADAPTER_PROGRAM_ID);
    const [b, bb] = derivePercolatorAdapterAuthority(ADAPTER_PROGRAM_ID);
    expect(a.toBase58()).toBe(b.toBase58());
    expect(ba).toBe(bb);
  });
});

describe('derivePercolatorOwnerPda', () => {
  it('changes with viewing_pub_hash', () => {
    const h1 = new Uint8Array(32).fill(0);
    const h2 = new Uint8Array(32);
    h2[0] = 1;
    const [a] = derivePercolatorOwnerPda(ADAPTER_PROGRAM_ID, h1);
    const [b] = derivePercolatorOwnerPda(ADAPTER_PROGRAM_ID, h2);
    expect(a.toBase58()).not.toBe(b.toBase58());
  });

  it('PRD-33 §3.2: differs across adapters for the same viewing_pub_hash', () => {
    // The cross-adapter scoping property: a kamino adapter's owner_pda
    // for viewing_pub_hash H must NEVER collide with a percolator adapter's
    // owner_pda for the same H. Here we vary only the program_id (kamino
    // would also vary the second seed segment to "kamino-owner", which
    // adds a second axis of separation, but program_id alone suffices).
    const h = new Uint8Array(32).fill(42);
    const [percA] = derivePercolatorOwnerPda(ADAPTER_PROGRAM_ID, h);
    const [percB] = derivePercolatorOwnerPda(KAMINO_ADAPTER_ID_PLACEHOLDER, h);
    expect(percA.toBase58()).not.toBe(percB.toBase58());
  });

  it('rejects wrong-length viewing_pub_hash', () => {
    expect(() =>
      derivePercolatorOwnerPda(ADAPTER_PROGRAM_ID, new Uint8Array(31)),
    ).toThrow(/must be 32 bytes/);
  });
});

describe('derivePercolatorPerpMapping', () => {
  it('is per-slab', () => {
    const slab1 = new PublicKey('11111111111111111111111111111112');
    const slab2 = new PublicKey('11111111111111111111111111111113');
    const [a] = derivePercolatorPerpMapping(ADAPTER_PROGRAM_ID, slab1);
    const [b] = derivePercolatorPerpMapping(ADAPTER_PROGRAM_ID, slab2);
    expect(a.toBase58()).not.toBe(b.toBase58());
  });
});

// ─── remaining_accounts layout (RA_* constants from open.rs) ───

describe('buildPercolatorPerUserRemainingAccounts', () => {
  function fixturePerUser() {
    const k = (n: number) => new PublicKey(new Uint8Array(32).fill(n));
    return {
      mapping: k(1),
      ownerPda: k(2),
      userPercolatorAta: k(3),
      slab: k(4),
      slabVault: k(5),
      percolatorProgram: k(6),
      clock: k(7),
      lpOwner: k(8),
      oracle: k(9),
      matcherProgram: k(10),
      matcherContext: k(11),
      lpPda: k(12),
    };
  }

  it('emits 12 head slots in pinned order', () => {
    const ra = buildPercolatorPerUserRemainingAccounts(fixturePerUser());
    expect(ra.length).toBe(12);
    // Verify slot N has pubkey filled with byte (N+1) — matches the fixture.
    for (let i = 0; i < 12; i++) {
      const expected = new PublicKey(new Uint8Array(32).fill(i + 1));
      expect(ra[i].pubkey.toBase58()).toBe(expected.toBase58());
    }
  });

  it('marks the right slots writable (matches RA_* in open.rs / close.rs)', () => {
    const ra = buildPercolatorPerUserRemainingAccounts(fixturePerUser());
    // Pinned writability: 0 mapping, 1 owner_pda, 2 user_pcl_ata, 3 slab,
    // 4 slab_vault, 10 matcher_context, 11 lp_pda.
    const expectedWritable = new Set([0, 1, 2, 3, 4, 10, 11]);
    for (let i = 0; i < ra.length; i++) {
      expect(ra[i].isWritable).toBe(expectedWritable.has(i));
      expect(ra[i].isSigner).toBe(false);
    }
  });

  it('appends matcher_tail after slot 12 when present', () => {
    const tail = [
      { pubkey: new PublicKey(new Uint8Array(32).fill(0xfe)), isSigner: false, isWritable: false },
      { pubkey: new PublicKey(new Uint8Array(32).fill(0xff)), isSigner: false, isWritable: true },
    ];
    const ra = buildPercolatorPerUserRemainingAccounts({ ...fixturePerUser(), matcherTail: tail });
    expect(ra.length).toBe(14);
    expect(ra[12]).toEqual(tail[0]);
    expect(ra[13]).toEqual(tail[1]);
  });

  it('PERCOLATOR_MAX_ACCOUNTS_DEFAULT pinned to 1024 (matches deployment tier)', () => {
    expect(PERCOLATOR_MAX_ACCOUNTS_DEFAULT).toBe(1024);
  });
});

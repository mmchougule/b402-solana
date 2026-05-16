/**
 * Unit tests for Token-2022 transferHook account-resolution helpers.
 *
 * Strategy: build a synthetic mint account buffer that carries a TLV-encoded
 * TransferHook extension, and a synthetic ExtraAccountMetaList PDA account
 * with one or zero extra fixed-pubkey metas. Mock `Connection.getAccountInfo`
 * to return them. Assert that `appendTransferHookAccounts` mutates the
 * passed-in instruction's `keys` array in the expected way:
 *   - hookless mint        → no change
 *   - mint with hook       → `keys.length` grows by (extras + 2)
 *     (the helper appends extras, then hook programId, then the ExtraAccountMetaList PDA)
 *   - mint with hook but missing PDA → clear error
 *
 * We deliberately avoid pulling a real on-chain mint into the unit test —
 * mainnet-fork integration is the parent task's responsibility.
 */

import { describe, it, expect } from 'vitest';
import {
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  AccountInfo,
} from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ExtensionType,
  ACCOUNT_SIZE,
  AccountType,
  getExtraAccountMetaAddress,
} from '@solana/spl-token';

import {
  appendTransferHookAccounts,
  mintHasTransferHook,
} from '../programs/transfer-hook.js';

// ---------- mint buffer builder ----------

/**
 * Build a synthetic Token-2022 mint account buffer with an optional
 * TransferHook extension. Matches the layout `unpackMint` expects:
 *   [0 .. MINT_SIZE)              raw mint fields (zeroed — `isInitialized`
 *                                   doesn't matter for `getTransferHook`)
 *   [MINT_SIZE .. ACCOUNT_SIZE)   padding to ACCOUNT_SIZE (165 bytes)
 *   [ACCOUNT_SIZE]                AccountType.Mint (= 1)
 *   [ACCOUNT_SIZE + 1 ..)         TLV blob: u16 type, u16 len, bytes value
 *
 * For a TransferHook extension: type = 14, len = 64 (authority 32 + programId 32).
 */
function buildMintBufferWithHook(hookProgramId: PublicKey | null): Buffer {
  // Minimum buffer size large enough to be unambiguously NOT a Multisig
  // (multisig has its own special-cased size). MINT_SIZE is 82, ACCOUNT_SIZE
  // is 165; we need at least ACCOUNT_SIZE + 1 + TLV bytes.
  const TLV_HEADER = 4; // u16 type + u16 length
  const TLV_VALUE = 64; // TransferHookLayout: authority (32) + programId (32)
  const size = hookProgramId ? ACCOUNT_SIZE + 1 + TLV_HEADER + TLV_VALUE
                              : ACCOUNT_SIZE + 1; // empty TLV blob
  const buf = Buffer.alloc(size);

  // Mark Initialized and a sensible decimals so callers that read the mint
  // don't trip on a missing-init guard. `unpackMint` only requires data.length
  // >= MINT_SIZE; everything beyond MINT_SIZE is parsed as TLV.
  buf.writeUInt8(6, 44);  // decimals = 6 (offset of `decimals` in MintLayout)
  buf.writeUInt8(1, 45);  // isInitialized = true

  // Account type discriminator at ACCOUNT_SIZE.
  buf.writeUInt8(AccountType.Mint, ACCOUNT_SIZE);

  if (hookProgramId) {
    const tlvOff = ACCOUNT_SIZE + 1;
    buf.writeUInt16LE(ExtensionType.TransferHook, tlvOff);
    buf.writeUInt16LE(TLV_VALUE, tlvOff + 2);
    // authority (32 zero bytes) + programId (32 bytes)
    hookProgramId.toBuffer().copy(buf, tlvOff + 4 + 32);
  }

  return buf;
}

function mintAccountInfo(data: Buffer): AccountInfo<Buffer> {
  return {
    owner: TOKEN_2022_PROGRAM_ID,
    data,
    executable: false,
    lamports: 1_000_000,
    rentEpoch: 0,
  };
}

/**
 * Build a minimal ExtraAccountMetaList PDA account with `extras` discriminator=0
 * (fixed-pubkey) entries. Layout (per @solana/spl-token state.js):
 *   - 8 bytes  instruction discriminator (anchor-style; opaque to the helper)
 *   - 4 bytes  length
 *   - 4 bytes  count (u32)
 *   - greedy[] ExtraAccountMeta { u8 disc, blob[32] addressConfig, bool signer, bool writable }
 */
function buildExtraMetasAccount(extras: PublicKey[]): AccountInfo<Buffer> {
  const ENTRY_SIZE = 1 + 32 + 1 + 1; // 35 bytes per ExtraAccountMeta
  const headerSize = 8 + 4 + 4;
  const buf = Buffer.alloc(headerSize + extras.length * ENTRY_SIZE);

  // 8 bytes: instructionDiscriminator (unused by our consumer paths, zero is fine)
  // 4 bytes: length (in BYTES) — set to extras.length * ENTRY_SIZE so the
  //          replicate-decoder reads exactly that many bytes for the inner
  //          struct. The layout uses `greedy(span, name)` over the slice
  //          returned by `replicate`, so over-reporting length would let
  //          the decoder run past `extras.length` entries.
  buf.writeUInt32LE(4 + extras.length * ENTRY_SIZE, 8); // includes the inner 4-byte count
  // 4 bytes: count (u32) — number of entries to keep
  buf.writeUInt32LE(extras.length, 12);

  let off = headerSize;
  for (const pk of extras) {
    buf.writeUInt8(0, off); // discriminator = 0 (fixed-pubkey)
    pk.toBuffer().copy(buf, off + 1); // addressConfig = pubkey bytes
    buf.writeUInt8(0, off + 33); // isSigner = false
    buf.writeUInt8(0, off + 34); // isWritable = false
    off += ENTRY_SIZE;
  }

  return {
    owner: SystemProgram.programId,
    data: buf,
    executable: false,
    lamports: 1_000_000,
    rentEpoch: 0,
  };
}

// ---------- connection mock ----------

interface MockEntry {
  pubkey: PublicKey;
  info: AccountInfo<Buffer> | null;
}

function mockConnection(entries: MockEntry[]) {
  const map = new Map<string, AccountInfo<Buffer> | null>();
  for (const e of entries) map.set(e.pubkey.toBase58(), e.info);
  return {
    getAccountInfo: async (pk: PublicKey) => {
      return map.has(pk.toBase58()) ? map.get(pk.toBase58())! : null;
    },
  } as unknown as import('@solana/web3.js').Connection;
}

// ---------- fixtures ----------

const DUMMY_MINT = new PublicKey('Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB');
const DUMMY_HOOK = new PublicKey('pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn');
const DUMMY_SRC = new PublicKey('1nc1nerator11111111111111111111111111111111');
const DUMMY_DST = new PublicKey('11111111111111111111111111111112');
const DUMMY_OWNER = new PublicKey('11111111111111111111111111111113');
const EXTRA_PK = new PublicKey('11111111111111111111111111111114');

function baseInstruction(): TransactionInstruction {
  // The helper validates that source/mint/destination/owner are present in
  // `keys`. Match the pool's transfer_checked ix in spirit — these four are
  // always present on the wire before the helper runs.
  return new TransactionInstruction({
    programId: SystemProgram.programId,
    keys: [
      { pubkey: DUMMY_SRC, isSigner: false, isWritable: true },
      { pubkey: DUMMY_MINT, isSigner: false, isWritable: false },
      { pubkey: DUMMY_DST, isSigner: false, isWritable: true },
      { pubkey: DUMMY_OWNER, isSigner: false, isWritable: false },
    ],
    data: Buffer.alloc(0),
  });
}

// ---------- tests ----------

describe('mintHasTransferHook', () => {
  it('returns true for a Token-2022 mint with a non-default hook programId', async () => {
    const conn = mockConnection([
      { pubkey: DUMMY_MINT, info: mintAccountInfo(buildMintBufferWithHook(DUMMY_HOOK)) },
    ]);
    expect(await mintHasTransferHook(conn, DUMMY_MINT)).toBe(true);
  });

  it('returns false for a Token-2022 mint without the TransferHook extension', async () => {
    const conn = mockConnection([
      { pubkey: DUMMY_MINT, info: mintAccountInfo(buildMintBufferWithHook(null)) },
    ]);
    expect(await mintHasTransferHook(conn, DUMMY_MINT)).toBe(false);
  });

  it('returns false for a classic SPL Token mint (no extensions possible)', async () => {
    const conn = mockConnection([
      {
        pubkey: DUMMY_MINT,
        info: {
          owner: TOKEN_PROGRAM_ID,
          data: Buffer.alloc(82), // MINT_SIZE
          executable: false,
          lamports: 1_000_000,
          rentEpoch: 0,
        },
      },
    ]);
    expect(await mintHasTransferHook(conn, DUMMY_MINT)).toBe(false);
  });

  it('returns false when the TransferHook extension is present but disabled (programId = default)', async () => {
    const conn = mockConnection([
      { pubkey: DUMMY_MINT, info: mintAccountInfo(buildMintBufferWithHook(PublicKey.default)) },
    ]);
    expect(await mintHasTransferHook(conn, DUMMY_MINT)).toBe(false);
  });
});

describe('appendTransferHookAccounts', () => {
  it('appends hook program + extras when mint declares a hook', async () => {
    const extraMetasPda = getExtraAccountMetaAddress(DUMMY_MINT, DUMMY_HOOK);
    const conn = mockConnection([
      { pubkey: DUMMY_MINT, info: mintAccountInfo(buildMintBufferWithHook(DUMMY_HOOK)) },
      { pubkey: extraMetasPda, info: buildExtraMetasAccount([EXTRA_PK]) },
    ]);
    const ix = baseInstruction();
    const before = ix.keys.length;
    await appendTransferHookAccounts({
      connection: conn,
      instruction: ix,
      mint: DUMMY_MINT,
      source: DUMMY_SRC,
      destination: DUMMY_DST,
      owner: DUMMY_OWNER,
      amount: 1_000n,
    });
    // Expected appended (per @solana/spl-token's addExtraAccountMetasForExecute):
    //   - 1 extra-meta entry (EXTRA_PK)
    //   - the hook program ID
    //   - the ExtraAccountMetaList PDA
    expect(ix.keys.length).toBe(before + 3);

    const appended = ix.keys.slice(before);
    const appendedPubs = appended.map(k => k.pubkey.toBase58());
    expect(appendedPubs).toContain(EXTRA_PK.toBase58());
    expect(appendedPubs).toContain(DUMMY_HOOK.toBase58());
    expect(appendedPubs).toContain(extraMetasPda.toBase58());
  });

  it('is a no-op for a Token-2022 mint without a transferHook', async () => {
    const conn = mockConnection([
      { pubkey: DUMMY_MINT, info: mintAccountInfo(buildMintBufferWithHook(null)) },
    ]);
    const ix = baseInstruction();
    const before = ix.keys.length;
    await appendTransferHookAccounts({
      connection: conn,
      instruction: ix,
      mint: DUMMY_MINT,
      source: DUMMY_SRC,
      destination: DUMMY_DST,
      owner: DUMMY_OWNER,
      amount: 1_000n,
    });
    expect(ix.keys.length).toBe(before);
  });

  it('is a no-op for a classic SPL Token mint', async () => {
    const conn = mockConnection([
      {
        pubkey: DUMMY_MINT,
        info: {
          owner: TOKEN_PROGRAM_ID,
          data: Buffer.alloc(82),
          executable: false,
          lamports: 1_000_000,
          rentEpoch: 0,
        },
      },
    ]);
    const ix = baseInstruction();
    const before = ix.keys.length;
    await appendTransferHookAccounts({
      connection: conn,
      instruction: ix,
      mint: DUMMY_MINT,
      source: DUMMY_SRC,
      destination: DUMMY_DST,
      owner: DUMMY_OWNER,
      amount: 1_000n,
    });
    expect(ix.keys.length).toBe(before);
  });

  it('throws a clear error when the hook is declared but ExtraAccountMetaList PDA is missing', async () => {
    // Mint says "hook = DUMMY_HOOK", but we deliberately do not register the
    // ExtraAccountMetaList PDA in the mock — `getAccountInfo` returns null.
    const conn = mockConnection([
      { pubkey: DUMMY_MINT, info: mintAccountInfo(buildMintBufferWithHook(DUMMY_HOOK)) },
      // no entry for getExtraAccountMetaAddress(mint, hook) ⇒ mock returns null
    ]);
    const ix = baseInstruction();
    await expect(
      appendTransferHookAccounts({
        connection: conn,
        instruction: ix,
        mint: DUMMY_MINT,
        source: DUMMY_SRC,
        destination: DUMMY_DST,
        owner: DUMMY_OWNER,
        amount: 1_000n,
      }),
    ).rejects.toThrow(/ExtraAccountMetaList PDA .* does not exist/);
  });
});

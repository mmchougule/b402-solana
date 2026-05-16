/**
 * Unit tests for the `tokenProgramOf` helper.
 *
 * The function is a thin wrapper around `connection.getAccountInfo`; the
 * value is in the validation rules (rejects missing / wrong-owner mints).
 * We mock the Connection at the AccountInfo level.
 */

import { describe, it, expect } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';

import { tokenProgramOf, tokenProgramOfOwner } from '../programs/token-program.js';

/** Minimal Connection mock — only the methods the helper uses. */
function mockConnection(owner: PublicKey | null) {
  return {
    getAccountInfo: async (_pk: PublicKey, _commit?: string) =>
      owner === null
        ? null
        : {
            owner,
            data: Buffer.alloc(0),
            executable: false,
            lamports: 0,
          },
  } as unknown as import('@solana/web3.js').Connection;
}

describe('tokenProgramOf', () => {
  const dummyMint = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');

  it('returns TOKEN_PROGRAM_ID for classic SPL mints', async () => {
    const conn = mockConnection(TOKEN_PROGRAM_ID);
    const program = await tokenProgramOf(conn, dummyMint);
    expect(program.equals(TOKEN_PROGRAM_ID)).toBe(true);
  });

  it('returns TOKEN_2022_PROGRAM_ID for Token-2022 mints', async () => {
    const conn = mockConnection(TOKEN_2022_PROGRAM_ID);
    const program = await tokenProgramOf(conn, dummyMint);
    expect(program.equals(TOKEN_2022_PROGRAM_ID)).toBe(true);
  });

  it('throws if the mint does not exist', async () => {
    const conn = mockConnection(null);
    await expect(tokenProgramOf(conn, dummyMint)).rejects.toThrow(/not found/);
  });

  it('throws if the mint is owned by neither token program', async () => {
    const bogusOwner = new PublicKey('11111111111111111111111111111111');
    const conn = mockConnection(bogusOwner);
    await expect(tokenProgramOf(conn, dummyMint)).rejects.toThrow(/owned by/);
  });
});

describe('tokenProgramOfOwner', () => {
  const dummyMint = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');

  it('accepts the classic SPL Token program', () => {
    const r = tokenProgramOfOwner(TOKEN_PROGRAM_ID, dummyMint);
    expect(r.equals(TOKEN_PROGRAM_ID)).toBe(true);
  });

  it('accepts the Token-2022 program', () => {
    const r = tokenProgramOfOwner(TOKEN_2022_PROGRAM_ID, dummyMint);
    expect(r.equals(TOKEN_2022_PROGRAM_ID)).toBe(true);
  });

  it('rejects a non-token-program owner', () => {
    const bogusOwner = new PublicKey('11111111111111111111111111111111');
    expect(() => tokenProgramOfOwner(bogusOwner, dummyMint)).toThrow(/owned by/);
  });
});

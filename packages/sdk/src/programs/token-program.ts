/**
 * Token-program detection helper.
 *
 * As of mainnet, an SPL mint can be owned by either:
 *   - Classic SPL Token program:  TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA
 *   - Token-2022 (Extensions):    TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb
 *
 * Pool program + Jupiter adapter now use `Interface<TokenInterface>` slots,
 * so callers MUST pass the program that actually owns each mint — passing
 * the wrong ID surfaces as Anchor's `ConstraintTokenInterface` (3018) or as
 * a raw TokenError. `tokenProgramOf` is the one place that does the lookup;
 * callers cache it per-mint where they can to avoid the extra RPC round-trip.
 *
 * Returns `TOKEN_PROGRAM_ID` (classic) when the mint is owned by the legacy
 * SPL Token program, `TOKEN_2022_PROGRAM_ID` when owned by Token-2022.
 * Throws if the account doesn't exist or is owned by neither program — a
 * defensive guard against the SDK ever silently routing through the wrong
 * code path.
 */

import { Connection, PublicKey } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';

const KNOWN_TOKEN_PROGRAMS = new Set([
  TOKEN_PROGRAM_ID.toBase58(),
  TOKEN_2022_PROGRAM_ID.toBase58(),
]);

export async function tokenProgramOf(
  connection: Connection,
  mint: PublicKey,
): Promise<PublicKey> {
  const info = await connection.getAccountInfo(mint, 'confirmed');
  if (!info) {
    throw new Error(`tokenProgramOf: mint ${mint.toBase58()} not found on-chain`);
  }
  const ownerB58 = info.owner.toBase58();
  if (!KNOWN_TOKEN_PROGRAMS.has(ownerB58)) {
    throw new Error(
      `tokenProgramOf: mint ${mint.toBase58()} is owned by ${ownerB58}, ` +
        `not the SPL Token or Token-2022 program`,
    );
  }
  return info.owner;
}

/**
 * Synchronous variant for callers who already hold the mint AccountInfo
 * (e.g. from a batched `getMultipleAccountsInfo` call). Same validation
 * rules as `tokenProgramOf`.
 */
export function tokenProgramOfOwner(owner: PublicKey, mint: PublicKey): PublicKey {
  const ownerB58 = owner.toBase58();
  if (!KNOWN_TOKEN_PROGRAMS.has(ownerB58)) {
    throw new Error(
      `tokenProgramOfOwner: mint ${mint.toBase58()} is owned by ${ownerB58}, ` +
        `not the SPL Token or Token-2022 program`,
    );
  }
  return owner;
}

/** Re-export for caller convenience — single import surface. */
export { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID };

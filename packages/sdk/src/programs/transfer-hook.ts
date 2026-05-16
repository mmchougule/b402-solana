/**
 * Token-2022 transferHook account resolution.
 *
 * The pool program transfers via `spl_token_2022::onchain::invoke_transfer_checked`
 * which auto-detects a mint's transferHook extension and CPIs the hook program
 * for validation. The hook program + its declared extra metas (defined in the
 * mint's ExtraAccountMetaList PDA) must be present in the outer ix's
 * `remaining_accounts` for the helper to find them.
 *
 * This module exposes:
 *   - `appendTransferHookAccounts` — mutates a TransactionInstruction in place,
 *     appending the hook program + resolved extra metas if the mint declares
 *     a hook. No-op for hook-less mints.
 *   - `mintHasTransferHook` — boolean probe so callers can gate UX paths
 *     (e.g. ALT sizing, fee estimation) without forcing the full resolution.
 *
 * Implementation note: we delegate to @solana/spl-token's
 * `addExtraAccountMetasForExecute`, which already handles TLV decoding +
 * pubkey-data / seed resolution for hooks. This file is thin glue: load the
 * mint, branch on the extension, call the helper, surface a clear error if
 * the ExtraAccountMetaList PDA is missing.
 */

import {
  Commitment,
  Connection,
  PublicKey,
  TransactionInstruction,
} from '@solana/web3.js';
import {
  addExtraAccountMetasForExecute,
  getMint,
  getTransferHook,
  getExtraAccountMetaAddress,
  TOKEN_2022_PROGRAM_ID,
} from '@solana/spl-token';

import { tokenProgramOf } from './token-program.js';

export interface AppendTransferHookAccountsCtx {
  connection: Connection;
  /** Instruction whose `keys` will be mutated in place. */
  instruction: TransactionInstruction;
  /** SPL mint being transferred. */
  mint: PublicKey;
  /** Token account funds are leaving. */
  source: PublicKey;
  /** Token account funds are arriving at. */
  destination: PublicKey;
  /** Authority of `source`. For PDA-signed transfers, pass the PDA pubkey. */
  owner: PublicKey;
  /** Transfer amount in base units (smallest token denom). */
  amount: bigint;
  /** RPC commitment for mint + ExtraAccountMetaList account reads. */
  commitment?: Commitment;
}

/**
 * Probe a mint for the transferHook extension. Returns `true` only for
 * Token-2022 mints whose tlvData carries a TransferHook extension with a
 * non-default programId. Cheap enough to call on every transfer if the SDK
 * doesn't already know the mint's program; callers that hold the mint
 * AccountInfo can decode `getTransferHook(mintInfo)` directly.
 */
export async function mintHasTransferHook(
  connection: Connection,
  mint: PublicKey,
  commitment?: Commitment,
): Promise<boolean> {
  const programId = await tokenProgramOf(connection, mint);
  // Classic SPL mints can't carry a TransferHook extension — short-circuit.
  if (!programId.equals(TOKEN_2022_PROGRAM_ID)) return false;
  const mintInfo = await getMint(connection, mint, commitment, programId);
  const hook = getTransferHook(mintInfo);
  // `getTransferHook` returns a struct even when the hook programId is the
  // zero pubkey (extension present but disabled). Treat zero as no-hook.
  return hook != null && !hook.programId.equals(PublicKey.default);
}

/**
 * Append transferHook accounts (program + resolved extra metas) to an
 * instruction's `keys` array. No-op for mints without a hook. Throws when
 * the mint declares a hook but the ExtraAccountMetaList PDA is missing
 * on-chain — that indicates an uninitialised hook and would surface as a
 * confusing runtime CPI failure if left to the pool program.
 *
 * The destination order in `instruction.keys` is: existing keys, then any
 * extra accounts the hook declares, then the hook program ID itself, then
 * the ExtraAccountMetaList PDA. This matches what
 * `addExtraAccountMetasForExecute` produces — it pushes the resolved metas
 * first and the program + PDA last.
 *
 * Preconditions enforced by the underlying helper:
 *   - `instruction.keys` must already contain entries for source, mint,
 *     destination, and owner. Caller is responsible for placing them before
 *     calling this function. The helper throws "Missing required account in
 *     instruction" otherwise.
 */
export async function appendTransferHookAccounts(
  ctx: AppendTransferHookAccountsCtx,
): Promise<void> {
  const { connection, instruction, mint, source, destination, owner, amount, commitment } = ctx;

  // Resolve the mint's owning token program. Classic SPL mints can't have
  // hooks at all — skip the round-trip to the mint account in that case.
  const programId = await tokenProgramOf(connection, mint);
  if (!programId.equals(TOKEN_2022_PROGRAM_ID)) return;

  const mintInfo = await getMint(connection, mint, commitment, programId);
  const hook = getTransferHook(mintInfo);
  if (hook == null || hook.programId.equals(PublicKey.default)) return;

  // Confirm the ExtraAccountMetaList PDA exists before letting the helper
  // silently no-op (the upstream helper returns early when the PDA is null).
  // Producing a clear error here lets callers distinguish "mint has no hook"
  // (legitimate skip) from "mint has hook but author forgot to init the
  // ExtraAccountMetaList" (programmer error in the hook author's deploy).
  const extraMetasPda = getExtraAccountMetaAddress(mint, hook.programId);
  const extraMetasInfo = await connection.getAccountInfo(extraMetasPda, commitment);
  if (extraMetasInfo == null) {
    throw new Error(
      `transfer-hook: mint ${mint.toBase58()} declares hook program ` +
        `${hook.programId.toBase58()} but its ExtraAccountMetaList PDA ` +
        `${extraMetasPda.toBase58()} does not exist. The hook is mis-initialised; ` +
        `transfers will revert until the hook program publishes the metas list.`,
    );
  }

  await addExtraAccountMetasForExecute(
    connection,
    instruction,
    hook.programId,
    source,
    mint,
    destination,
    owner,
    amount,
    commitment,
  );
}

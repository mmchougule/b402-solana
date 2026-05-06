/**
 * private_lend — atomic private deposit into Kamino V2 USDC reserve.
 *
 * Spends a shielded USDC note + deposits into Kamino + mints a kUSDC
 * voucher commitment. Each viewing key gets its own Kamino Obligation
 * (PRD-33 per-user obligation, derived from owner_pda). Mainnet only.
 *
 * One-time setup performed automatically on first call:
 *   - Pre-fund adapter authority (~0.5 SOL) for Kamino UserMetadata +
 *     Obligation rent
 *   - Create owner_pda's USDC ATA (Kamino enforces token::authority ==
 *     obligationOwner on deposit)
 *   - Create / extend the persisted Address Lookup Table to fit all
 *     account refs in the 1232-byte tx cap
 *
 * Subsequent calls reuse all of the above.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { createRpc } from '@lightprotocol/stateless.js';
import {
  poolConfigPda, adapterRegistryPda, treeStatePda,
  tokenConfigPda, vaultPda, derivePendingInputsPda,
} from '@b402ai/solana';
import { leToFrReduced, type SpendableNote } from '@b402ai/solana-shared';

import type { B402Context } from '../context.js';
import type { PrivateLendInput } from '../schemas.js';
import {
  POOL, KAMINO_ADAPTER, RESERVE, USDC,
  parseReserve, deriveAllPerUser, ensureAlt, ensurePerUserSetup,
  ensureAdapterScratchAtas, adapterAuthorityPda,
  buildDepositPayload, buildAdapterIxData, buildDepositRemainingAccounts,
} from '../kamino-helpers.js';

function loadKeypair(): Keypair {
  const p = path.resolve(
    process.env.B402_KEYPAIR_PATH ?? path.join(os.homedir(), '.config/solana/id.json'),
  );
  return Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(p, 'utf8'))));
}

export async function handlePrivateLend(
  ctx: B402Context,
  input: PrivateLendInput,
): Promise<{
  signature: string;
  voucherDepositId: string;
  obligationPda: string;
  ownerPda: string;
  inAmount: string;
  outVaultDelta: string;
  setupTxs: string[];
}> {
  if (ctx.cluster !== 'mainnet') {
    throw new Error(`private_lend is mainnet-only (current cluster: ${ctx.cluster}). Kamino reserves don't exist on devnet/localnet.`);
  }

  const conn = new Connection(ctx.rpcUrl, 'confirmed');
  const admin = loadKeypair();
  const inMint = USDC;
  const lendAmount = BigInt(input.amount);

  // 1. Read + parse the Kamino USDC reserve.
  const reserveAcct = await conn.getAccountInfo(RESERVE);
  if (!reserveAcct) throw new Error(`Kamino USDC reserve ${RESERVE.toBase58()} not on chain`);
  const reserve = parseReserve(reserveAcct.data);
  if (!reserve.liquidityMint.equals(USDC)) {
    throw new Error(`reserve liquidity mint ${reserve.liquidityMint.toBase58()} != USDC`);
  }
  const outMint = reserve.collateralMint; // kUSDC

  // 2. Derive per-user accounts from the SDK's spending pubkey.
  const spendingPub = ctx.b402.wallet.spendingPub;
  const perUser = deriveAllPerUser(spendingPub, reserve);
  const adapterAuthority = adapterAuthorityPda();

  const setupTxs: string[] = [];

  // 3. Adapter scratch ATAs (idempotent — reused across sessions).
  const { adapterInTa, adapterOutTa } = await ensureAdapterScratchAtas({
    conn, admin, adapterAuthority, inMint, outMint,
  });

  // 4. Per-user setup: owner_pda's USDC ATA + adapter-authority pre-fund.
  const setup = await ensurePerUserSetup({
    conn, admin, perUser, reserve, adapterAuthority,
  });
  if (setup.adapterFunded) setupTxs.push('adapter-funded');
  if (setup.ataCreated) setupTxs.push('owner-ata-created');

  // 5. ALT (lazily extended).
  const [pendingInputsPda] = derivePendingInputsPda(POOL, perUser.ownerPda.toBuffer());
  const altPubkey = await ensureAlt({
    conn, admin, reserve, perUser, pendingInputsPda,
    adapterAuthority, adapterInTa, adapterOutTa, outMint,
    poolHelpers: { poolConfigPda, adapterRegistryPda, treeStatePda, tokenConfigPda, vaultPda },
  });

  // 6. Find a spendable USDC note to lend. If `note` was specified, use
  //    that leafIndex; otherwise pick the most recent note matching the
  //    requested amount.
  await ctx.b402.status({ refresh: true });
  const inMintFr = leToFrReduced(inMint.toBytes());
  // _notes is internal (no public note-store accessor on B402Solana yet);
  // cast bypasses the visibility check. SDK 0.0.20 should expose a
  // getSpendableNotes(mintFr) method and we drop this cast.
  const usdcNotes = ((ctx.b402 as unknown as {
    _notes: { getSpendable(mintFr: bigint): SpendableNote[] };
  })._notes).getSpendable(inMintFr);
  if (usdcNotes.length === 0) {
    throw new Error('no spendable USDC notes — call shield first');
  }

  let note: SpendableNote = usdcNotes[0];
  if (input.leafIndex !== undefined) {
    const target = Number(input.leafIndex);
    const found = usdcNotes.find((n: SpendableNote) => Number(n.leafIndex) === target);
    if (!found) {
      throw new Error(`leafIndex ${target} not in spendable notes [${usdcNotes.map((n: SpendableNote) => n.leafIndex).join(',')}]`);
    }
    note = found;
  } else {
    const exact = usdcNotes.find((n: SpendableNote) => n.value === lendAmount);
    if (exact) {
      note = exact;
    } else {
      const sorted = [...usdcNotes].sort((a: SpendableNote, b: SpendableNote) => Number(BigInt(b.leafIndex) - BigInt(a.leafIndex)));
      note = sorted[0];
    }
  }
  const actualLendAmount = note.value;

  // 7. Build the adapter ix + remaining_accounts.
  const actionPayload = buildDepositPayload(RESERVE, actualLendAmount);
  const adapterIxData = buildAdapterIxData(actualLendAmount, 0n, actionPayload);
  const remainingAccounts = buildDepositRemainingAccounts({ reserve, perUser });

  // 8. Pool's kUSDC vault delta (informational — should be 0 for stateful adapter).
  const outVaultPda = vaultPda(POOL, outMint);
  const preInfo = await conn.getAccountInfo(outVaultPda);
  const preKUsdc = preInfo ? BigInt(preInfo.data.readBigUInt64LE(64)) : 0n;

  // 9. Photon RPC for validity proofs.
  const photonUrl = process.env.B402_PHOTON_URL ?? ctx.rpcUrl;
  const photonRpc = createRpc(ctx.rpcUrl, photonUrl);

  // 10. Submit the lend.
  const lendRes = await ctx.b402.privateLend({
    inMint, outMint,
    amount: actualLendAmount,
    note,
    adapterProgramId: KAMINO_ADAPTER,
    adapterInTa, adapterOutTa,
    alt: altPubkey,
    photonRpc,
    expectedOut: actualLendAmount,
    adapterIxData,
    actionPayload,
    remainingAccounts,
    phase9DualNote: true,
    pendingInputsMode: true,
  });

  const postInfo = await conn.getAccountInfo(outVaultPda);
  const postKUsdc = postInfo ? BigInt(postInfo.data.readBigUInt64LE(64)) : 0n;

  return {
    signature: lendRes.signature,
    voucherDepositId: lendRes.outNote.commitment.toString(16).padStart(64, '0').slice(0, 16),
    obligationPda: perUser.obligation.toBase58(),
    ownerPda: perUser.ownerPda.toBase58(),
    inAmount: actualLendAmount.toString(),
    outVaultDelta: (postKUsdc - preKUsdc).toString(),
    setupTxs,
  };
}

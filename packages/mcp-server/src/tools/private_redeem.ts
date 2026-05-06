/**
 * private_redeem — atomic private withdraw from Kamino V2 USDC reserve.
 *
 * Spends a kUSDC voucher commitment (minted by a prior `private_lend`) +
 * withdraws the underlying USDC + reshields it to a fresh USDC note. Uses
 * the per-user obligation derived from the caller's viewing key, so only
 * the original lender can redeem their position. Mainnet only.
 *
 * The kUSDC voucher must already be in the SDK's note store (i.e. the
 * caller previously ran `private_lend` with the same keypair).
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { getOrCreateAssociatedTokenAccount } from '@solana/spl-token';
import { createRpc } from '@lightprotocol/stateless.js';
import {
  poolConfigPda, adapterRegistryPda, treeStatePda,
  tokenConfigPda, vaultPda, derivePendingInputsPda,
} from '@b402ai/solana';
import { leToFrReduced, type SpendableNote } from '@b402ai/solana-shared';

import type { B402Context } from '../context.js';
import type { PrivateRedeemInput } from '../schemas.js';
import {
  POOL, KAMINO_ADAPTER, USDC,
  parseReserve, deriveAllPerUser, ensureAlt, ensurePerUserSetup,
  ensureAdapterScratchAtas, adapterAuthorityPda,
  buildWithdrawPayload, buildAdapterIxData, buildWithdrawRemainingAccounts,
} from '../kamino-helpers.js';
import { pickBestKaminoReserveByMint } from '@b402ai/solana';

function loadKeypair(): Keypair {
  const p = path.resolve(
    process.env.B402_KEYPAIR_PATH ?? path.join(os.homedir(), '.config/solana/id.json'),
  );
  return Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(p, 'utf8'))));
}

export async function handlePrivateRedeem(
  ctx: B402Context,
  input: PrivateRedeemInput,
): Promise<{
  signature: string;
  redeemedDepositId: string;
  obligationPda: string;
  usdcVaultDelta: string;
  redeemedAmount: string;
}> {
  if (ctx.cluster !== 'mainnet') {
    throw new Error(`private_redeem is mainnet-only (current cluster: ${ctx.cluster}).`);
  }

  await ctx.b402.ready();

  const conn = new Connection(ctx.rpcUrl, 'confirmed');
  const admin = loadKeypair();
  const inMint = input.mint ? new PublicKey(input.mint) : USDC;

  // 1. Discover the (market, reserve) tuple — must match what was used at lend.
  const marketFilter = input.market ? { market: new PublicKey(input.market) } : {};
  const picked = await pickBestKaminoReserveByMint(conn, inMint, marketFilter);
  if (!picked) {
    throw new Error(`no Kamino reserve found for mint ${inMint.toBase58()}${input.market ? ` in market ${input.market}` : ''}`);
  }
  const reserveAddr = picked.best.address;
  const market = picked.best.market;
  const reserve = parseReserve(picked.best.data, market);
  const outMint = reserve.collateralMint; // collateral mint (input for redeem — voucher being burned)

  // 2. Per-user accounts.
  const spendingPub = ctx.b402.wallet.spendingPub;
  const perUser = deriveAllPerUser(spendingPub, reserve, market);
  const adapterAuthority = adapterAuthorityPda();

  // 3. Reverse adapter scratch ATAs: adapter_in_ta = kUSDC, adapter_out_ta = USDC.
  const { adapterInTa: wAdapterInTa, adapterOutTa: wAdapterOutTa } =
    await ensureAdapterScratchAtas({
      conn, admin, adapterAuthority,
      inMint: outMint /* kUSDC into adapter */,
      outMint: inMint /* USDC out */,
    });

  // 4. Per-user setup (idempotent).
  await ensurePerUserSetup({ conn, admin, perUser, reserve, adapterAuthority });

  // 5. Pool's adapt_execute requires fee_ata_sentinel — the relayer's ATA
  //    for the IN mint. For redeem, IN mint = kUSDC. The relayer is either
  //    (a) the hosted HTTP relayer pubkey (default mainnet path), or
  //    (b) the local SDK relayer keypair (e.g. e2e fork tests). Either
  //    way, ensure the ATA exists; user (admin) pays the ~0.002 SOL rent
  //    once. Anyone can be the payer of an ATA owned by anyone else.
  const sdkInternal = ctx.b402 as unknown as {
    _relayerHttp?: { client: { pubkey: PublicKey } };
    relayer?: { publicKey: PublicKey };
  };
  const relayerPubkey = sdkInternal._relayerHttp?.client.pubkey
    ?? sdkInternal.relayer?.publicKey
    ?? admin.publicKey;
  await getOrCreateAssociatedTokenAccount(
    conn, admin, outMint /* kUSDC */, relayerPubkey, true,
  );

  // 6. ALT (extends with per-user PDAs lazily, persisted per (market, mint)).
  const [pendingInputsPda] = derivePendingInputsPda(POOL, perUser.ownerPda.toBuffer());
  const altPubkey = await ensureAlt({
    conn, admin, market, reserveAddr, reserve, perUser, pendingInputsPda,
    adapterAuthority,
    adapterInTa: wAdapterInTa, adapterOutTa: wAdapterOutTa,
    outMint: inMint, // for ALT purposes, want USDC + kUSDC token configs both included
    poolHelpers: { poolConfigPda, adapterRegistryPda, treeStatePda, tokenConfigPda, vaultPda },
  });

  // 7. Find the kUSDC voucher note to burn.
  await ctx.b402.status({ refresh: true });
  const kUsdcMintFr = leToFrReduced(outMint.toBytes());
  const kUsdcNotes = ((ctx.b402 as unknown as {
    _notes: { getSpendable(mintFr: bigint): SpendableNote[] };
  })._notes).getSpendable(kUsdcMintFr);
  if (kUsdcNotes.length === 0) {
    throw new Error('no spendable kUSDC voucher notes — run private_lend first, or wait for the lend tx to finalize');
  }

  let redeemNote: SpendableNote = kUsdcNotes[0];
  if (input.leafIndex !== undefined) {
    const target = Number(input.leafIndex);
    const found = kUsdcNotes.find((n: SpendableNote) => Number(n.leafIndex) === target);
    if (!found) {
      throw new Error(`leafIndex ${target} not in spendable kUSDC notes [${kUsdcNotes.map((n: SpendableNote) => n.leafIndex).join(',')}]`);
    }
    redeemNote = found;
  } else {
    const sorted = [...kUsdcNotes].sort((a: SpendableNote, b: SpendableNote) => Number(BigInt(b.leafIndex) - BigInt(a.leafIndex)));
    redeemNote = sorted[0];
  }
  const ktIn = redeemNote.value;

  // 8. Build adapter ix + ra_withdraw_per_user.
  const actionPayload = buildWithdrawPayload(reserveAddr, ktIn);
  const adapterIxData = buildAdapterIxData(ktIn, 0n, actionPayload);
  const remainingAccounts = buildWithdrawRemainingAccounts({ market, reserveAddr, reserve, perUser });

  // 9. Pool's USDC vault delta — actual USDC redeemed.
  const usdcVaultPda = vaultPda(POOL, inMint);
  const preUsdcInfo = await conn.getAccountInfo(usdcVaultPda);
  const preUsdc = preUsdcInfo ? BigInt(preUsdcInfo.data.readBigUInt64LE(64)) : 0n;

  // 10. Photon RPC.
  const photonUrl = process.env.B402_PHOTON_URL ?? ctx.rpcUrl;
  const photonRpc = createRpc(ctx.rpcUrl, photonUrl);

  // 11. Submit the redeem (Path B: pool skips input transfer for synthetic mint).
  const redeemRes = await ctx.b402.privateRedeem({
    inMint: outMint,  // kUSDC voucher being burned
    outMint: inMint,  // USDC being reshielded
    amount: ktIn,
    note: redeemNote,
    adapterProgramId: KAMINO_ADAPTER,
    adapterInTa: wAdapterInTa,
    adapterOutTa: wAdapterOutTa,
    alt: altPubkey,
    photonRpc,
    expectedOut: 0n,
    adapterIxData,
    actionPayload,
    remainingAccounts,
    phase9DualNote: true,
    pendingInputsMode: true,
  });

  const postUsdcInfo = await conn.getAccountInfo(usdcVaultPda);
  const postUsdc = postUsdcInfo ? BigInt(postUsdcInfo.data.readBigUInt64LE(64)) : 0n;
  const usdcDelta = postUsdc - preUsdc;

  if (usdcDelta <= 0n) {
    throw new Error(`Kamino withdraw did not credit pool vault — delta=${usdcDelta}`);
  }

  return {
    signature: redeemRes.signature,
    redeemedDepositId: redeemRes.outNote.commitment.toString(16).padStart(64, '0').slice(0, 16),
    obligationPda: perUser.obligation.toBase58(),
    usdcVaultDelta: usdcDelta.toString(),
    redeemedAmount: usdcDelta.toString(),
  };
}

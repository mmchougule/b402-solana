/**
 * private_lend — atomic private deposit into a Kamino V2 reserve.
 *
 * Caller picks a mint (default USDC). The reserve is discovered on-chain:
 * if multiple Kamino markets list that mint, the deepest by available
 * supply wins, and alternates are returned in the response so the agent
 * can switch markets next time. Pass `market` to pin a specific one.
 *
 * Each viewing key gets its own Kamino Obligation per (mint, market)
 * tuple. Mainnet only.
 *
 * Auto-setup (cached per (mint, market) tuple):
 *   - Pre-fund adapter authority for Kamino UserMetadata + Obligation rent
 *   - Create owner_pda's <mint> ATA (Kamino requires token::authority == obligationOwner)
 *   - Create / extend the persisted Address Lookup Table for the (market, reserve) tuple
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { createRpc } from '@lightprotocol/stateless.js';
import {
  poolConfigPda, adapterRegistryPda, treeStatePda,
  tokenConfigPda, vaultPda, derivePendingInputsPda,
  pickBestKaminoReserveByMint, findAllKaminoReservesByMint,
} from '@b402ai/solana';
import { leToFrReduced, type SpendableNote } from '@b402ai/solana-shared';

import type { B402Context } from '../context.js';
import type { PrivateLendInput } from '../schemas.js';
import {
  POOL, KAMINO_ADAPTER, USDC,
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
  market: string;
  marketAlternates?: { market: string; reserve: string; availableAmount: string }[];
  reserve: string;
  symbol: string;
  obligationPda: string;
  ownerPda: string;
  inMint: string;
  inAmount: string;
  outVaultDelta: string;
  setupTxs: string[];
}> {
  if (ctx.cluster !== 'mainnet') {
    throw new Error(`private_lend is mainnet-only (current cluster: ${ctx.cluster}). Kamino reserves don't exist on devnet/localnet.`);
  }

  await ctx.b402.ready();

  const conn = new Connection(ctx.rpcUrl, 'confirmed');
  const admin = loadKeypair();
  const inMint = input.mint ? new PublicKey(input.mint) : USDC;
  const lendAmount = BigInt(input.amount);

  // 1. Discover the Kamino reserve for this mint. If `market` is pinned,
  //    only consider that market; otherwise scan all markets and pick
  //    the deepest by available_amount.
  const marketFilter = input.market ? { market: new PublicKey(input.market) } : {};
  const picked = await pickBestKaminoReserveByMint(conn, inMint, marketFilter);
  if (!picked) {
    throw new Error(`no Kamino reserve found for mint ${inMint.toBase58()}${input.market ? ` in market ${input.market}` : ''}`);
  }
  const reserveAddr = picked.best.address;
  const market = picked.best.market;
  const reserve = parseReserve(picked.best.data, market);
  const outMint = reserve.collateralMint; // collateral mint (e.g. kUSDC, kSOL)

  // 2. Derive per-user accounts.
  const spendingPub = ctx.b402.wallet.spendingPub;
  const perUser = deriveAllPerUser(spendingPub, reserve, market);
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


  // 5. ALT (lazily extended, persisted per (market, mint) tuple).
  const [pendingInputsPda] = derivePendingInputsPda(POOL, perUser.ownerPda.toBuffer());
  const altPubkey = await ensureAlt({
    conn, admin, market, reserveAddr, reserve, perUser, pendingInputsPda,
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
  const actionPayload = buildDepositPayload(reserveAddr, actualLendAmount);
  const adapterIxData = buildAdapterIxData(actualLendAmount, 0n, actionPayload);
  const remainingAccounts = buildDepositRemainingAccounts({ market, reserveAddr, reserve, perUser });

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

  // Surface the runner-up markets so the caller can switch next time
  // without re-discovering. Top 5 only — full list is available via
  // list_kamino_reserves.
  const marketAlternates = picked.alternates.slice(0, 5).map((a) => ({
    market: a.market.toBase58(),
    reserve: a.address.toBase58(),
    availableAmount: a.availableAmount.toString(),
  }));

  return {
    signature: lendRes.signature,
    voucherDepositId: lendRes.outNote.commitment.toString(16).padStart(64, '0').slice(0, 16),
    market: market.toBase58(),
    ...(marketAlternates.length > 0 ? { marketAlternates } : {}),
    reserve: reserveAddr.toBase58(),
    symbol: picked.best.symbol,
    obligationPda: perUser.obligation.toBase58(),
    ownerPda: perUser.ownerPda.toBase58(),
    inMint: inMint.toBase58(),
    inAmount: actualLendAmount.toString(),
    outVaultDelta: (postKUsdc - preKUsdc).toString(),
    setupTxs,
  };
}

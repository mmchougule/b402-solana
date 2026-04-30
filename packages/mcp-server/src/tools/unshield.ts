import {
  AddressLookupTableProgram, Connection, PublicKey, SystemProgram,
  Transaction, TransactionInstruction, sendAndConfirmTransaction,
} from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { createRpc } from '@lightprotocol/stateless.js';
import type { B402Context } from '../context.js';
import type { UnshieldInput } from '../schemas.js';

const POOL_ID_MAINNET = new PublicKey('42a3hsCXtQLWonyxWZosaaCJCweYYKMrvNd25p1Jrt2y');
const NULLIFIER_ID = new PublicKey('2AnRZwWu6CTurZs1yQpqrcJWo4yRYL1xpeV78b2siweq');
const VERIFIER_T_ID = new PublicKey('Afjbnv2Ekxa98jjRw33xPPhZabevek2uZxoE75kr6ZrK');
const VERIFIER_A_ID = new PublicKey('3Y2tyhNSaUiW5AcZcmFGRyTMdnroxHxc5GqFQPcMTZae');
const SYSVAR_INSTRUCTIONS = new PublicKey('Sysvar1nstructions1111111111111111111111111');
const COMPUTE_BUDGET = new PublicKey('ComputeBudget111111111111111111111111111111');

/** Build a per-call ALT for v2.1 unshield. Includes pool, nullifier,
 *  Light infra, and per-mint accounts. Caller pays ~0.005 SOL for ALT
 *  rent (recoverable later via close). */
async function buildUnshieldAlt(
  conn: Connection,
  ctx: B402Context,
  mint: PublicKey,
  recipientAta: PublicKey,
): Promise<PublicKey> {
  const slot = (await conn.getSlot('finalized')) - 1;
  const payer = (ctx.b402 as any).relayer ?? (ctx.b402 as any).keypair;
  const [createIx, alt] = AddressLookupTableProgram.createLookupTable({
    authority: payer.publicKey, payer: payer.publicKey, recentSlot: slot,
  });
  await sendAndConfirmTransaction(conn, new Transaction().add(createIx), [payer], { commitment: 'confirmed' });

  const VPREFIX = Buffer.from('b402/v1');
  const POOL = ctx.cluster === 'mainnet' ? POOL_ID_MAINNET : POOL_ID_MAINNET; // same on devnet
  const seedPda = (...seeds: Buffer[]) => PublicKey.findProgramAddressSync(seeds, POOL)[0];
  const NULLIFIER_CPI = PublicKey.findProgramAddressSync([Buffer.from('cpi_authority')], NULLIFIER_ID)[0];

  const addresses: PublicKey[] = [
    new PublicKey('SySTEM1eSU2p4BGQfQpimFEWWSC1XDFeun3Nqzz3rT7'),
    new PublicKey('compr6CUsB5m2jS4Y3831ztGSTnDpnKJTKS95d64XVq'),
    new PublicKey('35hkDgaAKwMCaxRz2ocSZ6NaUrtKkyNqU6c4RV3tYJRh'),
    new PublicKey('HwXnGK3tPkkVY6P439H2p68AxpeuWXd5PcrAxFpbmfbA'),
    new PublicKey('amt2kaJA14v3urZbZvnc5v2np8jqvc4Z8zDep5wbtzx'),
    new PublicKey('oq5oh5ZR3yGomuQgFduNDzjtGvVWfDRGLuDVjv9a96P'),
    NULLIFIER_ID, NULLIFIER_CPI,
    POOL,
    seedPda(VPREFIX, Buffer.from('config')),
    seedPda(VPREFIX, Buffer.from('tree')),
    seedPda(VPREFIX, Buffer.from('treasury')),
    seedPda(VPREFIX, Buffer.from('token'), mint.toBuffer()),
    seedPda(VPREFIX, Buffer.from('vault'), mint.toBuffer()),
    VERIFIER_T_ID,
    SYSVAR_INSTRUCTIONS, COMPUTE_BUDGET,
    TOKEN_PROGRAM_ID, SystemProgram.programId,
    recipientAta,
  ];
  const ext = AddressLookupTableProgram.extendLookupTable({
    payer: payer.publicKey, authority: payer.publicKey, lookupTable: alt, addresses,
  });
  await sendAndConfirmTransaction(conn, new Transaction().add(ext), [payer], { commitment: 'confirmed' });
  // ALT must be > 1 slot old before use.
  await new Promise((r) => setTimeout(r, 3000));
  return alt;
}

export async function handleUnshield(
  ctx: B402Context,
  input: UnshieldInput,
): Promise<{
  signature: string;
  cluster: string;
}> {
  const mint = new PublicKey(input.mint);
  const to = new PublicKey(input.to);

  // v2.1 unshield needs a Photon-RPC client to fetch the non-inclusion
  // proof for the nullifier address (PRD-30 §3.6). Helius mainnet/devnet
  // serves Photon at the same endpoint as their Solana JSON-RPC.
  const photonUrl = process.env.B402_PHOTON_RPC_URL ?? ctx.rpcUrl;
  const photonRpc = createRpc(ctx.rpcUrl, photonUrl);

  // ALT: prefer pre-published constant; otherwise build per-call.
  const altOverride = process.env.B402_ALT;
  let alt: PublicKey;
  if (altOverride) {
    alt = new PublicKey(altOverride);
  } else if (ctx.b402AltMainnet) {
    alt = ctx.b402AltMainnet;
  } else {
    const conn = (ctx.b402 as any).connection as Connection;
    const recipientAta = getAssociatedTokenAddressSync(mint, to);
    alt = await buildUnshieldAlt(conn, ctx, mint, recipientAta);
  }

  const result = await ctx.b402.unshield({ to, mint, photonRpc, alt });
  return { signature: result.signature, cluster: ctx.cluster };
}

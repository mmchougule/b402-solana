/**
 * Tiny Jupiter v6 client for the public-baseline DCA. Uses the
 * `/v6/quote` + `/v6/swap` endpoints with a user-signed v0 tx.
 * No SDK dependency — keeps the baseline lean and obviously
 * "no shielded pool involved here."
 */
import {
  Connection,
  Keypair,
  VersionedTransaction,
} from '@solana/web3.js';

const JUP_BASE = 'https://quote-api.jup.ag/v6';

export interface JupSwapResult {
  signature: string;
  outAmount: string;
}

export async function publicSwap(args: {
  conn: Connection;
  user: Keypair;
  inMint: string;
  outMint: string;
  amountUnits: bigint;
  slippageBps?: number;
}): Promise<JupSwapResult> {
  const slippageBps = args.slippageBps ?? 50;
  const quoteUrl = `${JUP_BASE}/quote?inputMint=${args.inMint}&outputMint=${args.outMint}&amount=${args.amountUnits}&slippageBps=${slippageBps}&onlyDirectRoutes=false`;
  const quoteResp = await fetch(quoteUrl);
  if (!quoteResp.ok) {
    throw new Error(`jupiter /quote ${quoteResp.status}: ${await quoteResp.text()}`);
  }
  const quote = (await quoteResp.json()) as { outAmount: string };

  const swapResp = await fetch(`${JUP_BASE}/swap`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey: args.user.publicKey.toBase58(),
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: 'auto',
    }),
  });
  if (!swapResp.ok) {
    throw new Error(`jupiter /swap ${swapResp.status}: ${await swapResp.text()}`);
  }
  const swap = (await swapResp.json()) as { swapTransaction: string };

  const txBytes = Buffer.from(swap.swapTransaction, 'base64');
  const tx = VersionedTransaction.deserialize(txBytes);
  tx.sign([args.user]);

  const signature = await args.conn.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    maxRetries: 3,
  });
  const latest = await args.conn.getLatestBlockhash('confirmed');
  await args.conn.confirmTransaction(
    {
      signature,
      blockhash: latest.blockhash,
      lastValidBlockHeight: latest.lastValidBlockHeight,
    },
    'confirmed',
  );
  return { signature, outAmount: quote.outAmount };
}

import type { Observation } from './types.js';

/**
 * Parse a Solana confirmed-tx (the shape returned by
 * `connection.getParsedTransaction`) and return every USDC SPL transfer
 * whose destination is the ingress ATA.
 *
 * Caller responsibility:
 *   - `ingressAta` is the ingress wallet's associated token account for
 *     the configured mint. We compare `parsed.info.destination` against
 *     this ATA. Mint filtering is implicit (an ATA is mint-specific).
 *
 * Behavior:
 *   - Walks both top-level instructions and CPI inner instructions.
 *   - Recognises `spl-token` `transfer` and `transferChecked`.
 *   - Skips failed transactions (`meta.err !== null`).
 *   - Skips zero-amount transfers (the reconciler also drops these,
 *     but filtering here keeps the queue clean).
 *
 * Stub returns empty until tests pin the contract.
 */
export interface ParsedTxLike {
  slot: number;
  meta?: { err?: unknown; innerInstructions?: Array<{ instructions: ParsedInstruction[] }> | null } | null;
  transaction: {
    signatures: string[];
    message: { instructions: ParsedInstruction[] };
  };
}

export interface ParsedInstruction {
  program?: string;
  programId?: string | { toBase58(): string };
  parsed?: {
    type?: string;
    info?: {
      source?: string;
      destination?: string;
      authority?: string;
      multisigAuthority?: string;
      mint?: string;
      amount?: string | number;
      tokenAmount?: { amount?: string };
    };
  };
}

export function parseUsdcTransfersToIngress(
  tx: ParsedTxLike,
  ingressAta: string,
): Observation[] {
  if (tx.meta?.err) return [];
  const txSig = tx.transaction.signatures[0];
  if (!txSig) return [];
  const slot = tx.slot;

  const out: Observation[] = [];
  const visit = (ix: ParsedInstruction) => {
    if (ix.program !== 'spl-token') return;
    const t = ix.parsed?.type;
    if (t !== 'transfer' && t !== 'transferChecked') return;
    const info = ix.parsed?.info;
    if (!info) return;
    if (info.destination !== ingressAta) return;

    const amount =
      typeof info.amount === 'string'
        ? info.amount
        : typeof info.amount === 'number'
        ? info.amount.toString()
        : info.tokenAmount?.amount;
    if (!amount || amount === '0') return;

    const payer = info.authority ?? info.multisigAuthority;
    if (!payer) return;

    out.push({ txSig, payerPubkey: payer, amount, slot });
  };

  for (const ix of tx.transaction.message.instructions) visit(ix);
  for (const inner of tx.meta?.innerInstructions ?? []) {
    for (const ix of inner.instructions) visit(ix);
  }
  return out;
}

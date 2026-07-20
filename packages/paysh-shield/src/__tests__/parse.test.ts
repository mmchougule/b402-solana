import { describe, it, expect } from 'vitest';
import { parseUsdcTransfersToIngress, type ParsedTxLike } from '../parse.js';

const INGRESS_ATA = 'IngressAta1111111111111111111111111111111';
const OTHER_ATA = 'OtherAta1111111111111111111111111111111111';
const PAYER = 'Payer11111111111111111111111111111111111111';

const baseTx = (overrides: Partial<ParsedTxLike> = {}): ParsedTxLike => ({
  slot: 1234,
  meta: { err: null, innerInstructions: [] },
  transaction: {
    signatures: ['sig1'],
    message: { instructions: [] },
  },
  ...overrides,
});

const splTransfer = (info: Record<string, unknown>) => ({
  program: 'spl-token',
  programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  parsed: { type: 'transfer', info },
});

const splTransferChecked = (info: Record<string, unknown>) => ({
  program: 'spl-token',
  programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  parsed: { type: 'transferChecked', info },
});

describe('parseUsdcTransfersToIngress', () => {
  it('extracts a single transfer to ingress', () => {
    const tx = baseTx({
      transaction: {
        signatures: ['sigA'],
        message: {
          instructions: [
            splTransfer({
              source: 'Source1',
              destination: INGRESS_ATA,
              authority: PAYER,
              amount: '1000000',
            }),
          ],
        },
      },
    });
    expect(parseUsdcTransfersToIngress(tx, INGRESS_ATA)).toEqual([
      { txSig: 'sigA', payerPubkey: PAYER, amount: '1000000', slot: 1234 },
    ]);
  });

  it('extracts a transferChecked to ingress (uses tokenAmount.amount)', () => {
    const tx = baseTx({
      transaction: {
        signatures: ['sigB'],
        message: {
          instructions: [
            splTransferChecked({
              source: 'Source1',
              destination: INGRESS_ATA,
              authority: PAYER,
              mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
              tokenAmount: { amount: '500000' },
            }),
          ],
        },
      },
    });
    expect(parseUsdcTransfersToIngress(tx, INGRESS_ATA)).toEqual([
      { txSig: 'sigB', payerPubkey: PAYER, amount: '500000', slot: 1234 },
    ]);
  });

  it('ignores transfers to a different destination', () => {
    const tx = baseTx({
      transaction: {
        signatures: ['sigC'],
        message: {
          instructions: [
            splTransfer({
              source: 'Source1',
              destination: OTHER_ATA,
              authority: PAYER,
              amount: '1000000',
            }),
          ],
        },
      },
    });
    expect(parseUsdcTransfersToIngress(tx, INGRESS_ATA)).toEqual([]);
  });

  it('ignores non-spl-token program instructions', () => {
    const tx = baseTx({
      transaction: {
        signatures: ['sigD'],
        message: {
          instructions: [
            {
              program: 'system',
              programId: '11111111111111111111111111111111',
              parsed: {
                type: 'transfer',
                info: { destination: INGRESS_ATA, lamports: 1000 } as never,
              },
            },
          ],
        },
      },
    });
    expect(parseUsdcTransfersToIngress(tx, INGRESS_ATA)).toEqual([]);
  });

  it('ignores zero-amount transfers', () => {
    const tx = baseTx({
      transaction: {
        signatures: ['sigE'],
        message: {
          instructions: [
            splTransfer({
              source: 'Source1',
              destination: INGRESS_ATA,
              authority: PAYER,
              amount: '0',
            }),
          ],
        },
      },
    });
    expect(parseUsdcTransfersToIngress(tx, INGRESS_ATA)).toEqual([]);
  });

  it('ignores failed transactions', () => {
    const tx = baseTx({
      meta: { err: { InstructionError: [0, 'Custom'] }, innerInstructions: [] },
      transaction: {
        signatures: ['sigF'],
        message: {
          instructions: [
            splTransfer({
              source: 'Source1',
              destination: INGRESS_ATA,
              authority: PAYER,
              amount: '1000000',
            }),
          ],
        },
      },
    });
    expect(parseUsdcTransfersToIngress(tx, INGRESS_ATA)).toEqual([]);
  });

  it('finds transfers in inner (CPI) instructions', () => {
    const tx = baseTx({
      meta: {
        err: null,
        innerInstructions: [
          {
            instructions: [
              splTransfer({
                source: 'Source1',
                destination: INGRESS_ATA,
                authority: PAYER,
                amount: '7777',
              }),
            ],
          },
        ],
      },
      transaction: {
        signatures: ['sigG'],
        message: { instructions: [] },
      },
    });
    expect(parseUsdcTransfersToIngress(tx, INGRESS_ATA)).toEqual([
      { txSig: 'sigG', payerPubkey: PAYER, amount: '7777', slot: 1234 },
    ]);
  });

  it('returns multiple observations when a tx has multiple matching transfers', () => {
    const tx = baseTx({
      transaction: {
        signatures: ['sigH'],
        message: {
          instructions: [
            splTransfer({
              source: 'A',
              destination: INGRESS_ATA,
              authority: PAYER,
              amount: '100',
            }),
            splTransfer({
              source: 'B',
              destination: INGRESS_ATA,
              authority: PAYER,
              amount: '200',
            }),
            splTransfer({
              source: 'C',
              destination: OTHER_ATA,
              authority: PAYER,
              amount: '300',
            }),
          ],
        },
      },
    });
    const got = parseUsdcTransfersToIngress(tx, INGRESS_ATA);
    expect(got).toHaveLength(2);
    expect(got.map((o) => o.amount)).toEqual(['100', '200']);
  });

  it('falls back to multisigAuthority when authority is absent', () => {
    const tx = baseTx({
      transaction: {
        signatures: ['sigI'],
        message: {
          instructions: [
            splTransfer({
              source: 'Source1',
              destination: INGRESS_ATA,
              multisigAuthority: PAYER,
              amount: '1000',
            }),
          ],
        },
      },
    });
    expect(parseUsdcTransfersToIngress(tx, INGRESS_ATA)).toEqual([
      { txSig: 'sigI', payerPubkey: PAYER, amount: '1000', slot: 1234 },
    ]);
  });

  it('skips entries with no recoverable payer', () => {
    const tx = baseTx({
      transaction: {
        signatures: ['sigJ'],
        message: {
          instructions: [
            splTransfer({
              source: 'Source1',
              destination: INGRESS_ATA,
              amount: '1000',
            }),
          ],
        },
      },
    });
    expect(parseUsdcTransfersToIngress(tx, INGRESS_ATA)).toEqual([]);
  });
});

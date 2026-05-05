import { describe, it, expect, vi } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { PayshBridge, type BridgeConnection } from '../bridge.js';
import type { BridgeEvent, ShieldFn } from '../types.js';
import type { ParsedTxLike } from '../parse.js';

const INGRESS_OWNER = new PublicKey('11111111111111111111111111111112');
const INGRESS_ATA = new PublicKey('11111111111111111111111111111113');
const PAYER = 'Payer1111111111111111111111111111111111111';

function makeFakeConnection(opts?: {
  txByCallback?: (sig: string) => ParsedTxLike | null;
}): BridgeConnection & {
  triggerLog: (sig: string, opts?: { err?: unknown; slot?: number }) => void;
  removed: number[];
} {
  let listener: ((logs: { signature: string; err: unknown }, ctx: { slot: number }) => void) | null = null;
  const removed: number[] = [];
  return {
    onLogs(_target, cb) {
      listener = cb;
      return 42;
    },
    removeOnLogsListener(id) {
      removed.push(id);
    },
    async getParsedTransaction(signature) {
      return opts?.txByCallback ? opts.txByCallback(signature) : null;
    },
    triggerLog(sig, o) {
      listener?.({ signature: sig, err: o?.err ?? null }, { slot: o?.slot ?? 1 });
    },
    removed,
  };
}

const splTransferTx = (sig: string, dest: string, amount: string): ParsedTxLike => ({
  slot: 1,
  meta: { err: null, innerInstructions: [] },
  transaction: {
    signatures: [sig],
    message: {
      instructions: [
        {
          program: 'spl-token',
          programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
          parsed: {
            type: 'transfer',
            info: { source: 'Src', destination: dest, authority: PAYER, amount },
          },
        },
      ],
    },
  },
});

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
}

describe('PayshBridge', () => {
  it('payTo returns the ingress owner pubkey base58', () => {
    const b = new PayshBridge({
      connection: makeFakeConnection(),
      ingressOwner: INGRESS_OWNER,
      ingressAta: INGRESS_ATA,
      shield: vi.fn<ShieldFn>(),
      tickIntervalMs: 0,
    });
    expect(b.payTo()).toBe(INGRESS_OWNER.toBase58());
  });

  it('start subscribes; incoming SPL transfer to ingress triggers shield', async () => {
    const conn = makeFakeConnection({
      txByCallback: (sig) => splTransferTx(sig, INGRESS_ATA.toBase58(), '100000'),
    });
    const shield = vi.fn<ShieldFn>(async () => ({ signature: 's-shield', commitment: '0xc' }));
    const events: BridgeEvent[] = [];
    const b = new PayshBridge({
      connection: conn,
      ingressOwner: INGRESS_OWNER,
      ingressAta: INGRESS_ATA,
      shield,
      tickIntervalMs: 0,
    });
    b.on((e) => events.push(e));
    await b.start();

    conn.triggerLog('sig-A');
    await flush();

    expect(shield).toHaveBeenCalledTimes(1);
    expect(shield.mock.calls[0]?.[0]).toMatchObject({ amount: '100000', payerPubkey: PAYER });
    expect(events.find((e) => e.name === 'shielded')).toMatchObject({
      txSig: 'sig-A',
      commitment: '0xc',
    });
  });

  it('ignores logs with err set (tx failed on chain)', async () => {
    const conn = makeFakeConnection({
      txByCallback: () => splTransferTx('x', INGRESS_ATA.toBase58(), '1'),
    });
    const shield = vi.fn<ShieldFn>(async () => ({ signature: 's', commitment: '0xc' }));
    const b = new PayshBridge({
      connection: conn,
      ingressOwner: INGRESS_OWNER,
      ingressAta: INGRESS_ATA,
      shield,
      tickIntervalMs: 0,
    });
    await b.start();

    conn.triggerLog('sig-fail', { err: { InstructionError: [0, 'Custom'] } });
    await flush();

    expect(shield).not.toHaveBeenCalled();
  });

  it('ignores transfers whose destination is not the ingress ATA', async () => {
    const conn = makeFakeConnection({
      txByCallback: (sig) =>
        splTransferTx(sig, '99999999999999999999999999999999999999999999', '1'),
    });
    const shield = vi.fn<ShieldFn>();
    const b = new PayshBridge({
      connection: conn,
      ingressOwner: INGRESS_OWNER,
      ingressAta: INGRESS_ATA,
      shield,
      tickIntervalMs: 0,
    });
    await b.start();
    conn.triggerLog('sig-x');
    await flush();
    expect(shield).not.toHaveBeenCalled();
  });

  it('stop removes the subscription', async () => {
    const conn = makeFakeConnection();
    const b = new PayshBridge({
      connection: conn,
      ingressOwner: INGRESS_OWNER,
      ingressAta: INGRESS_ATA,
      shield: vi.fn<ShieldFn>(),
      tickIntervalMs: 0,
    });
    await b.start();
    await b.stop();
    expect(conn.removed).toEqual([42]);
  });

  it('handleSignature is idempotent — same sig twice → one shield', async () => {
    const conn = makeFakeConnection({
      txByCallback: (sig) => splTransferTx(sig, INGRESS_ATA.toBase58(), '42'),
    });
    const shield = vi.fn<ShieldFn>(async () => ({ signature: 's', commitment: '0xc' }));
    const b = new PayshBridge({
      connection: conn,
      ingressOwner: INGRESS_OWNER,
      ingressAta: INGRESS_ATA,
      shield,
      tickIntervalMs: 0,
    });
    await b.start();

    conn.triggerLog('dup-sig');
    conn.triggerLog('dup-sig');
    await flush();

    expect(shield).toHaveBeenCalledTimes(1);
  });

  it('submit() lets callers replay observations directly (e.g. backfill)', async () => {
    const shield = vi.fn<ShieldFn>(async () => ({ signature: 's', commitment: '0xc' }));
    const b = new PayshBridge({
      connection: makeFakeConnection(),
      ingressOwner: INGRESS_OWNER,
      ingressAta: INGRESS_ATA,
      shield,
      tickIntervalMs: 0,
    });
    await b.submit({ txSig: 'manual', payerPubkey: PAYER, amount: '1', slot: 0 });
    await flush();
    expect(shield).toHaveBeenCalledTimes(1);
  });
});

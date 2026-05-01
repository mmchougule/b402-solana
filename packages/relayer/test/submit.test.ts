/**
 * Submit unit tests with a stubbed Connection. We exercise tx assembly,
 * signature attachment, fee-payer override, and Jito vs RPC path selection
 * — without requiring a live validator.
 */

import { describe, it, expect, vi } from 'vitest';
import { Keypair, PublicKey, VersionedTransaction } from '@solana/web3.js';
import type { Connection } from '@solana/web3.js';
import { RpcSubmitter } from '../src/submit.js';
import { RelayerError } from '../src/errors.js';

function fakeConnection(overrides: Partial<{
  blockhash: string;
  slot: number;
  sendRawTransaction: (wire: Uint8Array) => Promise<string>;
  confirmErr: unknown;
  altMissing: boolean;
}> = {}): Connection {
  // Real-shape blockhash (base58 32B). The literal must use base58 alphabet
  // (no 0/O/I/l) — web3.js bs58-decodes it during MessageV0.serialize.
  const blockhash = overrides.blockhash ?? Keypair.generate().publicKey.toBase58();
  const slot = overrides.slot ?? 100;
  const send = overrides.sendRawTransaction ?? (async (_wire: Uint8Array) => 'sig-from-rpc');
  const confirmErr = overrides.confirmErr ?? null;

  return {
    getLatestBlockhash: vi.fn(async () => ({ blockhash, lastValidBlockHeight: 200 })),
    getAddressLookupTable: vi.fn(async (_addr: PublicKey) => {
      if (overrides.altMissing) return { value: null, context: { slot } };
      // Return a minimal valid AddressLookupTableAccount stub.
      return {
        value: {
          key: new PublicKey('11111111111111111111111111111111'),
          state: { addresses: [], deactivationSlot: BigInt('0xffffffffffffffff') },
          isActive: () => true,
        },
        context: { slot },
      };
    }),
    sendRawTransaction: vi.fn(send),
    confirmTransaction: vi.fn(async (_sig: string) => ({
      value: { err: confirmErr },
      context: { slot },
    })),
    getSlot: vi.fn(async () => slot),
    getBalance: vi.fn(async () => 1_000_000_000),
  } as unknown as Connection;
}

describe('RpcSubmitter', () => {
  it('builds a v0 tx, signs it, and forwards to RPC', async () => {
    const relayer = Keypair.generate();
    let captured: Uint8Array | null = null;
    const conn = fakeConnection({
      sendRawTransaction: async (wire: Uint8Array) => {
        captured = wire;
        return 'mocked-sig';
      },
    });

    const submitter = new RpcSubmitter({
      connection: conn,
      relayer,
      maxTxSize: 1232,
      jitoBundleUrl: null,
    });

    const ixData = new Uint8Array(64);
    const result = await submitter.submit({
      programId: new PublicKey('11111111111111111111111111111111'),
      ixData,
      accountKeys: [
        // Slot 0 will be overridden with relayer pubkey by the submitter.
        { pubkey: '11111111111111111111111111111111', isSigner: true, isWritable: true },
        { pubkey: 'SysvarRent111111111111111111111111111111111', isSigner: false, isWritable: false },
      ],
      altAddresses: [],
      computeUnitLimit: 200_000,
    });

    expect(result.signature).toBe('mocked-sig');
    expect(captured).not.toBeNull();
    // Round-trip the wire bytes back to a VersionedTransaction and assert
    // the fee payer is the relayer.
    const vtx = VersionedTransaction.deserialize(captured!);
    expect(vtx.message.staticAccountKeys[0]!.toBase58()).toBe(relayer.publicKey.toBase58());
  });

  it('rejects when accountKeys[0] is not a signer/writable', async () => {
    const submitter = new RpcSubmitter({
      connection: fakeConnection(),
      relayer: Keypair.generate(),
      maxTxSize: 1232,
      jitoBundleUrl: null,
    });

    await expect(submitter.submit({
      programId: new PublicKey('11111111111111111111111111111111'),
      ixData: new Uint8Array(32),
      accountKeys: [
        { pubkey: '11111111111111111111111111111111', isSigner: false, isWritable: false },
      ],
      altAddresses: [],
      computeUnitLimit: 200_000,
    })).rejects.toBeInstanceOf(RelayerError);
  });

  it('rejects unknown ALT', async () => {
    const submitter = new RpcSubmitter({
      connection: fakeConnection({ altMissing: true }),
      relayer: Keypair.generate(),
      maxTxSize: 1232,
      jitoBundleUrl: null,
    });

    await expect(submitter.submit({
      programId: new PublicKey('11111111111111111111111111111111'),
      ixData: new Uint8Array(32),
      accountKeys: [
        { pubkey: '11111111111111111111111111111111', isSigner: true, isWritable: true },
      ],
      altAddresses: [new PublicKey('SysvarRent111111111111111111111111111111111')],
      computeUnitLimit: 200_000,
    })).rejects.toBeInstanceOf(RelayerError);
  });

  it('surfaces tx confirmation errors', async () => {
    const submitter = new RpcSubmitter({
      connection: fakeConnection({ confirmErr: { InstructionError: [0, 'Custom'] } }),
      relayer: Keypair.generate(),
      maxTxSize: 1232,
      jitoBundleUrl: null,
    });

    await expect(submitter.submit({
      programId: new PublicKey('11111111111111111111111111111111'),
      ixData: new Uint8Array(32),
      accountKeys: [
        { pubkey: '11111111111111111111111111111111', isSigner: true, isWritable: true },
      ],
      altAddresses: [],
      computeUnitLimit: 200_000,
    })).rejects.toBeInstanceOf(RelayerError);
  });

  it('appends additionalIxs after the main pool ix and remaps signer slots to relayer', async () => {
    const relayer = Keypair.generate();
    let captured: Uint8Array | null = null;
    const conn = fakeConnection({
      sendRawTransaction: async (wire: Uint8Array) => {
        captured = wire;
        return 'sig-multi-ix';
      },
    });

    const submitter = new RpcSubmitter({
      connection: conn,
      relayer,
      maxTxSize: 1232,
      jitoBundleUrl: null,
    });

    const nullifierProgramId = new PublicKey('SysvarRent111111111111111111111111111111111');
    const result = await submitter.submit({
      programId: new PublicKey('11111111111111111111111111111111'),
      ixData: new Uint8Array(64),
      accountKeys: [
        { pubkey: '11111111111111111111111111111111', isSigner: true, isWritable: true },
      ],
      altAddresses: [],
      computeUnitLimit: 200_000,
      additionalIxs: [
        {
          programId: nullifierProgramId,
          ixData: new Uint8Array([1, 2, 3, 4]),
          accountKeys: [
            // Sibling-ix signer slot — should be remapped to relayer pubkey.
            { pubkey: '11111111111111111111111111111111', isSigner: true, isWritable: true },
            // Non-signer should pass through unchanged.
            { pubkey: 'SysvarRent111111111111111111111111111111111', isSigner: false, isWritable: false },
          ],
        },
      ],
    });

    expect(result.signature).toBe('sig-multi-ix');
    const vtx = VersionedTransaction.deserialize(captured!);
    // [cuIx, mainIx, nullifierIx] → 3 compiled instructions.
    expect(vtx.message.compiledInstructions.length).toBe(3);
    // Fee payer is the relayer.
    expect(vtx.message.staticAccountKeys[0]!.toBase58()).toBe(relayer.publicKey.toBase58());
    // Sibling ix's signer slot got remapped (the relayer is the only signing
    // pubkey present, so the account index for that slot must point at it).
    const siblingIx = vtx.message.compiledInstructions[2]!;
    const siblingFirstAccount = vtx.message.staticAccountKeys[siblingIx.accountKeyIndexes[0]!]!;
    expect(siblingFirstAccount.toBase58()).toBe(relayer.publicKey.toBase58());
  });

  it('uses Jito bundle endpoint when configured', async () => {
    const fetchSpy = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => {
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: 'bundle-id-1' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    const submitter = new RpcSubmitter({
      connection: fakeConnection(),
      relayer: Keypair.generate(),
      maxTxSize: 1232,
      jitoBundleUrl: 'https://mainnet.block-engine.jito.wtf/api/v1/bundles',
      fetchImpl: fetchSpy as unknown as typeof fetch,
    });

    const result = await submitter.submit({
      programId: new PublicKey('11111111111111111111111111111111'),
      ixData: new Uint8Array(32),
      accountKeys: [
        { pubkey: '11111111111111111111111111111111', isSigner: true, isWritable: true },
      ],
      altAddresses: [],
      computeUnitLimit: 200_000,
    });

    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(result.signature).toBeTruthy();
  });
});

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
  prioritizationFees: Array<{ slot: number; prioritizationFee: number }>;
  prioritizationFeesError: Error;
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
    // pollForConfirmation in submit.ts uses getSignatureStatuses now
    // (replaces the WS-based confirmTransaction). Fake confirms on first
    // poll so tests don't sleep through the backoff loop.
    getSignatureStatuses: vi.fn(async (_sigs: string[]) => ({
      value: [{
        slot,
        confirmations: 1,
        err: confirmErr,
        confirmationStatus: 'confirmed',
      }],
      context: { slot },
    })),
    getSlot: vi.fn(async () => slot),
    getBalance: vi.fn(async () => 1_000_000_000),
    getRecentPrioritizationFees: vi.fn(async () => {
      if (overrides.prioritizationFeesError) throw overrides.prioritizationFeesError;
      return overrides.prioritizationFees ?? [];
    }),
  } as unknown as Connection;
}

/**
 * Decode the SetComputeUnitPrice ix from a v0 tx if present.
 * Returns the microLamports value, or null if no priority-fee ix found.
 *
 * ComputeBudget program id: ComputeBudget111111111111111111111111111111
 * SetComputeUnitPrice discriminator: 3 (u8), followed by u64 LE.
 */
function extractPriorityFee(vtx: VersionedTransaction): bigint | null {
  const COMPUTE_BUDGET = 'ComputeBudget111111111111111111111111111111';
  for (const ix of vtx.message.compiledInstructions) {
    const programId = vtx.message.staticAccountKeys[ix.programIdIndex]?.toBase58();
    if (programId !== COMPUTE_BUDGET) continue;
    if (ix.data.length < 9) continue;
    if (ix.data[0] !== 3) continue; // not SetComputeUnitPrice
    const lo = BigInt(ix.data[1]!) | (BigInt(ix.data[2]!) << 8n) | (BigInt(ix.data[3]!) << 16n) | (BigInt(ix.data[4]!) << 24n);
    const hi = BigInt(ix.data[5]!) | (BigInt(ix.data[6]!) << 8n) | (BigInt(ix.data[7]!) << 16n) | (BigInt(ix.data[8]!) << 24n);
    return lo | (hi << 32n);
  }
  return null;
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

  it('rejects when no accountKey is signer+writable (no relayer slot)', async () => {
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
        { pubkey: 'SysvarRent111111111111111111111111111111111', isSigner: false, isWritable: false },
      ],
      altAddresses: [],
      computeUnitLimit: 200_000,
    })).rejects.toBeInstanceOf(RelayerError);
  });

  it('finds the relayer slot at any index — supports commit_inputs ix layout', async () => {
    // commit_inputs places pendingInputsPda at [0] (writable, NOT signer)
    // and the relayer at [1] (signer + writable). Submitter must scan
    // for the first signer+writable slot and substitute the relayer there.
    const relayer = Keypair.generate();
    let captured: Uint8Array | null = null;
    const conn = fakeConnection({
      sendRawTransaction: async (wire: Uint8Array) => {
        captured = wire;
        return 'sig-commit-inputs';
      },
    });

    const submitter = new RpcSubmitter({
      connection: conn,
      relayer,
      maxTxSize: 1232,
      jitoBundleUrl: null,
    });

    const result = await submitter.submit({
      programId: new PublicKey('11111111111111111111111111111111'),
      ixData: new Uint8Array(64),
      accountKeys: [
        // Slot 0: pending-inputs PDA (writable, not signer)
        { pubkey: 'SysvarRent111111111111111111111111111111111', isSigner: false, isWritable: true },
        // Slot 1: relayer placeholder (signer + writable) — must be remapped
        { pubkey: '11111111111111111111111111111111', isSigner: true, isWritable: true },
        // Slot 2: system program
        { pubkey: '11111111111111111111111111111111', isSigner: false, isWritable: false },
      ],
      altAddresses: [],
      computeUnitLimit: 200_000,
    });

    expect(result.signature).toBe('sig-commit-inputs');
    const vtx = VersionedTransaction.deserialize(captured!);
    // Fee payer (= staticAccountKeys[0]) is always the first signer+writable
    // in compiled tx — for this layout that's the relayer placeholder we
    // remapped, so it lands as relayer.publicKey.
    expect(vtx.message.staticAccountKeys[0]!.toBase58()).toBe(relayer.publicKey.toBase58());
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
    // [priorityIx, cuIx, mainIx, nullifierIx] → 4 compiled instructions.
    // priorityIx prepended after the priority-fee fix; sibling-ix is now at idx 3.
    expect(vtx.message.compiledInstructions.length).toBe(4);
    // Fee payer is the relayer.
    expect(vtx.message.staticAccountKeys[0]!.toBase58()).toBe(relayer.publicKey.toBase58());
    // Sibling ix's signer slot got remapped (the relayer is the only signing
    // pubkey present, so the account index for that slot must point at it).
    const siblingIx = vtx.message.compiledInstructions[3]!;
    const siblingFirstAccount = vtx.message.staticAccountKeys[siblingIx.accountKeyIndexes[0]!]!;
    expect(siblingFirstAccount.toBase58()).toBe(relayer.publicKey.toBase58());
  });

  describe('priority fees', () => {
    it('includes SetComputeUnitPrice ix at the floor when network is quiet', async () => {
      const relayer = Keypair.generate();
      let captured: Uint8Array | null = null;
      const conn = fakeConnection({
        prioritizationFees: [], // network quiet → fallback to floor
        sendRawTransaction: async (wire) => { captured = wire; return 'sig'; },
      });

      const submitter = new RpcSubmitter({
        connection: conn,
        relayer,
        maxTxSize: 1232,
        jitoBundleUrl: null,
        priorityFeeFloorMicroLamports: 10_000,
        priorityFeeCeilMicroLamports: 500_000,
      });

      await submitter.submit({
        programId: new PublicKey('11111111111111111111111111111111'),
        ixData: new Uint8Array(32),
        accountKeys: [{ pubkey: '11111111111111111111111111111111', isSigner: true, isWritable: true }],
        altAddresses: [],
        computeUnitLimit: 200_000,
      });

      const vtx = VersionedTransaction.deserialize(captured!);
      expect(extractPriorityFee(vtx)).toBe(10_000n);
    });

    it('picks p75 of recent fees when network has demand', async () => {
      const relayer = Keypair.generate();
      let captured: Uint8Array | null = null;
      // Mix of zeros and non-zeros. p75 of nonZero = sorted [50k,75k,100k,200k,500k] → idx floor(5*0.75)=3 → 200_000.
      const conn = fakeConnection({
        prioritizationFees: [
          { slot: 1, prioritizationFee: 0 },
          { slot: 2, prioritizationFee: 50_000 },
          { slot: 3, prioritizationFee: 75_000 },
          { slot: 4, prioritizationFee: 100_000 },
          { slot: 5, prioritizationFee: 200_000 },
          { slot: 6, prioritizationFee: 500_000 },
        ],
        sendRawTransaction: async (wire) => { captured = wire; return 'sig'; },
      });

      const submitter = new RpcSubmitter({
        connection: conn,
        relayer,
        maxTxSize: 1232,
        jitoBundleUrl: null,
        priorityFeeFloorMicroLamports: 10_000,
        priorityFeeCeilMicroLamports: 1_000_000,
      });

      await submitter.submit({
        programId: new PublicKey('11111111111111111111111111111111'),
        ixData: new Uint8Array(32),
        accountKeys: [{ pubkey: '11111111111111111111111111111111', isSigner: true, isWritable: true }],
        altAddresses: [],
        computeUnitLimit: 200_000,
      });

      const vtx = VersionedTransaction.deserialize(captured!);
      expect(extractPriorityFee(vtx)).toBe(200_000n);
    });

    it('clamps to ceiling when p75 would exceed it', async () => {
      const relayer = Keypair.generate();
      let captured: Uint8Array | null = null;
      const conn = fakeConnection({
        prioritizationFees: Array.from({ length: 8 }, (_, i) => ({
          slot: i + 1, prioritizationFee: 5_000_000,
        })),
        sendRawTransaction: async (wire) => { captured = wire; return 'sig'; },
      });

      const submitter = new RpcSubmitter({
        connection: conn,
        relayer,
        maxTxSize: 1232,
        jitoBundleUrl: null,
        priorityFeeFloorMicroLamports: 10_000,
        priorityFeeCeilMicroLamports: 500_000,
      });

      await submitter.submit({
        programId: new PublicKey('11111111111111111111111111111111'),
        ixData: new Uint8Array(32),
        accountKeys: [{ pubkey: '11111111111111111111111111111111', isSigner: true, isWritable: true }],
        altAddresses: [],
        computeUnitLimit: 200_000,
      });

      const vtx = VersionedTransaction.deserialize(captured!);
      expect(extractPriorityFee(vtx)).toBe(500_000n);
    });

    it('falls back to floor when getRecentPrioritizationFees errors', async () => {
      const relayer = Keypair.generate();
      let captured: Uint8Array | null = null;
      const conn = fakeConnection({
        prioritizationFeesError: new Error('rpc unreachable'),
        sendRawTransaction: async (wire) => { captured = wire; return 'sig'; },
      });

      const submitter = new RpcSubmitter({
        connection: conn,
        relayer,
        maxTxSize: 1232,
        jitoBundleUrl: null,
        priorityFeeFloorMicroLamports: 25_000,
        priorityFeeCeilMicroLamports: 500_000,
      });

      await submitter.submit({
        programId: new PublicKey('11111111111111111111111111111111'),
        ixData: new Uint8Array(32),
        accountKeys: [{ pubkey: '11111111111111111111111111111111', isSigner: true, isWritable: true }],
        altAddresses: [],
        computeUnitLimit: 200_000,
      });

      const vtx = VersionedTransaction.deserialize(captured!);
      expect(extractPriorityFee(vtx)).toBe(25_000n);
    });

    it('caches the priority fee decision across rapid submissions', async () => {
      const relayer = Keypair.generate();
      const conn = fakeConnection({
        prioritizationFees: [{ slot: 1, prioritizationFee: 100_000 }],
      });

      const submitter = new RpcSubmitter({
        connection: conn,
        relayer,
        maxTxSize: 1232,
        jitoBundleUrl: null,
        priorityFeeFloorMicroLamports: 10_000,
        priorityFeeCeilMicroLamports: 1_000_000,
      });

      const baseInput = {
        programId: new PublicKey('11111111111111111111111111111111'),
        ixData: new Uint8Array(32),
        accountKeys: [{ pubkey: '11111111111111111111111111111111', isSigner: true, isWritable: true }],
        altAddresses: [],
        computeUnitLimit: 200_000,
      };

      await submitter.submit(baseInput);
      await submitter.submit(baseInput);
      await submitter.submit(baseInput);

      // 3 submissions, but only 1 RPC call to getRecentPrioritizationFees
      // (10s cache window). Without cache this would be 3 calls.
      expect(conn.getRecentPrioritizationFees).toHaveBeenCalledTimes(1);
    });

    it('uses sane defaults when floor/ceil not provided in deps', async () => {
      const relayer = Keypair.generate();
      let captured: Uint8Array | null = null;
      const conn = fakeConnection({
        prioritizationFees: [], // quiet → floor default
        sendRawTransaction: async (wire) => { captured = wire; return 'sig'; },
      });

      const submitter = new RpcSubmitter({
        connection: conn,
        relayer,
        maxTxSize: 1232,
        jitoBundleUrl: null,
        // no priority-fee fields passed
      });

      await submitter.submit({
        programId: new PublicKey('11111111111111111111111111111111'),
        ixData: new Uint8Array(32),
        accountKeys: [{ pubkey: '11111111111111111111111111111111', isSigner: true, isWritable: true }],
        altAddresses: [],
        computeUnitLimit: 200_000,
      });

      const vtx = VersionedTransaction.deserialize(captured!);
      // DEFAULT_PRIORITY_FEE_FLOOR = 10_000
      expect(extractPriorityFee(vtx)).toBe(10_000n);
    });
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

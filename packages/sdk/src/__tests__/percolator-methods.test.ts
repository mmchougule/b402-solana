/**
 * `B402Solana.privatePerpOpen` / `privatePerpClose` unit tests (slice 4-β).
 *
 * These are SDK-shape tests: spy on the underlying `privateSwap` and
 * assert the percolator wrappers package args correctly (action_payload
 * bytes, adapter ix data, RA layout, USDC ATAs at adapter_authority).
 * End-to-end correctness against the deployed adapter is slice 5
 * (surfpool harness in `tests/v2/e2e/percolator-perp-fork.test.ts`).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Keypair, PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddress } from '@solana/spl-token';
import { B402Solana, type PrivatePerpOpenRequest, type PrivatePerpCloseRequest } from '../b402.js';
import {
  buildPercolatorOpenActionPayload,
  buildPercolatorCloseActionPayload,
  buildPercolatorExecuteIxData,
  derivePercolatorAdapterAuthority,
  type PercolatorPerUserAccounts,
} from '../percolator.js';

const USDC_MAINNET = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const ADAPTER_PROGRAM_ID = new PublicKey('Brp48gh1WcS6EtuKYFmK49Ldd55F9cdDkrYbfvh6RCq6');
const FAKE_ALT = new PublicKey('11111111111111111111111111111114');

function fixturePerUser(): PercolatorPerUserAccounts {
  const k = (n: number) => new PublicKey(new Uint8Array(32).fill(n));
  return {
    mapping: k(1),
    ownerPda: k(2),
    userPercolatorAta: k(3),
    slab: k(4),
    slabVault: k(5),
    percolatorProgram: k(6),
    clock: k(7),
    lpOwner: k(8),
    oracle: k(9),
    matcherProgram: k(10),
    matcherContext: k(11),
    lpPda: k(12),
  };
}

function makeSdk(): B402Solana {
  const kp = Keypair.generate();
  return new B402Solana({ cluster: 'devnet', keypair: kp });
}

describe('B402Solana.privatePerpOpen', () => {
  let sdk: B402Solana;
  let swapSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    sdk = makeSdk();
    swapSpy = vi.spyOn(sdk, 'privateSwap').mockResolvedValue({
      signature: 'fake-sig',
      outNote: {} as any,
      outAmount: 0n,
    } as any);
  });

  it('routes through privateSwap with USDC inMint=outMint and amount=marginAmount', async () => {
    const req: PrivatePerpOpenRequest = {
      lpIdx: 7,
      sizeE6: 1_500_000n,
      limitPriceE6: 200_000_000n,
      marginAmount: 50_000_000n,
      feePaymentIfInit: 100_000n,
      perUserAccts: fixturePerUser(),
      alt: FAKE_ALT,
    };
    await sdk.privatePerpOpen(req);
    expect(swapSpy).toHaveBeenCalledTimes(1);
    const call = swapSpy.mock.calls[0][0];
    expect(call.inMint.equals(USDC_MAINNET)).toBe(true);
    expect(call.outMint.equals(USDC_MAINNET)).toBe(true);
    expect(call.amount).toBe(50_000_000n);
    expect(call.expectedOut).toBe(0n);
  });

  it('builds the correct action_payload (matches buildPercolatorOpenActionPayload)', async () => {
    const req: PrivatePerpOpenRequest = {
      lpIdx: 7,
      sizeE6: 1_500_000n,
      limitPriceE6: 200_000_000n,
      marginAmount: 50_000_000n,
      feePaymentIfInit: 100_000n,
      perUserAccts: fixturePerUser(),
      alt: FAKE_ALT,
    };
    await sdk.privatePerpOpen(req);
    const expected = buildPercolatorOpenActionPayload({
      lpIdx: 7,
      sizeE6: 1_500_000n,
      limitPriceE6: 200_000_000n,
      feePaymentIfInit: 100_000n,
    });
    expect(swapSpy.mock.calls[0][0].actionPayload).toEqual(expected);
    expect(swapSpy.mock.calls[0][0].actionPayload.length).toBe(35);
  });

  it('builds the correct adapter ix data (execute disc + in_amount + 0 + len + payload)', async () => {
    const req: PrivatePerpOpenRequest = {
      lpIdx: 0,
      sizeE6: -1_000_000n,
      limitPriceE6: 100_000_000n,
      marginAmount: 25_000_000n,
      perUserAccts: fixturePerUser(),
      alt: FAKE_ALT,
    };
    await sdk.privatePerpOpen(req);
    const payload = buildPercolatorOpenActionPayload({
      lpIdx: 0,
      sizeE6: -1_000_000n,
      limitPriceE6: 100_000_000n,
      feePaymentIfInit: 0n,
    });
    const expected = buildPercolatorExecuteIxData({
      inAmount: 25_000_000n,
      expectedOut: 0n,
      actionPayload: payload,
    });
    expect(swapSpy.mock.calls[0][0].adapterIxData).toEqual(expected);
  });

  it('feePaymentIfInit defaults to 0n when omitted', async () => {
    const req: PrivatePerpOpenRequest = {
      lpIdx: 0,
      sizeE6: 1_000_000n,
      limitPriceE6: 100_000_000n,
      marginAmount: 1_000_000n,
      perUserAccts: fixturePerUser(),
      alt: FAKE_ALT,
    };
    await sdk.privatePerpOpen(req);
    // Re-encode with fee=0 and assert the payload matches.
    const expected = buildPercolatorOpenActionPayload({
      lpIdx: 0,
      sizeE6: 1_000_000n,
      limitPriceE6: 100_000_000n,
      feePaymentIfInit: 0n,
    });
    expect(swapSpy.mock.calls[0][0].actionPayload).toEqual(expected);
  });

  it('routes adapterInTa=adapterOutTa to the adapter_authority USDC ATA', async () => {
    const req: PrivatePerpOpenRequest = {
      lpIdx: 0,
      sizeE6: 1_000n,
      limitPriceE6: 1n,
      marginAmount: 1n,
      perUserAccts: fixturePerUser(),
      alt: FAKE_ALT,
    };
    await sdk.privatePerpOpen(req);
    const [adapterAuthority] = derivePercolatorAdapterAuthority(ADAPTER_PROGRAM_ID);
    const expectedAta = await getAssociatedTokenAddress(USDC_MAINNET, adapterAuthority, true);
    const call = swapSpy.mock.calls[0][0];
    expect(call.adapterInTa.equals(expectedAta)).toBe(true);
    expect(call.adapterOutTa.equals(expectedAta)).toBe(true);
  });

  it('passes 12 head remaining_accounts in pinned RA_* order', async () => {
    const req: PrivatePerpOpenRequest = {
      lpIdx: 0,
      sizeE6: 1n,
      limitPriceE6: 1n,
      marginAmount: 1n,
      perUserAccts: fixturePerUser(),
      alt: FAKE_ALT,
    };
    await sdk.privatePerpOpen(req);
    const ra = swapSpy.mock.calls[0][0].remainingAccounts;
    expect(ra).toHaveLength(12);
    // Slot 0 = mapping (filled with byte 1 in fixturePerUser)
    expect(ra[0].pubkey.toBase58()).toBe(new PublicKey(new Uint8Array(32).fill(1)).toBase58());
    // Slot 11 = lp_pda (byte 12)
    expect(ra[11].pubkey.toBase58()).toBe(new PublicKey(new Uint8Array(32).fill(12)).toBase58());
  });

  it('appends matcher_tail when provided', async () => {
    const tail = [
      { pubkey: new PublicKey(new Uint8Array(32).fill(0xfe)), isSigner: false, isWritable: false },
    ];
    const req: PrivatePerpOpenRequest = {
      lpIdx: 0,
      sizeE6: 1n,
      limitPriceE6: 1n,
      marginAmount: 1n,
      perUserAccts: fixturePerUser(),
      matcherTail: tail,
      alt: FAKE_ALT,
    };
    await sdk.privatePerpOpen(req);
    const ra = swapSpy.mock.calls[0][0].remainingAccounts;
    expect(ra).toHaveLength(13);
    expect(ra[12]).toEqual(tail[0]);
  });

  it('forwards the configured ALT and additional ALTs', async () => {
    const altA = new PublicKey('11111111111111111111111111111115');
    const altB = new PublicKey('11111111111111111111111111111116');
    const req: PrivatePerpOpenRequest = {
      lpIdx: 0,
      sizeE6: 1n,
      limitPriceE6: 1n,
      marginAmount: 1n,
      perUserAccts: fixturePerUser(),
      alt: altA,
      alts: [altB],
    };
    await sdk.privatePerpOpen(req);
    expect(swapSpy.mock.calls[0][0].alt.equals(altA)).toBe(true);
    expect(swapSpy.mock.calls[0][0].alts).toEqual([altB]);
  });

  it('phase9DualNote defaults to true (percolator targets Phase-9 build)', async () => {
    const req: PrivatePerpOpenRequest = {
      lpIdx: 0,
      sizeE6: 1n,
      limitPriceE6: 1n,
      marginAmount: 1n,
      perUserAccts: fixturePerUser(),
      alt: FAKE_ALT,
    };
    await sdk.privatePerpOpen(req);
    expect(swapSpy.mock.calls[0][0].phase9DualNote).toBe(true);
  });

  it('caller can override adapterProgramId', async () => {
    const otherAdapter = new PublicKey('11111111111111111111111111111117');
    const req: PrivatePerpOpenRequest = {
      lpIdx: 0,
      sizeE6: 1n,
      limitPriceE6: 1n,
      marginAmount: 1n,
      perUserAccts: fixturePerUser(),
      adapterProgramId: otherAdapter,
      alt: FAKE_ALT,
    };
    await sdk.privatePerpOpen(req);
    const call = swapSpy.mock.calls[0][0];
    expect(call.adapterProgramId.equals(otherAdapter)).toBe(true);
    // ATAs follow the override too.
    const [authOther] = derivePercolatorAdapterAuthority(otherAdapter);
    const expectedAta = await getAssociatedTokenAddress(USDC_MAINNET, authOther, true);
    expect(call.adapterInTa.equals(expectedAta)).toBe(true);
  });
});

describe('B402Solana.privatePerpClose', () => {
  let sdk: B402Solana;
  let swapSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    sdk = makeSdk();
    swapSpy = vi.spyOn(sdk, 'privateSwap').mockResolvedValue({
      signature: 'fake-close-sig',
      outNote: {} as any,
      outAmount: 0n,
    } as any);
  });

  it('routes with amount=0n, expectedOut=minOut, USDC inMint=outMint', async () => {
    const req: PrivatePerpCloseRequest = {
      lpIdx: 3,
      limitPriceE6: 199_000_000n,
      minOut: 1_000_000n,
      perUserAccts: fixturePerUser(),
      alt: FAKE_ALT,
    };
    await sdk.privatePerpClose(req);
    const call = swapSpy.mock.calls[0][0];
    expect(call.amount).toBe(0n);
    expect(call.expectedOut).toBe(1_000_000n);
    expect(call.inMint.equals(USDC_MAINNET)).toBe(true);
    expect(call.outMint.equals(USDC_MAINNET)).toBe(true);
  });

  it('builds ClosePosition action_payload with correct discriminant + fields', async () => {
    const req: PrivatePerpCloseRequest = {
      lpIdx: 3,
      limitPriceE6: 199_000_000n,
      perUserAccts: fixturePerUser(),
      alt: FAKE_ALT,
    };
    await sdk.privatePerpClose(req);
    const expected = buildPercolatorCloseActionPayload({
      lpIdx: 3,
      limitPriceE6: 199_000_000n,
    });
    expect(swapSpy.mock.calls[0][0].actionPayload).toEqual(expected);
    expect(swapSpy.mock.calls[0][0].actionPayload[0]).toBe(1); // ClosePosition disc
    expect(swapSpy.mock.calls[0][0].actionPayload.length).toBe(11);
  });

  it('minOut defaults to 0n when omitted', async () => {
    const req: PrivatePerpCloseRequest = {
      lpIdx: 0,
      limitPriceE6: 100_000_000n,
      perUserAccts: fixturePerUser(),
      alt: FAKE_ALT,
    };
    await sdk.privatePerpClose(req);
    expect(swapSpy.mock.calls[0][0].expectedOut).toBe(0n);
  });

  it('builds adapter ix data with in_amount=0', async () => {
    const req: PrivatePerpCloseRequest = {
      lpIdx: 5,
      limitPriceE6: 50_000_000n,
      minOut: 25_000_000n,
      perUserAccts: fixturePerUser(),
      alt: FAKE_ALT,
    };
    await sdk.privatePerpClose(req);
    const payload = buildPercolatorCloseActionPayload({ lpIdx: 5, limitPriceE6: 50_000_000n });
    const expected = buildPercolatorExecuteIxData({
      inAmount: 0n,
      expectedOut: 25_000_000n,
      actionPayload: payload,
    });
    expect(swapSpy.mock.calls[0][0].adapterIxData).toEqual(expected);
  });

  it('forwards caller-supplied note (zero-value note for the burn requirement)', async () => {
    const fakeNote: any = { commitment: 0xabcdn, value: 0n };
    const req: PrivatePerpCloseRequest = {
      lpIdx: 0,
      limitPriceE6: 1n,
      perUserAccts: fixturePerUser(),
      note: fakeNote,
      alt: FAKE_ALT,
    };
    await sdk.privatePerpClose(req);
    expect(swapSpy.mock.calls[0][0].note).toBe(fakeNote);
  });
});

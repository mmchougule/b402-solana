/**
 * tx-size regression: synthetic adapt_execute_devnet tx must fit under
 * Solana's 1,232 B cap with b402's ALT attached.
 *
 * Guards against future bloat — if someone adds named accounts to the
 * pool handler, extends action_payload, or drops the b402 ALT, this test
 * catches it before we ship.
 */

import { describe, expect, it } from 'vitest';
import {
  AddressLookupTableAccount, AddressLookupTableState, Keypair, PublicKey, SystemProgram,
} from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync,
} from '@solana/spl-token';

import {
  buildPrivateSwapTx, MAX_ACTION_PAYLOAD, MAX_TX_SIZE,
} from '../actions/privateSwap.js';
import {
  poolConfigPda, treeStatePda, tokenConfigPda, vaultPda, adapterRegistryPda,
} from '../programs/pda.js';

const POOL_ID = new PublicKey('42a3hsCXtQLWonyxWZosaaCJCweYYKMrvNd25p1Jrt2y');
const VERIFIER_ID = new PublicKey('Afjbnv2Ekxa98jjRw33xPPhZabevek2uZxoE75kr6ZrK');
const JUPITER_ADAPTER_ID = new PublicKey('3RHRcbinCmcj8JPBfVxb9FW76oh4r8y21aSx4JFy3yx7');
const JUPITER_V6_ID = new PublicKey('JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4');
const USDC = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const WSOL = new PublicKey('So11111111111111111111111111111111111111112');

const DUMMY_BLOCKHASH = '11111111111111111111111111111111';

function stubAltWith(key: PublicKey, addresses: PublicKey[]): AddressLookupTableAccount {
  const state: AddressLookupTableState = {
    deactivationSlot: BigInt('0xffffffffffffffff'),
    lastExtendedSlot: 0,
    lastExtendedSlotStartIndex: 0,
    authority: undefined,
    addresses,
  };
  return new AddressLookupTableAccount({ key, state });
}

/**
 * Mirror of ops/alt/create-alt.ts stableSeedAccounts(). Must stay in sync
 * with the real ALT — if the real ALT drops an entry, the tx-size math
 * this test validates no longer holds.
 */
function b402AltSeedAccounts(): PublicKey[] {
  const adapterAuthority = PublicKey.findProgramAddressSync(
    [new TextEncoder().encode('b402/v1'), new TextEncoder().encode('adapter')],
    JUPITER_ADAPTER_ID,
  )[0];
  return [
    JUPITER_V6_ID, POOL_ID, VERIFIER_ID, JUPITER_ADAPTER_ID,
    TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, SystemProgram.programId,
    poolConfigPda(POOL_ID), treeStatePda(POOL_ID), adapterAuthority,
    WSOL, USDC,
    getAssociatedTokenAddressSync(WSOL, adapterAuthority, true),
    getAssociatedTokenAddressSync(USDC, adapterAuthority, true),
  ];
}

/**
 * Per-mint accounts we'd `alt add-mint` after whitelisting: pool-side
 * Vault + TokenConfig PDAs and the adapter's scratch ATA for that mint.
 */
function mintAltEntries(mint: PublicKey, adapterProgramId: PublicKey): PublicKey[] {
  const auth = PublicKey.findProgramAddressSync(
    [new TextEncoder().encode('b402/v1'), new TextEncoder().encode('adapter')],
    adapterProgramId,
  )[0];
  return [
    vaultPda(POOL_ID, mint),
    tokenConfigPda(POOL_ID, mint),
    getAssociatedTokenAddressSync(mint, auth, true),
  ];
}

function stubJupiterSwap(routeSize: number, jupiterKeys: PublicKey[]) {
  const data = new Uint8Array(routeSize);
  for (let i = 0; i < data.length; i++) data[i] = i & 0xff;
  const keys = jupiterKeys.map((pubkey, i) => ({
    pubkey, isSigner: false, isWritable: i % 3 === 0,
  }));
  return { programId: JUPITER_V6_ID, keys, data };
}

function stubEncryptedNote() {
  return {
    ciphertext: new Uint8Array(89),
    ephemeralPub: new Uint8Array(32),
    viewingTag: new Uint8Array(2),
  };
}

describe('privateSwap tx-size', () => {
  it('2-hop Jupiter route with b402 ALT fits under 1232 B', () => {
    // 2-hop Whirlpool: ~14 Jupiter-side accounts, ~180 B route-plan per PRD-04 §5.1.
    const b402Alt = stubAltWith(
      Keypair.generate().publicKey,
      [
        ...b402AltSeedAccounts(),
        ...mintAltEntries(USDC, JUPITER_ADAPTER_ID),
        ...mintAltEntries(WSOL, JUPITER_ADAPTER_ID),
      ],
    );
    const jupKeys = Array.from({ length: 14 }, () => Keypair.generate().publicKey);
    const jupiterAlt = stubAltWith(Keypair.generate().publicKey, jupKeys);
    const jupiterSwap = stubJupiterSwap(180, jupKeys);

    const { estimatedSize } = buildPrivateSwapTx({
      poolProgramId: POOL_ID,
      jupiterAdapterId: JUPITER_ADAPTER_ID,
      altAccounts: [b402Alt, jupiterAlt],
      caller: Keypair.generate().publicKey,
      outputCommitmentLe: new Uint8Array(32),
      encryptedNote: stubEncryptedNote(),
      inMint: USDC, outMint: WSOL,
      inAmount: 100_000_000n, minOutAmount: 500_000_000n,
      jupiterSwapIx: jupiterSwap,
      blockhash: DUMMY_BLOCKHASH,
    });

    expect(estimatedSize, `2-hop estimate ${estimatedSize} B`).toBeLessThanOrEqual(MAX_TX_SIZE);
  });

  it('3-hop Jupiter route with b402 ALT fits under 1232 B', () => {
    // 3-hop: ~20 Jupiter accounts, ~280 B route-plan.
    const b402Alt = stubAltWith(
      Keypair.generate().publicKey,
      [
        ...b402AltSeedAccounts(),
        ...mintAltEntries(USDC, JUPITER_ADAPTER_ID),
        ...mintAltEntries(WSOL, JUPITER_ADAPTER_ID),
      ],
    );
    const jupKeys = Array.from({ length: 20 }, () => Keypair.generate().publicKey);
    const jupiterAlt = stubAltWith(Keypair.generate().publicKey, jupKeys);
    const jupiterSwap = stubJupiterSwap(280, jupKeys);

    const { estimatedSize } = buildPrivateSwapTx({
      poolProgramId: POOL_ID,
      jupiterAdapterId: JUPITER_ADAPTER_ID,
      altAccounts: [b402Alt, jupiterAlt],
      caller: Keypair.generate().publicKey,
      outputCommitmentLe: new Uint8Array(32),
      encryptedNote: stubEncryptedNote(),
      inMint: USDC, outMint: WSOL,
      inAmount: 100_000_000n, minOutAmount: 500_000_000n,
      jupiterSwapIx: jupiterSwap,
      blockhash: DUMMY_BLOCKHASH,
    });

    expect(estimatedSize, `3-hop estimate ${estimatedSize} B`).toBeLessThanOrEqual(MAX_TX_SIZE);
  });

  it('fails fast when action_payload exceeds MAX_ACTION_PAYLOAD', () => {
    const b402Alt = stubAltWith(Keypair.generate().publicKey, b402AltSeedAccounts());
    const jupKeys = Array.from({ length: 14 }, () => Keypair.generate().publicKey);
    const jupiterSwap = stubJupiterSwap(MAX_ACTION_PAYLOAD + 1, jupKeys);

    expect(() => buildPrivateSwapTx({
      poolProgramId: POOL_ID,
      jupiterAdapterId: JUPITER_ADAPTER_ID,
      altAccounts: [b402Alt],
      caller: Keypair.generate().publicKey,
      outputCommitmentLe: new Uint8Array(32),
      encryptedNote: stubEncryptedNote(),
      inMint: USDC, outMint: WSOL,
      inAmount: 100n, minOutAmount: 1n,
      jupiterSwapIx: jupiterSwap,
      blockhash: DUMMY_BLOCKHASH,
    })).toThrow(/MAX_ACTION_PAYLOAD/);
  });

  it('without ANY ALT, realistic adapt tx overflows (documents why ALT is required)', () => {
    const jupKeys = Array.from({ length: 20 }, () => Keypair.generate().publicKey);
    const jupiterSwap = stubJupiterSwap(280, jupKeys);

    const { estimatedSize } = buildPrivateSwapTx({
      poolProgramId: POOL_ID,
      jupiterAdapterId: JUPITER_ADAPTER_ID,
      altAccounts: [],
      caller: Keypair.generate().publicKey,
      outputCommitmentLe: new Uint8Array(32),
      encryptedNote: stubEncryptedNote(),
      inMint: USDC, outMint: WSOL,
      inAmount: 100n, minOutAmount: 1n,
      jupiterSwapIx: jupiterSwap,
      blockhash: DUMMY_BLOCKHASH,
    });

    expect(estimatedSize).toBeGreaterThan(MAX_TX_SIZE);
  });
});

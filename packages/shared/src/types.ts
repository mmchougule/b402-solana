/** Shared domain types for SDK ↔ prover ↔ relayer. */

/** Canonical Fr element: 32-byte little-endian, canonical (`x < p`). */
export type FrLe = Uint8Array;

export interface Note {
  tokenMint: bigint;    // Fr-reduced mint
  value: bigint;        // u64
  random: bigint;       // Fr
  spendingPub: bigint;  // Fr
}

export interface SpendableNote extends Note {
  commitment: bigint;
  leafIndex: bigint;
  spendingPriv: bigint;
  encryptedBytes: Uint8Array;
  ephemeralPub: Uint8Array;
  viewingTag: Uint8Array;
}

export interface TransactPublicInputs {
  merkleRoot: bigint;
  nullifier: [bigint, bigint];
  commitmentOut: [bigint, bigint];
  publicAmountIn: bigint;
  publicAmountOut: bigint;
  publicTokenMint: bigint;
  relayerFee: bigint;
  relayerFeeBind: bigint;
  rootBind: bigint;
}

export interface Groth16Proof {
  a: Uint8Array;    // 64 bytes (G1)
  b: Uint8Array;    // 128 bytes (G2)
  c: Uint8Array;    // 64 bytes (G1)
}

export interface ShieldIntent {
  kind: 'shield';
  tokenMint: string;     // base58
  amount: bigint;
  recipientSpendingPub?: bigint;   // defaults to own spending pub
}

export interface UnshieldIntent {
  kind: 'unshield';
  tokenMint: string;
  amount: bigint;
  recipient: string;     // base58 Solana address
}

export interface TransferIntent {
  kind: 'transfer';
  tokenMint: string;
  amount: bigint;
  recipientSpendingPub: bigint;
}

export interface PrivateSwapIntent {
  kind: 'privateSwap';
  fromMint: string;
  toMint: string;
  amount: bigint;
  slippageBps?: number;
}

export type Intent = ShieldIntent | UnshieldIntent | TransferIntent | PrivateSwapIntent;

/**
 * Verifies the wallet-isolation property: for a tx signed by the b402
 * hosted relayer, the user's wallet pubkey must NOT appear in
 * `tx.transaction.message.staticAccountKeys` (or `accountKeys` for
 * legacy tx). signer[0] must equal the expected relayer pubkey.
 *
 * For the public baseline: signer[0] must equal the user wallet.
 */
import type { Connection, PublicKey } from '@solana/web3.js';

export interface IsolationCheck {
  signature: string;
  userWallet: string;
  signer0: string;
  userInAccountKeys: boolean;
  passed: boolean;
  reason?: string;
}

export interface BaselineCheck {
  signature: string;
  userWallet: string;
  signer0: string;
  passed: boolean;
  reason?: string;
}

/**
 * Extract the static account-key list from a fetched tx. Handles both
 * the legacy `message.accountKeys` shape and the v0 `staticAccountKeys`
 * shape. Returns base58 strings.
 */
export function staticAccountKeysOf(tx: {
  transaction: {
    message: {
      accountKeys?: Array<{ toBase58: () => string } | string>;
      staticAccountKeys?: Array<{ toBase58: () => string } | string>;
    };
  };
}): string[] {
  const raw = tx.transaction.message.staticAccountKeys ?? tx.transaction.message.accountKeys ?? [];
  return raw.map((k) => (typeof k === 'string' ? k : k.toBase58()));
}

export function checkPrivateIsolation(args: {
  signature: string;
  userWallet: string;
  expectedRelayer: string;
  staticAccountKeys: string[];
}): IsolationCheck {
  const { signature, userWallet, expectedRelayer, staticAccountKeys } = args;
  const signer0 = staticAccountKeys[0] ?? '';
  const userInAccountKeys = staticAccountKeys.includes(userWallet);

  let passed = true;
  let reason: string | undefined;
  if (signer0 !== expectedRelayer) {
    passed = false;
    reason = `signer[0] = ${signer0}, expected relayer ${expectedRelayer}`;
  }
  if (userInAccountKeys) {
    passed = false;
    reason = reason
      ? `${reason}; user wallet ${userWallet} appears in accountKeys`
      : `user wallet ${userWallet} appears in accountKeys`;
  }

  return {
    signature,
    userWallet,
    signer0,
    userInAccountKeys,
    passed,
    ...(reason !== undefined ? { reason } : {}),
  };
}

export function checkBaselineSelfSigned(args: {
  signature: string;
  userWallet: string;
  staticAccountKeys: string[];
}): BaselineCheck {
  const { signature, userWallet, staticAccountKeys } = args;
  const signer0 = staticAccountKeys[0] ?? '';
  const passed = signer0 === userWallet;
  return {
    signature,
    userWallet,
    signer0,
    passed,
    ...(passed ? {} : { reason: `signer[0] = ${signer0}, expected user wallet ${userWallet}` }),
  };
}

/**
 * Fetch + verify a private-side tx. Retries a few times because
 * `getTransaction` on confirmed RPCs can lag a few seconds behind landing.
 */
export async function verifyPrivateTx(args: {
  conn: Connection;
  signature: string;
  userWallet: PublicKey;
  expectedRelayer: string;
  attempts?: number;
  delayMs?: number;
}): Promise<IsolationCheck> {
  const { conn, signature, userWallet, expectedRelayer } = args;
  const attempts = args.attempts ?? 6;
  const delayMs = args.delayMs ?? 2000;

  for (let i = 0; i < attempts; i++) {
    const tx = await conn.getTransaction(signature, {
      maxSupportedTransactionVersion: 0,
      commitment: 'confirmed',
    });
    if (tx) {
      const keys = staticAccountKeysOf(tx as never);
      return checkPrivateIsolation({
        signature,
        userWallet: userWallet.toBase58(),
        expectedRelayer,
        staticAccountKeys: keys,
      });
    }
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return {
    signature,
    userWallet: userWallet.toBase58(),
    signer0: '',
    userInAccountKeys: false,
    passed: false,
    reason: `tx not found after ${attempts} attempts`,
  };
}

export async function verifyBaselineTx(args: {
  conn: Connection;
  signature: string;
  userWallet: PublicKey;
  attempts?: number;
  delayMs?: number;
}): Promise<BaselineCheck> {
  const { conn, signature, userWallet } = args;
  const attempts = args.attempts ?? 6;
  const delayMs = args.delayMs ?? 2000;

  for (let i = 0; i < attempts; i++) {
    const tx = await conn.getTransaction(signature, {
      maxSupportedTransactionVersion: 0,
      commitment: 'confirmed',
    });
    if (tx) {
      const keys = staticAccountKeysOf(tx as never);
      return checkBaselineSelfSigned({
        signature,
        userWallet: userWallet.toBase58(),
        staticAccountKeys: keys,
      });
    }
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return {
    signature,
    userWallet: userWallet.toBase58(),
    signer0: '',
    passed: false,
    reason: `tx not found after ${attempts} attempts`,
  };
}

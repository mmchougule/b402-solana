/**
 * Env-driven runtime configuration. Validated at boot — fail fast on bad input.
 *
 * SECURITY: keypair material is loaded once and never logged. The Keypair
 * instance is held in memory only; serialised secret bytes are zeroed after
 * load. Callers must not pass `keypair` into log lines.
 */

import { readFileSync } from 'node:fs';
import { Keypair, PublicKey } from '@solana/web3.js';
import { z } from 'zod';

const PubkeySchema = z.string().min(32).max(44).transform((s, ctx) => {
  try {
    return new PublicKey(s);
  } catch {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `invalid base58 pubkey: ${s}` });
    return z.NEVER;
  }
});

const ApiKeyEntrySchema = z.object({
  rateLimitPerMin: z.number().int().positive().max(10_000).default(10),
  /** Optional list of base58 mint pubkeys this key is allowed to relay against. */
  tokenAllowlist: z.array(z.string()).optional(),
  /** Free-form label for logs. */
  label: z.string().optional(),
});

const ApiKeyFileSchema = z.record(ApiKeyEntrySchema).superRefine((rec, ctx) => {
  for (const k of Object.keys(rec)) {
    if (k.length < 8) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `api key id "${k}" must be ≥ 8 chars`,
      });
    }
  }
});

export type ApiKeyEntry = z.infer<typeof ApiKeyEntrySchema>;
export type ApiKeyMap = z.infer<typeof ApiKeyFileSchema>;

const EnvSchema = z.object({
  PORT: z.coerce.number().int().positive().max(65_535).default(8080),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  RPC_URL: z.string().url(),
  RELAYER_KEYPAIR: z.string().min(1),
  POOL_PROGRAM_ID: PubkeySchema,
  VERIFIER_TRANSACT_PROGRAM_ID: PubkeySchema.optional(),
  VERIFIER_ADAPT_PROGRAM_ID: PubkeySchema.optional(),

  /** Optional adapter program allowlist — required for /relay/adapt. */
  JUPITER_ADAPTER_ID: PubkeySchema.optional(),
  MOCK_ADAPTER_ID: PubkeySchema.optional(),
  EXTRA_ADAPTER_IDS: z.string().optional(), // comma-sep base58

  /** Optional Jito block-engine bundle endpoint. */
  JITO_BUNDLE_URL: z.string().url().optional(),

  /** Reject txs whose proof-bound relayer_fee is below this u64 (smallest-units). */
  MIN_FEE_LAMPORTS: z.coerce.bigint().nonnegative().default(0n),

  /** Path to JSON file mapping API keys → policy. Set to "" to disable auth (dev only). */
  API_KEY_FILE: z.string().default(''),

  /** Cap on serialised tx size after relayer signs. Solana enforces 1232. */
  MAX_TX_SIZE: z.coerce.number().int().positive().max(1232).default(1232),

  /** Override the default 1.4M CU budget per relay. */
  COMPUTE_UNIT_LIMIT: z.coerce.number().int().positive().max(1_400_000).default(1_400_000),
});

export interface Config {
  port: number;
  host: string;
  logLevel: string;
  rpcUrl: string;
  keypair: Keypair;
  poolProgramId: PublicKey;
  verifierTransactProgramId: PublicKey | null;
  verifierAdaptProgramId: PublicKey | null;
  adapterAllowlist: PublicKey[];
  jitoBundleUrl: string | null;
  minFeeLamports: bigint;
  apiKeys: ApiKeyMap | null;
  authEnabled: boolean;
  maxTxSize: number;
  computeUnitLimit: number;
}

function loadKeypair(path: string): Keypair {
  const raw = readFileSync(path, 'utf-8').trim();
  let bytes: number[];
  try {
    bytes = JSON.parse(raw) as number[];
  } catch (err) {
    throw new Error(`RELAYER_KEYPAIR ${path}: not valid JSON: ${(err as Error).message}`);
  }
  if (!Array.isArray(bytes) || bytes.length !== 64) {
    throw new Error(`RELAYER_KEYPAIR ${path}: expected 64-byte JSON array, got ${Array.isArray(bytes) ? bytes.length : typeof bytes}`);
  }
  const u8 = new Uint8Array(bytes);
  // NOTE: do NOT scrub `u8` after passing to `Keypair.fromSecretKey` — in
  // some @solana/web3.js builds the resulting Keypair shares the underlying
  // buffer, so `u8.fill(0)` corrupts the loaded secret. Symptoms: every
  // signed tx returns `Transaction did not pass signature verification`
  // because ed25519 derives a pubkey from a zeroed seed that doesn't match
  // the (also-zeroed) declared pubkey at slot[0]. Let GC reclaim the buffer.
  const kp = Keypair.fromSecretKey(u8);
  return kp;
}

function loadApiKeys(path: string): ApiKeyMap | null {
  if (!path) return null;
  const raw = readFileSync(path, 'utf-8');
  const parsed = JSON.parse(raw) as unknown;
  return ApiKeyFileSchema.parse(parsed);
}

function parseExtraAdapters(raw: string | undefined): PublicKey[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => new PublicKey(s));
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.parse(env);

  const keypair = loadKeypair(parsed.RELAYER_KEYPAIR);
  const apiKeys = loadApiKeys(parsed.API_KEY_FILE);

  const adapterAllowlist: PublicKey[] = [];
  if (parsed.JUPITER_ADAPTER_ID) adapterAllowlist.push(parsed.JUPITER_ADAPTER_ID);
  if (parsed.MOCK_ADAPTER_ID) adapterAllowlist.push(parsed.MOCK_ADAPTER_ID);
  adapterAllowlist.push(...parseExtraAdapters(parsed.EXTRA_ADAPTER_IDS));

  return {
    port: parsed.PORT,
    host: parsed.HOST,
    logLevel: parsed.LOG_LEVEL,
    rpcUrl: parsed.RPC_URL,
    keypair,
    poolProgramId: parsed.POOL_PROGRAM_ID,
    verifierTransactProgramId: parsed.VERIFIER_TRANSACT_PROGRAM_ID ?? null,
    verifierAdaptProgramId: parsed.VERIFIER_ADAPT_PROGRAM_ID ?? null,
    adapterAllowlist,
    jitoBundleUrl: parsed.JITO_BUNDLE_URL ?? null,
    minFeeLamports: parsed.MIN_FEE_LAMPORTS,
    apiKeys,
    authEnabled: apiKeys !== null,
    maxTxSize: parsed.MAX_TX_SIZE,
    computeUnitLimit: parsed.COMPUTE_UNIT_LIMIT,
  };
}

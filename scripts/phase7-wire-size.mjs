// Standalone wire-size measurement for Phase 7.
//
// Mirrors tests/v2/integration/phase7_wire_size.test.ts but runs without
// vitest. Uses fake/synthetic ix data + accounts — only Solana's structural
// wire encoding is being measured, not real proofs / Light state.
//
// Run with the repo's hoisted node_modules:
//   node scripts/phase7-wire-size.mjs
//
// The numbers reported go straight into docs/prds/PHASE-7-HANDOFF.md.

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..');
// Resolve from tests/v2 because that workspace pulls @solana/web3.js +
// @solana/spl-token as direct deps; the repo root package.json doesn't.
const requireFromV2 = createRequire(resolve(repo, 'tests/v2/package.json'));

const {
  AddressLookupTableAccount, ComputeBudgetProgram, Keypair, PublicKey,
  SystemProgram, TransactionInstruction, TransactionMessage,
} = requireFromV2('@solana/web3.js');
const { TOKEN_PROGRAM_ID } = requireFromV2('@solana/spl-token');

function fakeProof()  { return new Uint8Array(256); }
function fakeBytes(n) { return new Uint8Array(n); }
function u32Le(n)     { const o = new Uint8Array(4); new DataView(o.buffer).setUint32(0, n, true); return o; }
function u64Le(n)     { const o = new Uint8Array(8); new DataView(o.buffer).setBigUint64(0, BigInt(n), true); return o; }
function vecU8(b)     { const len = u32Le(b.length); const o = new Uint8Array(len.length + b.length); o.set(len, 0); o.set(b, len.length); return o; }
function concat(...p) { const t = p.reduce((a, b) => a + b.length, 0); const o = new Uint8Array(t); let c = 0; for (const x of p) { o.set(x, c); c += x.length; } return o; }
function fkey(tag) {
  const seed = new Uint8Array(32); const enc = new TextEncoder().encode(tag);
  seed.set(enc.subarray(0, Math.min(enc.length, 32)));
  return Keypair.fromSeed(seed).publicKey;
}

const SYSVAR_INSTRUCTIONS = new PublicKey('Sysvar1nstructions1111111111111111111111111');
const B402_NULLIFIER_PROGRAM_ID = new PublicKey('2AnRZwWu6CTurZs1yQpqrcJWo4yRYL1xpeV78b2siweq');
const B402_POOL = fkey('b402_pool');
const VERIFIER = fkey('verifier_transact');
const ADAPT_VERIFIER = fkey('verifier_adapt');
const RELAYER = fkey('relayer');
const POOL_CONFIG = fkey('pool_config');
const TREE_STATE = fkey('tree_state');
const TOKEN_CONFIG = fkey('token_config');
const VAULT = fkey('vault');
const RECIPIENT_TA = fkey('recipient_ta');

function buildLightAccounts9() {
  return [
    { pubkey: RELAYER, isSigner: true, isWritable: true },
    { pubkey: fkey('light_system_program'), isSigner: false, isWritable: false },
    { pubkey: fkey('cpi_authority'), isSigner: false, isWritable: false },
    { pubkey: fkey('registered_program_pda'), isSigner: false, isWritable: false },
    { pubkey: fkey('account_compression_authority'), isSigner: false, isWritable: false },
    { pubkey: fkey('account_compression_program'), isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: fkey('address_tree'), isSigner: false, isWritable: true },
    { pubkey: fkey('output_queue'), isSigner: false, isWritable: true },
  ];
}
function buildLightAccounts10() {
  const a = buildLightAccounts9();
  return [a[0], { pubkey: SYSVAR_INSTRUCTIONS, isSigner: false, isWritable: false }, ...a.slice(1)];
}

function buildSiblingNullifierIx() {
  const data = new Uint8Array(8 + 129 + 4 + 1 + 32);
  return new TransactionInstruction({
    programId: B402_NULLIFIER_PROGRAM_ID,
    keys: buildLightAccounts9(),
    data: Buffer.from(data),
  });
}

function buildUnshieldIxData(inline) {
  const parts = [
    fakeBytes(8),
    vecU8(fakeProof()),
    fakeBytes(32), fakeBytes(32), fakeBytes(32), fakeBytes(32), fakeBytes(32),
    u64Le(0n), u64Le(100_000n),
    fakeBytes(32),
    u64Le(0n),
    fakeBytes(32), fakeBytes(32), fakeBytes(32),
    u32Le(0),
    new Uint8Array([0b10]),
    new Uint8Array([0b11]),
    fakeBytes(32),
  ];
  if (inline) { parts.push(u32Le(1)); parts.push(vecU8(fakeBytes(134))); }
  return concat(...parts);
}

function buildUnshieldIx(inline) {
  const baseKeys = [
    { pubkey: RELAYER, isSigner: true, isWritable: true },
    { pubkey: POOL_CONFIG, isSigner: false, isWritable: false },
    { pubkey: TOKEN_CONFIG, isSigner: false, isWritable: false },
    { pubkey: VAULT, isSigner: false, isWritable: true },
    { pubkey: RECIPIENT_TA, isSigner: false, isWritable: true },
    { pubkey: RECIPIENT_TA, isSigner: false, isWritable: true },
    { pubkey: TREE_STATE, isSigner: false, isWritable: true },
    { pubkey: VERIFIER, isSigner: false, isWritable: false },
    { pubkey: SYSVAR_INSTRUCTIONS, isSigner: false, isWritable: false },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ];
  const inlineExtras = inline
    ? [{ pubkey: B402_NULLIFIER_PROGRAM_ID, isSigner: false, isWritable: false }, ...buildLightAccounts10()]
    : [];
  return new TransactionInstruction({
    programId: B402_POOL,
    keys: [...baseKeys, ...inlineExtras],
    data: Buffer.from(buildUnshieldIxData(inline)),
  });
}

function buildAdaptIxData(inline, adapterIxDataLen, actionPayloadLen) {
  const parts = [
    fakeBytes(8),
    vecU8(fakeProof()),
    fakeBytes(32), fakeBytes(32), fakeBytes(32), fakeBytes(32), fakeBytes(32),
    u64Le(100_000n), u64Le(0n), u64Le(0n),
    fakeBytes(32), fakeBytes(32), fakeBytes(32),
    fakeBytes(32), fakeBytes(32),
    u64Le(0n),
    u32Le(0),
    new Uint8Array([0b10]), new Uint8Array([0b10]),
    fakeBytes(32),
    vecU8(fakeBytes(adapterIxDataLen)),
    vecU8(fakeBytes(actionPayloadLen)),
  ];
  if (inline) { parts.push(u32Le(1)); parts.push(vecU8(fakeBytes(134))); }
  return concat(...parts);
}

function buildAdaptIx(inline, adapterRemainingCount, adapterIxDataLen, actionPayloadLen) {
  const namedKeys = [
    { pubkey: RELAYER, isSigner: true, isWritable: true },
    { pubkey: POOL_CONFIG, isSigner: false, isWritable: false },
    { pubkey: fkey('adapter_registry'), isSigner: false, isWritable: false },
    { pubkey: fkey('token_config_in'), isSigner: false, isWritable: false },
    { pubkey: fkey('token_config_out'), isSigner: false, isWritable: false },
    { pubkey: fkey('in_vault'), isSigner: false, isWritable: true },
    { pubkey: fkey('out_vault'), isSigner: false, isWritable: true },
    { pubkey: TREE_STATE, isSigner: false, isWritable: true },
    { pubkey: ADAPT_VERIFIER, isSigner: false, isWritable: false },
    { pubkey: fkey('adapter_program'), isSigner: false, isWritable: false },
    { pubkey: fkey('adapter_authority'), isSigner: false, isWritable: false },
    { pubkey: fkey('adapter_in_ta'), isSigner: false, isWritable: true },
    { pubkey: fkey('adapter_out_ta'), isSigner: false, isWritable: true },
    { pubkey: fkey('relayer_fee_ta'), isSigner: false, isWritable: true },
    { pubkey: SYSVAR_INSTRUCTIONS, isSigner: false, isWritable: false },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ];
  const inlineExtras = inline
    ? [{ pubkey: B402_NULLIFIER_PROGRAM_ID, isSigner: false, isWritable: false }, ...buildLightAccounts10()]
    : [];
  const adapterRemaining = Array.from({ length: adapterRemainingCount }, (_, i) => ({
    pubkey: fkey(`adapter_remaining_${i}`),
    isSigner: false,
    isWritable: i % 2 === 0,
  }));
  return new TransactionInstruction({
    programId: B402_POOL,
    keys: [...namedKeys, ...inlineExtras, ...adapterRemaining],
    data: Buffer.from(buildAdaptIxData(inline, adapterIxDataLen, actionPayloadLen)),
  });
}

function measureV0(ixs) {
  const allKeys = new Set();
  for (const ix of ixs) {
    allKeys.add(ix.programId.toBase58());
    for (const k of ix.keys) allKeys.add(k.pubkey.toBase58());
  }
  const altKeys = [...allKeys]
    .filter((k) => k !== RELAYER.toBase58())
    .map((k) => new PublicKey(k));
  const alt = new AddressLookupTableAccount({
    key: fkey('alt'),
    state: {
      deactivationSlot: BigInt('18446744073709551615'),
      lastExtendedSlot: 1,
      lastExtendedSlotStartIndex: 0,
      addresses: altKeys,
    },
  });
  const msg = new TransactionMessage({
    payerKey: RELAYER,
    recentBlockhash: '11111111111111111111111111111111',
    instructions: ixs,
  }).compileToV0Message([alt]);
  return msg.serialize().length;
}

const cuIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 });

const cases = [
  { name: 'unshield',     sib: [cuIx, buildUnshieldIx(false), buildSiblingNullifierIx()],     inl: [cuIx, buildUnshieldIx(true)] },
  { name: 'swap (24 ra)', sib: [cuIx, buildAdaptIx(false, 24, 80, 8), buildSiblingNullifierIx()], inl: [cuIx, buildAdaptIx(true, 24, 80, 8)] },
  { name: 'swap (12 ra)', sib: [cuIx, buildAdaptIx(false, 12, 80, 8), buildSiblingNullifierIx()], inl: [cuIx, buildAdaptIx(true, 12, 80, 8)] },
  { name: 'lend (19 ra)', sib: [cuIx, buildAdaptIx(false, 19, 32, 16), buildSiblingNullifierIx()], inl: [cuIx, buildAdaptIx(true, 19, 32, 16)] },
];

function pad(s, n) { return s.length >= n ? s : s + ' '.repeat(n - s.length); }
function tryMeasure(ixs) {
  try { return { ok: true, n: measureV0(ixs) }; }
  catch (e) { return { ok: false, err: e.message }; }
}
console.log('\n=== Phase 7 wire-size delta (v0 + ALT, every-key-in-ALT) ===');
console.log(`${pad('flow', 14)} ${pad('sibling', 10)} ${pad('inline', 10)} ${pad('delta', 10)} cap=1232`);
for (const c of cases) {
  const sib = tryMeasure(c.sib);
  const inl = tryMeasure(c.inl);
  const sibStr = sib.ok ? String(sib.n) + ' B' : 'OVERFLOW';
  const inlStr = inl.ok ? String(inl.n) + ' B' : 'OVERFLOW';
  const deltaStr = (sib.ok && inl.ok)
    ? (inl.n - sib.n >= 0 ? '+' : '') + String(inl.n - sib.n) + ' B'
    : '?';
  const sibFit = sib.ok ? (sib.n > 1232 ? 'OVER' : 'OK') : 'OVER';
  const inlFit = inl.ok ? (inl.n > 1232 ? 'OVER' : 'OK') : 'OVER';
  console.log(
    `${pad(c.name, 14)} ${pad(sibStr, 10)} ${pad(inlStr, 10)} ${pad(deltaStr, 10)}  ${sibFit} -> ${inlFit}`,
  );
}

/**
 * Comparison artifact builders. Given parallel tx-hash arrays, the
 * JSON has the right shape and the markdown table has the right
 * number of rows + correct labels.
 */
import { describe, it, expect } from 'vitest';
import { buildArtifact, renderMarkdown, explorerLink } from '../lib/comparison.js';

const RELAYER = '7f6gRiX56dMQGrPERNBKuzFsvagFTM1U4LMAAN9rsiNM';
const USER = 'B402testUserWallet1111111111111111111111111';

describe('buildArtifact / renderMarkdown', () => {
  const pubSigs = ['pub0aaaaaaa', 'pub1bbbbbbb', 'pub2ccccccc'];
  const prvSigs = ['prv0xxxxxxx', 'prv1yyyyyyy', 'prv2zzzzzzz'];
  const cfg = {
    in_mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    out_mint: 'So11111111111111111111111111111111111111112',
    amount_units: '1000000',
    amount_ui: '1.0',
    iters: 3,
    interval_s: 90,
    cluster: 'mainnet' as const,
    timestamp_utc: '2026-05-11T00:00:00Z',
  };

  it('builds a schema-versioned artifact with both sides', () => {
    const a = buildArtifact({
      config: cfg,
      public_run: {
        wallet: USER,
        tx_hashes: pubSigs,
        explorer_links: pubSigs.map((s) => explorerLink(s, 'mainnet')),
        per_swap_ms: [3100, 3200, 3300],
      },
      private_run: {
        user_wallet: USER,
        relayer_wallet: RELAYER,
        tx_hashes: prvSigs,
        explorer_links: prvSigs.map((s) => explorerLink(s, 'mainnet')),
        per_swap_ms: [11_000, 11_500, 12_000],
        setup_tx_hashes: ['shieldsig1'],
        setup_explorer_links: [explorerLink('shieldsig1', 'mainnet')],
      },
    });
    expect(a.schema_version).toBe('1');
    expect(a.public_run.tx_hashes).toEqual(pubSigs);
    expect(a.private_run.tx_hashes).toEqual(prvSigs);
    expect(a.private_run.relayer_wallet).toBe(RELAYER);
    expect(a.private_run.user_wallet).toBe(USER);
    expect(a.public_run.wallet).toBe(USER);
  });

  it('explorerLink omits cluster param for mainnet, includes for devnet', () => {
    expect(explorerLink('abc', 'mainnet')).toBe('https://explorer.solana.com/tx/abc');
    expect(explorerLink('abc', 'devnet')).toBe('https://explorer.solana.com/tx/abc?cluster=devnet');
  });

  it('markdown table has one data row per swap and labels the relayer correctly', () => {
    const a = buildArtifact({
      config: cfg,
      public_run: {
        wallet: USER,
        tx_hashes: pubSigs,
        explorer_links: pubSigs.map((s) => explorerLink(s, 'mainnet')),
        per_swap_ms: [],
      },
      private_run: {
        user_wallet: USER,
        relayer_wallet: RELAYER,
        tx_hashes: prvSigs,
        explorer_links: prvSigs.map((s) => explorerLink(s, 'mainnet')),
        per_swap_ms: [],
      },
    });
    const md = renderMarkdown(a);
    expect(md).toContain('# Private DCA');
    expect(md).toContain('Iterations: 3');
    // Three data rows in the swap-by-swap table.
    const dataRows = md.split('\n').filter((l) => l.startsWith('| 1 |') || l.startsWith('| 2 |') || l.startsWith('| 3 |'));
    expect(dataRows.length).toBe(3);
    // Linkage table: relayer signs every private swap; user signs every public swap.
    expect(md).toContain('(hosted relayer)');
    expect(md).toContain('(self)');
    expect(md).toContain(RELAYER);
    expect(md).toContain(USER);
  });

  it('asymmetric arrays still render — uses the longer side as row count', () => {
    const a = buildArtifact({
      config: cfg,
      public_run: {
        wallet: USER,
        tx_hashes: pubSigs.slice(0, 2),
        explorer_links: pubSigs.slice(0, 2).map((s) => explorerLink(s, 'mainnet')),
        per_swap_ms: [],
      },
      private_run: {
        user_wallet: USER,
        relayer_wallet: RELAYER,
        tx_hashes: prvSigs,
        explorer_links: prvSigs.map((s) => explorerLink(s, 'mainnet')),
        per_swap_ms: [],
      },
    });
    const md = renderMarkdown(a);
    expect(md).toContain('| 3 | - |');
  });
});

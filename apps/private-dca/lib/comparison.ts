/**
 * Build the comparison artifact: a JSON + Markdown pair from two
 * sets of tx hashes (public-baseline + private-DCA). Pure function —
 * no RPC, no SDK. The caller passes already-verified inputs.
 */
export interface RunSide {
  wallet?: string;
  /** For the private side, the wallet that paid for the deposit shield(s). */
  user_wallet?: string;
  /** For the private side, signer[0] on all DCA swap txs. */
  relayer_wallet?: string;
  tx_hashes: string[];
  explorer_links: string[];
  per_swap_ms: number[];
  /** Optional pre-step hashes: shield txs for the private run, none for the baseline. */
  setup_tx_hashes?: string[];
  setup_explorer_links?: string[];
  notes?: string[];
}

export interface ComparisonConfig {
  in_mint: string;
  out_mint: string;
  amount_units: string;
  amount_ui: string;
  iters: number;
  interval_s: number;
  cluster: 'mainnet' | 'devnet' | 'localnet';
  timestamp_utc: string;
}

export interface ComparisonArtifact {
  schema_version: '1';
  config: ComparisonConfig;
  public_run: RunSide;
  private_run: RunSide;
}

export function buildArtifact(args: {
  config: ComparisonConfig;
  public_run: RunSide;
  private_run: RunSide;
}): ComparisonArtifact {
  return { schema_version: '1', ...args };
}

export function explorerLink(sig: string, cluster: 'mainnet' | 'devnet' | 'localnet'): string {
  const param = cluster === 'mainnet' ? '' : `?cluster=${cluster}`;
  return `https://explorer.solana.com/tx/${sig}${param}`;
}

export function renderMarkdown(a: ComparisonArtifact): string {
  const { config, public_run, private_run } = a;
  const rows = Math.max(public_run.tx_hashes.length, private_run.tx_hashes.length);

  const headerBlock = [
    `# Private DCA — run ${config.timestamp_utc}`,
    '',
    `Cluster: \`${config.cluster}\`  `,
    `Pair: \`${config.in_mint}\` -> \`${config.out_mint}\`  `,
    `Amount per swap: ${config.amount_ui} (${config.amount_units} raw)  `,
    `Iterations: ${config.iters}  `,
    `Interval: ${config.interval_s}s`,
    '',
    '## Wallet linkage',
    '',
    `| | Public baseline | Private DCA |`,
    `|---|---|---|`,
    `| User wallet | \`${public_run.wallet ?? '-'}\` | \`${private_run.user_wallet ?? '-'}\` |`,
    `| signer[0] on every swap tx | \`${public_run.wallet ?? '-'}\` (self) | \`${private_run.relayer_wallet ?? '-'}\` (hosted relayer) |`,
    `| User wallet in swap tx accountKeys? | yes, all ${public_run.tx_hashes.length} | no, all ${private_run.tx_hashes.length} |`,
    '',
  ];

  const tableLines: string[] = [
    '## Swap-by-swap',
    '',
    '| # | Public baseline tx | Private DCA tx |',
    '|---|---|---|',
  ];
  for (let i = 0; i < rows; i++) {
    const pub = public_run.tx_hashes[i];
    const prv = private_run.tx_hashes[i];
    const pubCell = pub
      ? `[${pub.slice(0, 8)}...](${public_run.explorer_links[i]})`
      : '-';
    const prvCell = prv
      ? `[${prv.slice(0, 8)}...](${private_run.explorer_links[i]})`
      : '-';
    tableLines.push(`| ${i + 1} | ${pubCell} | ${prvCell} |`);
  }
  tableLines.push('');

  const setupBlock: string[] = [];
  if (private_run.setup_tx_hashes && private_run.setup_tx_hashes.length) {
    setupBlock.push('## Private-run setup');
    setupBlock.push('');
    setupBlock.push('Shield txs (one-time, link wallet -> pool for the seed amount):');
    setupBlock.push('');
    for (let i = 0; i < private_run.setup_tx_hashes.length; i++) {
      const sig = private_run.setup_tx_hashes[i];
      const link = private_run.setup_explorer_links?.[i] ?? '';
      setupBlock.push(`- \`${sig}\` -> ${link}`);
    }
    setupBlock.push('');
  }

  const notesBlock: string[] = [];
  if ((public_run.notes && public_run.notes.length) || (private_run.notes && private_run.notes.length)) {
    notesBlock.push('## Notes');
    notesBlock.push('');
    for (const n of public_run.notes ?? []) notesBlock.push(`- public: ${n}`);
    for (const n of private_run.notes ?? []) notesBlock.push(`- private: ${n}`);
    notesBlock.push('');
  }

  return [...headerBlock, ...tableLines, ...setupBlock, ...notesBlock].join('\n');
}

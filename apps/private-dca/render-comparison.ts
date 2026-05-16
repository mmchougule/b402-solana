#!/usr/bin/env tsx
/**
 * Combine a private-side JSON and a public-side JSON into the final
 * comparison artifact (JSON + Markdown). Pure file-shuffle — no RPC,
 * no SDK. Outputs to results/run-<ts>.{json,md}.
 *
 *   pnpm exec tsx render-comparison.ts \
 *     --private results/private-2026-05-11T....json \
 *     --public  results/public-2026-05-11T....json
 *
 * If --private or --public is omitted, picks the most recent file
 * of that kind from results/.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFlags } from './lib/args.js';
import { buildArtifact, renderMarkdown, type RunSide, type ComparisonConfig } from './lib/comparison.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = path.join(__dirname, 'results');

function nowIso(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function mostRecent(prefix: string): string | undefined {
  if (!fs.existsSync(RESULTS_DIR)) return undefined;
  const files = fs.readdirSync(RESULTS_DIR)
    .filter((f) => f.startsWith(prefix) && f.endsWith('.json'))
    .map((f) => path.join(RESULTS_DIR, f))
    .sort();
  return files.pop();
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  const privatePath = flags.private ?? mostRecent('private-');
  const publicPath  = flags.public  ?? mostRecent('public-');
  if (!privatePath) throw new Error('no --private file and no results/private-*.json found');
  if (!publicPath)  throw new Error('no --public file and no results/public-*.json found');

  const priv = JSON.parse(fs.readFileSync(privatePath, 'utf8')) as { config: ComparisonConfig; run: RunSide };
  const pub  = JSON.parse(fs.readFileSync(publicPath,  'utf8')) as { config: ComparisonConfig; run: RunSide };

  // Use the private side's config as canonical — same shape both sides.
  const config = priv.config;
  const artifact = buildArtifact({
    config,
    public_run: pub.run,
    private_run: priv.run,
  });

  const ts = nowIso();
  const jsonOut = path.join(RESULTS_DIR, `run-${ts}.json`);
  const mdOut   = path.join(RESULTS_DIR, `run-${ts}.md`);
  fs.writeFileSync(jsonOut, JSON.stringify(artifact, null, 2));
  fs.writeFileSync(mdOut, renderMarkdown(artifact));
  console.log(`wrote ${jsonOut}`);
  console.log(`wrote ${mdOut}`);
  console.log('');
  console.log(renderMarkdown(artifact));
}

main().then(() => process.exit(0)).catch((e) => {
  console.error('FAIL', e instanceof Error ? e.stack : e);
  process.exit(1);
});

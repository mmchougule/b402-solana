#!/usr/bin/env node
/**
 * create-b402-agent — scaffold a private-DeFi agent on Solana.
 *
 * Usage:
 *   npx @b402ai/create-agent <project-name>
 *   node dist/index.js <project-name>
 *
 * Writes a working agent template to ./<project-name> that runs shield →
 * tail_notes → unshield against b402's devnet pool. Honest about what's
 * needed: a Solana keypair, ~0.1 devnet SOL, and the prover artifacts URL
 * documented in the generated README.
 *
 * Intentionally kept small: positional arg only, no interactive prompts,
 * no flag system, no template variants. One template that works.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface Args {
  projectName: string;
}

export function parseArgs(argv: string[]): Args {
  const positional = argv.slice(2).filter((a) => !a.startsWith('-'));
  if (positional.length !== 1) {
    throw new Error('usage: create-b402-agent <project-name>');
  }
  const name = positional[0];
  if (!/^[a-z0-9][a-z0-9-]*$/u.test(name)) {
    throw new Error(`invalid project name "${name}" — use lowercase letters, digits, hyphens (must start with letter/digit)`);
  }
  return { projectName: name };
}

export function templatesRoot(): string {
  // dist/index.js → ../templates/agent
  return path.resolve(__dirname, '..', 'templates', 'agent');
}

export function copyTemplate(srcDir: string, destDir: string): { filesWritten: number } {
  if (fs.existsSync(destDir)) {
    throw new Error(`destination already exists: ${destDir}`);
  }
  fs.mkdirSync(destDir, { recursive: true });
  let count = 0;
  function walk(src: string, dest: string) {
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
      const s = path.join(src, entry.name);
      // .gitignore is checked into template as `_gitignore` to avoid
      // npm pack ignoring it; rename on copy.
      const renamedName = entry.name === '_gitignore' ? '.gitignore' : entry.name;
      const d = path.join(dest, renamedName);
      if (entry.isDirectory()) {
        fs.mkdirSync(d, { recursive: true });
        walk(s, d);
      } else {
        fs.copyFileSync(s, d);
        count += 1;
      }
    }
  }
  walk(srcDir, destDir);
  return { filesWritten: count };
}

export function rewriteProjectName(destDir: string, projectName: string): void {
  const pkgJsonPath = path.join(destDir, 'package.json');
  const raw = fs.readFileSync(pkgJsonPath, 'utf8');
  const pkg = JSON.parse(raw) as { name?: string };
  pkg.name = projectName;
  fs.writeFileSync(pkgJsonPath, JSON.stringify(pkg, null, 2) + '\n');
}

function main(): void {
  let args: Args;
  try {
    args = parseArgs(process.argv);
  } catch (e) {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  }

  const dest = path.resolve(process.cwd(), args.projectName);
  const tmpl = templatesRoot();
  if (!fs.existsSync(tmpl)) {
    process.stderr.write(`template missing at ${tmpl} — install may be corrupted\n`);
    process.exit(1);
  }

  try {
    const { filesWritten } = copyTemplate(tmpl, dest);
    rewriteProjectName(dest, args.projectName);
    process.stdout.write(`✓ scaffolded ${args.projectName} (${filesWritten} files)\n\n`);
    process.stdout.write(`Next:\n`);
    process.stdout.write(`  cd ${args.projectName}\n`);
    process.stdout.write(`  cp .env.example .env\n`);
    process.stdout.write(`  # edit .env: point B402_KEYPAIR_PATH at your Solana CLI keypair\n`);
    process.stdout.write(`  pnpm install\n`);
    process.stdout.write(`  pnpm dev\n`);
  } catch (e) {
    process.stderr.write(`failed: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  }
}

// Avoid running main during unit tests.
if (process.argv[1] === __filename || process.argv[1]?.endsWith('/dist/index.js')) {
  main();
}

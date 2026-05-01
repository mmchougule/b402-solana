/**
 * One-line installer for b402-solana MCP server.
 *
 * Adds an `b402-solana` entry to known MCP runtime config files, idempotently.
 * Only edits files that already exist (we don't create config for runtimes
 * the user hasn't installed). Runs on `--install` flag from CLI.
 *
 * Targets:
 *   - Claude Code      ~/.claude.json
 *   - Claude Desktop   ~/Library/Application Support/Claude/claude_desktop_config.json (mac)
 *                      ~/.config/Claude/claude_desktop_config.json (linux)
 *                      %APPDATA%\Claude\claude_desktop_config.json (windows)
 *   - Cursor           ~/.cursor/mcp.json
 *
 * Each runtime's config is JSON with a top-level `mcpServers` object. We
 * merge the b402-solana entry without touching other servers or unrelated
 * config keys.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SERVER_NAME = 'b402-solana';
const NPM_PACKAGE = '@b402ai/solana-mcp@latest';

interface MCPServerEntry {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

interface RuntimeTarget {
  name: string;
  configPath: string;
  /** Top-level key holding mcpServers — usually 'mcpServers' but Claude Code
   *  may have other shapes. Set when the parser locates it. */
  serversKey: 'mcpServers';
}

function expand(p: string): string {
  if (p.startsWith('~')) return path.join(os.homedir(), p.slice(1));
  return p;
}

function knownTargets(): RuntimeTarget[] {
  const home = os.homedir();
  const targets: RuntimeTarget[] = [
    {
      name: 'Claude Code',
      configPath: path.join(home, '.claude.json'),
      serversKey: 'mcpServers',
    },
    {
      name: 'Cursor',
      configPath: path.join(home, '.cursor', 'mcp.json'),
      serversKey: 'mcpServers',
    },
  ];

  // Claude Desktop, OS-specific
  if (process.platform === 'darwin') {
    targets.push({
      name: 'Claude Desktop',
      configPath: path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'),
      serversKey: 'mcpServers',
    });
  } else if (process.platform === 'win32') {
    const appdata = process.env.APPDATA;
    if (appdata) {
      targets.push({
        name: 'Claude Desktop',
        configPath: path.join(appdata, 'Claude', 'claude_desktop_config.json'),
        serversKey: 'mcpServers',
      });
    }
  } else {
    targets.push({
      name: 'Claude Desktop',
      configPath: path.join(home, '.config', 'Claude', 'claude_desktop_config.json'),
      serversKey: 'mcpServers',
    });
  }

  return targets;
}

function buildEntry(): MCPServerEntry {
  const env: Record<string, string> = {};
  // Pass through any B402_* env vars the user already has set, so installs
  // from a configured shell carry over (e.g. their Helius RPC).
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith('B402_') && typeof v === 'string' && v.length > 0) {
      env[k] = v;
    }
  }

  const entry: MCPServerEntry = {
    command: 'npx',
    args: ['-y', NPM_PACKAGE],
  };
  if (Object.keys(env).length > 0) {
    entry.env = env;
  }
  return entry;
}

interface InstallResult {
  target: string;
  configPath: string;
  status: 'installed' | 'updated' | 'unchanged' | 'skipped' | 'error';
  message?: string;
}

function installInto(target: RuntimeTarget, entry: MCPServerEntry, force: boolean): InstallResult {
  if (!fs.existsSync(target.configPath)) {
    return {
      target: target.name,
      configPath: target.configPath,
      status: 'skipped',
      message: 'config file not found (runtime probably not installed)',
    };
  }

  let raw: string;
  try {
    raw = fs.readFileSync(target.configPath, 'utf8');
  } catch (err) {
    return {
      target: target.name,
      configPath: target.configPath,
      status: 'error',
      message: `read failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  let config: Record<string, unknown>;
  try {
    config = raw.trim().length === 0 ? {} : JSON.parse(raw);
  } catch (err) {
    return {
      target: target.name,
      configPath: target.configPath,
      status: 'error',
      message: `not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const servers = (config[target.serversKey] as Record<string, MCPServerEntry> | undefined) ?? {};
  const existing = servers[SERVER_NAME];

  if (existing && !force) {
    // Compare for idempotence — if identical, no-op; if different, require --force.
    const same =
      existing.command === entry.command &&
      JSON.stringify(existing.args) === JSON.stringify(entry.args) &&
      JSON.stringify(existing.env ?? {}) === JSON.stringify(entry.env ?? {});
    if (same) {
      return { target: target.name, configPath: target.configPath, status: 'unchanged' };
    }
    return {
      target: target.name,
      configPath: target.configPath,
      status: 'skipped',
      message: 'entry already exists with different config; pass --force to overwrite',
    };
  }

  servers[SERVER_NAME] = entry;
  config[target.serversKey] = servers;

  // Backup the existing file once before writing.
  const backupPath = `${target.configPath}.b402-bak`;
  if (!fs.existsSync(backupPath)) {
    try {
      fs.copyFileSync(target.configPath, backupPath);
    } catch {
      // non-fatal; we'll still attempt the write
    }
  }

  try {
    // Preserve trailing newline if original had one.
    const trailingNl = raw.endsWith('\n') ? '\n' : '';
    fs.writeFileSync(target.configPath, JSON.stringify(config, null, 2) + trailingNl);
  } catch (err) {
    return {
      target: target.name,
      configPath: target.configPath,
      status: 'error',
      message: `write failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  return {
    target: target.name,
    configPath: target.configPath,
    status: existing ? 'updated' : 'installed',
  };
}

interface InstallOptions {
  force?: boolean;
  /** Restrict to a single target by name (case-insensitive). */
  only?: string;
}

export function runInstall(opts: InstallOptions = {}): void {
  const targets = knownTargets();
  const entry = buildEntry();

  const filtered = opts.only
    ? targets.filter((t) =>
        t.name.toLowerCase().includes(opts.only!.toLowerCase()) ||
        t.name.toLowerCase().replace(/\s+/g, '').includes(opts.only!.toLowerCase()),
      )
    : targets;

  if (filtered.length === 0) {
    console.error(`no target matched "${opts.only}". known: ${targets.map((t) => t.name).join(', ')}`);
    process.exit(1);
  }

  const results: InstallResult[] = filtered.map((t) => installInto(t, entry, opts.force ?? false));

  console.log('b402-solana MCP installer\n');
  for (const r of results) {
    const icon =
      r.status === 'installed' ? '+' :
      r.status === 'updated'   ? '~' :
      r.status === 'unchanged' ? '=' :
      r.status === 'skipped'   ? '·' : '!';
    const label = r.status.padEnd(9);
    console.log(`  [${icon}] ${label} ${r.target}`);
    console.log(`        ${r.configPath}`);
    if (r.message) console.log(`        ${r.message}`);
  }

  const installed = results.filter((r) => r.status === 'installed' || r.status === 'updated');
  const errored = results.filter((r) => r.status === 'error');

  console.log('');
  if (installed.length > 0) {
    console.log(`installed b402-solana into ${installed.length} runtime(s).`);
    console.log('restart the runtime to pick up the new server.');
    console.log('');
    console.log('next: run `status` from your AI assistant — it will return your wallet pubkey + private balances.');
    console.log('docs: https://github.com/mmchougule/b402-solana');
  } else if (errored.length === 0) {
    console.log('nothing to do.');
  }

  if (errored.length > 0) {
    process.exit(1);
  }
}

/** Parse argv after the binary path/script. Returns null if --install not present. */
export function parseInstallArgs(argv: string[]): InstallOptions | null {
  if (!argv.includes('--install')) return null;
  const opts: InstallOptions = {};
  if (argv.includes('--force')) opts.force = true;
  const onlyIdx = argv.indexOf('--only');
  if (onlyIdx >= 0 && argv[onlyIdx + 1]) opts.only = argv[onlyIdx + 1];
  return opts;
}

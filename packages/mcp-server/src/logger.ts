/**
 * File logger for the MCP server.
 *
 * - Default path: ~/.config/b402-solana/logs/mcp-YYYYMMDD.log
 * - Date-stamped filename gives natural daily rotation.
 * - Async append; no blocking on stdout/stderr (which is the MCP transport).
 * - Auto-cleanup: deletes logs older than 7 days on boot.
 * - Override path with B402_LOG_FILE; set to '' to disable.
 *
 * What gets logged:
 *   - Boot: cluster, relayer URL, wallet pubkey
 *   - Tool calls: name, duration_ms, ok|err, error message on failure
 *   - NOT logged: keypair paths, recipient addresses, raw mint addresses,
 *     ciphertext, signatures (signatures are public, but we treat the
 *     correlation between signature + tool call as private metadata).
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export interface Logger {
  info(event: string, data?: Record<string, unknown>): void;
  warn(event: string, data?: Record<string, unknown>): void;
  error(event: string, data?: Record<string, unknown>): void;
  close(): void;
}

const NOOP_LOGGER: Logger = {
  info() {}, warn() {}, error() {}, close() {},
};

/** Resolve the log file path (or null if disabled). */
function resolveLogPath(): string | null {
  const env = process.env.B402_LOG_FILE;
  if (env === '') return null;       // explicit disable
  if (env) return path.resolve(env); // explicit override
  const ts = new Date().toISOString().slice(0, 10).replace(/-/g, ''); // YYYYMMDD
  return path.join(os.homedir(), '.config', 'b402-solana', 'logs', `mcp-${ts}.log`);
}

/** Best-effort cleanup of old logs in the same dir. */
function cleanupOldLogs(dir: string, keepDays = 7): void {
  try {
    if (!fs.existsSync(dir)) return;
    const cutoff = Date.now() - keepDays * 86_400_000;
    for (const name of fs.readdirSync(dir)) {
      if (!/^mcp-\d{8}\.log$/.test(name)) continue;
      const p = path.join(dir, name);
      const stat = fs.statSync(p);
      if (stat.mtimeMs < cutoff) fs.unlinkSync(p);
    }
  } catch {
    // best-effort
  }
}

export function createLogger(): Logger {
  const logPath = resolveLogPath();
  if (!logPath) return NOOP_LOGGER;

  let stream: fs.WriteStream;
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    cleanupOldLogs(path.dirname(logPath));
    stream = fs.createWriteStream(logPath, { flags: 'a' });
    stream.on('error', () => {
      // file logging is best-effort; don't crash the MCP if disk fills.
    });
  } catch {
    return NOOP_LOGGER;
  }

  function write(level: 'info' | 'warn' | 'error', event: string, data?: Record<string, unknown>): void {
    try {
      const line = JSON.stringify({
        t: new Date().toISOString(),
        level,
        event,
        ...(data ?? {}),
      });
      stream.write(line + '\n');
    } catch {
      // ignore
    }
  }

  return {
    info: (event, data) => write('info', event, data),
    warn: (event, data) => write('warn', event, data),
    error: (event, data) => write('error', event, data),
    close: () => { try { stream.end(); } catch {} },
  };
}

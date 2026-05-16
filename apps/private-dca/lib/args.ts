/**
 * Tiny CLI flag parser. No external deps — argparse / commander
 * would be more lines than the logic itself. Supports --flag value
 * and --flag=value.
 */
export function parseFlags(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq >= 0) {
      out[a.slice(2, eq)] = a.slice(eq + 1);
    } else {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        out[a.slice(2)] = '1';
      } else {
        out[a.slice(2)] = next;
        i++;
      }
    }
  }
  return out;
}

export function intFlag(flags: Record<string, string>, key: string, fallback: number): number {
  const v = flags[key];
  if (v === undefined) return fallback;
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) throw new Error(`--${key} must be an integer, got ${v}`);
  return n;
}

export function floatFlag(flags: Record<string, string>, key: string, fallback: number): number {
  const v = flags[key];
  if (v === undefined) return fallback;
  const n = Number.parseFloat(v);
  if (!Number.isFinite(n)) throw new Error(`--${key} must be a number, got ${v}`);
  return n;
}

export function strFlag(flags: Record<string, string>, key: string, fallback: string): string {
  return flags[key] ?? fallback;
}

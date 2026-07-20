/**
 * Tiny CLI argument parser — no external dependency.
 *
 * Convention:
 *   - positional arguments come first (before any --flag)
 *   - flags are `--name value` or `--name=value` or `--bool` (true)
 *   - shorthand single-char flags supported (`-j` = `--json`)
 *   - `--` ends flag parsing ; remainder is positional
 *
 * Numeric flag values are auto-converted when the consumer asks via
 * `parsed.number("name")`. Otherwise the value is a string.
 */

export interface ParsedArgs {
  positional: string[];
  flags: Record<string, string | true>;
  /** All raw argv after the command name (useful for sub-commands). */
  raw: string[];

  // Helpers
  flag(name: string, shortName?: string): string | true | undefined;
  string(name: string, shortName?: string): string | undefined;
  bool(name: string, shortName?: string): boolean;
  number(name: string, shortName?: string): number | undefined;
  assertKnown(allowed: readonly string[]): void;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  const raw = [...argv];

  let i = 0;
  let endFlags = false;
  while (i < argv.length) {
    const a = argv[i] as string;
    if (!endFlags && a === "--") {
      endFlags = true;
      i++;
      continue;
    }
    if (!endFlags && a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq >= 0) {
        const k = a.slice(2, eq);
        const v = a.slice(eq + 1);
        flags[k] = v;
        i++;
        continue;
      }
      const k = a.slice(2);
      const next = i + 1 < argv.length ? (argv[i + 1] as string) : undefined;
      if (next != null && (!next.startsWith("-") || /^-\d/.test(next))) {
        flags[k] = next;
        i += 2;
      } else {
        flags[k] = true;
        i++;
      }
      continue;
    }
    if (!endFlags && a.startsWith("-") && a.length > 1) {
      // single-char flag(s) ; for v0.1 we treat them like long ones
      const k = a.slice(1);
      const next = i + 1 < argv.length ? (argv[i + 1] as string) : undefined;
      if (next != null && (!next.startsWith("-") || /^-\d/.test(next))) {
        flags[k] = next;
        i += 2;
      } else {
        flags[k] = true;
        i++;
      }
      continue;
    }
    positional.push(a);
    i++;
  }

  return {
    positional,
    flags,
    raw,
    flag(name: string, shortName?: string): string | true | undefined {
      if (name in flags) return flags[name];
      if (shortName && shortName in flags) return flags[shortName];
      return undefined;
    },
    string(name: string, shortName?: string): string | undefined {
      const v = this.flag(name, shortName);
      if (v === undefined) return undefined;
      if (v === true) throw new Error(`Missing value for --${name}`);
      return v;
    },
    bool(name: string, shortName?: string): boolean {
      const v = this.flag(name, shortName);
      if (v === undefined || v === "false") return false;
      if (v === true || v === "true") return true;
      throw new Error(`Invalid boolean for --${name}: "${v}"`);
    },
    number(name: string, shortName?: string): number | undefined {
      const v = this.string(name, shortName);
      if (v === undefined) return undefined;
      const n = Number(v);
      if (!Number.isFinite(n)) throw new Error(`Invalid number for --${name}: "${v}"`);
      return n;
    },
    assertKnown(allowed: readonly string[]): void {
      const known = new Set(allowed);
      const unknown = Object.keys(flags).filter((name) => !known.has(name));
      if (unknown.length > 0) {
        throw new Error(`Unknown flag${unknown.length > 1 ? "s" : ""}: ${unknown.map((name) => `--${name}`).join(", ")}`);
      }
    },
  };
}

/**
 * Parse a string into unix-ms timestamp.
 * Accepts ISO 8601 ("2026-06-02T19:00:00Z") or unix-ms ("1717000000000").
 */
export function parseDateArg(value: string): number {
  // Pure digits → unix-ms
  if (/^\d+$/.test(value)) {
    return Number.parseInt(value, 10);
  }
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`Invalid date: ${value} (expected ISO 8601 or unix-ms)`);
  }
  return d.getTime();
}

/**
 * Parse a flag value as one of a known enum set, or `undefined` if unset.
 * Throws when the value is set but not in the enum.
 *
 * Why this helper: status flags (--status open|in_progress|...) appear in
 * multiple commands and were previously cast `as any` after `args.string()`.
 * This restores type-safety end-to-end.
 */
export function enumArg<T extends string>(
  raw: string | undefined,
  allowed: readonly T[],
  flagName: string,
): T | undefined {
  if (raw === undefined) return undefined;
  if ((allowed as readonly string[]).includes(raw)) return raw as T;
  throw new Error(
    `Invalid value for --${flagName}: "${raw}". Allowed: ${allowed.join(", ")}`,
  );
}

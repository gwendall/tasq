/**
 * CLI configuration — `~/.tasq/config.json`.
 *
 * Minimal in v0.1. Projection is opt-in; universal setup never infers a
 * profile from a repository name or HOME layout.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import { CoordinationSpaceId } from "@tasq-run/schema";

export interface TasqConfig {
  /** Path to the LibSQL database file. */
  dbPath: string;
  /** Optional path where TASKS.md projection is written on each mutation. */
  projectionTarget?: string;
  /** Default tenant_id for new entities. */
  tenantId: string;
  /** Default actor (used when no --actor flag is passed). */
  defaultActor: string;
  /** Private, machine-local directory bindings written by `tasq use`. */
  directorySpaces?: Record<string, string>;
  /**
   * Path to the append-only JSONL event journal — every emitted audit event
   * appends one line. Defaults to `~/.tasq/events.jsonl`. It provides
   * off-database forensic parity evidence, not replay-complete recovery. Set
   * to empty string to disable.
   */
  eventJournalPath: string;
}

/**
 * Statically-typed set of mutable string keys.
 * Used by `config get`/`config set` to read/write typed fields without resorting to
 * Record<string, unknown> casting. Structured fields such as directorySpaces
 * are intentionally not mutable through the generic string setter.
 */
export const CONFIG_KEYS = [
  "dbPath",
  "projectionTarget",
  "tenantId",
  "defaultActor",
  "eventJournalPath",
] as const;
export const CONFIG_OUTPUT_KEYS = [...CONFIG_KEYS, "directorySpaces"] as const;
export type TasqConfigKey = (typeof CONFIG_KEYS)[number];

export function isConfigKey(value: string): value is TasqConfigKey {
  return (CONFIG_KEYS as readonly string[]).includes(value);
}

export function configDir(): string {
  return process.env.TASQ_HOME || join(homedir(), ".tasq");
}

export function configPath(): string {
  return join(configDir(), "config.json");
}

export function defaultDbPath(): string {
  return join(configDir(), "db.sqlite");
}

export function defaultEventJournalPath(): string {
  return join(configDir(), "events.jsonl");
}

const DEFAULT_CONFIG: TasqConfig = {
  dbPath: defaultDbPath(),
  tenantId: "gwendall",
  defaultActor: "gwendall",
  eventJournalPath: defaultEventJournalPath(),
};

export function loadConfig(): TasqConfig {
  const path = configPath();
  if (!existsSync(path)) {
    return { ...DEFAULT_CONFIG };
  }
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed: Partial<TasqConfig> = JSON.parse(raw);
    const merged = { ...DEFAULT_CONFIG, ...parsed };
    for (const key of ["dbPath", "tenantId", "defaultActor", "eventJournalPath"] as const) {
      if (typeof merged[key] !== "string" || merged[key].length === 0) {
        throw new Error(`${key} must be a non-empty string`);
      }
    }
    if (merged.projectionTarget !== undefined && typeof merged.projectionTarget !== "string") {
      throw new Error("projectionTarget must be a string when set");
    }
    if (merged.directorySpaces !== undefined) {
      if (
        merged.directorySpaces === null
        || typeof merged.directorySpaces !== "object"
        || Array.isArray(merged.directorySpaces)
      ) {
        throw new Error("directorySpaces must be an object when set");
      }
      const entries = Object.entries(merged.directorySpaces);
      if (entries.length > 1_000) throw new Error("directorySpaces cannot contain more than 1000 bindings");
      for (const [directory, space] of entries) {
        if (!isAbsolute(directory) || resolve(directory) !== directory) {
          throw new Error(`directorySpaces key must be a normalized absolute path: ${directory}`);
        }
        CoordinationSpaceId.parse(space);
      }
    }
    return merged;
  } catch (e) {
    throw new Error(`Config error in ${path}: ${(e as Error).message}`);
  }
}

export interface EffectiveSpace {
  space: string;
  source: "explicit_flag" | "environment" | "directory" | "global_default";
  directory: string | null;
}

/** Canonicalize a live directory so symlink spellings cannot create two scopes. */
export function canonicalDirectory(directory: string = process.cwd()): string {
  return realpathSync(resolve(directory));
}

/** Return the closest directory binding, inheriting from parent directories. */
export function resolveDirectorySpace(
  config: TasqConfig,
  directory: string = process.cwd(),
): { space: string; directory: string } | null {
  const bindings = config.directorySpaces ?? {};
  let cursor = canonicalDirectory(directory);
  while (true) {
    const space = bindings[cursor];
    if (space !== undefined) return { space, directory: cursor };
    const parent = dirname(cursor);
    if (parent === cursor) return null;
    cursor = parent;
  }
}

/** Resolve workspace selection without mutating the operator's global default. */
export function resolveEffectiveSpace(input: {
  config: TasqConfig;
  explicit?: string;
  environment?: string;
  directory?: string;
}): EffectiveSpace {
  if (input.explicit !== undefined) {
    return { space: input.explicit, source: "explicit_flag", directory: null };
  }
  if (input.environment) {
    return { space: input.environment, source: "environment", directory: null };
  }
  const selected = resolveDirectorySpace(input.config, input.directory);
  if (selected) return { ...selected, source: "directory" };
  return { space: input.config.tenantId, source: "global_default", directory: null };
}

/** Set or clear only the exact current-directory binding. */
export function bindDirectorySpace(
  config: TasqConfig,
  directory: string,
  space: string | null,
): { config: TasqConfig; directory: string; changed: boolean } {
  const canonical = canonicalDirectory(directory);
  const current = config.directorySpaces ?? {};
  const next = { ...current };
  const before = next[canonical];
  if (space === null) delete next[canonical];
  else next[canonical] = CoordinationSpaceId.parse(space);
  const changed = before !== next[canonical];
  return {
    config: {
      ...config,
      directorySpaces: Object.keys(next).length > 0 ? next : undefined,
    },
    directory: canonical,
    changed,
  };
}

export function saveConfig(cfg: TasqConfig): void {
  const path = configPath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  chmodSync(dirname(path), 0o700);
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(cfg, null, 2) + "\n", { encoding: "utf-8", mode: 0o600 });
  renameSync(temporary, path);
  chmodSync(path, 0o600);
}

/** Read a single typed config field by name. Returns undefined if unset. */
export function getConfigField(cfg: TasqConfig, key: TasqConfigKey): string | undefined {
  // All TasqConfig fields are string-typed today ; this stays type-safe.
  const v = cfg[key];
  return v === undefined ? undefined : String(v);
}

/** Set a single typed config field. */
export function setConfigField(cfg: TasqConfig, key: TasqConfigKey, value: string): TasqConfig {
  return { ...cfg, [key]: value };
}

export function configUrl(cfg: TasqConfig): string {
  // libsql expects file:<path>
  return `file:${cfg.dbPath}`;
}

export function ensureDbDir(cfg: TasqConfig): void {
  mkdirSync(dirname(cfg.dbPath), { recursive: true, mode: 0o700 });
}

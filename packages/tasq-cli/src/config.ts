/**
 * CLI configuration — `~/.tasq/config.json`.
 *
 * Minimal in v0.1. Projection is opt-in; universal setup never infers a
 * profile from a repository name or HOME layout.
 */

import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { CoordinationSpaceId, systemClock, type Clock } from "@tasq-run/schema";

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
  let config: TasqConfig;
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
    config = merged;
  } catch (e) {
    throw new Error(`Config error in ${path}: ${(e as Error).message}`);
  }
  assertStoreInsideHome(path, config);
  return config;
}

/** True when `candidate` is `root` itself or lives under it, following symlinks. */
function isInside(root: string, candidate: string): boolean {
  const real = (value: string): string => {
    try {
      return realpathSync(value);
    } catch {
      // The path may not exist yet (a store about to be created). Resolve the
      // nearest existing ancestor so /tmp vs /private/tmp still compares equal.
      const parent = dirname(value);
      return parent === value ? value : join(real(parent), value.slice(parent.length + 1));
    }
  };
  const base = real(root);
  const target = real(candidate);
  return target === base || target.startsWith(base.endsWith(sep) ? base : base + sep);
}

/**
 * Refuse a config whose store lives outside the TASQ_HOME it was loaded from.
 *
 * Copying a Tasq home to another directory carries absolute `dbPath` and
 * `eventJournalPath` along with it, so `TASQ_HOME=<copy> tasq <anything>` reads
 * the copy's config and then operates on the ORIGINAL store. Rehearsing a
 * migration on a copy - the responsible thing to do, and what an agent does
 * unprompted - destroys the original instead. That happened to this project's
 * own ledger on 2026-08-26: a dev build migrated the live store to a format the
 * installed binary could no longer read.
 *
 * Refuse rather than silently rebasing the paths onto TASQ_HOME: relocating
 * someone's store without asking is its own footgun, and a deliberate
 * split-layout is a real, if rare, configuration.
 */
function assertStoreInsideHome(configFile: string, config: TasqConfig): void {
  const home = process.env.TASQ_HOME;
  if (!home) return;
  if (process.env.TASQ_ALLOW_EXTERNAL_STORE === "1") return;

  const outside: string[] = [];
  for (const key of ["dbPath", "eventJournalPath"] as const) {
    const value = config[key];
    // An empty journal path disables the journal; a relative path already
    // resolves under the home, so neither can escape it.
    if (!value || !isAbsolute(value)) continue;
    if (!isInside(home, value)) outside.push(`  ${key} = ${value}`);
  }
  if (outside.length === 0) return;

  throw new Error(
    `TASQ_HOME is ${home}, but ${configFile} points at a store outside it:\n`
    + `${outside.join("\n")}\n`
    + "Refusing, because commands would read this config and then write that other store - "
    + "which is how copying a Tasq home to rehearse on it destroys the original instead.\n"
    + "Either point those paths inside TASQ_HOME, or set TASQ_ALLOW_EXTERNAL_STORE=1 if the "
    + "split layout is deliberate.",
  );
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

/**
 * Refuse to fall back on the global default when that space is explicitly bound
 * to a different project.
 *
 * Space resolution ends at `config.tenantId`. `tasq setup` sets it. So opening
 * ANY directory that was never bound and running a command reaches that space -
 * and on 2026-08-27, walking the newcomer journey, a second git repository with
 * no Tasq configuration at all listed the first project's tasks and would have
 * written to them. Every command succeeded and nothing warned.
 *
 * The precise signal is not "this looks like a project". It is: someone ran
 * `tasq use` and bound this space to a directory tree, and we are not inside
 * it. That means the space belongs to a project, and this is not that project.
 * A user who has only ever had one space is never affected.
 */
export function inheritedSpaceOwnedElsewhere(
  config: TasqConfig,
  space: string,
  directory: string,
): string[] {
  const bindings = config.directorySpaces ?? {};
  const here = canonicalDirectory(directory);
  const owners: string[] = [];
  for (const [boundDirectory, boundSpace] of Object.entries(bindings)) {
    if (boundSpace !== space) continue;
    // Inside the bound tree the binding would have won resolution, so reaching
    // here at all means we are outside every tree bound to this space.
    if (here === boundDirectory || here.startsWith(`${boundDirectory}/`)) return [];
    owners.push(boundDirectory);
  }
  return owners.sort();
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

export interface SaveConfigOptions {
  /**
   * The command that caused this write, as names only (command, subcommand,
   * flag names), never values. Recorded in the config journal.
   */
  command?: readonly string[];
  /**
   * Directories whose binding this write deliberately removes. Every other
   * binding present on disk survives the write, whatever the caller's copy of
   * the config says.
   */
  unbind?: readonly string[];
  /** The clock that stamps the journal record; the system clock when absent. */
  clock?: Clock;
}

export interface SaveConfigReport {
  path: string;
  changed: boolean;
  /** Bindings found on disk but absent from the caller's copy, kept rather than dropped. */
  preservedBindings: string[];
  journaled: boolean;
}

export const CONFIG_CHANGE_CONTRACT = "tasq.config-change.v1" as const;

/** Append-only record of every change to `config.json`: who changed what, from what. */
export function configJournalPath(): string {
  return join(configDir(), "config-journal.jsonl");
}

/** The on-disk config as written, without defaults or validation. */
function readDiskConfig(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function diskBindings(disk: Record<string, unknown> | null): Record<string, string> {
  const raw = disk?.directorySpaces;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return {};
  const bindings: Record<string, string> = {};
  for (const [directory, space] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof space === "string") bindings[directory] = space;
  }
  return bindings;
}

/**
 * Persist the config without losing what another writer put on disk.
 *
 * Every caller works from its own copy of the config, loaded some time before
 * it saves. Two sessions binding two directories in turn, or one session
 * saving a copy loaded before another one wrote, used to overwrite the whole
 * file from that copy - and every binding the copy did not know about was
 * gone, silently. On 2026-09-02 this project's own checkout lost its binding
 * that way, and nothing said who had rewritten the file.
 *
 * So bindings are merged with the file as it is now, a binding only disappears
 * when the caller names the directory it unbinds, and each write appends what
 * changed to the config journal.
 */
export function saveConfig(cfg: TasqConfig, options: SaveConfigOptions = {}): SaveConfigReport {
  const path = configPath();
  const disk = readDiskConfig(path);
  const unbind = new Set(options.unbind ?? []);
  const onDisk = diskBindings(disk);
  const merged: Record<string, string> = { ...(cfg.directorySpaces ?? {}) };
  const preserved: string[] = [];
  for (const [directory, space] of Object.entries(onDisk)) {
    if (directory in merged || unbind.has(directory)) continue;
    merged[directory] = space;
    preserved.push(directory);
  }
  const next: TasqConfig = {
    ...cfg,
    directorySpaces: Object.keys(merged).length > 0 ? merged : undefined,
  };
  const changes = configChanges(disk, next);
  const bindingChanges = bindingDiff(onDisk, merged);
  const changed = disk === null
    || Object.keys(changes).length > 0
    || bindingChanges.added.length + bindingChanges.removed.length + bindingChanges.changed.length > 0;
  if (!changed) {
    return { path, changed: false, preservedBindings: preserved.sort(), journaled: false };
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  chmodSync(dirname(path), 0o700);
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(next, null, 2) + "\n", { encoding: "utf-8", mode: 0o600 });
  renameSync(temporary, path);
  chmodSync(path, 0o600);
  const journaled = appendConfigJournal({
    recordedAt: (options.clock ?? systemClock).now(),
    command: options.command ?? [],
    changes,
    bindings: { ...bindingChanges, preserved: preserved.sort() },
  });
  return { path, changed: true, preservedBindings: preserved.sort(), journaled };
}

type ConfigChanges = Record<string, { before: unknown; after: unknown }>;

function configChanges(disk: Record<string, unknown> | null, next: TasqConfig): ConfigChanges {
  const changes: ConfigChanges = {};
  for (const key of CONFIG_KEYS) {
    const before = disk?.[key];
    const after = next[key];
    if (JSON.stringify(before ?? null) !== JSON.stringify(after ?? null)) {
      changes[key] = { before: before ?? null, after: after ?? null };
    }
  }
  return changes;
}

function bindingDiff(
  before: Record<string, string>,
  after: Record<string, string>,
): { added: string[]; removed: string[]; changed: string[] } {
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];
  for (const directory of Object.keys(after)) {
    if (!(directory in before)) added.push(directory);
    else if (before[directory] !== after[directory]) changed.push(directory);
  }
  for (const directory of Object.keys(before)) {
    if (!(directory in after)) removed.push(directory);
  }
  return { added: added.sort(), removed: removed.sort(), changed: changed.sort() };
}

function appendConfigJournal(entry: {
  recordedAt: number;
  command: readonly string[];
  changes: ConfigChanges;
  bindings: { added: string[]; removed: string[]; changed: string[]; preserved: string[] };
}): boolean {
  const record = {
    contractVersion: CONFIG_CHANGE_CONTRACT,
    recordedAt: entry.recordedAt,
    pid: process.pid,
    command: [...entry.command],
    changes: entry.changes,
    bindings: entry.bindings,
  };
  try {
    const journal = configJournalPath();
    appendFileSync(journal, `${JSON.stringify(record)}\n`, { encoding: "utf-8", mode: 0o600 });
    chmodSync(journal, 0o600);
    return true;
  } catch {
    // The journal is evidence, not a lock: a config write must not fail
    // because its record could not be appended.
    return false;
  }
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

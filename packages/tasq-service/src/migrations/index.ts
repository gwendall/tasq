/**
 * Migration runner — apply SQL migrations in lexicographic order,
 * idempotently. Tracks applied migrations in `_migration` table.
 */

import { chmodSync, readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Client } from "@libsql/client";
import type { Clock } from "@tasq/schema";
import { serviceNow } from "../util/clock.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

export interface MigrationOptions {
  clock?: Clock;
  now?: number;
}

/**
 * Run all pending migrations in `./` (this directory).
 * Idempotent — already-applied migrations are skipped.
 *
 * Cross-process safe: when multiple CLI processes boot concurrently against
 * a fresh DB, each one races to apply the same migrations. Without
 * serialization the loser would either crash on a UNIQUE violation when
 * inserting into `_migration`, or apply DDL twice. We acquire SQLite's
 * writer lock via `BEGIN IMMEDIATE` for the whole pass so only one process
 * mutates schema at a time; the others wait up to `busy_timeout` (5s, set
 * in db.ts) and then re-read `_migration` inside their own transaction,
 * find everything applied, and exit cleanly.
 */
export async function runMigrations(
  client: Client,
  options: MigrationOptions = {},
): Promise<MigrationResult> {
  const now = serviceNow(options, options.now);
  // Bootstrap migrations table (idempotent under concurrent CREATE IF NOT EXISTS).
  await client.execute(`
    CREATE TABLE IF NOT EXISTS _migration (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      applied_at INTEGER NOT NULL,
      checksum TEXT
    )
  `);

  const migrationColumns = await client.execute("PRAGMA table_info('_migration')");
  if (!migrationColumns.rows.some((row) => row["name"] === "checksum")) {
    await client.execute("ALTER TABLE _migration ADD COLUMN checksum TEXT");
  }

  const files = readdirSync(__dirname)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  const definitions = new Map(
    files.map((file) => {
      const sqlText = readFileSync(join(__dirname, file), "utf-8");
      return [file, { sqlText, checksum: checksum(sqlText) }] as const;
    }),
  );

  // Fast path: read-only check first. If nothing to apply we skip the
  // writer lock entirely — critical for the steady state where every CLI
  // invocation calls runMigrations on a fully-migrated DB. Without this,
  // N concurrent invocations would all queue on BEGIN IMMEDIATE and a few
  // would surface SQLITE_BUSY_RECOVERY under contention.
  const initial = await readApplied(client);
  assertNoChecksumDrift(initial, definitions);
  if (files.every((f) => initial.get(f) === definitions.get(f)!.checksum)) {
    return { applied: [], skipped: files };
  }

  // Upgrading an existing store is the only destructive-ish schema path.
  // Capture a self-contained SQLite snapshot before taking the migration lock.
  if (initial.size > 0) await backupBeforeMigration(client, now);

  const result: MigrationResult = { applied: [], skipped: [] };

  // Slow path: at least one migration to apply. Acquire SQLite's writer
  // lock so concurrent processes don't double-apply or collide on the
  // UNIQUE(name) constraint in `_migration`. busy_timeout (5s, set in
  // db.ts) gives the losers room to wait; once they get the lock they
  // re-read `_migration` and find everything already applied.
  await client.execute("BEGIN IMMEDIATE");
  try {
    const applied = await readApplied(client);

    for (const file of files) {
      const definition = definitions.get(file)!;
      const recordedChecksum = applied.get(file);
      if (recordedChecksum === definition.checksum) {
        result.skipped.push(file);
        continue;
      }
      if (applied.has(file) && recordedChecksum == null) {
        await client.execute({
          sql: "UPDATE _migration SET checksum = ? WHERE name = ?",
          args: [definition.checksum, file],
        });
        result.skipped.push(file);
        continue;
      }
      const statements = splitSql(definition.sqlText);
      for (const stmt of statements) {
        if (stmt.trim().length === 0) continue;
        await client.execute(stmt);
      }
      await client.execute({
        sql: "INSERT INTO _migration (name, applied_at, checksum) VALUES (?, ?, ?)",
        args: [file, now, definition.checksum],
      });
      result.applied.push(file);
    }

    await client.execute("COMMIT");
  } catch (e) {
    await client.execute("ROLLBACK");
    throw e;
  }

  return result;
}

async function backupBeforeMigration(client: Client, now: number): Promise<void> {
  const databases = await client.execute("PRAGMA database_list");
  const main = databases.rows.find((row) => row["name"] === "main");
  const file = typeof main?.["file"] === "string" ? main["file"] : "";
  if (!file || file === ":memory:") return;
  const target = `${file}.pre-migrate-${now}.bak`;
  await client.execute({ sql: "VACUUM INTO ?", args: [target] });
  chmodSync(target, 0o600);
}

async function readApplied(client: Client): Promise<Map<string, string | null>> {
  const rows = await client.execute("SELECT name, checksum FROM _migration");
  const out = new Map<string, string | null>();
  for (const r of rows.rows) {
    out.set(r["name"] as string, (r["checksum"] as string | null) ?? null);
  }
  return out;
}

function checksum(sqlText: string): string {
  return createHash("sha256").update(sqlText).digest("hex");
}

function assertNoChecksumDrift(
  applied: Map<string, string | null>,
  definitions: Map<string, { sqlText: string; checksum: string }>,
): void {
  for (const [name, recorded] of applied) {
    const current = definitions.get(name);
    if (!current) {
      throw new Error(`Applied migration is missing from the codebase: ${name}`);
    }
    if (recorded != null && current && recorded !== current.checksum) {
      throw new Error(
        `Migration checksum mismatch for ${name}; applied migrations are immutable`,
      );
    }
  }
}

/**
 * Split a SQL file into statements on top-level `;`. Trigger bodies contain
 * their own semicolons, so a CREATE TRIGGER statement stays buffered until
 * its final `END;`. Strips line comments (-- ...) but preserves block comments
 * inside statements.
 */
function splitSql(text: string): string[] {
  const out: string[] = [];
  let buf = "";
  let inLineComment = false;
  let inSingleQuote = false;
  let inDoubleQuote = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    const next = (i + 1 < text.length ? text[i + 1] : "") as string;

    if (inLineComment) {
      if (ch === "\n") {
        inLineComment = false;
        buf += "\n";
      }
      continue;
    }

    if (!inSingleQuote && !inDoubleQuote && ch === "-" && next === "-") {
      inLineComment = true;
      i++; // skip second dash
      continue;
    }

    if (!inDoubleQuote && ch === "'") {
      inSingleQuote = !inSingleQuote;
      buf += ch;
      continue;
    }
    if (!inSingleQuote && ch === '"') {
      inDoubleQuote = !inDoubleQuote;
      buf += ch;
      continue;
    }

    if (!inSingleQuote && !inDoubleQuote && ch === ";") {
      const candidate = buf.trim();
      const isTrigger = /^CREATE\s+(?:TEMP(?:ORARY)?\s+)?TRIGGER\b/i.test(candidate);
      if (isTrigger && !/\bEND\s*$/i.test(candidate)) {
        buf += ch;
        continue;
      }
      out.push(buf.trim());
      buf = "";
      continue;
    }

    buf += ch;
  }

  if (buf.trim().length > 0) out.push(buf.trim());
  return out;
}

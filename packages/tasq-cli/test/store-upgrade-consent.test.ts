/**
 * Two guarantees, both learned from one incident on 2026-08-26:
 *
 *   1. a diagnosis never mutates the thing it diagnoses;
 *   2. an executable that is not a published release never irreversibly
 *      upgrades a store the operator did not offer up for it.
 *
 * `openRuntime` migrates on open, so before these guards `tasq doctor` against
 * this project's own live ledger moved it from store format 32 to 33 and the
 * installed published binary then refused it.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, runMigrations, inspectStoreFormat } from "@tasq-internal/local-service";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

async function storeAtCurrentFormat(): Promise<{ dir: string; dbPath: string }> {
  const dir = mkdtempSync(join(tmpdir(), "tasq-consent-"));
  dirs.push(dir);
  const dbPath = join(dir, "db.sqlite");
  const handle = await openDb({ url: `file:${dbPath}`, wal: false });
  await runMigrations(handle.client);
  await handle.close();
  writeFileSync(join(dir, "config.json"), JSON.stringify({
    dbPath,
    eventJournalPath: join(dir, "events.jsonl"),
    tenantId: "gwendall",
    defaultActor: "gwendall",
  }, null, 2), "utf8");
  return { dir, dbPath };
}

describe("reading a store without migrating it", () => {
  test("reports an up-to-date store as needing no upgrade", async () => {
    const { dbPath } = await storeAtCurrentFormat();
    const handle = await openDb({ url: `file:${dbPath}`, wal: false });
    try {
      const inspection = await inspectStoreFormat(handle.client);
      expect(inspection.existingStore).toBe(true);
      expect(inspection.requiresIrreversibleUpgrade).toBe(false);
      expect(inspection.pending).toEqual([]);
      expect(inspection.format).toBe(inspection.current);
      expect(inspection.readableByThisExecutable).toBe(true);
    } finally {
      await handle.close();
    }
  });

  test("reports a store that does not exist yet without creating one", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tasq-absent-"));
    dirs.push(dir);
    const handle = await openDb({ url: `file:${join(dir, "db.sqlite")}`, wal: false });
    try {
      const inspection = await inspectStoreFormat(handle.client);
      expect(inspection.existingStore).toBe(false);
      expect(inspection.format).toBeNull();
      // A store that does not exist cannot be damaged by creating it, so this
      // must NOT read as a pending irreversible upgrade or every fresh
      // `tasq init` would be refused.
      expect(inspection.requiresIrreversibleUpgrade).toBe(false);
    } finally {
      await handle.close();
    }
  });

  test("inspecting leaves the applied migration history untouched", async () => {
    const { dbPath } = await storeAtCurrentFormat();
    const before = await appliedNames(dbPath);
    const handle = await openDb({ url: `file:${dbPath}`, wal: false });
    try {
      await inspectStoreFormat(handle.client);
    } finally {
      await handle.close();
    }
    expect(await appliedNames(dbPath)).toEqual(before);
  });
});

async function appliedNames(dbPath: string): Promise<string[]> {
  const handle = await openDb({ url: `file:${dbPath}`, wal: false });
  try {
    const rows = await handle.client.execute("SELECT name FROM _migration ORDER BY name");
    return rows.rows.map((row) => String(row["name"]));
  } finally {
    await handle.close();
  }
}

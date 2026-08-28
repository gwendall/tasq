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
import {
  STORE_FORMAT_COMPATIBILITY,
  openDb,
  runMigrations,
  inspectStoreFormat,
} from "@tasq-internal/local-service";

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

describe("crossing a store format is a decision", () => {
  test("refuses an ordinary command and names the deliberate verb", async () => {
    const { dir } = await storeOneFormatBehind();
    const result = await runCli(dir, ["list", "--limit", "1"]);

    expect(result.code).not.toBe(0);
    // The refusal has to carry the reason a SHARED ledger cares about, not just
    // the fact of a version gap.
    expect(result.stderr).toMatch(/irreversible upgrade/);
    expect(result.stderr).toMatch(/another machine, another agent/);
    expect(result.stderr).toMatch(/tasq store upgrade/);
  });

  test("upgrades on the deliberate verb, and reports how to roll back", async () => {
    const { dir } = await storeOneFormatBehind();

    const upgrade = await runCli(dir, ["store", "upgrade", "--json"]);
    expect(upgrade.code, upgrade.stderr).toBe(0);
    const outcome = JSON.parse(upgrade.stdout);
    expect(outcome.upgraded).toBe(true);
    expect(outcome.formatBefore).toBe(STORE_FORMAT_COMPATIBILITY.current - 1);
    expect(outcome.formatAfter).toBe(STORE_FORMAT_COMPATIBILITY.current);
    expect(outcome.recoveryPointId).toBeTruthy();

    // The gate steps aside only for the command that expresses the decision.
    const after = await runCli(dir, ["list", "--limit", "1"]);
    expect(after.code, after.stderr).toBe(0);
  });

  test("is a no-op on a store that is already current", async () => {
    const { dir } = await storeOneFormatBehind();
    expect((await runCli(dir, ["store", "upgrade"])).code).toBe(0);

    const again = await runCli(dir, ["store", "upgrade", "--json"]);
    expect(again.code, again.stderr).toBe(0);
    expect(JSON.parse(again.stdout).upgraded).toBe(false);
  });

  test("restores the gate after a rollback", async () => {
    const { dir } = await storeOneFormatBehind();
    expect((await runCli(dir, ["store", "upgrade"])).code).toBe(0);

    const points = JSON.parse((await runCli(dir, ["store", "recovery-points", "--json"])).stdout);
    const restore = await runCli(dir, ["store", "restore", points.recoveryPoints[0].id]);
    expect(restore.code, restore.stderr).toBe(0);

    const blocked = await runCli(dir, ["list", "--limit", "1"]);
    expect(blocked.code).not.toBe(0);
    expect(blocked.stderr).toMatch(/tasq store upgrade/);
  });
});

const CLI_ENTRY = join(import.meta.dir, "..", "src", "index.ts");

async function runCli(home: string, argv: string[]) {
  const proc = Bun.spawn(["bun", CLI_ENTRY, ...argv], {
    env: { ...process.env, TASQ_HOME: home, TASQ_TENANT: undefined, TASQ_DB_URL: undefined },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code: await proc.exited, stdout, stderr };
}

/** A populated store rolled back one migration, so an upgrade is genuinely pending. */
async function storeOneFormatBehind(): Promise<{ dir: string }> {
  const dir = mkdtempSync(join(tmpdir(), "tasq-behind-"));
  dirs.push(dir);
  const dbPath = join(dir, "db.sqlite");
  const handle = await openDb({ url: `file:${dbPath}`, wal: false });
  await runMigrations(handle.client);
  await handle.client.executeMultiple(`
    DROP TABLE contention;
    DELETE FROM _migration WHERE name = '0035_contention.sql';
  `);
  await handle.close();
  writeFileSync(join(dir, "config.json"), JSON.stringify({
    dbPath,
    eventJournalPath: join(dir, "events.jsonl"),
    tenantId: "gwendall",
    defaultActor: "gwendall",
  }, null, 2), "utf8");
  return { dir };
}

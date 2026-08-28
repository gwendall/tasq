/**
 * The rollback rule, exercised.
 *
 * PUBLIC_RELEASE_POLICY names `restore-matching-verified-pre-migration-snapshot-and-binary`
 * as the way back from an irreversible upgrade. These tests exist because that
 * rule was documented policy with no implementation until 2026-08-26, and the
 * only reason a real incident was recoverable that day is that the operator
 * happened to know the internals.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  STORE_FORMAT_COMPATIBILITY,
  createTask,
  listRecoveryPoints,
  openDb,
  restoreRecoveryPoint,
  runMigrations,
} from "@tasq-internal/local-service";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

/**
 * Build a store one format behind, so the next `runMigrations` writes a real
 * recovery point instead of a synthetic one.
 */
async function storeWithARecoveryPoint(): Promise<{ dbPath: string; taskId: string }> {
  const dir = mkdtempSync(join(tmpdir(), "tasq-recovery-"));
  dirs.push(dir);
  const dbPath = join(dir, "db.sqlite");

  let handle = await openDb({ url: `file:${dbPath}`, wal: false });
  await runMigrations(handle.client);
  const task = await createTask(handle.db, { title: "work that predates the upgrade" });
  // Roll the history back one migration so the store reads as the previous format.
  await handle.client.executeMultiple(`
    DROP TABLE contention;
    DELETE FROM _migration WHERE name = '0035_contention.sql';
  `);
  await handle.close();

  handle = await openDb({ url: `file:${dbPath}`, wal: false });
  await runMigrations(handle.client);
  await handle.close();
  return { dbPath, taskId: task.id };
}

describe("store recovery points", () => {
  test("records a usable, digest-verified point for an irreversible upgrade", async () => {
    const { dbPath } = await storeWithARecoveryPoint();
    const points = await listRecoveryPoints(dbPath);

    expect(points.length).toBeGreaterThan(0);
    const point = points[0]!;
    expect(point.sourceFormat).toBe(STORE_FORMAT_COMPATIBILITY.current - 1);
    expect(point.targetFormat).toBe(STORE_FORMAT_COMPATIBILITY.current);
    expect(point.snapshotVerified).toBe(true);
    expect(point.usable).toBe(true);
    expect(point.unusableReason).toBeNull();
  });

  test("restores the store to the format the snapshot holds", async () => {
    const { dbPath, taskId } = await storeWithARecoveryPoint();
    const point = (await listRecoveryPoints(dbPath))[0]!;

    const outcome = await restoreRecoveryPoint(dbPath, point.id, { now: 1_800_000_000_000 });
    expect(outcome.formatBefore).toBe(STORE_FORMAT_COMPATIBILITY.current);
    expect(outcome.formatAfter).toBe(STORE_FORMAT_COMPATIBILITY.current - 1);
    expect(outcome.eventsDropped).toBe(0);

    const handle = await openDb({ url: `file:${dbPath}`, wal: false });
    try {
      const applied = await handle.client.execute("SELECT name FROM _migration ORDER BY name DESC LIMIT 1");
      // The snapshot was taken one format back, so the restored store must end
      // at the migration BEFORE the one this build ships.
      expect(String(applied.rows[0]?.["name"])).toBe("0034_principal_device.sql");
      // The work that predates the upgrade must survive the way back.
      const rows = await handle.client.execute({ sql: "SELECT id FROM task WHERE id = ?", args: [taskId] });
      expect(rows.rows).toHaveLength(1);
    } finally {
      await handle.close();
    }
  });

  test("refuses to discard work written after the recovery point", async () => {
    const { dbPath } = await storeWithARecoveryPoint();
    const handle = await openDb({ url: `file:${dbPath}`, wal: false });
    await createTask(handle.db, { title: "work that postdates the upgrade" });
    await handle.close();

    const point = (await listRecoveryPoints(dbPath))[0]!;
    await expect(restoreRecoveryPoint(dbPath, point.id, { now: 1_800_000_000_000 }))
      .rejects.toThrow(/written after this recovery point/);
  });

  test("refuses a snapshot whose bytes no longer match its receipt", async () => {
    const { dbPath } = await storeWithARecoveryPoint();
    const before = (await listRecoveryPoints(dbPath))[0]!;
    appendFileSync(before.snapshotPath, "\0");

    const after = (await listRecoveryPoints(dbPath)).find((entry) => entry.id === before.id)!;
    expect(after.usable).toBe(false);
    expect(after.unusableReason).toMatch(/digest/);

    await expect(restoreRecoveryPoint(dbPath, before.id, { now: 1_800_000_000_000 }))
      .rejects.toThrow(/Refusing to restore/);
  });

  test("keeps the replaced store so a restore is itself reversible", async () => {
    const { dbPath } = await storeWithARecoveryPoint();
    const point = (await listRecoveryPoints(dbPath))[0]!;
    const outcome = await restoreRecoveryPoint(dbPath, point.id, { now: 1_800_000_000_000 });

    const handle = await openDb({ url: `file:${outcome.replacedStorePath}`, wal: false });
    try {
      const applied = await handle.client.execute("SELECT name FROM _migration ORDER BY name DESC LIMIT 1");
      expect(String(applied.rows[0]?.["name"])).toBe("0035_contention.sql");
    } finally {
      await handle.close();
    }
  });
});

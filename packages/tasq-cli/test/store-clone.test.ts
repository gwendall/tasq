/**
 * A clone must be genuinely independent, and a hand-rolled copy is not.
 *
 * Two failures, the second invisible:
 *   - config.json holds absolute paths, so a copied home still drives the
 *     original. That destroyed this project's own ledger on 2026-08-26.
 *   - the store runs in WAL mode, so copying db.sqlite alone yields a silently
 *     empty or stale database.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { copyFileSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTask, listTasks, openDb, runMigrations } from "@tasq-internal/local-service";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const CLI = join(import.meta.dir, "..", "src", "index.ts");

function scratch(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

async function run(home: string, argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", CLI, ...argv], {
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

/** A live store whose content sits in the WAL, which is the ordinary case. */
async function sourceHome(): Promise<{ home: string; dbPath: string }> {
  const home = scratch("tasq-clone-src-");
  const dbPath = join(home, "db.sqlite");
  const handle = await openDb({ url: `file:${dbPath}` });
  await runMigrations(handle.client);
  await createTask(handle.db, { title: "work that predates the clone" });
  // Deliberately leave the connection's WAL uncheckpointed.
  writeFileSync(join(home, "config.json"), JSON.stringify({
    dbPath,
    eventJournalPath: join(home, "events.jsonl"),
    tenantId: "gwendall",
    defaultActor: "gwendall",
  }, null, 2), "utf8");
  await handle.close();
  return { home, dbPath };
}

describe("tasq store clone", () => {
  test("produces a home whose every path stays inside it", async () => {
    const source = await sourceHome();
    const target = join(scratch("tasq-clone-dst-"), "clone");

    const result = await run(source.home, ["store", "clone", "--to", target, "--json"]);
    expect(result.code, result.stderr).toBe(0);
    const outcome = JSON.parse(result.stdout);
    expect(outcome.contractVersion).toBe("tasq.store-clone.v1");

    const config = JSON.parse(await Bun.file(join(target, "config.json")).text());
    for (const [key, value] of Object.entries(config)) {
      if (typeof value === "string" && value.startsWith("/")) {
        expect(value.startsWith(target), `${key} escapes the clone`).toBe(true);
      }
    }
    // A clone must never write a projection over the file the original maintains.
    expect(config.projectionTarget).toBeUndefined();
  });

  test("carries content still held in the WAL, which a file copy loses", async () => {
    const source = await sourceHome();
    const target = join(scratch("tasq-clone-wal-"), "clone");

    // What a careful person does by hand, and why it is wrong.
    const naive = scratch("tasq-clone-naive-");
    copyFileSync(source.dbPath, join(naive, "db.sqlite"));
    expect(statSync(join(naive, "db.sqlite")).size)
      .toBeLessThan(statSync(source.dbPath).size + 1_000_000);

    const result = await run(source.home, ["store", "clone", "--to", target, "--json"]);
    expect(result.code, result.stderr).toBe(0);

    const cloned = await openDb({ url: `file:${join(target, "db.sqlite")}`, wal: false });
    try {
      const tasks = await listTasks(cloned.db, { tenantId: "gwendall" });
      expect(tasks.map((task) => task.title)).toContain("work that predates the clone");
    } finally {
      await cloned.close();
    }

    const naiveDb = await openDb({ url: `file:${join(naive, "db.sqlite")}`, wal: false });
    try {
      const rows = await naiveDb.client.execute(
        "SELECT count(*) AS count FROM sqlite_master WHERE type='table' AND name='task'",
      );
      // The point: a file copy of a WAL store has no task table at all.
      expect(Number(rows.rows[0]?.["count"])).toBe(0);
    } finally {
      await naiveDb.close();
    }
  });

  test("leaves the source untouched when the clone is mutated", async () => {
    const source = await sourceHome();
    const target = join(scratch("tasq-clone-iso-"), "clone");
    expect((await run(source.home, ["store", "clone", "--to", target])).code).toBe(0);

    expect((await run(target, ["add", "written only in the clone"])).code).toBe(0);

    const cloneList = await run(target, ["list", "--json"]);
    const sourceList = await run(source.home, ["list", "--json"]);
    expect(cloneList.code, cloneList.stderr).toBe(0);
    expect(sourceList.code, sourceList.stderr).toBe(0);
    expect(JSON.parse(cloneList.stdout)).toHaveLength(2);
    expect(JSON.parse(sourceList.stdout)).toHaveLength(1);
  });

  test("refuses to clone into a directory that already holds something", async () => {
    const source = await sourceHome();
    const target = scratch("tasq-clone-busy-");
    writeFileSync(join(target, "occupied.txt"), "x", "utf8");

    const result = await run(source.home, ["store", "clone", "--to", target]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/non-empty directory/);
  });
});

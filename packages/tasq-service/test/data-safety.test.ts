import { afterEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  createTask,
  exportPortableStore,
  importPortableStore,
  MigrationSafetyError,
  openDb,
  runMigrations,
  STORE_FORMAT_COMPATIBILITY,
  StoreCompatibilityError,
} from "../src/index.js";

const PRE_AGENTIC_FIXTURE = fileURLToPath(
  new URL("./fixtures/pre-0006-populated.sql", import.meta.url),
);
const temporaryRoots: string[] = [];

afterEach(() => {
  while (temporaryRoots.length > 0) {
    rmSync(temporaryRoots.pop()!, { recursive: true, force: true });
  }
});

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "tasq-data-safety-"));
  temporaryRoots.push(root);
  return root;
}

async function openFixture(root: string) {
  const path = join(root, "db.sqlite");
  const opened = await openDb({ url: `file:${path}`, wal: false });
  await opened.client.executeMultiple(readFileSync(PRE_AGENTIC_FIXTURE, "utf8"));
  return { ...opened, path };
}

function receiptDocuments(databasePath: string): Array<Record<string, unknown>> {
  const directory = `${databasePath}.tasq-migrations`;
  return readdirSync(directory)
    .filter((name) => name.startsWith("receipt-") && name.endsWith(".json"))
    .sort()
    .map((name) => JSON.parse(readFileSync(join(directory, name), "utf8")) as Record<string, unknown>);
}

describe("migration data-safety envelope", () => {
  it("creates a verified private snapshot and complete durable receipt", async () => {
    const opened = await openFixture(temporaryRoot());
    try {
      const result = await runMigrations(opened.client, {
        now: 1_700_000_000_000,
        installReferenceExtension: false,
        postMigrationCheck: async () => ({ ok: true, issues: [] }),
      });
      expect(result).toMatchObject({
        beforeFormat: 5,
        afterFormat: STORE_FORMAT_COMPATIBILITY.current,
        migrationRequired: true,
        irreversible: true,
        receipt: { status: "complete", sourceFormat: 5, targetFormat: 25 },
      });
      const receipt = JSON.parse(readFileSync(result.receipt!.path, "utf8"));
      expect(receipt).toMatchObject({
        contractVersion: "tasq.migration-receipt.v1",
        status: "complete",
        recoveredAfterRestart: false,
        source: { format: 5, eventCursor: expect.any(Number) },
        target: { format: 25 },
        snapshot: {
          path: result.receipt!.snapshotPath,
          sha256: result.receipt!.snapshotSha256,
          verification: { ok: true },
        },
        postVerification: { schemaFormat: 25, service: { ok: true, issues: [] } },
      });
      expect(statSync(result.receipt!.snapshotPath).mode & 0o777).toBe(0o600);
      expect(statSync(result.receipt!.path).mode & 0o777).toBe(0o600);
    } finally {
      await opened.close();
    }
  });

  it("recovers an interruption after snapshot but before schema commit", async () => {
    const opened = await openFixture(temporaryRoot());
    try {
      await expect(runMigrations(opened.client, {
        now: 1_700_000_000_100,
        installReferenceExtension: false,
        onSafetyBoundary(boundary) {
          if (boundary === "after_snapshot_verified") throw new Error("injected process stop");
        },
      })).rejects.toThrow("injected process stop");
      expect(receiptDocuments(opened.path)).toEqual([
        expect.objectContaining({ status: "snapshot_verified" }),
      ]);

      const resumed = await runMigrations(opened.client, {
        now: 1_700_000_000_101,
        installReferenceExtension: false,
      });
      expect(resumed.receipt?.status).toBe("complete");
      expect(receiptDocuments(opened.path)).toEqual([
        expect.objectContaining({
          status: "failed",
          recoveredAfterRestart: true,
          failure: expect.stringContaining("before schema commit"),
        }),
        expect.objectContaining({ status: "complete", recoveredAfterRestart: false }),
      ]);
    } finally {
      await opened.close();
    }
  });

  it("serializes concurrent first-open upgrades and preserves both receipts", async () => {
    const root = temporaryRoot();
    const seeded = await openFixture(root);
    await seeded.close();
    const left = await openDb({ url: `file:${seeded.path}` });
    const right = await openDb({ url: `file:${seeded.path}` });
    try {
      const results = await Promise.all([
        runMigrations(left.client, { now: 1_700_000_000_150, installReferenceExtension: false }),
        runMigrations(right.client, { now: 1_700_000_000_150, installReferenceExtension: false }),
      ]);
      expect(results.reduce((count, result) => count + result.applied.length, 0)).toBe(20);
      expect(results.filter((result) => result.receipt?.status === "complete")).toHaveLength(1);
      expect(results.filter((result) => result.receipt === null)).toHaveLength(1);
      expect(receiptDocuments(seeded.path).map((receipt) => receipt.status)).toEqual(["complete"]);
      expect((await left.client.execute("SELECT count(*) AS count FROM _migration")).rows[0]?.count).toBe(26);
    } finally {
      await left.close();
      await right.close();
    }
  });

  it("recovers real process kills at every migration safety boundary", async () => {
    const root = temporaryRoot();
    const serviceModule = pathToFileURL(fileURLToPath(new URL("../src/index.ts", import.meta.url))).href;
    const runner = join(root, "kill-migration.ts");
    writeFileSync(runner, `
      import { openDb, runMigrations } from ${JSON.stringify(serviceModule)};
      const opened = await openDb({ url: \`file:\${process.env.DB_PATH}\` });
      await runMigrations(opened.client, {
        installReferenceExtension: false,
        onSafetyBoundary(boundary) {
          if (boundary === process.env.BOUNDARY) process.kill(process.pid, "SIGKILL");
        },
      });
      await opened.close();
    `);
    const boundaries = [
      "before_snapshot",
      "after_snapshot_verified",
      "after_ddl_before_commit",
      "after_commit_before_postcheck",
      "before_receipt_finalization",
    ];
    for (const boundary of boundaries) {
      const boundaryRoot = join(root, boundary);
      mkdirSync(boundaryRoot);
      const seeded = await openFixture(boundaryRoot);
      await seeded.close();
      const child = Bun.spawn([process.execPath, runner], {
        env: { ...process.env, DB_PATH: seeded.path, BOUNDARY: boundary },
        stdout: "ignore",
        stderr: "pipe",
      });
      const [exitCode, stderr] = await Promise.all([
        child.exited,
        new Response(child.stderr).text(),
      ]);
      expect(exitCode, `${boundary}: ${stderr}`).not.toBe(0);

      const resumed = await openDb({ url: `file:${seeded.path}` });
      try {
        const result = await runMigrations(resumed.client, {
          now: 1_700_000_000_175,
          installReferenceExtension: false,
        });
        expect(result.afterFormat, boundary).toBe(25);
        expect((await resumed.client.execute("SELECT count(*) AS count FROM _migration")).rows[0]?.count).toBe(26);
        expect(receiptDocuments(seeded.path).some((receipt) => receipt.status === "snapshot_verified")).toBe(false);
      } finally {
        await resumed.close();
      }
    }
  });

  it("finalizes a committed receipt left pending by a process stop", async () => {
    const opened = await openFixture(temporaryRoot());
    try {
      const first = await runMigrations(opened.client, {
        now: 1_700_000_000_200,
        installReferenceExtension: false,
      });
      const pending = JSON.parse(readFileSync(first.receipt!.path, "utf8"));
      pending.status = "snapshot_verified";
      pending.completedAt = null;
      pending.postVerification = null;
      writeFileSync(first.receipt!.path, `${JSON.stringify(pending, null, 2)}\n`, { mode: 0o600 });

      const resumed = await runMigrations(opened.client, {
        now: 1_700_000_000_201,
        installReferenceExtension: false,
        postMigrationCheck: async () => ({ ok: true, issues: [] }),
      });
      expect(resumed.applied).toEqual([]);
      expect(resumed.receipt).toMatchObject({ status: "complete", sourceFormat: 5, targetFormat: 25 });
      expect(JSON.parse(readFileSync(first.receipt!.path, "utf8"))).toMatchObject({
        status: "complete",
        recoveredAfterRestart: true,
        postVerification: { schemaFormat: 25, service: { ok: true } },
      });
    } finally {
      await opened.close();
    }
  });

  it("rejects a corrupt pending snapshot and never claims recovery success", async () => {
    const opened = await openFixture(temporaryRoot());
    try {
      await expect(runMigrations(opened.client, {
        now: 1_700_000_000_300,
        installReferenceExtension: false,
        onSafetyBoundary(boundary) {
          if (boundary === "after_snapshot_verified") throw new Error("injected process stop");
        },
      })).rejects.toThrow("injected process stop");
      const receipt = receiptDocuments(opened.path)[0]! as any;
      writeFileSync(receipt.snapshot.path, "corrupt", { mode: 0o600 });
      await expect(runMigrations(opened.client, {
        now: 1_700_000_000_301,
        installReferenceExtension: false,
      })).rejects.toBeInstanceOf(MigrationSafetyError);
      expect(receiptDocuments(opened.path)[0]).toMatchObject({
        status: "failed",
        recoveredAfterRestart: true,
        failure: expect.stringContaining("corrupt recovery snapshot"),
      });
    } finally {
      await opened.close();
    }
  });

  it("retains the recovery point and returns a restore plan when post-check fails", async () => {
    const opened = await openFixture(temporaryRoot());
    try {
      let problem: MigrationSafetyError | null = null;
      try {
        await runMigrations(opened.client, {
          now: 1_700_000_000_350,
          installReferenceExtension: false,
          postMigrationCheck: async () => ({ ok: false, issues: ["injected invariant failure"] }),
        });
      } catch (error) {
        problem = error as MigrationSafetyError;
      }
      expect(problem).toBeInstanceOf(MigrationSafetyError);
      expect(problem!.toJSON()).toMatchObject({
        code: "migration_postcheck_failed",
        receipt: { status: "failed", sourceFormat: 5, targetFormat: 25 },
        restore: {
          snapshotPath: expect.any(String),
          requiredStoreFormat: 5,
          rule: STORE_FORMAT_COMPATIBILITY.rollback,
        },
      });
      expect(existsSync(problem!.receipt.snapshotPath)).toBe(true);
      expect(receiptDocuments(opened.path)[0]).toMatchObject({
        status: "failed",
        failure: expect.stringContaining("post-migration verification failed"),
      });
    } finally {
      await opened.close();
    }
  });

  it("refuses a newer store with a typed error and no corrective write", async () => {
    const root = temporaryRoot();
    const opened = await openDb({ url: `file:${join(root, "db.sqlite")}`, wal: false });
    try {
      await runMigrations(opened.client, { installReferenceExtension: false });
      await createTask(opened.db, { title: "must survive" }, { tenantId: "future/space", actor: "test" });
      await opened.client.execute(
        "INSERT INTO _migration (name, applied_at, checksum) VALUES ('9999_future.sql', 1, 'future')",
      );
      const before = await opened.client.execute("SELECT count(*) AS count FROM task");
      let problem: StoreCompatibilityError | null = null;
      try {
        await runMigrations(opened.client, { installReferenceExtension: false });
      } catch (error) {
        problem = error as StoreCompatibilityError;
      }
      expect(problem).toBeInstanceOf(StoreCompatibilityError);
      expect(problem!.toJSON()).toMatchObject({
        code: "store_format_newer_than_executable",
        detectedFormat: 9999,
        mutationPerformed: false,
        supported: STORE_FORMAT_COMPATIBILITY,
      });
      expect(await opened.client.execute("SELECT count(*) AS count FROM task")).toEqual(before);
      expect((await opened.client.execute("SELECT name FROM _migration WHERE name='9999_future.sql'")).rows).toHaveLength(1);
    } finally {
      await opened.close();
    }
  });
});

describe("portable workspace export", () => {
  it("round-trips durable records into a private new store with declared omissions", async () => {
    const root = temporaryRoot();
    const sourcePath = join(root, "source.sqlite");
    const targetPath = join(root, "imported.sqlite");
    const source = await openDb({ url: `file:${sourcePath}`, wal: false });
    try {
      await runMigrations(source.client, { installReferenceExtension: false });
      await createTask(source.db, { title: "portable commitment" }, {
        tenantId: "demo/portable",
        actor: "test:export",
        now: 1_700_000_001_000,
      });
      const exported = await exportPortableStore(source.client, "demo/portable", {
        now: 1_700_000_001_001,
      });
      expect(exported.document.omissions).toEqual(expect.arrayContaining([
        "credentials",
        "delivery_outbox",
        "idempotency_key",
        "replication_outgoing",
        "event_journal",
      ]));
      const imported = await importPortableStore(
        exported.document,
        targetPath,
        exported.sha256,
        1_700_000_001_002,
      );
      expect(imported).toMatchObject({
        target: targetPath,
        workspaceId: "demo/portable",
        recordCount: exported.recordCount,
        verification: { ok: true, eventCursor: exported.document.eventOrdering.maxSequence },
      });
      expect(statSync(targetPath).mode & 0o777).toBe(0o600);

      const restored = await openDb({ url: `file:${targetPath}`, wal: false });
      try {
        const roundTrip = await exportPortableStore(restored.client, "demo/portable", {
          now: exported.document.exportedAt,
        });
        expect(roundTrip.document).toEqual(exported.document);
      } finally {
        await restored.close();
      }
    } finally {
      await source.close();
    }
  });

  it("validates hostile input completely before creating a target", async () => {
    const root = temporaryRoot();
    const source = await openDb({ url: `file:${join(root, "source.sqlite")}`, wal: false });
    try {
      await runMigrations(source.client, { installReferenceExtension: false });
      await createTask(source.db, { title: "bounded" }, { tenantId: "demo/hostile", actor: "test" });
      const exported = await exportPortableStore(source.client, "demo/hostile", { now: 1 });
      const hostile = structuredClone(exported.document);
      hostile.eventOrdering.count += 1;
      const target = join(root, "must-not-exist.sqlite");
      await expect(importPortableStore(hostile, target, exported.sha256, 2)).rejects.toThrow(
        "event ordering summary is inconsistent",
      );
      expect(existsSync(target)).toBe(false);

      const invalidGraph = structuredClone(exported.document);
      const taskTable = invalidGraph.tables.find((table) => table.name === "task")!;
      taskTable.rows[0]!.area_id = "01930000-0000-7000-8000-00000000ffff";
      const invalidTarget = join(root, "invalid-graph-must-not-exist.sqlite");
      await expect(importPortableStore(invalidGraph, invalidTarget, exported.sha256, 3)).rejects.toThrow(
        "foreign-key violation",
      );
      expect(existsSync(invalidTarget)).toBe(false);
      expect(readdirSync(root).some((name) => name.includes(".import-") && name.endsWith(".tmp"))).toBe(false);
      await expect(exportPortableStore(source.client, "demo/hostile", {
        now: 1,
        maxRecords: 1,
      })).rejects.toThrow("exceeds maxRecords=1");
    } finally {
      await source.close();
    }
  });
});

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireTaskClaim,
  captureDiscovery,
  createTask,
  getActiveTaskClaim,
  listDependencies,
  listTasks,
  openDb,
  runMigrations,
  unresolvedBlockerCount,
} from "../src/index.js";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "tasq-discovery-"));
  dirs.push(dir);
  const handle = await openDb({ url: `file:${join(dir, "db.sqlite")}`, wal: false });
  await runMigrations(handle.client);
  const source = await createTask(handle.db, { title: "Implement current scope" });
  return { ...handle, source };
}

describe("discovery capture", () => {
  it("atomically creates linked work without changing the discovering claim", async () => {
    const f = await fixture();
    try {
      const claim = await acquireTaskClaim(f.db, f.source.id, {
        tenantId: "gwendall", actor: "agent-a", now: 1_800_000_000_000,
        leaseMs: 60_000, idempotencyKey: "claim:source",
      });
      const captured = await captureDiscovery(f.db, {
        sourceTaskId: f.source.id,
        title: "Repair adjacent invariant",
        nextAction: "Write the failing test",
        sourceCommand: "done",
        context: { errorCode: "INVARIANT_REFUSED", runtime: "codex" },
      }, {
        tenantId: "gwendall", actor: "agent-a", now: 1_800_000_000_001,
        idempotencyKey: "capture:one",
      });
      expect(captured.replayed).toBeFalse();
      expect(captured.relation).toMatchObject({
        fromTaskId: captured.task.id,
        toTaskId: f.source.id,
        type: "discovered_from",
      });
      expect(captured.task.metadata.discovery).toMatchObject({
        contract: "tasq.discovery-capture.v1",
        sourceTaskId: f.source.id,
        sourceTaskRevision: 1,
        sourceCommand: "done",
        context: { errorCode: "INVARIANT_REFUSED", runtime: "codex" },
      });
      expect(await getActiveTaskClaim(f.db, f.source.id, "gwendall", 1_800_000_000_002))
        .toEqual(claim);
      expect(await unresolvedBlockerCount(f.db, captured.task.id)).toBe(0);
      expect(await listDependencies(f.db, {
        taskId: captured.task.id, direction: "from", type: "discovered_from",
      })).toEqual([captured.relation]);
      const legacy = await f.client.execute({
        sql: "SELECT COUNT(*) AS count FROM task_dependency WHERE tenant_id = ?",
        args: ["gwendall"],
      });
      expect(Number(legacy.rows[0]?.count)).toBe(0);
    } finally {
      await f.close();
    }
  });

  it("replays by durable identity and rejects a changed request", async () => {
    const f = await fixture();
    try {
      const ctx = { tenantId: "gwendall", actor: "agent-a", now: 1_800_000_000_000, idempotencyKey: "capture:retry" };
      const input = { sourceTaskId: f.source.id, title: "Follow-up", context: { code: "E1" } };
      const first = await captureDiscovery(f.db, input, ctx);
      const replay = await captureDiscovery(f.db, input, { ...ctx, now: ctx.now + 1 });
      expect(replay.replayed).toBeTrue();
      expect(replay.task.id).toBe(first.task.id);
      expect((await listTasks(f.db, { tenantId: "gwendall" })).filter((task) => task.title === "Follow-up"))
        .toHaveLength(1);
      await expect(captureDiscovery(f.db, { ...input, title: "Changed" }, { ...ctx, now: ctx.now + 2 }))
        .rejects.toThrow(/different request/i);
    } finally {
      await f.close();
    }
  });

  it("rolls back task creation when the provenance edge cannot commit", async () => {
    const f = await fixture();
    try {
      await f.client.execute(`
        CREATE TRIGGER reject_discovery_relation
        BEFORE INSERT ON commitment_relation
        WHEN NEW.relation_type = 'discovered_from'
        BEGIN SELECT RAISE(ABORT, 'test provenance refusal'); END
      `);
      await expect(captureDiscovery(f.db, {
        sourceTaskId: f.source.id,
        title: "Must roll back",
      }, { tenantId: "gwendall", actor: "agent-a", now: 1_800_000_000_000 }))
        .rejects.toThrow(/Failed query|provenance refusal/);
      expect((await listTasks(f.db, { tenantId: "gwendall" })).map((task) => task.title))
        .toEqual(["Implement current scope"]);
    } finally {
      await f.close();
    }
  });

  it("bounds machine context before opening a mutation", async () => {
    const f = await fixture();
    try {
      await expect(captureDiscovery(f.db, {
        sourceTaskId: f.source.id,
        title: "Oversized",
        context: { dump: "x".repeat(16_385) },
      })).rejects.toThrow(/exceeds 16384/);
      expect(await listDependencies(f.db, { taskId: f.source.id, type: "discovered_from" }))
        .toEqual([]);
    } finally {
      await f.close();
    }
  });
});

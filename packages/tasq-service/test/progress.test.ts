/**
 * Progress + ETA computation tests.
 *
 * The formula is intentionally simple. These tests pin the math so a
 * future "smarter" version stays honest about what changed.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  openDb,
  runMigrations,
  createArea,
  createProject,
  createTask,
  completeTask,
  cancelTask,
  startTask,
  blockTask,
  getProjectProgress,
  getTaskProgress,
  type TasqDb,
} from "../src/index.js";

const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length > 0) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

async function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "tasq-prog-"));
  tmpDirs.push(dir);
  const h = await openDb({ url: `file:${join(dir, "db.sqlite")}`, wal: false });
  await runMigrations(h.client);
  return h;
}

describe("Project progress — counts + percent", () => {
  it("empty project returns 0/0 0%", async () => {
    const { db, close } = await freshDb();
    try {
      const area = await createArea(db, { name: "X", slug: "x", importance: 3 });
      const p = await createProject(db, { title: "P", areaId: area.id });
      const prog = await getProjectProgress(db, p.id);
      expect(prog.counts.total).toBe(0);
      expect(prog.percentDone).toBe(0);
      expect(prog.eta).toBeNull();
    } finally {
      await close();
    }
  });

  it("counts each status correctly", async () => {
    const { db, close } = await freshDb();
    try {
      const area = await createArea(db, { name: "X", slug: "x", importance: 3 });
      const p = await createProject(db, { title: "P", areaId: area.id });

      const t1 = await createTask(db, { title: "t1", projectId: p.id, areaId: area.id });
      const t2 = await createTask(db, { title: "t2", projectId: p.id, areaId: area.id });
      const t3 = await createTask(db, { title: "t3", projectId: p.id, areaId: area.id });
      const t4 = await createTask(db, { title: "t4", projectId: p.id, areaId: area.id });
      const t5 = await createTask(db, { title: "t5", projectId: p.id, areaId: area.id });

      await startTask(db, t2.id);
      await blockTask(db, t3.id);
      await completeTask(db, t4.id);
      await cancelTask(db, t5.id);

      const prog = await getProjectProgress(db, p.id);
      expect(prog.counts.total).toBe(5);
      expect(prog.counts.open).toBe(1);
      expect(prog.counts.in_progress).toBe(1);
      expect(prog.counts.blocked).toBe(1);
      expect(prog.counts.done).toBe(1);
      expect(prog.counts.cancelled).toBe(1);
      // denominator excludes cancelled
      expect(prog.counts.denominator).toBe(4);
      // 1 done out of 4 = 25%
      expect(prog.percentDone).toBe(25);
    } finally {
      await close();
    }
  });

  it("percent ignores cancelled in denominator", async () => {
    const { db, close } = await freshDb();
    try {
      const area = await createArea(db, { name: "X", slug: "x", importance: 3 });
      const p = await createProject(db, { title: "P", areaId: area.id });
      const t1 = await createTask(db, { title: "t1", projectId: p.id, areaId: area.id });
      const t2 = await createTask(db, { title: "t2", projectId: p.id, areaId: area.id });
      await completeTask(db, t1.id);
      await cancelTask(db, t2.id);

      const prog = await getProjectProgress(db, p.id);
      // 1 done + 1 cancelled : denominator = 1, done = 1 → 100%
      expect(prog.percentDone).toBe(100);
    } finally {
      await close();
    }
  });
});

describe("ETA — sample size + computation", () => {
  it("returns null when sample size below threshold", async () => {
    const { db, close } = await freshDb();
    try {
      const area = await createArea(db, { name: "X", slug: "x", importance: 3 });
      const p = await createProject(db, { title: "P", areaId: area.id });
      // Open task, no recent completions
      await createTask(db, { title: "t1", projectId: p.id, areaId: area.id });

      const prog = await getProjectProgress(db, p.id);
      expect(prog.eta).toBeNull();
    } finally {
      await close();
    }
  });

  it("refuses an ETA when completions are a same-time batch", async () => {
    const { db, close } = await freshDb();
    try {
      const area = await createArea(db, { name: "X", slug: "x", importance: 3 });

      // Seed historical data: 3 completed tasks, each "1 day"
      await seedCompletedTasks(db, area.id, 3, 24 * 60 * 60 * 1000);

      const p = await createProject(db, { title: "P", areaId: area.id });
      await createTask(db, { title: "remaining-1", projectId: p.id, areaId: area.id });
      await createTask(db, { title: "remaining-2", projectId: p.id, areaId: area.id });

      const prog = await getProjectProgress(db, p.id);
      expect(prog.eta).toBeNull();
    } finally {
      await close();
    }
  });

  it("ETA window: ignores completions older than 30 days", async () => {
    const { db, close } = await freshDb();
    try {
      const area = await createArea(db, { name: "X", slug: "x", importance: 3 });
      const ancient = Date.now() - 60 * 24 * 60 * 60 * 1000; // 60d ago
      const recent = Date.now() - 5 * 24 * 60 * 60 * 1000; // 5d ago

      // 3 ancient completions (outside window)
      await seedHistoricalAt(db, area.id, 3, ancient, 24 * 60 * 60 * 1000);
      // 1 recent (inside window, below threshold)
      await seedHistoricalAt(db, area.id, 1, recent, 24 * 60 * 60 * 1000);

      const p = await createProject(db, { title: "P", areaId: area.id });
      await createTask(db, { title: "t", projectId: p.id, areaId: area.id });

      const prog = await getProjectProgress(db, p.id);
      // Only 1 recent → below threshold → ETA null
      expect(prog.eta).toBeNull();
    } finally {
      await close();
    }
  });
});

describe("Task progress (task with sub-tasks)", () => {
  it("returns progress for a task with sub-tasks", async () => {
    const { db, close } = await freshDb();
    try {
      const area = await createArea(db, { name: "X", slug: "x", importance: 3 });
      const parent = await createTask(db, { title: "Parent", areaId: area.id });
      const c1 = await createTask(db, { title: "c1", parentTaskId: parent.id });
      const c2 = await createTask(db, { title: "c2", parentTaskId: parent.id });
      await completeTask(db, c1.id);

      const prog = await getTaskProgress(db, parent.id);
      expect(prog).not.toBeNull();
      // 2 sub-tasks, 1 done, 1 open → 50%
      expect(prog!.counts.total).toBe(2);
      expect(prog!.counts.done).toBe(1);
      expect(prog!.percentDone).toBe(50);
    } finally {
      await close();
    }
  });

  it("returns null for non-existent task", async () => {
    const { db, close } = await freshDb();
    try {
      const prog = await getTaskProgress(db, "01900000-0000-7000-8000-000000000000");
      expect(prog).toBeNull();
    } finally {
      await close();
    }
  });

  it("nested sub-tasks: counts all descendants", async () => {
    const { db, close } = await freshDb();
    try {
      const area = await createArea(db, { name: "X", slug: "x", importance: 3 });
      const root = await createTask(db, { title: "root", areaId: area.id });
      const a = await createTask(db, { title: "a", parentTaskId: root.id });
      const b = await createTask(db, { title: "b", parentTaskId: a.id });
      const c = await createTask(db, { title: "c", parentTaskId: a.id });
      await completeTask(db, b.id);
      await completeTask(db, c.id);

      const prog = await getTaskProgress(db, root.id);
      expect(prog!.counts.total).toBe(2); // executable leaves b + c; a is a container
      expect(prog!.counts.done).toBe(2);
      expect(prog!.percentDone).toBe(100);
    } finally {
      await close();
    }
  });
});

// ──────────────────────────────────────────────────────────────────────
// Helpers — seed historical completed tasks
// ──────────────────────────────────────────────────────────────────────

async function seedCompletedTasks(
  db: TasqDb,
  areaId: string,
  count: number,
  cycleMs: number,
): Promise<void> {
  const now = Date.now();
  await seedHistoricalAt(db, areaId, count, now - cycleMs, cycleMs);
}

/**
 * Seed `count` completed tasks whose completed_at = `endTime` and whose
 * created_at = endTime - cycleMs. Used to build a known sample for ETA.
 *
 * Implementation detail: we create + complete via the public API to get a
 * "raw" completion, then directly UPDATE created_at + completed_at to the
 * synthetic timestamps via the raw client. This bypasses the service for
 * test setup only ; production code never does this.
 */
async function seedHistoricalAt(
  db: TasqDb,
  areaId: string,
  count: number,
  endTime: number,
  cycleMs: number,
): Promise<void> {
  for (let i = 0; i < count; i++) {
    const t = await createTask(db, {
      title: `historical-${i}`,
      areaId,
    });
    await completeTask(db, t.id);
    // Backdate timestamps. Using `db._.session.client` would be ugly ; the
    // cleanest path is to write a small raw query via the underlying client.
    // Since openDb returns the client too, callers can pass it ; but here
    // we use drizzle's update for parity with the service layer.
    await db
      .update((await import("@tasq/schema")).task)
      .set({
        createdAt: endTime - cycleMs,
        completedAt: endTime,
        revision: (await import("drizzle-orm")).sql`${(await import("@tasq/schema")).task.revision} + 1`,
      })
      .where(
        (await import("drizzle-orm")).eq(
          (await import("@tasq/schema")).task.id,
          t.id,
        ),
      );
  }
}

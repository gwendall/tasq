/**
 * Smoke test — end-to-end happy path on an in-memory LibSQL.
 * Validates: migrations, schema, service create/update/transitions, event log.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  openDb,
  runMigrations,
  createArea,
  getArea,
  listAreas,
  softDeleteArea,
  restoreArea,
  createGoal,
  getGoal,
  softDeleteGoal,
  restoreGoal,
  createProject,
  getProject,
  softDeleteProject,
  restoreProject,
  createTask,
  startTask,
  completeTask,
  blockTask,
  unblockTask,
  listTasks,
  listEvents,
  getTask,
  updateTask,
  type TasqDb,
} from "../src/index.js";

const tmpDirs: string[] = [];

afterEach(() => {
  while (tmpDirs.length > 0) {
    const d = tmpDirs.pop()!;
    rmSync(d, { recursive: true, force: true });
  }
});

async function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "tasq-test-"));
  tmpDirs.push(dir);
  const url = `file:${join(dir, "db.sqlite")}`;
  const handle = await openDb({ url, wal: false });
  await runMigrations(handle.client);
  return handle;
}

describe("tasq-zero smoke", () => {
  it("init + create area + create task + status transitions + event log", async () => {
    const { db, close } = await freshDb();
    try {
      // 1. Create area
      const corps = await createArea(db, {
        name: "Health — Body",
        slug: "body",
        importance: 5,
        cadenceTarget: "3x/week",
      });
      expect(corps.slug).toBe("body");
      expect(corps.importance).toBe(5);

      const areas = await listAreas(db);
      expect(areas).toHaveLength(1);

      // 2. Create task
      const t = await createTask(db, {
        title: "Réserver session escalade",
        nextAction: "Ouvrir app Climbing District, créneau 19h",
        areaId: corps.id,
        estimatedMinutes: 5,
      });
      expect(t.status).toBe("open");
      expect(t.startedAt).toBeNull();
      expect(t.completedAt).toBeNull();

      // 3. Start
      const started = await startTask(db, t.id, { actor: "hermes", note: "via daily-brief" });
      expect(started.status).toBe("in_progress");
      expect(started.startedAt).toBeGreaterThan(0);

      // 4. Block then unblock (status machine)
      const blocked = await blockTask(db, t.id, {
        actor: "gwendall",
        reason: "salle fermée",
      });
      expect(blocked.status).toBe("blocked");

      const unblocked = await unblockTask(db, t.id, { actor: "gwendall" });
      expect(unblocked.status).toBe("open");

      // 5. Complete (must transition through in_progress first to match the SM)
      const restarted = await startTask(db, t.id);
      expect(restarted.status).toBe("in_progress");

      const done = await completeTask(db, t.id, {
        actor: "hermes",
        note: "observed gym checkin",
        source: "watcher:calendar",
      });
      expect(done.status).toBe("done");
      expect(done.completedAt).toBeGreaterThan(0);

      // 6. Update (after completion is allowed)
      const updated = await updateTask(db, t.id, {
        nextAction: "Already done — leave for the record",
      });
      expect(updated.nextAction).toBe("Already done — leave for the record");

      // 7. Event log
      const events = await listEvents(db, { entityId: t.id, ascending: true });
      const types = events.map((e) => e.eventType);
      expect(types).toContain("created");
      expect(types).toContain("started");
      expect(types).toContain("blocked");
      expect(types).toContain("unblocked");
      expect(types).toContain("completed");
      expect(types).toContain("updated");
      // Actor diversity recorded
      const actors = new Set(events.map((e) => e.actor));
      expect(actors.has("gwendall")).toBe(true);
      expect(actors.has("hermes")).toBe(true);
    } finally {
      await close();
    }
  });

  it("listTasks filters by status + area", async () => {
    const { db, close } = await freshDb();
    try {
      const a = await createArea(db, { name: "Career", slug: "career", importance: 5 });
      const b = await createArea(db, { name: "Money", slug: "money", importance: 3 });

      await createTask(db, { title: "t1", areaId: a.id });
      await createTask(db, { title: "t2", areaId: a.id });
      const t3 = await createTask(db, { title: "t3", areaId: b.id });
      await completeTask(db, await ensureInProgress(db, t3.id));

      const careerOpen = await listTasks(db, { areaId: a.id, status: "open" });
      expect(careerOpen).toHaveLength(2);

      const moneyDone = await listTasks(db, { areaId: b.id, status: "done" });
      expect(moneyDone).toHaveLength(1);

      const allOpen = await listTasks(db, { status: "open" });
      expect(allOpen).toHaveLength(2);
    } finally {
      await close();
    }
  });

  it("listTasks hides deferred tasks (scheduledAt > now) by default", async () => {
    const { db, close } = await freshDb();
    try {
      const DAY_MS = 24 * 60 * 60 * 1000;
      const baseNow = Date.now();
      const a = await createArea(db, { name: "X", slug: "x", importance: 3 });
      await createTask(db, { title: "now-task", areaId: a.id });
      await createTask(db, {
        title: "deferred-task",
        areaId: a.id,
        scheduledAt: baseNow + 7 * DAY_MS,
      });

      const visible = await listTasks(db, { now: baseNow });
      expect(visible.map((t) => t.title)).toEqual(["now-task"]);

      const all = await listTasks(db, { now: baseNow, includeScheduled: true });
      expect(all.map((t) => t.title).sort()).toEqual(["deferred-task", "now-task"]);
    } finally {
      await close();
    }
  });

  it("applies the deferred-task filter before LIMIT", async () => {
    const { db, close } = await freshDb();
    try {
      const now = Date.now();
      await createTask(db, { title: "visible" });
      await createTask(db, { title: "newer-but-deferred", scheduledAt: now + 86_400_000 });

      const page = await listTasks(db, { now, limit: 1 });
      expect(page.map((t) => t.title)).toEqual(["visible"]);
    } finally {
      await close();
    }
  });

  it("rejects invalid status transitions", async () => {
    const { db, close } = await freshDb();
    try {
      const a = await createArea(db, { name: "X", slug: "x", importance: 1 });
      const t = await createTask(db, { title: "blocked from start?", areaId: a.id });
      // open → done directly is *allowed* by our SM (skip in_progress is OK)
      const done = await completeTask(db, t.id);
      expect(done.status).toBe("done");
      // done → blocked is NOT allowed
      await expect(blockTask(db, t.id)).rejects.toThrow(/Invalid task status transition/);
    } finally {
      await close();
    }
  });

  it("rejects creating a task directly in an engine-owned status", async () => {
    const { db, close } = await freshDb();
    try {
      await expect(createTask(db, { title: "invalid import", status: "done" })).rejects.toThrow(
        /must be created open/,
      );
    } finally {
      await close();
    }
  });

  it("soft-delete + restore round-trip for area, goal, project", async () => {
    const { db, close } = await freshDb();
    try {
      const a = await createArea(db, { name: "X", slug: "x", importance: 3 });
      await softDeleteArea(db, a.id);
      expect((await getArea(db, a.id))?.deletedAt).not.toBeNull();
      await restoreArea(db, a.id);
      expect((await getArea(db, a.id))?.deletedAt).toBeNull();

      const g = await createGoal(db, { areaId: a.id, title: "G" });
      await softDeleteGoal(db, g.id);
      expect((await getGoal(db, g.id))?.deletedAt).not.toBeNull();
      await restoreGoal(db, g.id);
      expect((await getGoal(db, g.id))?.deletedAt).toBeNull();

      const p = await createProject(db, { title: "P", areaId: a.id });
      await softDeleteProject(db, p.id);
      expect((await getProject(db, p.id))?.deletedAt).not.toBeNull();
      await restoreProject(db, p.id);
      expect((await getProject(db, p.id))?.deletedAt).toBeNull();
    } finally {
      await close();
    }
  });
});

// Helper: bring a task to in_progress so completeTask is allowed from any starting state.
async function ensureInProgress(db: TasqDb, id: string): Promise<string> {
  const t = await getTask(db, id);
  if (!t) throw new Error("missing task");
  if (t.status === "open") {
    await startTask(db, id);
  }
  return id;
}

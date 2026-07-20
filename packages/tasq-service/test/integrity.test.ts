/**
 * Soft-delete integrity tests.
 *
 * Three invariants enforced by this milestone item:
 *   1. softDelete BLOCKS (default) when live children reference the row;
 *      CASCADE (opt-in) tombstones the whole live subtree in one transaction,
 *      one `deleted` event per entity, reversible per-row (SPEC §4.4 / §8.2).
 *   2. create/update/reparent against a soft-deleted areaId/goalId/projectId
 *      (or a soft-deleted parent task) is rejected.
 *   3. the prioritizer does not load tombstoned goals/areas, so leverage falls
 *      back to area-or-default importance and the misleading `goal-importance:`
 *      reason-trace is suppressed.
 *
 * Harness mirrors smoke.test.ts: a fresh file-backed LibSQL per test.
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
  softDeleteArea,
  restoreArea,
  createGoal,
  getGoal,
  softDeleteGoal,
  restoreGoal,
  createProject,
  getProject,
  updateProject,
  softDeleteProject,
  restoreProject,
  createTask,
  getTask,
  updateTask,
  softDeleteTask,
  restoreTask,
  listEvents,
  pickNext,
} from "../src/index.js";

const tmpDirs: string[] = [];

afterEach(() => {
  while (tmpDirs.length > 0) {
    const d = tmpDirs.pop()!;
    rmSync(d, { recursive: true, force: true });
  }
});

async function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "tasq-integrity-"));
  tmpDirs.push(dir);
  const url = `file:${join(dir, "db.sqlite")}`;
  const handle = await openDb({ url, wal: false });
  await runMigrations(handle.client);
  return handle;
}

/** Build an area → goal → project → task chain. */
async function chain(db: Parameters<typeof createArea>[0]) {
  const area = await createArea(db, { name: "A", slug: "a", importance: 5 });
  const goal = await createGoal(db, { areaId: area.id, title: "G", importance: 5 });
  const project = await createProject(db, { title: "P", areaId: area.id, goalId: goal.id });
  const task = await createTask(db, {
    title: "T",
    areaId: area.id,
    goalId: goal.id,
    projectId: project.id,
  });
  return { area, goal, project, task };
}

describe("soft-delete integrity — block (default)", () => {
  it("softDeleteArea throws and tombstones nothing when live children exist", async () => {
    const { db, close } = await freshDb();
    try {
      const { area, goal, project, task } = await chain(db);
      await expect(softDeleteArea(db, area.id)).rejects.toThrow(/live/i);

      // Nothing tombstoned.
      expect((await getArea(db, area.id))?.deletedAt).toBeNull();
      expect((await getGoal(db, goal.id))?.deletedAt).toBeNull();
      expect((await getProject(db, project.id))?.deletedAt).toBeNull();
      expect((await getTask(db, task.id))?.deletedAt).toBeNull();
    } finally {
      await close();
    }
  });

  it("softDeleteGoal throws when a live project/task references it", async () => {
    const { db, close } = await freshDb();
    try {
      const { goal, project, task } = await chain(db);
      await expect(softDeleteGoal(db, goal.id)).rejects.toThrow(/live/i);
      expect((await getGoal(db, goal.id))?.deletedAt).toBeNull();
      expect((await getProject(db, project.id))?.deletedAt).toBeNull();
      expect((await getTask(db, task.id))?.deletedAt).toBeNull();
    } finally {
      await close();
    }
  });

  it("softDeleteProject throws when a live task references it", async () => {
    const { db, close } = await freshDb();
    try {
      const { project, task } = await chain(db);
      await expect(softDeleteProject(db, project.id)).rejects.toThrow(/live task/i);
      expect((await getProject(db, project.id))?.deletedAt).toBeNull();
      expect((await getTask(db, task.id))?.deletedAt).toBeNull();
    } finally {
      await close();
    }
  });

  it("softDeleteTask throws when a live subtask references it", async () => {
    const { db, close } = await freshDb();
    try {
      const a = await createArea(db, { name: "A", slug: "a" });
      const parent = await createTask(db, { title: "parent", areaId: a.id });
      const child = await createTask(db, { title: "child", parentTaskId: parent.id });
      await expect(softDeleteTask(db, parent.id)).rejects.toThrow(/live subtask/i);
      expect((await getTask(db, parent.id))?.deletedAt).toBeNull();
      expect((await getTask(db, child.id))?.deletedAt).toBeNull();
    } finally {
      await close();
    }
  });

  it("softDelete on a childless row still succeeds (no false block)", async () => {
    const { db, close } = await freshDb();
    try {
      const a = await createArea(db, { name: "X", slug: "x" });
      await softDeleteArea(db, a.id); // no children → allowed
      expect((await getArea(db, a.id))?.deletedAt).not.toBeNull();
    } finally {
      await close();
    }
  });
});

describe("soft-delete integrity — cascade (opt-in)", () => {
  it("softDeleteArea({cascade}) tombstones the whole subtree, one event each", async () => {
    const { db, close } = await freshDb();
    try {
      const { area, goal, project, task } = await chain(db);
      await softDeleteArea(db, area.id, { cascade: true });

      expect((await getArea(db, area.id))?.deletedAt).not.toBeNull();
      expect((await getGoal(db, goal.id))?.deletedAt).not.toBeNull();
      expect((await getProject(db, project.id))?.deletedAt).not.toBeNull();
      expect((await getTask(db, task.id))?.deletedAt).not.toBeNull();

      // Exactly one `deleted` event per entity — proves service-layer cascade,
      // not a raw bulk UPDATE.
      for (const id of [area.id, goal.id, project.id, task.id]) {
        const deletes = (await listEvents(db, { entityId: id })).filter(
          (e) => e.eventType === "deleted",
        );
        expect(deletes).toHaveLength(1);
      }
    } finally {
      await close();
    }
  });

  it("softDeleteGoal({cascade}) tombstones its projects + tasks but not the area", async () => {
    const { db, close } = await freshDb();
    try {
      const { area, goal, project, task } = await chain(db);
      await softDeleteGoal(db, goal.id, { cascade: true });

      expect((await getArea(db, area.id))?.deletedAt).toBeNull(); // ancestor untouched
      expect((await getGoal(db, goal.id))?.deletedAt).not.toBeNull();
      expect((await getProject(db, project.id))?.deletedAt).not.toBeNull();
      expect((await getTask(db, task.id))?.deletedAt).not.toBeNull();
    } finally {
      await close();
    }
  });

  it("softDeleteProject({cascade}) tombstones its tasks but not the goal/area", async () => {
    const { db, close } = await freshDb();
    try {
      const { area, goal, project, task } = await chain(db);
      await softDeleteProject(db, project.id, { cascade: true });

      expect((await getArea(db, area.id))?.deletedAt).toBeNull();
      expect((await getGoal(db, goal.id))?.deletedAt).toBeNull();
      expect((await getProject(db, project.id))?.deletedAt).not.toBeNull();
      expect((await getTask(db, task.id))?.deletedAt).not.toBeNull();
    } finally {
      await close();
    }
  });

  it("softDeleteTask({cascade}) tombstones the subtask subtree", async () => {
    const { db, close } = await freshDb();
    try {
      const a = await createArea(db, { name: "A", slug: "a" });
      const parent = await createTask(db, { title: "parent", areaId: a.id });
      const child = await createTask(db, { title: "child", parentTaskId: parent.id });
      await softDeleteTask(db, parent.id, { cascade: true });
      expect((await getTask(db, parent.id))?.deletedAt).not.toBeNull();
      expect((await getTask(db, child.id))?.deletedAt).not.toBeNull();
    } finally {
      await close();
    }
  });

  it("cascade is idempotent: a pre-deleted descendant keeps its original tombstone, no duplicate event", async () => {
    const { db, close } = await freshDb();
    try {
      const { area, task } = await chain(db);
      // Pre-delete the task on its own.
      await softDeleteTask(db, task.id);
      const before = await getTask(db, task.id);
      expect(before?.deletedAt).not.toBeNull();
      const originalDeletedAt = before!.deletedAt;

      // Sleep so a re-tombstone (if it happened) would carry a different ts.
      await new Promise((r) => setTimeout(r, 5));

      await softDeleteArea(db, area.id, { cascade: true });

      const after = await getTask(db, task.id);
      expect(after?.deletedAt).toBe(originalDeletedAt!); // unchanged

      const taskDeletes = (await listEvents(db, { entityId: task.id })).filter(
        (e) => e.eventType === "deleted",
      );
      expect(taskDeletes).toHaveLength(1); // not double-emitted
    } finally {
      await close();
    }
  });

  it("cascade is reversible per-row (restore each within the 90-day window)", async () => {
    const { db, close } = await freshDb();
    try {
      const { area, goal, project, task } = await chain(db);
      await softDeleteArea(db, area.id, { cascade: true });

      await restoreArea(db, area.id);
      await restoreGoal(db, goal.id);
      await restoreProject(db, project.id);
      await restoreTask(db, task.id);

      expect((await getArea(db, area.id))?.deletedAt).toBeNull();
      expect((await getGoal(db, goal.id))?.deletedAt).toBeNull();
      expect((await getProject(db, project.id))?.deletedAt).toBeNull();
      expect((await getTask(db, task.id))?.deletedAt).toBeNull();
    } finally {
      await close();
    }
  });
});

describe("soft-delete integrity — create/update/reparent rejection", () => {
  it("createTask rejects an explicitly soft-deleted goalId / areaId / projectId", async () => {
    const { db, close } = await freshDb();
    try {
      const area = await createArea(db, { name: "A", slug: "a" });
      const goal = await createGoal(db, { areaId: area.id, title: "G" });
      const project = await createProject(db, { title: "P", areaId: area.id });

      // Delete each childless target, then try to create a task against it.
      await softDeleteGoal(db, goal.id);
      await expect(createTask(db, { title: "t", goalId: goal.id })).rejects.toThrow(
        /Goal is deleted/,
      );

      await softDeleteProject(db, project.id);
      await expect(createTask(db, { title: "t", projectId: project.id })).rejects.toThrow(
        /Project is deleted/,
      );

      // Area has a live goal/project still — but both are now deleted; also no
      // live tasks. Delete the area and assert create rejects.
      await softDeleteArea(db, area.id, { cascade: true });
      await expect(createTask(db, { title: "t", areaId: area.id })).rejects.toThrow(
        /Area is deleted/,
      );
    } finally {
      await close();
    }
  });

  it("restoreTask rejects making a task live under a tombstoned goal", async () => {
    const { db, close } = await freshDb();
    try {
      const area = await createArea(db, { name: "A", slug: "a" });
      const goal = await createGoal(db, { areaId: area.id, title: "G" });
      const parent = await createTask(db, { title: "parent", areaId: area.id, goalId: goal.id });

      await softDeleteGoal(db, goal.id, { cascade: true });
      await expect(restoreTask(db, parent.id)).rejects.toThrow(
        /Goal is deleted/,
      );
      expect((await getTask(db, parent.id))?.deletedAt).not.toBeNull();
    } finally {
      await close();
    }
  });

  it("updateTask rejects re-anchoring onto a tombstoned goal/area/project", async () => {
    const { db, close } = await freshDb();
    try {
      const area = await createArea(db, { name: "A", slug: "a" });
      const goal = await createGoal(db, { areaId: area.id, title: "G" });
      const project = await createProject(db, { title: "P", areaId: area.id });
      const t = await createTask(db, { title: "t", areaId: area.id });

      await softDeleteGoal(db, goal.id);
      await expect(updateTask(db, t.id, { goalId: goal.id })).rejects.toThrow(/Goal is deleted/);

      await softDeleteProject(db, project.id);
      await expect(updateTask(db, t.id, { projectId: project.id })).rejects.toThrow(
        /Project is deleted/,
      );
    } finally {
      await close();
    }
  });

  it("updateTask rejects reparenting onto a soft-deleted parent task", async () => {
    const { db, close } = await freshDb();
    try {
      const a = await createArea(db, { name: "A", slug: "a" });
      const deadParent = await createTask(db, { title: "dead", areaId: a.id });
      const child = await createTask(db, { title: "child", areaId: a.id });
      await softDeleteTask(db, deadParent.id);
      await expect(updateTask(db, child.id, { parentTaskId: deadParent.id })).rejects.toThrow(
        /Parent task is deleted/,
      );
    } finally {
      await close();
    }
  });

  it("createProject rejects a soft-deleted areaId / goalId; createGoal rejects a soft-deleted areaId", async () => {
    const { db, close } = await freshDb();
    try {
      const area = await createArea(db, { name: "A", slug: "a" });
      const goal = await createGoal(db, { areaId: area.id, title: "G" });

      await softDeleteGoal(db, goal.id);
      await expect(
        createProject(db, { title: "P", areaId: area.id, goalId: goal.id }),
      ).rejects.toThrow(/Goal is deleted/);

      // Delete area (it has the dead goal but no live children).
      await softDeleteArea(db, area.id, { cascade: true });
      await expect(createProject(db, { title: "P", areaId: area.id })).rejects.toThrow(
        /Area is deleted/,
      );
      await expect(createGoal(db, { areaId: area.id, title: "G2" })).rejects.toThrow(
        /Area is deleted/,
      );
    } finally {
      await close();
    }
  });

  it("updateProject rejects re-anchoring onto a tombstoned area/goal", async () => {
    const { db, close } = await freshDb();
    try {
      const area = await createArea(db, { name: "A", slug: "a" });
      const goal = await createGoal(db, { areaId: area.id, title: "G" });
      const p = await createProject(db, { title: "P", areaId: area.id });

      await softDeleteGoal(db, goal.id);
      await expect(updateProject(db, p.id, { goalId: goal.id })).rejects.toThrow(
        /Goal is deleted/,
      );
    } finally {
      await close();
    }
  });
});

describe("soft-delete integrity — dead ancestors cannot anchor live tasks", () => {
  it("keeps a cascaded task tombstoned until its goal is restored", async () => {
    const { db, close } = await freshDb();
    try {
      const area = await createArea(db, { name: "A", slug: "a", importance: 3 });
      const goal = await createGoal(db, { areaId: area.id, title: "G", importance: 5 });
      const t = await createTask(db, { title: "t", areaId: area.id, goalId: goal.id });

      await softDeleteGoal(db, goal.id, { cascade: true });
      await expect(restoreTask(db, t.id)).rejects.toThrow(/Goal is deleted/);

      const results = await pickNext(db, { now: Date.now() });
      expect(results.some((x) => x.task.id === t.id)).toBe(false);
    } finally {
      await close();
    }
  });

  it("control: a LIVE importance-5 goal DOES drive leverage 5 and prints the reason", async () => {
    const { db, close } = await freshDb();
    try {
      const area = await createArea(db, { name: "A", slug: "a", importance: 3 });
      const goal = await createGoal(db, { areaId: area.id, title: "G", importance: 5 });
      const t = await createTask(db, { title: "t", areaId: area.id, goalId: goal.id });

      const results = await pickNext(db, { now: Date.now() });
      const r = results.find((x) => x.task.id === t.id);
      expect(r).toBeDefined();
      expect(r!.goal?.importance).toBe(5);
      expect(r!.score.leverage).toBe(5);
      expect(r!.score.reasons).toContain("goal-importance:5");
    } finally {
      await close();
    }
  });
});

describe("canonical ancestry", () => {
  it("derives project and task goal/area instead of storing contradictory scopes", async () => {
    const { db, close } = await freshDb();
    try {
      const area = await createArea(db, { name: "A", slug: "a" });
      const other = await createArea(db, { name: "B", slug: "b" });
      const goal = await createGoal(db, { areaId: area.id, title: "G" });
      const project = await createProject(db, { title: "P", goalId: goal.id });
      expect(project.areaId).toBe(area.id);

      const task = await createTask(db, { title: "T", projectId: project.id });
      expect(task.goalId).toBe(goal.id);
      expect(task.areaId).toBe(area.id);

      await expect(
        createTask(db, { title: "bad", projectId: project.id, areaId: other.id }),
      ).rejects.toThrow(/must match project/);
    } finally {
      await close();
    }
  });

  it("propagates a project scope change to its tasks", async () => {
    const { db, close } = await freshDb();
    try {
      const a = await createArea(db, { name: "A", slug: "a" });
      const b = await createArea(db, { name: "B", slug: "b" });
      const g1 = await createGoal(db, { areaId: a.id, title: "G1" });
      const g2 = await createGoal(db, { areaId: b.id, title: "G2" });
      const p = await createProject(db, { title: "P", goalId: g1.id });
      const t = await createTask(db, { title: "T", projectId: p.id });

      await updateProject(db, p.id, { goalId: g2.id });
      const moved = await getTask(db, t.id);
      expect(moved?.goalId).toBe(g2.id);
      expect(moved?.areaId).toBe(b.id);
    } finally {
      await close();
    }
  });
});

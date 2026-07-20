/**
 * Exhaustive state machine tests for Task / Goal / Project.
 *
 * Each entity has an explicit transition table. We test:
 *   1. Every allowed transition succeeds and emits the right event type
 *   2. Every forbidden transition throws with a clear message
 *   3. Side effects fire on the correct transitions (startedAt, completedAt)
 *   4. Status events carry before/after payloads
 */

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  openDb,
  runMigrations,
  createArea,
  createGoal,
  createProject,
  createTask,
  getTask,
  startTask,
  completeTask,
  blockTask,
  unblockTask,
  cancelTask,
  reopenTask,
  updateGoal,
  updateProject,
  listEvents,
  type Task,
  type TasqDb,
  type TaskStatus,
  type GoalStatus,
  type ProjectStatus,
} from "../src/index.js";

const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length > 0) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

async function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "tasq-sm-"));
  tmpDirs.push(dir);
  const h = await openDb({ url: `file:${join(dir, "db.sqlite")}`, wal: false });
  await runMigrations(h.client);
  return h;
}

async function makeArea(db: TasqDb, slug: string) {
  return createArea(db, { name: slug, slug, importance: 3 });
}

// ──────────────────────────────────────────────────────────────────────
// TASK state machine
// ──────────────────────────────────────────────────────────────────────

describe("Task state machine", () => {
  const TASK_TRANSITIONS: ReadonlyArray<[TaskStatus, TaskStatus, boolean]> = [
    // [from, to, allowed]
    ["open", "in_progress", true],
    ["open", "blocked", true],
    ["open", "done", true],
    ["open", "cancelled", true],

    ["in_progress", "open", true],
    ["in_progress", "blocked", true],
    ["in_progress", "done", true],
    ["in_progress", "cancelled", true],

    ["blocked", "open", true],
    ["blocked", "in_progress", true],
    ["blocked", "done", true],
    ["blocked", "cancelled", true],

    ["done", "open", true],
    ["done", "in_progress", true],
    ["done", "blocked", false],
    ["done", "cancelled", false],

    ["cancelled", "open", true],
    ["cancelled", "in_progress", false],
    ["cancelled", "done", false],
    ["cancelled", "blocked", false],
  ];

  for (const [from, to, allowed] of TASK_TRANSITIONS) {
    it(`${from} → ${to}: ${allowed ? "allowed" : "rejected"}`, async () => {
      const { db, close } = await freshDb();
      try {
        const area = await makeArea(db, "x");
        let task = await createTask(db, { title: "t", areaId: area.id });

        // Drive task to the `from` state
        task = await driveToState(db, task.id, from);
        expect(task.status).toBe(from);

        // Attempt transition to `to`
        if (allowed) {
          const result = await tryTransition(db, task.id, to);
          expect(result.status).toBe(to);
        } else {
          await expect(tryTransition(db, task.id, to)).rejects.toThrow(/Invalid task status transition/);
        }
      } finally {
        await close();
      }
    });
  }

  it("side effects: in_progress sets startedAt, done sets completedAt", async () => {
    const { db, close } = await freshDb();
    try {
      const area = await makeArea(db, "x");
      const t = await createTask(db, { title: "t", areaId: area.id });
      expect(t.startedAt).toBeNull();
      expect(t.completedAt).toBeNull();

      const started = await startTask(db, t.id);
      expect(started.startedAt).toBeGreaterThan(0);

      const done = await completeTask(db, t.id);
      expect(done.completedAt).toBeGreaterThan(0);
    } finally {
      await close();
    }
  });

  it("reopen from done clears completedAt", async () => {
    const { db, close } = await freshDb();
    try {
      const area = await makeArea(db, "x");
      const t = await createTask(db, { title: "t", areaId: area.id });
      await completeTask(db, t.id);
      const reopened = await reopenTask(db, t.id);
      expect(reopened.status).toBe("open");
      expect(reopened.completedAt).toBeNull();
    } finally {
      await close();
    }
  });

  it("events carry before/after status in payload", async () => {
    const { db, close } = await freshDb();
    try {
      const area = await makeArea(db, "x");
      const t = await createTask(db, { title: "t", areaId: area.id });
      await startTask(db, t.id, { reason: "ready to ship" });
      const events = await listEvents(db, { entityId: t.id, ascending: true });
      const started = events.find((e) => e.eventType === "started");
      expect(started).toBeDefined();
      expect(started!.payload.before).toEqual({ status: "open" });
      expect(started!.payload.after).toEqual({ status: "in_progress" });
      expect(started!.payload.reason).toBe("ready to ship");
    } finally {
      await close();
    }
  });

  it("separates supplied domain time from event recording time", async () => {
    const { db, close } = await freshDb();
    try {
      const occurredAt = Date.UTC(2025, 0, 2, 12);
      const t = await createTask(db, { title: "backfilled completion" });
      const done = await completeTask(db, t.id, { occurredAt });
      expect(done.completedAt).toBe(occurredAt);
      const events = await listEvents(db, { entityId: t.id, ascending: true });
      const completion = events.find((event) => event.eventType === "completed")!;
      expect(completion.occurredAt).toBe(occurredAt);
      expect(completion.createdAt).toBeGreaterThan(occurredAt);
    } finally {
      await close();
    }
  });
});

// ──────────────────────────────────────────────────────────────────────
// GOAL state machine
// ──────────────────────────────────────────────────────────────────────

describe("Goal state machine", () => {
  const GOAL_TRANSITIONS: ReadonlyArray<[GoalStatus, GoalStatus, boolean]> = [
    ["active", "paused", true],
    ["active", "done", true],
    ["active", "abandoned", true],

    ["paused", "active", true],
    ["paused", "done", true],
    ["paused", "abandoned", true],

    ["done", "active", true],
    ["done", "paused", false],
    ["done", "abandoned", false],

    ["abandoned", "active", true],
    ["abandoned", "paused", false],
    ["abandoned", "done", false],
  ];

  for (const [from, to, allowed] of GOAL_TRANSITIONS) {
    it(`goal ${from} → ${to}: ${allowed ? "allowed" : "rejected"}`, async () => {
      const { db, close } = await freshDb();
      try {
        const area = await makeArea(db, "x");
        const g = await createGoal(db, { areaId: area.id, title: "g", status: "active" });

        // Drive to `from` (transitions through active are needed)
        await driveGoalToState(db, g.id, from);

        if (allowed) {
          const updated = await updateGoal(db, g.id, { status: to });
          expect(updated.status).toBe(to);
        } else {
          await expect(updateGoal(db, g.id, { status: to })).rejects.toThrow(
            /Invalid goal status transition/,
          );
        }
      } finally {
        await close();
      }
    });
  }
});

// ──────────────────────────────────────────────────────────────────────
// PROJECT state machine
// ──────────────────────────────────────────────────────────────────────

describe("Project state machine", () => {
  const PROJECT_TRANSITIONS: ReadonlyArray<[ProjectStatus, ProjectStatus, boolean]> = [
    ["active", "blocked", true],
    ["active", "waiting", true],
    ["active", "done", true],
    ["active", "cancelled", true],

    ["blocked", "active", true],
    ["blocked", "waiting", true],
    ["blocked", "done", true],
    ["blocked", "cancelled", true],

    ["waiting", "active", true],
    ["waiting", "blocked", true],
    ["waiting", "done", true],
    ["waiting", "cancelled", true],

    ["done", "active", true],
    ["done", "blocked", false],

    ["cancelled", "active", true],
    ["cancelled", "blocked", false],
  ];

  for (const [from, to, allowed] of PROJECT_TRANSITIONS) {
    it(`project ${from} → ${to}: ${allowed ? "allowed" : "rejected"}`, async () => {
      const { db, close } = await freshDb();
      try {
        const area = await makeArea(db, "x");
        const p = await createProject(db, { title: "p", areaId: area.id, status: "active" });
        await driveProjectToState(db, p.id, from);

        if (allowed) {
          const updated = await updateProject(db, p.id, { status: to });
          expect(updated.status).toBe(to);
        } else {
          await expect(updateProject(db, p.id, { status: to })).rejects.toThrow(
            /Invalid project status transition/,
          );
        }
      } finally {
        await close();
      }
    });
  }
});

// ──────────────────────────────────────────────────────────────────────
// Helpers — drive an entity to a target state via valid transitions
// ──────────────────────────────────────────────────────────────────────

async function tryTransition(db: TasqDb, id: string, to: TaskStatus) {
  switch (to) {
    case "in_progress":
      return startTask(db, id);
    case "done":
      return completeTask(db, id);
    case "blocked":
      return blockTask(db, id);
    case "cancelled":
      return cancelTask(db, id);
    case "open":
      return reopenTask(db, id);
  }
}

/**
 * Drive a freshly-created task (default status `open`) to the target state
 * via the canonical single-step transition. Throws if the path can't be
 * achieved (which would mean the test setup is buggy, not the SM).
 */
async function driveToState(db: TasqDb, id: string, target: TaskStatus): Promise<Task> {
  if (target === "open") {
    // Tasks start as `open` ; just return the current row.
    const t = await getTask(db, id);
    if (!t) throw new Error(`task disappeared during driveToState: ${id}`);
    return t;
  }
  if (target === "in_progress") return startTask(db, id);
  if (target === "blocked") return blockTask(db, id);
  if (target === "done") return completeTask(db, id);
  if (target === "cancelled") return cancelTask(db, id);
  // Exhaustive — typeguard ensures the above are the only TaskStatus values.
  const _exhaustive: never = target;
  throw new Error(`unreachable target ${_exhaustive}`);
}

async function driveGoalToState(db: TasqDb, id: string, target: GoalStatus) {
  if (target === "active") return;
  await updateGoal(db, id, { status: target });
}

async function driveProjectToState(db: TasqDb, id: string, target: ProjectStatus) {
  if (target === "active") return;
  await updateProject(db, id, { status: target });
}

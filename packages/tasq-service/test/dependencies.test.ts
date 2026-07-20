/**
 * First-class peer task dependencies (SPEC §4.5).
 *
 * Covers edge CRUD + natural-key idempotency, self-edge / missing-endpoint
 * rejection, the `blocks` cycle guard (and that relates_to/duplicates are NOT
 * cycle-checked), open-vocab event emission (entityType='task'), the
 * unresolved-blocker count + the "just unblocked" surfacing, and the explicit
 * "no automatic coupling" invariant (a blocks-dep never flips status).
 */

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  openDb,
  runMigrations,
  createArea,
  createTask,
  completeTask,
  cancelTask,
  getTask,
  dependTask,
  undependTask,
  listDependencies,
  unresolvedBlockerCount,
  unresolvedBlockerMap,
  justUnblocked,
  listEvents,
} from "../src/index.js";

const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length > 0) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

async function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "tasq-dep-"));
  tmpDirs.push(dir);
  const h = await openDb({ url: `file:${join(dir, "db.sqlite")}`, wal: false });
  await runMigrations(h.client);
  return h;
}

async function twoTasks(db: Parameters<typeof createTask>[0]) {
  const area = await createArea(db, { name: "Kami", slug: "kami", importance: 5 });
  const a = await createTask(db, { title: "Task A", areaId: area.id });
  const b = await createTask(db, { title: "Task B", areaId: area.id });
  return { a, b };
}

describe("dependency edge CRUD", () => {
  it("creates a blocks edge with the natural key", async () => {
    const { db, close } = await freshDb();
    try {
      const { a, b } = await twoTasks(db);
      const edge = await dependTask(db, { fromTaskId: a.id, toTaskId: b.id });
      expect(edge.fromTaskId).toBe(a.id);
      expect(edge.toTaskId).toBe(b.id);
      expect(edge.type).toBe("blocks");
      expect(edge.deletedAt).toBeNull();
    } finally {
      await close();
    }
  });

  it("creates relates_to and duplicates edges", async () => {
    const { db, close } = await freshDb();
    try {
      const { a, b } = await twoTasks(db);
      const rel = await dependTask(db, { fromTaskId: a.id, toTaskId: b.id, type: "relates_to" });
      const dup = await dependTask(db, { fromTaskId: a.id, toTaskId: b.id, type: "duplicates" });
      expect(rel.type).toBe("relates_to");
      expect(dup.type).toBe("duplicates");
      const edges = await listDependencies(db, { taskId: a.id, direction: "from" });
      expect(edges.map((e) => e.type).sort()).toEqual(["duplicates", "relates_to"]);
    } finally {
      await close();
    }
  });

  it("is idempotent on the natural key (re-add does not duplicate)", async () => {
    const { db, close } = await freshDb();
    try {
      const { a, b } = await twoTasks(db);
      const first = await dependTask(db, { fromTaskId: a.id, toTaskId: b.id });
      const second = await dependTask(db, { fromTaskId: a.id, toTaskId: b.id });
      expect(second.id).toBe(first.id);
      const edges = await listDependencies(db, { taskId: a.id, direction: "from", type: "blocks" });
      expect(edges).toHaveLength(1);
    } finally {
      await close();
    }
  });

  it("rejects a self-edge", async () => {
    const { db, close } = await freshDb();
    try {
      const { a } = await twoTasks(db);
      await expect(
        dependTask(db, { fromTaskId: a.id, toTaskId: a.id }),
      ).rejects.toThrow(/itself|cycle/i);
    } finally {
      await close();
    }
  });

  it("rejects a non-existent endpoint", async () => {
    const { db, close } = await freshDb();
    try {
      const { a } = await twoTasks(db);
      await expect(
        dependTask(db, { fromTaskId: a.id, toTaskId: "01900000-0000-7000-8000-000000000000" }),
      ).rejects.toThrow(/not found/i);
    } finally {
      await close();
    }
  });
});

describe("cycle guard (blocks only)", () => {
  it("rejects one side of concurrent opposite blocks edges", async () => {
    const { db, close } = await freshDb();
    try {
      const a = await createTask(db, { title: "A" });
      const b = await createTask(db, { title: "B" });
      const outcomes = await Promise.allSettled([
        dependTask(db, { fromTaskId: a.id, toTaskId: b.id, type: "blocks" }),
        dependTask(db, { fromTaskId: b.id, toTaskId: a.id, type: "blocks" }),
      ]);
      expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);
      expect(outcomes.filter((o) => o.status === "rejected")).toHaveLength(1);
    } finally {
      await close();
    }
  });

  it("rejects a direct A→B, B→A blocks cycle", async () => {
    const { db, close } = await freshDb();
    try {
      const { a, b } = await twoTasks(db);
      await dependTask(db, { fromTaskId: a.id, toTaskId: b.id });
      await expect(
        dependTask(db, { fromTaskId: b.id, toTaskId: a.id }),
      ).rejects.toThrow(/cycle/i);
    } finally {
      await close();
    }
  });

  it("rejects a transitive A→B→C→A blocks cycle", async () => {
    const { db, close } = await freshDb();
    try {
      const area = await createArea(db, { name: "K", slug: "k", importance: 5 });
      const a = await createTask(db, { title: "A", areaId: area.id });
      const b = await createTask(db, { title: "B", areaId: area.id });
      const c = await createTask(db, { title: "C", areaId: area.id });
      await dependTask(db, { fromTaskId: a.id, toTaskId: b.id });
      await dependTask(db, { fromTaskId: b.id, toTaskId: c.id });
      await expect(
        dependTask(db, { fromTaskId: c.id, toTaskId: a.id }),
      ).rejects.toThrow(/cycle/i);
    } finally {
      await close();
    }
  });

  it("allows relates_to / duplicates 'cycles' (non-transitive, no guard)", async () => {
    const { db, close } = await freshDb();
    try {
      const { a, b } = await twoTasks(db);
      await dependTask(db, { fromTaskId: a.id, toTaskId: b.id, type: "relates_to" });
      // Reverse relates_to edge is fine.
      const reverse = await dependTask(db, { fromTaskId: b.id, toTaskId: a.id, type: "relates_to" });
      expect(reverse.type).toBe("relates_to");
      const dup = await dependTask(db, { fromTaskId: a.id, toTaskId: b.id, type: "duplicates" });
      const dupReverse = await dependTask(db, { fromTaskId: b.id, toTaskId: a.id, type: "duplicates" });
      expect(dup.id).not.toBe(dupReverse.id);
    } finally {
      await close();
    }
  });
});

describe("soft-delete + reactivation", () => {
  it("undepend soft-deletes and a re-add reactivates the same row", async () => {
    const { db, close } = await freshDb();
    try {
      const { a, b } = await twoTasks(db);
      const edge = await dependTask(db, { fromTaskId: a.id, toTaskId: b.id });
      await undependTask(db, null, { fromTaskId: a.id, toTaskId: b.id, type: "blocks" });

      // Default list excludes the soft-deleted edge.
      expect(await listDependencies(db, { taskId: a.id, direction: "from" })).toHaveLength(0);
      // Re-add reactivates the same id (partial UNIQUE survives soft-delete).
      const reAdded = await dependTask(db, { fromTaskId: a.id, toTaskId: b.id });
      expect(reAdded.id).toBe(edge.id);
      expect(reAdded.deletedAt).toBeNull();
      expect(await listDependencies(db, { taskId: a.id, direction: "from" })).toHaveLength(1);
    } finally {
      await close();
    }
  });

  it("undepend on a missing edge throws", async () => {
    const { db, close } = await freshDb();
    try {
      const { a, b } = await twoTasks(db);
      await expect(
        undependTask(db, null, { fromTaskId: a.id, toTaskId: b.id, type: "blocks" }),
      ).rejects.toThrow(/not found/i);
    } finally {
      await close();
    }
  });
});

describe("open-vocab events (no enum migration)", () => {
  it("emits dependency_added / dependency_removed with entityType='task'", async () => {
    const { db, close } = await freshDb();
    try {
      const { a, b } = await twoTasks(db);
      await dependTask(db, { fromTaskId: a.id, toTaskId: b.id });
      await undependTask(db, null, { fromTaskId: a.id, toTaskId: b.id, type: "blocks" });

      const events = await listEvents(db, { entityType: "task", entityId: a.id });
      const types = events.map((e) => e.eventType);
      expect(types).toContain("dependency_added");
      expect(types).toContain("dependency_removed");
      // The open-vocab event_type works WITHOUT touching the entity_type CHECK:
      // every dependency event is attributed to a 'task' entity.
      for (const e of events.filter((ev) =>
        ev.eventType.startsWith("dependency_"),
      )) {
        expect(e.entityType).toBe("task");
        expect(e.entityId).toBe(a.id);
      }
    } finally {
      await close();
    }
  });
});

describe("unresolvedBlockerCount + map", () => {
  it("counts a live open blocker, drops to 0 on complete", async () => {
    const { db, close } = await freshDb();
    try {
      const { a, b } = await twoTasks(db);
      await dependTask(db, { fromTaskId: a.id, toTaskId: b.id });
      expect(await unresolvedBlockerCount(db, a.id)).toBe(1);

      await completeTask(db, b.id);
      expect(await unresolvedBlockerCount(db, a.id)).toBe(0);
    } finally {
      await close();
    }
  });

  it("counts a cancelled blocker as resolved", async () => {
    const { db, close } = await freshDb();
    try {
      const { a, b } = await twoTasks(db);
      await dependTask(db, { fromTaskId: a.id, toTaskId: b.id });
      await cancelTask(db, b.id, { reason: "obsolete" });
      expect(await unresolvedBlockerCount(db, a.id)).toBe(0);
    } finally {
      await close();
    }
  });

  it("unresolvedBlockerMap aggregates against supplied statuses (no N+1)", async () => {
    const { db, close } = await freshDb();
    try {
      const area = await createArea(db, { name: "K", slug: "k", importance: 5 });
      const a = await createTask(db, { title: "A", areaId: area.id });
      const b = await createTask(db, { title: "B", areaId: area.id });
      const c = await createTask(db, { title: "C", areaId: area.id });
      await dependTask(db, { fromTaskId: a.id, toTaskId: b.id });
      await dependTask(db, { fromTaskId: a.id, toTaskId: c.id });

      const statusById = new Map<string, string>([
        [b.id, "open"],
        [c.id, "done"], // resolved → not counted
      ]);
      const map = await unresolvedBlockerMap(db, "gwendall", statusById);
      expect(map.get(a.id)).toBe(1);
    } finally {
      await close();
    }
  });

  it("relates_to / duplicates edges never count as blockers", async () => {
    const { db, close } = await freshDb();
    try {
      const { a, b } = await twoTasks(db);
      await dependTask(db, { fromTaskId: a.id, toTaskId: b.id, type: "relates_to" });
      await dependTask(db, { fromTaskId: a.id, toTaskId: b.id, type: "duplicates" });
      expect(await unresolvedBlockerCount(db, a.id)).toBe(0);
    } finally {
      await close();
    }
  });
});

describe("justUnblocked", () => {
  it("surfaces a dependent whose only blocker just completed", async () => {
    const { db, close } = await freshDb();
    try {
      const { a, b } = await twoTasks(db);
      await dependTask(db, { fromTaskId: a.id, toTaskId: b.id });
      await completeTask(db, b.id);

      const set = await justUnblocked(db, {});
      expect(set.has(a.id)).toBe(true);
    } finally {
      await close();
    }
  });

  it("does NOT surface a task that still has an unresolved blocker", async () => {
    const { db, close } = await freshDb();
    try {
      const area = await createArea(db, { name: "K", slug: "k", importance: 5 });
      const a = await createTask(db, { title: "A", areaId: area.id });
      const b = await createTask(db, { title: "B", areaId: area.id });
      const c = await createTask(db, { title: "C", areaId: area.id });
      await dependTask(db, { fromTaskId: a.id, toTaskId: b.id });
      await dependTask(db, { fromTaskId: a.id, toTaskId: c.id });
      await completeTask(db, b.id); // one resolved, one still open

      const set = await justUnblocked(db, {});
      expect(set.has(a.id)).toBe(false);
    } finally {
      await close();
    }
  });

  it("does NOT surface a task whose blocker resolved before the recent window", async () => {
    const { db, close } = await freshDb();
    try {
      const { a, b } = await twoTasks(db);
      await dependTask(db, { fromTaskId: a.id, toTaskId: b.id });
      await completeTask(db, b.id);
      // Look far in the future so the resolution is older than the 7d window.
      const farFuture = Date.now() + 30 * 24 * 60 * 60 * 1000;
      const set = await justUnblocked(db, { now: farFuture });
      expect(set.has(a.id)).toBe(false);
    } finally {
      await close();
    }
  });
});

describe("no automatic coupling (SPEC §4.5)", () => {
  it("adding a blocks-dep does NOT flip the dependent's status to blocked", async () => {
    const { db, close } = await freshDb();
    try {
      const { a, b } = await twoTasks(db);
      await dependTask(db, { fromTaskId: a.id, toTaskId: b.id });
      const reloaded = await getTask(db, a.id);
      expect(reloaded?.status).toBe("open"); // unchanged, NOT 'blocked'
    } finally {
      await close();
    }
  });

  it("resolving a blocker does NOT flip the dependent's status", async () => {
    const { db, close } = await freshDb();
    try {
      const { a, b } = await twoTasks(db);
      await dependTask(db, { fromTaskId: a.id, toTaskId: b.id });
      await completeTask(db, b.id);
      const reloaded = await getTask(db, a.id);
      expect(reloaded?.status).toBe("open"); // still the user/agent's call
    } finally {
      await close();
    }
  });
});

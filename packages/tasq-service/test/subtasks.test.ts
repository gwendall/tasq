/**
 * Sub-tasks: creation, inheritance, cycle prevention, depth limit, tree.
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
  getTaskDepth,
  getTaskTree,
  subtreeHeight,
  updateTask,
  pickNext,
  startTask,
  completeTask,
  listTasks,
  MAX_TASK_DEPTH,
} from "../src/index.js";

const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length > 0) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

async function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "tasq-sub-"));
  tmpDirs.push(dir);
  const h = await openDb({ url: `file:${join(dir, "db.sqlite")}`, wal: false });
  await runMigrations(h.client);
  return h;
}

describe("Sub-task creation", () => {
  it("creates a child with parent_task_id set", async () => {
    const { db, close } = await freshDb();
    try {
      const area = await createArea(db, { name: "Kami", slug: "kami", importance: 5 });
      const parent = await createTask(db, { title: "Parent", areaId: area.id });
      const child = await createTask(db, {
        title: "Child",
        parentTaskId: parent.id,
      });
      expect(child.parentTaskId).toBe(parent.id);
    } finally {
      await close();
    }
  });

  it("inherits area / goal / project from parent if not explicitly set", async () => {
    const { db, close } = await freshDb();
    try {
      const area = await createArea(db, { name: "Kami", slug: "kami", importance: 5 });
      const goal = await createGoal(db, { areaId: area.id, title: "G" });
      const project = await createProject(db, { title: "P", areaId: area.id, goalId: goal.id });

      const parent = await createTask(db, {
        title: "Parent",
        areaId: area.id,
        goalId: goal.id,
        projectId: project.id,
      });
      const child = await createTask(db, { title: "Child", parentTaskId: parent.id });
      expect(child.areaId).toBe(area.id);
      expect(child.goalId).toBe(goal.id);
      expect(child.projectId).toBe(project.id);
    } finally {
      await close();
    }
  });

  it("rejects a child scope that contradicts its parent", async () => {
    const { db, close } = await freshDb();
    try {
      const a1 = await createArea(db, { name: "A1", slug: "a1", importance: 5 });
      const a2 = await createArea(db, { name: "A2", slug: "a2", importance: 3 });
      const parent = await createTask(db, { title: "Parent", areaId: a1.id });
      await expect(
        createTask(db, {
          title: "Child",
          parentTaskId: parent.id,
          areaId: a2.id,
        }),
      ).rejects.toThrow(/must match its parent/);
    } finally {
      await close();
    }
  });

  it("rejects detaching a child from its parent's scope", async () => {
    const { db, close } = await freshDb();
    try {
      const area = await createArea(db, { name: "Kami", slug: "kami", importance: 5 });
      const goal = await createGoal(db, { areaId: area.id, title: "G" });
      const project = await createProject(db, { title: "P", areaId: area.id, goalId: goal.id });

      const parent = await createTask(db, {
        title: "Parent",
        areaId: area.id,
        goalId: goal.id,
        projectId: project.id,
      });
      await expect(
        createTask(db, {
          title: "Child",
          parentTaskId: parent.id,
          projectId: null,
        }),
      ).rejects.toThrow(/must match its parent/);
    } finally {
      await close();
    }
  });

  it("rejects non-existent parent", async () => {
    const { db, close } = await freshDb();
    try {
      await expect(
        createTask(db, {
          title: "Orphan",
          parentTaskId: "01900000-0000-7000-8000-000000000000",
        }),
      ).rejects.toThrow(/Parent task not found/);
    } finally {
      await close();
    }
  });

  it("rejects depth beyond MAX_TASK_DEPTH (5)", async () => {
    const { db, close } = await freshDb();
    try {
      const area = await createArea(db, { name: "X", slug: "x", importance: 3 });
      let currentParent = (await createTask(db, { title: "depth-1", areaId: area.id })).id;
      // Build up to MAX depth (5)
      for (let depth = 2; depth <= MAX_TASK_DEPTH; depth++) {
        currentParent = (
          await createTask(db, { title: `depth-${depth}`, parentTaskId: currentParent })
        ).id;
      }
      // 6th level should fail
      await expect(
        createTask(db, { title: "too-deep", parentTaskId: currentParent }),
      ).rejects.toThrow(/exceeds max depth/);
    } finally {
      await close();
    }
  });
});

describe("Cycle prevention on reparent", () => {
  it("rejects making a task its own parent", async () => {
    const { db, close } = await freshDb();
    try {
      const area = await createArea(db, { name: "X", slug: "x", importance: 3 });
      const t = await createTask(db, { title: "Self", areaId: area.id });
      await expect(updateTask(db, t.id, { parentTaskId: t.id })).rejects.toThrow(
        /Task cannot be its own parent/,
      );
    } finally {
      await close();
    }
  });

  it("rejects making a task a descendant of itself (cycle)", async () => {
    const { db, close } = await freshDb();
    try {
      const area = await createArea(db, { name: "X", slug: "x", importance: 3 });
      const a = await createTask(db, { title: "A", areaId: area.id });
      const b = await createTask(db, { title: "B", parentTaskId: a.id });
      const c = await createTask(db, { title: "C", parentTaskId: b.id });
      // A becomes child of C → cycle A → C → B → A
      await expect(updateTask(db, a.id, { parentTaskId: c.id })).rejects.toThrow(
        /Reparent would create a cycle/,
      );
    } finally {
      await close();
    }
  });

  it("allows valid reparent (sibling → cousin)", async () => {
    const { db, close } = await freshDb();
    try {
      const area = await createArea(db, { name: "X", slug: "x", importance: 3 });
      const a = await createTask(db, { title: "A", areaId: area.id });
      const b = await createTask(db, { title: "B", areaId: area.id });
      const c = await createTask(db, { title: "C", parentTaskId: a.id });
      // Move C under B
      const updated = await updateTask(db, c.id, { parentTaskId: b.id });
      expect(updated.parentTaskId).toBe(b.id);
    } finally {
      await close();
    }
  });

  it("rejects reparent that would exceed depth limit", async () => {
    const { db, close } = await freshDb();
    try {
      const area = await createArea(db, { name: "X", slug: "x", importance: 3 });
      // Build a 4-deep chain on side A:
      const a1 = await createTask(db, { title: "a1", areaId: area.id });
      const a2 = await createTask(db, { title: "a2", parentTaskId: a1.id });
      const a3 = await createTask(db, { title: "a3", parentTaskId: a2.id });
      const a4 = await createTask(db, { title: "a4", parentTaskId: a3.id });
      // Side B: a top-level + a child (subtree height 2)
      const b1 = await createTask(db, { title: "b1", areaId: area.id });
      const b2 = await createTask(db, { title: "b2", parentTaskId: b1.id });
      // Reparent b1 under a4 → would be depth 4 (a4) + 2 (subtree height) = 6 > 5
      await expect(updateTask(db, b1.id, { parentTaskId: a4.id })).rejects.toThrow(
        /exceed max task depth/,
      );
    } finally {
      await close();
    }
  });
});

describe("getTaskDepth + subtreeHeight", () => {
  it("getTaskDepth returns 1 for top-level, increments per level", async () => {
    const { db, close } = await freshDb();
    try {
      const area = await createArea(db, { name: "X", slug: "x", importance: 3 });
      const a = await createTask(db, { title: "a", areaId: area.id });
      const b = await createTask(db, { title: "b", parentTaskId: a.id });
      const c = await createTask(db, { title: "c", parentTaskId: b.id });
      expect(await getTaskDepth(db, a.id)).toBe(1);
      expect(await getTaskDepth(db, b.id)).toBe(2);
      expect(await getTaskDepth(db, c.id)).toBe(3);
    } finally {
      await close();
    }
  });

  it("subtreeHeight returns 1 for leaf, 2 for one level of children", async () => {
    const { db, close } = await freshDb();
    try {
      const area = await createArea(db, { name: "X", slug: "x", importance: 3 });
      const a = await createTask(db, { title: "a", areaId: area.id });
      expect(await subtreeHeight(db, a.id)).toBe(1);

      await createTask(db, { title: "child-1", parentTaskId: a.id });
      await createTask(db, { title: "child-2", parentTaskId: a.id });
      expect(await subtreeHeight(db, a.id)).toBe(2);
    } finally {
      await close();
    }
  });
});

describe("getTaskTree", () => {
  it("returns root + descendants in BFS order", async () => {
    const { db, close } = await freshDb();
    try {
      const area = await createArea(db, { name: "X", slug: "x", importance: 3 });
      const root = await createTask(db, { title: "root", areaId: area.id });
      const c1 = await createTask(db, { title: "c1", parentTaskId: root.id });
      const c2 = await createTask(db, { title: "c2", parentTaskId: root.id });
      const gc1 = await createTask(db, { title: "gc1", parentTaskId: c1.id });

      const tree = await getTaskTree(db, root.id);
      expect(tree).not.toBeNull();
      expect(tree!.length).toBe(4);
      expect(tree![0]!.id).toBe(root.id);
      // Level 1 (c1, c2) come before level 2 (gc1)
      const indexOf = (id: string) => tree!.findIndex((t) => t.id === id);
      expect(indexOf(c1.id)).toBeLessThan(indexOf(gc1.id));
      expect(indexOf(c2.id)).toBeLessThan(indexOf(gc1.id));
    } finally {
      await close();
    }
  });

  it("returns null for non-existent root", async () => {
    const { db, close } = await freshDb();
    try {
      const tree = await getTaskTree(db, "01900000-0000-7000-8000-000000000000");
      expect(tree).toBeNull();
    } finally {
      await close();
    }
  });
});

describe("Prioritizer + sub-tasks", () => {
  it("excludes parents with open sub-tasks from `next` by default", async () => {
    const { db, close } = await freshDb();
    try {
      const area = await createArea(db, { name: "X", slug: "x", importance: 5 });
      const parent = await createTask(db, {
        title: "Parent (avoid in next)",
        areaId: area.id,
        priority: 5,
      });
      const child = await createTask(db, {
        title: "Child (should be in next)",
        parentTaskId: parent.id,
        priority: 5,
      });
      // Also a standalone task for comparison
      const standalone = await createTask(db, {
        title: "Standalone",
        areaId: area.id,
        priority: 5,
      });

      const next = await pickNext(db, { limit: 10 });
      const ids = next.map((n) => n.task.id);
      expect(ids).toContain(child.id);
      expect(ids).toContain(standalone.id);
      expect(ids).not.toContain(parent.id); // parent excluded — child is the real next action
    } finally {
      await close();
    }
  });

  it("includes parents when includeParentsWithOpenSubtasks=true (tree view)", async () => {
    const { db, close } = await freshDb();
    try {
      const area = await createArea(db, { name: "X", slug: "x", importance: 5 });
      const parent = await createTask(db, { title: "P", areaId: area.id });
      await createTask(db, { title: "C", parentTaskId: parent.id });

      const next = await pickNext(db, { limit: 10, includeParentsWithOpenSubtasks: true });
      const ids = next.map((n) => n.task.id);
      expect(ids).toContain(parent.id);
    } finally {
      await close();
    }
  });

  it("parent reappears in next once all sub-tasks are closed", async () => {
    const { db, close } = await freshDb();
    try {
      const area = await createArea(db, { name: "X", slug: "x", importance: 5 });
      const parent = await createTask(db, { title: "P", areaId: area.id });
      const child = await createTask(db, { title: "C", parentTaskId: parent.id });

      // Initially parent excluded
      let next = await pickNext(db, { limit: 10 });
      expect(next.map((n) => n.task.id)).not.toContain(parent.id);

      // Close the child
      await completeTask(db, child.id);

      // Now parent is the next-action
      next = await pickNext(db, { limit: 10 });
      expect(next.map((n) => n.task.id)).toContain(parent.id);
    } finally {
      await close();
    }
  });
});

describe("listTasks with parentTaskId filter", () => {
  it("parentTaskId: null returns top-level only", async () => {
    const { db, close } = await freshDb();
    try {
      const area = await createArea(db, { name: "X", slug: "x", importance: 3 });
      await createTask(db, { title: "top1", areaId: area.id });
      const top2 = await createTask(db, { title: "top2", areaId: area.id });
      await createTask(db, { title: "child", parentTaskId: top2.id });

      const topLevel = await listTasks(db, { parentTaskId: null });
      expect(topLevel).toHaveLength(2);
      expect(topLevel.every((t) => t.parentTaskId == null)).toBe(true);
    } finally {
      await close();
    }
  });

  it("parentTaskId: <id> returns direct children only", async () => {
    const { db, close } = await freshDb();
    try {
      const area = await createArea(db, { name: "X", slug: "x", importance: 3 });
      const parent = await createTask(db, { title: "P", areaId: area.id });
      const c1 = await createTask(db, { title: "c1", parentTaskId: parent.id });
      await createTask(db, { title: "gc1", parentTaskId: c1.id });

      const directChildren = await listTasks(db, { parentTaskId: parent.id });
      expect(directChildren).toHaveLength(1);
      expect(directChildren[0]!.title).toBe("c1");
    } finally {
      await close();
    }
  });
});

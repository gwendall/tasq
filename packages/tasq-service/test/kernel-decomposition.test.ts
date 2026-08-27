/**
 * The kernel decomposes commitments without a planning profile (ADR-023).
 *
 * These were bundled: the flat policy refused a parent along with area, goal
 * and project. Only the second group is a life-planning vocabulary; every
 * domain decomposes work, which is the spec's own test for a kernel primitive.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCommitment, getTaskTree, openDb, runMigrations } from "../src/index.js";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const CTX = { workspaceId: "robotics-lab", actor: "planner" };

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "tasq-decomp-"));
  dirs.push(dir);
  const handle = await openDb({ url: `file:${join(dir, "db.sqlite")}`, wal: false });
  await runMigrations(handle.client);
  return handle;
}

describe("decomposition in the kernel", () => {
  it("creates a commitment as the child of another, with no profile injected", async () => {
    const f = await fixture();
    try {
      const parent = await createCommitment(f.db, { title: "Calibrate the arm" }, { ...CTX, now: 1_000 });
      const child = await createCommitment(
        f.db,
        { title: "Home all six axes", parentCommitmentId: parent.id },
        { ...CTX, now: 1_010 },
      );
      expect(child.parentCommitmentId).toBe(parent.id);

      const tree = await getTaskTree(f.db, parent.id, "robotics-lab");
      // A missing tree would otherwise have thrown inside the assertion and
      // read as an ordinary failure rather than "the parent was not found".
      expect(tree, "no tree for the parent commitment").not.toBeNull();
      expect(tree!.map((node) => node.id)).toEqual([parent.id, child.id]);
    } finally {
      await f.close();
    }
  });

  it("has no planning vocabulary to refuse, which is the stronger statement", async () => {
    const f = await fixture();
    try {
      // The kernel commitment API does not merely reject area, goal and project
      // - it has no such fields. They are rejected by the schema before any
      // policy runs, so the kernel surface cannot express them at all.
      for (const scoped of [{ projectId: "x" }, { areaId: "x" }, { goalId: "x" }]) {
        await expect(createCommitment(
          f.db,
          { title: "Scoped work", ...scoped } as never,
          { ...CTX, now: 1_000 },
        )).rejects.toThrow(/Unrecognized key/);
      }
    } finally {
      await f.close();
    }
  });

  it("refuses a parent that does not exist", async () => {
    const f = await fixture();
    try {
      await expect(createCommitment(
        f.db,
        { title: "Orphan", parentCommitmentId: "00000000-0000-7000-8000-00000000dead" },
        { ...CTX, now: 1_000 },
      )).rejects.toThrow(/Parent commitment not found/);
    } finally {
      await f.close();
    }
  });

  it("refuses past the depth limit, which the kernel guards on its own", async () => {
    const f = await fixture();
    try {
      let parentId: string | undefined;
      // MAX_TASK_DEPTH is 5, so the sixth level must be refused.
      for (let level = 0; level < 5; level++) {
        const made = await createCommitment(
          f.db,
          { title: `level ${level}`, parentCommitmentId: parentId },
          { ...CTX, now: 1_000 + level },
        );
        parentId = made.id;
      }
      await expect(createCommitment(
        f.db,
        { title: "one too deep", parentCommitmentId: parentId },
        { ...CTX, now: 2_000 },
      )).rejects.toThrow(/max depth/);
    } finally {
      await f.close();
    }
  });
});

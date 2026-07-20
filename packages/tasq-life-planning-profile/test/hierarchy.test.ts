import { describe, expect, test } from "bun:test";
import {
  resolveCanonicalLifePlanningScope,
  type LifePlanningHierarchyLookup,
} from "../src/index.js";

function lookup(): LifePlanningHierarchyLookup {
  return {
    area: async (id) => id === "area" ? { id, deletedAt: null } : null,
    goal: async (id) => id === "goal"
      ? { id, areaId: "area", deletedAt: null }
      : null,
    project: async (id) => id === "project"
      ? { id, goalId: "goal", areaId: "area", deletedAt: null }
      : null,
    task: async (id) => id === "parent"
      ? {
          id,
          parentTaskId: null,
          projectId: "project",
          goalId: "goal",
          areaId: "area",
          deletedAt: null,
        }
      : null,
  };
}

describe("bundled planning hierarchy", () => {
  test("derives project and goal ancestry through structural lookups", async () => {
    await expect(resolveCanonicalLifePlanningScope(
      { projectId: "project" },
      lookup(),
    )).resolves.toEqual({
      parentTaskId: null,
      projectId: "project",
      goalId: "goal",
      areaId: "area",
    });

    await expect(resolveCanonicalLifePlanningScope(
      { goalId: "goal" },
      lookup(),
    )).resolves.toEqual({
      parentTaskId: null,
      projectId: null,
      goalId: "goal",
      areaId: "area",
    });
  });

  test("inherits the complete scope from a parent task", async () => {
    await expect(resolveCanonicalLifePlanningScope(
      { parentTaskId: "parent" },
      lookup(),
    )).resolves.toEqual({
      parentTaskId: "parent",
      projectId: "project",
      goalId: "goal",
      areaId: "area",
    });
  });

  test("rejects contradictory or missing profile ancestry", async () => {
    await expect(resolveCanonicalLifePlanningScope(
      { projectId: "project", areaId: "other" },
      lookup(),
    )).rejects.toThrow(/must match project/);
    await expect(resolveCanonicalLifePlanningScope(
      { parentTaskId: "parent", goalId: null },
      lookup(),
    )).rejects.toThrow(/must match its parent/);
    await expect(resolveCanonicalLifePlanningScope(
      { areaId: "missing" },
      lookup(),
    )).rejects.toThrow("Area not found: missing");
  });
});

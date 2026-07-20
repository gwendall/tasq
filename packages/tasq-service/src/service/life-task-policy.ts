/** Compatibility policy that projects tasks into the bundled life-planning hierarchy. */

import { resolveCanonicalLifePlanningScope } from "@tasq-internal/life-planning-profile";
import type { TaskHierarchyPolicy } from "./tasks.js";
import { getTask } from "./tasks.js";
import { getArea } from "./areas.js";
import { getGoal } from "./goals.js";
import { getProject } from "./projects.js";

export const lifeTaskHierarchyPolicy: TaskHierarchyPolicy = {
  resolveScope(db, tenantId, input) {
    return resolveCanonicalLifePlanningScope(input, {
      task: (id) => getTask(db, id, tenantId),
      project: (id) => getProject(db, id, tenantId),
      goal: (id) => getGoal(db, id, tenantId),
      area: (id) => getArea(db, id, tenantId),
    });
  },

  async assertLiveAncestors(db, tenantId, ancestors) {
    if (ancestors.areaId != null) {
      const area = await getArea(db, ancestors.areaId, tenantId);
      if (!area) throw new Error(`Area not found: ${ancestors.areaId}`);
      if (area.deletedAt) throw new Error(`Area is deleted: ${ancestors.areaId}`);
    }
    if (ancestors.goalId != null) {
      const goal = await getGoal(db, ancestors.goalId, tenantId);
      if (!goal) throw new Error(`Goal not found: ${ancestors.goalId}`);
      if (goal.deletedAt) throw new Error(`Goal is deleted: ${ancestors.goalId}`);
    }
    if (ancestors.projectId != null) {
      const project = await getProject(db, ancestors.projectId, tenantId);
      if (!project) throw new Error(`Project not found: ${ancestors.projectId}`);
      if (project.deletedAt) throw new Error(`Project is deleted: ${ancestors.projectId}`);
    }
  },
};

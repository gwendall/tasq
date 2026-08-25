/** Canonical area → goal → project → task ancestry for the bundled profile. */

export interface LifePlanningScopeInput {
  areaId?: string | null;
  goalId?: string | null;
  projectId?: string | null;
  parentTaskId?: string | null;
}

export interface CanonicalLifePlanningScope {
  areaId: string | null;
  goalId: string | null;
  projectId: string | null;
  parentTaskId: string | null;
}

export interface LifePlanningScopeTask extends CanonicalLifePlanningScope {
  id: string;
  deletedAt: number | null;
}

export interface LifePlanningScopeProject {
  id: string;
  areaId: string | null;
  goalId: string | null;
  deletedAt: number | null;
}

export interface LifePlanningScopeGoal {
  id: string;
  areaId: string;
  deletedAt: number | null;
}

export interface LifePlanningScopeArea {
  id: string;
  deletedAt: number | null;
}

export interface LifePlanningHierarchyLookup {
  task(id: string): Promise<LifePlanningScopeTask | null>;
  project(id: string): Promise<LifePlanningScopeProject | null>;
  goal(id: string): Promise<LifePlanningScopeGoal | null>;
  area(id: string): Promise<LifePlanningScopeArea | null>;
}

/**
 * Resolve one canonical planning chain through injected structural lookups.
 * The profile owns inheritance/consistency policy; the host owns persistence.
 */
export async function resolveCanonicalLifePlanningScope(
  input: LifePlanningScopeInput,
  lookup: LifePlanningHierarchyLookup,
): Promise<CanonicalLifePlanningScope> {
  const parentTaskId = input.parentTaskId ?? null;
  if (parentTaskId) {
    const parent = await requireLive("Parent task", parentTaskId, lookup.task);
    for (const [field, supplied, inherited] of [
      ["projectId", input.projectId, parent.projectId],
      ["goalId", input.goalId, parent.goalId],
      ["areaId", input.areaId, parent.areaId],
    ] as const) {
      if (supplied !== undefined && supplied !== inherited) {
        throw new Error(
          `Child task ${field} must match its parent (expected ${inherited ?? "null"}, received ${supplied ?? "null"})`,
        );
      }
    }
    return {
      parentTaskId,
      projectId: parent.projectId,
      goalId: parent.goalId,
      areaId: parent.areaId,
    };
  }

  const projectId = input.projectId ?? null;
  if (projectId) {
    const project = await requireLive("Project", projectId, lookup.project);
    // Name the conflict and the way out. A caller who reaches this passed a
    // goal or area explicitly; stating only the invariant left them guessing.
    if (input.goalId !== undefined && input.goalId !== project.goalId) {
      throw new Error(
        `Project ${projectId} belongs to goal ${project.goalId ?? "none"}, but goal ${input.goalId ?? "none"} was supplied. `
          + `Move the task without passing a goal to adopt the project's, or pass --goal ${project.goalId ?? "(and --clear-goal for none)"}.`,
      );
    }
    if (input.areaId !== undefined && input.areaId !== project.areaId) {
      throw new Error(
        `Project ${projectId} belongs to area ${project.areaId ?? "none"}, but area ${input.areaId ?? "none"} was supplied. `
          + `Move the task without passing an area to adopt the project's, or pass --area ${project.areaId ?? "(and --clear-area for none)"}.`,
      );
    }
    if (project.areaId) await requireLive("Area", project.areaId, lookup.area);
    if (project.goalId) await requireLive("Goal", project.goalId, lookup.goal);
    return {
      parentTaskId: null,
      projectId,
      goalId: project.goalId,
      areaId: project.areaId,
    };
  }

  const goalId = input.goalId ?? null;
  if (goalId) {
    const goal = await requireLive("Goal", goalId, lookup.goal);
    if (input.areaId !== undefined && input.areaId !== goal.areaId) {
      throw new Error(`Task areaId must match goal ${goalId} (expected ${goal.areaId})`);
    }
    await requireLive("Area", goal.areaId, lookup.area);
    return { parentTaskId: null, projectId: null, goalId, areaId: goal.areaId };
  }

  const areaId = input.areaId ?? null;
  if (areaId) await requireLive("Area", areaId, lookup.area);
  return { parentTaskId: null, projectId: null, goalId: null, areaId };
}

async function requireLive<T extends { deletedAt: number | null }>(
  label: string,
  id: string,
  get: (id: string) => Promise<T | null>,
): Promise<T> {
  const record = await get(id);
  if (!record) throw new Error(`${label} not found: ${id}`);
  if (record.deletedAt != null) throw new Error(`${label} is deleted: ${id}`);
  return record;
}

import {
  createGoal,
  createProject,
  getAreaBySlug,
  listGoals,
  listProjects,
  updateGoal,
  updateProject,
  GOAL_STATUSES,
  PROJECT_STATUSES,
  type GoalStatus,
  type ProjectStatus,
} from "@tasq-internal/local-service";
import { openRuntime, regenerateProjection } from "../runtime.js";
import {
  color,
  colorizeStatus,
  printError,
  printInfo,
  printJson,
  shortId,
} from "../output/format.js";
import { enumArg, parseDateArg, type ParsedArgs } from "../args.js";
import { resolveGoalIdOrError, resolveProjectIdOrError } from "./_resolve.js";

// ──────────────────────────────────────────────────────────────────────
// Goal
// ──────────────────────────────────────────────────────────────────────

export async function goalCmd(args: ParsedArgs): Promise<number> {
  const [sub] = args.positional;
  if (!sub || sub === "list") return goalList(args);
  if (sub === "add") return goalAdd(args);
  if (sub === "update") return goalUpdate(args);
  printError(`unknown goal subcommand: ${sub}`);
  return 1;
}

async function goalList(args: ParsedArgs): Promise<number> {
  const rt = await openRuntime(args.string("actor"), args.string("tenant"));
  try {
    const areaSlug = args.string("area");
    const areaId = areaSlug ? (await getAreaBySlug(rt.db, areaSlug, rt.config.tenantId))?.id : undefined;
    if (areaSlug && !areaId) {
      printError(`area not found: ${areaSlug}`);
      return 1;
    }
    const status = enumArg<GoalStatus>(args.string("status"), GOAL_STATUSES, "status");
    const goals = await listGoals(rt.db, {
      tenantId: rt.config.tenantId,
      areaId,
      status,
    });
    if (args.bool("json", "j")) {
      printJson(goals);
    } else if (goals.length === 0) {
      printInfo(color.dim("(no goals)"));
    } else {
      for (const g of goals) {
        const horizon = g.horizon ? color.dim(` · ${g.horizon}`) : "";
        printInfo(`${color.dim(shortId(g.id))}  ${colorizeStatus(g.status).padEnd(20)}  ${g.title}  ${color.dim("imp:" + g.importance)}${horizon}`);
      }
    }
    return 0;
  } finally {
    await rt.close();
  }
}

async function goalAdd(args: ParsedArgs): Promise<number> {
  const [, ...rest] = args.positional;
  const title = rest.join(" ");
  if (!title) {
    printError("goal add <title> --area <slug> [--horizon <text>] [--importance 1-5] [--target-date <iso>]");
    return 1;
  }
  const areaSlug = args.string("area");
  if (!areaSlug) {
    printError("--area <slug> is required");
    return 1;
  }
  const rt = await openRuntime(args.string("actor"), args.string("tenant"));
  try {
    const area = await getAreaBySlug(rt.db, areaSlug, rt.config.tenantId);
    if (!area) {
      printError(`area not found: ${areaSlug}`);
      return 1;
    }
    const targetDate = args.string("target-date") ? parseDateArg(args.string("target-date")!) : null;
    const g = await createGoal(
      rt.db,
      {
        areaId: area.id,
        title,
        horizon: args.string("horizon") ?? null,
        importance: args.number("importance") ?? area.importance,
        description: args.string("description") ?? null,
        targetDate,
      },
      rt.ctx,
    );
    await regenerateProjection(rt);
    if (args.bool("json", "j")) printJson(g);
    else printInfo(color.green("✓") + ` goal created ${color.dim(shortId(g.id))}  ${g.title}`);
    return 0;
  } finally {
    await rt.close();
  }
}

async function goalUpdate(args: ParsedArgs): Promise<number> {
  const [, id] = args.positional;
  if (!id) {
    printError("goal update <id> [--title ...] [--status active|paused|done|abandoned] [--importance ...] [--horizon ...]");
    return 1;
  }
  const rt = await openRuntime(args.string("actor"), args.string("tenant"));
  try {
    const resolved = await resolveGoalIdOrError(rt, id);
    if (!resolved) return 1;

    const patch: Record<string, unknown> = {};
    if (args.string("title") !== undefined) patch.title = args.string("title");
    if (args.string("description") !== undefined) patch.description = args.string("description");
    if (args.string("status") !== undefined) patch.status = args.string("status");
    if (args.string("horizon") !== undefined) patch.horizon = args.string("horizon");
    if (args.number("importance") !== undefined) patch.importance = args.number("importance");
    if (args.string("target-date") !== undefined) patch.targetDate = parseDateArg(args.string("target-date")!);

    const updated = await updateGoal(rt.db, resolved, patch, rt.ctx);
    await regenerateProjection(rt);
    if (args.bool("json", "j")) printJson(updated);
    else printInfo(color.green("✓") + ` goal updated ${color.dim(shortId(updated.id))}`);
    return 0;
  } finally {
    await rt.close();
  }
}

// ──────────────────────────────────────────────────────────────────────
// Project
// ──────────────────────────────────────────────────────────────────────

export async function projectCmd(args: ParsedArgs): Promise<number> {
  const [sub] = args.positional;
  if (!sub || sub === "list") return projectList(args);
  if (sub === "add") return projectAdd(args);
  if (sub === "update") return projectUpdate(args);
  if (sub === "status") {
    const { projectStatusCmd } = await import("./tree-status.js");
    return projectStatusCmd(args);
  }
  printError(`unknown project subcommand: ${sub}`);
  return 1;
}

async function projectList(args: ParsedArgs): Promise<number> {
  const rt = await openRuntime(args.string("actor"), args.string("tenant"));
  try {
    const status = enumArg<ProjectStatus>(args.string("status"), PROJECT_STATUSES, "status");
    let goalId: string | undefined;
    const goalArg = args.string("goal");
    if (goalArg !== undefined) {
      const g = await resolveGoalIdOrError(rt, goalArg);
      if (!g) return 1;
      goalId = g;
    }
    const projects = await listProjects(rt.db, {
      tenantId: rt.config.tenantId,
      status,
      goalId,
    });
    if (args.bool("json", "j")) {
      printJson(projects);
    } else if (projects.length === 0) {
      printInfo(color.dim("(no projects)"));
    } else {
      for (const p of projects) {
        printInfo(`${color.dim(shortId(p.id))}  ${colorizeStatus(p.status).padEnd(20)}  ${p.title}`);
      }
    }
    return 0;
  } finally {
    await rt.close();
  }
}

async function projectAdd(args: ParsedArgs): Promise<number> {
  const [, ...rest] = args.positional;
  const title = rest.join(" ");
  if (!title) {
    printError("project add <title> [--goal <id>] [--area <slug>]");
    return 1;
  }
  const rt = await openRuntime(args.string("actor"), args.string("tenant"));
  try {
    let areaId: string | null = null;
    const areaSlug = args.string("area");
    if (areaSlug) {
      const a = await getAreaBySlug(rt.db, areaSlug, rt.config.tenantId);
      if (!a) {
        printError(`area not found: ${areaSlug}`);
        return 1;
      }
      areaId = a.id;
    }
    let goalId: string | null = null;
    const goalArg = args.string("goal");
    if (goalArg !== undefined) {
      const resolved = await resolveGoalIdOrError(rt, goalArg);
      if (!resolved) return 1;
      goalId = resolved;
    }
    const p = await createProject(
      rt.db,
      {
        title,
        goalId,
        areaId,
        description: args.string("description") ?? null,
      },
      rt.ctx,
    );
    await regenerateProjection(rt);
    if (args.bool("json", "j")) printJson(p);
    else printInfo(color.green("✓") + ` project created ${color.dim(shortId(p.id))}  ${p.title}`);
    return 0;
  } finally {
    await rt.close();
  }
}

async function projectUpdate(args: ParsedArgs): Promise<number> {
  const [, id] = args.positional;
  if (!id) {
    printError("project update <id> [--title ...] [--status active|blocked|waiting|done|cancelled] [--goal <id>] [--area <slug>]");
    return 1;
  }
  const rt = await openRuntime(args.string("actor"), args.string("tenant"));
  try {
    const resolved = await resolveProjectIdOrError(rt, id);
    if (!resolved) return 1;

    const patch: Record<string, unknown> = {};
    if (args.string("title") !== undefined) patch.title = args.string("title");
    if (args.string("description") !== undefined) patch.description = args.string("description");
    if (args.string("status") !== undefined) patch.status = args.string("status");
    if (args.string("goal") !== undefined) {
      const g = await resolveGoalIdOrError(rt, args.string("goal")!);
      if (!g) return 1;
      patch.goalId = g;
    }
    if (args.string("area") !== undefined) {
      const a = await getAreaBySlug(rt.db, args.string("area")!, rt.config.tenantId);
      if (!a) {
        printError(`area not found: ${args.string("area")}`);
        return 1;
      }
      patch.areaId = a.id;
    }
    const updated = await updateProject(rt.db, resolved, patch, rt.ctx);
    await regenerateProjection(rt);
    if (args.bool("json", "j")) printJson(updated);
    else printInfo(color.green("✓") + ` project updated ${color.dim(shortId(updated.id))}`);
    return 0;
  } finally {
    await rt.close();
  }
}

/**
 * Compatibility adapter for the bundled `_life` markdown projection.
 *
 * The service owns DB reads and candidate coordination filters. The pure
 * surface policy lives in `@tasq-internal/life-planning-profile`, allowing a
 * minimal kernel host to omit it entirely.
 */

import { and, eq, isNull } from "drizzle-orm";
import {
  area,
  goal,
  project,
  task,
  Area as AreaZ,
  Goal as GoalZ,
  Project as ProjectZ,
  Task as TaskZ,
  type Area as AreaT,
  type Goal as GoalT,
  type Project as ProjectT,
  type Task as TaskT,
  type Clock,
} from "@tasq-run/schema";
import { renderLifePlanningMarkdown } from "@tasq-internal/life-planning-profile";
import type { TasqDb } from "../db.js";
import { pickNext } from "../prioritizer.js";
import { parseRow } from "../util/row.js";
import { serviceNow } from "../util/clock.js";

export interface RenderOptions {
  tenantId?: string;
  /** Human-readable source label shown in the generated header. */
  sourceLabel?: string;
  /** Explicit snapshot wins over the injected clock. */
  now?: number;
  clock?: Clock;
}

export async function renderProjection(
  db: TasqDb,
  options: RenderOptions = {},
): Promise<string> {
  const tenantId = options.tenantId ?? "gwendall";
  const now = serviceNow(options, options.now);

  const areaRows = await db
    .select()
    .from(area)
    .where(and(eq(area.tenantId, tenantId), isNull(area.deletedAt)));
  const goalRows = await db
    .select()
    .from(goal)
    .where(and(eq(goal.tenantId, tenantId), isNull(goal.deletedAt)));
  const projectRows = await db
    .select()
    .from(project)
    .where(and(eq(project.tenantId, tenantId), isNull(project.deletedAt)));
  const taskRows = await db
    .select()
    .from(task)
    .where(and(eq(task.tenantId, tenantId), isNull(task.deletedAt)));

  const areas: AreaT[] = areaRows.map((row) => AreaZ.parse(parseRow(row)));
  const goals: GoalT[] = goalRows.map((row) => GoalZ.parse(parseRow(row)));
  const projects: ProjectT[] = projectRows.map((row) => ProjectZ.parse(parseRow(row)));
  const tasks: TaskT[] = taskRows.map((row) => TaskZ.parse(parseRow(row)));

  // A human projection is an overview, not one actor's private action queue.
  const next = await pickNext(db, {
    tenantId,
    limit: 5,
    now,
    includeClaimed: true,
  });

  return renderLifePlanningMarkdown({
    areas,
    goals,
    projects,
    tasks,
    next,
    now,
    sourceLabel: options.sourceLabel ?? "tasq database",
  });
}

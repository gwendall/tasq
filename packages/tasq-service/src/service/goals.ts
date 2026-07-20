/**
 * Goal service — CRUD with event logging + status state machine.
 */

import { and, asc, eq, inArray, isNull, or } from "drizzle-orm";
import {
  goal,
  project,
  task,
  uuidv7,
  Goal as GoalZ,
  GoalInsert,
  GoalUpdate,
  GoalStatus,
  type Goal as GoalT,
  type GoalStatus as GoalStatusT,
  type Event as EventT,
} from "@tasq/schema";
import type { TasqDb, TasqDbOrTx } from "../db.js";
import { runInTransaction } from "../db.js";
import { recordEvent, emitAfterCommit } from "./events.js";
import type { ServiceContext } from "./context.js";
import { getArea } from "./areas.js";
import type { SoftDeleteOptions } from "./tasks.js";
import { softDeleteTaskTx } from "./tasks.js";
import { softDeleteProjectInTx } from "./projects.js";
import { parseRow } from "../util/row.js";
import { diffRecords } from "../util/diff.js";
import { serviceNow } from "../util/clock.js";

/** Throw if the referenced area is missing or soft-deleted. */
async function assertLiveArea(
  db: TasqDbOrTx,
  tenantId: string,
  areaId: string | null | undefined,
): Promise<void> {
  if (areaId == null) return;
  const a = await getArea(db, areaId, tenantId);
  if (!a) throw new Error(`Area not found: ${areaId}`);
  if (a.deletedAt) throw new Error(`Area is deleted: ${areaId}`);
}

/** Live (non-deleted) project ids under a goal. */
async function liveGoalProjectIds(
  db: TasqDbOrTx,
  goalId: string,
  tenantId: string,
): Promise<string[]> {
  const rows = await db
    .select({ id: project.id })
    .from(project)
    .where(
      and(eq(project.tenantId, tenantId), eq(project.goalId, goalId), isNull(project.deletedAt)),
    );
  return rows.map((r) => r.id);
}

/** Live (non-deleted) task ids directly under a goal (project-less or otherwise). */
async function liveGoalTaskIds(
  db: TasqDbOrTx,
  goalId: string,
  tenantId: string,
): Promise<string[]> {
  const rows = await db
    .select({ id: task.id })
    .from(task)
    .where(and(eq(task.tenantId, tenantId), eq(task.goalId, goalId), isNull(task.deletedAt)));
  return rows.map((r) => r.id);
}

const STATUS_TRANSITIONS: Record<GoalStatusT, readonly GoalStatusT[]> = {
  active: ["paused", "done", "abandoned"],
  paused: ["active", "done", "abandoned"],
  done: ["active"], // can re-open
  abandoned: ["active"],
};

function assertTransition(from: GoalStatusT, to: GoalStatusT): void {
  if (from === to) return;
  const allowed = STATUS_TRANSITIONS[from];
  if (!allowed.includes(to)) {
    throw new Error(`Invalid goal status transition: ${from} → ${to}`);
  }
}

function parseGoal(row: typeof goal.$inferSelect): GoalT {
  return GoalZ.parse(parseRow(row));
}

export async function createGoal(
  db: TasqDb,
  input: unknown,
  ctx: ServiceContext = {},
): Promise<GoalT> {
  const parsed = GoalInsert.parse(input);
  if (parsed.status !== "active") {
    throw new Error("Goals must be created active; use updateGoal for an audited status transition");
  }
  const now = serviceNow(ctx);
  const id = parsed.id ?? uuidv7(now);
  const tenantId = ctx.tenantId ?? parsed.tenantId;
  const actor = ctx.actor ?? "system";

  const { result, committedEvent } = await runInTransaction(db, async (tx) => {
    await assertLiveArea(tx, tenantId, parsed.areaId);
    await tx.insert(goal).values({
      id,
      tenantId,
      areaId: parsed.areaId,
      title: parsed.title,
      description: parsed.description,
      horizon: parsed.horizon,
      importance: parsed.importance,
      status: parsed.status,
      targetDate: parsed.targetDate,
      metadata: JSON.stringify(parsed.metadata),
      createdAt: now,
      updatedAt: now,
    });

    const committedEvent = await recordEvent(
      tx,
      {
        tenantId,
        actor,
        entityType: "goal",
        entityId: id,
        eventType: "created",
        payload: {
          after: {
            title: parsed.title,
            areaId: parsed.areaId,
            status: parsed.status,
            importance: parsed.importance,
          },
        },
      },
      { defer: true, now },
    );

    return { result: (await getGoal(tx, id, tenantId)) as GoalT, committedEvent };
  });

  emitAfterCommit(committedEvent);
  return result;
}

export async function getGoal(
  db: TasqDbOrTx,
  id: string,
  tenantId = "gwendall",
): Promise<GoalT | null> {
  const rows = await db
    .select()
    .from(goal)
    .where(and(eq(goal.id, id), eq(goal.tenantId, tenantId)))
    .limit(1);
  const row = rows[0];
  return row ? parseGoal(row) : null;
}

export interface ListGoalsOptions extends ServiceContext {
  areaId?: string;
  status?: GoalStatusT | GoalStatusT[];
  includeDeleted?: boolean;
}

export async function listGoals(
  db: TasqDb,
  options: ListGoalsOptions = {},
): Promise<GoalT[]> {
  const tenantId = options.tenantId ?? "gwendall";
  const filters = [eq(goal.tenantId, tenantId)];

  if (!options.includeDeleted) filters.push(isNull(goal.deletedAt));
  if (options.areaId) filters.push(eq(goal.areaId, options.areaId));

  if (options.status) {
    const statuses = Array.isArray(options.status) ? options.status : [options.status];
    if (statuses.length === 1) {
      filters.push(eq(goal.status, statuses[0] as string));
    } else {
      const orExpr = or(...statuses.map((s) => eq(goal.status, s as string)));
      if (orExpr) filters.push(orExpr);
    }
  }

  const rows = await db
    .select()
    .from(goal)
    .where(and(...filters))
    .orderBy(asc(goal.title));

  return rows.map(parseGoal);
}

export async function updateGoal(
  db: TasqDb,
  id: string,
  update: unknown,
  ctx: ServiceContext = {},
): Promise<GoalT> {
  const parsed = GoalUpdate.parse(update);
  const tenantId = ctx.tenantId ?? "gwendall";
  const actor = ctx.actor ?? "system";

  const now = serviceNow(ctx);
  const { after, committedEvent } = await runInTransaction(db, async (tx) => {
    const before = await getGoal(tx, id, tenantId);
    if (!before) throw new Error(`Goal not found: ${id}`);
    if (before.deletedAt) throw new Error(`Goal is deleted: ${id}`);
    const changed = Object.entries(parsed).some(
      ([key, value]) => JSON.stringify(before[key as keyof GoalT]) !== JSON.stringify(value),
    );
    if (!changed) return { after: before, committedEvent: null };
    if (parsed.status !== undefined && parsed.status !== before.status) {
      assertTransition(before.status, parsed.status);
    }
    const patch: Partial<typeof goal.$inferInsert> = { updatedAt: now };
    if (parsed.title !== undefined) patch.title = parsed.title;
    if (parsed.description !== undefined) patch.description = parsed.description;
    if (parsed.horizon !== undefined) patch.horizon = parsed.horizon;
    if (parsed.importance !== undefined) patch.importance = parsed.importance;
    if (parsed.status !== undefined) patch.status = parsed.status;
    if (parsed.targetDate !== undefined) patch.targetDate = parsed.targetDate;
    if (parsed.metadata !== undefined) patch.metadata = JSON.stringify(parsed.metadata);
    const eventType =
      parsed.status !== undefined && parsed.status !== before.status
        ? "status_changed"
        : "updated";

    await tx
      .update(goal)
      .set(patch)
      .where(and(eq(goal.id, id), eq(goal.tenantId, tenantId)));

    const after = (await getGoal(tx, id, tenantId)) as GoalT;

    const committedEvent = await recordEvent(
      tx,
      {
        tenantId,
        actor,
        entityType: "goal",
        entityId: id,
        eventType,
        payload: diffRecords(before, after),
      },
      { defer: true, now },
    );

    return { after, committedEvent };
  });

  if (committedEvent) emitAfterCommit(committedEvent);
  return after;
}

export async function softDeleteGoal(
  db: TasqDb,
  id: string,
  ctx: SoftDeleteOptions = {},
): Promise<void> {
  const tenantId = ctx.tenantId ?? "gwendall";
  const actor = ctx.actor ?? "system";
  const now = serviceNow(ctx);

  const committedEvents = await runInTransaction(db, async (tx) => {
    const existing = await getGoal(tx, id, tenantId);
    if (!existing) throw new Error(`Goal not found: ${id}`);
    if (existing.deletedAt) return [] as EventT[];

    const projectIds = await liveGoalProjectIds(tx, id, tenantId);
    const allTaskIds = await liveGoalTaskIds(tx, id, tenantId);
    const taskIds = await filterTasksNotUnderProjects(tx, allTaskIds, projectIds, tenantId);
    const childCount = projectIds.length + taskIds.length;
    if (childCount > 0 && !ctx.cascade) {
      const parts: string[] = [];
      if (projectIds.length) parts.push(`${projectIds.length} live project(s)`);
      if (taskIds.length) parts.push(`${taskIds.length} live task(s)`);
      throw new Error(
        `Cannot delete goal ${id}: ${parts.join(", ")} still reference it. Pass cascade to tombstone them too.`,
      );
    }

    const events: EventT[] = [];
    for (const projectId of projectIds) {
      events.push(...(await softDeleteProjectInTx(tx, projectId, tenantId, actor, now)));
    }
    for (const taskId of taskIds) {
      events.push(...(await softDeleteTaskTx(tx, taskId, tenantId, actor, now)));
    }
    await tx
      .update(goal)
      .set({ deletedAt: now, updatedAt: now })
      .where(and(eq(goal.id, id), eq(goal.tenantId, tenantId)));

    events.push(
      await recordEvent(
        tx,
        {
          tenantId,
          actor,
          entityType: "goal",
          entityId: id,
          eventType: "deleted",
          payload: {},
        },
        { defer: true, now },
      ),
    );
    return events;
  });

  for (const e of committedEvents) emitAfterCommit(e);
}

/**
 * Tombstone a goal + its live subtree (projects → their tasks, then loose tasks)
 * inside a caller's existing transaction. Used by area cascade. Returns events
 * to emit after the caller commits.
 */
export async function softDeleteGoalInTx(
  tx: TasqDbOrTx,
  id: string,
  tenantId: string,
  actor: string,
  now: number,
): Promise<EventT[]> {
  const events: EventT[] = [];
  // Idempotency: skip an already-tombstoned goal (overlapping ancestry).
  const existing = await tx
    .select({ deletedAt: goal.deletedAt })
    .from(goal)
    .where(and(eq(goal.id, id), eq(goal.tenantId, tenantId)))
    .limit(1);
  if (existing.length === 0 || existing[0]!.deletedAt != null) return events;

  const projectIds = await liveGoalProjectIds(tx, id, tenantId);
  const allTaskIds = await liveGoalTaskIds(tx, id, tenantId);
  const taskIds = await filterTasksNotUnderProjects(tx, allTaskIds, projectIds, tenantId);
  for (const projectId of projectIds) {
    events.push(...(await softDeleteProjectInTx(tx, projectId, tenantId, actor, now)));
  }
  for (const taskId of taskIds) {
    events.push(...(await softDeleteTaskTx(tx, taskId, tenantId, actor, now)));
  }
  await tx
    .update(goal)
    .set({ deletedAt: now, updatedAt: now })
    .where(and(eq(goal.id, id), eq(goal.tenantId, tenantId)));
  events.push(
    await recordEvent(
      tx,
      {
        tenantId,
        actor,
        entityType: "goal",
        entityId: id,
        eventType: "deleted",
        payload: {},
      },
      { defer: true, now },
    ),
  );
  return events;
}

/**
 * From a candidate set of task ids, drop those whose `projectId` is one of the
 * given (already-cascading) project ids. Prevents a task from being tombstoned
 * twice (once via its project's cascade, once via the goal's loose-task sweep).
 */
async function filterTasksNotUnderProjects(
  db: TasqDbOrTx,
  taskIds: string[],
  projectIds: string[],
  tenantId: string,
): Promise<string[]> {
  if (taskIds.length === 0 || projectIds.length === 0) return taskIds;
  const projectSet = new Set(projectIds);
  const rows = await db
    .select({ id: task.id, projectId: task.projectId })
    .from(task)
    .where(and(eq(task.tenantId, tenantId), inArray(task.id, taskIds)));
  const byId = new Map(rows.map((r) => [r.id, r.projectId] as const));
  return taskIds.filter((tid) => {
    const pid = byId.get(tid);
    return pid == null || !projectSet.has(pid);
  });
}

export async function restoreGoal(
  db: TasqDb,
  id: string,
  ctx: ServiceContext = {},
): Promise<GoalT> {
  const tenantId = ctx.tenantId ?? "gwendall";
  const actor = ctx.actor ?? "system";
  const now = serviceNow(ctx);

  const { result, committedEvent } = await runInTransaction(db, async (tx) => {
    const existing = await getGoal(tx, id, tenantId);
    if (!existing) throw new Error(`Goal not found: ${id}`);
    if (!existing.deletedAt) return { result: existing, committedEvent: null };
    await assertLiveArea(tx, tenantId, existing.areaId);

    await tx
      .update(goal)
      .set({ deletedAt: null, updatedAt: now })
      .where(and(eq(goal.id, id), eq(goal.tenantId, tenantId)));

    const committedEvent = await recordEvent(
      tx,
      {
        tenantId,
        actor,
        entityType: "goal",
        entityId: id,
        eventType: "restored",
        payload: {},
      },
      { defer: true, now },
    );

    return { result: (await getGoal(tx, id, tenantId)) as GoalT, committedEvent };
  });

  if (committedEvent) emitAfterCommit(committedEvent);
  return result;
}

export { GoalStatus };

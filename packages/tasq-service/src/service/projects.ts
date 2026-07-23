/**
 * Project service — CRUD with event logging + status state machine.
 */

import { and, asc, eq, isNull, or, sql } from "drizzle-orm";
import {
  project,
  task,
  uuidv7,
  Project as ProjectZ,
  ProjectInsert,
  ProjectUpdate,
  ProjectStatus,
  type Project as ProjectT,
  type ProjectStatus as ProjectStatusT,
  type Event as EventT,
} from "@tasq-run/schema";
import type { TasqDb, TasqDbOrTx } from "../db.js";
import { runInTransaction } from "../db.js";
import { recordEvent, emitAfterCommit } from "./events.js";
import type { ServiceContext } from "./context.js";
import type { SoftDeleteOptions } from "./tasks.js";
import { getArea } from "./areas.js";
import { getGoal } from "./goals.js";
import { softDeleteTaskTx } from "./tasks.js";
import { parseRow } from "../util/row.js";
import { diffRecords } from "../util/diff.js";
import { serviceNow } from "../util/clock.js";

/** Throw if the referenced area/goal is missing or soft-deleted. */
async function assertLiveProjectAncestors(
  db: TasqDbOrTx,
  tenantId: string,
  ancestors: { areaId?: string | null; goalId?: string | null },
): Promise<void> {
  if (ancestors.areaId != null) {
    const a = await getArea(db, ancestors.areaId, tenantId);
    if (!a) throw new Error(`Area not found: ${ancestors.areaId}`);
    if (a.deletedAt) throw new Error(`Area is deleted: ${ancestors.areaId}`);
  }
  if (ancestors.goalId != null) {
    const g = await getGoal(db, ancestors.goalId, tenantId);
    if (!g) throw new Error(`Goal not found: ${ancestors.goalId}`);
    if (g.deletedAt) throw new Error(`Goal is deleted: ${ancestors.goalId}`);
  }
}

async function resolveCanonicalProjectScope(
  db: TasqDbOrTx,
  tenantId: string,
  goalId: string | null,
  areaId: string | null | undefined,
): Promise<{ goalId: string | null; areaId: string | null }> {
  if (goalId) {
    const goal = await getGoal(db, goalId, tenantId);
    if (!goal) throw new Error(`Goal not found: ${goalId}`);
    if (goal.deletedAt) throw new Error(`Goal is deleted: ${goalId}`);
    if (areaId != null && areaId !== goal.areaId) {
      throw new Error(`Project areaId must match goal ${goalId} (expected ${goal.areaId})`);
    }
    await assertLiveProjectAncestors(db, tenantId, { goalId, areaId: goal.areaId });
    return { goalId, areaId: goal.areaId };
  }
  const canonicalAreaId = areaId ?? null;
  await assertLiveProjectAncestors(db, tenantId, { areaId: canonicalAreaId });
  return { goalId: null, areaId: canonicalAreaId };
}

/** Live (non-deleted) task ids directly under a project. */
async function liveProjectTaskIds(
  db: TasqDbOrTx,
  projectId: string,
  tenantId: string,
): Promise<string[]> {
  const rows = await db
    .select({ id: task.id })
    .from(task)
    .where(
      and(eq(task.tenantId, tenantId), eq(task.projectId, projectId), isNull(task.deletedAt)),
    );
  return rows.map((r) => r.id);
}

const STATUS_TRANSITIONS: Record<ProjectStatusT, readonly ProjectStatusT[]> = {
  active: ["blocked", "waiting", "done", "cancelled"],
  blocked: ["active", "waiting", "done", "cancelled"],
  waiting: ["active", "blocked", "done", "cancelled"],
  done: ["active"], // re-open allowed
  cancelled: ["active"],
};

function assertTransition(from: ProjectStatusT, to: ProjectStatusT): void {
  if (from === to) return;
  const allowed = STATUS_TRANSITIONS[from];
  if (!allowed.includes(to)) {
    throw new Error(`Invalid project status transition: ${from} → ${to}`);
  }
}

function parseProject(row: typeof project.$inferSelect): ProjectT {
  return ProjectZ.parse(parseRow(row));
}

export async function createProject(
  db: TasqDb,
  input: unknown,
  ctx: ServiceContext = {},
): Promise<ProjectT> {
  const parsed = ProjectInsert.parse(input);
  if (parsed.status !== "active") {
    throw new Error("Projects must be created active; use updateProject for an audited status transition");
  }
  const now = serviceNow(ctx);
  const id = parsed.id ?? uuidv7(now);
  const tenantId = ctx.tenantId ?? parsed.tenantId;
  const actor = ctx.actor ?? "system";

  const { result, committedEvent } = await runInTransaction(db, async (tx) => {
    const scope = await resolveCanonicalProjectScope(
      tx,
      tenantId,
      parsed.goalId,
      parsed.areaId,
    );
    await tx.insert(project).values({
      id,
      tenantId,
      goalId: scope.goalId,
      areaId: scope.areaId,
      title: parsed.title,
      description: parsed.description,
      status: parsed.status,
      metadata: JSON.stringify(parsed.metadata),
      createdAt: now,
      updatedAt: now,
    });

    const committedEvent = await recordEvent(
      tx,
      {
        tenantId,
        actor,
        entityType: "project",
        entityId: id,
        eventType: "created",
        payload: {
          after: {
            title: parsed.title,
            status: parsed.status,
            goalId: scope.goalId,
            areaId: scope.areaId,
          },
        },
      },
      { defer: true, now },
    );

    return { result: (await getProject(tx, id, tenantId)) as ProjectT, committedEvent };
  });

  emitAfterCommit(committedEvent);
  return result;
}

export async function getProject(
  db: TasqDbOrTx,
  id: string,
  tenantId = "gwendall",
): Promise<ProjectT | null> {
  const rows = await db
    .select()
    .from(project)
    .where(and(eq(project.id, id), eq(project.tenantId, tenantId)))
    .limit(1);
  const row = rows[0];
  return row ? parseProject(row) : null;
}

export interface ListProjectsOptions extends ServiceContext {
  status?: ProjectStatusT | ProjectStatusT[];
  goalId?: string;
  areaId?: string;
  includeDeleted?: boolean;
}

export async function listProjects(
  db: TasqDb,
  options: ListProjectsOptions = {},
): Promise<ProjectT[]> {
  const tenantId = options.tenantId ?? "gwendall";
  const filters = [eq(project.tenantId, tenantId)];

  if (!options.includeDeleted) filters.push(isNull(project.deletedAt));
  if (options.goalId) filters.push(eq(project.goalId, options.goalId));
  if (options.areaId) filters.push(eq(project.areaId, options.areaId));

  if (options.status) {
    const statuses = Array.isArray(options.status) ? options.status : [options.status];
    if (statuses.length === 1) {
      filters.push(eq(project.status, statuses[0] as string));
    } else {
      const orExpr = or(...statuses.map((s) => eq(project.status, s as string)));
      if (orExpr) filters.push(orExpr);
    }
  }

  const rows = await db
    .select()
    .from(project)
    .where(and(...filters))
    .orderBy(asc(project.title));

  return rows.map(parseProject);
}

export async function updateProject(
  db: TasqDb,
  id: string,
  update: unknown,
  ctx: ServiceContext = {},
): Promise<ProjectT> {
  const parsed = ProjectUpdate.parse(update);
  const tenantId = ctx.tenantId ?? "gwendall";
  const actor = ctx.actor ?? "system";

  const now = serviceNow(ctx);
  const { after, committedEvents } = await runInTransaction(db, async (tx) => {
    const before = await getProject(tx, id, tenantId);
    if (!before) throw new Error(`Project not found: ${id}`);
    if (before.deletedAt) throw new Error(`Project is deleted: ${id}`);
    const changed = Object.entries(parsed).some(
      ([key, value]) => JSON.stringify(before[key as keyof ProjectT]) !== JSON.stringify(value),
    );
    if (!changed) return { after: before, committedEvents: [] as EventT[] };
    if (parsed.status !== undefined && parsed.status !== before.status) {
      assertTransition(before.status, parsed.status);
    }

    const desiredGoalId = parsed.goalId !== undefined ? parsed.goalId : before.goalId;
    const desiredAreaId =
      parsed.goalId !== undefined && parsed.goalId !== before.goalId && parsed.areaId === undefined
        ? undefined
        : parsed.areaId !== undefined
          ? parsed.areaId
          : before.areaId;
    const scope = await resolveCanonicalProjectScope(tx, tenantId, desiredGoalId, desiredAreaId);

    const patch: Partial<typeof project.$inferInsert> = {
      updatedAt: now,
      goalId: scope.goalId,
      areaId: scope.areaId,
    };
    if (parsed.title !== undefined) patch.title = parsed.title;
    if (parsed.description !== undefined) patch.description = parsed.description;
    if (parsed.status !== undefined) patch.status = parsed.status;
    if (parsed.metadata !== undefined) patch.metadata = JSON.stringify(parsed.metadata);
    const eventType =
      parsed.status !== undefined && parsed.status !== before.status
        ? "status_changed"
        : "updated";

    await tx
      .update(project)
      .set(patch)
      .where(and(eq(project.id, id), eq(project.tenantId, tenantId)));

    const committedEvents: EventT[] = [];

    // The project owns the effective goal/area of every linked task. Each
    // derived row change gets its own audit event in the same transaction.
    if (scope.goalId !== before.goalId || scope.areaId !== before.areaId) {
      const affectedTasks = await tx
        .select({ id: task.id, goalId: task.goalId, areaId: task.areaId })
        .from(task)
        .where(and(eq(task.tenantId, tenantId), eq(task.projectId, id)));
      await tx
        .update(task)
        .set({
          goalId: scope.goalId,
          areaId: scope.areaId,
          updatedAt: now,
          revision: sql`${task.revision} + 1`,
        })
        .where(and(eq(task.tenantId, tenantId), eq(task.projectId, id)));
      for (const affected of affectedTasks) {
        committedEvents.push(
          await recordEvent(
            tx,
            {
              tenantId,
              actor,
              entityType: "task",
              entityId: affected.id,
              eventType: "scope_rederived",
              payload: {
                before: { goalId: affected.goalId, areaId: affected.areaId },
                after: { goalId: scope.goalId, areaId: scope.areaId, projectId: id },
                source: "project-scope-change",
              },
            },
            { defer: true, now },
          ),
        );
      }
    }

    const after = (await getProject(tx, id, tenantId)) as ProjectT;

    committedEvents.unshift(
      await recordEvent(
        tx,
        {
          tenantId,
          actor,
          entityType: "project",
          entityId: id,
          eventType,
          payload: diffRecords(before, after),
        },
        { defer: true, now },
      ),
    );

    return { after, committedEvents };
  });

  for (const committedEvent of committedEvents) emitAfterCommit(committedEvent);
  return after;
}

export async function softDeleteProject(
  db: TasqDb,
  id: string,
  ctx: SoftDeleteOptions = {},
): Promise<void> {
  const tenantId = ctx.tenantId ?? "gwendall";
  const actor = ctx.actor ?? "system";
  const now = serviceNow(ctx);

  const committedEvents = await softDeleteProjectTx(db, id, tenantId, actor, now, ctx.cascade);
  for (const e of committedEvents) emitAfterCommit(e);
}

/**
 * Tombstone a project + (when child ids are supplied) its live tasks inside one
 * transaction. Returns the events to emit after commit. Exposed so an ancestor
 * cascade (area/goal) can tombstone a project's subtree in the same tx.
 */
async function softDeleteProjectTx(
  db: TasqDb,
  id: string,
  tenantId: string,
  actor: string,
  now: number,
  cascade = false,
): Promise<EventT[]> {
  return runInTransaction(db, async (tx) => {
    const existing = await getProject(tx, id, tenantId);
    if (!existing) throw new Error(`Project not found: ${id}`);
    if (existing.deletedAt) return [] as EventT[];
    const childIds = await liveProjectTaskIds(tx, id, tenantId);
    if (childIds.length > 0 && !cascade) {
      throw new Error(
        `Cannot delete project ${id}: ${childIds.length} live task(s) still reference it. Pass cascade to tombstone them too.`,
      );
    }
    const events: EventT[] = [];
    for (const taskId of childIds) {
      events.push(...(await softDeleteTaskTx(tx, taskId, tenantId, actor, now)));
    }
    await tx
      .update(project)
      .set({ deletedAt: now, updatedAt: now })
      .where(and(eq(project.id, id), eq(project.tenantId, tenantId)));

    events.push(
      await recordEvent(
        tx,
        {
          tenantId,
          actor,
          entityType: "project",
          entityId: id,
          eventType: "deleted",
          payload: {},
        },
        { defer: true, now },
      ),
    );
    return events;
  });
}

/**
 * Tombstone a project + its live tasks inside a caller's existing transaction
 * (used by area/goal cascade). Returns events to emit after the caller commits.
 */
export async function softDeleteProjectInTx(
  tx: TasqDbOrTx,
  id: string,
  tenantId: string,
  actor: string,
  now: number,
): Promise<EventT[]> {
  const events: EventT[] = [];
  // Idempotency: skip an already-tombstoned project (overlapping ancestry).
  const existing = await tx
    .select({ deletedAt: project.deletedAt })
    .from(project)
    .where(and(eq(project.id, id), eq(project.tenantId, tenantId)))
    .limit(1);
  if (existing.length === 0 || existing[0]!.deletedAt != null) return events;

  const childIds = await liveProjectTaskIds(tx, id, tenantId);
  for (const taskId of childIds) {
    events.push(...(await softDeleteTaskTx(tx, taskId, tenantId, actor, now)));
  }
  await tx
    .update(project)
    .set({ deletedAt: now, updatedAt: now })
    .where(and(eq(project.id, id), eq(project.tenantId, tenantId)));
  events.push(
    await recordEvent(
      tx,
      {
        tenantId,
        actor,
        entityType: "project",
        entityId: id,
        eventType: "deleted",
        payload: {},
      },
      { defer: true, now },
    ),
  );
  return events;
}

export async function restoreProject(
  db: TasqDb,
  id: string,
  ctx: ServiceContext = {},
): Promise<ProjectT> {
  const tenantId = ctx.tenantId ?? "gwendall";
  const actor = ctx.actor ?? "system";
  const now = serviceNow(ctx);

  const { result, committedEvent } = await runInTransaction(db, async (tx) => {
    const existing = await getProject(tx, id, tenantId);
    if (!existing) throw new Error(`Project not found: ${id}`);
    if (!existing.deletedAt) return { result: existing, committedEvent: null };
    const scope = await resolveCanonicalProjectScope(
      tx,
      tenantId,
      existing.goalId,
      existing.areaId,
    );

    await tx
      .update(project)
      .set({ deletedAt: null, goalId: scope.goalId, areaId: scope.areaId, updatedAt: now })
      .where(and(eq(project.id, id), eq(project.tenantId, tenantId)));

    const committedEvent = await recordEvent(
      tx,
      {
        tenantId,
        actor,
        entityType: "project",
        entityId: id,
        eventType: "restored",
        payload: {},
      },
      { defer: true, now },
    );

    return { result: (await getProject(tx, id, tenantId)) as ProjectT, committedEvent };
  });

  if (committedEvent) emitAfterCommit(committedEvent);
  return result;
}

export { ProjectStatus };

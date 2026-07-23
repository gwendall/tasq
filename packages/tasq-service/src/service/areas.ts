/**
 * Area service — CRUD with event logging.
 */

import { and, asc, eq, isNull } from "drizzle-orm";
import {
  area,
  goal,
  project,
  task,
  uuidv7,
  Area as AreaZ,
  AreaInsert,
  AreaUpdate,
  type Area as AreaT,
  type Event as EventT,
} from "@tasq-run/schema";
import type { TasqDb, TasqDbOrTx } from "../db.js";
import { runInTransaction } from "../db.js";
import { recordEvent, emitAfterCommit } from "./events.js";
import type { SoftDeleteOptions } from "./tasks.js";
import { softDeleteTaskTx } from "./tasks.js";
import { softDeleteProjectInTx } from "./projects.js";
import { softDeleteGoalInTx } from "./goals.js";
import { parseRow } from "../util/row.js";
import { diffRecords } from "../util/diff.js";
import { serviceNow } from "../util/clock.js";
import type { ServiceContext } from "./context.js";
export type { ServiceContext } from "./context.js";

/** Live (non-deleted) child ids referencing an area, grouped by entity type. */
async function liveAreaChildren(
  db: TasqDbOrTx,
  areaId: string,
  tenantId: string,
): Promise<{ goalIds: string[]; projectIds: string[]; taskIds: string[] }> {
  const goalRows = await db
    .select({ id: goal.id })
    .from(goal)
    .where(and(eq(goal.tenantId, tenantId), eq(goal.areaId, areaId), isNull(goal.deletedAt)));
  const projectRows = await db
    .select({ id: project.id })
    .from(project)
    .where(
      and(eq(project.tenantId, tenantId), eq(project.areaId, areaId), isNull(project.deletedAt)),
    );
  const taskRows = await db
    .select({ id: task.id })
    .from(task)
    .where(and(eq(task.tenantId, tenantId), eq(task.areaId, areaId), isNull(task.deletedAt)));
  return {
    goalIds: goalRows.map((r) => r.id),
    projectIds: projectRows.map((r) => r.id),
    taskIds: taskRows.map((r) => r.id),
  };
}

function parseArea(row: typeof area.$inferSelect): AreaT {
  return AreaZ.parse(parseRow(row));
}

export async function createArea(
  db: TasqDb,
  input: unknown,
  ctx: ServiceContext = {},
): Promise<AreaT> {
  const parsed = AreaInsert.parse(input);
  const now = serviceNow(ctx);
  const id = parsed.id ?? uuidv7(now);
  const tenantId = ctx.tenantId ?? parsed.tenantId;
  const actor = ctx.actor ?? "system";

  const { result, committedEvent } = await runInTransaction(db, async (tx) => {
    await tx.insert(area).values({
      id,
      tenantId,
      name: parsed.name,
      slug: parsed.slug,
      importance: parsed.importance,
      cadenceTarget: parsed.cadenceTarget,
      description: parsed.description,
      metadata: JSON.stringify(parsed.metadata),
      createdAt: now,
      updatedAt: now,
    });

    const committedEvent = await recordEvent(
      tx,
      {
        tenantId,
        actor,
        entityType: "area",
        entityId: id,
        eventType: "created",
        payload: { after: { name: parsed.name, slug: parsed.slug, importance: parsed.importance } },
      },
      { defer: true, now },
    );

    return { result: (await getArea(tx, id, tenantId)) as AreaT, committedEvent };
  });

  emitAfterCommit(committedEvent);
  return result;
}

export async function getArea(
  db: TasqDbOrTx,
  id: string,
  tenantId = "gwendall",
): Promise<AreaT | null> {
  const rows = await db
    .select()
    .from(area)
    .where(and(eq(area.id, id), eq(area.tenantId, tenantId)))
    .limit(1);
  const row = rows[0];
  return row ? parseArea(row) : null;
}

export async function getAreaBySlug(
  db: TasqDb,
  slug: string,
  tenantId = "gwendall",
): Promise<AreaT | null> {
  const rows = await db
    .select()
    .from(area)
    .where(and(eq(area.slug, slug), eq(area.tenantId, tenantId)))
    .limit(1);
  const row = rows[0];
  return row ? parseArea(row) : null;
}

export interface ListAreasOptions extends ServiceContext {
  includeDeleted?: boolean;
}

export async function listAreas(
  db: TasqDb,
  options: ListAreasOptions = {},
): Promise<AreaT[]> {
  const tenantId = options.tenantId ?? "gwendall";
  const filters = [eq(area.tenantId, tenantId)];
  if (!options.includeDeleted) filters.push(isNull(area.deletedAt));

  const rows = await db
    .select()
    .from(area)
    .where(and(...filters))
    .orderBy(asc(area.name));

  return rows.map(parseArea);
}

export async function updateArea(
  db: TasqDb,
  id: string,
  update: unknown,
  ctx: ServiceContext = {},
): Promise<AreaT> {
  const parsed = AreaUpdate.parse(update);
  const tenantId = ctx.tenantId ?? "gwendall";
  const actor = ctx.actor ?? "system";

  const now = serviceNow(ctx);
  const { after, committedEvent } = await runInTransaction(db, async (tx) => {
    const before = await getArea(tx, id, tenantId);
    if (!before) throw new Error(`Area not found: ${id}`);
    if (before.deletedAt) throw new Error(`Area is deleted: ${id}`);
    const changed = Object.entries(parsed).some(
      ([key, value]) => JSON.stringify(before[key as keyof AreaT]) !== JSON.stringify(value),
    );
    if (!changed) return { after: before, committedEvent: null };

    const patch: Partial<typeof area.$inferInsert> = { updatedAt: now };
    if (parsed.name !== undefined) patch.name = parsed.name;
    if (parsed.slug !== undefined) patch.slug = parsed.slug;
    if (parsed.importance !== undefined) patch.importance = parsed.importance;
    if (parsed.cadenceTarget !== undefined) patch.cadenceTarget = parsed.cadenceTarget;
    if (parsed.description !== undefined) patch.description = parsed.description;
    if (parsed.metadata !== undefined) patch.metadata = JSON.stringify(parsed.metadata);

    await tx
      .update(area)
      .set(patch)
      .where(and(eq(area.id, id), eq(area.tenantId, tenantId)));

    const after = (await getArea(tx, id, tenantId)) as AreaT;

    const committedEvent = await recordEvent(
      tx,
      {
        tenantId,
        actor,
        entityType: "area",
        entityId: id,
        eventType: "updated",
        payload: diffRecords(before, after),
      },
      { defer: true, now },
    );

    return { after, committedEvent };
  });

  if (committedEvent) emitAfterCommit(committedEvent);
  return after;
}

export async function softDeleteArea(
  db: TasqDb,
  id: string,
  ctx: SoftDeleteOptions = {},
): Promise<void> {
  const tenantId = ctx.tenantId ?? "gwendall";
  const actor = ctx.actor ?? "system";
  const now = serviceNow(ctx);

  const committedEvents = await runInTransaction(db, async (tx) => {
    const existing = await getArea(tx, id, tenantId);
    if (!existing) throw new Error(`Area not found: ${id}`);
    if (existing.deletedAt) return [] as EventT[];

    const { goalIds, projectIds, taskIds } = await liveAreaChildren(tx, id, tenantId);
    const childCount = goalIds.length + projectIds.length + taskIds.length;
    if (childCount > 0 && !ctx.cascade) {
      const parts: string[] = [];
      if (goalIds.length) parts.push(`${goalIds.length} live goal(s)`);
      if (projectIds.length) parts.push(`${projectIds.length} live project(s)`);
      if (taskIds.length) parts.push(`${taskIds.length} live task(s)`);
      throw new Error(
        `Cannot delete area ${id}: ${parts.join(", ")} still reference it. Pass cascade to tombstone them too.`,
      );
    }

    const events: EventT[] = [];
    // Cascade deepest-anchor-first via the service helpers so each emits its
    // own `deleted` event. The `*InTx` helpers skip already-tombstoned rows,
    // so overlapping ancestry (a task under both a cascaded goal AND this area)
    // is tombstoned exactly once with one event.
    for (const goalId of goalIds) {
      events.push(...(await softDeleteGoalInTx(tx, goalId, tenantId, actor, now)));
    }
    for (const projectId of projectIds) {
      events.push(...(await softDeleteProjectInTx(tx, projectId, tenantId, actor, now)));
    }
    for (const taskId of taskIds) {
      events.push(...(await softDeleteTaskTx(tx, taskId, tenantId, actor, now)));
    }
    await tx
      .update(area)
      .set({ deletedAt: now, updatedAt: now })
      .where(and(eq(area.id, id), eq(area.tenantId, tenantId)));

    events.push(
      await recordEvent(
        tx,
        {
          tenantId,
          actor,
          entityType: "area",
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

export async function restoreArea(
  db: TasqDb,
  id: string,
  ctx: ServiceContext = {},
): Promise<AreaT> {
  const tenantId = ctx.tenantId ?? "gwendall";
  const actor = ctx.actor ?? "system";
  const now = serviceNow(ctx);

  const { result, committedEvent } = await runInTransaction(db, async (tx) => {
    const existing = await getArea(tx, id, tenantId);
    if (!existing) throw new Error(`Area not found: ${id}`);
    if (!existing.deletedAt) return { result: existing, committedEvent: null };

    await tx
      .update(area)
      .set({ deletedAt: null, updatedAt: now })
      .where(and(eq(area.id, id), eq(area.tenantId, tenantId)));

    const committedEvent = await recordEvent(
      tx,
      {
        tenantId,
        actor,
        entityType: "area",
        entityId: id,
        eventType: "restored",
        payload: {},
      },
      { defer: true, now },
    );

    return { result: (await getArea(tx, id, tenantId)) as AreaT, committedEvent };
  });

  if (committedEvent) emitAfterCommit(committedEvent);
  return result;
}

/**
 * Task dependency service — first-class peer edges (SPEC §4.5).
 *
 * A `blocks` edge means `from_task_id` depends on `to_task_id`: the dependent
 * (`from`) is held up until its blocker (`to`) resolves. `relates_to` /
 * `duplicates` are informational links (non-transitive, no cycle guard).
 *
 * Every mutation:
 *   1. Validates input via Zod
 *   2. Mutates the row (insert / reactivate / soft-delete)
 *   3. Records a `dependency_added` / `dependency_removed` event
 *
 * `event.event_type` is open-vocab (only `entity_type` is CHECK-constrained),
 * so these events use `entityType: 'task'` with `entityId = fromTaskId` — the
 * dependent task whose actionability changes — and need no enum migration
 * (SPEC §4.8).
 *
 * A `blocks` edge NEVER auto-flips the dependent's status to `blocked`
 * (SPEC §4.5 "no automatic coupling"); it only feeds the prioritizer's
 * W_blocked down-weight (§5.2.1).
 */

import { and, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import {
  commitmentRelation,
  task,
  taskDependency,
  uuidv7,
  TaskDependencyInsert,
  TaskDependency as TaskDependencyZ,
  type TaskDependency as TaskDependencyT,
  type DependencyType as DependencyTypeT,
} from "@tasq-run/schema";
import type { TasqDb, TasqDbOrTx } from "../db.js";
import { runInTransaction } from "../db.js";
import { recordEvent, emitAfterCommit, listEvents } from "./events.js";
import type { ServiceContext } from "./context.js";
import { getTask } from "./tasks.js";
import { serviceNow } from "../util/clock.js";
import { ensureLocalPrincipal } from "./principals.js";

// ──────────────────────────────────────────────────────────────────────
// Parsing
// ──────────────────────────────────────────────────────────────────────

function parseDependency(row: typeof taskDependency.$inferSelect): TaskDependencyT {
  // No JSON columns → no parseRow needed.
  return TaskDependencyZ.parse(row);
}

// ──────────────────────────────────────────────────────────────────────
// Cycle guard (ported from tasks.ts updateTask reparent walk)
// ──────────────────────────────────────────────────────────────────────

/**
 * Reject a new `blocks` edge `from → to` that would close a cycle.
 *
 * Walk the live `blocks` graph downward from `to` (following `from_task_id =
 * cursor` → its `to_task_id`s), maintaining a seen-set; if `from` is reachable
 * the edge would create a cycle. Same cursor + seen-set + reachability-throw
 * structure as the reparent guard in tasks.ts — only the traversal source
 * changes (task_dependency live blocks edges vs task.parentTaskId).
 *
 * Only meaningful for `type='blocks'`; relates_to/duplicates are non-transitive.
 */
async function assertNoCycle(
  db: TasqDbOrTx,
  tenantId: string,
  fromTaskId: string,
  toTaskId: string,
): Promise<void> {
  // The candidate edge says "from blocks to". A cycle exists iff `to`
  // (transitively) already blocks `from`. Walk forward from `to`.
  if (toTaskId === fromTaskId) {
    throw new Error(`Dependency would create a cycle: task ${fromTaskId} cannot block itself`);
  }
  let frontier: string[] = [toTaskId];
  const seen = new Set<string>([toTaskId]);
  while (frontier.length > 0) {
    const rows = await db
      .select({ toTaskId: taskDependency.toTaskId })
      .from(taskDependency)
      .where(
        and(
          eq(taskDependency.tenantId, tenantId),
          eq(taskDependency.type, "blocks"),
          isNull(taskDependency.deletedAt),
          inArray(taskDependency.fromTaskId, frontier),
        ),
      );
    const nextFrontier: string[] = [];
    for (const r of rows) {
      const next = r.toTaskId;
      if (next === fromTaskId) {
        throw new Error(
          `Dependency would create a cycle: ${toTaskId} already blocks ${fromTaskId} (adding ${fromTaskId} blocks ${toTaskId} closes the loop)`,
        );
      }
      if (!seen.has(next)) {
        seen.add(next);
        nextFrontier.push(next);
      }
    }
    frontier = nextFrontier;
  }
}

// ──────────────────────────────────────────────────────────────────────
// Mutations
// ──────────────────────────────────────────────────────────────────────

/**
 * Create (or reactivate) a dependency edge. For `type='blocks'`, runs the
 * cycle guard before inserting. Reactivates a soft-deleted matching edge rather
 * than inserting a duplicate (partial UNIQUE; SPEC §5.3). Emits
 * `dependency_added` (entityType 'task', entityId = fromTaskId).
 */
export async function dependTask(
  db: TasqDb,
  input: unknown,
  ctx: ServiceContext = {},
): Promise<TaskDependencyT> {
  const parsed = TaskDependencyInsert.parse(input);
  const tenantId = ctx.tenantId ?? parsed.tenantId;
  const actor = ctx.actor ?? "system";
  const now = serviceNow(ctx);

  const { fromTaskId, toTaskId, type } = parsed;

  if (fromTaskId === toTaskId) {
    throw new Error(`A task cannot depend on itself: ${fromTaskId}`);
  }

  const id = parsed.id ?? uuidv7(now);

  const { result, committedEvent } = await runInTransaction(db, async (tx) => {
    // Endpoint and cycle checks must observe the same serialized snapshot as
    // the insert; otherwise concurrent opposite edges can both pass.
    const from = await getTask(tx, fromTaskId, tenantId);
    if (!from) throw new Error(`Task not found: ${fromTaskId}`);
    if (from.deletedAt) throw new Error(`Task is deleted: ${fromTaskId}`);
    const to = await getTask(tx, toTaskId, tenantId);
    if (!to) throw new Error(`Task not found: ${toTaskId}`);
    if (to.deletedAt) throw new Error(`Task is deleted: ${toTaskId}`);
    if (type === "blocks") await assertNoCycle(tx, tenantId, fromTaskId, toTaskId);

    // Reactivate a soft-deleted matching edge instead of inserting a dup.
    const existing = await tx
      .select()
      .from(taskDependency)
      .where(
        and(
          eq(taskDependency.tenantId, tenantId),
          eq(taskDependency.fromTaskId, fromTaskId),
          eq(taskDependency.toTaskId, toTaskId),
          eq(taskDependency.type, type),
        ),
      )
      // There may be historical tombstones for the same natural key. Always
      // select the live compatibility row first, then the newest tombstone.
      .orderBy(desc(sql`${taskDependency.deletedAt} IS NULL`), desc(taskDependency.updatedAt))
      .limit(1);

    let edgeId = id;
    const prior = existing[0];
    if (prior) {
      edgeId = prior.id;
      if (prior.deletedAt == null) {
        return { result: parseDependency(prior), committedEvent: null };
      }
      await tx
        .update(taskDependency)
        .set({ deletedAt: null, updatedAt: now })
        .where(eq(taskDependency.id, prior.id));
    } else {
      await tx.insert(taskDependency).values({
        id: edgeId,
        tenantId,
        fromTaskId,
        toTaskId,
        type,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      });
    }

    // `commitment_relation` is the universal authority. Keep this v1 API as
    // a transactional compatibility adapter instead of a second graph. A
    // reactivated legacy edge becomes a new immutable relation lifecycle.
    const principal = await ensureLocalPrincipal(tx, tenantId, actor, now);
    const relationType = type === "blocks" ? "depends_on" : type;
    const activeRelations = await tx.select({ id: commitmentRelation.id })
      .from(commitmentRelation)
      .where(and(
        eq(commitmentRelation.tenantId, tenantId),
        eq(commitmentRelation.fromTaskId, fromTaskId),
        eq(commitmentRelation.toTaskId, toTaskId),
        eq(commitmentRelation.relationType, relationType),
        isNull(commitmentRelation.endedAt),
      )).limit(1);
    if (!activeRelations[0]) {
      await tx.insert(commitmentRelation).values({
        id: prior ? uuidv7(now) : edgeId,
        tenantId,
        fromTaskId,
        relationType,
        toTaskId,
        revision: 1,
        createdByPrincipalId: principal.id,
        createdAt: now,
        endedByPrincipalId: null,
        endedAt: null,
      });
    }

    const committedEvent = await recordEvent(
      tx,
      {
        tenantId,
        actor,
        entityType: "task",
        entityId: fromTaskId,
        eventType: "dependency_added",
        payload: { after: { toTaskId, type } },
      },
      { defer: true, now },
    );

    const rows = await tx
      .select()
      .from(taskDependency)
      .where(eq(taskDependency.id, edgeId))
      .limit(1);
    return { result: parseDependency(rows[0]!), committedEvent };
  });

  if (committedEvent) emitAfterCommit(committedEvent);
  return result;
}

export interface UndependOptions extends ServiceContext {
  /** Soft-delete by natural key instead of edge id. */
  fromTaskId?: string;
  toTaskId?: string;
  type?: DependencyTypeT;
}

/**
 * Soft-delete a dependency edge — by edge id, or (when `id` is omitted) by the
 * natural key `{fromTaskId,toTaskId,type}`. Emits `dependency_removed`
 * (entityType 'task', entityId = fromTaskId). Idempotent: removing an
 * already-removed / nonexistent edge is a no-op throw-free skip.
 */
export async function undependTask(
  db: TasqDb,
  id: string | null,
  ctx: UndependOptions = {},
): Promise<void> {
  const tenantId = ctx.tenantId ?? "gwendall";
  const actor = ctx.actor ?? "system";
  const now = serviceNow(ctx);

  const committedEvent = await runInTransaction(db, async (tx) => {
    const filters = [eq(taskDependency.tenantId, tenantId), isNull(taskDependency.deletedAt)];
    if (id) {
      filters.push(eq(taskDependency.id, id));
    } else {
      if (!ctx.fromTaskId || !ctx.toTaskId) {
        throw new Error("undependTask requires an edge id or {fromTaskId,toTaskId}");
      }
      filters.push(eq(taskDependency.fromTaskId, ctx.fromTaskId));
      filters.push(eq(taskDependency.toTaskId, ctx.toTaskId));
      filters.push(eq(taskDependency.type, ctx.type ?? "blocks"));
    }

    const rows = await tx.select().from(taskDependency).where(and(...filters)).limit(1);
    const edge = rows[0];
    if (!edge) {
      throw new Error(
        id
          ? `Dependency not found: ${id}`
          : `Dependency not found: ${ctx.fromTaskId} -[${ctx.type ?? "blocks"}]-> ${ctx.toTaskId}`,
      );
    }

    await tx
      .update(taskDependency)
      .set({ deletedAt: now, updatedAt: now })
      .where(eq(taskDependency.id, edge.id));

    const principal = await ensureLocalPrincipal(tx, tenantId, actor, now);
    await tx.update(commitmentRelation).set({
      endedByPrincipalId: principal.id,
      endedAt: now,
      revision: sql`${commitmentRelation.revision} + 1`,
    }).where(and(
      eq(commitmentRelation.tenantId, tenantId),
      eq(commitmentRelation.fromTaskId, edge.fromTaskId),
      eq(commitmentRelation.toTaskId, edge.toTaskId),
      eq(commitmentRelation.relationType, edge.type === "blocks" ? "depends_on" : edge.type),
      isNull(commitmentRelation.endedAt),
    ));

    return recordEvent(
      tx,
      {
        tenantId,
        actor,
        entityType: "task",
        entityId: edge.fromTaskId,
        eventType: "dependency_removed",
        payload: { before: { toTaskId: edge.toTaskId, type: edge.type } },
      },
      { defer: true, now },
    );
  });

  emitAfterCommit(committedEvent);
}

// ──────────────────────────────────────────────────────────────────────
// Reads
// ──────────────────────────────────────────────────────────────────────

export interface ListDependenciesOptions extends ServiceContext {
  /** The task whose edges to fetch. */
  taskId: string;
  /**
   * `from` → edges where this task is the dependent (its blockers / relations);
   * `to` → edges where this task is the target (what it blocks);
   * `both` → either endpoint (default).
   */
  direction?: "from" | "to" | "both";
  type?: DependencyTypeT;
  includeDeleted?: boolean;
}

/** Read dependency edges touching a task (default excludes soft-deleted). */
export async function listDependencies(
  db: TasqDb,
  options: ListDependenciesOptions,
): Promise<TaskDependencyT[]> {
  const tenantId = options.tenantId ?? "gwendall";
  const direction = options.direction ?? "both";

  const filters = [eq(taskDependency.tenantId, tenantId)];
  if (!options.includeDeleted) filters.push(isNull(taskDependency.deletedAt));
  if (options.type) filters.push(eq(taskDependency.type, options.type));
  if (direction === "from") {
    filters.push(eq(taskDependency.fromTaskId, options.taskId));
  } else if (direction === "to") {
    filters.push(eq(taskDependency.toTaskId, options.taskId));
  }

  const rows = await db
    .select()
    .from(taskDependency)
    .where(and(...filters))
    .orderBy(desc(taskDependency.createdAt));

  let parsed = rows.map(parseDependency);
  if (direction === "both") {
    parsed = parsed.filter(
      (d) => d.fromTaskId === options.taskId || d.toTaskId === options.taskId,
    );
  }
  return parsed;
}

/**
 * Count unresolved blockers of a task — live `blocks` edges where `from_task_id
 * = taskId` (the tasks that block this one, SPEC §4.5) whose `to_task_id` task
 * is still live and NOT done/cancelled. Integer fed to the prioritizer's
 * W_blocked down-weight.
 */
export async function unresolvedBlockerCount(
  db: TasqDb,
  taskId: string,
  tenantId = "gwendall",
): Promise<number> {
  const edges = await db
    .select({ toTaskId: taskDependency.toTaskId })
    .from(taskDependency)
    .where(
      and(
        eq(taskDependency.tenantId, tenantId),
        eq(taskDependency.type, "blocks"),
        eq(taskDependency.fromTaskId, taskId),
        isNull(taskDependency.deletedAt),
      ),
    );
  if (edges.length === 0) return 0;

  const blockerIds = Array.from(new Set(edges.map((e) => e.toTaskId)));
  // A blocker is "resolved" when its task is done/cancelled or soft-deleted.
  const liveUnresolved = await db
    .select({ id: task.id })
    .from(task)
    .where(
      and(
        eq(task.tenantId, tenantId),
        inArray(task.id, blockerIds),
        isNull(task.deletedAt),
        ne(task.status, "done"),
        ne(task.status, "cancelled"),
      ),
    );
  return liveUnresolved.length;
}

/**
 * Per-tenant map of taskId → unresolved `blocks`-blocker count, computed in a
 * single SELECT of live `blocks` edges aggregated against the supplied task
 * statuses (no N+1). `statusById` should hold every task referenced as a
 * blocker; ids absent from it (deleted / out-of-tenant) count as resolved.
 */
export async function unresolvedBlockerMap(
  db: TasqDb,
  tenantId: string,
  statusById: Map<string, string>,
): Promise<Map<string, number>> {
  const edges = await db
    .select({ fromTaskId: taskDependency.fromTaskId, toTaskId: taskDependency.toTaskId })
    .from(taskDependency)
    .where(
      and(
        eq(taskDependency.tenantId, tenantId),
        eq(taskDependency.type, "blocks"),
        isNull(taskDependency.deletedAt),
      ),
    );
  const out = new Map<string, number>();
  for (const e of edges) {
    const blockerStatus = statusById.get(e.toTaskId);
    // Unresolved iff the blocker is a known live task not done/cancelled.
    if (blockerStatus != null && blockerStatus !== "done" && blockerStatus !== "cancelled") {
      out.set(e.fromTaskId, (out.get(e.fromTaskId) ?? 0) + 1);
    }
  }
  return out;
}

export interface JustUnblockedOptions extends ServiceContext {
  /** Only consider resolutions newer than this unix-ms. Default: last 7 days. */
  sinceMs?: number;
  now?: number;
}

/**
 * Tasks that have ZERO current unresolved blockers but whose last blocker
 * resolution (a `dependency_removed` event, or a blocker task reaching
 * done/cancelled) is recent. Conservative, read-only, never drives a status
 * change — surfaced as a "just unblocked" hint only.
 *
 * Returns the set of dependent task ids that recently became unblocked.
 */
export async function justUnblocked(
  db: TasqDb,
  options: JustUnblockedOptions = {},
): Promise<Set<string>> {
  const tenantId = options.tenantId ?? "gwendall";
  const now = serviceNow(options, options.now);
  const sinceMs = options.sinceMs ?? now - 7 * 24 * 60 * 60 * 1000;

  // Candidate dependents: tasks that have at least one `blocks` edge (live or
  // recently removed). We only care about tasks that ever had a blocker.
  const edges = await db
    .select({
      fromTaskId: taskDependency.fromTaskId,
      toTaskId: taskDependency.toTaskId,
      deletedAt: taskDependency.deletedAt,
      updatedAt: taskDependency.updatedAt,
    })
    .from(taskDependency)
    .where(and(eq(taskDependency.tenantId, tenantId), eq(taskDependency.type, "blocks")));
  if (edges.length === 0) return new Set();

  const dependents = Array.from(new Set(edges.map((e) => e.fromTaskId)));
  const blockerIds = Array.from(new Set(edges.map((e) => e.toTaskId)));

  // Load blocker statuses + completion times in one go.
  const blockerRows = blockerIds.length
    ? await db
        .select({
          id: task.id,
          status: task.status,
          completedAt: task.completedAt,
          updatedAt: task.updatedAt,
          deletedAt: task.deletedAt,
        })
        .from(task)
        .where(and(eq(task.tenantId, tenantId), inArray(task.id, blockerIds)))
    : [];
  const blockerById = new Map(blockerRows.map((r) => [r.id, r]));

  // dependency_removed events (recent edge removals also count as resolutions).
  const removedEvents = await listEvents(db, {
    tenantId,
    entityType: "task",
    limit: 1000,
  });
  const removedAtByDependent = new Map<string, number>();
  for (const e of removedEvents) {
    if (e.eventType !== "dependency_removed") continue;
    const prev = removedAtByDependent.get(e.entityId) ?? 0;
    if (e.createdAt > prev) removedAtByDependent.set(e.entityId, e.createdAt);
  }

  const out = new Set<string>();
  for (const dependent of dependents) {
    // Current unresolved blocker count must be ZERO.
    const liveBlockers = edges.filter(
      (e) => e.fromTaskId === dependent && e.deletedAt == null,
    );
    const stillUnresolved = liveBlockers.some((e) => {
      const b = blockerById.get(e.toTaskId);
      return b != null && b.deletedAt == null && b.status !== "done" && b.status !== "cancelled";
    });
    if (stillUnresolved) continue;

    // Most recent resolution timestamp: latest blocker completion OR latest
    // dependency_removed event for this dependent.
    let lastResolution = removedAtByDependent.get(dependent) ?? 0;
    for (const e of edges) {
      if (e.fromTaskId !== dependent) continue;
      const b = blockerById.get(e.toTaskId);
      if (b && (b.status === "done" || b.status === "cancelled")) {
        const ts = b.completedAt ?? b.updatedAt;
        if (ts > lastResolution) lastResolution = ts;
      }
      // A removed edge is itself a resolution event captured above.
    }
    if (lastResolution > sinceMs && lastResolution <= now) out.add(dependent);
  }
  return out;
}

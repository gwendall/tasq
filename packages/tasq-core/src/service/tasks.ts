/**
 * Task service — the core verbs (create, update, status transitions, list).
 *
 * Every mutation:
 *   1. Validates input via Zod
 *   2. Mutates the row
 *   3. Records an event
 *
 * Status transitions are validated against an explicit state machine
 * (`STATUS_TRANSITIONS`). Invalid transitions throw rather than
 * silently fail.
 */

import { and, asc, desc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import {
  task,
  taskAttempt,
  taskClaim,
  taskEvidence,
  completionRecord,
  waitCondition,
  uuidv7,
  Task as TaskZ,
  TaskInsert,
  TaskUpdate,
  TaskStatus,
  MAX_TASK_DEPTH,
  type Task as TaskT,
  type TaskStatus as TaskStatusT,
  type Event as EventT,
} from "@tasq-run/schema";
import type { TasqDb, TasqDbOrTx } from "../db.js";
import { runInTransaction } from "../db.js";
import { recordEvent, emitAfterCommit } from "./events.js";
import { parseRow } from "../util/row.js";
import { diffRecords } from "../util/diff.js";
import { serviceNow } from "../util/clock.js";
import {
  findIdempotencyResult,
  prepareIdempotency,
  saveIdempotencyResult,
} from "./idempotency.js";
import { ensureLocalPrincipal, getPrincipal } from "./principals.js";
import type { ServiceContext } from "./context.js";

// ──────────────────────────────────────────────────────────────────────
// Ancestor-liveness guards (SPEC §4.4: a tombstoned ancestor must not
// silently anchor a live task)
// ──────────────────────────────────────────────────────────────────────

/**
 * Throw if the referenced area/goal/project is missing or soft-deleted.
 * Only invoked for non-null ids (create/update/reparent against a live
 * ancestor). Mirrors the parent-deleted guard in `createTask`.
 */
export interface TaskServiceContext extends ServiceContext {
  /** Internal composition seam; public kernel callers deliberately cannot select a domain profile. */
  hierarchyPolicy?: TaskHierarchyPolicy;
}

export interface TaskScopeInput {
  areaId?: string | null;
  goalId?: string | null;
  projectId?: string | null;
  parentTaskId?: string | null;
}

export interface CanonicalTaskScope {
  areaId: string | null;
  goalId: string | null;
  projectId: string | null;
  parentTaskId: string | null;
}

/**
 * Resolve the one canonical ancestry chain for a task.
 *
 * A child task cannot override its parent's scope. A project determines its
 * goal/area and a goal determines its area. Callers may repeat those derived
 * ids for convenience, but contradictory combinations are rejected instead
 * of being persisted as several competing truths.
 */
export interface TaskHierarchyPolicy {
  resolveScope(
    db: TasqDbOrTx,
    tenantId: string,
    input: TaskScopeInput,
  ): Promise<CanonicalTaskScope>;
  assertLiveAncestors(
    db: TasqDbOrTx,
    tenantId: string,
    ancestors: Pick<TaskScopeInput, "areaId" | "goalId" | "projectId">,
  ): Promise<void>;
}

const flatHierarchyPolicy: TaskHierarchyPolicy = {
  async resolveScope(_db, _tenantId, input) {
    if (
      input.parentTaskId == null &&
      input.projectId == null &&
      input.goalId == null &&
      input.areaId == null
    ) {
      return { parentTaskId: null, projectId: null, goalId: null, areaId: null };
    }
    throw new Error("Hierarchical task scope requires an injected planning-profile policy");
  },
  async assertLiveAncestors(_db, _tenantId, ancestors) {
    if (ancestors.areaId == null && ancestors.goalId == null && ancestors.projectId == null) return;
    throw new Error("Hierarchical task scope requires an injected planning-profile policy");
  },
};

// ──────────────────────────────────────────────────────────────────────
// Status state machine
// ──────────────────────────────────────────────────────────────────────

const STATUS_TRANSITIONS: Record<TaskStatusT, readonly TaskStatusT[]> = {
  open: ["in_progress", "blocked", "done", "cancelled"],
  in_progress: ["open", "blocked", "done", "cancelled"],
  blocked: ["open", "in_progress", "done", "cancelled"],
  done: ["in_progress", "open"], // allow re-open (mistakes happen)
  cancelled: ["open"], // allow un-cancel
};

function assertTransition(from: TaskStatusT, to: TaskStatusT): void {
  if (from === to) return;
  const allowed = STATUS_TRANSITIONS[from];
  if (!allowed.includes(to)) {
    throw new Error(`Invalid task status transition: ${from} → ${to}`);
  }
}

// ──────────────────────────────────────────────────────────────────────
// Parsing
// ──────────────────────────────────────────────────────────────────────

function parseTask(row: typeof task.$inferSelect): TaskT {
  return TaskZ.parse(parseRow(row));
}

export interface CreateTaskInTransactionOptions {
  tenantId: string;
  actor: string;
  principalId?: string;
  now: number;
  /** Extra immutable provenance included in the task creation event. */
  eventContext?: { note?: string; reason?: string; source?: string };
  hierarchyPolicy?: TaskHierarchyPolicy;
}

/**
 * Canonical task creation primitive for services already holding a writer
 * transaction. Public callers use `createTask`; deadline fallbacks use this
 * helper so task validation, hierarchy derivation and audit stay identical.
 */
export async function createTaskInTransaction(
  tx: TasqDbOrTx,
  parsed: TaskInsert,
  options: CreateTaskInTransactionOptions,
): Promise<{ result: TaskT; event: EventT }> {
  const { tenantId, actor, now } = options;
  if (parsed.status !== "open") {
    throw new Error("Tasks must be created open; use a status transition to preserve engine timestamps and audit semantics");
  }
  if (parsed.completionMode === "evidence" && !parsed.successCriteria?.trim()) {
    throw new Error("Evidence-backed tasks require explicit successCriteria");
  }
  const id = parsed.id ?? uuidv7(now);
  const scope = await (options.hierarchyPolicy ?? flatHierarchyPolicy).resolveScope(tx, tenantId, parsed);
  if (scope.parentTaskId) {
    const parentDepth = await getTaskDepth(tx, scope.parentTaskId, tenantId);
    if (parentDepth + 1 > MAX_TASK_DEPTH) {
      throw new Error(
        `Task hierarchy exceeds max depth ${MAX_TASK_DEPTH} (would be ${parentDepth + 1}). Consider modeling with a project instead.`,
      );
    }
  }

  await tx.insert(task).values({
    id,
    tenantId,
    projectId: scope.projectId,
    goalId: scope.goalId,
    areaId: scope.areaId,
    parentTaskId: scope.parentTaskId,
    title: parsed.title,
    description: parsed.description,
    nextAction: parsed.nextAction,
    successCriteria: parsed.successCriteria,
    completionMode: parsed.completionMode,
    status: parsed.status,
    priority: parsed.priority,
    estimatedMinutes: parsed.estimatedMinutes,
    scheduledAt: parsed.scheduledAt,
    dueAt: parsed.dueAt,
    startedAt: null,
    completedAt: null,
    recurrence: parsed.recurrence,
    recurrenceInterval: parsed.recurrenceInterval,
    recurrenceAnchor: parsed.recurrenceAnchor,
    lastDoneAt: null,
    streak: 0,
    recurrenceParentId: parsed.recurrenceParentId ?? null,
    metadata: JSON.stringify(parsed.metadata),
    revision: 1,
    createdAt: now,
    updatedAt: now,
  });

  const event = await recordEvent(
    tx,
    {
      tenantId,
      actor,
      principalId: options.principalId,
      entityType: "task",
      entityId: id,
      eventType: "created",
      payload: {
        after: {
          title: parsed.title,
          status: parsed.status,
          completionMode: parsed.completionMode,
          areaId: scope.areaId,
          goalId: scope.goalId,
          projectId: scope.projectId,
          ...(scope.parentTaskId ? { parentTaskId: scope.parentTaskId } : {}),
        },
        ...(options.eventContext ?? {}),
      },
    },
    { defer: true, now },
  );
  const result = await getTask(tx, id, tenantId);
  if (!result) throw new Error(`Failed to read back task ${id}`);
  return { result, event };
}

/** Make an existing fallback immediately actionable without claiming it. */
export async function activateTaskInTransaction(
  tx: TasqDbOrTx,
  id: string,
  options: {
    tenantId: string;
    actor: string;
    now: number;
    waitConditionId: string;
    sourceTaskId: string;
    hierarchyPolicy?: TaskHierarchyPolicy;
  },
): Promise<{ result: TaskT; event: EventT }> {
  const before = await getTask(tx, id, options.tenantId);
  if (!before) throw new Error(`Fallback task not found: ${id}`);
  if (before.deletedAt != null) throw new Error(`Fallback task is deleted: ${id}`);
  if (before.status === "done" || before.status === "cancelled") {
    throw new Error(`Fallback task is terminal: ${id} (${before.status})`);
  }
  await (options.hierarchyPolicy ?? flatHierarchyPolicy).assertLiveAncestors(
    tx,
    options.tenantId,
    before,
  );

  const nextStatus = before.status === "blocked" ? "open" : before.status;
  assertTransition(before.status, nextStatus);
  if (nextStatus !== before.status || before.scheduledAt != null) {
    await tx
      .update(task)
      .set({ status: nextStatus, scheduledAt: null, updatedAt: options.now, revision: sql`${task.revision} + 1` })
      .where(and(eq(task.id, id), eq(task.tenantId, options.tenantId)));
  }
  const result = await getTask(tx, id, options.tenantId);
  if (!result) throw new Error(`Failed to read back fallback task ${id}`);
  const event = await recordEvent(
    tx,
    {
      tenantId: options.tenantId,
      actor: options.actor,
      entityType: "task",
      entityId: id,
      eventType: "wait_fallback_activated",
      payload: {
        before: { status: before.status, scheduledAt: before.scheduledAt },
        after: {
          status: result.status,
          scheduledAt: result.scheduledAt,
          waitConditionId: options.waitConditionId,
          sourceTaskId: options.sourceTaskId,
        },
        source: `wait:${options.waitConditionId}`,
      },
    },
    { defer: true, now: options.now },
  );
  return { result, event };
}

// ──────────────────────────────────────────────────────────────────────
// Create / Read
// ──────────────────────────────────────────────────────────────────────

export async function createTask(
  db: TasqDb,
  input: unknown,
  ctx: TaskServiceContext = {},
): Promise<TaskT> {
  const parsed = TaskInsert.parse(input);
  if (parsed.status !== "open") {
    throw new Error("Tasks must be created open; use a status transition to preserve engine timestamps and audit semantics");
  }
  if (parsed.completionMode === "evidence" && !parsed.successCriteria?.trim()) {
    throw new Error("Evidence-backed tasks require explicit successCriteria");
  }
  const now = serviceNow(ctx, ctx.now);
  const tenantId = ctx.tenantId ?? parsed.tenantId;
  const actor = ctx.actor ?? "system";
  const retryRequest = { ...parsed, tenantId, actor, principalId: ctx.principalId ?? null };
  const retry = prepareIdempotency(
    { ...ctx, tenantId, actor },
    "task.create",
    retryRequest,
    { now, legacyRequest: retryRequest },
  );

  const { result, committedEvent } = await runInTransaction(db, async (tx) => {
    const prior = await findIdempotencyResult(tx, retry);
    if (prior) {
      const existing = await getTask(tx, prior.resultId, tenantId);
      if (!existing) throw new Error(`Idempotency record points at missing task ${prior.resultId}`);
      return { result: existing, committedEvent: null };
    }

    const created = await createTaskInTransaction(tx, parsed, {
      tenantId, actor, principalId: ctx.principalId, now,
      hierarchyPolicy: ctx.hierarchyPolicy,
    });

    await saveIdempotencyResult(tx, retry, {
      resultType: "commitment",
      resultId: created.result.id,
      resultStatus: created.result.status,
      resultRevision: created.result.revision,
      eventSequence: created.event.sequence,
    });

    return { result: created.result, committedEvent: created.event };
  });

  if (committedEvent) emitAfterCommit(committedEvent);
  return result;
}

/**
 * Depth of a task in the hierarchy.
 *   - top-level (parent_task_id IS NULL) → 1
 *   - child of top-level → 2
 *   - ...
 * Implementation: walk parent_task_id upward. Stops at MAX_TASK_DEPTH+1 as
 * a safety net (a cycle would have been rejected on create, but defensive
 * coding doesn't hurt — this is read-only).
 */
export async function getTaskDepth(
  db: TasqDbOrTx,
  id: string,
  tenantId = "gwendall",
): Promise<number> {
  let depth = 1;
  let currentId: string | null = id;
  const seen = new Set<string>();

  while (currentId && depth <= MAX_TASK_DEPTH + 1) {
    if (seen.has(currentId)) {
      throw new Error(`Cycle detected in task hierarchy at ${currentId}`);
    }
    seen.add(currentId);

    const rows: { parentTaskId: string | null }[] = await db
      .select({ parentTaskId: task.parentTaskId })
      .from(task)
      .where(and(eq(task.id, currentId), eq(task.tenantId, tenantId)))
      .limit(1);

    const row = rows[0];
    if (!row) return depth;
    if (row.parentTaskId == null) return depth;

    currentId = row.parentTaskId;
    depth++;
  }

  return depth;
}

/**
 * Height of a task's subtree (counting itself as 1). Used for reparent
 * depth checks. A task with no children → 1. Leaf-only children → 2.
 */
export async function subtreeHeight(
  db: TasqDbOrTx,
  id: string,
  tenantId = "gwendall",
): Promise<number> {
  let height = 1;
  let frontier: string[] = [id];
  // Defensive: cap iterations at MAX_TASK_DEPTH+1
  for (let i = 0; i <= MAX_TASK_DEPTH + 1; i++) {
    const rows = await db
      .select({ id: task.id })
      .from(task)
      .where(
        and(
          eq(task.tenantId, tenantId),
          inArray(task.parentTaskId, frontier),
          isNull(task.deletedAt),
        ),
      );
    if (rows.length === 0) return height;
    frontier = rows.map((r) => r.id);
    height++;
  }
  return height;
}

/**
 * Return a task plus all its descendants, breadth-first.
 * Order: parent first, then children in order, then grandchildren, etc.
 * Returns null if root task doesn't exist.
 */
export async function getTaskTree(
  db: TasqDb,
  rootId: string,
  tenantId = "gwendall",
  options: { includeDeleted?: boolean } = {},
): Promise<TaskT[] | null> {
  const root = await getTask(db, rootId, tenantId);
  if (!root) return null;

  const result: TaskT[] = [root];
  let frontier: string[] = [rootId];
  const seen = new Set<string>([rootId]);

  while (frontier.length > 0) {
    const filters = [
      eq(task.tenantId, tenantId),
      inArray(task.parentTaskId, frontier),
    ];
    if (!options.includeDeleted) filters.push(isNull(task.deletedAt));

    const rows = await db
      .select()
      .from(task)
      .where(and(...filters))
      .orderBy(asc(task.createdAt));

    if (rows.length === 0) break;
    const parsed = rows.map(parseTask).filter((child) => {
      if (seen.has(child.id)) return false;
      seen.add(child.id);
      return true;
    });
    if (parsed.length === 0) break;
    result.push(...parsed);
    frontier = parsed.map((t) => t.id);
  }

  return result;
}

export async function getTask(
  db: TasqDbOrTx,
  id: string,
  tenantId = "gwendall",
): Promise<TaskT | null> {
  const rows = await db
    .select()
    .from(task)
    .where(and(eq(task.id, id), eq(task.tenantId, tenantId)))
    .limit(1);
  const row = rows[0];
  return row ? parseTask(row) : null;
}

// ──────────────────────────────────────────────────────────────────────
// Update (non-status fields)
// ──────────────────────────────────────────────────────────────────────

export interface UpdateTaskInTransactionOptions {
  tenantId: string;
  actor: string;
  principalId?: string;
  now: number;
  expectedRevision?: number;
  hierarchyPolicy?: TaskHierarchyPolicy;
}

/**
 * Canonical non-status update primitive for callers that already own the
 * writer transaction. Replication uses this exact path so remote application
 * cannot bypass hierarchy, completion or local CAS invariants.
 */
export async function updateTaskInTransaction(
  tx: TasqDbOrTx,
  id: string,
  parsed: TaskUpdate,
  options: UpdateTaskInTransactionOptions,
): Promise<{ result: TaskT; event: EventT | null }> {
  const { tenantId, actor, now, expectedRevision } = options;
  const before = await getTask(tx, id, tenantId);
  if (!before) throw new Error(`Task not found: ${id}`);
  if (before.deletedAt) throw new Error(`Task is deleted: ${id}`);
  const desiredCompletionMode = parsed.completionMode ?? before.completionMode;
  const desiredSuccessCriteria =
    parsed.successCriteria !== undefined ? parsed.successCriteria : before.successCriteria;
  if (desiredCompletionMode === "evidence" && !desiredSuccessCriteria?.trim()) {
    throw new Error("Evidence-backed tasks require explicit successCriteria");
  }
  if (
    (before.status === "done" || before.status === "cancelled") &&
    (parsed.completionMode !== undefined || parsed.successCriteria !== undefined)
  ) {
    throw new Error("Cannot change completion semantics on a terminal task; reopen it first");
  }
  const changed = Object.entries(parsed).some(
    ([key, value]) => JSON.stringify(before[key as keyof TaskT]) !== JSON.stringify(value),
  );
  if (!changed) return { result: before, event: null };

  const desiredParent =
    parsed.parentTaskId !== undefined ? parsed.parentTaskId : before.parentTaskId;

  // Reparent validation belongs in the write transaction. This closes the
  // classic concurrent A→B / B→A race where both callers otherwise validate
  // against stale pre-transaction state.
  if (desiredParent !== before.parentTaskId) {
    if (desiredParent === id) throw new Error("Task cannot be its own parent");
    if (desiredParent !== null) {
      let cursor: string | null = desiredParent;
      const seen = new Set<string>();
      while (cursor) {
        if (cursor === id) {
          throw new Error(
            `Reparent would create a cycle: task ${id} is an ancestor of ${desiredParent}`,
          );
        }
        if (seen.has(cursor)) throw new Error(`Pre-existing cycle in task hierarchy at ${cursor}`);
        seen.add(cursor);
        const rows: { parentTaskId: string | null }[] = await tx
          .select({ parentTaskId: task.parentTaskId })
          .from(task)
          .where(and(eq(task.id, cursor), eq(task.tenantId, tenantId)))
          .limit(1);
        cursor = rows[0]?.parentTaskId ?? null;
      }

      const newParentDepth = await getTaskDepth(tx, desiredParent, tenantId);
      const ownSubtreeHeight = await subtreeHeight(tx, id, tenantId);
      if (newParentDepth + ownSubtreeHeight > MAX_TASK_DEPTH) {
        throw new Error(
          `Reparent would exceed max task depth ${MAX_TASK_DEPTH} (parent depth ${newParentDepth} + subtree height ${ownSubtreeHeight}).`,
        );
      }
    }
  }

  const scope = await (options.hierarchyPolicy ?? flatHierarchyPolicy).resolveScope(tx, tenantId, {
    parentTaskId: desiredParent,
    projectId:
      desiredParent != null && parsed.projectId === undefined
        ? undefined
        : parsed.projectId !== undefined
          ? parsed.projectId
          : before.projectId,
    goalId:
      desiredParent != null && parsed.goalId === undefined
        ? undefined
        : parsed.goalId !== undefined
          ? parsed.goalId
          : before.goalId,
    areaId:
      desiredParent != null && parsed.areaId === undefined
        ? undefined
        : parsed.areaId !== undefined
          ? parsed.areaId
          : before.areaId,
  });

  const patch: Partial<typeof task.$inferInsert> = {
    updatedAt: now,
    parentTaskId: scope.parentTaskId,
    projectId: scope.projectId,
    goalId: scope.goalId,
    areaId: scope.areaId,
  };
  if (parsed.title !== undefined) patch.title = parsed.title;
  if (parsed.description !== undefined) patch.description = parsed.description;
  if (parsed.nextAction !== undefined) patch.nextAction = parsed.nextAction;
  if (parsed.successCriteria !== undefined) patch.successCriteria = parsed.successCriteria;
  if (parsed.completionMode !== undefined) patch.completionMode = parsed.completionMode;
  if (parsed.priority !== undefined) patch.priority = parsed.priority;
  if (parsed.estimatedMinutes !== undefined) patch.estimatedMinutes = parsed.estimatedMinutes;
  if (parsed.scheduledAt !== undefined) patch.scheduledAt = parsed.scheduledAt;
  if (parsed.dueAt !== undefined) patch.dueAt = parsed.dueAt;
  if (parsed.recurrence !== undefined) patch.recurrence = parsed.recurrence;
  if (parsed.recurrenceInterval !== undefined) patch.recurrenceInterval = parsed.recurrenceInterval;
  if (parsed.recurrenceAnchor !== undefined) patch.recurrenceAnchor = parsed.recurrenceAnchor;
  if (parsed.metadata !== undefined) patch.metadata = JSON.stringify(parsed.metadata);

  const updated = await tx
    .update(task)
    .set({ ...patch, revision: sql`${task.revision} + 1` })
    .where(and(
      eq(task.id, id),
      eq(task.tenantId, tenantId),
      ...(expectedRevision === undefined ? [] : [eq(task.revision, expectedRevision)]),
    ))
    .returning({ id: task.id });
  if (expectedRevision !== undefined && updated.length === 0) {
    throw new Error(`Stale task revision: expected ${expectedRevision}`);
  }

  const result = (await getTask(tx, id, tenantId)) as TaskT;
  const event = await recordEvent(
    tx,
    {
      tenantId,
      actor,
      principalId: options.principalId,
      entityType: "task",
      entityId: id,
      eventType: "updated",
      payload: diffRecords(before, result),
    },
    { defer: true, now },
  );
  return { result, event };
}

export async function updateTask(
  db: TasqDb,
  id: string,
  update: unknown,
  ctx: TaskServiceContext = {},
): Promise<TaskT> {
  const parsed = TaskUpdate.parse(update);
  const tenantId = ctx.tenantId ?? "gwendall";
  const actor = ctx.actor ?? "system";
  const expectedRevision = ctx.expectedRevision;
  const now = serviceNow(ctx, ctx.now);
  const identity = prepareIdempotency({ ...ctx, tenantId, actor }, "task.update", {
    taskId: id,
    patch: parsed,
    expectedRevision: expectedRevision ?? null,
  }, { now });
  const { after, committedEvent } = await runInTransaction(db, async (tx) => {
    const prior = await findIdempotencyResult(tx, identity);
    if (prior) {
      const existing = await getTask(tx, prior.resultId, tenantId);
      if (!existing) throw new Error(`Idempotency record points at missing task ${prior.resultId}`);
      return { after: existing, committedEvent: null };
    }
    const updated = await updateTaskInTransaction(tx, id, parsed, {
      tenantId,
      actor,
      principalId: ctx.principalId,
      now,
      expectedRevision,
      hierarchyPolicy: ctx.hierarchyPolicy,
    });

    await saveIdempotencyResult(tx, identity, {
      resultType: "commitment",
      resultId: updated.result.id,
      resultStatus: updated.result.status,
      resultRevision: updated.result.revision,
      eventSequence: updated.event?.sequence,
    });

    return { after: updated.result, committedEvent: updated.event };
  });

  if (committedEvent) emitAfterCommit(committedEvent);
  return after;
}

// ──────────────────────────────────────────────────────────────────────
// Status transitions (start / done / block / unblock / cancel / restore)
// ──────────────────────────────────────────────────────────────────────

export interface StatusChangeOptions extends TaskServiceContext {
  /** Canonical kernel callers must guard mutable state with this revision. */
  expectedRevision?: number;
  reason?: string;
  note?: string;
  source?: string;
  /** Domain time of the action; recording time remains independently audited. */
  occurredAt?: number;
  /** Evidence explicitly used to justify completion. */
  evidenceIds?: string[];
}

export interface RecurringCompletionMaterializer {
  (
    tx: TasqDbOrTx,
    completed: TaskT,
    occurredAt: number,
    context: { tenantId: string; actor: string },
  ): Promise<{ event: EventT }>;
}

export async function transitionTaskStatus(
  db: TasqDb,
  id: string,
  to: TaskStatusT,
  options: StatusChangeOptions = {},
  recurringCompletionMaterializer?: RecurringCompletionMaterializer,
): Promise<TaskT> {
  const tenantId = options.tenantId ?? "gwendall";
  const actor = options.actor ?? "system";
  const now = serviceNow(options, options.now);
  const occurredAt = options.occurredAt ?? now;
  if (!Number.isSafeInteger(occurredAt) || occurredAt < 0) {
    throw new Error("occurredAt must be a non-negative unix-ms integer");
  }
  const requestedEvidenceIds = Array.from(new Set(options.evidenceIds ?? [])).sort();
  const identity = prepareIdempotency(
    { ...options, tenantId, actor },
    `task.transition.${to}`,
    {
      taskId: id,
      to,
      expectedRevision: options.expectedRevision ?? null,
      reason: options.reason ?? null,
      note: options.note ?? null,
      source: options.source ?? null,
      occurredAt: options.occurredAt ?? null,
      evidenceIds: requestedEvidenceIds,
    },
    { now },
  );

  const { after, committedEvents } = await runInTransaction(db, async (tx) => {
    const prior = await findIdempotencyResult(tx, identity);
    if (prior) {
      const existing = await getTask(tx, prior.resultId, tenantId);
      if (!existing) throw new Error(`Idempotency record points at missing task ${prior.resultId}`);
      return { after: existing, committedEvents: [] as EventT[] };
    }
    const before = await getTask(tx, id, tenantId);
    if (!before) throw new Error(`Task not found: ${id}`);
    if (before.deletedAt) throw new Error(`Task is deleted: ${id}`);

    // Repeating a terminal/action command is a real idempotent no-op: do not
    // rewrite timestamps, emit an event, or spawn another recurring instance.
    if (before.status === to) {
      await saveIdempotencyResult(tx, identity, {
        resultType: "commitment",
        resultId: before.id,
        resultStatus: before.status,
        resultRevision: before.revision,
      });
      return { after: before, committedEvents: [] as EventT[] };
    }

    assertTransition(before.status, to);
    await (options.hierarchyPolicy ?? flatHierarchyPolicy).assertLiveAncestors(tx, tenantId, before);

    let completionEvidenceIds: string[] = [];
    if (to === "done") {
      completionEvidenceIds = requestedEvidenceIds;
      if (before.completionMode === "evidence" && completionEvidenceIds.length === 0) {
        throw new Error(
          `Task ${id} requires explicit evidence; add evidence and pass its id when completing`,
        );
      }
      if (completionEvidenceIds.length > 0) {
        const rows = await tx
          .select({ id: taskEvidence.id })
          .from(taskEvidence)
          .where(
            and(
              eq(taskEvidence.tenantId, tenantId),
              eq(taskEvidence.taskId, id),
              inArray(taskEvidence.id, completionEvidenceIds),
            ),
          );
        const found = new Set(rows.map((row) => row.id));
        const missing = completionEvidenceIds.filter((evidenceId) => !found.has(evidenceId));
        if (missing.length > 0) {
          throw new Error(`Evidence does not belong to task ${id}: ${missing.join(", ")}`);
        }
        const superseding = await tx
          .select({ supersedesEvidenceId: taskEvidence.supersedesEvidenceId })
          .from(taskEvidence)
          .where(and(
            eq(taskEvidence.tenantId, tenantId),
            inArray(taskEvidence.supersedesEvidenceId, completionEvidenceIds),
          ));
        if (superseding.length > 0) {
          throw new Error("Completion evidence has been superseded");
        }
      }
    }

    // A durable commitment cannot become terminal while an execution attempt
    // still claims to be running or waiting for input. Close the attempt first.
    if (to === "done" || to === "cancelled") {
      const activeAttempts = await tx
        .select({ id: taskAttempt.id })
        .from(taskAttempt)
        .where(
          and(
            eq(taskAttempt.tenantId, tenantId),
            eq(taskAttempt.taskId, id),
            or(eq(taskAttempt.status, "running"), eq(taskAttempt.status, "input_required")),
          ),
        );
      if (activeAttempts.length > 0) {
        throw new Error(
          `Task ${id} has ${activeAttempts.length} active attempt(s); finish or cancel them before making the commitment terminal`,
        );
      }
    }

    const cancelledWaits =
      to === "done" || to === "cancelled"
        ? await cancelWaitingConditionsForTaskTx(tx, id, tenantId, actor, now)
        : { ids: [] as string[], events: [] as EventT[] };

    const patch: Partial<typeof task.$inferInsert> = {
      status: to,
      updatedAt: now,
    };
    if (to === "in_progress" && before.startedAt == null) patch.startedAt = occurredAt;
    if (to === "done") {
      patch.completedAt = occurredAt;
      patch.lastDoneAt = occurredAt;
    }
    if (to === "open" && before.status === "done") patch.completedAt = null;

    const shouldMaterialize = to === "done" && before.recurrence != null && recurringCompletionMaterializer != null;
    const eventType = statusEventType(before.status, to);

    const updated = await tx
      .update(task)
      .set({ ...patch, revision: sql`${task.revision} + 1` })
      .where(and(
        eq(task.id, id),
        eq(task.tenantId, tenantId),
        ...(options.expectedRevision === undefined
          ? []
          : [eq(task.revision, options.expectedRevision)]),
      ))
      .returning({ id: task.id });
    if (options.expectedRevision !== undefined && updated.length === 0) {
      throw new Error(`Stale task revision: expected ${options.expectedRevision}`);
    }

    const after = (await getTask(tx, id, tenantId)) as TaskT;
    const attribution = options.principalId
      ? await getPrincipal(tx, options.principalId, tenantId)
      : await ensureLocalPrincipal(tx, tenantId, actor, now);
    if (!attribution) throw new Error(`Principal not found in workspace: ${options.principalId}`);
    if (attribution.status !== "enabled") throw new Error(`Principal is disabled: ${attribution.id}`);
    let completionRecordId: string | null = null;
    if (to === "done") {
      completionRecordId = uuidv7(now);
      const completionPolicyUri = before.completionMode === "evidence"
        ? "urn:tasq:completion-policy:evidence-required"
        : "urn:tasq:completion-policy:assertion";
      const policyInputDigest = createHash("sha256").update(stableSerialize({
        taskId: id,
        resultingRevision: after.revision,
        completionPolicyUri,
        completionPolicyVersion: 1,
        evidenceIds: completionEvidenceIds,
      })).digest("hex");
      await tx.insert(completionRecord).values({
        id: completionRecordId,
        tenantId,
        taskId: id,
        resultingRevision: after.revision,
        completionPolicyUri,
        completionPolicyVersion: 1,
        policyInputDigest,
        evidenceIds: JSON.stringify(completionEvidenceIds),
        decidedByPrincipalId: attribution.id,
        decidedAt: occurredAt,
      });
    }

    // Terminal commitments release coordination leases automatically. This is
    // state cleanup, not execution success: attempts must already be terminal.
    const releasedClaims =
      to === "done" || to === "cancelled"
        ? await tx
            .update(taskClaim)
            .set({
              releasedAt: now,
              releaseReason: to === "done" ? "task_done" : "task_cancelled",
              updatedAt: now,
              revision: sql`${taskClaim.revision} + 1`,
            })
            .where(
              and(
                eq(taskClaim.tenantId, tenantId),
                eq(taskClaim.taskId, id),
                isNull(taskClaim.releasedAt),
              ),
            )
            .returning({ id: taskClaim.id })
        : [];

    const committedEvents: EventT[] = [...cancelledWaits.events];
    const transitionEvent = await recordEvent(
        tx,
        {
          tenantId,
          actor,
          principalId: attribution.id,
          entityType: "task",
          entityId: id,
          eventType,
          occurredAt: options.occurredAt ?? null,
          payload: {
            before: { status: before.status },
            after: {
              status: to,
              ...(completionEvidenceIds.length > 0 ? { evidenceIds: completionEvidenceIds } : {}),
              ...(completionRecordId ? { completionRecordId } : {}),
              ...(releasedClaims.length > 0
                ? { releasedClaimIds: releasedClaims.map((claim) => claim.id) }
                : {}),
              ...(cancelledWaits.ids.length > 0
                ? { cancelledWaitConditionIds: cancelledWaits.ids }
                : {}),
            },
            ...(options.reason ? { reason: options.reason } : {}),
            ...(options.note ? { note: options.note } : {}),
            ...(options.source ? { source: options.source } : {}),
          },
        },
        { defer: true, now },
      );
    committedEvents.push(transitionEvent);

    // Spawn the next recurring instance in the SAME tx so the completion +
    // the spawn + both events commit/roll back atomically (SPEC §6.4-H: on
    // completion, materialize the next instance only). `after` carries the
    // freshly-stamped lastDoneAt; the spawned instance's streak = after.streak+1.
    if (shouldMaterialize) {
      const spawned = await recurringCompletionMaterializer(tx, after, occurredAt, { tenantId, actor });
      committedEvents.push(spawned.event);
    }

    await saveIdempotencyResult(tx, identity, {
      resultType: "commitment",
      resultId: after.id,
      resultStatus: after.status,
      resultRevision: after.revision,
      eventSequence: transitionEvent.sequence,
    });

    return { after, committedEvents };
  });

  for (const e of committedEvents) emitAfterCommit(e);
  return after;
}

function statusEventType(from: TaskStatusT, to: TaskStatusT): string {
  if (to === "in_progress") return "started";
  if (to === "done") return "completed";
  if (to === "blocked") return "blocked";
  if (to === "cancelled") return "cancelled";
  // At this point `to` is "open" (the only remaining status).
  if (from === "blocked") return "unblocked";
  if (from === "cancelled") return "uncancelled";
  return "status_changed";
}

export const startTask = (db: TasqDb, id: string, options?: StatusChangeOptions) =>
  transitionTaskStatus(db, id, "in_progress", options);
export const completeTask = (db: TasqDb, id: string, options?: StatusChangeOptions) =>
  transitionTaskStatus(db, id, "done", options);
export const blockTask = (db: TasqDb, id: string, options?: StatusChangeOptions) =>
  transitionTaskStatus(db, id, "blocked", options);
export const unblockTask = (db: TasqDb, id: string, options?: StatusChangeOptions) =>
  transitionTaskStatus(db, id, "open", options);
export const cancelTask = (db: TasqDb, id: string, options?: StatusChangeOptions) =>
  transitionTaskStatus(db, id, "cancelled", options);
export const reopenTask = (db: TasqDb, id: string, options?: StatusChangeOptions) =>
  transitionTaskStatus(db, id, "open", options);

// ──────────────────────────────────────────────────────────────────────
// Soft delete / restore
// ──────────────────────────────────────────────────────────────────────

/**
 * Soft-delete options. `cascade: false` (default) BLOCKS the delete when live
 * children (subtasks) still reference the row; `cascade: true` tombstones the
 * whole live subtree, each row through the service layer so each emits its own
 * `deleted` event (SPEC §8.2: cascade is reversible per-row, not a hard delete).
 */
export interface SoftDeleteOptions extends TaskServiceContext {
  cascade?: boolean;
}

/** Live (non-deleted) direct subtasks of a task. */
async function liveSubtaskIds(
  db: TasqDbOrTx,
  parentTaskId: string,
  tenantId: string,
): Promise<string[]> {
  const rows = await db
    .select({ id: task.id })
    .from(task)
    .where(
      and(
        eq(task.tenantId, tenantId),
        eq(task.parentTaskId, parentTaskId),
        isNull(task.deletedAt),
      ),
    );
  return rows.map((r) => r.id);
}

/** Atomically close every still-waiting condition when its task becomes terminal. */
async function cancelWaitingConditionsForTaskTx(
  tx: TasqDbOrTx,
  taskId: string,
  tenantId: string,
  actor: string,
  now: number,
): Promise<{ ids: string[]; events: EventT[] }> {
  const rows = await tx
    .select({ id: waitCondition.id })
    .from(waitCondition)
    .where(
      and(
        eq(waitCondition.tenantId, tenantId),
        eq(waitCondition.taskId, taskId),
        eq(waitCondition.status, "waiting"),
      ),
    );
  const events: EventT[] = [];
  for (const row of rows) {
    await tx
      .update(waitCondition)
      .set({
        status: "cancelled",
        cancelledAt: now,
        cancelReason: "task_terminal",
        updatedAt: now,
      })
      .where(and(eq(waitCondition.id, row.id), eq(waitCondition.status, "waiting")));
    events.push(
      await recordEvent(
        tx,
        {
          tenantId,
          actor,
          entityType: "task",
          entityId: taskId,
          eventType: "wait_cancelled",
          payload: {
            before: { waitConditionId: row.id, status: "waiting" },
            after: { waitConditionId: row.id, status: "cancelled" },
            reason: "task_terminal",
          },
        },
        { defer: true, now },
      ),
    );
  }
  return { ids: rows.map((row) => row.id), events };
}

/** Cancel transient execution state before hiding a commitment. */
async function closeAgentExecutionForDeletion(
  tx: TasqDbOrTx,
  taskId: string,
  tenantId: string,
  actor: string,
  now: number,
): Promise<EventT[]> {
  const events: EventT[] = [];
  const claims = await tx
    .select({ id: taskClaim.id, actor: taskClaim.actor })
    .from(taskClaim)
    .where(
      and(
        eq(taskClaim.tenantId, tenantId),
        eq(taskClaim.taskId, taskId),
        isNull(taskClaim.releasedAt),
      ),
    );
  for (const claim of claims) {
    await tx
      .update(taskClaim)
      .set({ releasedAt: now, releaseReason: "task_deleted", updatedAt: now, revision: sql`${taskClaim.revision} + 1` })
      .where(eq(taskClaim.id, claim.id));
    events.push(
      await recordEvent(
        tx,
        {
          tenantId,
          actor,
          entityType: "task",
          entityId: taskId,
          eventType: "claim_released",
          payload: {
            before: { claimId: claim.id, actor: claim.actor },
            reason: "task_deleted",
          },
        },
        { defer: true, now },
      ),
    );
  }

  const attempts = await tx
    .select({ id: taskAttempt.id, status: taskAttempt.status })
    .from(taskAttempt)
    .where(
      and(
        eq(taskAttempt.tenantId, tenantId),
        eq(taskAttempt.taskId, taskId),
        or(eq(taskAttempt.status, "running"), eq(taskAttempt.status, "input_required")),
      ),
    );
  for (const attempt of attempts) {
    await tx
      .update(taskAttempt)
      .set({
        status: "cancelled",
        statusMessage: "task deleted",
        endedAt: now,
        updatedAt: now,
        revision: sql`${taskAttempt.revision} + 1`,
      })
      .where(eq(taskAttempt.id, attempt.id));
    events.push(
      await recordEvent(
        tx,
        {
          tenantId,
          actor,
          entityType: "task",
          entityId: taskId,
          eventType: "attempt_cancelled",
          payload: {
            before: { attemptId: attempt.id, status: attempt.status },
            after: { attemptId: attempt.id, status: "cancelled" },
            reason: "task_deleted",
          },
        },
        { defer: true, now },
      ),
    );
  }
  const cancelledWaits = await cancelWaitingConditionsForTaskTx(
    tx,
    taskId,
    tenantId,
    actor,
    now,
  );
  events.push(...cancelledWaits.events);
  return events;
}

export async function softDeleteTask(
  db: TasqDb,
  id: string,
  ctx: SoftDeleteOptions = {},
): Promise<void> {
  const tenantId = ctx.tenantId ?? "gwendall";
  const actor = ctx.actor ?? "system";
  const now = serviceNow(ctx, ctx.now);

  const committedEvents = await runInTransaction(db, async (tx) => {
    const existing = await getTask(tx, id, tenantId);
    if (!existing) throw new Error(`Task not found: ${id}`);
    if (existing.deletedAt) return [] as EventT[];

    const childIds = await liveSubtaskIds(tx, id, tenantId);
    if (childIds.length > 0 && !ctx.cascade) {
      throw new Error(
        `Cannot delete task ${id}: ${childIds.length} live subtask(s) still reference it. Pass cascade to tombstone them too.`,
      );
    }

    const events: EventT[] = [];
    if (childIds.length > 0) {
      // Cascade: tombstone live subtasks first, each through the same tx so
      // the whole subtree commits/rolls back together and each emits a
      // `deleted` event. (Subtasks are depth ≤2 so this is at most one level.)
      for (const childId of childIds) {
        events.push(...(await softDeleteTaskTx(tx, childId, tenantId, actor, now)));
      }
    }
    events.push(...(await closeAgentExecutionForDeletion(tx, id, tenantId, actor, now)));
    await tx
      .update(task)
      .set({ deletedAt: now, updatedAt: now, revision: sql`${task.revision} + 1` })
      .where(and(eq(task.id, id), eq(task.tenantId, tenantId)));

    events.push(
      await recordEvent(
        tx,
        {
          tenantId,
          actor,
          entityType: "task",
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
 * Tombstone a task + its live subtree inside an existing transaction, returning
 * the events to emit after commit. Used by the cascade path of any ancestor
 * (area/goal/project) soft-delete so the whole cascade is one atomic tx.
 */
export async function softDeleteTaskTx(
  tx: TasqDbOrTx,
  id: string,
  tenantId: string,
  actor: string,
  now: number,
): Promise<EventT[]> {
  const events: EventT[] = [];
  // Idempotency: if this row was already tombstoned earlier in the same cascade
  // (overlapping ancestry paths) or a prior run, leave its original deletedAt
  // and emit nothing — no double-tombstone, no duplicate `deleted` event.
  const existing = await tx
    .select({ deletedAt: task.deletedAt })
    .from(task)
    .where(and(eq(task.id, id), eq(task.tenantId, tenantId)))
    .limit(1);
  if (existing.length === 0 || existing[0]!.deletedAt != null) return events;

  const childIds = await liveSubtaskIds(tx, id, tenantId);
  for (const childId of childIds) {
    events.push(...(await softDeleteTaskTx(tx, childId, tenantId, actor, now)));
  }
  events.push(...(await closeAgentExecutionForDeletion(tx, id, tenantId, actor, now)));
  await tx
    .update(task)
    .set({ deletedAt: now, updatedAt: now, revision: sql`${task.revision} + 1` })
    .where(and(eq(task.id, id), eq(task.tenantId, tenantId)));
  events.push(
    await recordEvent(
      tx,
      {
        tenantId,
        actor,
        entityType: "task",
        entityId: id,
        eventType: "deleted",
        payload: {},
      },
      { defer: true, now },
    ),
  );
  return events;
}

export interface RestoreTaskInTransactionOptions {
  tenantId: string;
  actor: string;
  principalId?: string;
  now: number;
  hierarchyPolicy?: TaskHierarchyPolicy;
}

/** Canonical restore primitive for replication and other transaction owners. */
export async function restoreTaskInTransaction(
  tx: TasqDbOrTx,
  id: string,
  options: RestoreTaskInTransactionOptions,
): Promise<{ result: TaskT; event: EventT | null }> {
  const { tenantId, actor, now } = options;
  const existing = await getTask(tx, id, tenantId);
  if (!existing) throw new Error(`Task not found: ${id}`);
  if (!existing.deletedAt) return { result: existing, event: null };

  if (existing.parentTaskId) {
    const parent = await getTask(tx, existing.parentTaskId, tenantId);
    if (!parent) throw new Error(`Parent task not found: ${existing.parentTaskId}`);
    if (parent.deletedAt) {
      throw new Error(`Cannot restore task ${id}: parent task is deleted: ${existing.parentTaskId}`);
    }
  }
  await (options.hierarchyPolicy ?? flatHierarchyPolicy).assertLiveAncestors(tx, tenantId, existing);

  await tx
    .update(task)
    .set({ deletedAt: null, updatedAt: now, revision: sql`${task.revision} + 1` })
    .where(and(eq(task.id, id), eq(task.tenantId, tenantId)));

  const event = await recordEvent(
    tx,
    {
      tenantId,
      actor,
      principalId: options.principalId,
      entityType: "task",
      entityId: id,
      eventType: "restored",
      payload: {},
    },
    { defer: true, now },
  );
  return { result: (await getTask(tx, id, tenantId)) as TaskT, event };
}

export async function restoreTask(
  db: TasqDb,
  id: string,
  ctx: TaskServiceContext = {},
): Promise<TaskT> {
  const tenantId = ctx.tenantId ?? "gwendall";
  const actor = ctx.actor ?? "system";
  const now = serviceNow(ctx, ctx.now);

  const { result, committedEvent } = await runInTransaction(db, async (tx) => {
    const restored = await restoreTaskInTransaction(tx, id, {
      tenantId,
      actor,
      principalId: ctx.principalId,
      now,
      hierarchyPolicy: ctx.hierarchyPolicy,
    });
    return { result: restored.result, committedEvent: restored.event };
  });

  if (committedEvent) emitAfterCommit(committedEvent);
  return result;
}

// ──────────────────────────────────────────────────────────────────────
// Listing
// ──────────────────────────────────────────────────────────────────────

export interface ListTasksOptions extends TaskServiceContext {
  status?: TaskStatusT | TaskStatusT[];
  areaId?: string;
  goalId?: string;
  projectId?: string;
  /** Filter by parent task. Pass `null` for "top-level only" (no parent). */
  parentTaskId?: string | null;
  /** Tasks with no project (inbox). */
  orphanOnly?: boolean;
  includeDeleted?: boolean;
  /**
   * Override the default defer filter. By default tasks with
   * `scheduledAt != null && scheduledAt > now` are EXCLUDED so deferred work
   * does not pollute the list / inbox / search (SPEC §5.2). Pass `true` to
   * include deferred tasks.
   */
  includeScheduled?: boolean;
  /** Override now() — useful for tests. */
  now?: number;
  limit?: number;
}

export async function listTasks(
  db: TasqDb,
  options: ListTasksOptions = {},
): Promise<TaskT[]> {
  const tenantId = options.tenantId ?? "gwendall";
  const filters = [eq(task.tenantId, tenantId)];

  if (!options.includeDeleted) filters.push(isNull(task.deletedAt));
  if (options.areaId) filters.push(eq(task.areaId, options.areaId));
  if (options.goalId) filters.push(eq(task.goalId, options.goalId));
  if (options.projectId) filters.push(eq(task.projectId, options.projectId));
  if (options.orphanOnly) filters.push(isNull(task.projectId));
  if (options.parentTaskId === null) {
    filters.push(isNull(task.parentTaskId));
  } else if (typeof options.parentTaskId === "string") {
    filters.push(eq(task.parentTaskId, options.parentTaskId));
  }

  if (options.status) {
    const statuses = Array.isArray(options.status) ? options.status : [options.status];
    if (statuses.length === 1) {
      filters.push(eq(task.status, statuses[0] as string));
    } else {
      const orExpr = or(...statuses.map((s) => eq(task.status, s as string)));
      if (orExpr) filters.push(orExpr);
    }
  }

  // Apply defer visibility before LIMIT. Filtering after limiting could return
  // an empty/short page even when older visible tasks existed.
  if (!options.includeScheduled) {
    const now = serviceNow(options, options.now);
    const visibleBySchedule = or(isNull(task.scheduledAt), lte(task.scheduledAt, now));
    if (visibleBySchedule) filters.push(visibleBySchedule);
  }

  const rows = await db
    .select()
    .from(task)
    .where(and(...filters))
    .orderBy(desc(task.updatedAt))
    .limit(options.limit ?? 100);

  return rows.map(parseTask);
}

// Re-export the enum for callers that want to match against allowed statuses
export { TaskStatus };

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableSerialize(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** Durable deadline evaluation and ledger-only wait fallbacks. */

import { and, asc, eq, isNotNull, lte } from "drizzle-orm";
import {
  TaskInsert,
  waitCondition,
  type Event,
  type Reconciliation,
  type WaitCondition,
  type Clock,
} from "@tasq/schema";
import type { TasqDb, TasqDbOrTx } from "../db.js";
import { runInTransaction } from "../db.js";
import { emitAfterCommit, recordEvent } from "./events.js";
import {
  listCandidateObservations,
  reconcileWaitObservationInTransaction,
} from "./reconciliation.js";
import {
  activateTaskInTransaction,
  createTaskInTransaction,
  getTask,
  type TaskHierarchyPolicy,
} from "./tasks.js";
import { getWaitCondition } from "./waits.js";
import { serviceNow } from "../util/clock.js";
import {
  findIdempotencyResult,
  prepareIdempotency,
  saveIdempotencyResult,
} from "./idempotency.js";

function unixMs(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative unix-ms integer`);
  }
  return value;
}

export type DeadlineEvaluationOutcome =
  | "satisfied"
  | "expired"
  | "already_terminal"
  | "not_due";

export interface DeadlineEvaluationResult {
  condition: WaitCondition;
  outcome: DeadlineEvaluationOutcome;
  sweepNow: number;
  reconciliations: Reconciliation[];
  fallbackResultTaskId: string | null;
}

export interface EvaluateDeadlineOptions {
  tenantId?: string;
  actor?: string;
  matcherVersion?: number;
  /** One wall-clock snapshot, shared by the whole sweep. */
  sweepNow?: number;
  clock?: Clock;
  /** Internal compatibility seam; strict kernel fallbacks are flat. */
  hierarchyPolicy?: TaskHierarchyPolicy;
}

/** Evaluate one condition atomically against every eligible queued fact. */
export async function evaluateWaitConditionDeadline(
  db: TasqDb,
  conditionId: string,
  options: EvaluateDeadlineOptions = {},
): Promise<DeadlineEvaluationResult> {
  const tenantId = options.tenantId ?? "gwendall";
  const actor = options.actor ?? "deadline-sweeper";
  if (!actor.trim()) throw new Error("Deadline actor must not be blank");
  const matcherVersion = options.matcherVersion ?? 1;
  if (!Number.isSafeInteger(matcherVersion) || matcherVersion <= 0) {
    throw new Error("matcherVersion must be a positive integer");
  }
  const sweepNow = unixMs(serviceNow(options, options.sweepNow), "sweepNow");

  const { result, events } = await runInTransaction(db, async (tx) => {
    const initial = await getWaitCondition(tx, conditionId, tenantId);
    if (!initial) throw new Error(`Wait condition not found: ${conditionId}`);
    if (initial.status !== "waiting") {
      return {
        result: outcome(initial, "already_terminal", sweepNow, []),
        events: [] as Event[],
      };
    }
    if (initial.deadlineAt == null || initial.deadlineAt > sweepNow) {
      return { result: outcome(initial, "not_due", sweepNow, []), events: [] as Event[] };
    }

    // Both clocks are strict: a fact at the deadline is late. Reading and
    // reconciling under the same writer transaction closes the ingest/reconcile
    // lag window before expiry wins.
    const candidates = await listCandidateObservations(tx, conditionId, {
      tenantId,
      matcherVersion,
      occurredBefore: initial.deadlineAt,
      recordedBefore: initial.deadlineAt,
      limit: 2_147_483_647,
    });
    const reconciliations: Reconciliation[] = [];
    const events: Event[] = [];
    for (const candidate of candidates) {
      const evaluation = await reconcileWaitObservationInTransaction(
        tx,
        conditionId,
        candidate.id,
        { tenantId, actor, matcherVersion, now: sweepNow },
      );
      reconciliations.push(evaluation.result);
      events.push(...evaluation.events);
      if (evaluation.result.effect === "satisfied") {
        const satisfied = await getWaitCondition(tx, conditionId, tenantId);
        if (!satisfied) throw new Error(`Wait condition disappeared: ${conditionId}`);
        return { result: outcome(satisfied, "satisfied", sweepNow, reconciliations), events };
      }
    }

    const fallbackResultTaskId = await materializeFallback(
      tx,
      initial,
      { tenantId, actor, sweepNow, hierarchyPolicy: options.hierarchyPolicy },
      events,
    );
    await tx.update(waitCondition).set({
      status: "expired",
      expiredAt: sweepNow,
      fallbackResultTaskId,
      updatedAt: sweepNow,
    }).where(and(
      eq(waitCondition.id, conditionId),
      eq(waitCondition.tenantId, tenantId),
      eq(waitCondition.status, "waiting"),
    ));

    events.push(await recordEvent(tx, {
      tenantId,
      actor,
      entityType: "task",
      entityId: initial.taskId,
      eventType: "wait_expired",
      payload: {
        before: { waitConditionId: initial.id, status: "waiting" },
        after: {
          waitConditionId: initial.id,
          status: "expired",
          deadlineAt: initial.deadlineAt,
          sweepNow,
          fallbackKind: initial.fallbackKind,
          fallbackResultTaskId,
        },
      },
    }, { defer: true, now: sweepNow }));
    const expired = await getWaitCondition(tx, conditionId, tenantId);
    if (!expired) throw new Error(`Failed to read back expired wait condition ${conditionId}`);
    return { result: outcome(expired, "expired", sweepNow, reconciliations), events };
  });

  for (const event of events) emitAfterCommit(event);
  return result;
}

export interface SweepDeadlineOptions extends EvaluateDeadlineOptions {
  limit?: number;
}

export interface DeadlineSweepResult {
  sweepNow: number;
  evaluated: number;
  satisfied: number;
  expired: number;
  alreadyTerminal: number;
  results: DeadlineEvaluationResult[];
  errors: Array<{ conditionId: string; message: string }>;
}

/** Process due waits independently so one invalid fallback cannot starve peers. */
export async function sweepWaitConditionDeadlines(
  db: TasqDb,
  options: SweepDeadlineOptions = {},
): Promise<DeadlineSweepResult> {
  const tenantId = options.tenantId ?? "gwendall";
  const sweepNow = unixMs(serviceNow(options, options.sweepNow), "sweepNow");
  const limit = options.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 10_000) {
    throw new Error("limit must be an integer between 1 and 10000");
  }
  const due = await db.select({ id: waitCondition.id }).from(waitCondition).where(and(
    eq(waitCondition.tenantId, tenantId),
    eq(waitCondition.status, "waiting"),
    isNotNull(waitCondition.deadlineAt),
    lte(waitCondition.deadlineAt, sweepNow),
  )).orderBy(asc(waitCondition.deadlineAt), asc(waitCondition.id)).limit(limit);

  const results: DeadlineEvaluationResult[] = [];
  const errors: DeadlineSweepResult["errors"] = [];
  for (const row of due) {
    try {
      results.push(await evaluateWaitConditionDeadline(db, row.id, { ...options, tenantId, sweepNow }));
    } catch (error) {
      errors.push({
        conditionId: row.id,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return {
    sweepNow,
    evaluated: results.length,
    satisfied: results.filter((item) => item.outcome === "satisfied").length,
    expired: results.filter((item) => item.outcome === "expired").length,
    alreadyTerminal: results.filter((item) => item.outcome === "already_terminal").length,
    results,
    errors,
  };
}

function outcome(
  condition: WaitCondition,
  result: DeadlineEvaluationOutcome,
  sweepNow: number,
  reconciliations: Reconciliation[],
): DeadlineEvaluationResult {
  return {
    condition,
    outcome: result,
    sweepNow,
    reconciliations,
    fallbackResultTaskId: condition.fallbackResultTaskId,
  };
}

async function materializeFallback(
  tx: TasqDbOrTx,
  condition: WaitCondition,
  context: {
    tenantId: string;
    actor: string;
    sweepNow: number;
    hierarchyPolicy?: TaskHierarchyPolicy;
  },
  events: Event[],
): Promise<string | null> {
  if (condition.fallbackKind === "none") return null;
  const key = `wait:${condition.id}:deadline-fallback:v1`;
  const operation = "wait.deadline-fallback";
  const request = {
    conditionId: condition.id,
    fallbackKind: condition.fallbackKind,
    fallbackSpec: condition.fallbackSpec,
    fallbackTargetTaskId: condition.fallbackTargetTaskId,
  };
  const identity = prepareIdempotency({
    tenantId: context.tenantId,
    actor: context.actor,
    idempotencyKey: key,
  }, operation, request, {
    now: context.sweepNow,
    retentionClass: "durable",
    legacyRequest: { operation, ...request },
  });
  const prior = await findIdempotencyResult(tx, identity);
  if (prior) {
    const existing = await getTask(tx, prior.resultId, context.tenantId);
    if (!existing) throw new Error(`Deadline fallback points at missing task ${prior.resultId}`);
    return existing.id;
  }

  let resultId: string;
  if (condition.fallbackKind === "activate_task") {
    if (!condition.fallbackTargetTaskId) throw new Error("activate_task fallback has no target");
    const activated = await activateTaskInTransaction(tx, condition.fallbackTargetTaskId, {
      tenantId: context.tenantId,
      actor: context.actor,
      now: context.sweepNow,
      waitConditionId: condition.id,
      sourceTaskId: condition.taskId,
      hierarchyPolicy: context.hierarchyPolicy,
    });
    resultId = activated.result.id;
    events.push(activated.event);
  } else {
    if (!condition.fallbackSpec) throw new Error("create_task fallback has no spec");
    const sourceTask = await getTask(tx, condition.taskId, context.tenantId);
    if (!sourceTask || sourceTask.deletedAt != null) {
      throw new Error(`Wait source task is missing or deleted: ${condition.taskId}`);
    }
    const spec = condition.fallbackSpec;
    const parsed = TaskInsert.parse({
      tenantId: context.tenantId,
      title: spec.title,
      nextAction: spec.nextAction,
      priority: spec.priority,
      scheduledAt: spec.scheduledAt,
      dueAt: spec.dueAt,
      projectId: spec.projectId === undefined ? sourceTask.projectId : spec.projectId,
      goalId: spec.goalId === undefined ? sourceTask.goalId : spec.goalId,
      areaId: spec.areaId === undefined ? sourceTask.areaId : spec.areaId,
      parentTaskId: spec.parentTaskId === undefined ? sourceTask.parentTaskId : spec.parentTaskId,
      metadata: {
        ...spec.metadata,
        waitFallback: {
          conditionId: condition.id,
          sourceTaskId: condition.taskId,
          deadlineAt: condition.deadlineAt,
        },
      },
    });
    const created = await createTaskInTransaction(tx, parsed, {
      tenantId: context.tenantId,
      actor: context.actor,
      now: context.sweepNow,
      eventContext: { source: `wait:${condition.id}` },
      hierarchyPolicy: context.hierarchyPolicy,
    });
    resultId = created.result.id;
    events.push(created.event);
  }

  await saveIdempotencyResult(tx, identity, {
    resultType: "commitment",
    resultId,
    resultStatus: "active",
    eventSequence: events[events.length - 1]?.sequence ?? null,
  });
  return resultId;
}

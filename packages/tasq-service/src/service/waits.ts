/**
 * Durable typed wait conditions.
 *
 * Conditions describe an external fact a task is waiting for. They are not
 * timers or workflows: runtimes call this service, and later observations plus
 * deterministic reconciliation advance the monotone lifecycle.
 */

import { and, asc, desc, eq, inArray } from "drizzle-orm";
import {
  uuidv7,
  waitCondition,
  WaitCondition as WaitConditionZ,
  WaitConditionInsert,
  type Event as EventT,
  type WaitCondition,
  type WaitConditionKind,
  type WaitConditionStatus,
} from "@tasq-run/schema";
import {
  REFERENCE_EVALUATOR_IMPLEMENTATION_DIGEST,
  REFERENCE_EVALUATOR_VERSION,
  WAIT_KIND_EXTENSION_IDENTITIES,
} from "@tasq-internal/reference-extension";
import type { TasqDb, TasqDbOrTx } from "../db.js";
import { runInTransaction } from "../db.js";
import type { ServiceContext } from "./context.js";
import { emitAfterCommit, recordEvent } from "./events.js";
import { getTask } from "./tasks.js";
import { ensureBundledReferenceExtensionAvailable } from "./reference-extensions.js";
import { parseReferenceCondition } from "./reference-runtime.js";
import { serviceNow } from "../util/clock.js";
import {
  findIdempotencyResult,
  prepareIdempotency,
  saveIdempotencyResult,
  type PreparedIdempotency,
} from "./idempotency.js";

function validateUnixMs(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative unix-ms integer`);
  }
  return value;
}

function parseCondition(row: typeof waitCondition.$inferSelect): WaitCondition {
  return WaitConditionZ.parse({
    ...row,
    parameters: JSON.parse(row.parameters) as unknown,
    fallbackSpec: row.fallbackSpec == null ? null : JSON.parse(row.fallbackSpec) as unknown,
  });
}

async function requireLiveNonterminalTask(
  db: TasqDbOrTx,
  taskId: string,
  tenantId: string,
  label = "Task",
) {
  const linkedTask = await getTask(db, taskId, tenantId);
  if (!linkedTask) throw new Error(`${label} not found: ${taskId}`);
  if (linkedTask.deletedAt != null) throw new Error(`${label} is deleted: ${taskId}`);
  if (linkedTask.status === "done" || linkedTask.status === "cancelled") {
    throw new Error(`${label} is terminal: ${taskId} (${linkedTask.status})`);
  }
  return linkedTask;
}

function retryIdentity(
  ctx: ServiceContext,
  operation: string,
  request: unknown,
  now: number,
): PreparedIdempotency | null {
  return prepareIdempotency(ctx, operation, request, {
    now,
    legacyRequest: { operation, request },
  });
}

async function priorResultId(
  tx: TasqDbOrTx,
  tenantId: string,
  identity: PreparedIdempotency | null,
): Promise<string | null> {
  const prior = await findIdempotencyResult(tx, identity);
  if (!prior) return null;
  return prior.resultId;
}

async function storeRetryIdentity(
  tx: TasqDbOrTx,
  tenantId: string,
  identity: PreparedIdempotency | null,
  resultId: string,
  resultStatus: string,
  eventSequence: number,
): Promise<void> {
  await saveIdempotencyResult(tx, identity, {
    resultType: "wait_condition",
    resultId,
    resultStatus,
    eventSequence,
  });
}

export interface CreateWaitConditionOptions extends ServiceContext {
  /** Deterministic recording clock for tests and runtime reconciliation. */
  now?: number;
}

/** Create a waiting condition; optional correction supersession is atomic. */
export async function createWaitCondition(
  db: TasqDb,
  input: unknown,
  options: CreateWaitConditionOptions = {},
): Promise<WaitCondition> {
  const parsed = WaitConditionInsert.parse(input);
  const tenantId = options.tenantId ?? parsed.tenantId;
  const actor = options.actor ?? "system";
  const now = validateUnixMs(serviceNow(options, options.now), "now");
  const notBefore = validateUnixMs(parsed.notBefore ?? now, "notBefore");
  const deadlineAt = parsed.deadlineAt == null
    ? null
    : validateUnixMs(parsed.deadlineAt, "deadlineAt");
  if (deadlineAt != null && deadlineAt <= notBefore) {
    throw new Error("deadlineAt must be strictly after notBefore");
  }
  const parameters = parseReferenceCondition(
    parsed.kind,
    parsed.schemaVersion,
    parsed.parameters,
  );
  await ensureBundledReferenceExtensionAvailable(db, { tenantId, actor, now });
  const extensionIdentity = WAIT_KIND_EXTENSION_IDENTITIES[parsed.kind];
  const identity = retryIdentity({ ...options, tenantId }, "wait.create", {
    ...parsed,
    parameters,
    tenantId,
    requestedNotBefore: parsed.notBefore ?? null,
  }, now);

  const { result, events } = await runInTransaction(db, async (tx) => {
    const priorId = await priorResultId(tx, tenantId, identity);
    if (priorId) {
      const prior = await getWaitCondition(tx, priorId, tenantId);
      if (!prior) throw new Error(`Idempotency record points at missing wait condition ${priorId}`);
      return { result: prior, events: [] as EventT[] };
    }

    await requireLiveNonterminalTask(tx, parsed.taskId, tenantId);
    if (parsed.fallbackTargetTaskId) {
      await requireLiveNonterminalTask(
        tx,
        parsed.fallbackTargetTaskId,
        tenantId,
        "Fallback task",
      );
    }

    let superseded: WaitCondition | null = null;
    if (parsed.supersedesConditionId) {
      superseded = await getWaitCondition(tx, parsed.supersedesConditionId, tenantId);
      if (!superseded) {
        throw new Error(`Superseded wait condition not found: ${parsed.supersedesConditionId}`);
      }
      if (superseded.taskId !== parsed.taskId) {
        throw new Error("A wait condition may only supersede a condition on the same task");
      }
      if (superseded.status !== "waiting") {
        throw new Error(`Wait condition ${superseded.id} is already terminal (${superseded.status})`);
      }
    }

    const id = parsed.id ?? uuidv7(now);
    await tx.insert(waitCondition).values({
      id,
      tenantId,
      taskId: parsed.taskId,
      kind: parsed.kind,
      typeUri: extensionIdentity.typeUri,
      schemaVersion: parsed.schemaVersion,
      evaluatorUri: extensionIdentity.evaluatorUri,
      evaluatorVersion: REFERENCE_EVALUATOR_VERSION,
      evaluatorImplementationDigest: REFERENCE_EVALUATOR_IMPLEMENTATION_DIGEST,
      parameters: JSON.stringify(parameters),
      status: "waiting",
      notBefore,
      deadlineAt,
      fallbackKind: parsed.fallbackKind,
      fallbackSpec: parsed.fallbackSpec == null ? null : JSON.stringify(parsed.fallbackSpec),
      fallbackTargetTaskId: parsed.fallbackTargetTaskId,
      fallbackResultTaskId: null,
      supersedesConditionId: parsed.supersedesConditionId,
      satisfiedByObservationId: null,
      satisfiedAt: null,
      expiredAt: null,
      cancelledAt: null,
      cancelReason: null,
      createdAt: now,
      updatedAt: now,
    });

    const events: EventT[] = [];
    if (superseded) {
      await tx
        .update(waitCondition)
        .set({
          status: "cancelled",
          cancelledAt: now,
          cancelReason: "superseded",
          updatedAt: now,
        })
        .where(and(eq(waitCondition.id, superseded.id), eq(waitCondition.tenantId, tenantId)));
      events.push(
        await recordEvent(
          tx,
          {
            tenantId,
            actor,
            entityType: "task",
            entityId: parsed.taskId,
            eventType: "wait_cancelled",
            payload: {
              before: { waitConditionId: superseded.id, status: "waiting" },
              after: { waitConditionId: superseded.id, status: "cancelled", supersededBy: id },
              reason: "superseded",
            },
          },
          { defer: true, now },
        ),
      );
    }

    events.push(
      await recordEvent(
        tx,
        {
          tenantId,
          actor,
          entityType: "task",
          entityId: parsed.taskId,
          eventType: "wait_created",
          payload: {
            after: {
              waitConditionId: id,
              kind: parsed.kind,
              schemaVersion: parsed.schemaVersion,
              status: "waiting",
              notBefore,
              deadlineAt,
              fallbackKind: parsed.fallbackKind,
              supersedesConditionId: parsed.supersedesConditionId,
            },
          },
        },
        { defer: true, now },
      ),
    );

    const inserted = await getWaitCondition(tx, id, tenantId);
    if (!inserted) throw new Error(`Failed to read back wait condition ${id}`);
    const createdEvent = events[events.length - 1];
    if (!createdEvent) throw new Error("wait_created event was not recorded");
    await storeRetryIdentity(
      tx,
      tenantId,
      identity,
      id,
      inserted.status,
      createdEvent.sequence,
    );
    return { result: inserted, events };
  });

  for (const event of events) emitAfterCommit(event);
  return result;
}

export async function getWaitCondition(
  db: TasqDbOrTx,
  id: string,
  tenantId = "gwendall",
): Promise<WaitCondition | null> {
  const rows = await db
    .select()
    .from(waitCondition)
    .where(and(eq(waitCondition.id, id), eq(waitCondition.tenantId, tenantId)))
    .limit(1);
  return rows[0] ? parseCondition(rows[0]) : null;
}

export interface ListWaitConditionsOptions extends ServiceContext {
  statuses?: WaitConditionStatus[];
  kinds?: WaitConditionKind[];
  ascending?: boolean;
  limit?: number;
}

export async function listWaitConditions(
  db: TasqDb,
  taskId: string | null,
  options: ListWaitConditionsOptions = {},
): Promise<WaitCondition[]> {
  const filters = [eq(waitCondition.tenantId, options.tenantId ?? "gwendall")];
  if (taskId) filters.push(eq(waitCondition.taskId, taskId));
  if (options.statuses?.length) filters.push(inArray(waitCondition.status, options.statuses));
  if (options.kinds?.length) filters.push(inArray(waitCondition.kind, options.kinds));
  const rows = await db
    .select()
    .from(waitCondition)
    .where(and(...filters))
    .orderBy((options.ascending ? asc : desc)(waitCondition.createdAt))
    .limit(options.limit ?? 100);
  return rows.map(parseCondition);
}

export interface CancelWaitConditionOptions extends ServiceContext {
  reason: string;
  now?: number;
}

/** The only public TQ-102 terminal transition; match/expiry are added later. */
export async function cancelWaitCondition(
  db: TasqDb,
  id: string,
  options: CancelWaitConditionOptions,
): Promise<WaitCondition> {
  const tenantId = options.tenantId ?? "gwendall";
  const actor = options.actor ?? "system";
  const now = validateUnixMs(serviceNow(options, options.now), "now");
  const reason = options.reason.trim();
  if (!reason) throw new Error("Cancellation reason must not be empty");

  const { result, event } = await runInTransaction(db, async (tx) => {
    const before = await getWaitCondition(tx, id, tenantId);
    if (!before) throw new Error(`Wait condition not found: ${id}`);
    if (before.status === "cancelled") {
      if (before.cancelReason !== reason) {
        throw new Error(
          `Wait condition ${id} is already cancelled with reason: ${before.cancelReason}`,
        );
      }
      return { result: before, event: null as EventT | null };
    }
    if (before.status !== "waiting") {
      throw new Error(`Wait condition ${id} is terminal (${before.status}) and immutable`);
    }
    if (now < before.createdAt) {
      throw new Error(`Cancellation time ${now} precedes condition creation ${before.createdAt}`);
    }

    await tx
      .update(waitCondition)
      .set({ status: "cancelled", cancelledAt: now, cancelReason: reason, updatedAt: now })
      .where(and(eq(waitCondition.id, id), eq(waitCondition.tenantId, tenantId)));
    const after = await getWaitCondition(tx, id, tenantId);
    if (!after) throw new Error(`Failed to read back wait condition ${id}`);
    const event = await recordEvent(
      tx,
      {
        tenantId,
        actor,
        entityType: "task",
        entityId: before.taskId,
        eventType: "wait_cancelled",
        payload: {
          before: { waitConditionId: id, status: "waiting" },
          after: { waitConditionId: id, status: "cancelled" },
          reason,
        },
      },
      { defer: true, now },
    );
    return { result: after, event };
  });

  if (event) emitAfterCommit(event);
  return result;
}

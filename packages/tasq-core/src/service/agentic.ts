/**
 * Agentic execution primitives.
 *
 * A task is a durable commitment. Claims coordinate ownership, attempts record
 * concrete executions, and evidence records observable results. An attempt
 * succeeding never completes its task implicitly: execution and outcome are
 * intentionally separate state machines.
 */

import { and, asc, desc, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import {
  ATTEMPT_STATUSES,
  AttemptStatus,
  TaskAttempt as TaskAttemptZ,
  TaskAttemptInsert,
  TaskClaim as TaskClaimZ,
  TaskEvidence as TaskEvidenceZ,
  TaskEvidenceInsert,
  taskAttempt,
  taskClaim,
  taskEvidence,
  uuidv7,
  type AttemptStatus as AttemptStatusT,
  type Event as EventT,
  type Metadata,
  type TaskAttempt,
  type TaskClaim,
  type TaskEvidence,
  type Clock,
} from "@tasq/schema";
import type { TasqDb, TasqDbOrTx } from "../db.js";
import { runInTransaction } from "../db.js";
import { parseRow } from "../util/row.js";
import type { ServiceContext } from "./context.js";
import { emitAfterCommit, recordEvent } from "./events.js";
import { getTask } from "./tasks.js";
import { serviceNow } from "../util/clock.js";
import { ensureLocalPrincipal, getPrincipal } from "./principals.js";
import {
  findIdempotencyResult,
  prepareIdempotency,
  saveIdempotencyResult,
  type PreparedIdempotency,
} from "./idempotency.js";

const MIN_LEASE_MS = 1_000;
const MAX_LEASE_MS = 7 * 24 * 60 * 60 * 1_000;
const DEFAULT_LEASE_MS = 30 * 60 * 1_000;
const TERMINAL_ATTEMPT_STATUSES = new Set<AttemptStatusT>([
  "succeeded",
  "failed",
  "cancelled",
]);

function validateUnixMs(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative unix-ms integer`);
  }
  return value;
}

function parseClaim(row: typeof taskClaim.$inferSelect): TaskClaim {
  return TaskClaimZ.parse(parseRow(row));
}

function parseAttempt(row: typeof taskAttempt.$inferSelect): TaskAttempt {
  return TaskAttemptZ.parse(parseRow(row));
}

function parseEvidence(row: typeof taskEvidence.$inferSelect): TaskEvidence {
  return TaskEvidenceZ.parse(parseRow(row));
}

function validateLeaseMs(value: number | undefined): number {
  const leaseMs = value ?? DEFAULT_LEASE_MS;
  if (!Number.isSafeInteger(leaseMs) || leaseMs < MIN_LEASE_MS || leaseMs > MAX_LEASE_MS) {
    throw new Error(`leaseMs must be an integer between ${MIN_LEASE_MS} and ${MAX_LEASE_MS}`);
  }
  return leaseMs;
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
  resultType: string,
  resultId: string,
  resultStatus: string | null,
  resultRevision: number | null,
  eventSequence: number | null,
): Promise<void> {
  await saveIdempotencyResult(tx, identity, {
    resultType,
    resultId,
    resultStatus,
    resultRevision,
    eventSequence,
  });
}

async function requireLiveTask(db: TasqDbOrTx, taskId: string, tenantId: string) {
  const linkedTask = await getTask(db, taskId, tenantId);
  if (!linkedTask) throw new Error(`Task not found: ${taskId}`);
  if (linkedTask.deletedAt) throw new Error(`Task is deleted: ${taskId}`);
  return linkedTask;
}

async function resolveCallerPrincipal(
  db: TasqDbOrTx,
  tenantId: string,
  options: ServiceContext,
  actor: string,
  now: number,
) {
  if (!options.principalId) return ensureLocalPrincipal(db, tenantId, actor, now);
  const result = await getPrincipal(db, options.principalId, tenantId);
  if (!result) throw new Error(`Principal not found in workspace: ${options.principalId}`);
  if (result.status !== "enabled") throw new Error(`Principal is disabled: ${result.id}`);
  return result;
}

export interface AcquireClaimOptions extends ServiceContext {
  leaseMs?: number;
  metadata?: Metadata;
  /** Deterministic clock for tests and reconciliation. */
  now?: number;
}

/** Atomically acquire or renew the exclusive live claim for a task. */
export async function acquireTaskClaim(
  db: TasqDb,
  taskId: string,
  options: AcquireClaimOptions = {},
): Promise<TaskClaim> {
  const tenantId = options.tenantId ?? "gwendall";
  const actor = options.actor ?? "system";
  const now = validateUnixMs(serviceNow(options, options.now), "now");
  const leaseMs = validateLeaseMs(options.leaseMs);
  const expiresAt = now + leaseMs;
  if (!Number.isSafeInteger(expiresAt)) throw new Error("Lease expiry exceeds unix-ms range");
  const identity = retryIdentity({ ...options, tenantId }, "claim.acquire", {
    taskId,
    actor,
    principalId: options.principalId ?? null,
    leaseMs,
    metadata: options.metadata ?? {},
  }, now);

  const { result, event } = await runInTransaction(db, async (tx) => {
    const priorId = await priorResultId(tx, tenantId, identity);
    if (priorId) {
      const prior = await getTaskClaim(tx, priorId, tenantId);
      if (!prior) throw new Error(`Idempotency record points at missing claim ${priorId}`);
      return { result: prior, event: null as EventT | null };
    }
    const linkedTask = await requireLiveTask(tx, taskId, tenantId);
    const attribution = await resolveCallerPrincipal(tx, tenantId, options, actor, now);
    if (linkedTask.status === "done" || linkedTask.status === "cancelled") {
      throw new Error(`Cannot claim terminal task ${taskId} (${linkedTask.status})`);
    }

    const rows = await tx
      .select()
      .from(taskClaim)
      .where(
        and(
          eq(taskClaim.tenantId, tenantId),
          eq(taskClaim.taskId, taskId),
          isNull(taskClaim.releasedAt),
        ),
      )
      .limit(1);
    const current = rows[0] ? parseClaim(rows[0]) : null;

    if (current && now < current.heartbeatAt) {
      throw new Error(`Claim clock moved backwards: ${now} < heartbeat ${current.heartbeatAt}`);
    }

    if (current && current.expiresAt > now && (
      current.principalId ? current.principalId !== attribution.id : current.actor !== actor
    )) {
      throw new Error(
        `Task ${taskId} is claimed by ${current.actor} until ${new Date(current.expiresAt).toISOString()}`,
      );
    }

    if (current && current.expiresAt > now) {
      const renewedMutation = await tx
        .update(taskClaim)
        .set({ heartbeatAt: now, expiresAt, updatedAt: now, revision: sql`${taskClaim.revision} + 1` })
        .where(and(
          eq(taskClaim.id, current.id),
          ...(options.expectedRevision === undefined ? [] : [eq(taskClaim.revision, options.expectedRevision)]),
        )).returning({ revision: taskClaim.revision });
      if (options.expectedRevision !== undefined && renewedMutation.length === 0) {
        throw new Error(`Stale claim revision: expected ${options.expectedRevision}`);
      }
      const renewedRows = await tx.select().from(taskClaim).where(eq(taskClaim.id, current.id)).limit(1);
      const renewed = parseClaim(renewedRows[0]!);
      const event = await recordEvent(
        tx,
        {
          tenantId,
          actor,
          principalId: attribution.id,
          entityType: "task",
          entityId: taskId,
          eventType: "claim_renewed",
          payload: { after: { claimId: renewed.id, expiresAt: renewed.expiresAt } },
        },
        { defer: true, now },
      );
      await storeRetryIdentity(
        tx, tenantId, identity, "task_claim", renewed.id,
        renewed.releaseReason ? "released" : "active", renewed.revision, event.sequence,
      );
      return { result: renewed, event };
    }

    // Expiry is reconciled inside the same writer transaction so two agents
    // racing to replace a stale claim cannot both win the partial UNIQUE key.
    if (current) {
      await tx
        .update(taskClaim)
        .set({ releasedAt: now, releaseReason: "expired", updatedAt: now, revision: sql`${taskClaim.revision} + 1` })
        .where(eq(taskClaim.id, current.id));
    }

    const priorClaims = await tx
      .select({ fence: taskClaim.fence })
      .from(taskClaim)
      .where(and(eq(taskClaim.tenantId, tenantId), eq(taskClaim.taskId, taskId)))
      .orderBy(desc(taskClaim.fence))
      .limit(1);
    const fence = (priorClaims[0]?.fence ?? 0) + 1;
    const id = uuidv7(now);
    await tx.insert(taskClaim).values({
      id,
      tenantId,
      taskId,
      actor,
      principalId: attribution.id,
      revision: 1,
      fence,
      acquiredAt: now,
      heartbeatAt: now,
      expiresAt,
      metadata: JSON.stringify(options.metadata ?? {}),
      createdAt: now,
      updatedAt: now,
    });
    const insertedRows = await tx.select().from(taskClaim).where(eq(taskClaim.id, id)).limit(1);
    const inserted = parseClaim(insertedRows[0]!);
    const event = await recordEvent(
      tx,
      {
        tenantId,
        actor,
        principalId: attribution.id,
        entityType: "task",
        entityId: taskId,
        eventType: "claim_acquired",
        payload: {
          after: { claimId: id, fence, expiresAt },
          ...(current ? { before: { expiredClaimId: current.id, actor: current.actor } } : {}),
        },
      },
      { defer: true, now },
    );
    await storeRetryIdentity(
      tx, tenantId, identity, "task_claim", inserted.id, "active",
      inserted.revision, event.sequence,
    );
    return { result: inserted, event };
  });

  if (event) emitAfterCommit(event);
  return result;
}

export interface ReleaseClaimOptions extends ServiceContext {
  reason?: string;
  force?: boolean;
  now?: number;
}

export async function releaseTaskClaim(
  db: TasqDb,
  taskId: string,
  options: ReleaseClaimOptions = {},
): Promise<TaskClaim> {
  const tenantId = options.tenantId ?? "gwendall";
  const actor = options.actor ?? "system";
  const now = validateUnixMs(serviceNow(options, options.now), "now");
  const identity = retryIdentity({ ...options, tenantId }, "claim.release", {
    taskId,
    actor,
    principalId: options.principalId ?? null,
    expectedRevision: options.expectedRevision ?? null,
    reason: options.reason ?? null,
    force: options.force ?? false,
  }, now);

  const { result, event } = await runInTransaction(db, async (tx) => {
    const priorId = await priorResultId(tx, tenantId, identity);
    if (priorId) {
      const prior = await getTaskClaim(tx, priorId, tenantId);
      if (!prior) throw new Error(`Idempotency record points at missing claim ${priorId}`);
      return { result: prior, event: null as EventT | null };
    }
    await requireLiveTask(tx, taskId, tenantId);
    const rows = await tx
      .select()
      .from(taskClaim)
      .where(
        and(
          eq(taskClaim.tenantId, tenantId),
          eq(taskClaim.taskId, taskId),
          isNull(taskClaim.releasedAt),
        ),
      )
      .limit(1);
    const current = rows[0] ? parseClaim(rows[0]) : null;
    if (!current) throw new Error(`Task ${taskId} has no unreleased claim`);
    if (now < current.acquiredAt) {
      throw new Error(`Release time ${now} precedes claim acquisition ${current.acquiredAt}`);
    }
    const attribution = await resolveCallerPrincipal(tx, tenantId, options, actor, now);
    if ((current.principalId ? current.principalId !== attribution.id : current.actor !== actor) && !options.force) {
      throw new Error(`Claim belongs to ${current.actor}; pass force to release it as ${actor}`);
    }

    const releasedMutation = await tx
      .update(taskClaim)
      .set({
        releasedAt: now,
        releaseReason: options.reason ?? (current.expiresAt <= now ? "expired" : "released"),
        updatedAt: now,
        revision: sql`${taskClaim.revision} + 1`,
      })
      .where(and(
        eq(taskClaim.id, current.id),
        ...(options.expectedRevision === undefined ? [] : [eq(taskClaim.revision, options.expectedRevision)]),
      )).returning({ revision: taskClaim.revision });
    if (options.expectedRevision !== undefined && releasedMutation.length === 0) {
      throw new Error(`Stale claim revision: expected ${options.expectedRevision}`);
    }
    const updatedRows = await tx.select().from(taskClaim).where(eq(taskClaim.id, current.id)).limit(1);
    const released = parseClaim(updatedRows[0]!);
    const event = await recordEvent(
      tx,
      {
        tenantId,
        actor,
        principalId: attribution.id,
        entityType: "task",
        entityId: taskId,
        eventType: "claim_released",
        payload: {
          before: { claimId: current.id, actor: current.actor, expiresAt: current.expiresAt },
          ...(options.reason ? { reason: options.reason } : {}),
        },
      },
      { defer: true, now },
    );
    await storeRetryIdentity(
      tx,
      tenantId,
      identity,
      "task_claim",
      released.id,
      "released",
      released.revision,
      event.sequence,
    );
    return { result: released, event };
  });

  if (event) emitAfterCommit(event);
  return result;
}

export async function getActiveTaskClaim(
  db: TasqDbOrTx,
  taskId: string,
  tenantId = "gwendall",
  nowOrClock: number | Clock = serviceNow(),
): Promise<TaskClaim | null> {
  const now = typeof nowOrClock === "number" ? nowOrClock : nowOrClock.now();
  const rows = await db
    .select()
    .from(taskClaim)
    .where(
      and(
        eq(taskClaim.tenantId, tenantId),
        eq(taskClaim.taskId, taskId),
        isNull(taskClaim.releasedAt),
        gt(taskClaim.expiresAt, now),
      ),
    )
    .limit(1);
  return rows[0] ? parseClaim(rows[0]) : null;
}

export async function getTaskClaim(
  db: TasqDbOrTx,
  id: string,
  tenantId = "gwendall",
): Promise<TaskClaim | null> {
  const rows = await db
    .select()
    .from(taskClaim)
    .where(and(eq(taskClaim.id, id), eq(taskClaim.tenantId, tenantId)))
    .limit(1);
  return rows[0] ? parseClaim(rows[0]) : null;
}

export interface ListClaimsOptions extends ServiceContext {
  activeOnly?: boolean;
  actorFilter?: string;
  now?: number;
}

export async function listTaskClaims(
  db: TasqDb,
  taskId: string | null,
  options: ListClaimsOptions = {},
): Promise<TaskClaim[]> {
  const tenantId = options.tenantId ?? "gwendall";
  const filters = [eq(taskClaim.tenantId, tenantId)];
  if (taskId) filters.push(eq(taskClaim.taskId, taskId));
  if (options.actorFilter) filters.push(eq(taskClaim.actor, options.actorFilter));
  if (options.activeOnly) {
    filters.push(isNull(taskClaim.releasedAt));
    filters.push(gt(taskClaim.expiresAt, serviceNow(options, options.now)));
  }
  const rows = await db
    .select()
    .from(taskClaim)
    .where(and(...filters))
    .orderBy(desc(taskClaim.createdAt));
  return rows.map(parseClaim);
}

/** Batch active claims for actionable queue filtering. */
export async function activeTaskClaimMap(
  db: TasqDb,
  tenantId = "gwendall",
  nowOrClock: number | Clock = serviceNow(),
): Promise<Map<string, TaskClaim>> {
  const now = typeof nowOrClock === "number" ? nowOrClock : nowOrClock.now();
  const rows = await db
    .select()
    .from(taskClaim)
    .where(
      and(
        eq(taskClaim.tenantId, tenantId),
        isNull(taskClaim.releasedAt),
        gt(taskClaim.expiresAt, now),
      ),
    );
  return new Map(rows.map((row) => {
    const parsed = parseClaim(row);
    return [parsed.taskId, parsed];
  }));
}

export interface StartAttemptOptions extends ServiceContext {
  claimId?: string | null;
  runtime?: string;
  externalId?: string | null;
  contextId?: string | null;
  metadata?: Metadata;
  occurredAt?: number;
}

export async function startTaskAttempt(
  db: TasqDb,
  taskId: string,
  options: StartAttemptOptions = {},
): Promise<TaskAttempt> {
  const tenantId = options.tenantId ?? "gwendall";
  const actor = options.actor ?? "system";
  const now = validateUnixMs(serviceNow(options, options.occurredAt), "occurredAt");
  const parsed = TaskAttemptInsert.parse({
    taskId,
    tenantId,
    claimId: options.claimId ?? null,
    runtime: options.runtime ?? "local",
    externalId: options.externalId ?? null,
    contextId: options.contextId ?? null,
    metadata: options.metadata ?? {},
  });
  const identity = retryIdentity({ ...options, tenantId }, "attempt.start", {
    taskId,
    actor,
    principalId: options.principalId ?? null,
    claimId: parsed.claimId,
    runtime: parsed.runtime,
    externalId: parsed.externalId,
    contextId: parsed.contextId,
    metadata: parsed.metadata,
  }, now);

  const { result, event } = await runInTransaction(db, async (tx) => {
    const priorId = await priorResultId(tx, tenantId, identity);
    if (priorId) {
      const prior = await getTaskAttempt(tx, priorId, tenantId);
      if (!prior) throw new Error(`Idempotency record points at missing attempt ${priorId}`);
      return { result: prior, event: null as EventT | null };
    }
    const linkedTask = await requireLiveTask(tx, taskId, tenantId);
    const attribution = await resolveCallerPrincipal(tx, tenantId, options, actor, now);
    if (linkedTask.status === "done" || linkedTask.status === "cancelled") {
      throw new Error(`Cannot start an attempt for terminal task ${taskId}`);
    }

    const activeClaim = await getActiveTaskClaim(tx, taskId, tenantId, now);
    if (activeClaim && (activeClaim.principalId
      ? activeClaim.principalId !== attribution.id
      : activeClaim.actor !== actor)) {
      throw new Error(`Task ${taskId} is claimed by ${activeClaim.actor}`);
    }
    const claimId = parsed.claimId ?? activeClaim?.id ?? null;
    if (claimId) {
      const claimRows = await tx
        .select()
        .from(taskClaim)
        .where(and(eq(taskClaim.id, claimId), eq(taskClaim.tenantId, tenantId)))
        .limit(1);
      const claim = claimRows[0] ? parseClaim(claimRows[0]) : null;
      if (!claim || claim.taskId !== taskId) throw new Error(`Claim does not belong to task ${taskId}`);
      if (claim.principalId ? claim.principalId !== attribution.id : claim.actor !== actor) {
        throw new Error(`Claim ${claimId} belongs to another principal`);
      }
      if (claim.releasedAt != null || claim.expiresAt <= now) throw new Error(`Claim ${claimId} is not active`);
    }

    const id = parsed.id ?? uuidv7(now);
    await tx.insert(taskAttempt).values({
      id,
      tenantId,
      taskId,
      claimId,
      actor,
      principalId: attribution.id,
      revision: 1,
      runtime: parsed.runtime,
      externalId: parsed.externalId,
      contextId: parsed.contextId,
      status: "running",
      startedAt: now,
      metadata: JSON.stringify(parsed.metadata),
      createdAt: now,
      updatedAt: now,
    });
    const inserted = await getTaskAttempt(tx, id, tenantId);
    if (!inserted) throw new Error(`Failed to read back attempt ${id}`);
    const event = await recordEvent(
      tx,
      {
        tenantId,
        actor,
        principalId: attribution.id,
        entityType: "task",
        entityId: taskId,
        eventType: "attempt_started",
        occurredAt: options.occurredAt ?? null,
        payload: {
          after: {
            attemptId: id,
            runtime: parsed.runtime,
            claimId,
            externalId: parsed.externalId,
            contextId: parsed.contextId,
          },
        },
      },
      { defer: true, now },
    );
    await storeRetryIdentity(
      tx, tenantId, identity, "task_attempt", inserted.id,
      inserted.status, inserted.revision, event.sequence,
    );
    return { result: inserted, event };
  });

  if (event) emitAfterCommit(event);
  return result;
}

export async function getTaskAttempt(
  db: TasqDbOrTx,
  id: string,
  tenantId = "gwendall",
): Promise<TaskAttempt | null> {
  const rows = await db
    .select()
    .from(taskAttempt)
    .where(and(eq(taskAttempt.id, id), eq(taskAttempt.tenantId, tenantId)))
    .limit(1);
  return rows[0] ? parseAttempt(rows[0]) : null;
}

export interface ListAttemptsOptions extends ServiceContext {
  statuses?: AttemptStatusT[];
  actorFilter?: string;
  limit?: number;
}

export async function listTaskAttempts(
  db: TasqDb,
  taskId: string | null,
  options: ListAttemptsOptions = {},
): Promise<TaskAttempt[]> {
  const filters = [eq(taskAttempt.tenantId, options.tenantId ?? "gwendall")];
  if (taskId) filters.push(eq(taskAttempt.taskId, taskId));
  if (options.actorFilter) filters.push(eq(taskAttempt.actor, options.actorFilter));
  if (options.statuses?.length) filters.push(inArray(taskAttempt.status, options.statuses));
  const rows = await db
    .select()
    .from(taskAttempt)
    .where(and(...filters))
    .orderBy(desc(taskAttempt.startedAt))
    .limit(options.limit ?? 100);
  return rows.map(parseAttempt);
}

export interface TransitionAttemptOptions extends ServiceContext {
  message?: string | null;
  occurredAt?: number;
}

export async function transitionTaskAttempt(
  db: TasqDb,
  id: string,
  to: AttemptStatusT,
  options: TransitionAttemptOptions = {},
): Promise<TaskAttempt> {
  const parsedStatus = AttemptStatus.parse(to);
  const tenantId = options.tenantId ?? "gwendall";
  const actor = options.actor ?? "system";
  const now = validateUnixMs(serviceNow(options, options.occurredAt), "occurredAt");
  const identity = retryIdentity({ ...options, tenantId }, `attempt.transition.${parsedStatus}`, {
    attemptId: id,
    to: parsedStatus,
    actor,
    principalId: options.principalId ?? null,
    expectedRevision: options.expectedRevision ?? null,
    message: options.message ?? null,
    occurredAt: options.occurredAt ?? null,
  }, now);

  const { result, event } = await runInTransaction(db, async (tx) => {
    const priorId = await priorResultId(tx, tenantId, identity);
    if (priorId) {
      const prior = await getTaskAttempt(tx, priorId, tenantId);
      if (!prior) throw new Error(`Idempotency record points at missing attempt ${priorId}`);
      return { result: prior, event: null as EventT | null };
    }
    const before = await getTaskAttempt(tx, id, tenantId);
    if (!before) throw new Error(`Attempt not found: ${id}`);
    if (before.status === parsedStatus && TERMINAL_ATTEMPT_STATUSES.has(parsedStatus)) {
      await storeRetryIdentity(
        tx, tenantId, identity, "task_attempt", before.id,
        before.status, before.revision, null,
      );
      return { result: before, event: null as EventT | null };
    }
    if (TERMINAL_ATTEMPT_STATUSES.has(before.status)) {
      throw new Error(`Attempt ${id} is terminal (${before.status}) and immutable`);
    }
    if (now < before.startedAt) {
      throw new Error(`Attempt end time ${now} precedes start ${before.startedAt}`);
    }
    if (now < before.updatedAt) {
      throw new Error(`Attempt update time ${now} precedes revision time ${before.updatedAt}`);
    }
    if (before.status === parsedStatus && now === before.updatedAt &&
      (options.message ?? before.statusMessage) === before.statusMessage) {
      await storeRetryIdentity(
        tx, tenantId, identity, "task_attempt", before.id,
        before.status, before.revision, null,
      );
      return { result: before, event: null as EventT | null };
    }
    const allowed = before.status === "running"
      ? new Set<AttemptStatusT>(["running", "input_required", "succeeded", "failed", "cancelled"])
      : new Set<AttemptStatusT>(["input_required", "running", "succeeded", "failed", "cancelled"]);
    if (!allowed.has(parsedStatus)) {
      throw new Error(`Invalid attempt transition: ${before.status} → ${parsedStatus}`);
    }
    const attribution = await resolveCallerPrincipal(tx, tenantId, options, actor, now);

    const updated = await tx
      .update(taskAttempt)
      .set({
        status: parsedStatus,
        statusMessage: options.message ?? before.statusMessage,
        endedAt: TERMINAL_ATTEMPT_STATUSES.has(parsedStatus) ? now : null,
        updatedAt: now,
        revision: sql`${taskAttempt.revision} + 1`,
      })
      .where(and(
        eq(taskAttempt.id, id),
        eq(taskAttempt.tenantId, tenantId),
        ...(options.expectedRevision === undefined ? [] : [eq(taskAttempt.revision, options.expectedRevision)]),
      )).returning({ revision: taskAttempt.revision });
    if (options.expectedRevision !== undefined && updated.length === 0) {
      throw new Error(`Stale attempt revision: expected ${options.expectedRevision}`);
    }
    const after = await getTaskAttempt(tx, id, tenantId);
    if (!after) throw new Error(`Failed to read back attempt ${id}`);
    const event = await recordEvent(
      tx,
      {
        tenantId,
        actor,
        principalId: attribution.id,
        entityType: "task",
        entityId: before.taskId,
        eventType: `attempt_${parsedStatus}`,
        occurredAt: options.occurredAt ?? null,
        payload: {
          before: { attemptId: id, status: before.status },
          after: { attemptId: id, status: parsedStatus },
          ...(options.message ? { note: options.message } : {}),
        },
      },
      { defer: true, now },
    );
    await storeRetryIdentity(
      tx, tenantId, identity, "task_attempt", after.id,
      after.status, after.revision, event.sequence,
    );
    return { result: after, event };
  });

  if (event) emitAfterCommit(event);
  return result;
}

export interface AddEvidenceOptions extends ServiceContext {
  occurredAt?: number;
}

export async function addTaskEvidence(
  db: TasqDb,
  input: unknown,
  options: AddEvidenceOptions = {},
): Promise<TaskEvidence> {
  const parsed = TaskEvidenceInsert.parse(input);
  const tenantId = options.tenantId ?? parsed.tenantId;
  const actor = options.actor ?? "system";
  const now = serviceNow(options);
  const observedAt = validateUnixMs(
    parsed.observedAt ?? options.occurredAt ?? now,
    "observedAt",
  );
  const identity = retryIdentity({ ...options, tenantId }, "evidence.add", {
    taskId: parsed.taskId,
    attemptId: parsed.attemptId,
    supersedesEvidenceId: parsed.supersedesEvidenceId,
    kind: parsed.kind,
    summary: parsed.summary,
    uri: parsed.uri,
    digest: parsed.digest,
    source: parsed.source,
    metadata: parsed.metadata,
    tenantId,
    actor,
    principalId: options.principalId ?? null,
    requestedObservedAt: parsed.observedAt ?? options.occurredAt ?? null,
  }, now);

  const { result, event } = await runInTransaction(db, async (tx) => {
    const priorId = await priorResultId(tx, tenantId, identity);
    if (priorId) {
      const prior = await getTaskEvidence(tx, priorId, tenantId);
      if (!prior) throw new Error(`Idempotency record points at missing evidence ${priorId}`);
      return { result: prior, event: null as EventT | null };
    }
    await requireLiveTask(tx, parsed.taskId, tenantId);
    if (parsed.attemptId) {
      const attempt = await getTaskAttempt(tx, parsed.attemptId, tenantId);
      if (!attempt || attempt.taskId !== parsed.taskId) {
        throw new Error(`Attempt does not belong to task ${parsed.taskId}`);
      }
    }
    if (parsed.supersedesEvidenceId) {
      const prior = await getTaskEvidence(tx, parsed.supersedesEvidenceId, tenantId);
      if (!prior || prior.taskId !== parsed.taskId) {
        throw new Error(`Superseded evidence does not belong to task ${parsed.taskId}`);
      }
    }

    const id = parsed.id ?? uuidv7(now);
    const attribution = await resolveCallerPrincipal(tx, tenantId, options, actor, now);
    await tx.insert(taskEvidence).values({
      id,
      tenantId,
      taskId: parsed.taskId,
      attemptId: parsed.attemptId,
      supersedesEvidenceId: parsed.supersedesEvidenceId,
      actor,
      principalId: attribution.id,
      kind: parsed.kind,
      summary: parsed.summary,
      uri: parsed.uri,
      digest: parsed.digest,
      source: parsed.source,
      observedAt,
      metadata: JSON.stringify(parsed.metadata),
      createdAt: now,
    });
    const inserted = await getTaskEvidence(tx, id, tenantId);
    if (!inserted) throw new Error(`Failed to read back evidence ${id}`);
    const event = await recordEvent(
      tx,
      {
        tenantId,
        actor,
        principalId: attribution.id,
        entityType: "task",
        entityId: parsed.taskId,
        eventType: "evidence_added",
        occurredAt: options.occurredAt ?? null,
        payload: {
          after: {
            evidenceId: id,
            attemptId: parsed.attemptId,
            supersedesEvidenceId: parsed.supersedesEvidenceId,
            kind: parsed.kind,
            uri: parsed.uri,
            digest: parsed.digest,
          },
          ...(parsed.source ? { source: parsed.source } : {}),
          ...(parsed.summary ? { note: parsed.summary } : {}),
        },
      },
      { defer: true, now },
    );
    await storeRetryIdentity(
      tx, tenantId, identity, "task_evidence", inserted.id,
      "recorded", null, event.sequence,
    );
    return { result: inserted, event };
  });

  if (event) emitAfterCommit(event);
  return result;
}

export async function getTaskEvidence(
  db: TasqDbOrTx,
  id: string,
  tenantId = "gwendall",
): Promise<TaskEvidence | null> {
  const rows = await db
    .select()
    .from(taskEvidence)
    .where(and(eq(taskEvidence.id, id), eq(taskEvidence.tenantId, tenantId)))
    .limit(1);
  return rows[0] ? parseEvidence(rows[0]) : null;
}

export interface ListEvidenceOptions extends ServiceContext {
  attemptId?: string;
  kind?: string;
  limit?: number;
  ascending?: boolean;
}

export async function listTaskEvidence(
  db: TasqDb,
  taskId: string | null,
  options: ListEvidenceOptions = {},
): Promise<TaskEvidence[]> {
  const filters = [eq(taskEvidence.tenantId, options.tenantId ?? "gwendall")];
  if (taskId) filters.push(eq(taskEvidence.taskId, taskId));
  if (options.attemptId) filters.push(eq(taskEvidence.attemptId, options.attemptId));
  if (options.kind) filters.push(eq(taskEvidence.kind, options.kind));
  const rows = await db
    .select()
    .from(taskEvidence)
    .where(and(...filters))
    .orderBy((options.ascending ? asc : desc)(taskEvidence.createdAt))
    .limit(options.limit ?? 100);
  return rows.map(parseEvidence);
}

export { ATTEMPT_STATUSES };

export const AGENTIC_CONFIG = {
  DEFAULT_LEASE_MS,
  MIN_LEASE_MS,
  MAX_LEASE_MS,
} as const;

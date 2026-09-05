/** Provider-neutral observed-cost receipts and conservative claim bounds. */

import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import {
  ExternalRef as ExternalRefZ,
  externalRef,
  taskAttempt,
  taskClaim,
  uuidv7,
  type ExternalRef,
  type Task, LEGACY_DEFAULT_WORKSPACE_ID } from "@tasq-run/schema";
import type { TasqDb, TasqDbOrTx } from "../db.js";
import { runInTransaction } from "../db.js";
import { canonicalJson, sha256Digest } from "../util/canonical-json.js";
import { parseRow } from "../util/row.js";
import { serviceNow } from "../util/clock.js";
import type { ServiceContext } from "./context.js";
import { emitAfterCommit, recordEvent } from "./events.js";
import {
  findIdempotencyResult,
  prepareIdempotency,
  saveIdempotencyResult,
} from "./idempotency.js";
import { ensureLocalPrincipal, getPrincipal } from "./principals.js";
import { getTask, updateTask } from "./tasks.js";

export const ATTEMPT_COST_OBSERVATION_URI =
  "https://tasq.run/contracts/attempt-cost-observation/v1" as const;
export const TASK_COST_BUDGET_METADATA_KEY = "tasqCostBudget" as const;

const Micros = z.string().regex(/^(0|[1-9][0-9]{0,18})$/);
const Currency = z.string().regex(/^[A-Z]{3}$/);

export const TaskCostBudget = z.object({
  contract: z.literal("tasq.task-cost-budget.v1"),
  currency: Currency,
  maxGrossMicros: Micros.refine((value) => BigInt(value) > 0n, "maxGrossMicros must be positive"),
  renewalReserveMicros: Micros.default("0"),
  metering: z.enum(["required", "best_effort"]).default("required"),
}).superRefine((value, context) => {
  if (BigInt(value.renewalReserveMicros) > BigInt(value.maxGrossMicros)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["renewalReserveMicros"],
      message: "renewalReserveMicros cannot exceed maxGrossMicros",
    });
  }
});
export type TaskCostBudget = z.infer<typeof TaskCostBudget>;

export const AttemptCostObservation = z.object({
  contract: z.literal("tasq.attempt-cost-observation.v1"),
  attemptId: z.string().uuid(),
  taskId: z.string().uuid(),
  meterUri: z.string().url(),
  observationId: z.string().trim().min(1).max(1_000),
  currency: Currency,
  grossMicros: Micros,
  observedAt: z.number().int().nonnegative(),
  basis: z.enum(["provider_receipt", "runtime_meter", "operator_attestation"]),
});
export type AttemptCostObservation = z.infer<typeof AttemptCostObservation>;

const RecordAttemptCostInput = AttemptCostObservation.omit({
  contract: true,
  attemptId: true,
  taskId: true,
});

export interface TaskCostSummary {
  contractVersion: "tasq.task-cost-summary.v1";
  taskId: string;
  budget: TaskCostBudget | null;
  observedGrossByCurrency: Record<string, string>;
  observationCount: number;
  currentClaimId: string | null;
  currentClaimMetered: boolean;
  renewal: {
    allowed: boolean;
    reason: "unbounded" | "within_bound" | "metering_required" | "bound_reached";
    observedGrossMicros: string | null;
    remainingMicros: string | null;
  };
}

export class CostBoundError extends Error {
  readonly code: "cost_metering_required" | "cost_bound_reached";
  constructor(readonly summary: TaskCostSummary) {
    const code = summary.renewal.reason === "metering_required"
      ? "cost_metering_required" as const
      : "cost_bound_reached" as const;
    super(code === "cost_metering_required"
      ? `Claim renewal refused: no cost observation exists for claim ${summary.currentClaimId}`
      : `Claim renewal refused: observed cost reached the task's hard bound`);
    this.name = "CostBoundError";
    this.code = code;
  }
}

function parseExternalRef(row: typeof externalRef.$inferSelect): ExternalRef {
  return ExternalRefZ.parse(parseRow(row));
}

function budgetFromTask(task: Task): TaskCostBudget | null {
  const candidate = task.metadata[TASK_COST_BUDGET_METADATA_KEY];
  if (candidate === undefined) return null;
  return TaskCostBudget.parse(candidate);
}

function observationFromRef(ref: ExternalRef): AttemptCostObservation | null {
  if (ref.resourceType !== ATTEMPT_COST_OBSERVATION_URI) return null;
  return AttemptCostObservation.parse(ref.metadata);
}

async function resolvePrincipal(
  tx: TasqDbOrTx,
  tenantId: string,
  context: ServiceContext,
  actor: string,
  now: number,
) {
  if (!context.principalId) return ensureLocalPrincipal(tx, tenantId, actor, now);
  const principal = await getPrincipal(tx, context.principalId, tenantId);
  if (!principal) throw new Error(`Principal not found in workspace: ${context.principalId}`);
  if (principal.status !== "enabled") throw new Error(`Principal is disabled: ${principal.id}`);
  return principal;
}

async function costRefsForTask(
  tx: TasqDbOrTx,
  taskId: string,
  tenantId: string,
): Promise<Array<{ ref: ExternalRef; claimId: string | null }>> {
  const rows = await tx.select({ ref: externalRef, claimId: taskAttempt.claimId })
    .from(externalRef)
    .innerJoin(taskAttempt, and(
      eq(externalRef.tenantId, taskAttempt.tenantId),
      eq(externalRef.recordId, taskAttempt.id),
    ))
    .where(and(
      eq(externalRef.tenantId, tenantId),
      eq(externalRef.recordType, "attempt"),
      eq(externalRef.resourceType, ATTEMPT_COST_OBSERVATION_URI),
      eq(taskAttempt.taskId, taskId),
    ))
    .orderBy(asc(externalRef.createdAt), asc(externalRef.id));
  return rows.map((row) => ({ ref: parseExternalRef(row.ref), claimId: row.claimId }));
}

async function summarizeTaskCostInTransaction(
  tx: TasqDbOrTx,
  taskId: string,
  tenantId: string,
  currentClaimId: string | null,
  enforceCurrentClaimMetering: boolean,
): Promise<TaskCostSummary> {
  const task = await getTask(tx, taskId, tenantId);
  if (!task || task.deletedAt !== null) throw new Error(`Task not found: ${taskId}`);
  const budget = budgetFromTask(task);
  const refs = await costRefsForTask(tx, taskId, tenantId);
  const totals = new Map<string, bigint>();
  let currentClaimMetered = false;
  for (const item of refs) {
    const observation = observationFromRef(item.ref);
    if (!observation) continue;
    totals.set(observation.currency, (totals.get(observation.currency) ?? 0n) + BigInt(observation.grossMicros));
    if (currentClaimId !== null && item.claimId === currentClaimId) currentClaimMetered = true;
  }
  const observedGrossByCurrency = Object.fromEntries(
    [...totals.entries()].sort(([left], [right]) => left.localeCompare(right))
      .map(([currency, amount]) => [currency, amount.toString()]),
  );
  if (!budget) {
    return {
      contractVersion: "tasq.task-cost-summary.v1",
      taskId,
      budget: null,
      observedGrossByCurrency,
      observationCount: refs.length,
      currentClaimId,
      currentClaimMetered,
      renewal: {
        allowed: true,
        reason: "unbounded",
        observedGrossMicros: null,
        remainingMicros: null,
      },
    };
  }
  const observed = totals.get(budget.currency) ?? 0n;
  const maximum = BigInt(budget.maxGrossMicros);
  const reserve = BigInt(budget.renewalReserveMicros);
  const remaining = maximum > observed ? maximum - observed : 0n;
  const meterDenied = enforceCurrentClaimMetering && budget.metering === "required" && !currentClaimMetered;
  const boundDenied = observed >= maximum || observed + reserve > maximum;
  return {
    contractVersion: "tasq.task-cost-summary.v1",
    taskId,
    budget,
    observedGrossByCurrency,
    observationCount: refs.length,
    currentClaimId,
    currentClaimMetered,
    renewal: {
      allowed: !meterDenied && !boundDenied,
      reason: meterDenied ? "metering_required" : boundDenied ? "bound_reached" : "within_bound",
      observedGrossMicros: observed.toString(),
      remainingMicros: remaining.toString(),
    },
  };
}

/** Internal claim gate; caller must already hold the writer transaction. */
export async function assertTaskCostAllowsClaim(
  tx: TasqDbOrTx,
  taskId: string,
  tenantId: string,
  currentClaimId: string | null,
  renewal: boolean,
): Promise<TaskCostSummary> {
  const summary = await summarizeTaskCostInTransaction(
    tx, taskId, tenantId, currentClaimId, renewal,
  );
  if (!summary.renewal.allowed) throw new CostBoundError(summary);
  return summary;
}

export async function getTaskCostSummary(
  db: TasqDb,
  taskId: string,
  options: ServiceContext = {},
): Promise<TaskCostSummary> {
  const tenantId = options.tenantId ?? LEGACY_DEFAULT_WORKSPACE_ID;
  const now = serviceNow(options, options.now);
  const claims = await db.select().from(taskClaim).where(and(
    eq(taskClaim.tenantId, tenantId),
    eq(taskClaim.taskId, taskId),
    isNull(taskClaim.releasedAt),
  )).limit(1);
  const current = claims[0] && claims[0].expiresAt > now ? claims[0] : null;
  return summarizeTaskCostInTransaction(db, taskId, tenantId, current?.id ?? null, Boolean(current));
}

export async function configureTaskCostBudget(
  db: TasqDb,
  taskId: string,
  input: unknown,
  context: ServiceContext = {},
): Promise<Task> {
  const budget = TaskCostBudget.parse(input);
  const tenantId = context.tenantId ?? LEGACY_DEFAULT_WORKSPACE_ID;
  const task = await getTask(db, taskId, tenantId);
  if (!task || task.deletedAt !== null) throw new Error(`Task not found: ${taskId}`);
  return updateTask(db, taskId, {
    metadata: { ...task.metadata, [TASK_COST_BUDGET_METADATA_KEY]: budget },
  }, { ...context, expectedRevision: context.expectedRevision ?? task.revision });
}

export interface RecordAttemptCostResult {
  observation: AttemptCostObservation;
  externalRef: ExternalRef;
  summary: TaskCostSummary;
  replayed: boolean;
  claimReleased: boolean;
}

export async function recordAttemptCost(
  db: TasqDb,
  attemptId: string,
  input: unknown,
  context: ServiceContext = {},
): Promise<RecordAttemptCostResult> {
  const parsed = RecordAttemptCostInput.parse(input);
  const tenantId = context.tenantId ?? LEGACY_DEFAULT_WORKSPACE_ID;
  const actor = context.actor ?? "system";
  const now = serviceNow(context, context.now);
  const attemptRows = await db.select().from(taskAttempt).where(and(
    eq(taskAttempt.tenantId, tenantId), eq(taskAttempt.id, attemptId),
  )).limit(1);
  const attempt = attemptRows[0];
  if (!attempt) throw new Error(`Attempt not found: ${attemptId}`);
  const observation = AttemptCostObservation.parse({
    contract: "tasq.attempt-cost-observation.v1",
    ...parsed,
    attemptId,
    taskId: attempt.taskId,
  });
  const canonical = canonicalJson(observation);
  const digest = sha256Digest(canonical);
  const retry = prepareIdempotency(
    { ...context, tenantId, actor },
    "attempt-cost.record",
    observation,
    { now, retentionClass: "durable" },
  );

  const committed = await runInTransaction(db, async (tx) => {
    const prior = await findIdempotencyResult(tx, retry);
    if (prior) {
      const rows = await tx.select().from(externalRef).where(and(
        eq(externalRef.tenantId, tenantId), eq(externalRef.id, prior.resultId),
      )).limit(1);
      if (!rows[0]) throw new Error(`Idempotency record points at missing cost receipt ${prior.resultId}`);
      const ref = parseExternalRef(rows[0]);
      const summary = await summarizeTaskCostInTransaction(tx, attempt.taskId, tenantId, null, false);
      return { result: { observation, externalRef: ref, summary, replayed: true, claimReleased: false }, events: [] };
    }
    const exact = await tx.select().from(externalRef).where(and(
      eq(externalRef.tenantId, tenantId),
      eq(externalRef.system, observation.meterUri),
      eq(externalRef.resourceType, ATTEMPT_COST_OBSERVATION_URI),
      eq(externalRef.externalId, observation.observationId),
    )).limit(1);
    if (exact[0]) {
      const ref = parseExternalRef(exact[0]);
      if (ref.digest !== digest || ref.recordId !== attemptId) {
        throw new Error(`Cost observation identity already exists with different bytes: ${observation.observationId}`);
      }
      const summary = await summarizeTaskCostInTransaction(tx, attempt.taskId, tenantId, null, false);
      return { result: { observation, externalRef: ref, summary, replayed: true, claimReleased: false }, events: [] };
    }
    const task = await getTask(tx, attempt.taskId, tenantId);
    if (!task || task.deletedAt !== null) throw new Error(`Task not found: ${attempt.taskId}`);
    const budget = budgetFromTask(task);
    if (budget && budget.currency !== observation.currency) {
      throw new Error(`Cost observation currency ${observation.currency} does not match budget ${budget.currency}`);
    }
    const principal = await resolvePrincipal(tx, tenantId, context, actor, now);
    const id = uuidv7(now);
    await tx.insert(externalRef).values({
      id,
      tenantId,
      recordType: "attempt",
      recordId: attemptId,
      system: observation.meterUri,
      resourceType: ATTEMPT_COST_OBSERVATION_URI,
      externalId: observation.observationId,
      url: null,
      version: "1",
      digest,
      metadata: canonical,
      createdByPrincipalId: principal.id,
      createdAt: now,
    });
    const event = await recordEvent(tx, {
      tenantId,
      actor,
      principalId: principal.id,
      entityType: "task",
      entityId: attempt.taskId,
      eventType: "attempt_cost_observed",
      payload: { after: { externalRefId: id, attemptId, currency: observation.currency, grossMicros: observation.grossMicros } },
    }, { defer: true, now });
    const activeRows = await tx.select().from(taskClaim).where(and(
      eq(taskClaim.tenantId, tenantId),
      eq(taskClaim.taskId, attempt.taskId),
      isNull(taskClaim.releasedAt),
    )).limit(1);
    const active = activeRows[0] && activeRows[0].expiresAt > now ? activeRows[0] : null;
    const summary = await summarizeTaskCostInTransaction(
      tx, attempt.taskId, tenantId, active?.id ?? null, false,
    );
    let claimReleased = false;
    const events = [event];
    if (active && !summary.renewal.allowed) {
      await tx.update(taskClaim).set({
        releasedAt: now,
        releaseReason: "cost_bound_reached",
        updatedAt: now,
        revision: sql`${taskClaim.revision} + 1`,
      }).where(eq(taskClaim.id, active.id));
      events.push(await recordEvent(tx, {
        tenantId,
        actor,
        principalId: principal.id,
        entityType: "task",
        entityId: attempt.taskId,
        eventType: "claim_released_cost_bound",
        payload: { before: { claimId: active.id }, after: { observedGrossMicros: summary.renewal.observedGrossMicros } },
      }, { defer: true, now }));
      claimReleased = true;
    }
    await saveIdempotencyResult(tx, retry, {
      resultType: "attempt_cost_observation",
      resultId: id,
      resultStatus: "recorded",
      eventSequence: event.sequence,
    });
    const rows = await tx.select().from(externalRef).where(eq(externalRef.id, id)).limit(1);
    return {
      result: { observation, externalRef: parseExternalRef(rows[0]!), summary, replayed: false, claimReleased },
      events,
    };
  });
  for (const event of committed.events) emitAfterCommit(event);
  return committed.result;
}

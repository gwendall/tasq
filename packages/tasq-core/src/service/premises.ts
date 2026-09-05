/** Observation-backed, independently refutable premises for commitments. */

import { and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import {
  ExternalRef as ExternalRefZ,
  TaskInsert as TaskInsertZ,
  externalRef,
  observation,
  taskAttempt,
  taskClaim,
  taskEvidence,
  uuidv7,
  type Event as EventT,
  type ExternalRef,
  type Task, LEGACY_DEFAULT_WORKSPACE_ID } from "@tasq-run/schema";
import type { TasqDb, TasqDbOrTx } from "../db.js";
import { runInTransaction } from "../db.js";
import { canonicalJson, sha256Digest } from "../util/canonical-json.js";
import { serviceNow } from "../util/clock.js";
import { parseRow } from "../util/row.js";
import type { ServiceContext } from "./context.js";
import { emitAfterCommit, recordEvent } from "./events.js";
import { findIdempotencyResult, prepareIdempotency, saveIdempotencyResult } from "./idempotency.js";
import { ensureLocalPrincipal, getPrincipal } from "./principals.js";
import { createTaskInTransaction, getTask } from "./tasks.js";

export const TASK_PREMISE_SYSTEM_URI = "https://tasq.run" as const;
export const TASK_PREMISE_URI = "https://tasq.run/contracts/task-premise/v1" as const;
export const TASK_PREMISE_PROPOSAL_URI = "https://tasq.run/contracts/task-premise-proposal/v1" as const;
export const TASK_PREMISE_CHALLENGE_URI = "https://tasq.run/contracts/task-premise-challenge/v1" as const;
export const TASK_PREMISE_DECISION_URI = "https://tasq.run/contracts/task-premise-decision/v1" as const;
export const TASK_PREMISE_INVALIDATION_URI = "https://tasq.run/contracts/task-premise-invalidation/v1" as const;

export const RESERVED_TASK_PREMISE_RESOURCE_TYPES = new Set<string>([
  TASK_PREMISE_URI,
  TASK_PREMISE_PROPOSAL_URI,
  TASK_PREMISE_CHALLENGE_URI,
  TASK_PREMISE_DECISION_URI,
  TASK_PREMISE_INVALIDATION_URI,
]);

const PrincipalIds = z.array(z.string().min(1).max(500)).max(32)
  .transform((ids) => [...new Set(ids)].sort());
const EvidenceIds = z.array(z.string().uuid()).min(1).max(128)
  .transform((ids) => [...new Set(ids)].sort());

export const TaskPremise = z.object({
  contract: z.literal("tasq.task-premise.v1"),
  taskId: z.string().uuid(),
  taskRevision: z.number().int().positive(),
  observationId: z.string().uuid(),
  observationDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  proposition: z.string().trim().min(1).max(2_000),
  eligibleValidatorPrincipalIds: PrincipalIds.refine((ids) => ids.length > 0, "At least one validator is required"),
  adjudicatorPrincipalIds: PrincipalIds.default([]),
  allowSelfValidation: z.boolean().default(false),
  createdByPrincipalId: z.string().min(1).max(500),
  createdAt: z.number().int().nonnegative(),
});
export type TaskPremise = z.infer<typeof TaskPremise>;

export const TaskPremiseProposal = z.object({
  contract: z.literal("tasq.task-premise-proposal.v1"),
  taskId: z.string().uuid(),
  premiseId: z.string().uuid(),
  verdict: z.enum(["uphold", "refute"]),
  evidenceIds: EvidenceIds,
  rationale: z.string().trim().min(1).max(2_000),
  proposedByPrincipalId: z.string().min(1).max(500),
  proposedAt: z.number().int().nonnegative(),
});
export type TaskPremiseProposal = z.infer<typeof TaskPremiseProposal>;

export const TaskPremiseChallenge = z.object({
  contract: z.literal("tasq.task-premise-challenge.v1"),
  taskId: z.string().uuid(),
  premiseId: z.string().uuid(),
  proposalId: z.string().uuid(),
  counterEvidenceIds: EvidenceIds,
  rationale: z.string().trim().min(1).max(2_000),
  challengedByPrincipalId: z.string().min(1).max(500),
  challengedAt: z.number().int().nonnegative(),
});
export type TaskPremiseChallenge = z.infer<typeof TaskPremiseChallenge>;

export const TaskPremiseDecision = z.object({
  contract: z.literal("tasq.task-premise-decision.v1"),
  taskId: z.string().uuid(),
  premiseId: z.string().uuid(),
  proposalId: z.string().uuid(),
  outcome: z.enum(["accepted", "rejected", "challenged", "indeterminate"]),
  challengeIds: z.array(z.string().uuid()).max(128),
  evidenceIds: EvidenceIds,
  rationale: z.string().trim().min(1).max(2_000),
  decidedByPrincipalId: z.string().min(1).max(500),
  decidedAt: z.number().int().nonnegative(),
});
export type TaskPremiseDecision = z.infer<typeof TaskPremiseDecision>;

export const TaskPremiseInvalidation = z.object({
  contract: z.literal("tasq.task-premise-invalidation.v1"),
  taskId: z.string().uuid(),
  premiseId: z.string().uuid(),
  proposalId: z.string().uuid(),
  decisionId: z.string().uuid(),
  invalidatedByPrincipalId: z.string().min(1).max(500),
  invalidatedAt: z.number().int().nonnegative(),
  reason: z.string().trim().min(1).max(2_000),
});
export type TaskPremiseInvalidation = z.infer<typeof TaskPremiseInvalidation>;

export interface TaskPremiseState {
  contractVersion: "tasq.task-premise-state.v1";
  task: Task;
  premise: { id: string; value: TaskPremise };
  proposals: Array<{ id: string; value: TaskPremiseProposal }>;
  challenges: Array<{ id: string; value: TaskPremiseChallenge }>;
  decisions: Array<{ id: string; value: TaskPremiseDecision }>;
  invalidation: { id: string; value: TaskPremiseInvalidation } | null;
  actionable: boolean;
}

export interface PremiseContext extends ServiceContext {
  principalId?: string;
}

async function callerPrincipal(tx: TasqDbOrTx, tenantId: string, ctx: PremiseContext, now: number) {
  if (!ctx.principalId) return ensureLocalPrincipal(tx, tenantId, ctx.actor ?? "system", now);
  const principal = await getPrincipal(tx, ctx.principalId, tenantId);
  if (!principal) throw new Error(`Principal not found in workspace: ${ctx.principalId}`);
  if (principal.status !== "enabled") throw new Error(`Principal is disabled: ${principal.id}`);
  return principal;
}

function parseRef(row: typeof externalRef.$inferSelect): ExternalRef {
  return ExternalRefZ.parse(parseRow(row));
}

function metadataFor<S extends z.ZodTypeAny>(ref: ExternalRef, schema: S): z.output<S> {
  return schema.parse(ref.metadata) as z.output<S>;
}

async function insertTypedRef(
  tx: TasqDbOrTx,
  input: {
    tenantId: string;
    taskId: string;
    resourceType: string;
    value: unknown;
    principalId: string;
    now: number;
  },
): Promise<ExternalRef> {
  const id = uuidv7(input.now);
  const canonical = canonicalJson(input.value);
  await tx.insert(externalRef).values({
    id,
    tenantId: input.tenantId,
    recordType: "commitment",
    recordId: input.taskId,
    system: TASK_PREMISE_SYSTEM_URI,
    resourceType: input.resourceType,
    externalId: id,
    url: null,
    version: "1",
    digest: sha256Digest(canonical),
    metadata: canonical,
    createdByPrincipalId: input.principalId,
    createdAt: input.now,
  });
  const rows = await tx.select().from(externalRef).where(eq(externalRef.id, id)).limit(1);
  return parseRef(rows[0]!);
}

async function refsForTask(tx: TasqDbOrTx, taskId: string, tenantId: string): Promise<ExternalRef[]> {
  return (await tx.select().from(externalRef).where(and(
    eq(externalRef.tenantId, tenantId),
    eq(externalRef.recordType, "commitment"),
    eq(externalRef.recordId, taskId),
    eq(externalRef.system, TASK_PREMISE_SYSTEM_URI),
    inArray(externalRef.resourceType, [...RESERVED_TASK_PREMISE_RESOURCE_TYPES]),
  )).orderBy(asc(externalRef.createdAt), asc(externalRef.id))).map(parseRef);
}

async function requireEvidence(
  tx: TasqDbOrTx,
  taskId: string,
  tenantId: string,
  evidenceIds: string[],
): Promise<void> {
  const rows = await tx.select({ id: taskEvidence.id }).from(taskEvidence).where(and(
    eq(taskEvidence.tenantId, tenantId),
    eq(taskEvidence.taskId, taskId),
    inArray(taskEvidence.id, evidenceIds),
  ));
  const found = new Set(rows.map((row) => row.id));
  const missing = evidenceIds.filter((id) => !found.has(id));
  if (missing.length > 0) throw new Error(`Premise evidence does not belong to task ${taskId}: ${missing.join(", ")}`);
}

function retry(ctx: PremiseContext, tenantId: string, operation: string, request: unknown, now: number) {
  return prepareIdempotency({ ...ctx, tenantId }, operation, request, { now, retentionClass: "durable" });
}

export async function createTaskWithPremise(
  db: TasqDb,
  taskInput: unknown,
  premiseInput: unknown,
  ctx: PremiseContext = {},
): Promise<{ task: Task; premise: { id: string; value: TaskPremise }; replayed: boolean }> {
  const tenantId = ctx.tenantId ?? LEGACY_DEFAULT_WORKSPACE_ID;
  const actor = ctx.actor ?? "system";
  const now = serviceNow(ctx, ctx.now);
  const taskParsed = TaskInsertZ.parse({ ...(taskInput as Record<string, unknown>), tenantId });
  const requested = z.object({
    observationId: z.string().uuid(),
    proposition: z.string().trim().min(1).max(2_000),
    eligibleValidatorPrincipalIds: PrincipalIds.refine((ids) => ids.length > 0),
    adjudicatorPrincipalIds: PrincipalIds.default([]),
    allowSelfValidation: z.boolean().default(false),
  }).parse(premiseInput);
  const identity = retry(ctx, tenantId, "premise.task.create", { task: taskParsed, premise: requested }, now);
  const committed = await runInTransaction(db, async (tx) => {
    const prior = await findIdempotencyResult(tx, identity);
    if (prior) {
      const rows = await tx.select().from(externalRef).where(and(
        eq(externalRef.tenantId, tenantId), eq(externalRef.id, prior.resultId),
      )).limit(1);
      if (!rows[0]) throw new Error(`Idempotency record points at missing premise ${prior.resultId}`);
      const ref = parseRef(rows[0]);
      const value = metadataFor(ref, TaskPremise);
      const task = await getTask(tx, value.taskId, tenantId);
      if (!task) throw new Error(`Premise points at missing task ${value.taskId}`);
      return { result: { task, premise: { id: ref.id, value }, replayed: true }, events: [] as EventT[] };
    }
    const observed = (await tx.select().from(observation).where(and(
      eq(observation.tenantId, tenantId), eq(observation.id, requested.observationId),
    )).limit(1))[0];
    if (!observed) throw new Error(`Observation not found in workspace: ${requested.observationId}`);
    const principal = await callerPrincipal(tx, tenantId, ctx, now);
    for (const validatorId of [...requested.eligibleValidatorPrincipalIds, ...requested.adjudicatorPrincipalIds]) {
      const validator = await getPrincipal(tx, validatorId, tenantId);
      if (!validator || validator.status !== "enabled") throw new Error(`Premise validator is not enabled: ${validatorId}`);
    }
    const created = await createTaskInTransaction(tx, taskParsed, {
      tenantId, actor, principalId: principal.id, now,
      eventContext: { source: "task_premise" },
    });
    const value = TaskPremise.parse({
      contract: "tasq.task-premise.v1",
      taskId: created.result.id,
      taskRevision: created.result.revision,
      observationId: requested.observationId,
      observationDigest: sha256Digest(canonicalJson(parseRow(observed))),
      proposition: requested.proposition,
      eligibleValidatorPrincipalIds: requested.eligibleValidatorPrincipalIds,
      adjudicatorPrincipalIds: requested.adjudicatorPrincipalIds,
      allowSelfValidation: requested.allowSelfValidation,
      createdByPrincipalId: principal.id,
      createdAt: now,
    });
    const ref = await insertTypedRef(tx, {
      tenantId, taskId: created.result.id, resourceType: TASK_PREMISE_URI,
      value, principalId: principal.id, now,
    });
    const event = await recordEvent(tx, {
      tenantId, actor, principalId: principal.id, entityType: "task", entityId: created.result.id,
      eventType: "premise_attached",
      payload: { after: { premiseId: ref.id, observationId: value.observationId, observationDigest: value.observationDigest } },
    }, { defer: true, now });
    await saveIdempotencyResult(tx, identity, {
      resultType: "task_premise", resultId: ref.id, resultStatus: "attached", eventSequence: event.sequence,
    });
    return { result: { task: created.result, premise: { id: ref.id, value }, replayed: false }, events: [created.event, event] };
  });
  committed.events.forEach(emitAfterCommit);
  return committed.result;
}

export async function getTaskPremiseState(
  db: TasqDbOrTx,
  taskId: string,
  tenantId = LEGACY_DEFAULT_WORKSPACE_ID,
): Promise<TaskPremiseState | null> {
  const task = await getTask(db, taskId, tenantId);
  if (!task) throw new Error(`Task not found: ${taskId}`);
  const refs = await refsForTask(db, taskId, tenantId);
  const premiseRefs = refs.filter((ref) => ref.resourceType === TASK_PREMISE_URI);
  if (premiseRefs.length === 0) return null;
  if (premiseRefs.length !== 1) throw new Error(`Task ${taskId} has multiple motivating premises`);
  const premiseRef = premiseRefs[0]!;
  const proposals = refs.filter((ref) => ref.resourceType === TASK_PREMISE_PROPOSAL_URI)
    .map((ref) => ({ id: ref.id, value: metadataFor(ref, TaskPremiseProposal) }));
  const challenges = refs.filter((ref) => ref.resourceType === TASK_PREMISE_CHALLENGE_URI)
    .map((ref) => ({ id: ref.id, value: metadataFor(ref, TaskPremiseChallenge) }));
  const decisions = refs.filter((ref) => ref.resourceType === TASK_PREMISE_DECISION_URI)
    .map((ref) => ({ id: ref.id, value: metadataFor(ref, TaskPremiseDecision) }));
  const invalidations = refs.filter((ref) => ref.resourceType === TASK_PREMISE_INVALIDATION_URI)
    .map((ref) => ({ id: ref.id, value: metadataFor(ref, TaskPremiseInvalidation) }));
  if (invalidations.length > 1) throw new Error(`Task ${taskId} has multiple premise invalidations`);
  const premiseValue = metadataFor(premiseRef, TaskPremise);
  if (premiseValue.taskId !== taskId) throw new Error(`Premise task binding drift: ${premiseRef.id}`);
  const proposalById = new Map(proposals.map((item) => [item.id, item]));
  for (const proposal of proposals) {
    if (proposal.value.taskId !== taskId || proposal.value.premiseId !== premiseRef.id) {
      throw new Error(`Premise proposal binding drift: ${proposal.id}`);
    }
  }
  for (const challenge of challenges) {
    if (challenge.value.taskId !== taskId || challenge.value.premiseId !== premiseRef.id
      || !proposalById.has(challenge.value.proposalId)) {
      throw new Error(`Premise challenge binding drift: ${challenge.id}`);
    }
  }
  const decisionById = new Map(decisions.map((item) => [item.id, item]));
  for (const decision of decisions) {
    if (decision.value.taskId !== taskId || decision.value.premiseId !== premiseRef.id
      || !proposalById.has(decision.value.proposalId)) {
      throw new Error(`Premise decision binding drift: ${decision.id}`);
    }
  }
  if (invalidations[0]) {
    const invalidation = invalidations[0];
    const decision = decisionById.get(invalidation.value.decisionId);
    const proposal = proposalById.get(invalidation.value.proposalId);
    if (invalidation.value.taskId !== taskId || invalidation.value.premiseId !== premiseRef.id
      || decision?.value.outcome !== "accepted" || decision.value.proposalId !== invalidation.value.proposalId
      || proposal?.value.verdict !== "refute") {
      throw new Error(`Premise invalidation binding drift: ${invalidation.id}`);
    }
  }
  return {
    contractVersion: "tasq.task-premise-state.v1",
    task,
    premise: { id: premiseRef.id, value: premiseValue },
    proposals,
    challenges,
    decisions,
    invalidation: invalidations[0] ?? null,
    actionable: invalidations.length === 0 && task.deletedAt === null && !["done", "cancelled"].includes(task.status),
  };
}

export async function proposeTaskPremise(
  db: TasqDb,
  taskId: string,
  input: unknown,
  ctx: PremiseContext = {},
): Promise<{ id: string; value: TaskPremiseProposal; replayed: boolean }> {
  const parsed = z.object({
    verdict: z.enum(["uphold", "refute"]), evidenceIds: EvidenceIds,
    rationale: z.string().trim().min(1).max(2_000),
  }).parse(input);
  return appendPremiseMutation(db, taskId, "premise.propose", parsed, ctx, async (tx, basis) => {
    if (basis.state.invalidation) throw new Error("Task premise is already invalidated");
    await requireEvidence(tx, taskId, basis.tenantId, parsed.evidenceIds);
    const value = TaskPremiseProposal.parse({
      contract: "tasq.task-premise-proposal.v1", taskId, premiseId: basis.state.premise.id,
      ...parsed, proposedByPrincipalId: basis.principal.id, proposedAt: basis.now,
    });
    return { resourceType: TASK_PREMISE_PROPOSAL_URI, value, status: "proposed", eventType: "premise_resolution_proposed" };
  });
}

export async function challengeTaskPremise(
  db: TasqDb,
  taskId: string,
  input: unknown,
  ctx: PremiseContext = {},
): Promise<{ id: string; value: TaskPremiseChallenge; replayed: boolean }> {
  const parsed = z.object({
    proposalId: z.string().uuid(), counterEvidenceIds: EvidenceIds,
    rationale: z.string().trim().min(1).max(2_000),
  }).parse(input);
  return appendPremiseMutation(db, taskId, "premise.challenge", parsed, ctx, async (tx, basis) => {
    if (basis.state.invalidation) throw new Error("Task premise is already invalidated");
    const proposal = basis.state.proposals.find((item) => item.id === parsed.proposalId);
    if (!proposal) throw new Error(`Premise proposal not found for task: ${parsed.proposalId}`);
    if (basis.state.decisions.some((item) => item.value.proposalId === proposal.id)) {
      throw new Error("Decided premise proposals are terminal");
    }
    await requireEvidence(tx, taskId, basis.tenantId, parsed.counterEvidenceIds);
    const value = TaskPremiseChallenge.parse({
      contract: "tasq.task-premise-challenge.v1", taskId, premiseId: basis.state.premise.id,
      ...parsed, challengedByPrincipalId: basis.principal.id, challengedAt: basis.now,
    });
    return { resourceType: TASK_PREMISE_CHALLENGE_URI, value, status: "challenged", eventType: "premise_resolution_challenged" };
  });
}

export async function decideTaskPremise(
  db: TasqDb,
  taskId: string,
  input: unknown,
  ctx: PremiseContext = {},
): Promise<{ id: string; value: TaskPremiseDecision; replayed: boolean }> {
  const parsed = z.object({
    proposalId: z.string().uuid(),
    outcome: z.enum(["accepted", "rejected", "challenged", "indeterminate"]),
    rationale: z.string().trim().min(1).max(2_000),
  }).parse(input);
  return appendPremiseMutation(db, taskId, "premise.decide", parsed, ctx, async (tx, basis) => {
    if (basis.state.invalidation) throw new Error("Task premise is already invalidated");
    const proposal = basis.state.proposals.find((item) => item.id === parsed.proposalId);
    if (!proposal) throw new Error(`Premise proposal not found for task: ${parsed.proposalId}`);
    if (basis.state.decisions.some((item) => item.value.proposalId === proposal.id)) {
      throw new Error("Premise proposal already has a decision");
    }
    const premise = basis.state.premise.value;
    const challenges = basis.state.challenges.filter((item) => item.value.proposalId === proposal.id);
    const isValidator = premise.eligibleValidatorPrincipalIds.includes(basis.principal.id);
    const isAdjudicator = premise.adjudicatorPrincipalIds.includes(basis.principal.id);
    if (!isValidator && !isAdjudicator) throw new Error(`Principal is not eligible to decide premise: ${basis.principal.id}`);
    if (!premise.allowSelfValidation && proposal.value.proposedByPrincipalId === basis.principal.id) {
      throw new Error("Premise proposer cannot validate their own proposal");
    }
    if (challenges.length > 0 && parsed.outcome === "accepted" && !isAdjudicator) {
      throw new Error("A challenged premise proposal requires a named adjudicator");
    }
    const evidenceIds = [...new Set([
      ...proposal.value.evidenceIds,
      ...challenges.flatMap((challenge) => challenge.value.counterEvidenceIds),
    ])].sort();
    const value = TaskPremiseDecision.parse({
      contract: "tasq.task-premise-decision.v1", taskId, premiseId: basis.state.premise.id,
      proposalId: proposal.id, outcome: parsed.outcome,
      challengeIds: challenges.map((challenge) => challenge.id).sort(), evidenceIds,
      rationale: parsed.rationale, decidedByPrincipalId: basis.principal.id, decidedAt: basis.now,
    });
    return {
      resourceType: TASK_PREMISE_DECISION_URI, value, status: parsed.outcome,
      eventType: "premise_resolution_decided",
      invalidate: parsed.outcome === "accepted" && proposal.value.verdict === "refute"
        ? { proposalId: proposal.id, reason: parsed.rationale }
        : undefined,
    };
  });
}

type MutationBuild<T> = {
  resourceType: string;
  value: T;
  status: string;
  eventType: string;
  invalidate?: { proposalId: string; reason: string };
};

async function appendPremiseMutation<T>(
  db: TasqDb,
  taskId: string,
  operation: string,
  request: unknown,
  ctx: PremiseContext,
  build: (tx: TasqDbOrTx, basis: {
    tenantId: string; now: number; principal: Awaited<ReturnType<typeof callerPrincipal>>; state: TaskPremiseState;
  }) => Promise<MutationBuild<T>>,
): Promise<{ id: string; value: T; replayed: boolean }> {
  const tenantId = ctx.tenantId ?? LEGACY_DEFAULT_WORKSPACE_ID;
  const actor = ctx.actor ?? "system";
  const now = serviceNow(ctx, ctx.now);
  const identity = retry(ctx, tenantId, operation, { taskId, request }, now);
  const committed = await runInTransaction(db, async (tx) => {
    const prior = await findIdempotencyResult(tx, identity);
    if (prior) {
      const rows = await tx.select().from(externalRef).where(and(
        eq(externalRef.tenantId, tenantId), eq(externalRef.id, prior.resultId),
      )).limit(1);
      if (!rows[0]) throw new Error(`Idempotency record points at missing premise record ${prior.resultId}`);
      const ref = parseRef(rows[0]);
      return { result: { id: ref.id, value: ref.metadata as T, replayed: true }, events: [] as EventT[] };
    }
    const state = await getTaskPremiseState(tx, taskId, tenantId);
    if (!state) throw new Error(`Task has no motivating premise: ${taskId}`);
    const principal = await callerPrincipal(tx, tenantId, ctx, now);
    const built = await build(tx, { tenantId, now, principal, state });
    const ref = await insertTypedRef(tx, {
      tenantId, taskId, resourceType: built.resourceType, value: built.value,
      principalId: principal.id, now,
    });
    const events: EventT[] = [await recordEvent(tx, {
      tenantId, actor, principalId: principal.id, entityType: "task", entityId: taskId,
      eventType: built.eventType,
      payload: { after: { premiseRecordId: ref.id, premiseId: state.premise.id, status: built.status } },
    }, { defer: true, now })];
    if (built.invalidate) {
      const invalidation = TaskPremiseInvalidation.parse({
        contract: "tasq.task-premise-invalidation.v1", taskId, premiseId: state.premise.id,
        proposalId: built.invalidate.proposalId, decisionId: ref.id,
        invalidatedByPrincipalId: principal.id, invalidatedAt: now, reason: built.invalidate.reason,
      });
      const invalidationRef = await insertTypedRef(tx, {
        tenantId, taskId, resourceType: TASK_PREMISE_INVALIDATION_URI, value: invalidation,
        principalId: principal.id, now,
      });
      const releasedClaims = await tx.update(taskClaim).set({
        releasedAt: now, releaseReason: "premise_invalidated", updatedAt: now,
        revision: sql`${taskClaim.revision} + 1`,
      }).where(and(
        eq(taskClaim.tenantId, tenantId), eq(taskClaim.taskId, taskId), isNull(taskClaim.releasedAt),
      )).returning({ id: taskClaim.id });
      const cancelledAttempts = await tx.update(taskAttempt).set({
        status: "cancelled", statusMessage: "motivating premise invalidated", endedAt: now,
        updatedAt: now, revision: sql`${taskAttempt.revision} + 1`,
      }).where(and(
        eq(taskAttempt.tenantId, tenantId), eq(taskAttempt.taskId, taskId),
        or(eq(taskAttempt.status, "running"), eq(taskAttempt.status, "input_required")),
      )).returning({ id: taskAttempt.id });
      events.push(await recordEvent(tx, {
        tenantId, actor, principalId: principal.id, entityType: "task", entityId: taskId,
        eventType: "premise_invalidated",
        payload: { after: {
          invalidationId: invalidationRef.id, decisionId: ref.id,
          releasedClaimIds: releasedClaims.map((row) => row.id),
          cancelledAttemptIds: cancelledAttempts.map((row) => row.id),
        }, reason: built.invalidate.reason },
      }, { defer: true, now }));
    }
    await saveIdempotencyResult(tx, identity, {
      resultType: built.resourceType, resultId: ref.id, resultStatus: built.status,
      eventSequence: events[0]!.sequence,
    });
    return { result: { id: ref.id, value: built.value, replayed: false }, events };
  });
  committed.events.forEach(emitAfterCommit);
  return committed.result;
}

export async function assertTaskPremiseActionable(
  tx: TasqDbOrTx,
  taskId: string,
  tenantId: string,
): Promise<void> {
  const rows = await tx.select({ id: externalRef.id }).from(externalRef).where(and(
    eq(externalRef.tenantId, tenantId), eq(externalRef.recordType, "commitment"),
    eq(externalRef.recordId, taskId), eq(externalRef.resourceType, TASK_PREMISE_INVALIDATION_URI),
  )).limit(1);
  if (rows.length > 0) throw new Error(`Task premise is invalidated: ${taskId}`);
}

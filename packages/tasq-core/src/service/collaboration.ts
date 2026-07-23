/** Universal collaboration records: delegation, relations, outputs and refs. */

import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  Artifact as ArtifactZ,
  ArtifactInsert,
  Assignment as AssignmentZ,
  AssignmentInsert,
  CommitmentRelation as CommitmentRelationZ,
  CommitmentRelationInsert,
  CompletionRecord as CompletionRecordZ,
  ExternalRef as ExternalRefZ,
  ExternalRefInsert,
  artifact,
  assignment,
  commitmentRelation,
  completionRecord,
  externalRef,
  principal,
  task,
  taskAttempt,
  taskClaim,
  taskDependency,
  taskEvidence,
  uuidv7,
  type Artifact,
  type Assignment,
  type AssignmentStatus,
  type CommitmentRelation,
  type CompletionRecord,
  type ExternalRef,
  type Principal,
} from "@tasq-run/schema";
import type { TasqDb, TasqDbOrTx } from "../db.js";
import { runInTransaction } from "../db.js";
import { serviceNow } from "../util/clock.js";
import { parseRow } from "../util/row.js";
import type { ServiceContext } from "./context.js";
import { emitAfterCommit, recordEvent } from "./events.js";
import { ensureLocalPrincipal, getPrincipal } from "./principals.js";
import { getTask } from "./tasks.js";
import {
  findIdempotencyResult,
  prepareIdempotency,
  saveIdempotencyResult,
  type PreparedIdempotency,
} from "./idempotency.js";

export interface PrincipalContext extends ServiceContext {
  /** Authenticated surfaces map their subject to this stable principal. */
  principalId?: string;
}

function parseAssignment(row: typeof assignment.$inferSelect): Assignment {
  return AssignmentZ.parse(row);
}
function parseRelation(row: typeof commitmentRelation.$inferSelect): CommitmentRelation {
  return CommitmentRelationZ.parse(row);
}
function parseArtifact(row: typeof artifact.$inferSelect): Artifact {
  return ArtifactZ.parse(parseRow(row));
}
function parseExternalRef(row: typeof externalRef.$inferSelect): ExternalRef {
  return ExternalRefZ.parse(parseRow(row));
}
function parseCompletionRecord(row: typeof completionRecord.$inferSelect): CompletionRecord {
  return CompletionRecordZ.parse({
    ...row,
    evidenceIds: typeof row.evidenceIds === "string" ? JSON.parse(row.evidenceIds) : row.evidenceIds,
  });
}

async function contextPrincipal(
  tx: TasqDbOrTx,
  tenantId: string,
  ctx: PrincipalContext,
  now: number,
): Promise<Principal> {
  if (ctx.principalId) {
    const result = await getPrincipal(tx, ctx.principalId, tenantId);
    if (!result) throw new Error(`Principal not found in workspace: ${ctx.principalId}`);
    if (result.status !== "enabled") throw new Error(`Principal is disabled: ${result.id}`);
    return result;
  }
  return ensureLocalPrincipal(tx, tenantId, ctx.actor ?? "system", now);
}

function actorLabel(ctx: PrincipalContext, principal: Principal): string {
  return ctx.actor ?? principal.localAlias ?? principal.id;
}

async function requirePrincipal(
  tx: TasqDbOrTx,
  id: string,
  tenantId: string,
): Promise<Principal> {
  const result = await getPrincipal(tx, id, tenantId);
  if (!result) throw new Error(`Principal not found in workspace: ${id}`);
  return result;
}

async function requireTask(tx: TasqDbOrTx, id: string, tenantId: string) {
  const result = await getTask(tx, id, tenantId);
  if (!result || result.deletedAt != null) throw new Error(`Commitment not found: ${id}`);
  return result;
}

async function retryResult(
  tx: TasqDbOrTx,
  tenantId: string,
  ctx: PrincipalContext,
  operation: string,
  request: unknown,
  now: number,
  durable = false,
): Promise<{ id: string | null; identity: PreparedIdempotency | null }> {
  const identity = prepareIdempotency({ ...ctx, tenantId }, operation, request, {
    now,
    retentionClass: durable ? "durable" : "standard",
    legacyRequest: { operation, request },
  });
  const prior = await findIdempotencyResult(tx, identity);
  return { id: prior?.resultId ?? null, identity };
}

async function saveRetry(
  tx: TasqDbOrTx,
  identity: PreparedIdempotency | null,
  outcome: Parameters<typeof saveIdempotencyResult>[2],
): Promise<void> {
  await saveIdempotencyResult(tx, identity, outcome);
}

export async function proposeAssignment(
  db: TasqDb,
  input: unknown,
  ctx: PrincipalContext = {},
): Promise<Assignment> {
  const parsed = AssignmentInsert.parse(input);
  const tenantId = parsed.tenantId;
  const now = serviceNow(ctx, ctx.now);
  const { result, event } = await runInTransaction(db, async (tx) => {
    const retryRequest = { input: parsed, caller: ctx.principalId ?? ctx.actor ?? "system" };
    const retry = await retryResult(tx, tenantId, ctx, "assignment.propose", retryRequest, now);
    if (retry.id) {
      const prior = await getAssignment(tx, retry.id, tenantId);
      if (!prior) throw new Error(`Idempotency record points at missing assignment ${retry.id}`);
      return { result: prior, event: null };
    }
    await requireTask(tx, parsed.taskId, tenantId);
    const assigner = await contextPrincipal(tx, tenantId, ctx, now);
    if (parsed.assignerPrincipalId !== assigner.id) {
      throw new Error("assignerPrincipalId must match the calling principal");
    }
    const assignee = await requirePrincipal(tx, parsed.assigneePrincipalId, tenantId);
    if (assignee.status !== "enabled") throw new Error(`Assignee is disabled: ${assignee.id}`);
    const id = parsed.id ?? uuidv7(now);
    await tx.insert(assignment).values({
      id,
      tenantId,
      taskId: parsed.taskId,
      assignerPrincipalId: assigner.id,
      assigneePrincipalId: assignee.id,
      role: parsed.role,
      status: "proposed",
      instructionsRef: parsed.instructionsRef,
      acceptedAt: null,
      endedAt: null,
      revision: 1,
      createdAt: now,
      updatedAt: now,
    });
    const result = await getAssignment(tx, id, tenantId);
    if (!result) throw new Error(`Failed to read back assignment ${id}`);
    const event = await recordEvent(tx, {
      tenantId,
      actor: actorLabel(ctx, assigner),
      principalId: assigner.id,
      entityType: "task",
      entityId: parsed.taskId,
      eventType: "assignment_proposed",
      payload: { after: { assignmentId: id, assigneePrincipalId: assignee.id, role: parsed.role } },
    }, { defer: true, now });
    await saveRetry(tx, retry.identity, {
      resultType: "assignment",
      resultId: id,
      resultStatus: result.status,
      resultRevision: result.revision,
      eventSequence: event.sequence,
    });
    return { result, event };
  });
  if (event) emitAfterCommit(event);
  return result;
}

export async function getAssignment(
  db: TasqDbOrTx,
  id: string,
  tenantId = "gwendall",
): Promise<Assignment | null> {
  const rows = await db.select().from(assignment)
    .where(and(eq(assignment.id, id), eq(assignment.tenantId, tenantId))).limit(1);
  return rows[0] ? parseAssignment(rows[0]) : null;
}

export async function listAssignments(
  db: TasqDb,
  options: { tenantId?: string; taskId?: string; assigneePrincipalId?: string; status?: AssignmentStatus } = {},
): Promise<Assignment[]> {
  const filters = [eq(assignment.tenantId, options.tenantId ?? "gwendall")];
  if (options.taskId) filters.push(eq(assignment.taskId, options.taskId));
  if (options.assigneePrincipalId) filters.push(eq(assignment.assigneePrincipalId, options.assigneePrincipalId));
  if (options.status) filters.push(eq(assignment.status, options.status));
  return (await db.select().from(assignment).where(and(...filters)).orderBy(asc(assignment.createdAt)))
    .map(parseAssignment);
}

async function transitionAssignment(
  db: TasqDb,
  id: string,
  to: AssignmentStatus,
  options: PrincipalContext & { expectedRevision: number },
): Promise<Assignment> {
  const tenantId = options.tenantId ?? "gwendall";
  const now = serviceNow(options, options.now);
  const { result, event } = await runInTransaction(db, async (tx) => {
    const before = await getAssignment(tx, id, tenantId);
    if (!before) throw new Error(`Assignment not found: ${id}`);
    const caller = await contextPrincipal(tx, tenantId, options, now);
    const assigneeTransition = to === "accepted" || to === "rejected" || to === "released";
    if (assigneeTransition && caller.id !== before.assigneePrincipalId) {
      throw new Error(`Only the assignee may ${to} assignment ${id}`);
    }
    if (to === "revoked" && caller.id !== before.assignerPrincipalId) {
      throw new Error(`Only the assigner may revoke assignment ${id}`);
    }
    if (before.status === to) return { result: before, event: null };
    const allowed =
      (before.status === "proposed" && inArrayValue(to, ["accepted", "rejected", "revoked"])) ||
      (before.status === "accepted" && inArrayValue(to, ["released", "revoked"]));
    if (!allowed) throw new Error(`Invalid assignment transition: ${before.status} → ${to}`);
    const rows = await tx.update(assignment).set({
      status: to,
      acceptedAt: to === "accepted" ? now : before.acceptedAt,
      endedAt: inArrayValue(to, ["rejected", "revoked", "released"]) ? now : null,
      updatedAt: now,
      revision: sql`${assignment.revision} + 1`,
    }).where(and(
      eq(assignment.id, id),
      eq(assignment.tenantId, tenantId),
      eq(assignment.revision, options.expectedRevision),
    )).returning();
    if (!rows[0]) throw new Error(`Stale assignment revision: expected ${options.expectedRevision}`);
    const result = parseAssignment(rows[0]);
    const event = await recordEvent(tx, {
      tenantId,
      actor: actorLabel(options, caller),
      principalId: caller.id,
      entityType: "task",
      entityId: before.taskId,
      eventType: `assignment_${to}`,
      payload: { before: { assignmentId: id, status: before.status }, after: { assignmentId: id, status: to } },
    }, { defer: true, now });
    return { result, event };
  });
  if (event) emitAfterCommit(event);
  return result;
}

function inArrayValue<T>(value: T, values: readonly T[]): boolean {
  return values.includes(value);
}

export const acceptAssignment = (db: TasqDb, id: string, options: PrincipalContext & { expectedRevision: number }) =>
  transitionAssignment(db, id, "accepted", options);
export const rejectAssignment = (db: TasqDb, id: string, options: PrincipalContext & { expectedRevision: number }) =>
  transitionAssignment(db, id, "rejected", options);
export const revokeAssignment = (db: TasqDb, id: string, options: PrincipalContext & { expectedRevision: number }) =>
  transitionAssignment(db, id, "revoked", options);
export const releaseAssignment = (db: TasqDb, id: string, options: PrincipalContext & { expectedRevision: number }) =>
  transitionAssignment(db, id, "released", options);

export async function addCommitmentRelation(
  db: TasqDb,
  input: unknown,
  ctx: PrincipalContext = {},
): Promise<CommitmentRelation> {
  const parsed = CommitmentRelationInsert.parse(input);
  const tenantId = parsed.tenantId;
  const now = serviceNow(ctx, ctx.now);
  const { result, event } = await runInTransaction(db, async (tx) => {
    const retryRequest = { input: parsed, caller: ctx.principalId ?? ctx.actor ?? "system" };
    const retry = await retryResult(tx, tenantId, ctx, "relation.add", retryRequest, now, true);
    if (retry.id) {
      const prior = await getCommitmentRelation(tx, retry.id, tenantId);
      if (!prior) throw new Error(`Idempotency record points at missing relation ${retry.id}`);
      return { result: prior, event: null };
    }
    await Promise.all([
      requireTask(tx, parsed.fromTaskId, tenantId),
      requireTask(tx, parsed.toTaskId, tenantId),
    ]);
    const caller = await contextPrincipal(tx, tenantId, ctx, now);
    if (parsed.relationType === "depends_on") {
      await assertNoDependencyCycle(tx, tenantId, parsed.fromTaskId, parsed.toTaskId);
    }
    const id = parsed.id ?? uuidv7(now);
    await tx.insert(commitmentRelation).values({
      id,
      tenantId,
      fromTaskId: parsed.fromTaskId,
      relationType: parsed.relationType,
      toTaskId: parsed.toTaskId,
      revision: 1,
      createdByPrincipalId: caller.id,
      createdAt: now,
      endedByPrincipalId: null,
      endedAt: null,
    });
    if (parsed.relationType === "depends_on" || parsed.relationType === "relates_to" || parsed.relationType === "duplicates") {
      await tx.insert(taskDependency).values({
        id,
        tenantId,
        fromTaskId: parsed.fromTaskId,
        toTaskId: parsed.toTaskId,
        type: parsed.relationType === "depends_on" ? "blocks" : parsed.relationType,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      });
    }
    const result = await getCommitmentRelation(tx, id, tenantId);
    if (!result) throw new Error(`Failed to read back relation ${id}`);
    const event = await recordEvent(tx, {
      tenantId,
      actor: actorLabel(ctx, caller),
      principalId: caller.id,
      entityType: "task",
      entityId: parsed.fromTaskId,
      eventType: "relation_added",
      payload: { after: { relationId: id, relationType: parsed.relationType, toCommitmentId: parsed.toTaskId } },
    }, { defer: true, now });
    await saveRetry(tx, retry.identity, {
      resultType: "commitment_relation",
      resultId: id,
      resultStatus: "active",
      resultRevision: result.revision,
      eventSequence: event.sequence,
    });
    return { result, event };
  });
  if (event) emitAfterCommit(event);
  return result;
}

async function assertNoDependencyCycle(
  tx: TasqDbOrTx,
  tenantId: string,
  fromId: string,
  toId: string,
): Promise<void> {
  if (fromId === toId) throw new Error("A commitment cannot depend on itself");
  const seen = new Set<string>();
  let frontier = [toId];
  while (frontier.length > 0) {
    if (frontier.includes(fromId)) throw new Error("Relation would create a depends_on cycle");
    const next = await tx.select({ id: commitmentRelation.toTaskId }).from(commitmentRelation)
      .where(and(
        eq(commitmentRelation.tenantId, tenantId),
        eq(commitmentRelation.relationType, "depends_on"),
        isNull(commitmentRelation.endedAt),
        inArray(commitmentRelation.fromTaskId, frontier),
      ));
    frontier = next.map((row) => row.id).filter((id) => !seen.has(id));
    frontier.forEach((id) => seen.add(id));
  }
}

export async function getCommitmentRelation(
  db: TasqDbOrTx,
  id: string,
  tenantId = "gwendall",
): Promise<CommitmentRelation | null> {
  const rows = await db.select().from(commitmentRelation)
    .where(and(eq(commitmentRelation.id, id), eq(commitmentRelation.tenantId, tenantId))).limit(1);
  return rows[0] ? parseRelation(rows[0]) : null;
}

export async function listCommitmentRelations(
  db: TasqDb,
  options: { tenantId?: string; commitmentId?: string; activeOnly?: boolean } = {},
): Promise<CommitmentRelation[]> {
  const tenantId = options.tenantId ?? "gwendall";
  const rows = await db.select().from(commitmentRelation)
    .where(and(eq(commitmentRelation.tenantId, tenantId), ...(options.activeOnly ? [isNull(commitmentRelation.endedAt)] : [])))
    .orderBy(asc(commitmentRelation.createdAt));
  return rows.map(parseRelation).filter((relation) =>
    !options.commitmentId || relation.fromTaskId === options.commitmentId || relation.toTaskId === options.commitmentId);
}

export async function endCommitmentRelation(
  db: TasqDb,
  id: string,
  options: PrincipalContext & { expectedRevision: number },
): Promise<CommitmentRelation> {
  const tenantId = options.tenantId ?? "gwendall";
  const now = serviceNow(options, options.now);
  const { result, event } = await runInTransaction(db, async (tx) => {
    const before = await getCommitmentRelation(tx, id, tenantId);
    if (!before) throw new Error(`Relation not found: ${id}`);
    if (before.endedAt != null) return { result: before, event: null };
    const caller = await contextPrincipal(tx, tenantId, options, now);
    const rows = await tx.update(commitmentRelation).set({
      endedByPrincipalId: caller.id,
      endedAt: now,
      revision: sql`${commitmentRelation.revision} + 1`,
    }).where(and(
      eq(commitmentRelation.id, id),
      eq(commitmentRelation.tenantId, tenantId),
      eq(commitmentRelation.revision, options.expectedRevision),
      isNull(commitmentRelation.endedAt),
    )).returning();
    if (!rows[0]) throw new Error(`Stale relation revision: expected ${options.expectedRevision}`);
    await tx.update(taskDependency).set({ deletedAt: now, updatedAt: now })
      .where(and(
        eq(taskDependency.id, id),
        eq(taskDependency.tenantId, tenantId),
        isNull(taskDependency.deletedAt),
      ));
    const result = parseRelation(rows[0]);
    const event = await recordEvent(tx, {
      tenantId,
      actor: actorLabel(options, caller),
      principalId: caller.id,
      entityType: "task",
      entityId: before.fromTaskId,
      eventType: "relation_ended",
      payload: { before: { relationId: id, relationType: before.relationType, toCommitmentId: before.toTaskId } },
    }, { defer: true, now });
    return { result, event };
  });
  if (event) emitAfterCommit(event);
  return result;
}

export async function appendArtifact(
  db: TasqDb,
  input: unknown,
  ctx: PrincipalContext = {},
): Promise<Artifact> {
  const parsed = ArtifactInsert.parse(input);
  const tenantId = parsed.tenantId;
  const now = serviceNow(ctx, ctx.now);
  const { result, event } = await runInTransaction(db, async (tx) => {
    const retryRequest = { input: parsed, caller: ctx.principalId ?? ctx.actor ?? "system" };
    const retry = await retryResult(tx, tenantId, ctx, "artifact.append", retryRequest, now, true);
    if (retry.id) {
      const prior = await getArtifact(tx, retry.id, tenantId);
      if (!prior) throw new Error(`Idempotency record points at missing artifact ${retry.id}`);
      return { result: prior, event: null };
    }
    await requireTask(tx, parsed.taskId, tenantId);
    if (parsed.attemptId) {
      const rows = await tx.select().from(taskAttempt).where(and(
        eq(taskAttempt.id, parsed.attemptId),
        eq(taskAttempt.tenantId, tenantId),
        eq(taskAttempt.taskId, parsed.taskId),
      )).limit(1);
      if (!rows[0]) throw new Error(`Attempt does not belong to commitment ${parsed.taskId}`);
    }
    const caller = await contextPrincipal(tx, tenantId, ctx, now);
    const id = parsed.id ?? uuidv7(now);
    await tx.insert(artifact).values({
      id,
      tenantId,
      taskId: parsed.taskId,
      attemptId: parsed.attemptId,
      typeUri: parsed.typeUri,
      schemaVersion: parsed.schemaVersion,
      name: parsed.name,
      mediaType: parsed.mediaType,
      uri: parsed.uri,
      digest: parsed.digest!,
      inlineDataRef: parsed.inlineDataRef,
      createdByPrincipalId: caller.id,
      metadata: JSON.stringify(parsed.metadata),
      createdAt: now,
    });
    const result = await getArtifact(tx, id, tenantId);
    if (!result) throw new Error(`Failed to read back artifact ${id}`);
    const event = await recordEvent(tx, {
      tenantId,
      actor: actorLabel(ctx, caller),
      principalId: caller.id,
      entityType: "task",
      entityId: parsed.taskId,
      eventType: "artifact_appended",
      payload: { after: { artifactId: id, attemptId: parsed.attemptId, typeUri: parsed.typeUri, digest: parsed.digest } },
    }, { defer: true, now });
    await saveRetry(tx, retry.identity, {
      resultType: "artifact",
      resultId: id,
      resultStatus: "recorded",
      eventSequence: event.sequence,
    });
    return { result, event };
  });
  if (event) emitAfterCommit(event);
  return result;
}

export async function getArtifact(db: TasqDbOrTx, id: string, tenantId = "gwendall"): Promise<Artifact | null> {
  const rows = await db.select().from(artifact)
    .where(and(eq(artifact.id, id), eq(artifact.tenantId, tenantId))).limit(1);
  return rows[0] ? parseArtifact(rows[0]) : null;
}

export async function listArtifacts(
  db: TasqDb,
  options: { tenantId?: string; taskId?: string; attemptId?: string } = {},
): Promise<Artifact[]> {
  const filters = [eq(artifact.tenantId, options.tenantId ?? "gwendall")];
  if (options.taskId) filters.push(eq(artifact.taskId, options.taskId));
  if (options.attemptId) filters.push(eq(artifact.attemptId, options.attemptId));
  return (await db.select().from(artifact).where(and(...filters)).orderBy(asc(artifact.createdAt)))
    .map(parseArtifact);
}

export async function appendExternalRef(
  db: TasqDb,
  input: unknown,
  ctx: PrincipalContext = {},
): Promise<ExternalRef> {
  const parsed = ExternalRefInsert.parse(input);
  const tenantId = parsed.tenantId;
  const now = serviceNow(ctx, ctx.now);
  const { result, event } = await runInTransaction(db, async (tx) => {
    const retryRequest = { input: parsed, caller: ctx.principalId ?? ctx.actor ?? "system" };
    const retry = await retryResult(tx, tenantId, ctx, "external-ref.append", retryRequest, now, true);
    if (retry.id) {
      const prior = await getExternalRef(tx, retry.id, tenantId);
      if (!prior) throw new Error(`Idempotency record points at missing external ref ${retry.id}`);
      return { result: prior, event: null };
    }
    const taskId = await assertRecordExists(tx, tenantId, parsed.recordType, parsed.recordId);
    const caller = await contextPrincipal(tx, tenantId, ctx, now);
    const id = parsed.id ?? uuidv7(now);
    await tx.insert(externalRef).values({
      id,
      tenantId,
      recordType: parsed.recordType,
      recordId: parsed.recordId,
      system: parsed.system,
      resourceType: parsed.resourceType,
      externalId: parsed.externalId,
      url: parsed.url,
      version: parsed.version,
      digest: parsed.digest,
      metadata: JSON.stringify(parsed.metadata),
      createdByPrincipalId: caller.id,
      createdAt: now,
    });
    const result = await getExternalRef(tx, id, tenantId);
    if (!result) throw new Error(`Failed to read back external ref ${id}`);
    const event = taskId ? await recordEvent(tx, {
      tenantId,
      actor: actorLabel(ctx, caller),
      principalId: caller.id,
      entityType: "task",
      entityId: taskId,
      eventType: "external_ref_appended",
      payload: { after: { externalRefId: id, recordType: parsed.recordType, recordId: parsed.recordId, system: parsed.system } },
    }, { defer: true, now }) : null;
    await saveRetry(tx, retry.identity, {
      resultType: "external_ref",
      resultId: id,
      resultStatus: "recorded",
      eventSequence: event?.sequence ?? null,
    });
    return { result, event };
  });
  if (event) emitAfterCommit(event);
  return result;
}

async function assertRecordExists(tx: TasqDbOrTx, tenantId: string, recordType: string, id: string): Promise<string | null> {
  const tables = {
    principal: { table: principal, id: principal.id, tenant: principal.tenantId, taskId: null },
    commitment: { table: task, id: task.id, tenant: task.tenantId, taskId: task.id },
    assignment: { table: assignment, id: assignment.id, tenant: assignment.tenantId, taskId: assignment.taskId },
    relation: { table: commitmentRelation, id: commitmentRelation.id, tenant: commitmentRelation.tenantId, taskId: commitmentRelation.fromTaskId },
    claim: { table: taskClaim, id: taskClaim.id, tenant: taskClaim.tenantId, taskId: taskClaim.taskId },
    attempt: { table: taskAttempt, id: taskAttempt.id, tenant: taskAttempt.tenantId, taskId: taskAttempt.taskId },
    artifact: { table: artifact, id: artifact.id, tenant: artifact.tenantId, taskId: artifact.taskId },
    evidence: { table: taskEvidence, id: taskEvidence.id, tenant: taskEvidence.tenantId, taskId: taskEvidence.taskId },
    completion: { table: completionRecord, id: completionRecord.id, tenant: completionRecord.tenantId, taskId: completionRecord.taskId },
  };
  const target = tables[recordType as keyof typeof tables] as typeof tables[keyof typeof tables] | undefined;
  if (!target) throw new Error(`Unsupported external-ref recordType: ${recordType}`);
  const selectedTaskId = target.taskId ?? sql<string | null>`null`;
  const rows = await tx.select({ id: target.id, taskId: selectedTaskId }).from(target.table)
    .where(and(eq(target.id, id), eq(target.tenant, tenantId))).limit(1);
  if (!rows[0]) throw new Error(`${recordType} record not found in workspace: ${id}`);
  return rows[0].taskId;
}

export async function getExternalRef(db: TasqDbOrTx, id: string, tenantId = "gwendall"): Promise<ExternalRef | null> {
  const rows = await db.select().from(externalRef)
    .where(and(eq(externalRef.id, id), eq(externalRef.tenantId, tenantId))).limit(1);
  return rows[0] ? parseExternalRef(rows[0]) : null;
}

export async function listExternalRefs(
  db: TasqDb,
  options: { tenantId?: string; recordType?: string; recordId?: string } = {},
): Promise<ExternalRef[]> {
  const filters = [eq(externalRef.tenantId, options.tenantId ?? "gwendall")];
  if (options.recordType) filters.push(eq(externalRef.recordType, options.recordType));
  if (options.recordId) filters.push(eq(externalRef.recordId, options.recordId));
  return (await db.select().from(externalRef).where(and(...filters)).orderBy(asc(externalRef.createdAt)))
    .map(parseExternalRef);
}

export async function getCompletionRecord(
  db: TasqDbOrTx,
  id: string,
  tenantId = "gwendall",
): Promise<CompletionRecord | null> {
  const rows = await db.select().from(completionRecord)
    .where(and(eq(completionRecord.id, id), eq(completionRecord.tenantId, tenantId))).limit(1);
  return rows[0] ? parseCompletionRecord(rows[0]) : null;
}

export async function listCompletionRecords(
  db: TasqDb,
  taskId: string,
  tenantId = "gwendall",
): Promise<CompletionRecord[]> {
  return (await db.select().from(completionRecord).where(and(
    eq(completionRecord.tenantId, tenantId),
    eq(completionRecord.taskId, taskId),
  )).orderBy(asc(completionRecord.resultingRevision))).map(parseCompletionRecord);
}

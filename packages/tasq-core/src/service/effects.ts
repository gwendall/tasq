/** K2 effect proposal, immutable approval and pre-dispatch lifecycle services. */

import { and, asc, eq, sql } from "drizzle-orm";
import {
  ApprovalVerificationLevel,
  Effect as EffectZ,
  EffectDispatchPermit as EffectDispatchPermitZ,
  EffectReceipt as EffectReceiptZ,
  EffectReceiptCoverage as EffectReceiptCoverageZ,
  EffectReceiptInput,
  EffectJsonObject as EffectJsonObjectZ,
  EFFECT_RECEIPT_COVERAGE,
  EffectApproval as EffectApprovalZ,
  EffectApprovalDecision,
  EffectProposal,
  canonicalizeEffectJson,
  deriveEffectDispatchKey,
  effect,
  effectApproval,
  effectReceipt,
  extensionType,
  prepareEffectRequest,
  prepareEffectReceiptReport,
  principal,
  task,
  taskAttempt,
  taskClaim,
  taskEvidence,
  uuidv7,
  type ApprovalDecision,
  type Effect,
  type EffectApproval,
  type EffectDispatchPermit,
  type EffectReceipt,
  type EffectJsonObject,
  type EffectStatus,
  type Principal,
} from "@tasq-run/schema";
import {
  assertEffectAuthority,
  canonicalEffectPermitPayload,
  type EffectConnectorPolicy,
  type EffectPermitIssuer,
  type EffectReceiptVerifier,
} from "@tasq-run/extension-sdk";
import type { TasqDb, TasqDbOrTx } from "../db.js";
import { runInTransaction } from "../db.js";
import { serviceNow } from "../util/clock.js";
import type { PrincipalContext } from "./collaboration.js";
import { emitAfterCommit, recordEvent } from "./events.js";
import { ensureLocalPrincipal, getPrincipal } from "./principals.js";
import {
  findIdempotencyResult,
  prepareIdempotency,
  saveIdempotencyResult,
  type PreparedIdempotency,
} from "./idempotency.js";

export interface EffectAuthorityContext extends PrincipalContext {
  authorityVerification?: {
    level: "authenticated_context" | "cryptographic";
    method: string;
    details?: EffectJsonObject;
  };
}

function actorLabel(ctx: PrincipalContext, principalValue: Principal): string {
  return ctx.actor ?? principalValue.localAlias ?? principalValue.id;
}

async function contextPrincipal(
  tx: TasqDbOrTx,
  tenantId: string,
  ctx: PrincipalContext,
  now: number,
): Promise<Principal> {
  if (ctx.principalId) {
    const value = await getPrincipal(tx, ctx.principalId, tenantId);
    if (!value) throw new Error(`Principal not found in workspace: ${ctx.principalId}`);
    if (value.status !== "enabled") throw new Error(`Principal is disabled: ${value.id}`);
    return value;
  }
  return ensureLocalPrincipal(tx, tenantId, ctx.actor ?? "system", now);
}

function parseEffect(row: typeof effect.$inferSelect): Effect {
  let request: unknown;
  try {
    request = JSON.parse(row.canonicalRequest);
  } catch {
    throw new Error(`Effect ${row.id} contains invalid canonical request JSON`);
  }
  const prepared = prepareEffectRequest(request);
  if (prepared.canonicalRequest !== row.canonicalRequest || prepared.requestDigest !== row.requestDigest) {
    throw new Error(`Effect ${row.id} request integrity mismatch`);
  }
  if (deriveEffectDispatchKey(row.id, prepared) !== row.dispatchIdempotencyKey) {
    throw new Error(`Effect ${row.id} dispatch identity mismatch`);
  }
  return EffectZ.parse({ ...row, request: prepared.request });
}

function parseApproval(row: typeof effectApproval.$inferSelect): EffectApproval {
  const parseCanonicalObject = (name: string, value: string): EffectJsonObject => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new Error(`Effect approval ${row.id} contains invalid ${name} JSON`);
    }
    const canonical = canonicalizeEffectJson(parsed);
    if (canonical !== value || parsed === null || Array.isArray(parsed) || typeof parsed !== "object") {
      throw new Error(`Effect approval ${row.id} contains non-canonical ${name}`);
    }
    return parsed as EffectJsonObject;
  };
  return EffectApprovalZ.parse({
    ...row,
    scope: parseCanonicalObject("scope", row.scope),
    limits: parseCanonicalObject("limits", row.limits),
    verification: parseCanonicalObject("verification", row.verification),
  });
}

async function retryResult(
  tx: TasqDbOrTx,
  tenantId: string,
  ctx: PrincipalContext,
  operation: string,
  request: unknown,
  now: number,
): Promise<{
  id: string | null;
  revision: number | null;
  identity: PreparedIdempotency | null;
}> {
  const identity = prepareIdempotency({ ...ctx, tenantId }, operation, request, {
    now,
    retentionClass: "durable",
    legacyRequest: { operation, request },
  });
  const prior = await findIdempotencyResult(tx, identity);
  return { id: prior?.resultId ?? null, revision: prior?.resultRevision ?? null, identity };
}

async function saveRetry(
  tx: TasqDbOrTx,
  identity: PreparedIdempotency | null,
  outcome: Parameters<typeof saveIdempotencyResult>[2],
): Promise<void> {
  await saveIdempotencyResult(tx, identity, outcome);
}

async function requireTaskAndAttempt(
  tx: TasqDbOrTx,
  tenantId: string,
  taskId: string,
  attemptId: string | null,
): Promise<void> {
  const tasks = await tx.select({ id: task.id }).from(task)
    .where(and(eq(task.id, taskId), eq(task.tenantId, tenantId), sql`${task.deletedAt} IS NULL`)).limit(1);
  if (!tasks[0]) throw new Error(`Commitment not found: ${taskId}`);
  if (attemptId == null) return;
  const attempts = await tx.select({ id: taskAttempt.id }).from(taskAttempt).where(and(
    eq(taskAttempt.id, attemptId),
    eq(taskAttempt.tenantId, tenantId),
    eq(taskAttempt.taskId, taskId),
  )).limit(1);
  if (!attempts[0]) throw new Error(`Attempt does not belong to commitment: ${attemptId}`);
}

async function requireRegisteredEffectType(
  tx: TasqDbOrTx,
  tenantId: string,
  typeUri: string,
  schemaVersion: number,
): Promise<void> {
  const rows = await tx.select({ id: extensionType.id }).from(extensionType).where(and(
    eq(extensionType.tenantId, tenantId),
    eq(extensionType.recordKind, "effect"),
    eq(extensionType.typeUri, typeUri),
    eq(extensionType.schemaVersion, schemaVersion),
  )).limit(1);
  if (!rows[0]) throw new Error(`Unsupported effect type: ${typeUri}@${schemaVersion}`);
}

export async function proposeEffect(
  db: TasqDb,
  input: unknown,
  ctx: PrincipalContext = {},
): Promise<Effect> {
  // Preserve the input before Zod can erase a meaningful unsafe value.
  canonicalizeEffectJson(input);
  const parsed = EffectProposal.parse(input);
  const tenantId = parsed.tenantId;
  if (parsed.request.workspaceId !== tenantId) {
    throw new Error("Effect request workspaceId must match tenantId");
  }
  const prepared = prepareEffectRequest(parsed.request);
  const now = serviceNow(ctx, ctx.now);
  const { result, event: committedEvent } = await runInTransaction(db, async (tx) => {
    const retryRequest = {
      taskId: parsed.taskId,
      attemptId: parsed.attemptId,
      requestDigest: prepared.requestDigest,
      supersedesEffectId: parsed.supersedesEffectId,
      compensationOfEffectId: parsed.compensationOfEffectId,
    };
    const retry = await retryResult(tx, tenantId, ctx, "effect.propose", retryRequest, now);
    if (retry.id) {
      const prior = await getEffect(tx, retry.id, tenantId);
      if (!prior) throw new Error(`Idempotency record points at missing effect ${retry.id}`);
      return { result: prior, event: null };
    }
    await requireTaskAndAttempt(tx, tenantId, parsed.taskId, parsed.attemptId);
    await requireRegisteredEffectType(
      tx,
      tenantId,
      prepared.request.effectTypeUri,
      prepared.request.effectSchemaVersion,
    );
    const caller = await contextPrincipal(tx, tenantId, ctx, now);
    if (parsed.supersedesEffectId) {
      const prior = await getEffect(tx, parsed.supersedesEffectId, tenantId);
      if (!prior || prior.taskId !== parsed.taskId || prior.status !== "cancelled") {
        throw new Error("A correction must supersede a cancelled effect on the same commitment");
      }
    }
    if (parsed.compensationOfEffectId) {
      const original = await getEffect(tx, parsed.compensationOfEffectId, tenantId);
      if (!original || original.status !== "committed") {
        throw new Error("A compensation must reference a committed effect");
      }
    }
    const id = parsed.id ?? uuidv7(now);
    const dispatchIdempotencyKey = deriveEffectDispatchKey(id, prepared);
    await tx.insert(effect).values({
      id,
      tenantId,
      taskId: parsed.taskId,
      attemptId: parsed.attemptId,
      canonicalRequest: prepared.canonicalRequest,
      requestDigest: prepared.requestDigest,
      requestProtocol: prepared.request.protocol,
      canonicalization: prepared.request.canonicalization,
      digestAlgorithm: prepared.request.digestAlgorithm,
      effectTypeUri: prepared.request.effectTypeUri,
      effectSchemaVersion: prepared.request.effectSchemaVersion,
      connectorOperationUri: prepared.request.connector.operationUri,
      connectorOperationVersion: prepared.request.connector.operationVersion,
      connectorContractDigest: prepared.request.connector.contractDigest,
      connectorInstanceRef: prepared.request.connector.instanceRef,
      connectorBindingDigest: prepared.request.connector.bindingDigest,
      dispatchIdempotencyKey,
      status: "proposed",
      authorizedByApprovalId: null,
      claimId: null,
      fence: null,
      supersedesEffectId: parsed.supersedesEffectId,
      compensationOfEffectId: parsed.compensationOfEffectId,
      createdByPrincipalId: caller.id,
      revision: 1,
      authorizedAt: null,
      executionStartedAt: null,
      indeterminateAt: null,
      resolvedAt: null,
      cancelledAt: null,
      cancelReason: null,
      createdAt: now,
      updatedAt: now,
    });
    const result = await getEffect(tx, id, tenantId);
    if (!result) throw new Error(`Failed to read back effect ${id}`);
    const event = await recordEvent(tx, {
      tenantId,
      actor: actorLabel(ctx, caller),
      principalId: caller.id,
      entityType: "task",
      entityId: parsed.taskId,
      eventType: "effect_proposed",
      payload: {
        after: {
          effectId: id,
          requestDigest: prepared.requestDigest,
          effectTypeUri: prepared.request.effectTypeUri,
        },
      },
    }, { defer: true, now });
    await saveRetry(tx, retry.identity, {
      resultType: "effect",
      resultId: id,
      resultStatus: result.status,
      resultRevision: result.revision,
      eventSequence: event.sequence,
    });
    return { result, event };
  });
  if (committedEvent) emitAfterCommit(committedEvent);
  return result;
}

export async function getEffect(
  db: TasqDbOrTx,
  id: string,
  tenantId = "gwendall",
): Promise<Effect | null> {
  const rows = await db.select().from(effect)
    .where(and(eq(effect.id, id), eq(effect.tenantId, tenantId))).limit(1);
  return rows[0] ? parseEffect(rows[0]) : null;
}

export async function listEffects(
  db: TasqDb,
  options: { tenantId?: string; taskId?: string; status?: EffectStatus } = {},
): Promise<Effect[]> {
  const filters = [eq(effect.tenantId, options.tenantId ?? "gwendall")];
  if (options.taskId) filters.push(eq(effect.taskId, options.taskId));
  if (options.status) filters.push(eq(effect.status, options.status));
  return (await db.select().from(effect).where(and(...filters)).orderBy(asc(effect.createdAt)))
    .map(parseEffect);
}

export async function getEffectApproval(
  db: TasqDbOrTx,
  id: string,
  tenantId = "gwendall",
): Promise<EffectApproval | null> {
  const rows = await db.select().from(effectApproval).where(and(
    eq(effectApproval.id, id),
    eq(effectApproval.tenantId, tenantId),
  )).limit(1);
  return rows[0] ? parseApproval(rows[0]) : null;
}

export async function listEffectApprovals(
  db: TasqDbOrTx,
  options: { tenantId?: string; effectId?: string; decision?: ApprovalDecision } = {},
): Promise<EffectApproval[]> {
  const filters = [eq(effectApproval.tenantId, options.tenantId ?? "gwendall")];
  if (options.effectId) filters.push(eq(effectApproval.effectId, options.effectId));
  if (options.decision) filters.push(eq(effectApproval.decision, options.decision));
  return (await db.select().from(effectApproval).where(and(...filters)).orderBy(asc(effectApproval.decidedAt)))
    .map(parseApproval);
}

export async function getEffectiveEffectApproval(
  db: TasqDbOrTx,
  effectId: string,
  tenantId = "gwendall",
): Promise<EffectApproval | null> {
  const approvals = await listEffectApprovals(db, { tenantId, effectId });
  if (approvals.length === 0) return null;
  const superseded = new Set(approvals.map((value) => value.supersedesApprovalId).filter(Boolean));
  const leaves = approvals.filter((value) => !superseded.has(value.id));
  if (leaves.length !== 1) throw new Error(`Effect ${effectId} has a branched approval history`);
  return leaves[0] ?? null;
}

function verificationFromContext(ctx: EffectAuthorityContext): {
  level: "self_asserted" | "authenticated_context" | "cryptographic";
  method: string;
  details: EffectJsonObject;
} {
  const supplied = ctx.authorityVerification;
  if (!supplied) {
    return { level: "self_asserted", method: "local-actor-alias", details: {} };
  }
  ApprovalVerificationLevel.parse(supplied.level);
  if (!supplied.method.trim()) throw new Error("authority verification method must not be empty");
  canonicalizeEffectJson(supplied.details ?? {});
  return { level: supplied.level, method: supplied.method, details: supplied.details ?? {} };
}

export async function recordEffectApproval(
  db: TasqDb,
  input: unknown,
  ctx: EffectAuthorityContext = {},
): Promise<EffectApproval> {
  canonicalizeEffectJson(input);
  const parsed = EffectApprovalDecision.parse(input);
  const tenantId = parsed.tenantId;
  const now = serviceNow(ctx, ctx.now);
  if (parsed.expiresAt != null && parsed.expiresAt <= now) {
    throw new Error("Approval expiry must be in the future at decision time");
  }
  const verification = verificationFromContext(ctx);
  const scope = canonicalizeEffectJson(parsed.scope);
  const limits = canonicalizeEffectJson(parsed.limits);
  const verificationJson = canonicalizeEffectJson(verification.details);
  const { result, events } = await runInTransaction(db, async (tx) => {
    const target = await getEffect(tx, parsed.effectId, tenantId);
    if (!target) throw new Error(`Effect not found: ${parsed.effectId}`);
    const caller = await contextPrincipal(tx, tenantId, ctx, now);
    const retryRequest = {
      input: parsed,
      requestDigest: target.requestDigest,
      approverPrincipalId: caller.id,
      verification,
    };
    const retry = await retryResult(
      tx,
      tenantId,
      ctx,
      "effect.approval.record",
      retryRequest,
      now,
    );
    if (retry.id) {
      const prior = await getEffectApproval(tx, retry.id, tenantId);
      if (!prior) throw new Error(`Idempotency record points at missing approval ${retry.id}`);
      return { result: prior, events: [] };
    }
    const current = await getEffectiveEffectApproval(tx, target.id, tenantId);
    if (!current && parsed.supersedesApprovalId != null) {
      throw new Error("The first approval decision cannot supersede another record");
    }
    if (current && parsed.supersedesApprovalId !== current.id) {
      throw new Error(`Approval decision must supersede current leaf ${current.id}`);
    }
    if (parsed.decision === "revoked" && current?.decision !== "approved") {
      throw new Error("Revocation must supersede an approved decision");
    }
    const id = parsed.id ?? uuidv7(now);
    await tx.insert(effectApproval).values({
      id,
      tenantId,
      effectId: target.id,
      requestDigest: target.requestDigest,
      approverPrincipalId: caller.id,
      decision: parsed.decision,
      scope,
      limits,
      validFrom: parsed.validFrom,
      expiresAt: parsed.expiresAt,
      verificationLevel: verification.level,
      verificationMethod: verification.method,
      verification: verificationJson,
      supersedesApprovalId: parsed.supersedesApprovalId,
      decidedAt: now,
    });
    const events = [];
    events.push(await recordEvent(tx, {
      tenantId,
      actor: actorLabel(ctx, caller),
      principalId: caller.id,
      entityType: "task",
      entityId: target.taskId,
      eventType: "effect_approval_recorded",
      payload: {
        after: {
          effectId: target.id,
          approvalId: id,
          requestDigest: target.requestDigest,
          decision: parsed.decision,
          supersedesApprovalId: parsed.supersedesApprovalId,
        },
      },
    }, { defer: true, now }));
    if (target.status === "authorized" && target.authorizedByApprovalId === current?.id) {
      const rows = await tx.update(effect).set({
        status: "proposed",
        authorizedByApprovalId: null,
        authorizedAt: null,
        updatedAt: now,
        revision: sql`${effect.revision} + 1`,
      }).where(and(
        eq(effect.id, target.id),
        eq(effect.tenantId, tenantId),
        eq(effect.revision, target.revision),
      )).returning();
      if (!rows[0]) throw new Error(`Stale effect revision: expected ${target.revision}`);
      events.push(await recordEvent(tx, {
        tenantId,
        actor: actorLabel(ctx, caller),
        principalId: caller.id,
        entityType: "task",
        entityId: target.taskId,
        eventType: "effect_authority_withdrawn",
        payload: { before: { effectId: target.id, approvalId: current.id }, after: { status: "proposed" } },
      }, { defer: true, now }));
    }
    await saveRetry(tx, retry.identity, {
      resultType: "effect_approval",
      resultId: id,
      resultStatus: parsed.decision,
      eventSequence: events[0]?.sequence ?? null,
    });
    const result = await getEffectApproval(tx, id, tenantId);
    if (!result) throw new Error(`Failed to read back effect approval ${id}`);
    return { result, events };
  });
  for (const event of events) emitAfterCommit(event);
  return result;
}

export async function authorizeEffect(
  db: TasqDb,
  effectId: string,
  approvalId: string,
  options: PrincipalContext & { expectedRevision: number },
): Promise<Effect> {
  const tenantId = options.tenantId ?? "gwendall";
  const now = serviceNow(options, options.now);
  const { result, event: committedEvent } = await runInTransaction(db, async (tx) => {
    const retry = await retryResult(tx, tenantId, options, "effect.authorize", {
      effectId,
      approvalId,
      expectedRevision: options.expectedRevision,
    }, now);
    if (retry.id) {
      const prior = await getEffect(tx, retry.id, tenantId);
      if (!prior) throw new Error(`Idempotency record points at missing effect ${retry.id}`);
      return { result: prior, event: null };
    }
    const before = await getEffect(tx, effectId, tenantId);
    if (!before) throw new Error(`Effect not found: ${effectId}`);
    if (before.status !== "proposed") {
      throw new Error(`Effect must be proposed before authorization: ${before.status}`);
    }
    const approval = await getEffectiveEffectApproval(tx, effectId, tenantId);
    if (!approval || approval.id !== approvalId || approval.decision !== "approved") {
      throw new Error("Effect authorization requires the current approved decision");
    }
    if (approval.requestDigest !== before.requestDigest) {
      throw new Error("Approval request digest does not match the effect");
    }
    if (approval.validFrom != null && now < approval.validFrom) {
      throw new Error("Approval is not valid yet");
    }
    if (approval.expiresAt != null && now >= approval.expiresAt) {
      throw new Error("Approval has expired");
    }
    const caller = await contextPrincipal(tx, tenantId, options, now);
    const rows = await tx.update(effect).set({
      status: "authorized",
      authorizedByApprovalId: approval.id,
      authorizedAt: now,
      updatedAt: now,
      revision: sql`${effect.revision} + 1`,
    }).where(and(
      eq(effect.id, effectId),
      eq(effect.tenantId, tenantId),
      eq(effect.revision, options.expectedRevision),
    )).returning();
    if (!rows[0]) throw new Error(`Stale effect revision: expected ${options.expectedRevision}`);
    const result = parseEffect(rows[0]);
    const event = await recordEvent(tx, {
      tenantId,
      actor: actorLabel(options, caller),
      principalId: caller.id,
      entityType: "task",
      entityId: before.taskId,
      eventType: "effect_authorized",
      payload: { before: { effectId, status: before.status }, after: { effectId, status: "authorized", approvalId } },
    }, { defer: true, now });
    await saveRetry(tx, retry.identity, {
      resultType: "effect",
      resultId: result.id,
      resultStatus: result.status,
      resultRevision: result.revision,
      eventSequence: event.sequence,
    });
    return { result, event };
  });
  if (committedEvent) emitAfterCommit(committedEvent);
  return result;
}

export interface BeginEffectExecutionOptions extends PrincipalContext {
  expectedRevision: number;
  claimId: string;
  fence: number;
  policy: EffectConnectorPolicy;
  permitIssuer: EffectPermitIssuer;
}

export interface BegunEffectExecution {
  effect: Effect;
  permit: EffectDispatchPermit;
}

function issueEffectDispatchPermit(
  effectValue: Effect,
  approval: EffectApproval,
  attemptId: string,
  claim: { id: string; fence: number; principalId: string; expiresAt: number },
  effectRevision: number,
  issuedAt: number,
  issuer: EffectPermitIssuer,
): EffectDispatchPermit {
  if (approval.decision !== "approved") {
    throw new Error("An effect dispatch permit requires an approved decision");
  }
  const payload = {
    contractVersion: "tasq.effect-dispatch-permit.v1",
    issuedAt,
    workspaceId: effectValue.tenantId,
    effectId: effectValue.id,
    effectRevision,
    effectStatus: "executing",
    taskId: effectValue.taskId,
    attemptId,
    request: effectValue.request,
    canonicalRequest: effectValue.canonicalRequest,
    requestDigest: effectValue.requestDigest,
    dispatchIdempotencyKey: effectValue.dispatchIdempotencyKey,
    approval: {
      id: approval.id,
      requestDigest: approval.requestDigest,
      approverPrincipalId: approval.approverPrincipalId,
      decision: "approved" as const,
      scope: approval.scope,
      limits: approval.limits,
      validFrom: approval.validFrom,
      expiresAt: approval.expiresAt,
      verificationLevel: approval.verificationLevel,
      verificationMethod: approval.verificationMethod,
      verification: approval.verification,
      decidedAt: approval.decidedAt,
    },
    claim: {
      id: claim.id,
      fence: claim.fence,
      principalId: claim.principalId,
      expiresAt: claim.expiresAt,
    },
    executionStartedAt: issuedAt,
  } as const;
  return EffectDispatchPermitZ.parse({
    payload,
    authentication: {
      algorithm: issuer.algorithm,
      keyId: issuer.keyId,
      signature: issuer.sign(canonicalEffectPermitPayload(payload)),
    },
  });
}

/** Atomic point of no return before the connector performs external I/O. */
export async function beginEffectExecution(
  db: TasqDb,
  effectId: string,
  options: BeginEffectExecutionOptions,
): Promise<BegunEffectExecution> {
  const tenantId = options.tenantId ?? "gwendall";
  const now = serviceNow(options, options.now);
  const { result, event: committedEvent } = await runInTransaction(db, async (tx) => {
    const retry = await retryResult(tx, tenantId, options, "effect.execution.begin", {
      effectId,
      expectedRevision: options.expectedRevision,
      claimId: options.claimId,
      fence: options.fence,
      policy: {
        effectTypeUri: options.policy.effectTypeUri,
        effectSchemaVersion: options.policy.effectSchemaVersion,
        operationUri: options.policy.operationUri,
        operationVersion: options.policy.operationVersion,
        contractDigest: options.policy.contractDigest,
        instanceRef: options.policy.instanceRef,
        bindingDigest: options.policy.bindingDigest,
      },
      permitIssuer: {
        algorithm: options.permitIssuer.algorithm,
        keyId: options.permitIssuer.keyId,
      },
    }, now);
    if (retry.id) {
      const prior = await getEffect(tx, retry.id, tenantId);
      if (!prior) throw new Error(`Idempotency record points at missing effect ${retry.id}`);
      if (prior.status !== "executing" && prior.status !== "indeterminate") {
        throw new Error(
          `Effect dispatch ${prior.id} is already resolved (${prior.status}); inspect its receipt instead of redispatching`,
        );
      }
      if (prior.executionStartedAt == null || prior.attemptId == null ||
        prior.authorizedByApprovalId == null || prior.claimId == null || prior.fence == null ||
        retry.revision == null) {
        throw new Error(`Idempotent execution result ${prior.id} has an incomplete dispatch binding`);
      }
      const approval = await getEffectApproval(tx, prior.authorizedByApprovalId, tenantId);
      if (!approval || approval.decision !== "approved") {
        throw new Error(`Effect dispatch approval is missing: ${prior.authorizedByApprovalId}`);
      }
      const claimRows = await tx.select().from(taskClaim).where(and(
        eq(taskClaim.id, prior.claimId),
        eq(taskClaim.tenantId, tenantId),
      )).limit(1);
      const claim = claimRows[0];
      if (!claim || claim.fence !== prior.fence || !claim.principalId) {
        throw new Error(`Effect dispatch claim is missing: ${prior.claimId}`);
      }
      return {
        result: {
          effect: prior,
          permit: issueEffectDispatchPermit(
            prior,
            approval,
            prior.attemptId,
            { ...claim, principalId: claim.principalId },
            retry.revision,
            prior.executionStartedAt,
            options.permitIssuer,
          ),
        },
        event: null,
      };
    }
    const before = await getEffect(tx, effectId, tenantId);
    if (!before) throw new Error(`Effect not found: ${effectId}`);
    if (before.status !== "authorized") {
      throw new Error(`Effect must be authorized before execution: ${before.status}`);
    }
    if (before.attemptId == null) throw new Error("Effect execution requires an attached attempt");
    const approval = await getEffectiveEffectApproval(tx, effectId, tenantId);
    if (!approval || approval.id !== before.authorizedByApprovalId || approval.decision !== "approved") {
      throw new Error("Effect execution requires its current exact approved decision");
    }
    const attemptRows = await tx.select().from(taskAttempt).where(and(
      eq(taskAttempt.id, before.attemptId),
      eq(taskAttempt.tenantId, tenantId),
      eq(taskAttempt.taskId, before.taskId),
    )).limit(1);
    const attempt = attemptRows[0];
    if (!attempt || attempt.status !== "running" || attempt.claimId !== options.claimId) {
      throw new Error("Effect execution requires a running attempt bound to the supplied claim");
    }
    const claimRows = await tx.select().from(taskClaim).where(and(
      eq(taskClaim.id, options.claimId),
      eq(taskClaim.tenantId, tenantId),
      eq(taskClaim.taskId, before.taskId),
    )).limit(1);
    const claim = claimRows[0];
    if (!claim || claim.releasedAt != null || claim.expiresAt <= now || claim.fence !== options.fence) {
      throw new Error("Effect execution requires the current live claim fence");
    }
    if (!claim.principalId || attempt.principalId !== claim.principalId) {
      throw new Error("Effect attempt and claim principal attribution do not match");
    }
    const caller = await contextPrincipal(tx, tenantId, options, now);
    if (caller.id !== claim.principalId) {
      throw new Error("Only the principal holding the live claim may begin effect execution");
    }
    assertEffectAuthority({
      request: before.request,
      requestDigest: before.requestDigest,
      approval,
      now,
    }, options.policy);
    const rows = await tx.update(effect).set({
      status: "executing",
      claimId: claim.id,
      fence: claim.fence,
      executionStartedAt: now,
      updatedAt: now,
      revision: sql`${effect.revision} + 1`,
    }).where(and(
      eq(effect.id, effectId),
      eq(effect.tenantId, tenantId),
      eq(effect.revision, options.expectedRevision),
    )).returning();
    if (!rows[0]) throw new Error(`Stale effect revision: expected ${options.expectedRevision}`);
    const after = parseEffect(rows[0]);
    const permit = issueEffectDispatchPermit(
      after,
      approval,
      attempt.id,
      { ...claim, principalId: claim.principalId },
      after.revision,
      now,
      options.permitIssuer,
    );
    const event = await recordEvent(tx, {
      tenantId,
      actor: actorLabel(options, caller),
      principalId: caller.id,
      entityType: "task",
      entityId: before.taskId,
      eventType: "effect_execution_started",
      payload: {
        before: { effectId, status: before.status, revision: before.revision },
        after: {
          effectId,
          status: after.status,
          revision: after.revision,
          approvalId: approval.id,
          claimId: claim.id,
          fence: claim.fence,
        },
      },
    }, { defer: true, now });
    await saveRetry(tx, retry.identity, {
      resultType: "effect_dispatch",
      resultId: after.id,
      resultStatus: after.status,
      resultRevision: after.revision,
      eventSequence: event.sequence,
    });
    return { result: { effect: after, permit }, event };
  });
  if (committedEvent) emitAfterCommit(committedEvent);
  return result;
}

function parseReceipt(row: typeof effectReceipt.$inferSelect): EffectReceipt {
  let report: unknown;
  let verification: unknown;
  let coverage: unknown;
  try {
    report = JSON.parse(row.canonicalReport);
    verification = JSON.parse(row.verification);
    coverage = JSON.parse(row.coverage);
  } catch {
    throw new Error(`Effect receipt ${row.id} contains invalid JSON`);
  }
  const prepared = prepareEffectReceiptReport(report);
  if (prepared.canonicalReport !== row.canonicalReport || prepared.receiptDigest !== row.receiptDigest) {
    throw new Error(`Effect receipt ${row.id} integrity mismatch`);
  }
  if (canonicalizeEffectJson(verification) !== row.verification ||
    canonicalizeEffectJson(coverage) !== row.coverage) {
    throw new Error(`Effect receipt ${row.id} verification metadata is not canonical`);
  }
  return EffectReceiptZ.parse({ ...row, report: prepared.report, verification, coverage });
}

export async function getEffectReceipt(
  db: TasqDbOrTx,
  id: string,
  tenantId = "gwendall",
): Promise<EffectReceipt | null> {
  const rows = await db.select().from(effectReceipt).where(and(
    eq(effectReceipt.id, id), eq(effectReceipt.tenantId, tenantId),
  )).limit(1);
  return rows[0] ? parseReceipt(rows[0]) : null;
}

export async function listEffectReceipts(
  db: TasqDbOrTx,
  options: { tenantId?: string; effectId?: string } = {},
): Promise<EffectReceipt[]> {
  const filters = [eq(effectReceipt.tenantId, options.tenantId ?? "gwendall")];
  if (options.effectId) filters.push(eq(effectReceipt.effectId, options.effectId));
  return (await db.select().from(effectReceipt).where(and(...filters))
    .orderBy(asc(effectReceipt.recordedAt))).map(parseReceipt);
}

export interface RecordEffectReceiptOptions extends PrincipalContext {
  expectedRevision: number;
  verifier: EffectReceiptVerifier;
}

/** Persist one immutable connector report, derive evidence and resolve effect state atomically. */
export async function recordEffectReceipt(
  db: TasqDb,
  input: unknown,
  options: RecordEffectReceiptOptions,
): Promise<EffectReceipt> {
  canonicalizeEffectJson(input);
  const parsed = EffectReceiptInput.parse(input);
  const prepared = prepareEffectReceiptReport(parsed.report);
  const tenantId = options.tenantId ?? prepared.report.workspaceId;
  if (prepared.report.workspaceId !== tenantId) throw new Error("Receipt workspace does not match context");
  const now = serviceNow(options, options.now);
  const { result, events } = await runInTransaction(db, async (tx) => {
    const priorRows = await tx.select().from(effectReceipt).where(and(
      eq(effectReceipt.tenantId, tenantId),
      eq(effectReceipt.connectorInstanceRef, prepared.report.connectorInstanceRef),
      eq(effectReceipt.externalReceiptId, prepared.report.externalReceiptId),
    )).limit(1);
    if (priorRows[0]) {
      if (priorRows[0].receiptDigest !== prepared.receiptDigest) {
        throw new Error("Effect receipt delivery identity was reused with different content");
      }
      return { result: parseReceipt(priorRows[0]), events: [] };
    }
    const target = await getEffect(tx, prepared.report.effectId, tenantId);
    if (!target) throw new Error(`Effect not found: ${prepared.report.effectId}`);
    if (target.revision !== options.expectedRevision) {
      throw new Error(`Stale effect revision: expected ${options.expectedRevision}`);
    }
    if (target.status !== "executing" && target.status !== "indeterminate") {
      throw new Error(`Effect cannot accept a receipt from status ${target.status}`);
    }
    if (!target.attemptId || !target.authorizedByApprovalId || !target.claimId || !target.fence) {
      throw new Error("Effect receipt requires a complete execution binding");
    }
    const exact = prepared.report.requestDigest === target.requestDigest &&
      prepared.report.dispatchIdempotencyKey === target.dispatchIdempotencyKey &&
      prepared.report.approvalId === target.authorizedByApprovalId &&
      prepared.report.claimId === target.claimId && prepared.report.fence === target.fence &&
      prepared.report.connectorInstanceRef === target.request.connector.instanceRef &&
      prepared.report.connectorBindingDigest === target.request.connector.bindingDigest;
    if (!exact) throw new Error("Receipt does not match the exact effect execution binding");
    if (prepared.report.outcome === "indeterminate") {
      if (target.status !== "executing" || prepared.report.resolvesReceiptId != null) {
        throw new Error("Only an executing effect can become indeterminate");
      }
    } else if (target.status === "indeterminate") {
      if (prepared.report.resolvesReceiptId !== target.outcomeReceiptId) {
        throw new Error("Terminal recovery must resolve the current indeterminate receipt");
      }
    } else if (prepared.report.resolvesReceiptId != null) {
      throw new Error("A direct terminal receipt cannot resolve another receipt");
    }
    const caller = await contextPrincipal(tx, tenantId, options, now);
    const verified = options.verifier.verify({ report: prepared.report, now });
    if (!verified.method.trim()) throw new Error("Receipt verification method must not be empty");
    const verificationLevel = ApprovalVerificationLevel.parse(verified.level);
    const verificationDetails = EffectJsonObjectZ.parse(verified.details);
    const parsedCoverage = verified.coverage.map((value) => EffectReceiptCoverageZ.parse(value));
    const coverage = [...new Set(parsedCoverage)].sort();
    if (coverage.length !== verified.coverage.length) throw new Error("Receipt verification coverage contains duplicates");
    if (prepared.report.outcome !== "indeterminate") {
      if (verificationLevel === "self_asserted" ||
        EFFECT_RECEIPT_COVERAGE.some((required) => !coverage.includes(required))) {
        throw new Error("Terminal receipt requires strong verification with complete coverage");
      }
    }
    const receiptId = parsed.id ?? uuidv7(now);
    const evidenceId = parsed.evidenceId ?? uuidv7(now);
    const actor = actorLabel(options, caller);
    await tx.insert(taskEvidence).values({
      id: evidenceId,
      tenantId,
      taskId: target.taskId,
      attemptId: target.attemptId,
      supersedesEvidenceId: null,
      actor,
      principalId: caller.id,
      kind: "effect_receipt",
      summary: `Effect ${prepared.report.outcome}: receipt ${prepared.report.externalReceiptId}`,
      uri: prepared.report.rawRef,
      digest: prepared.report.rawDigest,
      source: prepared.report.connectorInstanceRef,
      observedAt: prepared.report.occurredAt,
      metadata: canonicalizeEffectJson({
        effectId: target.id,
        approvalId: target.authorizedByApprovalId,
        receiptId,
        receiptDigest: prepared.receiptDigest,
        outcome: prepared.report.outcome,
      }),
      createdAt: now,
    });
    await tx.insert(effectReceipt).values({
      id: receiptId,
      tenantId,
      effectId: target.id,
      taskId: target.taskId,
      attemptId: target.attemptId,
      approvalId: target.authorizedByApprovalId,
      evidenceId,
      canonicalReport: prepared.canonicalReport,
      receiptDigest: prepared.receiptDigest,
      connectorInstanceRef: prepared.report.connectorInstanceRef,
      externalReceiptId: prepared.report.externalReceiptId,
      providerOperationId: prepared.report.providerOperationId,
      outcome: prepared.report.outcome,
      resolvesReceiptId: prepared.report.resolvesReceiptId,
      verificationLevel,
      verificationMethod: verified.method,
      coverage: canonicalizeEffectJson(coverage),
      verification: canonicalizeEffectJson(verificationDetails),
      recordedByPrincipalId: caller.id,
      occurredAt: prepared.report.occurredAt,
      recordedAt: now,
    });
    const terminal = prepared.report.outcome !== "indeterminate";
    const rows = await tx.update(effect).set({
      status: prepared.report.outcome,
      outcomeReceiptId: receiptId,
      indeterminateAt: terminal ? target.indeterminateAt : now,
      resolvedAt: terminal ? now : null,
      updatedAt: now,
      revision: sql`${effect.revision} + 1`,
    }).where(and(
      eq(effect.id, target.id),
      eq(effect.tenantId, tenantId),
      eq(effect.revision, options.expectedRevision),
    )).returning();
    if (!rows[0]) throw new Error(`Stale effect revision: expected ${options.expectedRevision}`);
    const events = [
      await recordEvent(tx, {
        tenantId, actor, principalId: caller.id, entityType: "task", entityId: target.taskId,
        eventType: "evidence_added",
        payload: { after: { evidenceId, attemptId: target.attemptId, kind: "effect_receipt", receiptId } },
      }, { defer: true, now }),
      await recordEvent(tx, {
        tenantId, actor, principalId: caller.id, entityType: "task", entityId: target.taskId,
        eventType: "effect_receipt_recorded",
        payload: {
          before: { effectId: target.id, status: target.status, revision: target.revision },
          after: {
            effectId: target.id, status: prepared.report.outcome, receiptId, evidenceId,
            revision: rows[0].revision,
          },
        },
      }, { defer: true, now }),
    ];
    const result = await getEffectReceipt(tx, receiptId, tenantId);
    if (!result) throw new Error(`Failed to read back effect receipt ${receiptId}`);
    return { result, events };
  });
  for (const event of events) emitAfterCommit(event);
  return result;
}

export async function cancelEffect(
  db: TasqDb,
  effectId: string,
  reason: string,
  options: PrincipalContext & { expectedRevision: number },
): Promise<Effect> {
  if (!reason.trim()) throw new Error("Effect cancellation requires a reason");
  const tenantId = options.tenantId ?? "gwendall";
  const now = serviceNow(options, options.now);
  const { result, event: committedEvent } = await runInTransaction(db, async (tx) => {
    const retry = await retryResult(tx, tenantId, options, "effect.cancel", {
      effectId,
      expectedRevision: options.expectedRevision,
      reason: reason.trim(),
    }, now);
    if (retry.id) {
      const prior = await getEffect(tx, retry.id, tenantId);
      if (!prior) throw new Error(`Idempotency record points at missing effect ${retry.id}`);
      return { result: prior, event: null };
    }
    const before = await getEffect(tx, effectId, tenantId);
    if (!before) throw new Error(`Effect not found: ${effectId}`);
    if (before.status !== "proposed" && before.status !== "authorized") {
      throw new Error(`Effect cannot be cancelled after dispatch: ${before.status}`);
    }
    const caller = await contextPrincipal(tx, tenantId, options, now);
    const rows = await tx.update(effect).set({
      status: "cancelled",
      authorizedByApprovalId: null,
      authorizedAt: null,
      cancelledAt: now,
      cancelReason: reason.trim(),
      updatedAt: now,
      revision: sql`${effect.revision} + 1`,
    }).where(and(
      eq(effect.id, effectId),
      eq(effect.tenantId, tenantId),
      eq(effect.revision, options.expectedRevision),
    )).returning();
    if (!rows[0]) throw new Error(`Stale effect revision: expected ${options.expectedRevision}`);
    const result = parseEffect(rows[0]);
    const event = await recordEvent(tx, {
      tenantId,
      actor: actorLabel(options, caller),
      principalId: caller.id,
      entityType: "task",
      entityId: before.taskId,
      eventType: "effect_cancelled",
      payload: { before: { effectId, status: before.status }, after: { effectId, status: "cancelled", reason: reason.trim() } },
    }, { defer: true, now });
    await saveRetry(tx, retry.identity, {
      resultType: "effect",
      resultId: result.id,
      resultStatus: result.status,
      resultRevision: result.revision,
      eventSequence: event.sequence,
    });
    return { result, event };
  });
  if (committedEvent) emitAfterCommit(committedEvent);
  return result;
}

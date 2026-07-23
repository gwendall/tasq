/** ADR-005/TQ-612 independently validated completion resolution. */

import { and, asc, eq, inArray } from "drizzle-orm";
import {
  AUTHENTICITY_RANK,
  CompletionChallenge as CompletionChallengeZ,
  CompletionChallengeInsert,
  CompletionProposal as CompletionProposalZ,
  CompletionProposalInsert,
  CompletionResolutionChain as CompletionResolutionChainZ,
  EvidenceTrustAttestationInsert,
  EvidenceTrustRecord as EvidenceTrustRecordZ,
  ManualValidationDecisionInsert,
  ResolutionContract as ResolutionContractZ,
  ResolutionContractInsert,
  TaskEvidence as TaskEvidenceZ,
  ValidationDecision as ValidationDecisionZ,
  completionChallenge,
  completionProposal,
  evidenceTrustRecord,
  principal,
  resolutionContract,
  taskEvidence,
  validationDecision,
  uuidv7,
  type CompletionChallenge,
  type CompletionProposal,
  type CompletionResolutionChain,
  type EvidenceAuthenticityClass,
  type EvidenceTrustRecord,
  type Event as EventT,
  type ResolutionContract,
  type TaskEvidence,
  type ValidationDecision,
  type ValidationOutcome,
} from "@tasq-run/schema";
import type {
  CompletionEvaluationInput,
  CompletionEvaluatorRuntime,
} from "@tasq-run/extension-sdk";
import type { TasqDb, TasqDbOrTx } from "../db.js";
import { runInTransaction } from "../db.js";
import { canonicalJson, sha256Digest } from "../util/canonical-json.js";
import { serviceNow } from "../util/clock.js";
import { parseRow } from "../util/row.js";
import type { ServiceContext } from "./context.js";
import { emitAfterCommit, recordEvent } from "./events.js";
import {
  findIdempotencyResult,
  prepareIdempotency,
  saveIdempotencyResult,
} from "./idempotency.js";
import { ensureLocalPrincipal, getPrincipal } from "./principals.js";
import { getTask } from "./tasks.js";

export interface ResolutionContext extends ServiceContext {
  principalId?: string;
}

export interface EvidenceTrustAuthority {
  authorityUri: string;
  authorityVersion: number;
  authorityDigest: string;
  authorize(input: {
    workspaceId: string;
    principalId: string;
    evidence: TaskEvidence;
    authenticity: EvidenceAuthenticityClass;
  }): boolean;
}

export interface AttestEvidenceTrustOptions extends ResolutionContext {
  authority?: EvidenceTrustAuthority;
}

export interface RevokeEvidenceTrustOptions extends ResolutionContext {
  reason: string;
  idempotencyKey?: string;
}

export interface DeterministicValidationOptions extends ResolutionContext {
  evaluator: CompletionEvaluatorRuntime;
  supersedesDecisionId?: string | null;
}

interface PreparedValidation {
  contract: ResolutionContract;
  proposal: CompletionProposal;
  evidence: TaskEvidence[];
  trust: EvidenceTrustRecord[];
  evidenceIds: string[];
  earlyOutcome: { outcome: "too_early" | "indeterminate"; reasonCode: string; explanation: string } | null;
}

function parseContract(row: typeof resolutionContract.$inferSelect): ResolutionContract {
  return ResolutionContractZ.parse({
    ...parseRow(row),
    criteria: JSON.parse(row.criteriaJson),
    eligibleValidatorPrincipalIds: JSON.parse(row.eligibleValidatorPrincipalIds),
    adjudicatorPrincipalIds: JSON.parse(row.adjudicatorPrincipalIds),
  });
}

function parseTrust(row: typeof evidenceTrustRecord.$inferSelect): EvidenceTrustRecord {
  return EvidenceTrustRecordZ.parse(row);
}

function parseProposal(row: typeof completionProposal.$inferSelect): CompletionProposal {
  return CompletionProposalZ.parse({
    ...row,
    criterionEvidence: JSON.parse(row.criterionEvidence),
  });
}

function parseChallenge(row: typeof completionChallenge.$inferSelect): CompletionChallenge {
  return CompletionChallengeZ.parse({
    ...row,
    counterEvidenceIds: JSON.parse(row.counterEvidenceIds),
  });
}

function parseDecision(row: typeof validationDecision.$inferSelect): ValidationDecision {
  return ValidationDecisionZ.parse({
    ...row,
    evidenceIds: JSON.parse(row.evidenceIds),
    trustRecordIds: JSON.parse(row.trustRecordIds),
  });
}

async function callerPrincipal(
  tx: TasqDbOrTx,
  tenantId: string,
  ctx: ResolutionContext,
  now: number,
) {
  if (ctx.principalId) {
    const result = await getPrincipal(tx, ctx.principalId, tenantId);
    if (!result) throw new Error(`Principal not found in workspace: ${ctx.principalId}`);
    if (result.status !== "enabled") throw new Error(`Principal is disabled: ${result.id}`);
    return result;
  }
  return ensureLocalPrincipal(tx, tenantId, ctx.actor ?? "system", now);
}

async function requireEnabledPrincipal(
  tx: TasqDbOrTx,
  tenantId: string,
  id: string,
) {
  const result = await getPrincipal(tx, id, tenantId);
  if (!result) throw new Error(`Principal not found in workspace: ${id}`);
  if (result.status !== "enabled") throw new Error(`Principal is disabled: ${id}`);
  return result;
}

function retry(
  ctx: ResolutionContext,
  tenantId: string,
  operation: string,
  request: unknown,
  now: number,
) {
  return prepareIdempotency({ ...ctx, tenantId }, operation, request, {
    now,
    retentionClass: "durable",
    legacyRequest: { operation, request },
  });
}

async function recordResolutionEvent(
  tx: TasqDbOrTx,
  input: {
    tenantId: string;
    taskId: string;
    actor: string;
    principalId: string;
    eventType: string;
    payload: Record<string, unknown>;
    now: number;
  },
) {
  return recordEvent(tx, {
    tenantId: input.tenantId,
    actor: input.actor,
    principalId: input.principalId,
    entityType: "task",
    entityId: input.taskId,
    eventType: input.eventType,
    payload: input.payload,
  }, { defer: true, now: input.now });
}

export async function createResolutionContract(
  db: TasqDb,
  input: unknown,
  ctx: ResolutionContext = {},
): Promise<ResolutionContract> {
  const parsed = ResolutionContractInsert.parse(input);
  const tenantId = ctx.tenantId ?? "gwendall";
  const actor = ctx.actor ?? "system";
  const now = serviceNow(ctx, ctx.now);
  const identity = retry(ctx, tenantId, "resolution.contract.create", parsed, now);
  const { result, event } = await runInTransaction(db, async (tx) => {
    const prior = await findIdempotencyResult(tx, identity);
    if (prior) {
      const found = await getResolutionContract(tx, prior.resultId, tenantId);
      if (!found) throw new Error(`Idempotency record points at missing resolution contract ${prior.resultId}`);
      return { result: found, event: null as EventT | null };
    }
    const task = await getTask(tx, parsed.taskId, tenantId);
    if (!task || task.deletedAt != null) throw new Error(`Commitment not found: ${parsed.taskId}`);
    if (!task.validationRequired || task.completionMode !== "evidence") {
      throw new Error("Resolution contracts require an evidence task with validationRequired");
    }
    if (!task.successCriteria?.trim()) throw new Error("Resolution contract requires success criteria");
    for (const id of new Set([
      ...parsed.eligibleValidatorPrincipalIds,
      ...parsed.adjudicatorPrincipalIds,
    ])) await requireEnabledPrincipal(tx, tenantId, id);
    const creator = await callerPrincipal(tx, tenantId, ctx, now);
    const criteria = [...parsed.criteria].sort((a, b) => a.id.localeCompare(b.id));
    const criteriaDigest = sha256Digest(canonicalJson({
      successCriteria: task.successCriteria,
      criteria,
    }));
    const digestInput = {
      taskId: task.id,
      taskRevision: task.revision,
      successCriteriaSnapshot: task.successCriteria,
      criteria,
      criteriaDigest,
      policyKind: parsed.policyKind,
      policyUri: parsed.policyUri,
      policyVersion: parsed.policyVersion,
      implementationDigest: parsed.implementationDigest,
      notBefore: parsed.notBefore,
      challengeWindowMs: parsed.challengeWindowMs,
      allowSelfValidation: parsed.allowSelfValidation,
      eligibleValidatorPrincipalIds: [...parsed.eligibleValidatorPrincipalIds].sort(),
      adjudicatorPrincipalIds: [...parsed.adjudicatorPrincipalIds].sort(),
      metadata: parsed.metadata,
    };
    const contractDigest = sha256Digest(canonicalJson(digestInput));
    const id = parsed.id ?? uuidv7(now);
    await tx.insert(resolutionContract).values({
      id,
      tenantId,
      taskId: task.id,
      taskRevision: task.revision,
      successCriteriaSnapshot: task.successCriteria,
      criteriaJson: canonicalJson(criteria),
      criteriaDigest,
      policyKind: parsed.policyKind,
      policyUri: parsed.policyUri,
      policyVersion: parsed.policyVersion,
      implementationDigest: parsed.implementationDigest,
      notBefore: parsed.notBefore,
      challengeWindowMs: parsed.challengeWindowMs,
      allowSelfValidation: parsed.allowSelfValidation,
      eligibleValidatorPrincipalIds: canonicalJson([...parsed.eligibleValidatorPrincipalIds].sort()),
      adjudicatorPrincipalIds: canonicalJson([...parsed.adjudicatorPrincipalIds].sort()),
      contractDigest,
      createdByPrincipalId: creator.id,
      metadata: canonicalJson(parsed.metadata),
      createdAt: now,
    });
    const result = await getResolutionContract(tx, id, tenantId);
    if (!result) throw new Error(`Failed to read resolution contract ${id}`);
    const event = await recordResolutionEvent(tx, {
      tenantId, taskId: task.id, actor, principalId: creator.id,
      eventType: "resolution_contract_created",
      payload: { after: { resolutionContractId: id, contractDigest, policyKind: parsed.policyKind } },
      now,
    });
    await saveIdempotencyResult(tx, identity, {
      resultType: "resolution_contract",
      resultId: id,
      resultStatus: "created",
      eventSequence: event.sequence,
    });
    return { result, event };
  });
  if (event) emitAfterCommit(event);
  return result;
}

export async function getResolutionContract(
  db: TasqDbOrTx,
  id: string,
  tenantId = "gwendall",
): Promise<ResolutionContract | null> {
  const rows = await db.select().from(resolutionContract).where(and(
    eq(resolutionContract.id, id),
    eq(resolutionContract.tenantId, tenantId),
  )).limit(1);
  return rows[0] ? parseContract(rows[0]) : null;
}

export async function listResolutionContracts(
  db: TasqDb,
  taskId: string,
  tenantId = "gwendall",
): Promise<ResolutionContract[]> {
  return (await db.select().from(resolutionContract).where(and(
    eq(resolutionContract.tenantId, tenantId),
    eq(resolutionContract.taskId, taskId),
  )).orderBy(asc(resolutionContract.createdAt))).map(parseContract);
}

export async function attestEvidenceTrust(
  db: TasqDb,
  input: unknown,
  ctx: AttestEvidenceTrustOptions = {},
): Promise<EvidenceTrustRecord> {
  const parsed = EvidenceTrustAttestationInsert.parse(input);
  const tenantId = ctx.tenantId ?? "gwendall";
  const actor = ctx.actor ?? "system";
  const now = serviceNow(ctx, ctx.now);
  const identity = retry(ctx, tenantId, "resolution.evidence-trust.attest", parsed, now);
  const { result, event } = await runInTransaction(db, async (tx) => {
    const prior = await findIdempotencyResult(tx, identity);
    if (prior) {
      const found = await getEvidenceTrustRecord(tx, prior.resultId, tenantId);
      if (!found) throw new Error(`Idempotency record points at missing evidence trust ${prior.resultId}`);
      return { result: found, event: null as EventT | null };
    }
    const evidence = await getEvidence(tx, parsed.evidenceId, tenantId);
    if (!evidence || evidence.taskId !== parsed.taskId) {
      throw new Error(`Evidence does not belong to task ${parsed.taskId}`);
    }
    const recorder = await callerPrincipal(tx, tenantId, ctx, now);
    if (parsed.authenticity !== "unverified") {
      const authority = ctx.authority;
      if (!authority
        || authority.authorityUri !== parsed.authorityUri
        || authority.authorityVersion !== parsed.authorityVersion
        || authority.authorityDigest !== parsed.authorityDigest
        || !authority.authorize({
          workspaceId: tenantId,
          principalId: recorder.id,
          evidence,
          authenticity: parsed.authenticity,
        })) {
        throw new Error("Authenticated evidence trust requires a matching host authority");
      }
    }
    const id = parsed.id ?? uuidv7(now);
    await tx.insert(evidenceTrustRecord).values({
      id,
      tenantId,
      taskId: parsed.taskId,
      evidenceId: parsed.evidenceId,
      action: "attest",
      authenticity: parsed.authenticity,
      authorityUri: parsed.authorityUri,
      authorityVersion: parsed.authorityVersion,
      authorityDigest: parsed.authorityDigest,
      supersedesTrustRecordId: null,
      reason: parsed.reason,
      verifiedAt: parsed.verifiedAt,
      validUntil: parsed.validUntil,
      retentionUntil: parsed.retentionUntil,
      recordedByPrincipalId: recorder.id,
      createdAt: now,
    });
    const result = await getEvidenceTrustRecord(tx, id, tenantId);
    if (!result) throw new Error(`Failed to read evidence trust ${id}`);
    const event = await recordResolutionEvent(tx, {
      tenantId, taskId: parsed.taskId, actor, principalId: recorder.id,
      eventType: "evidence_trust_attested",
      payload: { after: { trustRecordId: id, evidenceId: parsed.evidenceId, authenticity: parsed.authenticity } },
      now,
    });
    await saveIdempotencyResult(tx, identity, {
      resultType: "evidence_trust_record",
      resultId: id,
      resultStatus: "attested",
      eventSequence: event.sequence,
    });
    return { result, event };
  });
  if (event) emitAfterCommit(event);
  return result;
}

export async function revokeEvidenceTrust(
  db: TasqDb,
  trustRecordId: string,
  ctx: RevokeEvidenceTrustOptions,
): Promise<EvidenceTrustRecord> {
  const tenantId = ctx.tenantId ?? "gwendall";
  const actor = ctx.actor ?? "system";
  const now = serviceNow(ctx, ctx.now);
  if (!ctx.reason.trim()) throw new Error("Evidence trust revocation requires a reason");
  const identity = retry(ctx, tenantId, "resolution.evidence-trust.revoke", {
    trustRecordId, reason: ctx.reason,
  }, now);
  const { result, event } = await runInTransaction(db, async (tx) => {
    const priorResult = await findIdempotencyResult(tx, identity);
    if (priorResult) {
      const found = await getEvidenceTrustRecord(tx, priorResult.resultId, tenantId);
      if (!found) throw new Error(`Idempotency record points at missing evidence trust ${priorResult.resultId}`);
      return { result: found, event: null as EventT | null };
    }
    const prior = await getEvidenceTrustRecord(tx, trustRecordId, tenantId);
    if (!prior || prior.action !== "attest") throw new Error("Trust revocation must supersede an attestation");
    const existingChild = await childTrustRecord(tx, prior.id, tenantId);
    if (existingChild) throw new Error(`Evidence trust already superseded by ${existingChild.id}`);
    const recorder = await callerPrincipal(tx, tenantId, ctx, now);
    if (recorder.id !== prior.recordedByPrincipalId) {
      throw new Error("Only the attesting principal may revoke this local trust record");
    }
    const id = uuidv7(now);
    await tx.insert(evidenceTrustRecord).values({
      id,
      tenantId,
      taskId: prior.taskId,
      evidenceId: prior.evidenceId,
      action: "revoke",
      authenticity: prior.authenticity,
      authorityUri: prior.authorityUri,
      authorityVersion: prior.authorityVersion,
      authorityDigest: prior.authorityDigest,
      supersedesTrustRecordId: prior.id,
      reason: ctx.reason,
      verifiedAt: now,
      validUntil: prior.validUntil,
      retentionUntil: prior.retentionUntil,
      recordedByPrincipalId: recorder.id,
      createdAt: now,
    });
    const result = await getEvidenceTrustRecord(tx, id, tenantId);
    if (!result) throw new Error(`Failed to read evidence trust revocation ${id}`);
    const event = await recordResolutionEvent(tx, {
      tenantId, taskId: prior.taskId, actor, principalId: recorder.id,
      eventType: "evidence_trust_revoked",
      payload: { after: { trustRecordId: id, supersedesTrustRecordId: prior.id, evidenceId: prior.evidenceId } },
      now,
    });
    await saveIdempotencyResult(tx, identity, {
      resultType: "evidence_trust_record",
      resultId: id,
      resultStatus: "revoked",
      eventSequence: event.sequence,
    });
    return { result, event };
  });
  if (event) emitAfterCommit(event);
  return result;
}

export async function getEvidenceTrustRecord(
  db: TasqDbOrTx,
  id: string,
  tenantId = "gwendall",
): Promise<EvidenceTrustRecord | null> {
  const rows = await db.select().from(evidenceTrustRecord).where(and(
    eq(evidenceTrustRecord.id, id),
    eq(evidenceTrustRecord.tenantId, tenantId),
  )).limit(1);
  return rows[0] ? parseTrust(rows[0]) : null;
}

export async function listEvidenceTrustRecords(
  db: TasqDb,
  evidenceId: string,
  tenantId = "gwendall",
): Promise<EvidenceTrustRecord[]> {
  return (await db.select().from(evidenceTrustRecord).where(and(
    eq(evidenceTrustRecord.tenantId, tenantId),
    eq(evidenceTrustRecord.evidenceId, evidenceId),
  )).orderBy(asc(evidenceTrustRecord.createdAt))).map(parseTrust);
}

export async function proposeCompletion(
  db: TasqDb,
  input: unknown,
  ctx: ResolutionContext = {},
): Promise<CompletionProposal> {
  const parsed = CompletionProposalInsert.parse(input);
  const tenantId = ctx.tenantId ?? "gwendall";
  const actor = ctx.actor ?? "system";
  const now = serviceNow(ctx, ctx.now);
  const identity = retry(ctx, tenantId, "resolution.proposal.create", parsed, now);
  const { result, event } = await runInTransaction(db, async (tx) => {
    const prior = await findIdempotencyResult(tx, identity);
    if (prior) {
      const found = await getCompletionProposal(tx, prior.resultId, tenantId);
      if (!found) throw new Error(`Idempotency record points at missing completion proposal ${prior.resultId}`);
      return { result: found, event: null as EventT | null };
    }
    const contract = await getResolutionContract(tx, parsed.resolutionContractId, tenantId);
    if (!contract || contract.taskId !== parsed.taskId) {
      throw new Error(`Resolution contract does not belong to task ${parsed.taskId}`);
    }
    const task = await getTask(tx, parsed.taskId, tenantId);
    if (!task || task.deletedAt != null || task.status === "done" || task.status === "cancelled") {
      throw new Error(`Commitment is not open for completion proposal: ${parsed.taskId}`);
    }
    if (task.successCriteria !== contract.successCriteriaSnapshot) {
      throw new Error("Success criteria changed after the resolution contract was frozen");
    }
    const proposer = await callerPrincipal(tx, tenantId, ctx, now);
    const criterionEvidence = normalizeCriterionEvidence(contract, parsed.criterionEvidence);
    const evidenceIds = uniqueEvidenceIds(criterionEvidence);
    await requireCurrentEvidence(tx, tenantId, parsed.taskId, evidenceIds);
    const digestInput = {
      taskId: parsed.taskId,
      resolutionContractId: contract.id,
      contractDigest: contract.contractDigest,
      proposerPrincipalId: proposer.id,
      criterionEvidence,
      summary: parsed.summary,
    };
    const proposalDigest = sha256Digest(canonicalJson(digestInput));
    const id = parsed.id ?? uuidv7(now);
    await tx.insert(completionProposal).values({
      id,
      tenantId,
      taskId: parsed.taskId,
      resolutionContractId: contract.id,
      contractDigest: contract.contractDigest,
      proposerPrincipalId: proposer.id,
      criterionEvidence: canonicalJson(criterionEvidence),
      summary: parsed.summary,
      proposalDigest,
      proposedAt: now,
    });
    const result = await getCompletionProposal(tx, id, tenantId);
    if (!result) throw new Error(`Failed to read completion proposal ${id}`);
    const event = await recordResolutionEvent(tx, {
      tenantId, taskId: parsed.taskId, actor, principalId: proposer.id,
      eventType: "completion_proposed",
      payload: { after: { proposalId: id, resolutionContractId: contract.id, evidenceIds } },
      now,
    });
    await saveIdempotencyResult(tx, identity, {
      resultType: "completion_proposal",
      resultId: id,
      resultStatus: "proposed",
      eventSequence: event.sequence,
    });
    return { result, event };
  });
  if (event) emitAfterCommit(event);
  return result;
}

export async function challengeCompletion(
  db: TasqDb,
  input: unknown,
  ctx: ResolutionContext = {},
): Promise<CompletionChallenge> {
  const parsed = CompletionChallengeInsert.parse(input);
  const tenantId = ctx.tenantId ?? "gwendall";
  const actor = ctx.actor ?? "system";
  const now = serviceNow(ctx, ctx.now);
  const identity = retry(ctx, tenantId, "resolution.challenge.create", parsed, now);
  const { result, event } = await runInTransaction(db, async (tx) => {
    const prior = await findIdempotencyResult(tx, identity);
    if (prior) {
      const found = await getCompletionChallenge(tx, prior.resultId, tenantId);
      if (!found) throw new Error(`Idempotency record points at missing completion challenge ${prior.resultId}`);
      return { result: found, event: null as EventT | null };
    }
    const proposal = await getCompletionProposal(tx, parsed.proposalId, tenantId);
    if (!proposal) throw new Error(`Completion proposal not found: ${parsed.proposalId}`);
    const contract = await getResolutionContract(tx, proposal.resolutionContractId, tenantId);
    if (!contract) throw new Error(`Resolution contract not found: ${proposal.resolutionContractId}`);
    if (contract.challengeWindowMs <= 0) throw new Error("Resolution contract has no challenge window");
    const deadline = proposal.proposedAt + contract.challengeWindowMs;
    if (now >= deadline) throw new Error(`Challenge deadline passed at ${deadline}`);
    await requireCurrentEvidence(tx, tenantId, proposal.taskId, parsed.counterEvidenceIds);
    const challenger = await callerPrincipal(tx, tenantId, ctx, now);
    const id = parsed.id ?? uuidv7(now);
    await tx.insert(completionChallenge).values({
      id,
      tenantId,
      taskId: proposal.taskId,
      proposalId: proposal.id,
      challengerPrincipalId: challenger.id,
      reasonCode: parsed.reasonCode,
      explanation: parsed.explanation,
      counterEvidenceIds: canonicalJson([...parsed.counterEvidenceIds].sort()),
      challengedAt: now,
    });
    const result = await getCompletionChallenge(tx, id, tenantId);
    if (!result) throw new Error(`Failed to read completion challenge ${id}`);
    const event = await recordResolutionEvent(tx, {
      tenantId, taskId: proposal.taskId, actor, principalId: challenger.id,
      eventType: "completion_challenged",
      payload: { after: { challengeId: id, proposalId: proposal.id, reasonCode: parsed.reasonCode } },
      now,
    });
    await saveIdempotencyResult(tx, identity, {
      resultType: "completion_challenge",
      resultId: id,
      resultStatus: "challenged",
      eventSequence: event.sequence,
    });
    return { result, event };
  });
  if (event) emitAfterCommit(event);
  return result;
}

export async function evaluateCompletionDeterministically(
  db: TasqDb,
  proposalId: string,
  options: DeterministicValidationOptions,
): Promise<ValidationDecision> {
  const tenantId = options.tenantId ?? "gwendall";
  const now = serviceNow(options, options.now);
  const idempotencyOperation = "resolution.decision.evaluate";
  const idempotencyRequest = {
    proposalId,
    evaluator: {
      policyUri: options.evaluator.policyUri,
      policyVersion: options.evaluator.policyVersion,
      implementationDigest: options.evaluator.implementationDigest,
    },
    supersedesDecisionId: options.supersedesDecisionId ?? null,
  };
  const replay = await replayDecision(
    db, options, tenantId, idempotencyOperation, idempotencyRequest, now,
  );
  if (replay) return replay;
  const prepared = await prepareValidation(db, proposalId, tenantId, now);
  if (prepared.contract.policyKind !== "deterministic") {
    throw new Error(`Resolution policy is ${prepared.contract.policyKind}, not deterministic`);
  }
  const evaluator = options.evaluator;
  assertEvaluatorIdentity(prepared.contract, evaluator);
  const result = prepared.earlyOutcome ?? evaluator.evaluate({
    contract: prepared.contract,
    proposal: prepared.proposal,
    evidence: prepared.evidence,
    effectiveTrust: prepared.trust,
    evaluatedAt: now,
  });
  return appendDecision(
    db, prepared, result, options, now, options.supersedesDecisionId ?? null,
    idempotencyOperation, idempotencyRequest,
  );
}

export async function attestCompletion(
  db: TasqDb,
  input: unknown,
  ctx: ResolutionContext = {},
): Promise<ValidationDecision> {
  const parsed = ManualValidationDecisionInsert.parse(input);
  const tenantId = ctx.tenantId ?? "gwendall";
  const now = serviceNow(ctx, ctx.now);
  const idempotencyOperation = "resolution.decision.attest";
  const replay = await replayDecision(db, ctx, tenantId, idempotencyOperation, parsed, now);
  if (replay) return replay;
  const prepared = await prepareValidation(db, parsed.proposalId, tenantId, now);
  if (prepared.contract.policyKind !== "attestation") {
    throw new Error(`Resolution policy is ${prepared.contract.policyKind}, not attestation`);
  }
  const validator = await resolveCallerFromDb(db, tenantId, ctx, now);
  if (!prepared.contract.eligibleValidatorPrincipalIds.includes(validator.id)) {
    throw new Error(`Principal is not an eligible validator: ${validator.id}`);
  }
  assertSelfValidation(prepared, validator.id);
  const result = acceptedOnlyWhenReady(prepared, parsed.outcome, parsed.reasonCode, parsed.explanation);
  return appendDecision(
    db, prepared, result, ctx, now,
    parsed.supersedesDecisionId, idempotencyOperation, parsed,
  );
}

export async function settleOptimisticCompletion(
  db: TasqDb,
  proposalId: string,
  ctx: ResolutionContext = {},
): Promise<ValidationDecision> {
  const tenantId = ctx.tenantId ?? "gwendall";
  const now = serviceNow(ctx, ctx.now);
  const idempotencyOperation = "resolution.decision.settle-optimistic";
  const idempotencyRequest = { proposalId };
  const replay = await replayDecision(
    db, ctx, tenantId, idempotencyOperation, idempotencyRequest, now,
  );
  if (replay) return replay;
  const prepared = await prepareValidation(db, proposalId, tenantId, now);
  if (prepared.contract.policyKind !== "optimistic") {
    throw new Error(`Resolution policy is ${prepared.contract.policyKind}, not optimistic`);
  }
  const deadline = prepared.proposal.proposedAt + prepared.contract.challengeWindowMs;
  const priorDecision = await currentDecision(db, proposalId, tenantId);
  if (now < deadline) {
    if (priorDecision) return priorDecision;
    return appendDecision(db, prepared, {
      outcome: "too_early",
      reasonCode: "challenge_window_open",
      explanation: `Challenge window remains open until ${deadline}`,
    }, ctx, now, null, idempotencyOperation, idempotencyRequest);
  }
  const challenges = await listCompletionChallenges(db, proposalId, tenantId);
  const result = prepared.earlyOutcome ?? (challenges.length > 0
    ? {
      outcome: "challenged" as const,
      reasonCode: "eligible_challenge_recorded",
      explanation: `${challenges.length} challenge(s) require adjudication`,
    }
    : {
      outcome: "accepted" as const,
      reasonCode: "challenge_window_elapsed",
      explanation: "No challenge was recorded before the deadline",
    });
  if (priorDecision && priorDecision.outcome !== "too_early") {
    return priorDecision;
  }
  return appendDecision(
    db, prepared, result, ctx, now, priorDecision?.id ?? null,
    idempotencyOperation, idempotencyRequest,
  );
}

export async function adjudicateCompletion(
  db: TasqDb,
  input: unknown,
  ctx: ResolutionContext = {},
): Promise<ValidationDecision> {
  const parsed = ManualValidationDecisionInsert.parse(input);
  const tenantId = ctx.tenantId ?? "gwendall";
  const now = serviceNow(ctx, ctx.now);
  const idempotencyOperation = "resolution.decision.adjudicate";
  const replay = await replayDecision(db, ctx, tenantId, idempotencyOperation, parsed, now);
  if (replay) return replay;
  const prepared = await prepareValidation(db, parsed.proposalId, tenantId, now);
  if (prepared.contract.policyKind !== "adjudicated"
    && prepared.contract.policyKind !== "optimistic") {
    throw new Error(`Resolution policy ${prepared.contract.policyKind} cannot be adjudicated`);
  }
  const adjudicator = await resolveCallerFromDb(db, tenantId, ctx, now);
  if (!prepared.contract.adjudicatorPrincipalIds.includes(adjudicator.id)) {
    throw new Error(`Principal is not an eligible adjudicator: ${adjudicator.id}`);
  }
  assertSelfValidation(prepared, adjudicator.id);
  if (prepared.contract.policyKind === "optimistic") {
    const current = await currentDecision(db, prepared.proposal.id, tenantId);
    if (!current || current.outcome !== "challenged" || parsed.supersedesDecisionId !== current.id) {
      throw new Error("Optimistic adjudication must supersede the current challenged decision");
    }
  }
  const result = acceptedOnlyWhenReady(prepared, parsed.outcome, parsed.reasonCode, parsed.explanation);
  return appendDecision(
    db,
    prepared,
    result,
    ctx,
    now,
    parsed.supersedesDecisionId,
    idempotencyOperation,
    parsed,
  );
}

function acceptedOnlyWhenReady(
  prepared: PreparedValidation,
  outcome: ValidationOutcome,
  reasonCode: string,
  explanation: string,
) {
  if (outcome === "challenged") throw new Error("Manual decision cannot synthesize a challenge");
  if (outcome === "accepted" && prepared.earlyOutcome) {
    throw new Error(`Proposal cannot be accepted: ${prepared.earlyOutcome.reasonCode}`);
  }
  return { outcome: outcome as Exclude<ValidationOutcome, "challenged">, reasonCode, explanation };
}

function assertSelfValidation(prepared: PreparedValidation, validatorId: string) {
  if (!prepared.contract.allowSelfValidation
    && prepared.proposal.proposerPrincipalId === validatorId) {
    throw new Error("Resolution contract forbids self-validation");
  }
}

function assertEvaluatorIdentity(
  contract: ResolutionContract,
  evaluator: CompletionEvaluatorRuntime,
) {
  if (evaluator.policyUri !== contract.policyUri
    || evaluator.policyVersion !== contract.policyVersion
    || evaluator.implementationDigest !== contract.implementationDigest) {
    throw new Error("Completion evaluator identity does not match the frozen resolution contract");
  }
}

async function appendDecision(
  db: TasqDb,
  prepared: PreparedValidation,
  result: { outcome: ValidationOutcome; reasonCode: string; explanation: string },
  ctx: ResolutionContext,
  now: number,
  supersedesDecisionId: string | null,
  idempotencyOperation: string,
  idempotencyRequest: unknown,
): Promise<ValidationDecision> {
  const tenantId = ctx.tenantId ?? prepared.contract.tenantId;
  const actor = ctx.actor ?? "system";
  const identity = retry(ctx, tenantId, idempotencyOperation, idempotencyRequest, now);
  const { decision, event } = await runInTransaction(db, async (tx) => {
    const prior = await findIdempotencyResult(tx, identity);
    if (prior) {
      const found = await getValidationDecision(tx, prior.resultId, tenantId);
      if (!found) throw new Error(`Idempotency record points at missing validation decision ${prior.resultId}`);
      return { decision: found, event: null as EventT | null };
    }
    const decider = await callerPrincipal(tx, tenantId, ctx, now);
    if (supersedesDecisionId) {
      const current = await currentDecision(tx, prepared.proposal.id, tenantId);
      if (!current || current.id !== supersedesDecisionId) {
        throw new Error(`Decision must supersede current leaf ${current?.id ?? "none"}`);
      }
    }
    const policyInputDigest = validationInputDigest(prepared, now);
    const id = uuidv7(now);
    await tx.insert(validationDecision).values({
      id,
      tenantId,
      taskId: prepared.proposal.taskId,
      resolutionContractId: prepared.contract.id,
      proposalId: prepared.proposal.id,
      outcome: result.outcome,
      policyUri: prepared.contract.policyUri,
      policyVersion: prepared.contract.policyVersion,
      implementationDigest: prepared.contract.implementationDigest,
      policyInputDigest,
      evidenceIds: canonicalJson(prepared.evidenceIds),
      trustRecordIds: canonicalJson(prepared.trust.map((value) => value.id).sort()),
      supersedesDecisionId,
      decidedByPrincipalId: decider.id,
      reasonCode: result.reasonCode,
      explanation: result.explanation,
      decidedAt: now,
    });
    const decision = await getValidationDecision(tx, id, tenantId);
    if (!decision) throw new Error(`Failed to read validation decision ${id}`);
    const event = await recordResolutionEvent(tx, {
      tenantId, taskId: prepared.proposal.taskId, actor, principalId: decider.id,
      eventType: "validation_decided",
      payload: {
        after: {
          validationDecisionId: id,
          proposalId: prepared.proposal.id,
          outcome: result.outcome,
          supersedesDecisionId,
        },
      },
      now,
    });
    await saveIdempotencyResult(tx, identity, {
      resultType: "validation_decision",
      resultId: id,
      resultStatus: result.outcome,
      eventSequence: event.sequence,
    });
    return { decision, event };
  });
  if (event) emitAfterCommit(event);
  return decision;
}

async function replayDecision(
  db: TasqDb,
  ctx: ResolutionContext,
  tenantId: string,
  operation: string,
  request: unknown,
  now: number,
): Promise<ValidationDecision | null> {
  const prior = await findIdempotencyResult(db, retry(ctx, tenantId, operation, request, now));
  if (!prior) return null;
  const found = await getValidationDecision(db, prior.resultId, tenantId);
  if (!found) throw new Error(`Idempotency record points at missing validation decision ${prior.resultId}`);
  return found;
}

async function prepareValidation(
  db: TasqDbOrTx,
  proposalId: string,
  tenantId: string,
  now: number,
): Promise<PreparedValidation> {
  const proposal = await getCompletionProposal(db, proposalId, tenantId);
  if (!proposal) throw new Error(`Completion proposal not found: ${proposalId}`);
  const contract = await getResolutionContract(db, proposal.resolutionContractId, tenantId);
  if (!contract || contract.contractDigest !== proposal.contractDigest) {
    throw new Error("Completion proposal contract identity mismatch");
  }
  const task = await getTask(db, proposal.taskId, tenantId);
  if (!task || task.deletedAt != null || task.status === "done" || task.status === "cancelled") {
    throw new Error(`Commitment is not open for validation: ${proposal.taskId}`);
  }
  if (task.successCriteria !== contract.successCriteriaSnapshot) {
    throw new Error("Success criteria changed after the resolution contract was frozen");
  }
  const criterionEvidence = normalizeCriterionEvidence(contract, proposal.criterionEvidence);
  const evidenceIds = uniqueEvidenceIds(criterionEvidence);
  const evidence = await requireCurrentEvidence(db, tenantId, proposal.taskId, evidenceIds);
  const trust: EvidenceTrustRecord[] = [];
  let earlyOutcome: PreparedValidation["earlyOutcome"] =
    contract.notBefore != null && now < contract.notBefore
      ? {
        outcome: "too_early",
        reasonCode: "resolution_not_eligible",
        explanation: `Resolution is not eligible before ${contract.notBefore}`,
      }
      : null;
  for (const mapping of criterionEvidence) {
    const criterion = contract.criteria.find((value) => value.id === mapping.criterionId)!;
    if (mapping.evidenceIds.length < criterion.minimumEvidenceCount && !earlyOutcome) {
      earlyOutcome = {
        outcome: "indeterminate",
        reasonCode: "insufficient_evidence",
        explanation: `Criterion ${criterion.id} requires ${criterion.minimumEvidenceCount} evidence record(s)`,
      };
    }
    for (const evidenceId of mapping.evidenceIds) {
      const item = evidence.find((value) => value.id === evidenceId)!;
      if (criterion.acceptedEvidenceKinds.length > 0
        && !criterion.acceptedEvidenceKinds.includes(item.kind)
        && !earlyOutcome) {
        earlyOutcome = {
          outcome: "indeterminate",
          reasonCode: "evidence_kind_not_accepted",
          explanation: `Evidence ${item.id} kind ${item.kind} is not accepted for ${criterion.id}`,
        };
      }
      if (criterion.acceptedSources.length > 0
        && (item.source == null || !criterion.acceptedSources.includes(item.source))
        && !earlyOutcome) {
        earlyOutcome = {
          outcome: "indeterminate",
          reasonCode: "evidence_source_not_accepted",
          explanation: `Evidence ${item.id} source is not accepted for ${criterion.id}`,
        };
      }
      if (criterion.maxAgeMs != null && now - item.observedAt > criterion.maxAgeMs && !earlyOutcome) {
        earlyOutcome = {
          outcome: "indeterminate",
          reasonCode: "evidence_stale",
          explanation: `Evidence ${item.id} exceeds the freshness window`,
        };
      }
      const leaf = await effectiveTrust(db, item.id, tenantId);
      if (!leaf || leaf.action === "revoke") {
        if (!earlyOutcome) {
          earlyOutcome = {
            outcome: "indeterminate",
            reasonCode: leaf ? "evidence_trust_revoked" : "evidence_trust_missing",
            explanation: `Evidence ${item.id} has no effective trust attestation`,
          };
        }
        continue;
      }
      trust.push(leaf);
      if (AUTHENTICITY_RANK[leaf.authenticity] < AUTHENTICITY_RANK[criterion.minimumAuthenticity]
        && !earlyOutcome) {
        earlyOutcome = {
          outcome: "indeterminate",
          reasonCode: "evidence_authenticity_insufficient",
          explanation: `Evidence ${item.id} does not meet ${criterion.minimumAuthenticity}`,
        };
      }
      if (leaf.validUntil != null && now > leaf.validUntil && !earlyOutcome) {
        earlyOutcome = {
          outcome: "indeterminate",
          reasonCode: "evidence_trust_expired",
          explanation: `Evidence trust ${leaf.id} expired`,
        };
      }
      const requiredRetentionUntil = now + criterion.minimumRetentionMs;
      if (criterion.minimumRetentionMs > 0
        && (leaf.retentionUntil == null || leaf.retentionUntil < requiredRetentionUntil)
        && !earlyOutcome) {
        earlyOutcome = {
          outcome: "indeterminate",
          reasonCode: "evidence_retention_insufficient",
          explanation: `Evidence trust ${leaf.id} does not cover the required retention window`,
        };
      }
    }
  }
  return {
    contract,
    proposal,
    evidence,
    trust: dedupeById(trust),
    evidenceIds,
    earlyOutcome,
  };
}

function validationInputDigest(prepared: PreparedValidation, evaluatedAt: number): string {
  return sha256Digest(canonicalJson({
    contractDigest: prepared.contract.contractDigest,
    proposalDigest: prepared.proposal.proposalDigest,
    evidence: prepared.evidence.map((value) => ({
      id: value.id,
      digest: value.digest,
      observedAt: value.observedAt,
      supersedesEvidenceId: value.supersedesEvidenceId,
    })).sort((a, b) => a.id.localeCompare(b.id)),
    trust: prepared.trust.map((value) => ({
      id: value.id,
      action: value.action,
      authenticity: value.authenticity,
      authorityDigest: value.authorityDigest,
      validUntil: value.validUntil,
      retentionUntil: value.retentionUntil,
    })).sort((a, b) => a.id.localeCompare(b.id)),
    evaluatedAt,
  }));
}

function normalizeCriterionEvidence(
  contract: ResolutionContract,
  mappings: CompletionProposal["criterionEvidence"],
) {
  const expected = contract.criteria.map((value) => value.id).sort();
  const actual = mappings.map((value) => value.criterionId).sort();
  if (new Set(actual).size !== actual.length
    || expected.length !== actual.length
    || !expected.every((value, index) => value === actual[index])) {
    throw new Error("Completion proposal must map every frozen criterion exactly once");
  }
  return [...mappings]
    .map((value) => ({ criterionId: value.criterionId, evidenceIds: [...value.evidenceIds].sort() }))
    .sort((a, b) => a.criterionId.localeCompare(b.criterionId));
}

function uniqueEvidenceIds(mappings: CompletionProposal["criterionEvidence"]): string[] {
  return Array.from(new Set(mappings.flatMap((value) => value.evidenceIds))).sort();
}

async function requireCurrentEvidence(
  db: TasqDbOrTx,
  tenantId: string,
  taskId: string,
  evidenceIds: string[],
): Promise<TaskEvidence[]> {
  if (evidenceIds.length === 0) return [];
  const rows = await db.select().from(taskEvidence).where(and(
    eq(taskEvidence.tenantId, tenantId),
    eq(taskEvidence.taskId, taskId),
    inArray(taskEvidence.id, evidenceIds),
  ));
  const found = new Set(rows.map((row) => row.id));
  const missing = evidenceIds.filter((id) => !found.has(id));
  if (missing.length > 0) throw new Error(`Evidence does not belong to task ${taskId}: ${missing.join(", ")}`);
  const children = await db.select({ parent: taskEvidence.supersedesEvidenceId })
    .from(taskEvidence).where(and(
      eq(taskEvidence.tenantId, tenantId),
      inArray(taskEvidence.supersedesEvidenceId, evidenceIds),
    ));
  if (children.length > 0) throw new Error("Completion evidence has been superseded");
  return rows.map((row) => TaskEvidenceZ.parse(parseRow(row)))
    .sort((a, b) => a.id.localeCompare(b.id));
}

async function getEvidence(db: TasqDbOrTx, id: string, tenantId: string) {
  const rows = await db.select().from(taskEvidence).where(and(
    eq(taskEvidence.id, id),
    eq(taskEvidence.tenantId, tenantId),
  )).limit(1);
  return rows[0] ? TaskEvidenceZ.parse(parseRow(rows[0])) : null;
}

async function childTrustRecord(db: TasqDbOrTx, id: string, tenantId: string) {
  const rows = await db.select().from(evidenceTrustRecord).where(and(
    eq(evidenceTrustRecord.tenantId, tenantId),
    eq(evidenceTrustRecord.supersedesTrustRecordId, id),
  )).limit(1);
  return rows[0] ? parseTrust(rows[0]) : null;
}

async function effectiveTrust(db: TasqDbOrTx, evidenceId: string, tenantId: string) {
  const rows = (await db.select().from(evidenceTrustRecord).where(and(
    eq(evidenceTrustRecord.tenantId, tenantId),
    eq(evidenceTrustRecord.evidenceId, evidenceId),
  ))).map(parseTrust);
  if (rows.length === 0) return null;
  const parentIds = new Set(rows.flatMap((row) =>
    row.supersedesTrustRecordId ? [row.supersedesTrustRecordId] : []));
  const leaves = rows.filter((row) => !parentIds.has(row.id));
  if (leaves.length !== 1) throw new Error(`Evidence trust chain has ${leaves.length} leaves`);
  return leaves[0]!;
}

function dedupeById<T extends { id: string }>(rows: T[]): T[] {
  return [...new Map(rows.map((row) => [row.id, row])).values()]
    .sort((a, b) => a.id.localeCompare(b.id));
}

async function resolveCallerFromDb(
  db: TasqDb,
  tenantId: string,
  ctx: ResolutionContext,
  now: number,
) {
  return runInTransaction(db, (tx) => callerPrincipal(tx, tenantId, ctx, now));
}

export async function getCompletionProposal(
  db: TasqDbOrTx,
  id: string,
  tenantId = "gwendall",
): Promise<CompletionProposal | null> {
  const rows = await db.select().from(completionProposal).where(and(
    eq(completionProposal.id, id),
    eq(completionProposal.tenantId, tenantId),
  )).limit(1);
  return rows[0] ? parseProposal(rows[0]) : null;
}

export async function listCompletionProposals(
  db: TasqDb,
  taskId: string,
  tenantId = "gwendall",
): Promise<CompletionProposal[]> {
  return (await db.select().from(completionProposal).where(and(
    eq(completionProposal.tenantId, tenantId),
    eq(completionProposal.taskId, taskId),
  )).orderBy(asc(completionProposal.proposedAt))).map(parseProposal);
}

export async function getCompletionChallenge(
  db: TasqDbOrTx,
  id: string,
  tenantId = "gwendall",
): Promise<CompletionChallenge | null> {
  const rows = await db.select().from(completionChallenge).where(and(
    eq(completionChallenge.id, id),
    eq(completionChallenge.tenantId, tenantId),
  )).limit(1);
  return rows[0] ? parseChallenge(rows[0]) : null;
}

export async function listCompletionChallenges(
  db: TasqDb,
  proposalId: string,
  tenantId = "gwendall",
): Promise<CompletionChallenge[]> {
  return (await db.select().from(completionChallenge).where(and(
    eq(completionChallenge.tenantId, tenantId),
    eq(completionChallenge.proposalId, proposalId),
  )).orderBy(asc(completionChallenge.challengedAt))).map(parseChallenge);
}

export async function getValidationDecision(
  db: TasqDbOrTx,
  id: string,
  tenantId = "gwendall",
): Promise<ValidationDecision | null> {
  const rows = await db.select().from(validationDecision).where(and(
    eq(validationDecision.id, id),
    eq(validationDecision.tenantId, tenantId),
  )).limit(1);
  return rows[0] ? parseDecision(rows[0]) : null;
}

export async function listValidationDecisions(
  db: TasqDb,
  proposalId: string,
  tenantId = "gwendall",
): Promise<ValidationDecision[]> {
  return (await db.select().from(validationDecision).where(and(
    eq(validationDecision.tenantId, tenantId),
    eq(validationDecision.proposalId, proposalId),
  )).orderBy(asc(validationDecision.decidedAt))).map(parseDecision);
}

async function currentDecision(db: TasqDbOrTx, proposalId: string, tenantId: string) {
  const decisions = await listValidationDecisionRows(db, proposalId, tenantId);
  if (decisions.length === 0) return null;
  const parentIds = new Set(decisions.flatMap((row) =>
    row.supersedesDecisionId ? [row.supersedesDecisionId] : []));
  const leaves = decisions.filter((row) => !parentIds.has(row.id));
  if (leaves.length !== 1) throw new Error(`Validation decision chain has ${leaves.length} leaves`);
  return leaves[0]!;
}

async function listValidationDecisionRows(
  db: TasqDbOrTx,
  proposalId: string,
  tenantId: string,
) {
  return (await db.select().from(validationDecision).where(and(
    eq(validationDecision.tenantId, tenantId),
    eq(validationDecision.proposalId, proposalId),
  )).orderBy(asc(validationDecision.decidedAt))).map(parseDecision);
}

export async function getCompletionResolutionChain(
  db: TasqDb,
  contractId: string,
  tenantId = "gwendall",
): Promise<CompletionResolutionChain | null> {
  const contract = await getResolutionContract(db, contractId, tenantId);
  if (!contract) return null;
  const proposals = (await db.select().from(completionProposal).where(and(
    eq(completionProposal.tenantId, tenantId),
    eq(completionProposal.resolutionContractId, contractId),
  )).orderBy(asc(completionProposal.proposedAt))).map(parseProposal);
  const proposalIds = proposals.map((value) => value.id);
  const challenges = proposalIds.length === 0 ? [] : (await db.select().from(completionChallenge)
    .where(and(
      eq(completionChallenge.tenantId, tenantId),
      inArray(completionChallenge.proposalId, proposalIds),
    )).orderBy(asc(completionChallenge.challengedAt))).map(parseChallenge);
  const decisions = proposalIds.length === 0 ? [] : (await db.select().from(validationDecision)
    .where(and(
      eq(validationDecision.tenantId, tenantId),
      inArray(validationDecision.proposalId, proposalIds),
    )).orderBy(asc(validationDecision.decidedAt))).map(parseDecision);
  const evidenceIds = uniqueEvidenceIds(proposals.flatMap((proposal) => proposal.criterionEvidence));
  const trustRecords = evidenceIds.length === 0 ? [] : (await db.select().from(evidenceTrustRecord)
    .where(and(
      eq(evidenceTrustRecord.tenantId, tenantId),
      inArray(evidenceTrustRecord.evidenceId, evidenceIds),
    )).orderBy(asc(evidenceTrustRecord.createdAt))).map(parseTrust);
  return CompletionResolutionChainZ.parse({ contract, proposals, challenges, decisions, trustRecords });
}

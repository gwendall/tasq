/** Deterministic settlement and recourse over exact agreement/runtime facts. */

import { and, asc, eq } from "drizzle-orm";
import {
  SettlementBasisV1,
  SettlementDecisionV1,
  SettlementEvaluationInputV1,
  SettlementMaterializationV1,
  SettlementPolicyV1,
  SettlementViewV1,
  TaskInsert,
  settlementBasisDigest,
  settlementDecision,
  settlementDecisionDigest,
  settlementMaterialization,
  settlementPolicyDigest,
  validationDecision,
  uuidv7,
  type Event,
  type SettlementBasisV1 as Basis,
  type SettlementDecisionKindV1 as DecisionKind,
  type SettlementDecisionV1 as Decision,
  type SettlementEntitlementV1 as Entitlement,
  type SettlementMaterializationV1 as Materialization,
  type SettlementPolicyRuleV1 as PolicyRule,
  type SettlementViewV1 as SettlementView, LEGACY_DEFAULT_WORKSPACE_ID } from "@tasq-run/schema";
import type { TasqDb, TasqDbOrTx } from "../db.js";
import { runInTransaction } from "../db.js";
import { canonicalJson } from "../util/canonical-json.js";
import { serviceNow } from "../util/clock.js";
import { getAgreementView } from "./agreements.js";
import { listTaskAttempts } from "./agentic.js";
import type { ServiceContext } from "./context.js";
import { cancelEffect, getEffect, proposeEffect } from "./effects.js";
import { emitAfterCommit } from "./events.js";
import { findIdempotencyResult, prepareIdempotency, saveIdempotencyResult } from "./idempotency.js";
import { getPrincipal } from "./principals.js";
import { createTaskInTransaction, getTask, transitionTaskStatus } from "./tasks.js";

function authenticatedPrincipal(ctx: ServiceContext): string {
  if (!ctx.principalId?.trim()) throw new Error("authenticated principalId is required");
  return ctx.principalId;
}

function parseDecision(row: typeof settlementDecision.$inferSelect): Decision {
  return SettlementDecisionV1.parse({
    contractVersion: "tasq.settlement-decision.v1",
    id: row.id,
    workspaceId: row.tenantId,
    decisionKind: row.decisionKind,
    basis: JSON.parse(row.basisJson),
    basisDigest: row.basisDigest,
    policy: JSON.parse(row.policyJson),
    policyDigest: row.policyDigest,
    matchedRuleId: row.matchedRuleId,
    classification: row.classification,
    entitlements: JSON.parse(row.entitlementsJson),
    supersedesDecisionId: row.supersedesDecisionId,
    decidedByPrincipalId: row.decidedByPrincipalId,
    decidedAt: row.decidedAt,
    decisionDigest: row.decisionDigest,
  });
}

function parseMaterialization(row: typeof settlementMaterialization.$inferSelect): Materialization {
  return SettlementMaterializationV1.parse({
    contractVersion: "tasq.settlement-materialization.v1",
    id: row.id,
    workspaceId: row.tenantId,
    decisionId: row.decisionId,
    entitlementId: row.entitlementId,
    commitmentId: row.commitmentId,
    effectId: row.effectId,
    createdAt: row.createdAt,
  });
}

export async function getSettlementDecision(
  db: TasqDbOrTx,
  id: string,
  workspaceId = LEGACY_DEFAULT_WORKSPACE_ID,
): Promise<Decision | null> {
  const rows = await db.select().from(settlementDecision).where(and(
    eq(settlementDecision.tenantId, workspaceId),
    eq(settlementDecision.id, id),
  )).limit(1);
  return rows[0] ? parseDecision(rows[0]) : null;
}

export async function listSettlementDecisions(
  db: TasqDbOrTx,
  workspaceId = LEGACY_DEFAULT_WORKSPACE_ID,
): Promise<Decision[]> {
  return (await db.select().from(settlementDecision)
    .where(eq(settlementDecision.tenantId, workspaceId))
    .orderBy(asc(settlementDecision.decidedAt), asc(settlementDecision.id))).map(parseDecision);
}

async function listMaterializations(
  db: TasqDbOrTx,
  decisionId: string,
  workspaceId: string,
): Promise<Materialization[]> {
  return (await db.select().from(settlementMaterialization).where(and(
    eq(settlementMaterialization.tenantId, workspaceId),
    eq(settlementMaterialization.decisionId, decisionId),
  )).orderBy(asc(settlementMaterialization.entitlementId))).map(parseMaterialization);
}

export async function getSettlementView(
  db: TasqDbOrTx,
  id: string,
  workspaceId = LEGACY_DEFAULT_WORKSPACE_ID,
): Promise<SettlementView | null> {
  const decision = await getSettlementDecision(db, id, workspaceId);
  if (!decision) return null;
  const successor = await db.select({ id: settlementDecision.id }).from(settlementDecision).where(and(
    eq(settlementDecision.tenantId, workspaceId),
    eq(settlementDecision.supersedesDecisionId, id),
  )).limit(1);
  return SettlementViewV1.parse({
    contractVersion: "tasq.settlement-view.v1",
    decision,
    materializations: await listMaterializations(db, id, workspaceId),
    supersededByDecisionId: successor[0]?.id ?? null,
    assurance: {
      completionRewritten: false,
      effectAuthorityGranted: false,
      escrowOrRecordRoleAsserted: false,
    },
  });
}

function matches(rule: PolicyRule, basis: Basis): boolean {
  const condition = rule.when;
  if (condition.taskStatuses.length > 0 && !condition.taskStatuses.includes(basis.task.status)) return false;
  if (condition.anyAttemptStatuses.length > 0 &&
      !basis.attempts.some(({ status }) => condition.anyAttemptStatuses.includes(status))) return false;
  if (condition.validationOutcomes.length > 0 &&
      (!basis.validation || !condition.validationOutcomes.includes(basis.validation.outcome))) return false;
  if (condition.validationReasonCodes.length > 0 &&
      (!basis.validation || !condition.validationReasonCodes.includes(basis.validation.reasonCode))) return false;
  if (condition.anyEffectStatuses.length > 0 &&
      !basis.effects.some(({ status }) => condition.anyEffectStatuses.includes(status))) return false;
  return true;
}

async function exactBasis(input: {
  tx: TasqDbOrTx;
  parsed: ReturnType<typeof SettlementEvaluationInputV1.parse>;
  workspaceId: string;
  now: number;
}): Promise<{ basis: Basis; kind: DecisionKind; parties: Set<string> }> {
  const { tx, parsed, workspaceId, now } = input;
  const agreement = await getAgreementView(tx, parsed.agreementOfferId, workspaceId, now);
  if (!agreement?.activation) throw new Error("settlement requires an activated agreement");
  const compilation = agreement.activation.compilations.find(({ obligationId }) => obligationId === parsed.obligationId);
  if (!compilation) throw new Error("settlement obligation is not compiled by this agreement activation");
  const task = await getTask(tx, compilation.commitmentId, workspaceId);
  if (!task) throw new Error("settlement source commitment is missing");

  const attempts = (await listTaskAttempts(tx as TasqDb, task.id, { tenantId: workspaceId, limit: 101 }))
    .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  if (attempts.length > 100) throw new Error("settlement basis exceeds 100 attempts");
  const exactAttemptIds = attempts.map(({ id }) => id);
  const requestedAttemptIds = [...parsed.attemptIds].sort();
  if (canonicalJson(requestedAttemptIds) !== canonicalJson(exactAttemptIds)) {
    throw new Error("settlement attempt set changed; retry with every current attempt id");
  }
  const decisions = await tx.select().from(validationDecision).where(and(
    eq(validationDecision.tenantId, workspaceId),
    eq(validationDecision.taskId, task.id),
    eq(validationDecision.resolutionContractId, compilation.resolutionContractId),
  )).orderBy(asc(validationDecision.decidedAt));
  if (!parsed.validationDecisionId && decisions.length > 0) {
    throw new Error("settlement requires an explicit current validation decision id when decisions exist");
  }
  const currentValidation = parsed.validationDecisionId
    ? decisions.find(({ id }) => id === parsed.validationDecisionId) ?? null
    : null;
  if (parsed.validationDecisionId && !currentValidation) {
    throw new Error("settlement validation decision is not part of this obligation resolution");
  }
  if (currentValidation && decisions.some(({ supersedesDecisionId }) => supersedesDecisionId === currentValidation.id)) {
    throw new Error("settlement validation decision has been superseded");
  }

  let prior: Decision | null = null;
  let effects: Array<{ id: string; revision: number; status: string; requestDigest: string }> = [];
  if (parsed.priorSettlementDecisionId) {
    prior = await getSettlementDecision(tx, parsed.priorSettlementDecisionId, workspaceId);
    if (!prior) throw new Error("recourse source settlement decision not found");
    if (prior.basis.agreementOfferId !== parsed.agreementOfferId || prior.basis.obligationId !== parsed.obligationId) {
      throw new Error("recourse source must cover the same agreement obligation");
    }
    const priorMaterializations = await listMaterializations(tx, prior.id, workspaceId);
    const observed = [];
    for (const materialization of priorMaterializations) {
      if (!materialization.effectId) continue;
      const effect = await getEffect(tx, materialization.effectId, workspaceId);
      if (!effect) throw new Error(`recourse source effect is missing: ${materialization.effectId}`);
      observed.push({ id: effect.id, revision: effect.revision, status: effect.status, requestDigest: effect.requestDigest });
    }
    effects = observed.sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
    if (canonicalJson(effects.map(({ id }) => id)) !== canonicalJson([...parsed.effectIds].sort())) {
      throw new Error("recourse effect set changed; retry with every materialized effect id");
    }
  } else if (parsed.effectIds.length > 0) {
    throw new Error("settlement cannot import effect facts without a prior decision");
  }

  const basis = SettlementBasisV1.parse({
    contractVersion: "tasq.settlement-basis.v1",
    agreementOfferId: agreement.offer.id,
    activationId: agreement.activation.id,
    activationDigest: agreement.activation.activationDigest,
    termsDigest: agreement.offer.termsDigest,
    obligationId: parsed.obligationId,
    resolutionContractId: compilation.resolutionContractId,
    task: { id: task.id, revision: task.revision, status: task.status },
    attempts: attempts.map(({ id, revision, status }) => ({ id, revision, status })),
    validation: currentValidation ? {
      id: currentValidation.id,
      outcome: currentValidation.outcome,
      reasonCode: currentValidation.reasonCode,
      policyInputDigest: currentValidation.policyInputDigest,
      decidedAt: currentValidation.decidedAt,
    } : null,
    effects,
    priorSettlementDecisionId: prior?.id ?? null,
  });
  return {
    basis,
    kind: prior ? "recourse" : "settlement",
    parties: new Set(agreement.offer.terms.parties.map(({ principalId }) => principalId)),
  };
}

async function retireSupersededMaterializations(input: {
  tx: TasqDbOrTx;
  predecessor: Decision;
  workspaceId: string;
  actor: string;
  principalId: string;
  now: number;
  successorId: string;
}): Promise<void> {
  const { tx, predecessor, workspaceId, actor, principalId, now, successorId } = input;
  const successor = await tx.select({ id: settlementDecision.id }).from(settlementDecision).where(and(
    eq(settlementDecision.tenantId, workspaceId),
    eq(settlementDecision.supersedesDecisionId, predecessor.id),
  )).limit(1);
  if (successor[0]) throw new Error("settlement decision already has a successor");
  for (const materialization of await listMaterializations(tx, predecessor.id, workspaceId)) {
    if (materialization.effectId) {
      const effect = await getEffect(tx, materialization.effectId, workspaceId);
      if (!effect) throw new Error("superseded settlement effect is missing");
      if (effect.status === "proposed" || effect.status === "authorized") {
        await cancelEffect(tx as TasqDb, effect.id, `Superseded by settlement decision ${successorId}`, {
          tenantId: workspaceId, actor, principalId, now, expectedRevision: effect.revision,
          idempotencyKey: `settlement:${successorId}:cancel-effect:${effect.id}`,
        });
      } else if (effect.status !== "failed" && effect.status !== "cancelled") {
        throw new Error(`settlement cannot supersede an effect after dispatch: ${effect.status}; use recourse`);
      }
    }
    const task = await getTask(tx, materialization.commitmentId, workspaceId);
    if (!task) throw new Error("superseded settlement commitment is missing");
    if (task.status === "done" || task.status === "in_progress") {
      throw new Error(`settlement cannot supersede a ${task.status} entitlement; use recourse`);
    }
    if (task.status !== "cancelled") {
      await transitionTaskStatus(tx as TasqDb, task.id, "cancelled", {
        tenantId: workspaceId, actor, principalId, now, expectedRevision: task.revision,
        reason: `Superseded by settlement decision ${successorId}`,
        source: `settlement:${successorId}`,
        idempotencyKey: `settlement:${successorId}:cancel-task:${task.id}`,
      });
    }
  }
}

async function materializeEntitlement(input: {
  tx: TasqDbOrTx;
  decision: Decision;
  entitlement: Entitlement;
  workspaceId: string;
  actor: string;
  principalId: string;
  now: number;
}): Promise<{ materialization: Materialization; event: Event }> {
  const { tx, decision, entitlement, workspaceId, actor, principalId, now } = input;
  const created = await createTaskInTransaction(tx, TaskInsert.parse({
    tenantId: workspaceId,
    title: entitlement.task.title,
    description: entitlement.task.description,
    successCriteria: entitlement.task.successCriteria,
    completionMode: "evidence",
    validationRequired: false,
    status: "open",
    dueAt: entitlement.task.dueAt,
    metadata: {
      ...entitlement.task.metadata,
      settlementDecisionId: decision.id,
      settlementDecisionDigest: decision.decisionDigest,
      settlementClassification: decision.classification,
      settlementEntitlementId: entitlement.id,
      obligorPrincipalId: entitlement.obligorPrincipalId,
      beneficiaryPrincipalId: entitlement.beneficiaryPrincipalId,
    },
  }), {
    tenantId: workspaceId,
    actor,
    principalId,
    now,
    eventContext: { source: `settlement:${decision.id}`, reason: `materialized entitlement ${entitlement.id}` },
  });
  let effectId: string | null = null;
  if (entitlement.effect) {
    const proposed = await proposeEffect(tx as TasqDb, {
      tenantId: workspaceId,
      taskId: created.result.id,
      attemptId: null,
      request: entitlement.effect.request,
      supersedesEffectId: null,
      compensationOfEffectId: entitlement.effect.compensationOfEffectId,
    }, {
      tenantId: workspaceId,
      actor,
      principalId,
      now,
      idempotencyKey: `settlement:${decision.id}:effect:${entitlement.id}`,
    });
    effectId = proposed.id;
  }
  const materialization = SettlementMaterializationV1.parse({
    contractVersion: "tasq.settlement-materialization.v1",
    id: uuidv7(now),
    workspaceId,
    decisionId: decision.id,
    entitlementId: entitlement.id,
    commitmentId: created.result.id,
    effectId,
    createdAt: now,
  });
  await tx.insert(settlementMaterialization).values({
    id: materialization.id,
    tenantId: workspaceId,
    decisionId: decision.id,
    entitlementId: entitlement.id,
    commitmentId: created.result.id,
    effectId,
    createdAt: now,
  });
  return { materialization, event: created.event };
}

export async function evaluateSettlementOrRecourse(
  db: TasqDb,
  input: unknown,
  ctx: ServiceContext = {},
): Promise<SettlementView> {
  const parsed = SettlementEvaluationInputV1.parse(input);
  const policy = SettlementPolicyV1.parse(parsed.policy);
  const workspaceId = ctx.tenantId ?? LEGACY_DEFAULT_WORKSPACE_ID;
  const principalId = authenticatedPrincipal(ctx);
  const actor = ctx.actor ?? "system";
  const now = serviceNow(ctx, ctx.now);
  const retry = prepareIdempotency({ ...ctx, tenantId: workspaceId }, "settlement.evaluate", parsed, { now });
  const { view, events } = await runInTransaction(db, async (tx) => {
    const priorRetry = await findIdempotencyResult(tx, retry);
    if (priorRetry) {
      const replay = await getSettlementView(tx, priorRetry.resultId, workspaceId);
      if (!replay) throw new Error(`idempotency record points at missing settlement ${priorRetry.resultId}`);
      return { view: replay, events: [] as Event[] };
    }
    const decider = await getPrincipal(tx, principalId, workspaceId);
    if (!decider || decider.status !== "enabled") throw new Error("settlement decider is not enabled in workspace");
    const { basis, kind, parties } = await exactBasis({ tx, parsed, workspaceId, now });
    const rule = policy.rules.find((candidate) => matches(candidate, basis));
    if (!rule) throw new Error("no settlement policy rule matches the exact current facts");
    for (const entitlement of rule.entitlements) {
      if (!parties.has(entitlement.obligorPrincipalId) || !parties.has(entitlement.beneficiaryPrincipalId)) {
        throw new Error(`settlement entitlement ${entitlement.id} must remain between agreement parties`);
      }
      if (entitlement.effect && entitlement.effect.request.workspaceId !== workspaceId) {
        throw new Error(`settlement entitlement ${entitlement.id} effect workspace mismatch`);
      }
      if (entitlement.effect?.compensationOfEffectId && kind !== "recourse") {
        throw new Error("compensation effects are recourse, not initial settlement");
      }
      if (entitlement.effect?.compensationOfEffectId &&
          !basis.effects.some(({ id, status }) => id === entitlement.effect?.compensationOfEffectId && status === "committed")) {
        throw new Error("recourse compensation must reference a committed effect in the exact basis");
      }
    }
    let predecessor: Decision | null = null;
    if (parsed.supersedesDecisionId) {
      predecessor = await getSettlementDecision(tx, parsed.supersedesDecisionId, workspaceId);
      if (!predecessor) throw new Error("superseded settlement decision not found");
      if (predecessor.decisionKind !== kind || predecessor.basis.agreementOfferId !== basis.agreementOfferId ||
          predecessor.basis.obligationId !== basis.obligationId) {
        throw new Error("settlement supersession must preserve decision kind and agreement obligation");
      }
    }
    const id = uuidv7(now);
    if (predecessor) await retireSupersededMaterializations({
      tx, predecessor, workspaceId, actor, principalId, now, successorId: id,
    });
    const basisDigest = settlementBasisDigest(basis);
    const policyDigest = settlementPolicyDigest(policy);
    const withoutDigest = {
      contractVersion: "tasq.settlement-decision.v1" as const,
      id,
      workspaceId,
      decisionKind: kind,
      basis,
      basisDigest,
      policy,
      policyDigest,
      matchedRuleId: rule.id,
      classification: rule.classification,
      entitlements: rule.entitlements,
      supersedesDecisionId: predecessor?.id ?? null,
      decidedByPrincipalId: principalId,
      decidedAt: now,
    };
    const decision = SettlementDecisionV1.parse({
      ...withoutDigest,
      decisionDigest: settlementDecisionDigest(withoutDigest),
    });
    await tx.insert(settlementDecision).values({
      id: decision.id,
      tenantId: workspaceId,
      decisionKind: decision.decisionKind,
      agreementOfferId: basis.agreementOfferId,
      activationId: basis.activationId,
      obligationId: basis.obligationId,
      commitmentId: basis.task.id,
      basisJson: canonicalJson(basis),
      basisDigest,
      policyJson: canonicalJson(policy),
      policyDigest,
      matchedRuleId: decision.matchedRuleId,
      classification: decision.classification,
      entitlementsJson: canonicalJson(decision.entitlements),
      priorDecisionId: basis.priorSettlementDecisionId,
      supersedesDecisionId: decision.supersedesDecisionId,
      decidedByPrincipalId: principalId,
      decidedAt: now,
      decisionDigest: decision.decisionDigest,
    });
    const events: Event[] = [];
    for (const entitlement of decision.entitlements) {
      const materialized = await materializeEntitlement({
        tx, decision, entitlement, workspaceId, actor, principalId, now,
      });
      events.push(materialized.event);
    }
    await saveIdempotencyResult(tx, retry, {
      resultType: decision.decisionKind === "settlement" ? "settlement_decision" : "recourse_decision",
      resultId: decision.id,
      resultStatus: decision.classification,
    });
    const view = await getSettlementView(tx, decision.id, workspaceId);
    if (!view) throw new Error("settlement decision disappeared after materialization");
    return { view, events };
  });
  for (const event of events) emitAfterCommit(event);
  return view;
}

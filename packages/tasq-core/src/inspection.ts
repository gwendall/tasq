/**
 * Profile- and provider-neutral inspection over one commitment graph.
 *
 * This is an additive canonical read model. It intentionally does not reuse
 * frozen CLI v1 DTOs, whose historical `tenantId`/`taskId` and closed kind
 * aliases remain compatibility contracts.
 */

import { and, asc, desc, eq, inArray, or } from "drizzle-orm";
import {
  artifact,
  assignment,
  commitmentRelation,
  completionRecord,
  event,
  externalContextLink,
  externalRef,
  effect,
  effectApproval,
  effectReceipt,
  observation,
  principal,
  reconciliation,
  taskAttempt,
  taskClaim,
  taskEvidence,
  waitCondition,
  type Clock,
} from "@tasq-run/schema";
import type { TasqDb, TasqDbOrTx } from "./db.js";
import { getCommitment } from "./commitments.js";
import { serviceNow } from "./util/clock.js";

export const INSPECTION_CONTRACT_VERSION = "tasq.inspect.v1" as const;

export interface InspectCommitmentOptions {
  workspaceId: string;
  clock?: Clock;
  now?: number;
}

function json(value: string): Record<string, unknown> {
  return JSON.parse(value) as Record<string, unknown>;
}

function jsonArray(value: string): string[] {
  return JSON.parse(value) as string[];
}

/** Read a complete, resumable commitment graph without loading a domain runtime or planning profile. */
export async function inspectCommitment(
  db: TasqDb,
  commitmentId: string,
  options: InspectCommitmentOptions,
) {
  if (!options.workspaceId.trim()) throw new Error("workspaceId must not be blank");
  const inspectedAt = serviceNow(options, options.now);
  return db.transaction((tx) => inspectCommitmentInTransaction(
    tx,
    commitmentId,
    options,
    inspectedAt,
  ));
}

/** Transaction-safe internal read used by source-bound derived projections. */
export async function inspectCommitmentInTransaction(
  db: TasqDbOrTx,
  commitmentId: string,
  options: InspectCommitmentOptions,
  inspectedAt: number,
) {
  const commitment = await getCommitment(db, commitmentId, options.workspaceId);
  if (!commitment) return null;
  const workspace = eq(assignment.tenantId, options.workspaceId);

  const [assignmentRows, relationRows, claimRows, attemptRows, artifactRows, effectRows,
    evidenceRows, completionRows, conditionRows, contextLinkRows, eventRows, latestEventRows,
    latestObservationRows] = await Promise.all([
    db.select().from(assignment).where(and(workspace, eq(assignment.taskId, commitmentId)))
      .orderBy(asc(assignment.createdAt)),
    db.select().from(commitmentRelation).where(and(
      eq(commitmentRelation.tenantId, options.workspaceId),
      or(eq(commitmentRelation.fromTaskId, commitmentId), eq(commitmentRelation.toTaskId, commitmentId)),
    )).orderBy(asc(commitmentRelation.createdAt)),
    db.select().from(taskClaim).where(and(
      eq(taskClaim.tenantId, options.workspaceId), eq(taskClaim.taskId, commitmentId),
    )).orderBy(asc(taskClaim.createdAt)),
    db.select().from(taskAttempt).where(and(
      eq(taskAttempt.tenantId, options.workspaceId), eq(taskAttempt.taskId, commitmentId),
    )).orderBy(asc(taskAttempt.createdAt)),
    db.select().from(artifact).where(and(
      eq(artifact.tenantId, options.workspaceId), eq(artifact.taskId, commitmentId),
    )).orderBy(asc(artifact.createdAt)),
    db.select().from(effect).where(and(
      eq(effect.tenantId, options.workspaceId), eq(effect.taskId, commitmentId),
    )).orderBy(asc(effect.createdAt)),
    db.select().from(taskEvidence).where(and(
      eq(taskEvidence.tenantId, options.workspaceId), eq(taskEvidence.taskId, commitmentId),
    )).orderBy(asc(taskEvidence.createdAt)),
    db.select().from(completionRecord).where(and(
      eq(completionRecord.tenantId, options.workspaceId), eq(completionRecord.taskId, commitmentId),
    )).orderBy(asc(completionRecord.resultingRevision)),
    db.select().from(waitCondition).where(and(
      eq(waitCondition.tenantId, options.workspaceId), eq(waitCondition.taskId, commitmentId),
    )).orderBy(asc(waitCondition.createdAt)),
    db.select().from(externalContextLink).where(and(
      eq(externalContextLink.tenantId, options.workspaceId),
      eq(externalContextLink.taskId, commitmentId),
    )).orderBy(asc(externalContextLink.createdAt), asc(externalContextLink.id)),
    db.select().from(event).where(and(
      eq(event.tenantId, options.workspaceId), eq(event.entityType, "task"), eq(event.entityId, commitmentId),
    )).orderBy(asc(event.sequence)),
    db.select({ sequence: event.sequence }).from(event)
      .where(eq(event.tenantId, options.workspaceId)).orderBy(desc(event.sequence)).limit(1),
    db.select({ recordedAt: observation.recordedAt, id: observation.id }).from(observation)
      .where(eq(observation.tenantId, options.workspaceId))
      .orderBy(desc(observation.recordedAt), desc(observation.id)).limit(1),
  ]);

  const effectIds = effectRows.map((row) => row.id);
  const approvalRows = effectIds.length === 0 ? [] : await db.select().from(effectApproval)
    .where(and(
      eq(effectApproval.tenantId, options.workspaceId),
      inArray(effectApproval.effectId, effectIds),
    )).orderBy(asc(effectApproval.decidedAt));
  const receiptRows = effectIds.length === 0 ? [] : await db.select().from(effectReceipt)
    .where(and(
      eq(effectReceipt.tenantId, options.workspaceId),
      inArray(effectReceipt.effectId, effectIds),
    )).orderBy(asc(effectReceipt.recordedAt));

  const conditionIds = conditionRows.map((row) => row.id);
  const reconciliationRows = conditionIds.length === 0 ? [] : await db.select()
    .from(reconciliation).where(and(
      eq(reconciliation.tenantId, options.workspaceId),
      inArray(reconciliation.conditionId, conditionIds),
    )).orderBy(asc(reconciliation.reconciledAt));
  const observationIds = [...new Set(reconciliationRows.map((row) => row.observationId))];
  const observationRows = observationIds.length === 0 ? [] : await db.select()
    .from(observation).where(and(
      eq(observation.tenantId, options.workspaceId), inArray(observation.id, observationIds),
    )).orderBy(asc(observation.recordedAt), asc(observation.id));

  const recordIds = new Set<string>([
    commitmentId,
    ...assignmentRows.map((row) => row.id),
    ...relationRows.map((row) => row.id),
    ...claimRows.map((row) => row.id),
    ...attemptRows.map((row) => row.id),
    ...artifactRows.map((row) => row.id),
    ...evidenceRows.map((row) => row.id),
    ...completionRows.map((row) => row.id),
  ]);
  const allExternalRefs = await db.select().from(externalRef)
    .where(eq(externalRef.tenantId, options.workspaceId)).orderBy(asc(externalRef.createdAt));
  const externalRefRows = allExternalRefs.filter((row) => recordIds.has(row.recordId));

  const principalIds = new Set<string>();
  for (const row of assignmentRows) {
    principalIds.add(row.assignerPrincipalId);
    principalIds.add(row.assigneePrincipalId);
  }
  for (const row of relationRows) {
    principalIds.add(row.createdByPrincipalId);
    if (row.endedByPrincipalId) principalIds.add(row.endedByPrincipalId);
  }
  for (const row of claimRows) if (row.principalId) principalIds.add(row.principalId);
  for (const row of attemptRows) if (row.principalId) principalIds.add(row.principalId);
  for (const row of artifactRows) principalIds.add(row.createdByPrincipalId);
  for (const row of effectRows) principalIds.add(row.createdByPrincipalId);
  for (const row of approvalRows) principalIds.add(row.approverPrincipalId);
  for (const row of receiptRows) principalIds.add(row.recordedByPrincipalId);
  for (const row of evidenceRows) if (row.principalId) principalIds.add(row.principalId);
  for (const row of completionRows) principalIds.add(row.decidedByPrincipalId);
  for (const row of contextLinkRows) principalIds.add(row.principalId);
  for (const row of externalRefRows) principalIds.add(row.createdByPrincipalId);
  for (const row of eventRows) if (row.principalId) principalIds.add(row.principalId);
  const principalRows = principalIds.size === 0 ? [] : await db.select().from(principal).where(and(
    eq(principal.tenantId, options.workspaceId), inArray(principal.id, [...principalIds]),
  )).orderBy(asc(principal.createdAt));

  return {
    contractVersion: INSPECTION_CONTRACT_VERSION,
    inspectedAt,
    workspaceId: options.workspaceId,
    commitment,
    principals: principalRows.map((row) => ({
      id: row.id, workspaceId: row.tenantId, kind: row.kind, displayName: row.displayName,
      status: row.status, revision: row.revision, metadata: json(row.metadata),
      createdAt: row.createdAt, updatedAt: row.updatedAt,
    })),
    assignments: assignmentRows.map(({ tenantId: workspaceId, taskId: commitmentId, ...row }) => ({
      ...row, workspaceId, commitmentId,
    })),
    relations: relationRows.map(({ tenantId: workspaceId, fromTaskId, toTaskId, ...row }) => ({
      ...row, workspaceId, fromCommitmentId: fromTaskId, toCommitmentId: toTaskId,
    })),
    claims: claimRows.map(({ tenantId: workspaceId, taskId: commitmentId, actor, metadata, ...row }) => ({
      ...row, workspaceId, commitmentId, actorAlias: actor, metadata: json(metadata),
    })),
    attempts: attemptRows.map(({ tenantId: workspaceId, taskId: commitmentId, actor, metadata, ...row }) => ({
      ...row, workspaceId, commitmentId, actorAlias: actor, metadata: json(metadata),
    })),
    artifacts: artifactRows.map(({ tenantId: workspaceId, taskId: commitmentId, typeUri, schemaVersion, metadata, ...row }) => ({
      ...row, workspaceId, commitmentId, metadata: json(metadata),
      type: { uri: typeUri, schemaVersion },
    })),
    effects: effectRows.map(({ tenantId: workspaceId, taskId: commitmentId, canonicalRequest,
      effectTypeUri, effectSchemaVersion, connectorOperationUri, connectorOperationVersion,
      connectorContractDigest, connectorInstanceRef, connectorBindingDigest, ...row }) => ({
      ...row, workspaceId, commitmentId, canonicalRequest,
      request: JSON.parse(canonicalRequest) as Record<string, unknown>,
      type: { uri: effectTypeUri, schemaVersion: effectSchemaVersion },
      connector: {
        operationUri: connectorOperationUri,
        operationVersion: connectorOperationVersion,
        contractDigest: connectorContractDigest,
        instanceRef: connectorInstanceRef,
        bindingDigest: connectorBindingDigest,
      },
    })),
    effectApprovals: approvalRows.map(({ tenantId: workspaceId, scope, limits, verification, ...row }) => ({
      ...row, workspaceId, scope: json(scope), limits: json(limits), verification: json(verification),
    })),
    effectReceipts: receiptRows.map(({ tenantId: workspaceId, canonicalReport, coverage, verification, ...row }) => ({
      ...row, workspaceId, canonicalReport, report: json(canonicalReport),
      coverage: JSON.parse(coverage) as string[], verification: json(verification),
    })),
    evidence: evidenceRows.map(({ tenantId: workspaceId, taskId: commitmentId, actor, metadata, ...row }) => ({
      ...row, workspaceId, commitmentId, actorAlias: actor, metadata: json(metadata),
    })),
    completionRecords: completionRows.map(({ tenantId: workspaceId, taskId: commitmentId, evidenceIds,
      completionPolicyUri, completionPolicyVersion, ...row }) => ({
      ...row, workspaceId, commitmentId, evidenceIds: jsonArray(evidenceIds),
      policy: { uri: completionPolicyUri, version: completionPolicyVersion },
    })),
    conditions: conditionRows.map(({ tenantId: workspaceId, taskId: commitmentId, kind, typeUri,
      schemaVersion, evaluatorUri, evaluatorVersion, evaluatorImplementationDigest,
      parameters, fallbackSpec, ...row }) => ({
      ...row, workspaceId, commitmentId, parameters: json(parameters),
      fallbackSpec: fallbackSpec == null ? null : json(fallbackSpec),
      type: { uri: typeUri, schemaVersion },
      evaluator: {
        uri: evaluatorUri,
        version: evaluatorVersion,
        implementationDigest: evaluatorImplementationDigest,
      },
      compatibilityKind: kind,
    })),
    observations: observationRows.map(({ tenantId: workspaceId, kind, typeUri, schemaVersion,
      payload, metadata, ...row }) => ({
      ...row, workspaceId, payload: json(payload), metadata: json(metadata),
      type: { uri: typeUri, schemaVersion },
      compatibilityKind: kind,
    })),
    reconciliations: reconciliationRows.map(({ tenantId: workspaceId, matcherKind, evaluatorUri,
      evaluatorVersion, evaluatorImplementationDigest, ...row }) => ({
      ...row, workspaceId,
      evaluator: {
        uri: evaluatorUri,
        version: evaluatorVersion,
        implementationDigest: evaluatorImplementationDigest,
      },
      compatibilityKind: matcherKind,
    })),
    externalRefs: externalRefRows.map(({ tenantId: workspaceId, metadata, ...row }) => ({
      ...row, workspaceId, metadata: json(metadata),
    })),
    externalContextLinks: (() => {
      const superseded = new Set(contextLinkRows.flatMap((row) =>
        row.supersedesLinkId === null ? [] : [row.supersedesLinkId]));
      return contextLinkRows.map((row) => ({
        contractVersion: "tasq.external-context-link.v1" as const,
        id: row.id,
        workspaceId: row.tenantId,
        commitmentId: row.taskId,
        purposeUri: row.purposeUri,
        action: row.action as "attach" | "detach",
        supersedesLinkId: row.supersedesLinkId,
        target: {
          system: row.system,
          resourceType: row.resourceType,
          externalId: row.externalId,
          url: row.url,
          version: row.version,
          digest: row.digest,
        },
        binding: row.version !== null || row.digest !== null ? "pinned" as const : "floating" as const,
        actorAlias: row.actor,
        principalId: row.principalId,
        createdAt: row.createdAt,
        state: superseded.has(row.id)
          ? "superseded" as const
          : row.action === "attach" ? "active" as const : "detached" as const,
      }));
    })(),
    events: eventRows.map(({ tenantId: workspaceId, actor, payload, entityType, entityId, ...row }) => ({
      ...row, workspaceId, recordType: entityType === "task" ? "commitment" : entityType,
      recordId: entityId, actorAlias: actor, payload: json(payload),
    })),
    resumeCursor: {
      afterEventSequence: latestEventRows[0]?.sequence ?? 0,
      afterObservation: latestObservationRows[0] ?? null,
    },
  };
}

export type CommitmentInspection = NonNullable<Awaited<ReturnType<typeof inspectCommitment>>>;

/** Small deterministic human view over the canonical snapshot. */
export function renderCommitmentInspection(snapshot: CommitmentInspection): string {
  const lines = [
    `# ${snapshot.commitment.title}`,
    "",
    `- Commitment: \`${snapshot.commitment.id}\``,
    `- Workspace: \`${snapshot.workspaceId}\``,
    `- Status: **${snapshot.commitment.status}** (revision ${snapshot.commitment.revision})`,
    `- Completion policy: \`${snapshot.commitment.completionPolicy}\``,
    `- Assignments / claims / attempts: ${snapshot.assignments.length} / ${snapshot.claims.length} / ${snapshot.attempts.length}`,
    `- Artifacts / evidence / completions: ${snapshot.artifacts.length} / ${snapshot.evidence.length} / ${snapshot.completionRecords.length}`,
    `- External context links: ${snapshot.externalContextLinks.length}`,
    `- Effects / approvals / receipts: ${snapshot.effects.length} / ${snapshot.effectApprovals.length} / ${snapshot.effectReceipts.length}`,
    `- Conditions / observations / reconciliations: ${snapshot.conditions.length} / ${snapshot.observations.length} / ${snapshot.reconciliations.length}`,
    "",
  ];
  for (const condition of snapshot.conditions) {
    lines.push(`## Condition ${condition.id}`, "", `- Type: \`${condition.type.uri}@${condition.type.schemaVersion}\``,
      `- Status: **${condition.status}**`, `- Evaluator: \`${condition.evaluator.uri}@${condition.evaluator.version}\``, "");
  }
  lines.push("## Resume cursor", "", `- Event sequence: ${snapshot.resumeCursor.afterEventSequence}`,
    `- Observation: ${snapshot.resumeCursor.afterObservation == null ? "none" : `${snapshot.resumeCursor.afterObservation.recordedAt}/${snapshot.resumeCursor.afterObservation.id}`}`,
    "");
  return `${lines.join("\n")}\n`;
}

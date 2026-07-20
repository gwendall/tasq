import { eq } from "drizzle-orm";
import {
  area,
  artifact,
  assignment,
  commitmentRelation,
  completionRecord,
  commitmentSummary,
  event,
  externalContextLink,
  externalRef,
  effect,
  effectApproval,
  effectReceipt,
  goal,
  principal,
  project,
  task,
  taskAttempt,
  taskClaim,
  taskDependency,
  taskEvidence,
  extensionEvaluator,
  extensionRelease,
  extensionType,
  waitCondition,
  observation,
  observationRoute,
  reconciliation,
  idempotencyKey,
  Effect as EffectZ,
  EffectApproval as EffectApprovalZ,
  EffectReceipt as EffectReceiptZ,
  EFFECT_RECEIPT_COVERAGE,
  canonicalizeEffectJson,
  deriveEffectDispatchKey,
  prepareEffectRequest,
  prepareEffectReceiptReport,
  Observation as ObservationZ,
  Reconciliation as ReconciliationZ,
  WaitCondition as WaitConditionZ,
  IdempotencyRecord as IdempotencyRecordZ,
  MAX_TASK_DEPTH,
  CommitmentSummarySourceRefs,
} from "@tasq/schema";
import {
  OBSERVATION_KIND_TYPE_URIS,
  REFERENCE_EVALUATOR_IMPLEMENTATION_DIGEST,
  WAIT_KIND_EXTENSION_IDENTITIES,
} from "@tasq-internal/reference-extension";
import type { Client } from "@libsql/client";
import type { TasqDb } from "./db.js";
import { evaluateWaitObservation, observationRouteKeys } from "./service/matchers.js";
import {
  deriveReferenceObservationSubjectRef,
  parseReferenceObservation,
} from "./service/reference-runtime.js";
import { canonicalJson, sha256Digest } from "./service/extensions.js";
import { inspectCommitment } from "./inspection.js";
import {
  COMMITMENT_SUMMARY_EVENT_TYPE,
  deriveCommitmentSummarySource,
} from "./service/summaries.js";

export interface DoctorIssue {
  code: string;
  entityType?: "area" | "goal" | "project" | "task" | "summary" | "context_link" | "principal" | "assignment" | "relation" | "artifact" | "completion" | "external_ref" | "event" | "observation" | "reconciliation" | "extension" | "effect" | "effect_approval" | "effect_receipt" | "idempotency";
  entityId?: string;
  message: string;
}

export interface DoctorReport {
  ok: boolean;
  sqliteIntegrity: string;
  foreignKeyViolations: number;
  issues: DoctorIssue[];
}

/** Read-only structural audit of the store and its cross-row invariants. */
export async function diagnoseStore(
  db: TasqDb,
  client: Client,
  tenantId = "gwendall",
): Promise<DoctorReport> {
  const integrity = await client.execute("PRAGMA integrity_check");
  const sqliteIntegrity = String(integrity.rows[0]?.["integrity_check"] ?? "unknown");
  const foreignKeys = await client.execute("PRAGMA foreign_key_check");
  const issues: DoctorIssue[] = [];

  const [areas, goals, projects, tasks, summaries, contextLinks, dependencies, claims, attempts, evidence, principals, assignments, relations, artifacts, externalRefs, completions, events, releases, extensionTypes, evaluators, waits, observations, routes, reconciliations, idempotency, effects, approvals, receipts] = await Promise.all([
    db.select().from(area).where(eq(area.tenantId, tenantId)),
    db.select().from(goal).where(eq(goal.tenantId, tenantId)),
    db.select().from(project).where(eq(project.tenantId, tenantId)),
    db.select().from(task).where(eq(task.tenantId, tenantId)),
    db.select().from(commitmentSummary).where(eq(commitmentSummary.tenantId, tenantId)),
    db.select().from(externalContextLink).where(eq(externalContextLink.tenantId, tenantId)),
    db.select().from(taskDependency).where(eq(taskDependency.tenantId, tenantId)),
    db.select().from(taskClaim).where(eq(taskClaim.tenantId, tenantId)),
    db.select().from(taskAttempt).where(eq(taskAttempt.tenantId, tenantId)),
    db.select().from(taskEvidence).where(eq(taskEvidence.tenantId, tenantId)),
    db.select().from(principal).where(eq(principal.tenantId, tenantId)),
    db.select().from(assignment).where(eq(assignment.tenantId, tenantId)),
    db.select().from(commitmentRelation).where(eq(commitmentRelation.tenantId, tenantId)),
    db.select().from(artifact).where(eq(artifact.tenantId, tenantId)),
    db.select().from(externalRef).where(eq(externalRef.tenantId, tenantId)),
    db.select().from(completionRecord).where(eq(completionRecord.tenantId, tenantId)),
    db.select().from(event).where(eq(event.tenantId, tenantId)),
    db.select().from(extensionRelease).where(eq(extensionRelease.tenantId, tenantId)),
    db.select().from(extensionType).where(eq(extensionType.tenantId, tenantId)),
    db.select().from(extensionEvaluator).where(eq(extensionEvaluator.tenantId, tenantId)),
    db.select().from(waitCondition).where(eq(waitCondition.tenantId, tenantId)),
    db.select().from(observation).where(eq(observation.tenantId, tenantId)),
    db.select().from(observationRoute).where(eq(observationRoute.tenantId, tenantId)),
    db.select().from(reconciliation).where(eq(reconciliation.tenantId, tenantId)),
    db.select().from(idempotencyKey).where(eq(idempotencyKey.tenantId, tenantId)),
    db.select().from(effect).where(eq(effect.tenantId, tenantId)),
    db.select().from(effectApproval).where(eq(effectApproval.tenantId, tenantId)),
    db.select().from(effectReceipt).where(eq(effectReceipt.tenantId, tenantId)),
  ]);
  const areaById = new Map(areas.map((row) => [row.id, row]));
  const goalById = new Map(goals.map((row) => [row.id, row]));
  const projectById = new Map(projects.map((row) => [row.id, row]));
  const taskById = new Map(tasks.map((row) => [row.id, row]));
  const claimById = new Map(claims.map((row) => [row.id, row]));
  const attemptById = new Map(attempts.map((row) => [row.id, row]));
  const evidenceById = new Map(evidence.map((row) => [row.id, row]));
  const principalById = new Map(principals.map((row) => [row.id, row]));
  const assignmentById = new Map(assignments.map((row) => [row.id, row]));
  const relationById = new Map(relations.map((row) => [row.id, row]));
  const artifactById = new Map(artifacts.map((row) => [row.id, row]));
  const completionById = new Map(completions.map((row) => [row.id, row]));
  const releaseById = new Map(releases.map((row) => [row.id, row]));
  const extensionTypeByIdentity = new Map(extensionTypes.map((row) => [
    `${row.typeUri}@${row.schemaVersion}`,
    row,
  ]));
  const evaluatorByIdentity = new Map(evaluators.map((row) => [
    `${row.evaluatorUri}@${row.evaluatorVersion}`,
    row,
  ]));
  const waitById = new Map(waits.map((row) => [row.id, row]));
  const observationById = new Map(observations.map((row) => [row.id, row]));
  const effectById = new Map(effects.map((row) => [row.id, row]));
  const approvalById = new Map(approvals.map((row) => [row.id, row]));
  const receiptById = new Map(receipts.map((row) => [row.id, row]));

  const summaryById = new Map(summaries.map((row) => [row.id, row]));
  const summaryParents = new Set(summaries.flatMap((row) =>
    row.supersedesSummaryId ? [row.supersedesSummaryId] : []));
  const rawEventSequencesByTask = new Map<string, number[]>();
  for (const row of events) {
    if (row.entityType !== "task" || row.eventType === COMMITMENT_SUMMARY_EVENT_TYPE) continue;
    const sequences = rawEventSequencesByTask.get(row.entityId);
    if (sequences) sequences.push(row.sequence);
    else rawEventSequencesByTask.set(row.entityId, [row.sequence]);
  }
  const externalRefById = new Map(externalRefs.map((row) => [row.id, row]));
  const contextLinkById = new Map(contextLinks.map((row) => [row.id, row]));

  for (const row of summaries) {
    const linkedTask = taskById.get(row.taskId);
    if (!linkedTask) {
      issues.push(issue("summary_task_mismatch", "summary", row.id,
        `Summary ${row.id} has a missing/cross-workspace commitment`));
    }
    if (!principalById.has(row.principalId)) {
      issues.push(issue("summary_principal_mismatch", "summary", row.id,
        `Summary ${row.id} has a missing/cross-workspace principal`));
    }
    if (sha256Digest(`tasq.commitment-summary.v1\0${canonicalJson({ summary: row.summary })}`) !==
        row.summaryDigest) {
      issues.push(issue("summary_digest_mismatch", "summary", row.id,
        `Summary ${row.id} text digest drifted`));
    }
    let refs: ReturnType<typeof CommitmentSummarySourceRefs.parse> | null = null;
    try {
      refs = CommitmentSummarySourceRefs.parse(JSON.parse(row.sourceRefs));
    } catch (error) {
      issues.push(issue("summary_source_refs_invalid", "summary", row.id,
        `Summary ${row.id} has invalid source references: ${error instanceof Error ? error.message : String(error)}`));
    }
    if (refs) {
      const sourceAudit = rawEventSequencesByTask.get(row.taskId) ?? [];
      const sourceEventsThroughFrontier = sourceAudit.filter(
        (sequence) => sequence <= refs!.audit.throughSequence,
      );
      const invalid = refs.inspect.commitmentId !== row.taskId ||
        refs.audit.entityType !== "task" || refs.audit.entityId !== row.taskId ||
        refs.audit.throughSequence !== row.sourceEventSequence ||
        refs.audit.eventCount !== sourceEventsThroughFrontier.length ||
        (refs.audit.eventCount === 0 ? refs.audit.throughSequence !== 0 :
          !sourceAudit.includes(refs.audit.throughSequence)) ||
        refs.evidenceIds.some((id) => evidenceById.get(id)?.taskId !== row.taskId) ||
        refs.artifactIds.some((id) => artifactById.get(id)?.taskId !== row.taskId) ||
        refs.completionRecordIds.some((id) => completionById.get(id)?.taskId !== row.taskId) ||
        refs.effectReceiptIds.some((id) => receiptById.get(id)?.taskId !== row.taskId) ||
        refs.externalRefIds.some((id) => {
          const reference = externalRefById.get(id);
          return !reference || reference.recordType !== "task" || reference.recordId !== row.taskId;
        }) || (refs.externalContextLinkIds ?? []).some((id) =>
          contextLinkById.get(id)?.taskId !== row.taskId);
      if (invalid) {
        issues.push(issue("summary_source_ref_mismatch", "summary", row.id,
          `Summary ${row.id} references missing or foreign raw records`));
      }
    }
    if (row.supersedesSummaryId) {
      const prior = summaryById.get(row.supersedesSummaryId);
      if (!prior || prior.taskId !== row.taskId) {
        issues.push(issue("summary_chain_mismatch", "summary", row.id,
          `Summary ${row.id} supersedes a missing or foreign summary`));
      }
    }
    const seen = new Set<string>();
    let cursor: string | null = row.id;
    while (cursor) {
      if (seen.has(cursor)) {
        issues.push(issue("summary_chain_cycle", "summary", row.id,
          `Summary correction cycle reaches ${cursor}`));
        break;
      }
      seen.add(cursor);
      cursor = summaryById.get(cursor)?.supersedesSummaryId ?? null;
    }

    const rawSequences = rawEventSequencesByTask.get(row.taskId) ?? [];
    const rawFrontier = rawSequences.reduce((maximum, sequence) =>
      Math.max(maximum, sequence), 0);
    const currentLeaf = !summaryParents.has(row.id) && linkedTask &&
      linkedTask.deletedAt == null && linkedTask.status === row.sourceStatus &&
      linkedTask.revision === row.sourceRevision && rawFrontier === row.sourceEventSequence;
    if (currentLeaf) {
      const snapshot = await inspectCommitment(db, row.taskId, { workspaceId: tenantId, now: 0 });
      if (!snapshot) continue;
      const expected = deriveCommitmentSummarySource(snapshot);
      if (expected.digest !== row.sourceDigest ||
          canonicalJson(expected.refs) !== canonicalJson(refs)) {
        issues.push(issue("summary_current_source_mismatch", "summary", row.id,
          `Current summary ${row.id} digest/references do not match canonical inspection`));
      }
    }
  }

  for (const row of contextLinks) {
    if (!taskById.has(row.taskId)) {
      issues.push(issue("context_link_task_mismatch", "context_link", row.id,
        `External context link ${row.id} has a missing/cross-workspace commitment`));
    }
    if (!principalById.has(row.principalId)) {
      issues.push(issue("context_link_principal_mismatch", "context_link", row.id,
        `External context link ${row.id} has a missing/cross-workspace principal`));
    }
    if (row.supersedesLinkId === null) {
      if (row.action !== "attach") {
        issues.push(issue("context_link_root_detach", "context_link", row.id,
          `External context link ${row.id} detaches without an attached parent`));
      }
    } else {
      const parent = contextLinkById.get(row.supersedesLinkId);
      if (!parent || parent.taskId !== row.taskId || parent.purposeUri !== row.purposeUri ||
          parent.system !== row.system || parent.resourceType !== row.resourceType ||
          parent.externalId !== row.externalId) {
        issues.push(issue("context_link_chain_mismatch", "context_link", row.id,
          `External context link ${row.id} supersedes a missing or different target`));
      }
      if (row.action === "detach" && parent?.action === "detach") {
        issues.push(issue("context_link_duplicate_detach", "context_link", row.id,
          `External context link ${row.id} detaches an already detached target`));
      }
    }
    const seen = new Set<string>();
    let cursor: string | null = row.id;
    while (cursor) {
      if (seen.has(cursor)) {
        issues.push(issue("context_link_chain_cycle", "context_link", row.id,
          `External context-link chain cycles at ${cursor}`));
        break;
      }
      seen.add(cursor);
      cursor = contextLinkById.get(cursor)?.supersedesLinkId ?? null;
    }
  }
  const routesByObservation = new Map<string, typeof routes>();
  for (const route of routes) {
    routesByObservation.set(route.observationId, [
      ...(routesByObservation.get(route.observationId) ?? []),
      route,
    ]);
  }

  for (const row of idempotency) {
    const parsed = IdempotencyRecordZ.safeParse(row);
    if (!parsed.success) {
      issues.push(issue(
        "idempotency_record_invalid",
        "idempotency",
        `${row.callerScope}/${row.operation}/${row.key}`,
        parsed.error.issues.map((value) => `${value.path.join(".")}: ${value.message}`).join("; "),
      ));
    }
  }

  for (const row of goals) {
    const parent = areaById.get(row.areaId);
    if (row.deletedAt == null && (!parent || parent.deletedAt != null)) {
      issues.push(issue("live_goal_dead_area", "goal", row.id, `Live goal points at missing/deleted area ${row.areaId}`));
    }
  }

  for (const row of projects) {
    if (row.deletedAt != null) continue;
    if (row.goalId) {
      const parent = goalById.get(row.goalId);
      if (!parent || parent.deletedAt != null) {
        issues.push(issue("live_project_dead_goal", "project", row.id, `Live project points at missing/deleted goal ${row.goalId}`));
      } else if (row.areaId !== parent.areaId) {
        issues.push(issue("project_scope_mismatch", "project", row.id, `Project area ${row.areaId ?? "null"} differs from goal area ${parent.areaId}`));
      }
    } else if (row.areaId && areaById.get(row.areaId)?.deletedAt != null) {
      issues.push(issue("live_project_dead_area", "project", row.id, `Live project points at deleted area ${row.areaId}`));
    }
  }

  for (const row of tasks) {
    if (row.deletedAt != null) continue;
    if (row.status === "in_progress" && row.startedAt == null) {
      issues.push(issue("missing_started_at", "task", row.id, "in_progress task has no startedAt"));
    }
    if (row.status === "done" && row.completedAt == null) {
      issues.push(issue("missing_completed_at", "task", row.id, "done task has no completedAt"));
    }
    if (row.completionMode === "evidence" && !row.successCriteria?.trim()) {
      issues.push(issue("evidence_mode_without_criteria", "task", row.id, "Evidence-backed task has no success criteria"));
    }
    if (row.parentTaskId) {
      const parent = taskById.get(row.parentTaskId);
      if (!parent || parent.deletedAt != null) {
        issues.push(issue("live_task_dead_parent", "task", row.id, `Live task points at missing/deleted parent ${row.parentTaskId}`));
      } else if (
        row.projectId !== parent.projectId ||
        row.goalId !== parent.goalId ||
        row.areaId !== parent.areaId
      ) {
        issues.push(issue("task_parent_scope_mismatch", "task", row.id, "Child scope differs from parent scope"));
      }
      continue;
    }
    if (row.projectId) {
      const parent = projectById.get(row.projectId);
      if (!parent || parent.deletedAt != null) {
        issues.push(issue("live_task_dead_project", "task", row.id, `Live task points at missing/deleted project ${row.projectId}`));
      } else if (row.goalId !== parent.goalId || row.areaId !== parent.areaId) {
        issues.push(issue("task_project_scope_mismatch", "task", row.id, "Task scope differs from project scope"));
      }
    } else if (row.goalId) {
      const parent = goalById.get(row.goalId);
      if (!parent || parent.deletedAt != null) {
        issues.push(issue("live_task_dead_goal", "task", row.id, `Live task points at missing/deleted goal ${row.goalId}`));
      } else if (row.areaId !== parent.areaId) {
        issues.push(issue("task_goal_scope_mismatch", "task", row.id, "Task area differs from goal area"));
      }
    } else if (row.areaId && areaById.get(row.areaId)?.deletedAt != null) {
      issues.push(issue("live_task_dead_area", "task", row.id, `Live task points at deleted area ${row.areaId}`));
    }
  }

  for (const row of tasks) {
    let cursor: string | null = row.id;
    const seen = new Set<string>();
    let depth = 0;
    while (cursor) {
      if (seen.has(cursor)) {
        issues.push(issue("task_hierarchy_cycle", "task", row.id, `Hierarchy cycle reaches ${cursor}`));
        break;
      }
      seen.add(cursor);
      depth++;
      cursor = taskById.get(cursor)?.parentTaskId ?? null;
    }
    if (depth > MAX_TASK_DEPTH) {
      issues.push(issue("task_depth_exceeded", "task", row.id, `Task depth ${depth} exceeds ${MAX_TASK_DEPTH}`));
    }
  }

  const liveBlocks = dependencies.filter(
    (edge) => edge.deletedAt == null && edge.type === "blocks",
  );
  const graph = new Map<string, string[]>();
  for (const edge of liveBlocks) {
    graph.set(edge.fromTaskId, [...(graph.get(edge.fromTaskId) ?? []), edge.toTaskId]);
  }
  for (const start of graph.keys()) {
    if (dependencyCycleFrom(start, graph)) {
      issues.push(issue("dependency_cycle", "task", start, "Live blocks dependencies contain a cycle"));
    }
  }

  const universalGraph = new Map<string, string[]>();
  for (const row of relations) {
    if (!taskById.has(row.fromTaskId) || !taskById.has(row.toTaskId)) {
      issues.push(issue("relation_task_mismatch", "relation", row.id, `Relation ${row.id} has a missing/cross-workspace endpoint`));
    }
    if (!principalById.has(row.createdByPrincipalId) || (row.endedByPrincipalId && !principalById.has(row.endedByPrincipalId))) {
      issues.push(issue("relation_principal_mismatch", "relation", row.id, `Relation ${row.id} has a missing/cross-workspace principal`));
    }
    if (row.relationType === "depends_on" && row.endedAt == null) {
      universalGraph.set(row.fromTaskId, [...(universalGraph.get(row.fromTaskId) ?? []), row.toTaskId]);
    }
  }
  for (const start of universalGraph.keys()) {
    if (dependencyCycleFrom(start, universalGraph)) {
      issues.push(issue("relation_cycle", "task", start, "Live universal depends_on relations contain a cycle"));
    }
  }

  const liveLegacyKeys = new Set(dependencies.filter((row) => row.deletedAt == null).map((row) =>
    `${row.fromTaskId}\u0000${row.type === "blocks" ? "depends_on" : row.type}\u0000${row.toTaskId}`));
  const liveUniversalCompatKeys = new Set(relations.filter((row) =>
    row.endedAt == null && ["depends_on", "relates_to", "duplicates"].includes(row.relationType)).map((row) =>
      `${row.fromTaskId}\u0000${row.relationType}\u0000${row.toTaskId}`));
  for (const key of new Set([...liveLegacyKeys, ...liveUniversalCompatKeys])) {
    if (liveLegacyKeys.has(key) !== liveUniversalCompatKeys.has(key)) {
      issues.push(issue("relation_compatibility_drift", "relation", key, "Legacy dependency adapter differs from the universal relation graph"));
    }
  }

  for (const row of assignments) {
    if (!taskById.has(row.taskId)) issues.push(issue("assignment_task_mismatch", "assignment", row.id, `Assignment ${row.id} has a missing/cross-workspace task`));
    if (!principalById.has(row.assignerPrincipalId) || !principalById.has(row.assigneePrincipalId)) {
      issues.push(issue("assignment_principal_mismatch", "assignment", row.id, `Assignment ${row.id} has a missing/cross-workspace principal`));
    }
  }

  for (const row of artifacts) {
    if (!taskById.has(row.taskId)) issues.push(issue("artifact_task_mismatch", "artifact", row.id, `Artifact ${row.id} has a missing/cross-workspace task`));
    if (!principalById.has(row.createdByPrincipalId)) issues.push(issue("artifact_principal_mismatch", "artifact", row.id, `Artifact ${row.id} has a missing/cross-workspace principal`));
    if (row.attemptId && attemptById.get(row.attemptId)?.taskId !== row.taskId) {
      issues.push(issue("artifact_attempt_mismatch", "artifact", row.id, `Artifact ${row.id} attempt belongs to another task`));
    }
  }

  const completionsByTaskRevision = new Set<string>();
  for (const row of completions) {
    completionsByTaskRevision.add(`${row.taskId}\u0000${row.resultingRevision}`);
    const linkedTask = taskById.get(row.taskId);
    if (!linkedTask || row.resultingRevision > linkedTask.revision) {
      issues.push(issue("completion_task_mismatch", "completion", row.id, `Completion ${row.id} has an impossible task revision`));
    }
    if (!principalById.has(row.decidedByPrincipalId)) issues.push(issue("completion_principal_mismatch", "completion", row.id, `Completion ${row.id} has a missing/cross-workspace principal`));
    let evidenceIds: unknown = row.evidenceIds;
    try { evidenceIds = typeof evidenceIds === "string" ? JSON.parse(evidenceIds) : evidenceIds; } catch { evidenceIds = null; }
    if (!Array.isArray(evidenceIds) || evidenceIds.some((id) => evidenceById.get(String(id))?.taskId !== row.taskId)) {
      issues.push(issue("completion_evidence_mismatch", "completion", row.id, `Completion ${row.id} has invalid or foreign evidence`));
    }
  }
  for (const row of tasks) {
    if (row.status === "done" && !completionsByTaskRevision.has(`${row.id}\u0000${row.revision}`)) {
      issues.push(issue("missing_completion_record", "task", row.id, `Done task revision ${row.revision} has no completion record`));
    }
  }

  const recordSets: Record<string, Set<string>> = {
    principal: new Set(principalById.keys()), commitment: new Set(taskById.keys()),
    assignment: new Set(assignmentById.keys()), relation: new Set(relationById.keys()),
    claim: new Set(claims.map((row) => row.id)), attempt: new Set(attemptById.keys()),
    artifact: new Set(artifactById.keys()), evidence: new Set(evidenceById.keys()),
    completion: new Set(completionById.keys()),
  };
  for (const row of externalRefs) {
    if (!recordSets[row.recordType]?.has(row.recordId)) {
      issues.push(issue("external_ref_target_mismatch", "external_ref", row.id, `External ref ${row.id} target is missing or unsupported`));
    }
    if (!principalById.has(row.createdByPrincipalId)) issues.push(issue("external_ref_principal_mismatch", "external_ref", row.id, `External ref ${row.id} has a missing/cross-workspace principal`));
  }

  for (const [kind, rows] of [["event", events], ["claim", claims], ["attempt", attempts], ["evidence", evidence]] as const) {
    for (const row of rows) {
      if (!row.principalId || !principalById.has(row.principalId)) {
        issues.push(issue(`${kind}_principal_mismatch`, kind === "event" ? "event" : "task", "taskId" in row ? row.taskId : row.id, `${kind} ${row.id} lacks stable workspace attribution`));
      }
    }
  }

  for (const row of claims) {
    const linkedTask = taskById.get(row.taskId);
    if (!linkedTask) {
      issues.push(issue("claim_task_mismatch", "task", row.taskId, `Claim ${row.id} does not point at a task in tenant ${tenantId}`));
    }
    if (row.heartbeatAt < row.acquiredAt || row.expiresAt <= row.heartbeatAt) {
      issues.push(issue("claim_invalid_chronology", "task", row.taskId, `Claim ${row.id} has incoherent acquisition/heartbeat/expiry times`));
    }
    if (
      (row.releasedAt == null) !== (row.releaseReason == null) ||
      (row.releasedAt != null && row.releasedAt < row.acquiredAt) ||
      (row.releaseReason != null && row.releaseReason.trim().length === 0)
    ) {
      issues.push(issue("claim_invalid_release", "task", row.taskId, `Claim ${row.id} has incoherent release state`));
    }
    if (row.releasedAt == null && (!linkedTask || linkedTask.deletedAt != null)) {
      issues.push(issue("live_claim_dead_task", "task", row.taskId, `Unreleased claim ${row.id} points at a missing/deleted task`));
    }
    if (
      row.releasedAt == null &&
      linkedTask &&
      (linkedTask.status === "done" || linkedTask.status === "cancelled")
    ) {
      issues.push(issue("live_claim_terminal_task", "task", row.taskId, `Unreleased claim ${row.id} points at terminal task`));
    }
  }

  const claimsByTask = new Map<string, typeof claims>();
  for (const row of claims) {
    claimsByTask.set(row.taskId, [...(claimsByTask.get(row.taskId) ?? []), row]);
  }
  for (const [taskId, history] of claimsByTask) {
    const fences = new Set<number>();
    for (const row of history.sort((a, b) => a.fence - b.fence)) {
      if (fences.has(row.fence)) {
        issues.push(issue("claim_duplicate_fence", "task", taskId, `Fence ${row.fence} is reused by task claims`));
        break;
      }
      fences.add(row.fence);
    }
  }

  for (const row of attempts) {
    const linkedTask = taskById.get(row.taskId);
    const terminal = row.status === "succeeded" || row.status === "failed" || row.status === "cancelled";
    if (!linkedTask) {
      issues.push(issue("attempt_task_mismatch", "task", row.taskId, `Attempt ${row.id} does not point at a task in tenant ${tenantId}`));
    }
    if (terminal && row.endedAt == null) {
      issues.push(issue("terminal_attempt_without_end", "task", row.taskId, `Terminal attempt ${row.id} has no endedAt`));
    }
    if (!terminal && row.endedAt != null) {
      issues.push(issue("active_attempt_with_end", "task", row.taskId, `Active attempt ${row.id} unexpectedly has endedAt`));
    }
    if (row.endedAt != null && row.endedAt < row.startedAt) {
      issues.push(issue("attempt_end_before_start", "task", row.taskId, `Attempt ${row.id} ends before it starts`));
    }
    if (!terminal && (!linkedTask || linkedTask.deletedAt != null || linkedTask.status === "done" || linkedTask.status === "cancelled")) {
      issues.push(issue("active_attempt_inactive_task", "task", row.taskId, `Active attempt ${row.id} points at an inactive task`));
    }
    if (row.claimId) {
      const claim = claimById.get(row.claimId);
      if (!claim || claim.taskId !== row.taskId || claim.actor !== row.actor) {
        issues.push(issue("attempt_claim_mismatch", "task", row.taskId, `Attempt ${row.id} claim does not match its task and actor`));
      }
    }
  }

  for (const row of evidence) {
    if (!taskById.has(row.taskId)) {
      issues.push(issue("evidence_task_mismatch", "task", row.taskId, `Evidence ${row.id} does not point at a task in tenant ${tenantId}`));
    }
    if ((!row.summary || row.summary.trim().length === 0) && (!row.uri || row.uri.trim().length === 0)) {
      issues.push(issue("evidence_empty", "task", row.taskId, `Evidence ${row.id} has no non-empty summary or URI`));
    }
    if (row.attemptId) {
      const attempt = attemptById.get(row.attemptId);
      if (!attempt || attempt.taskId !== row.taskId) {
        issues.push(issue("evidence_attempt_mismatch", "task", row.taskId, `Evidence ${row.id} attempt belongs to another task`));
      }
    }
    if (row.supersedesEvidenceId) {
      const prior = evidenceById.get(row.supersedesEvidenceId);
      if (!prior || prior.taskId !== row.taskId) {
        issues.push(issue("evidence_supersession_mismatch", "task", row.taskId, `Evidence ${row.id} supersedes evidence from another task`));
      }
    }
    const seen = new Set<string>();
    let cursor: string | null = row.id;
    while (cursor) {
      if (seen.has(cursor)) {
        issues.push(issue("evidence_supersession_cycle", "task", row.taskId, `Evidence supersession cycle reaches ${cursor}`));
        break;
      }
      seen.add(cursor);
      cursor = evidenceById.get(cursor)?.supersedesEvidenceId ?? null;
    }
  }

  for (const row of releases) {
    try {
      const manifest = JSON.parse(row.manifestJson) as unknown;
      if (sha256Digest(canonicalJson(manifest)) !== row.manifestDigest) {
        issues.push(issue("extension_manifest_digest_mismatch", "extension", row.id, `Extension release ${row.extensionUri}@${row.version} manifest digest drifted`));
      }
    } catch {
      issues.push(issue("extension_manifest_invalid", "extension", row.id, `Extension release ${row.extensionUri}@${row.version} has invalid manifest JSON`));
    }
  }

  for (const row of extensionTypes) {
    if (!releaseById.has(row.extensionReleaseId)) {
      issues.push(issue("extension_type_release_mismatch", "extension", row.id, `Extension type ${row.typeUri}@${row.schemaVersion} has no same-tenant release`));
    }
    try {
      const schemaJson = JSON.parse(row.schemaJson) as unknown;
      if (sha256Digest(canonicalJson(schemaJson)) !== row.schemaDigest) {
        issues.push(issue("extension_schema_digest_mismatch", "extension", row.id, `Extension type ${row.typeUri}@${row.schemaVersion} schema digest drifted`));
      }
    } catch {
      issues.push(issue("extension_schema_invalid", "extension", row.id, `Extension type ${row.typeUri}@${row.schemaVersion} has invalid schema JSON`));
    }
  }

  for (const row of evaluators) {
    if (!releaseById.has(row.extensionReleaseId)) {
      issues.push(issue("extension_evaluator_release_mismatch", "extension", row.id, `Evaluator ${row.evaluatorUri}@${row.evaluatorVersion} has no same-tenant release`));
    }
    const conditionType = extensionTypeByIdentity.get(
      `${row.conditionTypeUri}@${row.conditionSchemaVersion}`,
    );
    if (!conditionType || conditionType.recordKind !== "condition") {
      issues.push(issue("extension_evaluator_condition_missing", "extension", row.id, `Evaluator ${row.evaluatorUri}@${row.evaluatorVersion} has no registered condition type`));
    }
    try {
      const accepted = JSON.parse(row.acceptedObservationTypes) as Array<{
        typeUri?: unknown;
        schemaVersion?: unknown;
      }>;
      if (!Array.isArray(accepted) || accepted.length === 0 || accepted.some((item) => {
        const type = extensionTypeByIdentity.get(`${item.typeUri}@${item.schemaVersion}`);
        return !type || type.recordKind !== "observation";
      })) {
        issues.push(issue("extension_evaluator_observation_missing", "extension", row.id, `Evaluator ${row.evaluatorUri}@${row.evaluatorVersion} has invalid accepted observation types`));
      }
    } catch {
      issues.push(issue("extension_evaluator_observation_invalid", "extension", row.id, `Evaluator ${row.evaluatorUri}@${row.evaluatorVersion} has invalid accepted-type JSON`));
    }
  }

  for (const row of waits) {
    const linkedTask = taskById.get(row.taskId);
    if (!linkedTask) {
      issues.push(issue("wait_task_mismatch", "task", row.taskId, `Wait condition ${row.id} does not point at a task in tenant ${tenantId}`));
    } else if (
      row.status === "waiting" &&
      (linkedTask.deletedAt != null || linkedTask.status === "done" || linkedTask.status === "cancelled")
    ) {
      issues.push(issue("waiting_condition_inactive_task", "task", row.taskId, `Waiting condition ${row.id} points at a terminal/deleted task`));
    }

    if (row.deadlineAt != null && row.deadlineAt <= row.notBefore) {
      issues.push(issue("wait_invalid_deadline", "task", row.taskId, `Wait condition ${row.id} deadline is not after notBefore`));
    }
    if (row.updatedAt < row.createdAt) {
      issues.push(issue("wait_invalid_chronology", "task", row.taskId, `Wait condition ${row.id} updatedAt precedes createdAt`));
    }
    const expectedIdentity = WAIT_KIND_EXTENSION_IDENTITIES[
      row.kind as keyof typeof WAIT_KIND_EXTENSION_IDENTITIES
    ];
    const registeredType = extensionTypeByIdentity.get(`${row.typeUri}@${row.schemaVersion}`);
    const registeredEvaluator = evaluatorByIdentity.get(
      `${row.evaluatorUri}@${row.evaluatorVersion}`,
    );
    if (
      !expectedIdentity ||
      row.typeUri !== expectedIdentity.typeUri ||
      row.evaluatorUri !== expectedIdentity.evaluatorUri
    ) {
      issues.push(issue("wait_extension_identity_drift", "task", row.taskId, `Wait condition ${row.id} legacy kind and universal identity disagree`));
    }
    if (!registeredType || registeredType.recordKind !== "condition") {
      issues.push(issue("wait_extension_type_missing", "task", row.taskId, `Wait condition ${row.id} type is not registered`));
    }
    if (
      !registeredEvaluator ||
      registeredEvaluator.conditionTypeUri !== row.typeUri ||
      registeredEvaluator.conditionSchemaVersion !== row.schemaVersion ||
      registeredEvaluator.implementationDigest !== row.evaluatorImplementationDigest
    ) {
      issues.push(issue("wait_extension_evaluator_missing", "task", row.taskId, `Wait condition ${row.id} evaluator identity is not registered`));
    }
    try {
      JSON.parse(row.parameters);
      if (row.fallbackSpec != null) JSON.parse(row.fallbackSpec);
    } catch {
      issues.push(issue("wait_invalid_json", "task", row.taskId, `Wait condition ${row.id} contains invalid JSON`));
    }

    const fallbackShapeValid =
      (row.fallbackKind === "none" && row.fallbackSpec == null && row.fallbackTargetTaskId == null) ||
      (row.fallbackKind === "create_task" && row.fallbackSpec != null && row.fallbackTargetTaskId == null) ||
      (row.fallbackKind === "activate_task" && row.fallbackSpec == null && row.fallbackTargetTaskId != null);
    if (!fallbackShapeValid) {
      issues.push(issue("wait_invalid_fallback", "task", row.taskId, `Wait condition ${row.id} has incoherent fallback configuration`));
    }
    if (row.fallbackTargetTaskId) {
      const target = taskById.get(row.fallbackTargetTaskId);
      if (!target || target.deletedAt != null) {
        issues.push(issue("wait_dead_fallback_target", "task", row.taskId, `Wait condition ${row.id} fallback target is missing/deleted`));
      } else if (
        row.status === "waiting" &&
        (target.status === "done" || target.status === "cancelled")
      ) {
        issues.push(issue("wait_terminal_fallback_target", "task", row.taskId, `Waiting condition ${row.id} fallback target is terminal`));
      }
    }
    if (row.fallbackResultTaskId && !taskById.has(row.fallbackResultTaskId)) {
      issues.push(issue("wait_missing_fallback_result", "task", row.taskId, `Wait condition ${row.id} fallback result is missing`));
    }
    if (row.status === "expired" && row.fallbackKind === "activate_task") {
      if (row.fallbackResultTaskId !== row.fallbackTargetTaskId) {
        issues.push(issue("wait_activate_result_mismatch", "task", row.taskId, `Wait condition ${row.id} activation result differs from its configured target`));
      }
    }
    if (row.status === "expired" && row.fallbackKind === "create_task") {
      const resultTask = row.fallbackResultTaskId
        ? taskById.get(row.fallbackResultTaskId)
        : undefined;
      try {
        const provenance = resultTask
          ? (JSON.parse(resultTask.metadata).waitFallback as Record<string, unknown> | undefined)
          : undefined;
        if (
          !provenance ||
          provenance.conditionId !== row.id ||
          provenance.sourceTaskId !== row.taskId
        ) {
          issues.push(issue("wait_create_result_mismatch", "task", row.taskId, `Wait condition ${row.id} created fallback lacks canonical provenance`));
        }
      } catch {
        issues.push(issue("wait_create_result_mismatch", "task", row.taskId, `Wait condition ${row.id} created fallback has invalid metadata`));
      }
    }
    if (row.status === "expired" && row.fallbackKind !== "none") {
      const key = `wait:${row.id}:deadline-fallback:v1`;
      const identity = idempotency.find((candidate) =>
        candidate.key === key &&
        candidate.operation === "wait.deadline-fallback" &&
        candidate.resultId === row.fallbackResultTaskId
      );
      if (
        !identity
      ) {
        issues.push(issue("wait_fallback_idempotency_missing", "task", row.taskId, `Wait condition ${row.id} has no matching deadline fallback identity`));
      }
    }

    const waitingShape = row.status === "waiting"
      && row.satisfiedAt == null
      && row.satisfiedByObservationId == null
      && row.expiredAt == null
      && row.cancelledAt == null
      && row.cancelReason == null
      && row.fallbackResultTaskId == null;
    const satisfiedShape = row.status === "satisfied"
      && row.satisfiedAt != null
      && row.satisfiedByObservationId != null
      && row.expiredAt == null
      && row.cancelledAt == null
      && row.cancelReason == null
      && row.fallbackResultTaskId == null;
    const expiredShape = row.status === "expired"
      && row.satisfiedAt == null
      && row.satisfiedByObservationId == null
      && row.expiredAt != null
      && row.deadlineAt != null
      && row.expiredAt >= row.deadlineAt
      && row.cancelledAt == null
      && row.cancelReason == null
      && (
        (row.fallbackKind === "none" && row.fallbackResultTaskId == null) ||
        (row.fallbackKind !== "none" && row.fallbackResultTaskId != null)
      );
    const cancelledShape = row.status === "cancelled"
      && row.satisfiedAt == null
      && row.satisfiedByObservationId == null
      && row.expiredAt == null
      && row.cancelledAt != null
      && row.cancelledAt >= row.createdAt
      && Boolean(row.cancelReason?.trim())
      && row.fallbackResultTaskId == null;
    if (!waitingShape && !satisfiedShape && !expiredShape && !cancelledShape) {
      issues.push(issue("wait_invalid_lifecycle", "task", row.taskId, `Wait condition ${row.id} has incoherent terminal fields`));
    }

    if (row.supersedesConditionId) {
      const prior = waitById.get(row.supersedesConditionId);
      if (!prior || prior.taskId !== row.taskId) {
        issues.push(issue("wait_supersession_mismatch", "task", row.taskId, `Wait condition ${row.id} supersedes a condition from another task`));
      }
    }
    if (
      row.satisfiedByObservationId &&
      !observationById.has(row.satisfiedByObservationId)
    ) {
      issues.push(issue("wait_observation_mismatch", "task", row.taskId, `Wait condition ${row.id} references a missing/cross-tenant observation`));
    }
    const seen = new Set<string>();
    let cursor: string | null = row.id;
    while (cursor) {
      if (seen.has(cursor)) {
        issues.push(issue("wait_supersession_cycle", "task", row.taskId, `Wait condition supersession cycle reaches ${cursor}`));
        break;
      }
      seen.add(cursor);
      cursor = waitById.get(cursor)?.supersedesConditionId ?? null;
    }
  }

  for (const row of observations) {
    if (!row.source.trim() || !row.externalEventId.trim() || !row.recordedBy.trim()) {
      issues.push(issue("observation_blank_identity", "observation", row.id, `Observation ${row.id} has blank delivery/provenance identity`));
    }
    if (row.occurredAt < 0 || row.recordedAt < 0) {
      issues.push(issue("observation_invalid_timestamp", "observation", row.id, `Observation ${row.id} has a negative timestamp`));
    }
    if (
      row.verificationLevel !== "unverified" &&
      (!row.verificationMethod || !row.verificationMethod.trim())
    ) {
      issues.push(issue("observation_missing_verification_method", "observation", row.id, `Verified observation ${row.id} has no verification method`));
    }
    if (row.rawRef != null && (!row.digest || !row.digest.trim())) {
      issues.push(issue("observation_unbound_raw_ref", "observation", row.id, `Observation ${row.id} rawRef has no binding digest`));
    }
    const expectedTypeUri = OBSERVATION_KIND_TYPE_URIS[
      row.kind as keyof typeof OBSERVATION_KIND_TYPE_URIS
    ];
    const registeredType = extensionTypeByIdentity.get(`${row.typeUri}@${row.schemaVersion}`);
    if (!expectedTypeUri || row.typeUri !== expectedTypeUri) {
      issues.push(issue("observation_extension_identity_drift", "observation", row.id, `Observation ${row.id} legacy kind and universal identity disagree`));
    }
    if (!registeredType || registeredType.recordKind !== "observation") {
      issues.push(issue("observation_extension_type_missing", "observation", row.id, `Observation ${row.id} type is not registered`));
    }
    try {
      const payload = parseReferenceObservation(
        row.kind as Parameters<typeof parseReferenceObservation>[0],
        row.schemaVersion,
        JSON.parse(row.payload),
      );
      const expectedSubject = deriveReferenceObservationSubjectRef(
        row.kind as Parameters<typeof deriveReferenceObservationSubjectRef>[0],
        row.schemaVersion,
        payload,
      );
      if (row.subjectRef !== expectedSubject) {
        issues.push(issue("observation_subject_mismatch", "observation", row.id, `Observation ${row.id} subjectRef is not canonical for its payload`));
      }
      const metadata = JSON.parse(row.metadata);
      const parsedObservation = ObservationZ.parse({ ...row, payload, metadata });
      const expectedRoutes = new Set(observationRouteKeys(parsedObservation));
      const actualRoutes = routesByObservation.get(row.id) ?? [];
      for (const route of actualRoutes) {
        if (route.kind !== row.kind || !expectedRoutes.has(route.routeKey)) {
          issues.push(issue("observation_route_mismatch", "observation", row.id, `Observation ${row.id} has a non-canonical route`));
        }
      }
      for (const expected of expectedRoutes) {
        if (!actualRoutes.some((route) => route.routeKey === expected)) {
          issues.push(issue("observation_route_missing", "observation", row.id, `Observation ${row.id} is missing a canonical route`));
        }
      }
    } catch (error) {
      issues.push(issue("observation_invalid_payload", "observation", row.id, `Observation ${row.id} is not valid for ${row.kind}@${row.schemaVersion}: ${error instanceof Error ? error.message : String(error)}`));
    }
  }

  for (const row of reconciliations) {
    const condition = waitById.get(row.conditionId);
    const observedRow = observationById.get(row.observationId);
    const linkedEvidence = row.evidenceId ? evidenceById.get(row.evidenceId) : null;
    if (!condition || condition.kind !== row.matcherKind) {
      issues.push(issue("reconciliation_condition_mismatch", "reconciliation", row.id, `Reconciliation ${row.id} condition is missing or has another matcher kind`));
    }
    if (!observedRow) {
      issues.push(issue("reconciliation_observation_mismatch", "reconciliation", row.id, `Reconciliation ${row.id} observation is missing`));
    }
    const registeredEvaluator = evaluatorByIdentity.get(
      `${row.evaluatorUri}@${row.evaluatorVersion}`,
    );
    const expectedIdentity = condition
      ? WAIT_KIND_EXTENSION_IDENTITIES[
          condition.kind as keyof typeof WAIT_KIND_EXTENSION_IDENTITIES
        ]
      : null;
    if (
      !expectedIdentity ||
      row.evaluatorUri !== expectedIdentity.evaluatorUri ||
      row.evaluatorVersion !== row.matcherVersion ||
      row.evaluatorImplementationDigest !== REFERENCE_EVALUATOR_IMPLEMENTATION_DIGEST
    ) {
      issues.push(issue("reconciliation_extension_identity_drift", "reconciliation", row.id, `Reconciliation ${row.id} matcher and universal evaluator identity disagree`));
    }
    if (
      !registeredEvaluator ||
      registeredEvaluator.implementationDigest !== row.evaluatorImplementationDigest ||
      (condition && registeredEvaluator.conditionTypeUri !== condition.typeUri)
    ) {
      issues.push(issue("reconciliation_extension_evaluator_missing", "reconciliation", row.id, `Reconciliation ${row.id} evaluator is not registered`));
    }
    if (
      row.evidenceId &&
      (!linkedEvidence || !condition || linkedEvidence.taskId !== condition.taskId)
    ) {
      issues.push(issue("reconciliation_evidence_mismatch", "reconciliation", row.id, `Reconciliation ${row.id} evidence does not belong to the condition task`));
    }
    try {
      const parsed = ReconciliationZ.parse(row);
      if (condition && observedRow) {
        const parsedCondition = WaitConditionZ.parse({
          ...condition,
          parameters: JSON.parse(condition.parameters),
          fallbackSpec: condition.fallbackSpec == null
            ? null
            : JSON.parse(condition.fallbackSpec),
        });
        const parsedObservation = ObservationZ.parse({
          ...observedRow,
          payload: JSON.parse(observedRow.payload),
          metadata: JSON.parse(observedRow.metadata),
        });
        const replay = evaluateWaitObservation(
          parsedCondition,
          parsedObservation,
          parsed.matcherVersion,
        );
        if (replay.decision !== parsed.decision) {
          issues.push(issue("reconciliation_decision_drift", "reconciliation", row.id, `Reconciliation ${row.id} decision differs from frozen matcher replay`));
        }
        if (
          parsed.effect === "satisfied" &&
          (condition.status !== "satisfied" || condition.satisfiedByObservationId !== row.observationId)
        ) {
          issues.push(issue("reconciliation_effect_mismatch", "reconciliation", row.id, `Satisfied reconciliation ${row.id} is not reflected by its condition`));
        }
      }
    } catch (error) {
      issues.push(issue("reconciliation_invalid", "reconciliation", row.id, `Reconciliation ${row.id} is invalid: ${error instanceof Error ? error.message : String(error)}`));
    }
  }

  for (const row of effects) {
    const linkedTask = taskById.get(row.taskId);
    if (!linkedTask) {
      issues.push(issue("effect_task_mismatch", "effect", row.id, `Effect ${row.id} points at a missing/cross-workspace commitment`));
    }
    if (row.attemptId && attemptById.get(row.attemptId)?.taskId !== row.taskId) {
      issues.push(issue("effect_attempt_mismatch", "effect", row.id, `Effect ${row.id} attempt belongs to another commitment`));
    }
    if (!principalById.has(row.createdByPrincipalId)) {
      issues.push(issue("effect_principal_mismatch", "effect", row.id, `Effect ${row.id} has a missing/cross-workspace creator`));
    }
    const registeredType = extensionTypeByIdentity.get(`${row.effectTypeUri}@${row.effectSchemaVersion}`);
    if (!registeredType || registeredType.recordKind !== "effect") {
      issues.push(issue("effect_extension_type_missing", "effect", row.id, `Effect ${row.id} type is not registered as an effect`));
    }
    try {
      const request = JSON.parse(row.canonicalRequest) as unknown;
      const prepared = prepareEffectRequest(request);
      const identityMatches = prepared.canonicalRequest === row.canonicalRequest &&
        prepared.requestDigest === row.requestDigest &&
        prepared.request.protocol === row.requestProtocol &&
        prepared.request.canonicalization === row.canonicalization &&
        prepared.request.digestAlgorithm === row.digestAlgorithm &&
        prepared.request.workspaceId === row.tenantId &&
        prepared.request.effectTypeUri === row.effectTypeUri &&
        prepared.request.effectSchemaVersion === row.effectSchemaVersion &&
        prepared.request.connector.operationUri === row.connectorOperationUri &&
        prepared.request.connector.operationVersion === row.connectorOperationVersion &&
        prepared.request.connector.contractDigest === row.connectorContractDigest &&
        prepared.request.connector.instanceRef === row.connectorInstanceRef &&
        prepared.request.connector.bindingDigest === row.connectorBindingDigest &&
        deriveEffectDispatchKey(row.id, prepared) === row.dispatchIdempotencyKey;
      if (!identityMatches) {
        issues.push(issue("effect_request_identity_drift", "effect", row.id, `Effect ${row.id} request, digest or dispatch identity drifted`));
      }
      EffectZ.parse({ ...row, request: prepared.request });
    } catch (error) {
      issues.push(issue("effect_invalid", "effect", row.id, `Effect ${row.id} is invalid: ${error instanceof Error ? error.message : String(error)}`));
    }
    if (row.supersedesEffectId) {
      const prior = effectById.get(row.supersedesEffectId);
      if (!prior || prior.taskId !== row.taskId || prior.status !== "cancelled") {
        issues.push(issue("effect_correction_mismatch", "effect", row.id, `Effect ${row.id} does not supersede a cancelled occurrence on the same commitment`));
      }
    }
    if (row.compensationOfEffectId && effectById.get(row.compensationOfEffectId)?.status !== "committed") {
      issues.push(issue("effect_compensation_mismatch", "effect", row.id, `Effect ${row.id} does not compensate a committed occurrence`));
    }
    if (["executing", "indeterminate", "committed", "failed"].includes(row.status)) {
      const linkedAttempt = row.attemptId ? attemptById.get(row.attemptId) : null;
      const linkedClaim = row.claimId ? claimById.get(row.claimId) : null;
      if (!linkedAttempt || !linkedClaim || linkedAttempt.taskId !== row.taskId ||
        linkedAttempt.claimId !== linkedClaim.id || linkedAttempt.principalId == null ||
        linkedAttempt.principalId !== linkedClaim.principalId || linkedClaim.taskId !== row.taskId ||
        linkedClaim.fence !== row.fence || (row.status === "executing" && linkedAttempt.status !== "running")) {
        issues.push(issue("effect_execution_binding_mismatch", "effect", row.id, `Effect ${row.id} does not retain its exact attempt/claim/fence execution binding`));
      }
    }
  }

  const approvalsByEffect = new Map<string, typeof approvals>();
  for (const row of approvals) {
    approvalsByEffect.set(row.effectId, [...(approvalsByEffect.get(row.effectId) ?? []), row]);
    const linkedEffect = effectById.get(row.effectId);
    if (!linkedEffect || linkedEffect.requestDigest !== row.requestDigest) {
      issues.push(issue("effect_approval_request_mismatch", "effect_approval", row.id, `Approval ${row.id} is not bound to its effect's exact request digest`));
    }
    if (!principalById.has(row.approverPrincipalId)) {
      issues.push(issue("effect_approval_principal_mismatch", "effect_approval", row.id, `Approval ${row.id} has a missing/cross-workspace approver`));
    }
    if (row.supersedesApprovalId) {
      const prior = approvalById.get(row.supersedesApprovalId);
      if (!prior || prior.effectId !== row.effectId || prior.decidedAt > row.decidedAt) {
        issues.push(issue("effect_approval_supersession_mismatch", "effect_approval", row.id, `Approval ${row.id} has an invalid predecessor`));
      }
    }
    try {
      const parseObject = (value: string) => {
        const parsed = JSON.parse(value) as unknown;
        if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object" || canonicalizeEffectJson(parsed) !== value) {
          throw new Error("authority JSON must be a canonical object");
        }
        return parsed;
      };
      EffectApprovalZ.parse({
        ...row,
        scope: parseObject(row.scope),
        limits: parseObject(row.limits),
        verification: parseObject(row.verification),
      });
    } catch (error) {
      issues.push(issue("effect_approval_invalid", "effect_approval", row.id, `Approval ${row.id} is invalid: ${error instanceof Error ? error.message : String(error)}`));
    }
  }

  for (const row of receipts) {
    const linkedEffect = effectById.get(row.effectId);
    const linkedEvidence = evidenceById.get(row.evidenceId);
    if (!linkedEffect || linkedEffect.taskId !== row.taskId || linkedEffect.attemptId !== row.attemptId ||
      linkedEffect.authorizedByApprovalId !== row.approvalId) {
      issues.push(issue("effect_receipt_binding_mismatch", "effect_receipt", row.id, `Receipt ${row.id} is not linked to its effect execution`));
    }
    if (!linkedEvidence || linkedEvidence.taskId !== row.taskId || linkedEvidence.attemptId !== row.attemptId) {
      issues.push(issue("effect_receipt_evidence_mismatch", "effect_receipt", row.id, `Receipt ${row.id} has missing or foreign evidence`));
    } else {
      try {
        const report = JSON.parse(row.canonicalReport) as Record<string, unknown>;
        const metadata = JSON.parse(linkedEvidence.metadata) as Record<string, unknown>;
        if (linkedEvidence.kind !== "effect_receipt" || linkedEvidence.uri !== report.rawRef ||
          linkedEvidence.digest !== report.rawDigest || linkedEvidence.source !== row.connectorInstanceRef ||
          linkedEvidence.observedAt !== row.occurredAt ||
          metadata.receiptId !== row.id || metadata.effectId !== row.effectId ||
          metadata.receiptDigest !== row.receiptDigest || metadata.outcome !== row.outcome) {
          throw new Error("evidence metadata does not bind the receipt");
        }
      } catch {
        issues.push(issue("effect_receipt_evidence_mismatch", "effect_receipt", row.id, `Receipt ${row.id} evidence metadata is invalid`));
      }
    }
    if (!principalById.has(row.recordedByPrincipalId)) {
      issues.push(issue("effect_receipt_principal_mismatch", "effect_receipt", row.id, `Receipt ${row.id} has a missing/cross-workspace recorder`));
    }
    try {
      const report = JSON.parse(row.canonicalReport) as unknown;
      const prepared = prepareEffectReceiptReport(report);
      const coverage = JSON.parse(row.coverage) as unknown;
      const verification = JSON.parse(row.verification) as unknown;
      if (prepared.canonicalReport !== row.canonicalReport || prepared.receiptDigest !== row.receiptDigest ||
        canonicalizeEffectJson(coverage) !== row.coverage || canonicalizeEffectJson(verification) !== row.verification) {
        throw new Error("canonical content or digest drifted");
      }
      const parsed = EffectReceiptZ.parse({ ...row, report: prepared.report, coverage, verification });
      const decomposedMatches = parsed.report.effectId === row.effectId &&
        parsed.report.approvalId === row.approvalId &&
        parsed.report.connectorInstanceRef === row.connectorInstanceRef &&
        parsed.report.externalReceiptId === row.externalReceiptId &&
        parsed.report.providerOperationId === row.providerOperationId &&
        parsed.report.outcome === row.outcome &&
        parsed.report.resolvesReceiptId === row.resolvesReceiptId &&
        parsed.report.occurredAt === row.occurredAt;
      if (!decomposedMatches) throw new Error("decomposed report fields drifted");
      if (parsed.report.outcome !== "indeterminate" && (
        parsed.verificationLevel === "self_asserted" ||
        EFFECT_RECEIPT_COVERAGE.some((required) => !parsed.coverage.includes(required))
      )) throw new Error("terminal outcome lacks strong complete verification coverage");
      if (row.resolvesReceiptId) {
        const prior = receiptById.get(row.resolvesReceiptId);
        if (!prior || prior.effectId !== row.effectId || prior.outcome !== "indeterminate") {
          throw new Error("resolution does not reference an indeterminate receipt for the same effect");
        }
      }
    } catch (error) {
      issues.push(issue("effect_receipt_invalid", "effect_receipt", row.id, `Receipt ${row.id} is invalid: ${error instanceof Error ? error.message : String(error)}`));
    }
  }

  for (const row of effects) {
    const history = approvalsByEffect.get(row.id) ?? [];
    if (history.length > 0) {
      const roots = history.filter((approval) => approval.supersedesApprovalId == null);
      const childCounts = new Map<string, number>();
      for (const approval of history) {
        if (approval.supersedesApprovalId) {
          childCounts.set(approval.supersedesApprovalId, (childCounts.get(approval.supersedesApprovalId) ?? 0) + 1);
        }
        const seen = new Set<string>();
        let cursor: string | null = approval.id;
        while (cursor) {
          if (seen.has(cursor)) {
            issues.push(issue("effect_approval_cycle", "effect_approval", approval.id, `Approval history for effect ${row.id} contains a cycle`));
            break;
          }
          seen.add(cursor);
          cursor = approvalById.get(cursor)?.supersedesApprovalId ?? null;
        }
      }
      const leaves = history.filter((approval) => (childCounts.get(approval.id) ?? 0) === 0);
      if (roots.length !== 1 || leaves.length !== 1 || [...childCounts.values()].some((count) => count > 1)) {
        issues.push(issue("effect_approval_history_branched", "effect", row.id, `Effect ${row.id} approval history is not one linear chain`));
      }
      if (row.status === "authorized" || row.status === "executing") {
        const active = row.authorizedByApprovalId ? approvalById.get(row.authorizedByApprovalId) : null;
        const authorizedAt = row.authorizedAt;
        if (!active || active.effectId !== row.id || active.id !== leaves[0]?.id || active.decision !== "approved" ||
          authorizedAt == null || (active.validFrom != null && authorizedAt < active.validFrom) ||
          (active.expiresAt != null && authorizedAt >= active.expiresAt)) {
          issues.push(issue("effect_authority_stale", "effect", row.id, `Effect ${row.id} is not backed by its current valid approved leaf`));
        }
      }
    } else if (row.authorizedByApprovalId != null) {
      issues.push(issue("effect_authority_missing", "effect", row.id, `Effect ${row.id} references a missing approval history`));
    }
    if (["indeterminate", "committed", "failed"].includes(row.status)) {
      const outcome = row.outcomeReceiptId ? receiptById.get(row.outcomeReceiptId) : null;
      if (!outcome || outcome.effectId !== row.id || outcome.outcome !== row.status) {
        issues.push(issue("effect_outcome_receipt_mismatch", "effect", row.id, `Effect ${row.id} is not grounded by its current outcome receipt`));
      }
    } else if (row.outcomeReceiptId != null) {
      issues.push(issue("effect_outcome_receipt_unexpected", "effect", row.id, `Effect ${row.id} references a receipt before an outcome state`));
    }
  }

  return {
    ok: sqliteIntegrity === "ok" && foreignKeys.rows.length === 0 && issues.length === 0,
    sqliteIntegrity,
    foreignKeyViolations: foreignKeys.rows.length,
    issues,
  };
}

function dependencyCycleFrom(start: string, graph: Map<string, string[]>): boolean {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    for (const next of graph.get(id) ?? []) if (visit(next)) return true;
    visiting.delete(id);
    visited.add(id);
    return false;
  };
  return visit(start);
}

function issue(
  code: string,
  entityType: DoctorIssue["entityType"],
  entityId: string,
  message: string,
): DoctorIssue {
  return { code, entityType, entityId, message };
}

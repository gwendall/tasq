/** Bounded, read-only attention projection. No row in this file is persisted. */
import {
  getAgreementView,
  listAgreementOffers,
  listAssignments,
  listCommitments,
  listCompletionChallenges,
  listCompletionProposals,
  listEffects,
  listSettlementDecisions,
  listTaskAttempts,
  listTaskEvidence,
  listValidationDecisions,
  type Commitment,
  type TasqDb,
} from "@tasq-run/core";
import type {
  Assignment,
  AttestationEligibilityDecisionV1,
  Clock,
} from "@tasq-run/schema";

export const REVIEW_ATTENTION_KINDS = [
  "assignment_acceptance",
  "agreement_acceptance",
  "eligibility",
  "attempt_input",
  "attempt_no_progress",
  "evidence_review",
  "evidence_challenge",
  "effect_approval",
  "effect_reconciliation",
  "settlement_dispute",
  "recourse_overdue",
  "custody",
] as const;
export type ReviewAttentionKind = typeof REVIEW_ATTENTION_KINDS[number];
export type ReviewAttentionSeverity = "critical" | "warning" | "info";

export interface ReviewAttentionItem {
  id: string;
  kind: ReviewAttentionKind;
  severity: ReviewAttentionSeverity;
  recordType: string;
  recordId: string;
  commitmentId: string | null;
  reasonCode: string;
  explanation: string;
  observedAt: number;
}

export interface EligibilityProjectionInput {
  assignment: Assignment;
  commitment: Commitment;
  at: number;
}

export interface CustodyAttentionProjectorInput {
  db: TasqDb;
  workspaceId: string;
  at: number;
  limit: number;
}

export interface BuildReviewInboxOptions {
  workspaceId: string;
  clock: Clock;
  limit?: number;
  scanLimit?: number;
  noProgressAfterMs?: number;
  evaluateEligibility?: (
    input: EligibilityProjectionInput,
  ) => Promise<AttestationEligibilityDecisionV1 | null>;
  projectCustodyAttention?: (
    input: CustodyAttentionProjectorInput,
  ) => Promise<readonly ReviewAttentionItem[]>;
}

export interface ReviewInbox {
  contractVersion: "tasq.review-inbox.v1";
  workspaceId: string;
  generatedAt: number;
  items: readonly ReviewAttentionItem[];
  scan: Readonly<{
    commitmentLimit: number;
    commitmentsExamined: number;
    truncated: boolean;
  }>;
  assurance: Readonly<{
    derivedOnly: true;
    persistedShadowState: false;
    authorityGranted: false;
  }>;
}

const SEVERITY_ORDER: Record<ReviewAttentionSeverity, number> = {
  critical: 0,
  warning: 1,
  info: 2,
};

function bounded(value: number | undefined, fallback: number, max: number, label: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result <= 0 || result > max) {
    throw new Error(`${label} must be an integer in 1..${max}`);
  }
  return result;
}

function item(input: Omit<ReviewAttentionItem, "id">): ReviewAttentionItem {
  return Object.freeze({
    ...input,
    id: `${input.kind}:${input.recordType}:${input.recordId}`,
  });
}

function isMetadataObject(value: unknown): value is Record<string, unknown> {
  return !!value && !Array.isArray(value) && typeof value === "object";
}

/**
 * Rebuild the inbox from authoritative records on every call. Callers inject
 * purpose-specific eligibility and experimental custody policy; neither is
 * guessed from assignment or signature records.
 */
export async function buildReviewInbox(
  db: TasqDb,
  options: BuildReviewInboxOptions,
): Promise<ReviewInbox> {
  if (!options.workspaceId.trim()) throw new Error("workspaceId is required");
  const limit = bounded(options.limit, 100, 500, "limit");
  const scanLimit = bounded(options.scanLimit, 250, 1_000, "scanLimit");
  const noProgressAfterMs = bounded(
    options.noProgressAfterMs,
    30 * 60_000,
    365 * 24 * 60 * 60_000,
    "noProgressAfterMs",
  );
  const at = options.clock.now();
  const candidates = await listCommitments(db, {
    workspaceId: options.workspaceId,
    includeDeferred: true,
    limit: scanLimit + 1,
    clock: options.clock,
  });
  const commitments = candidates.slice(0, scanLimit);
  const attention: ReviewAttentionItem[] = [];

  for (const commitment of commitments) {
    const [assignments, attempts, evidence, effects, proposals] = await Promise.all([
      listAssignments(db, { tenantId: options.workspaceId, taskId: commitment.id }),
      listTaskAttempts(db, commitment.id, { tenantId: options.workspaceId, limit: 1_000 }),
      listTaskEvidence(db, commitment.id, { tenantId: options.workspaceId, limit: 1_000 }),
      listEffects(db, { tenantId: options.workspaceId, taskId: commitment.id }),
      listCompletionProposals(db, commitment.id, options.workspaceId),
    ]);

    for (const assignment of assignments) {
      if (assignment.status === "proposed") attention.push(item({
        kind: "assignment_acceptance", severity: "warning", recordType: "assignment",
        recordId: assignment.id, commitmentId: commitment.id,
        reasonCode: "assignment_unaccepted",
        explanation: "The proposed assignee has not accepted or refused responsibility.",
        observedAt: assignment.createdAt,
      }));
      if (assignment.status === "accepted" && options.evaluateEligibility) {
        const decision = await options.evaluateEligibility({ assignment, commitment, at });
        if (decision?.outcome === "ineligible") attention.push(item({
          kind: "eligibility", severity: "critical", recordType: "assignment",
          recordId: assignment.id, commitmentId: commitment.id,
          reasonCode: "eligibility_unsatisfied",
          explanation: `Current eligibility is missing requirements ${decision.unsatisfiedRequirementIndexes.join(", ")}.`,
          observedAt: decision.authorityTime,
        }));
      }
    }

    for (const attempt of attempts) {
      if (attempt.status === "input_required") attention.push(item({
        kind: "attempt_input", severity: "warning", recordType: "task_attempt",
        recordId: attempt.id, commitmentId: commitment.id,
        reasonCode: "attempt_input_required",
        explanation: attempt.statusMessage ?? "The active runtime requires input.",
        observedAt: attempt.updatedAt,
      }));
      if (attempt.status === "running" && at - attempt.updatedAt >= noProgressAfterMs) attention.push(item({
        kind: "attempt_no_progress", severity: "warning", recordType: "task_attempt",
        recordId: attempt.id, commitmentId: commitment.id,
        reasonCode: "attempt_no_progress",
        explanation: `No recorded attempt progress for at least ${noProgressAfterMs} ms.`,
        observedAt: attempt.updatedAt,
      }));
    }

    for (const proposal of proposals) {
      const [challenges, decisions] = await Promise.all([
        listCompletionChallenges(db, proposal.id, options.workspaceId),
        listValidationDecisions(db, proposal.id, options.workspaceId),
      ]);
      if (decisions.length === 0) attention.push(item({
        kind: "evidence_review", severity: "warning", recordType: "completion_proposal",
        recordId: proposal.id, commitmentId: commitment.id,
        reasonCode: "completion_awaiting_decision",
        explanation: `Completion proposal with ${evidence.length} visible evidence record(s) awaits validation.`,
        observedAt: proposal.proposedAt,
      }));
      if (challenges.length > 0 && decisions.length === 0) attention.push(item({
        kind: "evidence_challenge", severity: "critical", recordType: "completion_proposal",
        recordId: proposal.id, commitmentId: commitment.id,
        reasonCode: "completion_challenged_unresolved",
        explanation: `${challenges.length} challenge(s) remain without a validation decision.`,
        observedAt: challenges[challenges.length - 1]!.challengedAt,
      }));
    }

    for (const effect of effects) {
      if (effect.status === "proposed") attention.push(item({
        kind: "effect_approval", severity: "warning", recordType: "effect",
        recordId: effect.id, commitmentId: commitment.id,
        reasonCode: "effect_requires_approval",
        explanation: "The exact proposed external action has no effective dispatch authorization.",
        observedAt: effect.createdAt,
      }));
      if (effect.status === "indeterminate") attention.push(item({
        kind: "effect_reconciliation", severity: "critical", recordType: "effect",
        recordId: effect.id, commitmentId: commitment.id,
        reasonCode: "effect_outcome_indeterminate",
        explanation: "Provider lookup is required before any retry or replacement action.",
        observedAt: effect.indeterminateAt ?? effect.updatedAt,
      }));
    }

    const metadata = isMetadataObject(commitment.metadata) ? commitment.metadata : {};
    if (commitment.status !== "done" && commitment.status !== "cancelled" &&
      commitment.dueAt != null && commitment.dueAt < at &&
      typeof metadata.settlementDecisionId === "string") attention.push(item({
        kind: "recourse_overdue", severity: "critical", recordType: "commitment",
        recordId: commitment.id, commitmentId: commitment.id,
        reasonCode: "recourse_commitment_overdue",
        explanation: "A settlement-created recourse commitment is overdue and unresolved.",
        observedAt: commitment.dueAt,
      }));
  }

  const offerCandidates = await listAgreementOffers(db, options.workspaceId);
  const offers = offerCandidates.slice(0, scanLimit);
  for (const offer of offers) {
    const view = await getAgreementView(db, offer.id, options.workspaceId, at);
    if (view?.state === "offered") attention.push(item({
      kind: "agreement_acceptance", severity: "warning", recordType: "agreement_offer",
      recordId: offer.id, commitmentId: null,
      reasonCode: "agreement_incomplete",
      explanation: `${view.acceptances.length}/${offer.terms.parties.length} exact party acceptances recorded.`,
      observedAt: offer.offeredAt,
    }));
  }

  const settlementCandidates = await listSettlementDecisions(db, options.workspaceId);
  const settlements = settlementCandidates.slice(0, scanLimit);
  for (const settlement of settlements) {
    if (settlement.classification === "indeterminate") attention.push(item({
      kind: "settlement_dispute", severity: "critical", recordType: "settlement_decision",
      recordId: settlement.id, commitmentId: settlement.basis.task.id,
      reasonCode: "settlement_indeterminate",
      explanation: "Settlement policy produced an indeterminate classification requiring review or recourse.",
      observedAt: settlement.decidedAt,
    }));
  }

  if (options.projectCustodyAttention) {
    const projected = await options.projectCustodyAttention({
      db, workspaceId: options.workspaceId, at, limit: scanLimit,
    });
    for (const value of projected) {
      if (value.kind !== "custody") throw new Error("custody projector returned a non-custody attention kind");
      attention.push(Object.freeze({ ...value }));
    }
  }

  const deduped = [...new Map(attention.map((value) => [value.id, value])).values()]
    .sort((left, right) => SEVERITY_ORDER[left.severity] - SEVERITY_ORDER[right.severity] ||
      left.observedAt - right.observedAt || left.id.localeCompare(right.id));
  const truncated = candidates.length > scanLimit || offerCandidates.length > scanLimit ||
    settlementCandidates.length > scanLimit || deduped.length > limit;
  return Object.freeze({
    contractVersion: "tasq.review-inbox.v1",
    workspaceId: options.workspaceId,
    generatedAt: at,
    items: Object.freeze(deduped.slice(0, limit)),
    scan: Object.freeze({ commitmentLimit: scanLimit, commitmentsExamined: commitments.length, truncated }),
    assurance: Object.freeze({ derivedOnly: true, persistedShadowState: false, authorityGranted: false }),
  });
}

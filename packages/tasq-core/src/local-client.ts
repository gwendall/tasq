/**
 * Deep local composition for application and runtime embedders.
 *
 * The client owns store opening, compatible migrations, coordination-space
 * bootstrap and repetitive call context. Its interface deliberately keeps
 * the store URL, workspace, actor and authoritative clock explicit.
 */

import type {
  AgreementOfferInputV1,
  AgreementOfferV1,
  AgreementViewV1,
  Artifact,
  ArtifactInsert,
  AttestationEligibilityDecisionV1,
  AttestationIssueInputV1,
  AttestationRequirementV1,
  AttestationRevocationV1,
  AttestationSubjectV1,
  AttestationV1,
  Assignment,
  AssignmentInsert,
  AssignmentStatus,
  AttemptStatus,
  Clock,
  CompletionChallenge,
  CompletionChallengeInsert,
  CompletionProposal,
  CompletionProposalInsert,
  CompletionResolutionChain,
  Effect,
  EffectApproval,
  EffectApprovalDecision,
  EffectProposal,
  EffectReceipt,
  EffectReceiptInput,
  EffectStatus,
  EntityType,
  EvidenceTrustAttestationInsert,
  EvidenceTrustRecord,
  Event,
  ExternalRef,
  ExternalRefInsert,
  ManualValidationDecisionInsert,
  Metadata,
  ResolutionContract,
  ResolutionContractInsert,
  SignedStatementBinding,
  TaskAttempt,
  TaskClaim,
  TaskEvidence,
  ValidationDecision,
} from "@tasq-run/schema";
import type { CompletionEvaluatorRuntime } from "@tasq-run/extension-sdk";
import {
  acceptAgreement,
  getAgreementOffer,
  getAgreementView,
  listAgreementOffers,
  offerAgreement,
  rejectAgreement,
  withdrawAgreement,
} from "./service/agreements.js";
import {
  evaluateAttestationEligibility,
  getAttestation,
  getAttestationRevocation,
  issueAttestation,
  listCurrentAttestations,
  revokeAttestation,
} from "./service/attestations.js";
import {
  type Commitment,
  type CommitmentTransitionOptions,
  type CreateCommitmentInput,
  type ListCommitmentsOptions,
  type UpdateCommitmentInput,
  blockCommitment,
  cancelCommitment,
  completeCommitment,
  createCommitment,
  getCommitment,
  listCommitments,
  reopenCommitment,
  startCommitment,
  unblockCommitment,
  updateCommitment,
} from "./commitments.js";
import { openDb, runInTransaction, type TasqDb } from "./db.js";
import { inspectCommitment, type CommitmentInspection } from "./inspection.js";
import { runMigrations, type MigrationResult } from "./migrations/index.js";
import {
  acquireTaskClaim,
  addTaskEvidence,
  getActiveTaskClaim,
  getTaskAttempt,
  getTaskClaim,
  getTaskEvidence,
  listTaskAttempts,
  listTaskClaims,
  listTaskEvidence,
  releaseTaskClaim,
  startTaskAttempt,
  transitionTaskAttempt,
  type AcquireClaimOptions,
  type ListAttemptsOptions,
  type ListClaimsOptions,
  type ListEvidenceOptions,
  type ReleaseClaimOptions,
  type StartAttemptOptions,
  type TransitionAttemptOptions,
} from "./service/agentic.js";
import { getEvent, listEvents, type ListEventsOptions } from "./service/events.js";
import {
  acceptAssignment,
  appendArtifact,
  appendExternalRef,
  getArtifact,
  getAssignment,
  getExternalRef,
  listArtifacts,
  listAssignments,
  listExternalRefs,
  proposeAssignment,
  rejectAssignment,
  releaseAssignment,
  revokeAssignment,
} from "./service/collaboration.js";
import {
  authorizeEffect,
  beginEffectExecution,
  cancelEffect,
  getEffect,
  getEffectApproval,
  getEffectReceipt,
  getEffectiveEffectApproval,
  listEffectApprovals,
  listEffectReceipts,
  listEffects,
  proposeEffect,
  recordEffectApproval,
  recordEffectReceipt,
  type BeginEffectExecutionOptions,
  type BegunEffectExecution,
  type EffectAuthorityContext,
  type RecordEffectReceiptOptions,
} from "./service/effects.js";
import {
  adjudicateCompletion,
  attestCompletion,
  attestEvidenceTrust,
  challengeCompletion,
  createResolutionContract,
  evaluateCompletionDeterministically,
  getCompletionChallenge,
  getCompletionProposal,
  getCompletionResolutionChain,
  getEvidenceTrustRecord,
  getResolutionContract,
  getValidationDecision,
  listCompletionChallenges,
  listCompletionProposals,
  listEvidenceTrustRecords,
  listResolutionContracts,
  listValidationDecisions,
  proposeCompletion,
  revokeEvidenceTrust,
  settleOptimisticCompletion,
  type EvidenceTrustAuthority,
} from "./service/resolution.js";
import {
  acquireResourceLease,
  getResourceLeaseView,
  listResourceEvents,
  listResourceWorld,
  releaseResourceLease,
  renewResourceLease,
  verifyResourceFence,
  type AcquireResourceLeaseOptions,
  type ListResourceEventsOptions,
  type ListResourceWorldOptions,
  type ReleaseResourceLeaseOptions,
  type RenewResourceLeaseOptions,
  type VerifyResourceFenceOptions,
} from "./service/resources.js";
import {
  getSignedStatementProof,
  listSignedStatementBindings,
} from "./service/signed-statements.js";
import {
  bootstrapCoordinationSpace,
  type BootstrapCoordinationSpaceResult,
} from "./service/spaces.js";

type BoundKernelContext = "workspaceId" | "actor" | "principalId" | "clock" | "now";
type BoundServiceContext = "tenantId" | "actor" | "principalId" | "clock" | "now";
type BoundResourceContext = "workspaceId" | "actor" | "principalId" | "clock";

export interface CreateLocalTasqOptions {
  /** Explicit LibSQL URL, normally `file:/absolute/path/to/db.sqlite`. */
  url: string;
  /** Stable coordination-space identity. Never inferred from cwd. */
  workspaceId: string;
  /** Stable local attribution label. It is not authentication or authority. */
  actor: string;
  /** Authoritative application clock used by every operation. */
  clock: Clock;
  /** Disable WAL only for isolated in-memory/test stores. */
  wal?: boolean;
}

export interface LocalMutationOptions {
  idempotencyKey?: string;
}

export type LocalCommitmentTransitionOptions = Omit<
  CommitmentTransitionOptions,
  BoundKernelContext
>;

export interface AddLocalEvidenceInput {
  taskId: string;
  attemptId?: string | null;
  supersedesEvidenceId?: string | null;
  kind: string;
  summary?: string | null;
  uri?: string | null;
  digest?: string | null;
  source?: string | null;
  observedAt?: number;
  metadata?: Metadata;
}

export interface LocalEvidenceOptions extends LocalMutationOptions {
  occurredAt?: number;
}

export type LocalAssignmentProposal = Omit<AssignmentInsert, "tenantId" | "assignerPrincipalId">;
export type LocalArtifactAppend = Omit<ArtifactInsert, "tenantId">;
export type LocalExternalRefAppend = Omit<ExternalRefInsert, "tenantId">;
export type LocalEffectProposal = Omit<EffectProposal, "tenantId" | "request"> & {
  request: Omit<EffectProposal["request"], "workspaceId">;
};

export interface ClaimAndStartInput {
  commitmentId: string;
  leaseMs?: number;
  claimMetadata?: Metadata;
  runtime?: string;
  externalId?: string | null;
  contextId?: string | null;
  attemptMetadata?: Metadata;
  idempotencyKey: string;
}

export interface ClaimAndStartResult {
  claim: TaskClaim;
  attempt: TaskAttempt;
}

export interface SubmitOutcomeEvidence {
  evidence: Omit<AddLocalEvidenceInput, "taskId" | "attemptId">;
  criterionIds: string[];
}

export interface SubmitOutcomeInput {
  commitmentId: string;
  attemptId: string;
  expectedAttemptRevision: number;
  resolutionContractId: string;
  artifacts?: Array<Omit<LocalArtifactAppend, "taskId" | "attemptId">>;
  evidence: SubmitOutcomeEvidence[];
  summary?: string | null;
  attemptMessage?: string | null;
  idempotencyKey: string;
}

export interface SubmitOutcomeResult {
  artifacts: Artifact[];
  evidence: TaskEvidence[];
  attempt: TaskAttempt;
  proposal: CompletionProposal;
}

export interface EventCursorPage {
  events: Event[];
  nextCursor: { afterSequence: number };
}

export interface LocalTasqClient {
  readonly workspaceId: string;
  readonly actor: string;
  readonly principalId: string;
  readonly bootstrap: BootstrapCoordinationSpaceResult;
  readonly migration: MigrationResult;
  readonly commitments: {
    create(input: CreateCommitmentInput, options?: LocalMutationOptions): Promise<Commitment>;
    get(id: string): Promise<Commitment | null>;
    list(options?: Omit<ListCommitmentsOptions, "workspaceId" | "clock" | "now">): Promise<Commitment[]>;
    update(
      id: string,
      input: UpdateCommitmentInput,
      options: LocalMutationOptions & { expectedRevision: number },
    ): Promise<Commitment>;
    start(id: string, options: LocalCommitmentTransitionOptions): Promise<Commitment>;
    complete(id: string, options: LocalCommitmentTransitionOptions): Promise<Commitment>;
    block(id: string, options: LocalCommitmentTransitionOptions): Promise<Commitment>;
    unblock(id: string, options: LocalCommitmentTransitionOptions): Promise<Commitment>;
    cancel(id: string, options: LocalCommitmentTransitionOptions): Promise<Commitment>;
    reopen(id: string, options: LocalCommitmentTransitionOptions): Promise<Commitment>;
  };
  readonly agreements: {
    offer(input: AgreementOfferInputV1, options?: LocalMutationOptions): Promise<AgreementOfferV1>;
    get(id: string, at?: number): Promise<AgreementViewV1 | null>;
    list(): Promise<AgreementOfferV1[]>;
    accept(
      id: string,
      termsDigest: string,
      options?: LocalMutationOptions & { metadata?: Metadata },
    ): Promise<AgreementViewV1>;
    withdraw(
      id: string,
      input: { termsDigest: string; reason: string; metadata?: Metadata },
      options?: LocalMutationOptions,
    ): Promise<AgreementViewV1>;
    reject(
      id: string,
      input: { termsDigest: string; reason: string; metadata?: Metadata },
      options?: LocalMutationOptions,
    ): Promise<AgreementViewV1>;
  };
  readonly claims: {
    acquire(
      commitmentId: string,
      options?: Omit<AcquireClaimOptions, BoundServiceContext>,
    ): Promise<TaskClaim>;
    get(id: string): Promise<TaskClaim | null>;
    active(commitmentId: string): Promise<TaskClaim | null>;
    list(
      commitmentId?: string | null,
      options?: Omit<ListClaimsOptions, BoundServiceContext>,
    ): Promise<TaskClaim[]>;
    release(
      commitmentId: string,
      options: Omit<ReleaseClaimOptions, BoundServiceContext> & { expectedRevision: number },
    ): Promise<TaskClaim>;
  };
  readonly attempts: {
    start(
      commitmentId: string,
      options?: Omit<StartAttemptOptions, BoundServiceContext>,
    ): Promise<TaskAttempt>;
    get(id: string): Promise<TaskAttempt | null>;
    list(
      commitmentId?: string | null,
      options?: Omit<ListAttemptsOptions, BoundServiceContext>,
    ): Promise<TaskAttempt[]>;
    transition(
      id: string,
      status: AttemptStatus,
      options: Omit<TransitionAttemptOptions, BoundServiceContext> & { expectedRevision: number },
    ): Promise<TaskAttempt>;
  };
  readonly evidence: {
    add(input: AddLocalEvidenceInput, options?: LocalEvidenceOptions): Promise<TaskEvidence>;
    get(id: string): Promise<TaskEvidence | null>;
    list(
      commitmentId?: string | null,
      options?: Omit<ListEvidenceOptions, BoundServiceContext>,
    ): Promise<TaskEvidence[]>;
  };
  readonly assignments: {
    propose(input: LocalAssignmentProposal, options?: LocalMutationOptions): Promise<Assignment>;
    get(id: string): Promise<Assignment | null>;
    list(options?: {
      commitmentId?: string;
      assigneePrincipalId?: string;
      status?: AssignmentStatus;
    }): Promise<Assignment[]>;
    accept(id: string, options: LocalMutationOptions & { expectedRevision: number }): Promise<Assignment>;
    reject(id: string, options: LocalMutationOptions & { expectedRevision: number }): Promise<Assignment>;
    revoke(id: string, options: LocalMutationOptions & { expectedRevision: number }): Promise<Assignment>;
    release(id: string, options: LocalMutationOptions & { expectedRevision: number }): Promise<Assignment>;
  };
  readonly artifacts: {
    append(input: LocalArtifactAppend, options?: LocalMutationOptions): Promise<Artifact>;
    get(id: string): Promise<Artifact | null>;
    list(options?: { commitmentId?: string; attemptId?: string }): Promise<Artifact[]>;
  };
  readonly externalReferences: {
    append(input: LocalExternalRefAppend, options?: LocalMutationOptions): Promise<ExternalRef>;
    get(id: string): Promise<ExternalRef | null>;
    list(options?: { recordType?: string; recordId?: string }): Promise<ExternalRef[]>;
  };
  readonly effects: {
    propose(input: LocalEffectProposal, options?: LocalMutationOptions): Promise<Effect>;
    get(id: string): Promise<Effect | null>;
    list(options?: { commitmentId?: string; status?: EffectStatus }): Promise<Effect[]>;
    approvals: {
      record(
        input: Omit<EffectApprovalDecision, "tenantId">,
        options?: Omit<EffectAuthorityContext, BoundServiceContext>,
      ): Promise<EffectApproval>;
      get(id: string): Promise<EffectApproval | null>;
      current(effectId: string): Promise<EffectApproval | null>;
      list(options?: { effectId?: string; decision?: EffectApproval["decision"] }): Promise<EffectApproval[]>;
    };
    authorize(
      effectId: string,
      approvalId: string,
      options: LocalMutationOptions & { expectedRevision: number },
    ): Promise<Effect>;
    begin(
      effectId: string,
      options: Omit<BeginEffectExecutionOptions, BoundServiceContext>,
    ): Promise<BegunEffectExecution>;
    receipts: {
      record(
        input: Omit<EffectReceiptInput, "report"> & {
          report: Omit<EffectReceiptInput["report"], "workspaceId">;
        },
        options: Omit<RecordEffectReceiptOptions, BoundServiceContext>,
      ): Promise<EffectReceipt>;
      get(id: string): Promise<EffectReceipt | null>;
      list(effectId?: string): Promise<EffectReceipt[]>;
    };
    cancel(
      effectId: string,
      reason: string,
      options: LocalMutationOptions & { expectedRevision: number },
    ): Promise<Effect>;
  };
  readonly journeys: {
    claimAndStart(input: ClaimAndStartInput): Promise<ClaimAndStartResult>;
    submitOutcome(input: SubmitOutcomeInput): Promise<SubmitOutcomeResult>;
  };
  readonly resolution: {
    contracts: {
      create(input: ResolutionContractInsert, options?: LocalMutationOptions): Promise<ResolutionContract>;
      get(id: string): Promise<ResolutionContract | null>;
      list(commitmentId: string): Promise<ResolutionContract[]>;
    };
    trust: {
      attest(
        input: EvidenceTrustAttestationInsert,
        options?: LocalMutationOptions & { authority?: EvidenceTrustAuthority },
      ): Promise<EvidenceTrustRecord>;
      revoke(
        trustRecordId: string,
        options: LocalMutationOptions & { reason: string },
      ): Promise<EvidenceTrustRecord>;
      get(id: string): Promise<EvidenceTrustRecord | null>;
      list(commitmentId: string): Promise<EvidenceTrustRecord[]>;
    };
    proposals: {
      create(input: CompletionProposalInsert, options?: LocalMutationOptions): Promise<CompletionProposal>;
      get(id: string): Promise<CompletionProposal | null>;
      list(commitmentId: string): Promise<CompletionProposal[]>;
    };
    challenges: {
      create(input: CompletionChallengeInsert, options?: LocalMutationOptions): Promise<CompletionChallenge>;
      get(id: string): Promise<CompletionChallenge | null>;
      list(proposalId: string): Promise<CompletionChallenge[]>;
    };
    decisions: {
      evaluate(
        proposalId: string,
        evaluator: CompletionEvaluatorRuntime,
        options?: LocalMutationOptions & { supersedesDecisionId?: string | null },
      ): Promise<ValidationDecision>;
      attest(input: ManualValidationDecisionInsert, options?: LocalMutationOptions): Promise<ValidationDecision>;
      settle(proposalId: string, options?: LocalMutationOptions): Promise<ValidationDecision>;
      adjudicate(input: ManualValidationDecisionInsert, options?: LocalMutationOptions): Promise<ValidationDecision>;
      get(id: string): Promise<ValidationDecision | null>;
      list(proposalId: string): Promise<ValidationDecision[]>;
    };
    inspect(contractId: string): Promise<CompletionResolutionChain | null>;
  };
  readonly resources: {
    acquire(
      resourceKey: string,
      options: Omit<AcquireResourceLeaseOptions, BoundResourceContext>,
    ): ReturnType<typeof acquireResourceLease>;
    renew(
      resourceKey: string,
      options: Omit<RenewResourceLeaseOptions, BoundResourceContext>,
    ): ReturnType<typeof renewResourceLease>;
    release(
      resourceKey: string,
      options: Omit<ReleaseResourceLeaseOptions, BoundResourceContext>,
    ): ReturnType<typeof releaseResourceLease>;
    verify(
      resourceKey: string,
      options: Omit<VerifyResourceFenceOptions, BoundResourceContext>,
    ): ReturnType<typeof verifyResourceFence>;
    get(resourceKey: string): ReturnType<typeof getResourceLeaseView>;
    list(options?: Omit<ListResourceWorldOptions, BoundResourceContext>): ReturnType<typeof listResourceWorld>;
  };
  readonly inspect: (commitmentId: string) => Promise<CommitmentInspection | null>;
  readonly attestations: {
    issue(input: AttestationIssueInputV1, options?: LocalMutationOptions): Promise<AttestationV1>;
    revoke(
      id: string,
      input: {
        reasonCode: string;
        explanation?: string | null;
        effectiveAt?: number;
        metadata?: Metadata;
      },
      options?: LocalMutationOptions,
    ): Promise<AttestationRevocationV1>;
    get(id: string): Promise<AttestationV1 | null>;
    getRevocation(id: string): Promise<AttestationRevocationV1 | null>;
    current(input: {
      subject: AttestationSubjectV1;
      at: number;
      purpose?: { uri: string; version: number };
    }): Promise<AttestationV1[]>;
    evaluate(input: {
      subject: AttestationSubjectV1;
      requirements: AttestationRequirementV1[];
      at: number;
    }): Promise<AttestationEligibilityDecisionV1>;
  };
  readonly signedStatements: {
    get(statementId: string): ReturnType<typeof getSignedStatementProof>;
    listBindings(input?: {
      recordType?: string;
      recordId?: string;
      statementId?: string;
    }): Promise<SignedStatementBinding[]>;
  };
  readonly events: {
    get(id: string): Promise<Event | null>;
    list(options?: Omit<ListEventsOptions, "tenantId">): Promise<Event[]>;
  };
  readonly cursors: {
    events(
      afterSequence: number,
      options?: Omit<ListEventsOptions, "tenantId" | "afterSequence" | "beforeSequence" | "ascending">,
    ): Promise<EventCursorPage>;
    resources(
      afterSequence: number,
      options?: Omit<ListResourceEventsOptions, BoundResourceContext | "afterSequence">,
    ): ReturnType<typeof listResourceEvents>;
  };
  close(): Promise<void>;
}

function requireOptions(options: CreateLocalTasqOptions): void {
  if (!options.url?.trim()) throw new Error("url is required; Tasq never infers an embedded store");
  if (!options.workspaceId?.trim()) throw new Error("workspaceId is required");
  if (!options.actor?.trim()) throw new Error("actor is required");
  if (!options.clock || typeof options.clock.now !== "function") {
    throw new Error("clock is required");
  }
}

/** Open and initialize one explicit local Tasq composition. */
export async function createLocalTasq(options: CreateLocalTasqOptions): Promise<LocalTasqClient> {
  requireOptions(options);
  const handle = await openDb({ url: options.url, wal: options.wal });
  try {
    const migration = await runMigrations(handle.client, { clock: options.clock });
    const bootstrap = await bootstrapCoordinationSpace(handle.db, {
      workspaceId: options.workspaceId,
      actor: options.actor,
      clock: options.clock,
    });
    const principalId = bootstrap.principal.id;
    const kernelContext = <T extends object>(extra?: T) => ({
      workspaceId: options.workspaceId,
      actor: options.actor,
      principalId,
      clock: options.clock,
      ...(extra ?? {}),
    }) as {
      workspaceId: string;
      actor: string;
      principalId: string;
      clock: Clock;
    } & T;
    const serviceContext = <T extends object>(extra?: T) => ({
      tenantId: options.workspaceId,
      actor: options.actor,
      principalId,
      clock: options.clock,
      ...(extra ?? {}),
    }) as {
      tenantId: string;
      actor: string;
      principalId: string;
      clock: Clock;
    } & T;
    const resourceContext = <T extends object>(extra?: T) => ({
      workspaceId: options.workspaceId,
      actor: options.actor,
      principalId,
      clock: options.clock,
      ...(extra ?? {}),
    }) as {
      workspaceId: string;
      actor: string;
      principalId: string;
      clock: Clock;
    } & T;
    const transition = (
      operation: typeof startCommitment,
      id: string,
      transitionOptions: LocalCommitmentTransitionOptions,
    ) => operation(handle.db, id, kernelContext(transitionOptions) as CommitmentTransitionOptions);

    return {
      workspaceId: options.workspaceId,
      actor: options.actor,
      principalId,
      bootstrap,
      migration,
      commitments: {
        create: (input, mutation = {}) =>
          createCommitment(handle.db, input, kernelContext(mutation)),
        get: (id) => getCommitment(handle.db, id, options.workspaceId),
        list: (listOptions = {}) =>
          listCommitments(handle.db, { ...listOptions, workspaceId: options.workspaceId, clock: options.clock }),
        update: (id, input, mutation) =>
          updateCommitment(handle.db, id, input, kernelContext(mutation) as ReturnType<typeof kernelContext> & {
            expectedRevision: number;
          }),
        start: (id, mutation) => transition(startCommitment, id, mutation),
        complete: (id, mutation) => transition(completeCommitment, id, mutation),
        block: (id, mutation) => transition(blockCommitment, id, mutation),
        unblock: (id, mutation) => transition(unblockCommitment, id, mutation),
        cancel: (id, mutation) => transition(cancelCommitment, id, mutation),
        reopen: (id, mutation) => transition(reopenCommitment, id, mutation),
      },
      agreements: {
        offer: (input, mutation = {}) => offerAgreement(handle.db, input, serviceContext(mutation)),
        get: (id, at = options.clock.now()) => getAgreementView(handle.db, id, options.workspaceId, at),
        list: () => listAgreementOffers(handle.db, options.workspaceId),
        accept: (id, termsDigest, mutation = {}) => acceptAgreement(handle.db, id, {
          termsDigest, metadata: mutation.metadata,
        }, serviceContext(mutation)),
        withdraw: (id, input, mutation = {}) =>
          withdrawAgreement(handle.db, id, input, serviceContext(mutation)),
        reject: (id, input, mutation = {}) =>
          rejectAgreement(handle.db, id, input, serviceContext(mutation)),
      },
      claims: {
        acquire: (id, claimOptions = {}) =>
          acquireTaskClaim(handle.db, id, serviceContext(claimOptions)),
        get: (id) => getTaskClaim(handle.db, id, options.workspaceId),
        active: (id) => getActiveTaskClaim(handle.db, id, options.workspaceId, options.clock),
        list: (id = null, listOptions = {}) =>
          listTaskClaims(handle.db, id, serviceContext(listOptions)),
        release: (id, releaseOptions) =>
          releaseTaskClaim(handle.db, id, serviceContext(releaseOptions)),
      },
      attempts: {
        start: (id, attemptOptions = {}) =>
          startTaskAttempt(handle.db, id, serviceContext(attemptOptions)),
        get: (id) => getTaskAttempt(handle.db, id, options.workspaceId),
        list: (id = null, listOptions = {}) =>
          listTaskAttempts(handle.db, id, serviceContext(listOptions)),
        transition: (id, status, transitionOptions) =>
          transitionTaskAttempt(handle.db, id, status, serviceContext(transitionOptions)),
      },
      evidence: {
        add: (input, evidenceOptions = {}) =>
          addTaskEvidence(handle.db, { ...input, tenantId: options.workspaceId }, serviceContext(evidenceOptions)),
        get: (id) => getTaskEvidence(handle.db, id, options.workspaceId),
        list: (id = null, listOptions = {}) =>
          listTaskEvidence(handle.db, id, serviceContext(listOptions)),
      },
      assignments: {
        propose: (input, mutation = {}) => proposeAssignment(handle.db, {
          ...input,
          tenantId: options.workspaceId,
          assignerPrincipalId: principalId,
        }, serviceContext(mutation)),
        get: (id) => getAssignment(handle.db, id, options.workspaceId),
        list: (listOptions = {}) => listAssignments(handle.db, {
          tenantId: options.workspaceId,
          taskId: listOptions.commitmentId,
          assigneePrincipalId: listOptions.assigneePrincipalId,
          status: listOptions.status,
        }),
        accept: (id, mutation) => acceptAssignment(handle.db, id, serviceContext(mutation)),
        reject: (id, mutation) => rejectAssignment(handle.db, id, serviceContext(mutation)),
        revoke: (id, mutation) => revokeAssignment(handle.db, id, serviceContext(mutation)),
        release: (id, mutation) => releaseAssignment(handle.db, id, serviceContext(mutation)),
      },
      artifacts: {
        append: (input, mutation = {}) => appendArtifact(handle.db, {
          ...input,
          tenantId: options.workspaceId,
        }, serviceContext(mutation)),
        get: (id) => getArtifact(handle.db, id, options.workspaceId),
        list: (listOptions = {}) => listArtifacts(handle.db, {
          tenantId: options.workspaceId,
          taskId: listOptions.commitmentId,
          attemptId: listOptions.attemptId,
        }),
      },
      externalReferences: {
        append: (input, mutation = {}) => appendExternalRef(handle.db, {
          ...input,
          tenantId: options.workspaceId,
        }, serviceContext(mutation)),
        get: (id) => getExternalRef(handle.db, id, options.workspaceId),
        list: (listOptions = {}) => listExternalRefs(handle.db, {
          tenantId: options.workspaceId,
          ...listOptions,
        }),
      },
      effects: {
        propose: (input, mutation = {}) => proposeEffect(handle.db, {
          ...input,
          tenantId: options.workspaceId,
          request: { ...input.request, workspaceId: options.workspaceId },
        }, serviceContext(mutation)),
        get: (id) => getEffect(handle.db, id, options.workspaceId),
        list: (listOptions = {}) => listEffects(handle.db, {
          tenantId: options.workspaceId,
          taskId: listOptions.commitmentId,
          status: listOptions.status,
        }),
        approvals: {
          record: (input, mutation = {}) => recordEffectApproval(handle.db, {
            ...input,
            tenantId: options.workspaceId,
          }, serviceContext(mutation)),
          get: (id) => getEffectApproval(handle.db, id, options.workspaceId),
          current: (id) => getEffectiveEffectApproval(handle.db, id, options.workspaceId),
          list: (listOptions = {}) => listEffectApprovals(handle.db, {
            tenantId: options.workspaceId,
            ...listOptions,
          }),
        },
        authorize: (effectId, approvalId, mutation) =>
          authorizeEffect(handle.db, effectId, approvalId, serviceContext(mutation)),
        begin: (effectId, mutation) =>
          beginEffectExecution(handle.db, effectId, serviceContext(mutation)),
        receipts: {
          record: (input, mutation) => recordEffectReceipt(handle.db, {
            ...input,
            report: { ...input.report, workspaceId: options.workspaceId },
          }, serviceContext(mutation)),
          get: (id) => getEffectReceipt(handle.db, id, options.workspaceId),
          list: (effectId) => listEffectReceipts(handle.db, {
            tenantId: options.workspaceId,
            effectId,
          }),
        },
        cancel: (effectId, reason, mutation) =>
          cancelEffect(handle.db, effectId, reason, serviceContext(mutation)),
      },
      journeys: {
        claimAndStart: async (input) => {
          const idempotencyKey = input.idempotencyKey.trim();
          if (!idempotencyKey) throw new Error("claimAndStart requires an idempotencyKey");
          return runInTransaction(handle.db, async (tx) => {
            const db = tx as unknown as TasqDb;
            const claim = await acquireTaskClaim(db, input.commitmentId, serviceContext({
              leaseMs: input.leaseMs,
              metadata: input.claimMetadata,
              idempotencyKey: `${idempotencyKey}:claim`,
            }));
            const attempt = await startTaskAttempt(db, input.commitmentId, serviceContext({
              claimId: claim.id,
              runtime: input.runtime,
              externalId: input.externalId,
              contextId: input.contextId,
              metadata: input.attemptMetadata,
              idempotencyKey: `${idempotencyKey}:attempt`,
            }));
            return { claim, attempt };
          });
        },
        submitOutcome: async (input) => {
          const idempotencyKey = input.idempotencyKey.trim();
          if (!idempotencyKey) throw new Error("submitOutcome requires an idempotencyKey");
          if (input.evidence.length === 0) throw new Error("submitOutcome requires evidence");
          return runInTransaction(handle.db, async (tx) => {
            const db = tx as unknown as TasqDb;
            const artifacts: Artifact[] = [];
            for (const [index, artifact] of (input.artifacts ?? []).entries()) {
              artifacts.push(await appendArtifact(db, {
                ...artifact,
                tenantId: options.workspaceId,
                taskId: input.commitmentId,
                attemptId: input.attemptId,
              }, serviceContext({ idempotencyKey: `${idempotencyKey}:artifact:${index}` })));
            }

            const evidence: TaskEvidence[] = [];
            const criterionEvidence = new Map<string, string[]>();
            for (const [index, entry] of input.evidence.entries()) {
              const criterionIds = [...new Set(entry.criterionIds.map((value) => value.trim()))]
                .filter(Boolean)
                .sort();
              if (criterionIds.length === 0) {
                throw new Error(`submitOutcome evidence ${index} requires at least one criterionId`);
              }
              const recorded = await addTaskEvidence(db, {
                ...entry.evidence,
                tenantId: options.workspaceId,
                taskId: input.commitmentId,
                attemptId: input.attemptId,
              }, serviceContext({ idempotencyKey: `${idempotencyKey}:evidence:${index}` }));
              evidence.push(recorded);
              for (const criterionId of criterionIds) {
                const ids = criterionEvidence.get(criterionId) ?? [];
                ids.push(recorded.id);
                criterionEvidence.set(criterionId, ids);
              }
            }

            const attempt = await transitionTaskAttempt(db, input.attemptId, "succeeded", serviceContext({
              expectedRevision: input.expectedAttemptRevision,
              message: input.attemptMessage,
              idempotencyKey: `${idempotencyKey}:attempt-succeeded`,
            }));
            if (attempt.taskId !== input.commitmentId) {
              throw new Error("submitOutcome attempt does not belong to commitment");
            }
            const proposal = await proposeCompletion(db, {
              taskId: input.commitmentId,
              resolutionContractId: input.resolutionContractId,
              criterionEvidence: [...criterionEvidence.entries()]
                .sort(([left], [right]) => left.localeCompare(right))
                .map(([criterionId, evidenceIds]) => ({ criterionId, evidenceIds })),
              summary: input.summary ?? null,
            }, serviceContext({ idempotencyKey: `${idempotencyKey}:proposal` }));
            return { artifacts, evidence, attempt, proposal };
          });
        },
      },
      resolution: {
        contracts: {
          create: (input, mutation = {}) =>
            createResolutionContract(handle.db, input, serviceContext(mutation)),
          get: (id) => getResolutionContract(handle.db, id, options.workspaceId),
          list: (id) => listResolutionContracts(handle.db, id, options.workspaceId),
        },
        trust: {
          attest: (input, mutation = {}) =>
            attestEvidenceTrust(handle.db, input, serviceContext(mutation)),
          revoke: (id, mutation) =>
            revokeEvidenceTrust(handle.db, id, { ...serviceContext(), ...mutation }),
          get: (id) => getEvidenceTrustRecord(handle.db, id, options.workspaceId),
          list: (id) => listEvidenceTrustRecords(handle.db, id, options.workspaceId),
        },
        proposals: {
          create: (input, mutation = {}) =>
            proposeCompletion(handle.db, input, serviceContext(mutation)),
          get: (id) => getCompletionProposal(handle.db, id, options.workspaceId),
          list: (id) => listCompletionProposals(handle.db, id, options.workspaceId),
        },
        challenges: {
          create: (input, mutation = {}) =>
            challengeCompletion(handle.db, input, serviceContext(mutation)),
          get: (id) => getCompletionChallenge(handle.db, id, options.workspaceId),
          list: (id) => listCompletionChallenges(handle.db, id, options.workspaceId),
        },
        decisions: {
          evaluate: (id, evaluator, mutation = {}) =>
            evaluateCompletionDeterministically(handle.db, id, {
              ...serviceContext(mutation), evaluator,
              supersedesDecisionId: mutation.supersedesDecisionId,
            }),
          attest: (input, mutation = {}) =>
            attestCompletion(handle.db, input, serviceContext(mutation)),
          settle: (id, mutation = {}) =>
            settleOptimisticCompletion(handle.db, id, serviceContext(mutation)),
          adjudicate: (input, mutation = {}) =>
            adjudicateCompletion(handle.db, input, serviceContext(mutation)),
          get: (id) => getValidationDecision(handle.db, id, options.workspaceId),
          list: (id) => listValidationDecisions(handle.db, id, options.workspaceId),
        },
        inspect: (id) => getCompletionResolutionChain(handle.db, id, options.workspaceId),
      },
      resources: {
        acquire: (key, leaseOptions) =>
          acquireResourceLease(handle.db, key, resourceContext(leaseOptions) as AcquireResourceLeaseOptions),
        renew: (key, leaseOptions) =>
          renewResourceLease(handle.db, key, resourceContext(leaseOptions) as RenewResourceLeaseOptions),
        release: (key, leaseOptions) =>
          releaseResourceLease(handle.db, key, resourceContext(leaseOptions) as ReleaseResourceLeaseOptions),
        verify: (key, verifyOptions) =>
          verifyResourceFence(handle.db, key, resourceContext(verifyOptions) as VerifyResourceFenceOptions),
        get: (key) => getResourceLeaseView(handle.db, key, resourceContext()),
        list: (listOptions = {}) =>
          listResourceWorld(handle.db, resourceContext(listOptions) as ListResourceWorldOptions),
      },
      inspect: (id) =>
        inspectCommitment(handle.db, id, { workspaceId: options.workspaceId, clock: options.clock }),
      attestations: {
        issue: (input, mutation = {}) =>
          issueAttestation(handle.db, input, serviceContext(mutation)),
        revoke: (id, input, mutation = {}) =>
          revokeAttestation(handle.db, id, input, serviceContext(mutation)),
        get: (id) => getAttestation(handle.db, id, options.workspaceId),
        getRevocation: (id) => getAttestationRevocation(handle.db, id, options.workspaceId),
        current: (input) => listCurrentAttestations(handle.db, {
          ...input,
          workspaceId: options.workspaceId,
        }),
        evaluate: (input) => evaluateAttestationEligibility(handle.db, {
          ...input,
          workspaceId: options.workspaceId,
        }),
      },
      signedStatements: {
        get: (statementId) =>
          getSignedStatementProof(handle.db, statementId, options.workspaceId),
        listBindings: (input = {}) =>
          listSignedStatementBindings(handle.db, {
            tenantId: options.workspaceId,
            ...input,
          }),
      },
      events: {
        get: (id) => getEvent(handle.db, id, options.workspaceId),
        list: (listOptions = {}) =>
          listEvents(handle.db, { ...listOptions, tenantId: options.workspaceId }),
      },
      cursors: {
        events: async (afterSequence, cursorOptions = {}) => {
          const events = await listEvents(handle.db, {
            ...cursorOptions,
            tenantId: options.workspaceId,
            afterSequence,
            ascending: true,
          });
          return {
            events,
            nextCursor: { afterSequence: events.at(-1)?.sequence ?? afterSequence },
          };
        },
        resources: (afterSequence, cursorOptions = {}) =>
          listResourceEvents(handle.db, resourceContext({
            ...cursorOptions,
            afterSequence,
          }) as ListResourceEventsOptions),
      },
      close: handle.close,
    };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

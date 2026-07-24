import { Buffer } from "node:buffer";
import {
  acceptReplicationPush,
  acceptSignedStatement,
  createLocalTasq,
  initializeReplicationAuthority,
  openDb,
  prepareSignedStatementAcceptance,
  pullReplication,
  registerReplicationReplica,
  runKernelMigrations,
  type Commitment,
  type LocalTasqClient,
} from "@tasq-run/core";
import {
  ED25519_VERIFIER_IMPLEMENTATION_DIGEST,
  verifyPurposeBoundStatement,
} from "@tasq-run/extension-sdk";
import {
  SignedStatementBundleV1,
  SignedStatementBindingKind,
  ReplicationPushRequest,
  type Clock,
  type SigningCredentialV1,
} from "@tasq-run/schema";
import { digestAuthorityValue } from "@tasq-internal/authority";
import { z } from "zod";
import {
  HostedMutationError,
  type HostedCommitmentRead,
  type HostedEventMetadata,
  type HostedMutationCommand,
  type HostedMutationOperation,
  type HostedMutationOutcome,
  type HostedMutationWorkspace,
} from "./http.js";
import {
  openHostedWorkspaceReceiptStore,
  type HostedWorkspaceReceiptStore,
} from "./workspace-receipts.js";

export const HOSTED_CORE_WORKSPACE_CONTRACT_VERSION = "tasq.hosted-core-workspace.v1" as const;

const Metadata = z.record(z.unknown()).default({});
const PortableId = z.string().min(1).max(500);
const LeaseMs = z.number().int().positive().max(86_400_000);

function contract(uri: string, semantic: unknown) {
  return {
    uri,
    version: 1,
    implementationDigest: digestAuthorityValue({ uri, version: 1, semantic }),
  };
}

function operation(
  id: string,
  actionUri: string,
  summary: string,
  requiresExpectedRevision: boolean,
  inputSemantic: unknown,
  outputSemantic: unknown,
): HostedMutationOperation {
  return {
    id,
    actionUri,
    summary,
    requiresExpectedRevision,
    inputContract: contract(`urn:tasq:server:input:${id}:v1`, inputSemantic),
    outputContract: contract(`urn:tasq:server:output:${id}:v1`, outputSemantic),
  };
}

export const HOSTED_CORE_OPERATIONS: readonly HostedMutationOperation[] = Object.freeze([
  operation("commitment.propose", "urn:tasq:action:commitment.propose", "Create a commitment", false,
    ["title", "description?", "successCriteria?", "completionPolicy?", "validationRequired?", "priority?", "notBefore?", "dueAt?", "metadata?"],
    "commitment"),
  operation("commitment.update", "urn:tasq:action:commitment.mutate", "Update a commitment", true,
    "partial_commitment_fields", "commitment"),
  operation("commitment.transition", "urn:tasq:action:commitment.mutate", "Transition commitment state", true,
    ["transition", "reason?", "note?", "evidenceIds?", "validationDecisionId?"], "commitment"),
  operation("claim.acquire", "urn:tasq:action:claim.coordinate", "Acquire or renew a claim", false,
    ["leaseMs?", "metadata?"], "claim"),
  operation("claim.release", "urn:tasq:action:claim.coordinate", "Release a claim", true,
    ["reason?"], "claim"),
  operation("attempt.start", "urn:tasq:action:attempt.execute", "Start an execution attempt", false,
    ["runtime?", "externalId?", "contextId?", "claimId?", "metadata?"], "attempt"),
  operation("attempt.transition", "urn:tasq:action:attempt.execute", "Finish or update an attempt", true,
    ["attemptId", "status", "message?"], "attempt"),
  operation("evidence.add", "urn:tasq:action:evidence.append", "Append commitment evidence", false,
    ["attemptId?", "kind", "summary?", "uri?", "digest?", "source?", "observedAt?", "metadata?"], "evidence"),
  operation("resolution.trust.attest-unverified", "urn:tasq:action:resolution.trust", "Record an explicitly unverified evidence trust attestation", false,
    ["evidenceId", "reason"], "evidence_trust_record"),
  operation("resolution.proposal.create", "urn:tasq:action:resolution.propose", "Propose completion against a resolution contract", false,
    ["resolutionContractId", "criterionEvidence", "summary?"], "completion_proposal"),
  operation("resolution.decision.attest", "urn:tasq:action:resolution.decide", "Record an authorized manual validation decision", false,
    ["proposalId", "outcome", "reasonCode", "explanation", "supersedesDecisionId?"], "validation_decision"),
  operation("statement.accept", "urn:tasq:action:statement.accept", "Accept one exact purpose-bound signed statement and typed binding", false,
    ["bundle", "binding"], "signed_statement_proof"),
  operation("replication.enroll", "urn:tasq:action:replication.enroll", "Bind one offline replica generation to the authenticated principal", false,
    ["generationId"], "replica_registration"),
  operation("replication.push", "urn:tasq:action:replication.push", "Push signed offline-speculative commitment operations", false,
    ["request", "signedOrigins"], "replication_push"),
  operation("replication.pull", "urn:tasq:action:replication.pull", "Pull bounded replication results or a recovery snapshot", false,
    ["generationId", "cursor?", "limit?"], "replication_pull"),
  operation("resource.acquire", "urn:tasq:action:resource.coordinate", "Acquire an opaque resource lease", false,
    ["leaseMs?", "metadata?"], "resource_lease"),
  operation("resource.renew", "urn:tasq:action:resource.coordinate", "Renew an opaque resource lease", true,
    ["leaseId", "fence", "leaseMs?"], "resource_lease"),
  operation("resource.release", "urn:tasq:action:resource.coordinate", "Release an opaque resource lease", true,
    ["leaseId", "fence", "reason?"], "resource_lease"),
]);

const CommitmentCreate = z.object({
  title: z.string().min(1).max(500),
  description: z.string().nullable().optional(),
  successCriteria: z.string().min(1).max(2_000).nullable().optional(),
  completionPolicy: z.enum(["assertion", "evidence"]).optional(),
  validationRequired: z.boolean().optional(),
  priority: z.number().int().min(1).max(5).nullable().optional(),
  notBefore: z.number().int().nonnegative().nullable().optional(),
  dueAt: z.number().int().nonnegative().nullable().optional(),
  metadata: Metadata.optional(),
}).strict();
const CommitmentUpdate = CommitmentCreate.omit({ title: true }).extend({
  title: z.string().min(1).max(500).optional(),
}).partial().strict();
const CommitmentTransition = z.object({
  transition: z.enum(["start", "complete", "block", "unblock", "cancel", "reopen"]),
  reason: z.string().min(1).max(2_000).optional(),
  note: z.string().min(1).max(10_000).optional(),
  evidenceIds: z.array(PortableId).max(100).optional(),
  validationDecisionId: PortableId.optional(),
}).strict();
const ClaimAcquire = z.object({ leaseMs: LeaseMs.optional(), metadata: Metadata.optional() }).strict();
const ClaimRelease = z.object({ reason: z.string().min(1).max(2_000).optional() }).strict();
const AttemptStart = z.object({
  runtime: z.string().min(1).max(200).optional(),
  externalId: z.string().min(1).max(500).nullable().optional(),
  contextId: z.string().min(1).max(500).nullable().optional(),
  claimId: PortableId.nullable().optional(),
  metadata: Metadata.optional(),
}).strict();
const AttemptTransition = z.object({
  attemptId: PortableId,
  status: z.enum(["running", "input_required", "succeeded", "failed", "cancelled"]),
  message: z.string().max(10_000).nullable().optional(),
}).strict();
const EvidenceAdd = z.object({
  attemptId: PortableId.nullable().optional(),
  kind: z.string().min(1).max(200),
  summary: z.string().max(10_000).nullable().optional(),
  uri: z.string().max(4_000).nullable().optional(),
  digest: z.string().max(500).nullable().optional(),
  source: z.string().max(500).nullable().optional(),
  observedAt: z.number().int().nonnegative().optional(),
  metadata: Metadata.optional(),
}).strict();
const EvidenceTrustAttestUnverified = z.object({
  evidenceId: PortableId,
  reason: z.string().min(1).max(2_000),
}).strict();
const ResolutionProposalCreate = z.object({
  resolutionContractId: PortableId,
  criterionEvidence: z.array(z.object({
    criterionId: z.string().min(1).max(120),
    evidenceIds: z.array(PortableId).min(1).max(100),
  }).strict()).min(1).max(100),
  summary: z.string().min(1).max(2_000).nullable().optional(),
}).strict();
const ResolutionDecisionAttest = z.object({
  proposalId: PortableId,
  outcome: z.enum(["accepted", "rejected", "too_early", "indeterminate", "challenged"]),
  reasonCode: z.string().min(1).max(120),
  explanation: z.string().min(1).max(2_000),
  supersedesDecisionId: PortableId.nullable().optional(),
}).strict();
const SignedStatementAccept = z.object({
  bundle: SignedStatementBundleV1,
  binding: z.object({
    bindingKind: SignedStatementBindingKind,
    recordType: z.string().min(1).max(120),
    recordId: PortableId,
    recordDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    metadata: Metadata.optional(),
  }).strict(),
}).strict();
const ReplicationEnroll = z.object({
  generationId: z.string().uuid(),
}).strict();
const ReplicationPush = z.object({
  request: ReplicationPushRequest,
  signedOrigins: z.array(SignedStatementBundleV1).min(1).max(500),
}).strict();
const ReplicationPull = z.object({
  generationId: z.string().uuid(),
  cursor: z.string().min(1).max(4_096).nullable().optional(),
  limit: z.number().int().min(1).max(1_000).optional(),
}).strict();
const ResourceAcquire = z.object({ leaseMs: LeaseMs.optional(), metadata: Metadata.optional() }).strict();
const ResourceRenew = z.object({
  leaseId: PortableId,
  fence: z.number().int().positive(),
  leaseMs: LeaseMs.optional(),
}).strict();
const ResourceRelease = z.object({
  leaseId: PortableId,
  fence: z.number().int().positive(),
  reason: z.string().min(1).max(2_000).optional(),
}).strict();

function hostedCommitment(value: Commitment): HostedCommitmentRead {
  return {
    id: value.id,
    workspaceId: value.workspaceId,
    title: value.title,
    status: value.status,
    revision: value.revision,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

function encodeCursor(value: { updatedAt: number; id: string }): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decodeCursor(value: string): { updatedAt: number; id: string } {
  try {
    return z.object({
      updatedAt: z.number().int().nonnegative(),
      id: PortableId,
    }).strict().parse(JSON.parse(Buffer.from(value, "base64url").toString("utf8")));
  } catch {
    throw new HostedMutationError("invalid_input");
  }
}

function mapDomainError(error: unknown): never {
  if (error instanceof HostedMutationError) throw error;
  if (error instanceof z.ZodError) throw new HostedMutationError("invalid_input");
  const code = typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : "";
  if (["contended", "stale_fence", "not_holder", "already_claimed", "conflict"].includes(code)) {
    throw new HostedMutationError("conflict");
  }
  if (code === "not_found") throw new HostedMutationError("not_found");
  if (code === "invalid_input") throw new HostedMutationError("invalid_input");
  const message = error instanceof Error ? error.message : String(error);
  if (/not found|does not belong|points at missing/i.test(message)) {
    throw new HostedMutationError("not_found");
  }
  if (/claimed by|already active|revision|conflict|stale|not the active holder|cannot (claim|transition)|invalid transition/i.test(message)) {
    throw new HostedMutationError("conflict");
  }
  if (/invalid|required|must be|expected/i.test(message)) throw new HostedMutationError("invalid_input");
  throw new HostedMutationError("unavailable");
}

export interface HostedCoreWorkspaceOptions {
  workspaceId: string;
  databaseUrl: string;
  receiptDatabaseUrl: string;
  clock: Clock;
  signedStatements?: {
    audience: string;
    /** Exact authority roots accepted by this workspace. Empty means deny all. */
    acceptedTrustRootDigests: readonly string[];
    resolveCredential(id: string): Promise<SigningCredentialV1 | null>;
  };
}

export interface HostedCoreWorkspace extends HostedMutationWorkspace {
  close(): Promise<void>;
}

export async function createHostedCoreWorkspace(options: HostedCoreWorkspaceOptions): Promise<HostedCoreWorkspace> {
  const receipts: HostedWorkspaceReceiptStore = await openHostedWorkspaceReceiptStore(options.receiptDatabaseUrl);
  const open = (actor: string) => createLocalTasq({
    url: options.databaseUrl,
    workspaceId: options.workspaceId,
    actor,
    clock: options.clock,
  });
  const withClient = async <T>(actor: string, run: (client: LocalTasqClient) => Promise<T>): Promise<T> => {
    const client = await open(actor);
    try {
      return await run(client);
    } finally {
      await client.close();
    }
  };
  const bootstrap = await openDb({ url: options.databaseUrl, wal: true });
  try {
    await runKernelMigrations(bootstrap.client, { clock: options.clock });
    await initializeReplicationAuthority(bootstrap.db, {
      workspaceId: options.workspaceId,
      clock: options.clock,
    });
  } finally {
    await bootstrap.close();
  }

  async function outcome(
    command: HostedMutationCommand,
    resultType: string,
    result: Record<string, unknown>,
  ): Promise<HostedMutationOutcome> {
    const resultId = PortableId.parse(result["id"] ?? command.resource.id);
    const revision = result["revision"];
    const eventSequence = await withClient("server:receipt", async (client) => {
      const events = await client.events.list({ entityId: command.resource.id, limit: 1 });
      return events[0]?.sequence ?? null;
    });
    return {
      contractVersion: "tasq.hosted-mutation-outcome.v1",
      workspaceId: options.workspaceId,
      operationId: command.operation.id,
      requestDigest: command.requestDigest,
      idempotencyKeyDigest: command.idempotencyKeyDigest,
      resultType,
      resultId,
      resultRevision: typeof revision === "number" && Number.isSafeInteger(revision) && revision > 0 ? revision : null,
      eventSequence,
      replayed: false,
      result,
    };
  }

  return {
    workspaceId: options.workspaceId,
    async getCommitment(id) {
      return withClient("server:reader", async (client) => {
        const value = await client.commitments.get(id);
        return value ? hostedCommitment(value) : null;
      });
    },
    async listCommitments({ cursor, limit }) {
      return withClient("server:reader", async (client) => {
        const values = await client.commitments.list({
          limit: limit + 1,
          includeDeleted: false,
          includeDeferred: true,
          ...(cursor ? { before: decodeCursor(cursor) } : {}),
        });
        const hasMore = values.length > limit;
        const items = values.slice(0, limit);
        const tail = items.at(-1);
        return {
          items: items.map(hostedCommitment),
          nextCursor: hasMore && tail ? encodeCursor({ updatedAt: tail.updatedAt, id: tail.id }) : null,
        };
      });
    },
    async listEventMetadata({ afterSequence, limit }) {
      return withClient("server:reader", async (client) => {
        const page = await client.cursors.events(afterSequence, { limit });
        const items: HostedEventMetadata[] = page.events.map((event) => ({
          id: event.id,
          sequence: event.sequence,
          entityType: event.entityType,
          entityId: event.entityId,
          eventType: event.eventType,
          actorPrincipalId: event.principalId,
          createdAt: event.createdAt,
        }));
        return { items, nextSequence: items.at(-1)?.sequence ?? null };
      });
    },
    async executeMutation(command) {
      const actor = command.decision.actorPrincipalId ?? command.decision.subjectPrincipalId;
      if (!actor) throw new HostedMutationError("conflict");
      try {
        const prior = await receipts.find({
          workspaceId: command.workspaceId,
          idempotencyKeyDigest: command.idempotencyKeyDigest,
          requestDigest: command.requestDigest,
          operationId: command.operation.id,
        });
        if (prior) return prior;
        const result = await withClient(actor, async (client) => {
          const expectedRevision = command.expectedRevision;
          switch (command.operation.id) {
            case "commitment.propose": {
              const result = await client.commitments.create(CommitmentCreate.parse(command.input), {
                idempotencyKey: command.idempotencyKey,
              });
              return outcome(command, "commitment", result as unknown as Record<string, unknown>);
            }
            case "commitment.update": {
              if (expectedRevision === null) throw new HostedMutationError("invalid_input");
              const result = await client.commitments.update(
                command.resource.id,
                CommitmentUpdate.parse(command.input),
                { expectedRevision, idempotencyKey: command.idempotencyKey },
              );
              return outcome(command, "commitment", result as unknown as Record<string, unknown>);
            }
            case "commitment.transition": {
              if (expectedRevision === null) throw new HostedMutationError("invalid_input");
              const input = CommitmentTransition.parse(command.input);
              const transition = client.commitments[input.transition];
              const result = await transition(command.resource.id, {
                expectedRevision,
                idempotencyKey: command.idempotencyKey,
                ...(input.reason ? { reason: input.reason } : {}),
                ...(input.note ? { note: input.note } : {}),
                ...(input.evidenceIds ? { evidenceIds: input.evidenceIds } : {}),
                ...(input.validationDecisionId ? { validationDecisionId: input.validationDecisionId } : {}),
              });
              return outcome(command, "commitment", result as unknown as Record<string, unknown>);
            }
            case "claim.acquire": {
              const input = ClaimAcquire.parse(command.input);
              const result = await client.claims.acquire(command.resource.id, {
                ...input,
                idempotencyKey: command.idempotencyKey,
              });
              return outcome(command, "claim", result as unknown as Record<string, unknown>);
            }
            case "claim.release": {
              if (expectedRevision === null) throw new HostedMutationError("invalid_input");
              const input = ClaimRelease.parse(command.input);
              const result = await client.claims.release(command.resource.id, {
                expectedRevision,
                idempotencyKey: command.idempotencyKey,
                reason: input.reason,
              });
              return outcome(command, "claim", result as unknown as Record<string, unknown>);
            }
            case "attempt.start": {
              const input = AttemptStart.parse(command.input);
              const result = await client.attempts.start(command.resource.id, {
                ...input,
                idempotencyKey: command.idempotencyKey,
              });
              return outcome(command, "attempt", result as unknown as Record<string, unknown>);
            }
            case "attempt.transition": {
              if (expectedRevision === null) throw new HostedMutationError("invalid_input");
              const input = AttemptTransition.parse(command.input);
              const result = await client.attempts.transition(input.attemptId, input.status, {
                expectedRevision,
                idempotencyKey: command.idempotencyKey,
                message: input.message,
              });
              return outcome(command, "attempt", result as unknown as Record<string, unknown>);
            }
            case "evidence.add": {
              const input = EvidenceAdd.parse(command.input);
              const result = await client.evidence.add({
                taskId: command.resource.id,
                ...input,
              }, { idempotencyKey: command.idempotencyKey });
              return outcome(command, "evidence", result as unknown as Record<string, unknown>);
            }
            case "resolution.trust.attest-unverified": {
              const input = EvidenceTrustAttestUnverified.parse(command.input);
              const result = await client.resolution.trust.attest({
                taskId: command.resource.id,
                evidenceId: input.evidenceId,
                authenticity: "unverified",
                authorityUri: "urn:tasq:authority:hosted-human-attribution",
                authorityVersion: 1,
                authorityDigest: digestAuthorityValue({
                  authorityUri: "urn:tasq:authority:hosted-human-attribution",
                  authorityVersion: 1,
                  semantic: "records attribution only; makes no authenticity claim",
                }),
                reason: input.reason,
                verifiedAt: command.evaluatedAt,
                validUntil: null,
                retentionUntil: null,
              }, { idempotencyKey: command.idempotencyKey });
              return outcome(command, "evidence_trust_record", result as unknown as Record<string, unknown>);
            }
            case "resolution.proposal.create": {
              const input = ResolutionProposalCreate.parse(command.input);
              const result = await client.resolution.proposals.create({
                taskId: command.resource.id,
                resolutionContractId: input.resolutionContractId,
                criterionEvidence: input.criterionEvidence,
                summary: input.summary ?? null,
              }, { idempotencyKey: command.idempotencyKey });
              return outcome(command, "completion_proposal", result as unknown as Record<string, unknown>);
            }
            case "resolution.decision.attest": {
              const input = ResolutionDecisionAttest.parse(command.input);
              const result = await client.resolution.decisions.attest({
                proposalId: input.proposalId,
                outcome: input.outcome,
                reasonCode: input.reasonCode,
                explanation: input.explanation,
                supersedesDecisionId: input.supersedesDecisionId ?? null,
              }, { idempotencyKey: command.idempotencyKey });
              return outcome(command, "validation_decision", result as unknown as Record<string, unknown>);
            }
            case "statement.accept": {
              if (!options.signedStatements || command.resource.kind !== "workspace"
                || command.resource.id !== options.workspaceId) {
                throw new HostedMutationError("invalid_input");
              }
              const input = SignedStatementAccept.parse(command.input);
              const opened = await openDb({ url: options.databaseUrl, wal: true });
              try {
                await runKernelMigrations(opened.client, { clock: options.clock });
                const accepted = await acceptSignedStatement(opened.db, {
                  bundle: input.bundle,
                  expectedAudience: options.signedStatements.audience,
                  acceptedTrustRootDigests:
                    options.signedStatements.acceptedTrustRootDigests,
                  binding: {
                    ...input.binding,
                    recordDigest: input.binding.recordDigest as `sha256:${string}`,
                  },
                  verify: async (request) => {
                    const verified = await verifyPurposeBoundStatement({
                      ...request,
                      resolveCredential: options.signedStatements!.resolveCredential,
                    });
                    return {
                      ...verified,
                      credential: verified.credential ? {
                        ...verified.credential,
                        publicMaterialDigest: verified.credential.publicMaterialDigest as `sha256:${string}`,
                        trustRootDigest: verified.credential.trustRootDigest as `sha256:${string}`,
                      } : null,
                      verifierImplementationDigest: ED25519_VERIFIER_IMPLEMENTATION_DIGEST,
                    };
                  },
                }, {
                  tenantId: options.workspaceId,
                  actor,
                  principalId: actor,
                  clock: options.clock,
                });
                return outcome(command, "signed_statement_proof", {
                  id: accepted.statement.statementId,
                  ...accepted,
                } as unknown as Record<string, unknown>);
              } finally {
                await opened.close();
              }
            }
            case "replication.enroll": {
              if (command.resource.kind !== "replica") {
                throw new HostedMutationError("invalid_input");
              }
              const input = ReplicationEnroll.parse(command.input);
              const opened = await openDb({ url: options.databaseUrl, wal: true });
              try {
                await runKernelMigrations(opened.client, { clock: options.clock });
                await registerReplicationReplica(opened.db, {
                  workspaceId: options.workspaceId,
                  replicaId: command.resource.id,
                  generationId: input.generationId,
                  principalId: actor,
                  clock: options.clock,
                });
                return outcome(command, "replica_registration", {
                  id: command.resource.id,
                  generationId: input.generationId,
                  principalId: actor,
                });
              } finally {
                await opened.close();
              }
            }
            case "replication.push": {
              if (!options.signedStatements || command.resource.kind !== "replica") {
                throw new HostedMutationError("invalid_input");
              }
              const input = ReplicationPush.parse(command.input);
              if (input.request.workspaceId !== options.workspaceId ||
                input.request.replicaId !== command.resource.id ||
                input.signedOrigins.length !== input.request.operations.length) {
                throw new HostedMutationError("invalid_input");
              }
              const opened = await openDb({ url: options.databaseUrl, wal: true });
              try {
                await runKernelMigrations(opened.client, { clock: options.clock });
                const signedOrigins = await Promise.all(input.signedOrigins.map(
                  (bundle, index) => prepareSignedStatementAcceptance({
                    bundle,
                    expectedAudience: options.signedStatements!.audience,
                    acceptedTrustRootDigests:
                      options.signedStatements!.acceptedTrustRootDigests,
                    binding: {
                      bindingKind: "replication_operation_origin",
                      recordType: "replication_operation",
                      recordId: input.request.operations[index]!.operationDigest,
                      recordDigest: input.request.operations[index]!
                        .operationDigest as `sha256:${string}`,
                    },
                    verify: async (request) => ({
                      ...await verifyPurposeBoundStatement({
                        ...request,
                        resolveCredential:
                          options.signedStatements!.resolveCredential,
                      }),
                      verifierImplementationDigest:
                        ED25519_VERIFIER_IMPLEMENTATION_DIGEST,
                    }),
                  }, {
                    tenantId: options.workspaceId,
                    actor,
                    principalId: actor,
                    clock: options.clock,
                  }),
                ));
                const response = await acceptReplicationPush(
                  opened.db,
                  input.request,
                  {
                    authenticatedReplicaId: command.resource.id,
                    authenticatedPrincipalId: actor,
                    domainPrincipalId: client.principalId,
                    actor,
                    clock: options.clock,
                    signedOrigins,
                  },
                );
                return outcome(command, "replication_push", {
                  id: command.resource.id,
                  ...response,
                } as unknown as Record<string, unknown>);
              } finally {
                await opened.close();
              }
            }
            case "replication.pull": {
              if (command.resource.kind !== "replica") {
                throw new HostedMutationError("invalid_input");
              }
              const input = ReplicationPull.parse(command.input);
              const opened = await openDb({ url: options.databaseUrl, wal: true });
              try {
                await runKernelMigrations(opened.client, { clock: options.clock });
                const response = await pullReplication(opened.db, {
                  workspaceId: options.workspaceId,
                  replicaId: command.resource.id,
                  generationId: input.generationId,
                  authenticatedReplicaId: command.resource.id,
                  authenticatedPrincipalId: actor,
                  cursor: input.cursor ?? null,
                  limit: input.limit,
                  clock: options.clock,
                });
                return outcome(command, "replication_pull", {
                  id: command.resource.id,
                  ...response,
                } as unknown as Record<string, unknown>);
              } finally {
                await opened.close();
              }
            }
            case "resource.acquire": {
              const input = ResourceAcquire.parse(command.input);
              const result = await client.resources.acquire(command.resource.id, {
                ...input,
                idempotencyKey: command.idempotencyKey,
              });
              return outcome(command, "resource_lease", result.lease as unknown as Record<string, unknown>);
            }
            case "resource.renew": {
              if (expectedRevision === null) throw new HostedMutationError("invalid_input");
              const input = ResourceRenew.parse(command.input);
              const result = await client.resources.renew(command.resource.id, {
                ...input,
                expectedRevision,
                idempotencyKey: command.idempotencyKey,
              });
              return outcome(command, "resource_lease", result.lease as unknown as Record<string, unknown>);
            }
            case "resource.release": {
              if (expectedRevision === null) throw new HostedMutationError("invalid_input");
              const input = ResourceRelease.parse(command.input);
              const result = await client.resources.release(command.resource.id, {
                ...input,
                expectedRevision,
                idempotencyKey: command.idempotencyKey,
              });
              return outcome(command, "resource_lease", result.lease as unknown as Record<string, unknown>);
            }
            default:
              throw new HostedMutationError("not_found");
          }
        });
        return await receipts.save(result, command.evaluatedAt);
      } catch (error) {
        mapDomainError(error);
      }
    },
    async close() {
      await receipts.close();
    },
  };
}

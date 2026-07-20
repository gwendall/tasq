/** Language-neutral contracts for ADR-003 authority-coordinated replication. */

import { z } from "zod";
import {
  CompletionMode,
  Metadata,
  Priority,
  RecurrenceAnchor,
  RecurrenceUnit,
  TaskStatus,
  UnixMs,
  UuidV7,
} from "./types.js";
import { Sha256Digest } from "./extensions.js";

export const REPLICATION_OPERATION_CONTRACT_VERSION =
  "tasq.replication-operation.v1" as const;
export const REPLICATION_DIGEST_VERSION = "tasq.replication-jcs.sha256.v1" as const;
export const REPLICATION_SNAPSHOT_CONTRACT_VERSION =
  "tasq.replication-snapshot.v1" as const;
export const REPLICATION_SNAPSHOT_PAGE_CONTRACT_VERSION =
  "tasq.replication-snapshot-page.v1" as const;
export const REPLICATION_PUSH_CONTRACT_VERSION = "tasq.replication-push.v1" as const;
export const REPLICATION_PULL_CONTRACT_VERSION = "tasq.replication-pull.v1" as const;
export const REPLICATION_CURSOR_CONTRACT_VERSION = "tasq.replication-cursor.v1" as const;
export const REPLICATION_PROJECTION_VERSION = "tasq.commitment-projection.v1" as const;

export const REPLICATION_OPERATION_URIS = Object.freeze({
  createCommitment: "urn:tasq:replication:commitment.create.v1",
  updateCommitment: "urn:tasq:replication:commitment.update.v1",
  deleteCommitment: "urn:tasq:replication:commitment.delete.v1",
  restoreCommitment: "urn:tasq:replication:commitment.restore.v1",
  transitionCommitment: "urn:tasq:replication:commitment.transition.authority.v1",
  claim: "urn:tasq:replication:claim.authority.v1",
  attempt: "urn:tasq:replication:attempt.authority.v1",
  effectDispatch: "urn:tasq:replication:effect-dispatch.authority.v1",
  extensionRegistry: "urn:tasq:replication:extension-registry.authority.v1",
  localOperationalState: "urn:tasq:replication:local-operational-state.v1",
} as const);

export const ReplicationOperationClass = z.enum([
  "offline_speculative",
  "authority_required",
  "local_only",
]);
export type ReplicationOperationClass = z.infer<typeof ReplicationOperationClass>;

export const REPLICATION_OPERATION_REGISTRY = Object.freeze([
  { operationUri: REPLICATION_OPERATION_URIS.createCommitment, operationVersion: 1, class: "offline_speculative" },
  { operationUri: REPLICATION_OPERATION_URIS.updateCommitment, operationVersion: 1, class: "offline_speculative" },
  { operationUri: REPLICATION_OPERATION_URIS.deleteCommitment, operationVersion: 1, class: "offline_speculative" },
  { operationUri: REPLICATION_OPERATION_URIS.restoreCommitment, operationVersion: 1, class: "offline_speculative" },
  { operationUri: REPLICATION_OPERATION_URIS.transitionCommitment, operationVersion: 1, class: "authority_required" },
  { operationUri: REPLICATION_OPERATION_URIS.claim, operationVersion: 1, class: "authority_required" },
  { operationUri: REPLICATION_OPERATION_URIS.attempt, operationVersion: 1, class: "authority_required" },
  { operationUri: REPLICATION_OPERATION_URIS.effectDispatch, operationVersion: 1, class: "authority_required" },
  { operationUri: REPLICATION_OPERATION_URIS.extensionRegistry, operationVersion: 1, class: "authority_required" },
  { operationUri: REPLICATION_OPERATION_URIS.localOperationalState, operationVersion: 1, class: "local_only" },
] as const);

const NonBlank = z.string().trim().min(1).max(1_000);
const Counter = z.number().int().positive().safe();
const Sequence = z.number().int().nonnegative().safe();

/**
 * Cross-store semantic commitment projection. Store-local revision, event
 * sequence, delivery state and credentials are deliberately absent.
 */
export const ReplicatedCommitmentSnapshot = z.object({
  id: UuidV7,
  title: z.string().min(1).max(500),
  description: z.string().nullable(),
  nextAction: z.string().nullable(),
  successCriteria: z.string().nullable(),
  completionMode: CompletionMode,
  status: TaskStatus,
  priority: Priority.nullable(),
  estimatedMinutes: z.number().int().positive().nullable(),
  scheduledAt: UnixMs.nullable(),
  dueAt: UnixMs.nullable(),
  startedAt: UnixMs.nullable(),
  completedAt: UnixMs.nullable(),
  recurrence: RecurrenceUnit.nullable(),
  recurrenceInterval: z.number().int().positive(),
  recurrenceAnchor: RecurrenceAnchor,
  lastDoneAt: UnixMs.nullable(),
  streak: z.number().int().nonnegative(),
  recurrenceParentId: UuidV7.nullable(),
  metadata: Metadata,
  createdAt: UnixMs,
  updatedAt: UnixMs,
  deletedAt: UnixMs.nullable(),
}).strict();
export type ReplicatedCommitmentSnapshot = z.infer<typeof ReplicatedCommitmentSnapshot>;

export const ReplicatedCommitmentCreate = z.object({
  id: UuidV7,
  title: z.string().min(1).max(500),
  description: z.string().nullable().default(null),
  nextAction: z.string().nullable().default(null),
  successCriteria: z.string().min(1).max(2_000).nullable().default(null),
  completionMode: CompletionMode.default("assertion"),
  priority: Priority.nullable().default(null),
  estimatedMinutes: z.number().int().positive().nullable().default(null),
  scheduledAt: UnixMs.nullable().default(null),
  dueAt: UnixMs.nullable().default(null),
  recurrence: RecurrenceUnit.nullable().default(null),
  recurrenceInterval: z.number().int().positive().default(1),
  recurrenceAnchor: RecurrenceAnchor.default("due"),
  metadata: Metadata.default({}),
}).strict();
export type ReplicatedCommitmentCreate = z.infer<typeof ReplicatedCommitmentCreate>;

export const ReplicatedCommitmentPatch = z.object({
  title: z.string().min(1).max(500).optional(),
  description: z.string().nullable().optional(),
  nextAction: z.string().nullable().optional(),
  successCriteria: z.string().min(1).max(2_000).nullable().optional(),
  completionMode: CompletionMode.optional(),
  priority: Priority.nullable().optional(),
  estimatedMinutes: z.number().int().positive().nullable().optional(),
  scheduledAt: UnixMs.nullable().optional(),
  dueAt: UnixMs.nullable().optional(),
  recurrence: RecurrenceUnit.nullable().optional(),
  recurrenceInterval: z.number().int().positive().optional(),
  recurrenceAnchor: RecurrenceAnchor.optional(),
  metadata: Metadata.optional(),
}).strict().refine((value) => Object.keys(value).length > 0, "patch must not be empty");
export type ReplicatedCommitmentPatch = z.infer<typeof ReplicatedCommitmentPatch>;

export const ReplicationCommand = z.discriminatedUnion("operationUri", [
  z.object({
    operationUri: z.literal(REPLICATION_OPERATION_URIS.createCommitment),
    operationVersion: z.literal(1),
    input: ReplicatedCommitmentCreate,
  }).strict(),
  z.object({
    operationUri: z.literal(REPLICATION_OPERATION_URIS.updateCommitment),
    operationVersion: z.literal(1),
    input: z.object({ id: UuidV7, patch: ReplicatedCommitmentPatch }).strict(),
  }).strict(),
  z.object({
    operationUri: z.literal(REPLICATION_OPERATION_URIS.deleteCommitment),
    operationVersion: z.literal(1),
    input: z.object({ id: UuidV7 }).strict(),
  }).strict(),
  z.object({
    operationUri: z.literal(REPLICATION_OPERATION_URIS.restoreCommitment),
    operationVersion: z.literal(1),
    input: z.object({ id: UuidV7 }).strict(),
  }).strict(),
]);
export type ReplicationCommand = z.infer<typeof ReplicationCommand>;

const ReplicationRecordState = z.object({
  recordType: z.literal("commitment"),
  recordId: UuidV7,
  stateDigest: Sha256Digest.nullable(),
  snapshot: ReplicatedCommitmentSnapshot.nullable(),
}).strict();

export const ReplicationOperation = z.object({
  contractVersion: z.literal(REPLICATION_OPERATION_CONTRACT_VERSION),
  workspaceId: NonBlank,
  origin: z.object({
    replicaId: UuidV7,
    generationId: UuidV7,
    counter: Counter,
    previousDigest: Sha256Digest.nullable(),
  }).strict(),
  causalBase: z.object({
    authorityReplicaId: UuidV7,
    authorityEpoch: UuidV7,
    observedSequence: Sequence,
  }).strict(),
  caller: z.object({ principalId: NonBlank }).strict(),
  command: ReplicationCommand,
  preconditions: z.array(ReplicationRecordState).min(1).max(64),
  outcomes: z.array(ReplicationRecordState).min(1).max(64),
  occurredAt: UnixMs,
  digestVersion: z.literal(REPLICATION_DIGEST_VERSION),
  operationDigest: Sha256Digest,
}).strict();
export type ReplicationOperation = z.infer<typeof ReplicationOperation>;

export const ReplicationConflict = z.object({
  id: UuidV7,
  workspaceId: NonBlank,
  authoritySequence: Counter,
  replicaId: UuidV7,
  generationId: UuidV7,
  counter: Counter,
  operationDigest: Sha256Digest,
  recordType: z.literal("commitment"),
  recordId: UuidV7,
  reason: z.enum(["concurrent_mutation", "retired_identity"]),
  baseSnapshot: ReplicatedCommitmentSnapshot.nullable(),
  authoritySnapshot: ReplicatedCommitmentSnapshot.nullable(),
  incomingSnapshot: ReplicatedCommitmentSnapshot.nullable(),
  principalId: NonBlank,
  recordedAt: UnixMs,
  resolvedByOperationDigest: Sha256Digest.nullable(),
}).strict();
export type ReplicationConflict = z.infer<typeof ReplicationConflict>;

export const ReplicationDisposition = z.enum(["applied", "equivalent", "conflicted"]);
export type ReplicationDisposition = z.infer<typeof ReplicationDisposition>;

export const ReplicationOperationResult = z.object({
  replicaId: UuidV7,
  generationId: UuidV7,
  counter: Counter,
  operationDigest: Sha256Digest,
  disposition: ReplicationDisposition,
  authoritySequence: Counter,
  conflict: ReplicationConflict.nullable(),
}).strict();
export type ReplicationOperationResult = z.infer<typeof ReplicationOperationResult>;

export const ReplicationAcceptedFrontier = z.object({
  replicaId: UuidV7,
  generationId: UuidV7,
  acceptedCounter: Sequence,
  acceptedDigest: Sha256Digest.nullable(),
}).strict().superRefine((value, context) => {
  if ((value.acceptedCounter === 0) !== (value.acceptedDigest === null)) {
    context.addIssue({
      code: "custom",
      message: "acceptedDigest must be null exactly at the zero frontier",
    });
  }
});
export type ReplicationAcceptedFrontier = z.infer<typeof ReplicationAcceptedFrontier>;

export const ReplicationSnapshotRecord = z.object({
  recordType: z.literal("commitment"),
  recordId: UuidV7,
  stateDigest: Sha256Digest,
  snapshot: ReplicatedCommitmentSnapshot,
}).strict();
export type ReplicationSnapshotRecord = z.infer<typeof ReplicationSnapshotRecord>;

export const ReplicationRetiredIdentity = z.object({
  recordType: z.literal("commitment"),
  recordId: UuidV7,
  retiredAt: UnixMs,
  tombstoneDigest: Sha256Digest,
}).strict();
export type ReplicationRetiredIdentity = z.infer<typeof ReplicationRetiredIdentity>;

export const ReplicationSnapshot = z.object({
  contractVersion: z.literal(REPLICATION_SNAPSHOT_CONTRACT_VERSION),
  workspaceId: NonBlank,
  authorityReplicaId: UuidV7,
  authorityEpoch: UuidV7,
  coveredSequence: Sequence,
  projectionVersion: z.literal(REPLICATION_PROJECTION_VERSION),
  projectionDigest: Sha256Digest,
  acceptedFrontiers: z.array(ReplicationAcceptedFrontier).max(100_000),
  records: z.array(ReplicationSnapshotRecord).max(100_000),
  retiredIdentities: z.array(ReplicationRetiredIdentity).max(100_000),
  unresolvedConflicts: z.array(ReplicationConflict).max(100_000),
  snapshotDigest: Sha256Digest,
}).strict();
export type ReplicationSnapshot = z.infer<typeof ReplicationSnapshot>;

export const ReplicationSnapshotPageItem = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("accepted_frontier"), value: ReplicationAcceptedFrontier }).strict(),
  z.object({ kind: z.literal("record"), value: ReplicationSnapshotRecord }).strict(),
  z.object({ kind: z.literal("retired_identity"), value: ReplicationRetiredIdentity }).strict(),
  z.object({ kind: z.literal("unresolved_conflict"), value: ReplicationConflict }).strict(),
]);
export type ReplicationSnapshotPageItem = z.infer<typeof ReplicationSnapshotPageItem>;

export const ReplicationSnapshotManifest = z.object({
  contractVersion: z.literal(REPLICATION_SNAPSHOT_PAGE_CONTRACT_VERSION),
  workspaceId: NonBlank,
  authorityReplicaId: UuidV7,
  authorityEpoch: UuidV7,
  coveredSequence: Sequence,
  projectionVersion: z.literal(REPLICATION_PROJECTION_VERSION),
  projectionDigest: Sha256Digest,
  snapshotDigest: Sha256Digest,
  pageCount: z.number().int().positive().max(10_000),
  pageDigests: z.array(Sha256Digest).min(1).max(10_000),
  manifestDigest: Sha256Digest,
}).strict();
export type ReplicationSnapshotManifest = z.infer<typeof ReplicationSnapshotManifest>;

export const ReplicationSnapshotPage = z.object({
  contractVersion: z.literal(REPLICATION_SNAPSHOT_PAGE_CONTRACT_VERSION),
  snapshotDigest: Sha256Digest,
  pageIndex: z.number().int().nonnegative().max(9_999),
  pageCount: z.number().int().positive().max(10_000),
  items: z.array(ReplicationSnapshotPageItem).max(500),
  pageDigest: Sha256Digest,
}).strict();
export type ReplicationSnapshotPage = z.infer<typeof ReplicationSnapshotPage>;

export const ReplicationPushRequest = z.object({
  contractVersion: z.literal(REPLICATION_PUSH_CONTRACT_VERSION),
  workspaceId: NonBlank,
  replicaId: UuidV7,
  generationId: UuidV7,
  operations: z.array(ReplicationOperation).min(1).max(500),
}).strict();
export type ReplicationPushRequest = z.infer<typeof ReplicationPushRequest>;

export const ReplicationPushResponse = z.object({
  contractVersion: z.literal(REPLICATION_PUSH_CONTRACT_VERSION),
  workspaceId: NonBlank,
  authorityReplicaId: UuidV7,
  authorityEpoch: UuidV7,
  results: z.array(ReplicationOperationResult).min(1).max(500),
  acknowledgedCounter: Counter,
  cursor: z.string().min(1).max(4_096),
}).strict();
export type ReplicationPushResponse = z.infer<typeof ReplicationPushResponse>;

export const ReplicationPullResponse = z.discriminatedUnion("disposition", [
  z.object({
    contractVersion: z.literal(REPLICATION_PULL_CONTRACT_VERSION),
    disposition: z.literal("incremental"),
    workspaceId: NonBlank,
    authorityReplicaId: UuidV7,
    authorityEpoch: UuidV7,
    entries: z.array(ReplicationOperationResult).max(1_000),
    /** Canonical snapshot also carries authority-local mutations outside the accepted client log. */
    snapshot: ReplicationSnapshot,
    nextCursor: z.string().min(1).max(4_096),
    hasMore: z.boolean(),
  }).strict(),
  z.object({
    contractVersion: z.literal(REPLICATION_PULL_CONTRACT_VERSION),
    disposition: z.literal("cursor_expired"),
    workspaceId: NonBlank,
    authorityReplicaId: UuidV7,
    authorityEpoch: UuidV7,
    minimumRetainedSequence: Sequence,
    snapshot: ReplicationSnapshot,
    nextCursor: z.string().min(1).max(4_096),
  }).strict(),
]);
export type ReplicationPullResponse = z.infer<typeof ReplicationPullResponse>;

export const ReplicationDiscovery = z.object({
  authorityReplicaId: UuidV7,
  authorityEpoch: UuidV7,
  currentSequence: Sequence,
  minimumRetainedSequence: Sequence,
  operationContractVersion: z.literal(REPLICATION_OPERATION_CONTRACT_VERSION),
  snapshotContractVersion: z.literal(REPLICATION_SNAPSHOT_CONTRACT_VERSION),
  snapshotPageContractVersion: z.literal(REPLICATION_SNAPSHOT_PAGE_CONTRACT_VERSION),
  cursorContractVersion: z.literal(REPLICATION_CURSOR_CONTRACT_VERSION),
  projectionVersion: z.literal(REPLICATION_PROJECTION_VERSION),
  projectionDigest: Sha256Digest,
  operationRegistry: z.array(z.object({
    operationUri: z.string().min(1).max(2_000),
    operationVersion: z.number().int().positive(),
    class: ReplicationOperationClass,
  }).strict()).min(1).max(256),
  limits: z.object({
    pushOperations: z.literal(500),
    pushBytes: z.literal(8 * 1024 * 1024),
    operationBytes: z.literal(1024 * 1024),
    pullEntries: z.literal(1_000),
    snapshotPageItems: z.literal(500),
    snapshotPageBytes: z.literal(8 * 1024 * 1024),
    snapshotPages: z.literal(10_000),
  }).strict(),
  retention: z.object({
    activeReplicaMs: z.number().int().positive(),
    operationMinimumMs: z.number().int().positive(),
    fullTombstoneMinimumMs: z.number().int().positive(),
  }).strict(),
}).strict();
export type ReplicationDiscovery = z.infer<typeof ReplicationDiscovery>;

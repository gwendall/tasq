/** ADR-003 authority-coordinated replication over explicit service commands. */

import { Buffer } from "node:buffer";
import { and, asc, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import {
  REPLICATION_CURSOR_CONTRACT_VERSION,
  REPLICATION_DIGEST_VERSION,
  REPLICATION_OPERATION_CONTRACT_VERSION,
  REPLICATION_OPERATION_REGISTRY,
  REPLICATION_OPERATION_URIS,
  REPLICATION_PROJECTION_VERSION,
  REPLICATION_PULL_CONTRACT_VERSION,
  REPLICATION_PUSH_CONTRACT_VERSION,
  REPLICATION_SNAPSHOT_CONTRACT_VERSION,
  REPLICATION_SNAPSHOT_PAGE_CONTRACT_VERSION,
  ReplicatedCommitmentCreate,
  ReplicatedCommitmentPatch,
  ReplicatedCommitmentSnapshot,
  ReplicationConflict,
  ReplicationOperation,
  ReplicationOperationResult,
  ReplicationPullResponse,
  ReplicationPushRequest,
  ReplicationPushResponse,
  ReplicationSnapshot,
  ReplicationSnapshotManifest,
  ReplicationSnapshotPage,
  Task as TaskSchema,
  TaskInsert,
  TaskUpdate,
  UuidV7,
  replicationAccepted,
  replicationAuthority,
  replicationAuthorityRecovery,
  replicationConflict,
  replicationLocalReplica,
  replicationMaterializedRecord,
  replicationOutgoing,
  replicationReplica,
  replicationRetiredIdentity,
  task,
  uuidv7,
  type Clock,
  type Event,
  type ReplicatedCommitmentCreate as ReplicatedCommitmentCreateT,
  type ReplicatedCommitmentPatch as ReplicatedCommitmentPatchT,
  type ReplicatedCommitmentSnapshot as ReplicatedCommitmentSnapshotT,
  type ReplicationAcceptedFrontier as ReplicationAcceptedFrontierT,
  type ReplicationCommand,
  type ReplicationConflict as ReplicationConflictT,
  type ReplicationOperation as ReplicationOperationT,
  type ReplicationOperationResult as ReplicationOperationResultT,
  type ReplicationPullResponse as ReplicationPullResponseT,
  type ReplicationPushResponse as ReplicationPushResponseT,
  type ReplicationSnapshot as ReplicationSnapshotT,
  type ReplicationSnapshotManifest as ReplicationSnapshotManifestT,
  type ReplicationSnapshotPage as ReplicationSnapshotPageT,
  type ReplicationSnapshotPageItem as ReplicationSnapshotPageItemT,
  type Task,
} from "@tasq-run/schema";
import type { TasqDb, TasqDbOrTx } from "../db.js";
import { runInTransaction, runOperationalTransaction } from "../db.js";
import { canonicalJson, sha256Digest } from "../util/canonical-json.js";
import { parseRow } from "../util/row.js";
import { emitAfterCommit } from "./events.js";
import { localPrincipalId } from "./principals.js";
import {
  createTaskInTransaction,
  getTask,
  restoreTaskInTransaction,
  softDeleteTaskTx,
  updateTaskInTransaction,
} from "./tasks.js";

export const REPLICATION_LIMITS = Object.freeze({
  pushOperations: 500,
  pushBytes: 8 * 1024 * 1024,
  operationBytes: 1024 * 1024,
  pullEntries: 1_000,
  snapshotPageItems: 500,
  snapshotPageBytes: 8 * 1024 * 1024,
  snapshotPages: 10_000,
});

export const REPLICATION_RETENTION = Object.freeze({
  activeReplicaMs: 90 * 24 * 60 * 60 * 1_000,
  operationMinimumMs: 30 * 24 * 60 * 60 * 1_000,
  fullTombstoneMinimumMs: 90 * 24 * 60 * 60 * 1_000,
});

const PROJECTION_DESCRIPTOR = {
  contractVersion: REPLICATION_PROJECTION_VERSION,
  recordType: "commitment",
  excludes: [
    "revision", "event", "delivery_sink", "delivery_outbox", "idempotency_key",
    "task_claim", "task_attempt", "credentials", "host_configuration",
  ],
  fields: Object.keys(ReplicatedCommitmentSnapshot.shape).sort(),
  stateDigestExcludes: ["createdAt", "updatedAt", "deletedAt"],
  stateDigestDerives: ["deleted"],
};

export const REPLICATION_PROJECTION_DIGEST = replicationDigest(
  "tasq.replication-projection-descriptor.v1",
  PROJECTION_DESCRIPTOR,
);

export type ReplicationProblemCode =
  | "authority_not_initialized"
  | "replica_not_registered"
  | "replica_stale"
  | "replica_revoked"
  | "origin_gap"
  | "predecessor_mismatch"
  | "identity_corruption"
  | "operation_digest_mismatch"
  | "authority_epoch_mismatch"
  | "unauthenticated_origin"
  | "unsupported_operation"
  | "projection_violation"
  | "payload_too_large";

export class ReplicationProtocolError extends Error {
  constructor(readonly code: ReplicationProblemCode, message: string) {
    super(message);
    this.name = "ReplicationProtocolError";
  }
}

export interface ReplicationAuthorityIdentity {
  workspaceId: string;
  authorityReplicaId: string;
  authorityEpoch: string;
  currentSequence: number;
  minimumRetainedSequence: number;
}

export interface ReplicationAuthorityRecoveryRecord {
  workspaceId: string;
  authorityEpoch: string;
  authorityReplicaId: string;
  priorAuthorityEpoch: string;
  restoredSequence: number;
  snapshotDigest: string;
  reason: string;
  recoveredAt: number;
}

export interface RecoverReplicationAuthorityOptions {
  workspaceId: string;
  expectedAuthorityReplicaId: string;
  expectedAuthorityEpoch: string;
  expectedCurrentSequence: number;
  newAuthorityEpoch: string;
  reason: string;
  clock: Clock;
}

export interface InitializeReplicationAuthorityOptions {
  workspaceId: string;
  clock: Clock;
  authorityReplicaId?: string;
  authorityEpoch?: string;
}

export interface RegisterReplicationReplicaOptions {
  workspaceId: string;
  replicaId: string;
  generationId: string;
  clock: Clock;
}

export interface InitializeLocalReplicaOptions extends RegisterReplicationReplicaOptions {
  authorityReplicaId: string;
  authorityEpoch: string;
  observedSequence?: number;
  pullCursor?: string;
}

export interface ReplicatedMutationContext {
  workspaceId: string;
  actor: string;
  principalId?: string;
  clock: Clock;
}

export interface QueueReplicationResult {
  commitment: ReplicatedCommitmentSnapshotT;
  operation: ReplicationOperationT;
}

export interface AcceptReplicationOptions {
  authenticatedReplicaId: string;
  authenticatedPrincipalId: string;
  actor: string;
  clock: Clock;
}

export interface PullReplicationOptions {
  workspaceId: string;
  replicaId: string;
  generationId: string;
  /** Identity already authenticated by the transport/host boundary. */
  authenticatedReplicaId: string;
  cursor?: string | null;
  limit?: number;
  clock: Clock;
}

function clockSnapshot(clock: Clock): number {
  const now = clock.now();
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new Error("Injected replication clock must return a non-negative unix-ms integer");
  }
  return now;
}

function assertWorkspaceId(workspaceId: string): string {
  const normalized = workspaceId.trim();
  if (!normalized || normalized.length > 1_000) {
    throw new Error("workspaceId must contain 1..1000 non-whitespace characters");
  }
  return workspaceId;
}

function assertNonBlank(value: string, label: string): string {
  if (!value.trim() || value.length > 1_000) throw new Error(`${label} must contain 1..1000 characters`);
  return value;
}

function assertSafeIntegerJson(value: unknown, path = "$"): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new Error(`Replication JSON number at ${path} must be a safe integer`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((child, index) => assertSafeIntegerJson(child, `${path}[${index}]`));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      assertSafeIntegerJson(child, `${path}.${key}`);
    }
    return;
  }
  throw new Error(`Replication JSON value at ${path} is not canonically serializable`);
}

function replicationCanonicalJson(value: unknown): string {
  assertSafeIntegerJson(value);
  return canonicalJson(value);
}

function replicationDigest(domain: string, value: unknown): string {
  return sha256Digest(`${domain}\0${replicationCanonicalJson(value)}`);
}

function operationDigest(operation: Omit<ReplicationOperationT, "operationDigest">): string {
  return replicationDigest(REPLICATION_DIGEST_VERSION, operation);
}

/** Public canonical helper for transport conformance and offline SDKs. */
export function computeReplicationOperationDigest(
  operation: Omit<ReplicationOperationT, "operationDigest">,
): string {
  return operationDigest(operation);
}

function semanticState(snapshot: ReplicatedCommitmentSnapshotT) {
  const { createdAt: _createdAt, updatedAt: _updatedAt, deletedAt, ...meaning } = snapshot;
  return { ...meaning, deleted: deletedAt != null };
}

function stateDigest(snapshot: ReplicatedCommitmentSnapshotT): string {
  return replicationDigest(REPLICATION_PROJECTION_VERSION, semanticState(snapshot));
}

/** Canonical cross-store CAS digest; authority recording timestamps are excluded. */
export function computeReplicatedCommitmentStateDigest(
  input: ReplicatedCommitmentSnapshotT,
): string {
  return stateDigest(ReplicatedCommitmentSnapshot.parse(input));
}

function snapshotDigest(snapshot: Omit<ReplicationSnapshotT, "snapshotDigest">): string {
  return replicationDigest(REPLICATION_SNAPSHOT_CONTRACT_VERSION, snapshot);
}

/** Public canonical helper for transport conformance and snapshot assemblers. */
export function computeReplicationSnapshotDigest(
  snapshot: Omit<ReplicationSnapshotT, "snapshotDigest">,
): string {
  return snapshotDigest(snapshot);
}

function taskToProjection(row: Task): ReplicatedCommitmentSnapshotT {
  if (row.projectId != null || row.goalId != null || row.areaId != null || row.parentTaskId != null) {
    throw new ReplicationProtocolError(
      "projection_violation",
      `Commitment ${row.id} uses compatibility-profile hierarchy fields outside ${REPLICATION_PROJECTION_VERSION}`,
    );
  }
  if (row.validationRequired) {
    throw new ReplicationProtocolError(
      "projection_violation",
      `Commitment ${row.id} requires authority-only resolution records outside ${REPLICATION_PROJECTION_VERSION}`,
    );
  }
  return ReplicatedCommitmentSnapshot.parse({
    id: row.id,
    title: row.title,
    description: row.description,
    nextAction: row.nextAction,
    successCriteria: row.successCriteria,
    completionMode: row.completionMode,
    status: row.status,
    priority: row.priority,
    estimatedMinutes: row.estimatedMinutes,
    scheduledAt: row.scheduledAt,
    dueAt: row.dueAt,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    recurrence: row.recurrence,
    recurrenceInterval: row.recurrenceInterval,
    recurrenceAnchor: row.recurrenceAnchor,
    lastDoneAt: row.lastDoneAt,
    streak: row.streak,
    recurrenceParentId: row.recurrenceParentId,
    metadata: row.metadata,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt,
  });
}

async function getProjection(
  db: TasqDbOrTx,
  workspaceId: string,
  recordId: string,
): Promise<ReplicatedCommitmentSnapshotT | null> {
  const row = await getTask(db, recordId, workspaceId);
  return row ? taskToProjection(row) : null;
}

function operationRecordId(command: ReplicationCommand): string {
  return command.input.id;
}

function operationCaller(context: ReplicatedMutationContext): string {
  return context.principalId ?? localPrincipalId(context.workspaceId, context.actor);
}

async function requireLocalReplica(tx: TasqDbOrTx, workspaceId: string) {
  const rows = await tx.select().from(replicationLocalReplica)
    .where(eq(replicationLocalReplica.workspaceId, workspaceId)).limit(1);
  const row = rows[0];
  if (!row) throw new Error(`Local replica is not initialized for workspace ${workspaceId}`);
  return row;
}

async function requireAuthority(tx: TasqDbOrTx, workspaceId: string) {
  const rows = await tx.select().from(replicationAuthority)
    .where(eq(replicationAuthority.workspaceId, workspaceId)).limit(1);
  const row = rows[0];
  if (!row) {
    throw new ReplicationProtocolError(
      "authority_not_initialized",
      `Replication authority is not initialized for workspace ${workspaceId}`,
    );
  }
  return row;
}

export async function initializeReplicationAuthority(
  db: TasqDb,
  options: InitializeReplicationAuthorityOptions,
): Promise<ReplicationAuthorityIdentity> {
  assertWorkspaceId(options.workspaceId);
  if (options.authorityReplicaId) UuidV7.parse(options.authorityReplicaId);
  if (options.authorityEpoch) UuidV7.parse(options.authorityEpoch);
  const now = clockSnapshot(options.clock);
  return runOperationalTransaction(db, async (tx) => {
    const existing = await tx.select().from(replicationAuthority)
      .where(eq(replicationAuthority.workspaceId, options.workspaceId)).limit(1);
    if (existing[0]) {
      if (options.authorityReplicaId && existing[0].authorityReplicaId !== options.authorityReplicaId) {
        throw new Error("Replication authority replica identity already differs");
      }
      if (options.authorityEpoch && existing[0].authorityEpoch !== options.authorityEpoch) {
        throw new Error("Replication authority epoch already differs");
      }
      return authorityIdentity(existing[0]);
    }
    const authorityReplicaId = options.authorityReplicaId ?? uuidv7(now);
    const authorityEpoch = options.authorityEpoch ?? uuidv7(now);
    await tx.insert(replicationAuthority).values({
      workspaceId: options.workspaceId,
      authorityReplicaId,
      authorityEpoch,
      currentSequence: 0,
      minimumRetainedSequence: 0,
      createdAt: now,
      updatedAt: now,
    });
    return {
      workspaceId: options.workspaceId,
      authorityReplicaId,
      authorityEpoch,
      currentSequence: 0,
      minimumRetainedSequence: 0,
    };
  });
}

function authorityIdentity(row: typeof replicationAuthority.$inferSelect): ReplicationAuthorityIdentity {
  return {
    workspaceId: row.workspaceId,
    authorityReplicaId: row.authorityReplicaId,
    authorityEpoch: row.authorityEpoch,
    currentSequence: row.currentSequence,
    minimumRetainedSequence: row.minimumRetainedSequence,
  };
}

export async function getReplicationAuthority(
  db: TasqDbOrTx,
  workspaceId: string,
): Promise<ReplicationAuthorityIdentity | null> {
  const rows = await db.select().from(replicationAuthority)
    .where(eq(replicationAuthority.workspaceId, workspaceId)).limit(1);
  return rows[0] ? authorityIdentity(rows[0]) : null;
}

function recoveryRecord(
  row: typeof replicationAuthorityRecovery.$inferSelect,
): ReplicationAuthorityRecoveryRecord {
  return {
    workspaceId: row.workspaceId,
    authorityEpoch: row.authorityEpoch,
    authorityReplicaId: row.authorityReplicaId,
    priorAuthorityEpoch: row.priorAuthorityEpoch,
    restoredSequence: row.restoredSequence,
    snapshotDigest: row.snapshotDigest,
    reason: row.reason,
    recoveredAt: row.recoveredAt,
  };
}

export async function listReplicationAuthorityRecoveries(
  db: TasqDbOrTx,
  workspaceId: string,
): Promise<ReplicationAuthorityRecoveryRecord[]> {
  const rows = await db.select().from(replicationAuthorityRecovery)
    .where(eq(replicationAuthorityRecovery.workspaceId, workspaceId))
    .orderBy(asc(replicationAuthorityRecovery.recoveredAt));
  return rows.map(recoveryRecord);
}

export async function registerReplicationReplica(
  db: TasqDb,
  options: RegisterReplicationReplicaOptions,
): Promise<void> {
  assertWorkspaceId(options.workspaceId);
  UuidV7.parse(options.replicaId);
  UuidV7.parse(options.generationId);
  const now = clockSnapshot(options.clock);
  await runOperationalTransaction(db, async (tx) => {
    await requireAuthority(tx, options.workspaceId);
    const rows = await tx.select().from(replicationReplica).where(and(
      eq(replicationReplica.workspaceId, options.workspaceId),
      eq(replicationReplica.replicaId, options.replicaId),
      eq(replicationReplica.generationId, options.generationId),
    )).limit(1);
    if (rows[0]) {
      if (rows[0].status === "revoked") {
        throw new ReplicationProtocolError("replica_revoked", "A revoked replica generation cannot re-register");
      }
      if (rows[0].status === "stale" || now - rows[0].lastContactAt > REPLICATION_RETENTION.activeReplicaMs) {
        throw new ReplicationProtocolError(
          "replica_stale",
          "A stale generation must bootstrap from a verified snapshot before reactivation",
        );
      }
      await tx.update(replicationReplica).set({ status: "active", lastContactAt: now, updatedAt: now })
        .where(and(
          eq(replicationReplica.workspaceId, options.workspaceId),
          eq(replicationReplica.replicaId, options.replicaId),
          eq(replicationReplica.generationId, options.generationId),
        ));
      return;
    }
    await tx.insert(replicationReplica).values({
      workspaceId: options.workspaceId,
      replicaId: options.replicaId,
      generationId: options.generationId,
      status: "active",
      acceptedCounter: 0,
      acceptedDigest: null,
      acknowledgedSequence: 0,
      registeredAt: now,
      lastContactAt: now,
      updatedAt: now,
    });
  });
}

export async function initializeLocalReplica(
  db: TasqDb,
  options: InitializeLocalReplicaOptions,
): Promise<void> {
  assertWorkspaceId(options.workspaceId);
  UuidV7.parse(options.replicaId);
  UuidV7.parse(options.generationId);
  UuidV7.parse(options.authorityReplicaId);
  UuidV7.parse(options.authorityEpoch);
  if (options.observedSequence !== undefined &&
    (!Number.isSafeInteger(options.observedSequence) || options.observedSequence < 0)) {
    throw new Error("observedSequence must be a non-negative safe integer");
  }
  if (options.pullCursor !== undefined && (options.pullCursor.length < 1 || options.pullCursor.length > 4_096)) {
    throw new Error("pullCursor must contain 1..4096 characters");
  }
  const now = clockSnapshot(options.clock);
  await runOperationalTransaction(db, async (tx) => {
    const rows = await tx.select().from(replicationLocalReplica)
      .where(eq(replicationLocalReplica.workspaceId, options.workspaceId)).limit(1);
    if (rows[0]) {
      if (rows[0].replicaId !== options.replicaId || rows[0].generationId !== options.generationId) {
        throw new Error("Local replica already has a different generation identity");
      }
      if (rows[0].authorityReplicaId !== options.authorityReplicaId ||
        rows[0].authorityEpoch !== options.authorityEpoch) {
        throw new Error("Local replica already targets a different authority epoch");
      }
      return;
    }
    await tx.insert(replicationLocalReplica).values({
      workspaceId: options.workspaceId,
      replicaId: options.replicaId,
      generationId: options.generationId,
      nextCounter: 1,
      previousDigest: null,
      authorityReplicaId: options.authorityReplicaId,
      authorityEpoch: options.authorityEpoch,
      observedSequence: options.observedSequence ?? 0,
      pullCursor: options.pullCursor ?? null,
      createdAt: now,
      updatedAt: now,
    });
  });
}

async function applyCommandInTransaction(
  tx: TasqDbOrTx,
  workspaceId: string,
  command: ReplicationCommand,
  options: { actor: string; principalId?: string; now: number },
): Promise<{ snapshot: ReplicatedCommitmentSnapshotT; events: Event[] }> {
  const events: Event[] = [];
  switch (command.operationUri) {
    case REPLICATION_OPERATION_URIS.createCommitment: {
      const input = ReplicatedCommitmentCreate.parse(command.input);
      const created = await createTaskInTransaction(tx, TaskInsert.parse({
        id: input.id,
        tenantId: workspaceId,
        title: input.title,
        description: input.description,
        nextAction: input.nextAction,
        successCriteria: input.successCriteria,
        completionMode: input.completionMode,
        priority: input.priority,
        estimatedMinutes: input.estimatedMinutes,
        scheduledAt: input.scheduledAt,
        dueAt: input.dueAt,
        recurrence: input.recurrence,
        recurrenceInterval: input.recurrenceInterval,
        recurrenceAnchor: input.recurrenceAnchor,
        metadata: input.metadata,
      }), { tenantId: workspaceId, actor: options.actor, principalId: options.principalId, now: options.now });
      events.push(created.event);
      return { snapshot: taskToProjection(created.result), events };
    }
    case REPLICATION_OPERATION_URIS.updateCommitment: {
      const patch = ReplicatedCommitmentPatch.parse(command.input.patch);
      const before = await getTask(tx, command.input.id, workspaceId);
      if (!before) throw new Error(`Task not found: ${command.input.id}`);
      taskToProjection(before);
      const updated = await updateTaskInTransaction(tx, command.input.id, TaskUpdate.parse(patch), {
        tenantId: workspaceId,
        actor: options.actor,
        principalId: options.principalId,
        now: options.now,
        expectedRevision: before.revision,
      });
      if (updated.event) events.push(updated.event);
      return { snapshot: taskToProjection(updated.result), events };
    }
    case REPLICATION_OPERATION_URIS.deleteCommitment: {
      const before = await getTask(tx, command.input.id, workspaceId);
      if (!before) throw new Error(`Task not found: ${command.input.id}`);
      taskToProjection(before);
      events.push(...await softDeleteTaskTx(tx, command.input.id, workspaceId, options.actor, options.now));
      const after = await getTask(tx, command.input.id, workspaceId);
      if (!after) throw new Error(`Deleted task disappeared: ${command.input.id}`);
      return { snapshot: taskToProjection(after), events };
    }
    case REPLICATION_OPERATION_URIS.restoreCommitment: {
      const restored = await restoreTaskInTransaction(tx, command.input.id, {
        tenantId: workspaceId,
        actor: options.actor,
        principalId: options.principalId,
        now: options.now,
      });
      if (restored.event) events.push(restored.event);
      return { snapshot: taskToProjection(restored.result), events };
    }
    default:
      throw new ReplicationProtocolError("unsupported_operation", "Operation is not offline-speculative");
  }
}

async function queueCommand(
  db: TasqDb,
  command: ReplicationCommand,
  context: ReplicatedMutationContext,
): Promise<QueueReplicationResult> {
  assertWorkspaceId(context.workspaceId);
  assertNonBlank(context.actor, "actor");
  if (context.principalId !== undefined) assertNonBlank(context.principalId, "principalId");
  const now = clockSnapshot(context.clock);
  const recordId = operationRecordId(command);
  const { operation, snapshot, events } = await runInTransaction(db, async (tx) => {
    const local = await requireLocalReplica(tx, context.workspaceId);
    const before = await getProjection(tx, context.workspaceId, recordId);
    if (command.operationUri === REPLICATION_OPERATION_URIS.createCommitment) {
      const retired = await tx.select({ recordId: replicationRetiredIdentity.recordId })
        .from(replicationRetiredIdentity).where(and(
          eq(replicationRetiredIdentity.workspaceId, context.workspaceId),
          eq(replicationRetiredIdentity.recordType, "commitment"),
          eq(replicationRetiredIdentity.recordId, recordId),
        )).limit(1);
      if (retired[0]) throw new Error(`Commitment identity is retired: ${recordId}`);
    }
    const applied = await applyCommandInTransaction(tx, context.workspaceId, command, {
      actor: context.actor,
      principalId: context.principalId,
      now,
    });
    const precondition = {
      recordType: "commitment" as const,
      recordId,
      stateDigest: before ? stateDigest(before) : null,
      snapshot: before,
    };
    const outcome = {
      recordType: "commitment" as const,
      recordId,
      stateDigest: stateDigest(applied.snapshot),
      snapshot: applied.snapshot,
    };
    const unsigned: Omit<ReplicationOperationT, "operationDigest"> = {
      contractVersion: REPLICATION_OPERATION_CONTRACT_VERSION,
      workspaceId: context.workspaceId,
      origin: {
        replicaId: local.replicaId,
        generationId: local.generationId,
        counter: local.nextCounter,
        previousDigest: local.previousDigest,
      },
      causalBase: {
        authorityReplicaId: local.authorityReplicaId,
        authorityEpoch: local.authorityEpoch,
        observedSequence: local.observedSequence,
      },
      caller: { principalId: operationCaller(context) },
      command,
      preconditions: [precondition],
      outcomes: [outcome],
      occurredAt: now,
      digestVersion: REPLICATION_DIGEST_VERSION,
    };
    const operation = ReplicationOperation.parse({
      ...unsigned,
      operationDigest: operationDigest(unsigned),
    });
    const operationJson = replicationCanonicalJson(operation);
    if (Buffer.byteLength(operationJson, "utf8") > REPLICATION_LIMITS.operationBytes) {
      throw new ReplicationProtocolError("payload_too_large", "Replication operation exceeds 1 MiB");
    }
    await tx.insert(replicationOutgoing).values({
      workspaceId: context.workspaceId,
      replicaId: local.replicaId,
      generationId: local.generationId,
      counter: local.nextCounter,
      operationDigest: operation.operationDigest,
      previousDigest: local.previousDigest,
      operationJson,
      status: "pending",
      authoritySequence: null,
      createdAt: now,
      updatedAt: now,
    });
    await tx.update(replicationLocalReplica).set({
      nextCounter: local.nextCounter + 1,
      previousDigest: operation.operationDigest,
      updatedAt: now,
    }).where(eq(replicationLocalReplica.workspaceId, context.workspaceId));
    return { operation, snapshot: applied.snapshot, events: applied.events };
  });
  events.forEach(emitAfterCommit);
  return { operation, commitment: snapshot };
}

export async function queueReplicatedCommitmentCreate(
  db: TasqDb,
  input: unknown,
  context: ReplicatedMutationContext,
): Promise<QueueReplicationResult> {
  const parsed = ReplicatedCommitmentCreate.parse(input);
  return queueCommand(db, {
    operationUri: REPLICATION_OPERATION_URIS.createCommitment,
    operationVersion: 1,
    input: parsed,
  }, context);
}

export async function queueReplicatedCommitmentUpdate(
  db: TasqDb,
  id: string,
  patch: unknown,
  context: ReplicatedMutationContext,
): Promise<QueueReplicationResult> {
  return queueCommand(db, {
    operationUri: REPLICATION_OPERATION_URIS.updateCommitment,
    operationVersion: 1,
    input: { id, patch: ReplicatedCommitmentPatch.parse(patch) },
  }, context);
}

export async function queueReplicatedCommitmentDelete(
  db: TasqDb,
  id: string,
  context: ReplicatedMutationContext,
): Promise<QueueReplicationResult> {
  return queueCommand(db, {
    operationUri: REPLICATION_OPERATION_URIS.deleteCommitment,
    operationVersion: 1,
    input: { id },
  }, context);
}

export async function queueReplicatedCommitmentRestore(
  db: TasqDb,
  id: string,
  context: ReplicatedMutationContext,
): Promise<QueueReplicationResult> {
  return queueCommand(db, {
    operationUri: REPLICATION_OPERATION_URIS.restoreCommitment,
    operationVersion: 1,
    input: { id },
  }, context);
}

export async function listPendingReplicationOperations(
  db: TasqDbOrTx,
  workspaceId: string,
  limit = REPLICATION_LIMITS.pushOperations,
): Promise<ReplicationOperationT[]> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > REPLICATION_LIMITS.pushOperations) {
    throw new Error(`Replication operation limit must be 1..${REPLICATION_LIMITS.pushOperations}`);
  }
  const localRows = await db.select().from(replicationLocalReplica)
    .where(eq(replicationLocalReplica.workspaceId, workspaceId)).limit(1);
  const local = localRows[0];
  if (!local) throw new Error(`Local replica is not initialized for workspace ${workspaceId}`);
  const rows = await db.select().from(replicationOutgoing).where(and(
    eq(replicationOutgoing.workspaceId, workspaceId),
    eq(replicationOutgoing.replicaId, local.replicaId),
    eq(replicationOutgoing.generationId, local.generationId),
    eq(replicationOutgoing.status, "pending"),
  )).orderBy(asc(replicationOutgoing.counter)).limit(limit);
  return rows.map((row) => ReplicationOperation.parse(JSON.parse(row.operationJson)));
}

export async function buildReplicationPushRequest(
  db: TasqDbOrTx,
  workspaceId: string,
  limit = REPLICATION_LIMITS.pushOperations,
): Promise<ReturnType<typeof ReplicationPushRequest.parse>> {
  const operations = await listPendingReplicationOperations(db, workspaceId, limit);
  if (operations.length === 0) throw new Error("No pending replication operations");
  return ReplicationPushRequest.parse({
    contractVersion: REPLICATION_PUSH_CONTRACT_VERSION,
    workspaceId,
    replicaId: operations[0]!.origin.replicaId,
    generationId: operations[0]!.origin.generationId,
    operations,
  });
}

function verifyOperation(operation: ReplicationOperationT): void {
  const { operationDigest: claimed, ...unsigned } = operation;
  if (operationDigest(unsigned) !== claimed) {
    throw new ReplicationProtocolError("operation_digest_mismatch", "Operation digest does not match canonical content");
  }
  if (operation.preconditions.length !== 1 || operation.outcomes.length !== 1) {
    throw new ReplicationProtocolError("unsupported_operation", "v1 commitment operations require one record state");
  }
  const recordId = operationRecordId(operation.command);
  const precondition = operation.preconditions[0]!;
  const outcome = operation.outcomes[0]!;
  if (precondition.recordId !== recordId || outcome.recordId !== recordId) {
    throw new ReplicationProtocolError("operation_digest_mismatch", "Command and record state identities differ");
  }
  for (const state of [precondition, outcome]) {
    if ((state.snapshot == null) !== (state.stateDigest == null)) {
      throw new ReplicationProtocolError("operation_digest_mismatch", "Snapshot and state digest nullability differ");
    }
    if (state.snapshot && stateDigest(state.snapshot) !== state.stateDigest) {
      throw new ReplicationProtocolError("operation_digest_mismatch", "Record state digest does not match snapshot");
    }
  }
  const base = precondition.snapshot;
  const intended = outcome.snapshot;
  if (!intended) {
    throw new ReplicationProtocolError("operation_digest_mismatch", "Commitment commands require an intended snapshot");
  }
  let expected: ReplicatedCommitmentSnapshotT;
  switch (operation.command.operationUri) {
    case REPLICATION_OPERATION_URIS.createCommitment: {
      if (base != null) {
        throw new ReplicationProtocolError("operation_digest_mismatch", "Create requires an absent base");
      }
      const input = ReplicatedCommitmentCreate.parse(operation.command.input);
      expected = ReplicatedCommitmentSnapshot.parse({
        ...input,
        status: "open",
        startedAt: null,
        completedAt: null,
        lastDoneAt: null,
        streak: 0,
        recurrenceParentId: null,
        createdAt: operation.occurredAt,
        updatedAt: operation.occurredAt,
        deletedAt: null,
      });
      break;
    }
    case REPLICATION_OPERATION_URIS.updateCommitment: {
      if (!base) throw new ReplicationProtocolError("operation_digest_mismatch", "Update requires a base snapshot");
      const patch = ReplicatedCommitmentPatch.parse(operation.command.input.patch);
      const changed = Object.entries(patch).some(([key, value]) =>
        replicationCanonicalJson(base[key as keyof ReplicatedCommitmentSnapshotT]) !==
          replicationCanonicalJson(value));
      expected = ReplicatedCommitmentSnapshot.parse({
        ...base,
        ...patch,
        updatedAt: changed ? operation.occurredAt : base.updatedAt,
      });
      break;
    }
    case REPLICATION_OPERATION_URIS.deleteCommitment: {
      if (!base) throw new ReplicationProtocolError("operation_digest_mismatch", "Delete requires a base snapshot");
      expected = ReplicatedCommitmentSnapshot.parse(base.deletedAt == null
        ? { ...base, deletedAt: operation.occurredAt, updatedAt: operation.occurredAt }
        : base);
      break;
    }
    case REPLICATION_OPERATION_URIS.restoreCommitment: {
      if (!base) throw new ReplicationProtocolError("operation_digest_mismatch", "Restore requires a base snapshot");
      expected = ReplicatedCommitmentSnapshot.parse(base.deletedAt != null
        ? { ...base, deletedAt: null, updatedAt: operation.occurredAt }
        : base);
      break;
    }
  }
  if (replicationCanonicalJson(expected) !== replicationCanonicalJson(intended)) {
    throw new ReplicationProtocolError(
      "operation_digest_mismatch",
      "Declared outcome is not the deterministic result of the explicit command and base",
    );
  }
}

function conflictFromRow(row: typeof replicationConflict.$inferSelect): ReplicationConflictT {
  return ReplicationConflict.parse({
    id: row.id,
    workspaceId: row.workspaceId,
    authoritySequence: row.authoritySequence,
    replicaId: row.replicaId,
    generationId: row.generationId,
    counter: row.counter,
    operationDigest: row.operationDigest,
    recordType: row.recordType,
    recordId: row.recordId,
    reason: row.reason,
    baseSnapshot: row.baseSnapshotJson ? JSON.parse(row.baseSnapshotJson) : null,
    authoritySnapshot: row.authoritySnapshotJson ? JSON.parse(row.authoritySnapshotJson) : null,
    incomingSnapshot: row.incomingSnapshotJson ? JSON.parse(row.incomingSnapshotJson) : null,
    principalId: row.principalId,
    recordedAt: row.recordedAt,
    resolvedByOperationDigest: row.resolvedByOperationDigest,
  });
}

async function acceptOneOperation(
  db: TasqDb,
  operation: ReplicationOperationT,
  options: AcceptReplicationOptions,
): Promise<ReplicationOperationResultT> {
  const now = clockSnapshot(options.clock);
  const { result, events } = await runInTransaction(db, async (tx) => {
    const authority = await requireAuthority(tx, operation.workspaceId);
    if (operation.causalBase.authorityReplicaId !== authority.authorityReplicaId ||
      operation.causalBase.authorityEpoch !== authority.authorityEpoch) {
      throw new ReplicationProtocolError("authority_epoch_mismatch", "Operation targets another authority epoch");
    }
    if (operation.causalBase.observedSequence > authority.currentSequence) {
      throw new ReplicationProtocolError("authority_epoch_mismatch", "Operation observes a future authority sequence");
    }
    const registrations = await tx.select().from(replicationReplica).where(and(
      eq(replicationReplica.workspaceId, operation.workspaceId),
      eq(replicationReplica.replicaId, operation.origin.replicaId),
      eq(replicationReplica.generationId, operation.origin.generationId),
    )).limit(1);
    const registration = registrations[0];
    if (!registration) {
      throw new ReplicationProtocolError("replica_not_registered", "Replica generation is not registered");
    }
    if (registration.status === "revoked") {
      throw new ReplicationProtocolError("replica_revoked", "Replica generation is revoked");
    }
    if (registration.status === "stale" || now - registration.lastContactAt > REPLICATION_RETENTION.activeReplicaMs) {
      throw new ReplicationProtocolError("replica_stale", "Replica generation must bootstrap from a snapshot");
    }

    const priorRows = await tx.select().from(replicationAccepted).where(and(
      eq(replicationAccepted.workspaceId, operation.workspaceId),
      eq(replicationAccepted.replicaId, operation.origin.replicaId),
      eq(replicationAccepted.generationId, operation.origin.generationId),
      eq(replicationAccepted.counter, operation.origin.counter),
    )).limit(1);
    const prior = priorRows[0];
    if (prior) {
      if (prior.operationDigest !== operation.operationDigest) {
        throw new ReplicationProtocolError("identity_corruption", "One operation dot has two different digests");
      }
      await tx.update(replicationReplica).set({ lastContactAt: now, updatedAt: now }).where(and(
        eq(replicationReplica.workspaceId, operation.workspaceId),
        eq(replicationReplica.replicaId, operation.origin.replicaId),
        eq(replicationReplica.generationId, operation.origin.generationId),
      ));
      return {
        result: ReplicationOperationResult.parse(JSON.parse(prior.resultJson)),
        events: [] as Event[],
      };
    }
    if (operation.origin.counter !== registration.acceptedCounter + 1) {
      throw new ReplicationProtocolError(
        "origin_gap",
        `Expected origin counter ${registration.acceptedCounter + 1}, got ${operation.origin.counter}`,
      );
    }
    if (operation.origin.previousDigest !== registration.acceptedDigest) {
      throw new ReplicationProtocolError("predecessor_mismatch", "Operation predecessor digest is not the accepted frontier");
    }

    const recordId = operationRecordId(operation.command);
    const precondition = operation.preconditions[0]!;
    const intended = operation.outcomes[0]!;
    const current = await getProjection(tx, operation.workspaceId, recordId);
    const currentDigest = current ? stateDigest(current) : null;
    const retiredRows = await tx.select().from(replicationRetiredIdentity).where(and(
      eq(replicationRetiredIdentity.workspaceId, operation.workspaceId),
      eq(replicationRetiredIdentity.recordType, "commitment"),
      eq(replicationRetiredIdentity.recordId, recordId),
    )).limit(1);
    const sequence = authority.currentSequence + 1;
    let disposition: "applied" | "equivalent" | "conflicted";
    let conflict: ReplicationConflictT | null = null;
    const committedEvents: Event[] = [];

    if (currentDigest === intended.stateDigest && currentDigest != null) {
      disposition = "equivalent";
    } else if (retiredRows[0] || currentDigest !== precondition.stateDigest) {
      disposition = "conflicted";
      conflict = ReplicationConflict.parse({
        id: uuidv7(now),
        workspaceId: operation.workspaceId,
        authoritySequence: sequence,
        replicaId: operation.origin.replicaId,
        generationId: operation.origin.generationId,
        counter: operation.origin.counter,
        operationDigest: operation.operationDigest,
        recordType: "commitment",
        recordId,
        reason: retiredRows[0] ? "retired_identity" : "concurrent_mutation",
        baseSnapshot: precondition.snapshot,
        authoritySnapshot: current,
        incomingSnapshot: intended.snapshot,
        principalId: options.authenticatedPrincipalId,
        recordedAt: now,
        resolvedByOperationDigest: null,
      });
      await tx.insert(replicationConflict).values({
        id: conflict.id,
        workspaceId: conflict.workspaceId,
        authoritySequence: sequence,
        replicaId: conflict.replicaId,
        generationId: conflict.generationId,
        counter: conflict.counter,
        operationDigest: conflict.operationDigest,
        recordType: conflict.recordType,
        recordId: conflict.recordId,
        reason: conflict.reason,
        baseSnapshotJson: conflict.baseSnapshot ? replicationCanonicalJson(conflict.baseSnapshot) : null,
        authoritySnapshotJson: conflict.authoritySnapshot ? replicationCanonicalJson(conflict.authoritySnapshot) : null,
        incomingSnapshotJson: conflict.incomingSnapshot ? replicationCanonicalJson(conflict.incomingSnapshot) : null,
        principalId: conflict.principalId,
        recordedAt: conflict.recordedAt,
        resolvedByOperationDigest: null,
      });
    } else {
      const applied = await applyCommandInTransaction(tx, operation.workspaceId, operation.command, {
        actor: options.actor,
        principalId: options.authenticatedPrincipalId,
        // Client occurredAt is descriptive only. Authority recording time,
        // tombstones and retention always come from the injected authority clock.
        now,
      });
      if (stateDigest(applied.snapshot) !== intended.stateDigest) {
        throw new ReplicationProtocolError(
          "operation_digest_mismatch",
          "Service outcome differs from the declared canonical outcome",
        );
      }
      disposition = "applied";
      committedEvents.push(...applied.events);
    }

    const acceptedResult = ReplicationOperationResult.parse({
      replicaId: operation.origin.replicaId,
      generationId: operation.origin.generationId,
      counter: operation.origin.counter,
      operationDigest: operation.operationDigest,
      disposition,
      authoritySequence: sequence,
      conflict,
    });
    await tx.insert(replicationAccepted).values({
      workspaceId: operation.workspaceId,
      authoritySequence: sequence,
      replicaId: operation.origin.replicaId,
      generationId: operation.origin.generationId,
      counter: operation.origin.counter,
      operationDigest: operation.operationDigest,
      operationJson: replicationCanonicalJson(operation),
      disposition,
      resultJson: replicationCanonicalJson(acceptedResult),
      recordedAt: now,
    });
    await tx.update(replicationAuthority).set({ currentSequence: sequence, updatedAt: now })
      .where(eq(replicationAuthority.workspaceId, operation.workspaceId));
    await tx.update(replicationReplica).set({
      acceptedCounter: operation.origin.counter,
      acceptedDigest: operation.operationDigest,
      lastContactAt: now,
      updatedAt: now,
    }).where(and(
      eq(replicationReplica.workspaceId, operation.workspaceId),
      eq(replicationReplica.replicaId, operation.origin.replicaId),
      eq(replicationReplica.generationId, operation.origin.generationId),
    ));
    return { result: acceptedResult, events: committedEvents };
  });
  events.forEach(emitAfterCommit);
  return result;
}

export async function acceptReplicationPush(
  db: TasqDb,
  input: unknown,
  options: AcceptReplicationOptions,
): Promise<ReplicationPushResponseT> {
  UuidV7.parse(options.authenticatedReplicaId);
  assertNonBlank(options.authenticatedPrincipalId, "authenticatedPrincipalId");
  assertNonBlank(options.actor, "actor");
  const request = ReplicationPushRequest.parse(input);
  const requestJson = replicationCanonicalJson(request);
  if (Buffer.byteLength(requestJson, "utf8") > REPLICATION_LIMITS.pushBytes) {
    throw new ReplicationProtocolError("payload_too_large", "Replication push exceeds 8 MiB");
  }
  if (request.replicaId !== options.authenticatedReplicaId) {
    throw new ReplicationProtocolError("unauthenticated_origin", "Authenticated replica does not match push origin");
  }
  for (const [index, operation] of request.operations.entries()) {
    if (operation.workspaceId !== request.workspaceId ||
      operation.origin.replicaId !== request.replicaId ||
      operation.origin.generationId !== request.generationId) {
      throw new ReplicationProtocolError("unauthenticated_origin", `Operation ${index} escapes the push origin`);
    }
    if (operation.caller.principalId !== options.authenticatedPrincipalId) {
      throw new ReplicationProtocolError("unauthenticated_origin", `Operation ${index} principal is not authenticated`);
    }
    if (Buffer.byteLength(replicationCanonicalJson(operation), "utf8") > REPLICATION_LIMITS.operationBytes) {
      throw new ReplicationProtocolError("payload_too_large", `Operation ${index} exceeds 1 MiB`);
    }
    verifyOperation(operation);
  }
  const results: ReplicationOperationResultT[] = [];
  for (const operation of request.operations) {
    results.push(await acceptOneOperation(db, operation, options));
  }
  const authority = await getReplicationAuthority(db, request.workspaceId);
  if (!authority) throw new ReplicationProtocolError("authority_not_initialized", "Authority disappeared");
  const response = ReplicationPushResponse.parse({
    contractVersion: REPLICATION_PUSH_CONTRACT_VERSION,
    workspaceId: request.workspaceId,
    authorityReplicaId: authority.authorityReplicaId,
    authorityEpoch: authority.authorityEpoch,
    results,
    acknowledgedCounter: results.at(-1)!.counter,
    cursor: encodeCursor(authority),
  });
  return response;
}

type CursorPayload = {
  contractVersion: typeof REPLICATION_CURSOR_CONTRACT_VERSION;
  workspaceId: string;
  authorityReplicaId: string;
  authorityEpoch: string;
  authoritySequence: number;
  digest: string;
};

function encodeCursor(authority: ReplicationAuthorityIdentity, sequence = authority.currentSequence): string {
  const unsigned = {
    contractVersion: REPLICATION_CURSOR_CONTRACT_VERSION,
    workspaceId: authority.workspaceId,
    authorityReplicaId: authority.authorityReplicaId,
    authorityEpoch: authority.authorityEpoch,
    authoritySequence: sequence,
  };
  const payload: CursorPayload = {
    ...unsigned,
    digest: replicationDigest(REPLICATION_CURSOR_CONTRACT_VERSION, unsigned),
  };
  return Buffer.from(replicationCanonicalJson(payload), "utf8").toString("base64url");
}

function decodeCursor(cursor: string): CursorPayload {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw new Error("Invalid replication cursor encoding");
  }
  if (!value || typeof value !== "object") throw new Error("Invalid replication cursor");
  const payload = value as Record<string, unknown>;
  const unsigned = {
    contractVersion: payload.contractVersion,
    workspaceId: payload.workspaceId,
    authorityReplicaId: payload.authorityReplicaId,
    authorityEpoch: payload.authorityEpoch,
    authoritySequence: payload.authoritySequence,
  };
  if (payload.contractVersion !== REPLICATION_CURSOR_CONTRACT_VERSION ||
    typeof payload.workspaceId !== "string" || typeof payload.authorityReplicaId !== "string" ||
    typeof payload.authorityEpoch !== "string" || !Number.isSafeInteger(payload.authoritySequence) ||
    Number(payload.authoritySequence) < 0 || typeof payload.digest !== "string" ||
    replicationDigest(REPLICATION_CURSOR_CONTRACT_VERSION, unsigned) !== payload.digest) {
    throw new Error("Invalid replication cursor content or digest");
  }
  return payload as CursorPayload;
}

async function buildSnapshot(
  db: TasqDbOrTx,
  authority: ReplicationAuthorityIdentity,
): Promise<ReplicationSnapshotT> {
  const [taskRows, retiredRows, conflictRows, frontierRows] = await Promise.all([
    db.select().from(task).where(and(
      eq(task.tenantId, authority.workspaceId),
      isNull(task.projectId), isNull(task.goalId), isNull(task.areaId), isNull(task.parentTaskId),
    )).orderBy(asc(task.id)),
    db.select().from(replicationRetiredIdentity).where(and(
      eq(replicationRetiredIdentity.workspaceId, authority.workspaceId),
      eq(replicationRetiredIdentity.recordType, "commitment"),
    )).orderBy(asc(replicationRetiredIdentity.recordId)),
    db.select().from(replicationConflict).where(and(
      eq(replicationConflict.workspaceId, authority.workspaceId),
      isNull(replicationConflict.resolvedByOperationDigest),
    )).orderBy(asc(replicationConflict.authoritySequence)),
    db.select().from(replicationReplica).where(
      eq(replicationReplica.workspaceId, authority.workspaceId),
    ).orderBy(asc(replicationReplica.replicaId), asc(replicationReplica.generationId)),
  ]);
  const records = taskRows.map((row) => {
    const snapshot = taskToProjection(TaskSchema.parse(parseRow(row)));
    return { recordType: "commitment" as const, recordId: snapshot.id, stateDigest: stateDigest(snapshot), snapshot };
  });
  const unsigned: Omit<ReplicationSnapshotT, "snapshotDigest"> = {
    contractVersion: REPLICATION_SNAPSHOT_CONTRACT_VERSION,
    workspaceId: authority.workspaceId,
    authorityReplicaId: authority.authorityReplicaId,
    authorityEpoch: authority.authorityEpoch,
    coveredSequence: authority.currentSequence,
    projectionVersion: REPLICATION_PROJECTION_VERSION,
    projectionDigest: REPLICATION_PROJECTION_DIGEST,
    acceptedFrontiers: frontierRows.map((row): ReplicationAcceptedFrontierT => ({
      replicaId: row.replicaId,
      generationId: row.generationId,
      acceptedCounter: row.acceptedCounter,
      acceptedDigest: row.acceptedDigest,
    })),
    records,
    retiredIdentities: retiredRows.map((row) => ({
      recordType: "commitment" as const,
      recordId: row.recordId,
      retiredAt: row.retiredAt,
      tombstoneDigest: row.tombstoneDigest,
    })),
    unresolvedConflicts: conflictRows.map(conflictFromRow),
  };
  return ReplicationSnapshot.parse({ ...unsigned, snapshotDigest: snapshotDigest(unsigned) });
}

export async function getReplicationSnapshot(
  db: TasqDb,
  workspaceId: string,
): Promise<ReplicationSnapshotT> {
  return db.transaction(async (tx) => {
    const authority = authorityIdentity(await requireAuthority(tx, workspaceId));
    return buildSnapshot(tx, authority);
  });
}

/**
 * Activate a restored authority under a fresh epoch and publish its recovery
 * snapshot in the same transaction. Every pre-restore generation becomes
 * stale, so copied clients cannot resume writing against the restored file.
 *
 * The complete expected old identity and frontier are mandatory operator
 * preconditions. An exact retry with the same new epoch is idempotent while
 * the recovered frontier remains unchanged, which covers response loss after
 * the recovery commit.
 */
export async function recoverReplicationAuthority(
  db: TasqDb,
  options: RecoverReplicationAuthorityOptions,
): Promise<{
  authority: ReplicationAuthorityIdentity;
  snapshot: ReplicationSnapshotT;
  recovery: ReplicationAuthorityRecoveryRecord;
}> {
  assertWorkspaceId(options.workspaceId);
  UuidV7.parse(options.expectedAuthorityReplicaId);
  UuidV7.parse(options.expectedAuthorityEpoch);
  UuidV7.parse(options.newAuthorityEpoch);
  if (options.newAuthorityEpoch === options.expectedAuthorityEpoch) {
    throw new Error("Authority recovery must rotate to a distinct epoch");
  }
  if (!Number.isSafeInteger(options.expectedCurrentSequence) || options.expectedCurrentSequence < 0) {
    throw new Error("expectedCurrentSequence must be a non-negative safe integer");
  }
  const reason = options.reason.trim();
  if (!reason || reason.length > 2_000) {
    throw new Error("Authority recovery reason must contain 1..2000 characters");
  }
  const now = clockSnapshot(options.clock);

  return runOperationalTransaction(db, async (tx) => {
    const current = authorityIdentity(await requireAuthority(tx, options.workspaceId));
    if (current.authorityReplicaId !== options.expectedAuthorityReplicaId ||
      current.currentSequence !== options.expectedCurrentSequence) {
      throw new ReplicationProtocolError(
        "authority_epoch_mismatch",
        "Restored authority identity or accepted frontier differs from the recovery precondition",
      );
    }

    const existingRows = await tx.select().from(replicationAuthorityRecovery).where(and(
      eq(replicationAuthorityRecovery.workspaceId, options.workspaceId),
      eq(replicationAuthorityRecovery.authorityEpoch, options.newAuthorityEpoch),
    )).limit(1);
    const existing = existingRows[0];
    if (current.authorityEpoch === options.newAuthorityEpoch) {
      if (!existing || existing.priorAuthorityEpoch !== options.expectedAuthorityEpoch ||
        existing.restoredSequence !== options.expectedCurrentSequence || existing.reason !== reason) {
        throw new ReplicationProtocolError(
          "identity_corruption",
          "Recovery epoch already exists with different preconditions",
        );
      }
      const snapshot = await buildSnapshot(tx, current);
      if (snapshot.snapshotDigest !== existing.snapshotDigest) {
        throw new ReplicationProtocolError(
          "identity_corruption",
          "Recovered authority changed before the lost recovery response was retried",
        );
      }
      return { authority: current, snapshot, recovery: recoveryRecord(existing) };
    }
    if (current.authorityEpoch !== options.expectedAuthorityEpoch || existing) {
      throw new ReplicationProtocolError(
        "authority_epoch_mismatch",
        "Restored authority epoch differs from the recovery precondition",
      );
    }

    await tx.update(replicationAuthority).set({
      authorityEpoch: options.newAuthorityEpoch,
      updatedAt: now,
    }).where(eq(replicationAuthority.workspaceId, options.workspaceId));
    await tx.update(replicationReplica).set({ status: "stale", updatedAt: now })
      .where(eq(replicationReplica.workspaceId, options.workspaceId));

    const authority: ReplicationAuthorityIdentity = {
      ...current,
      authorityEpoch: options.newAuthorityEpoch,
    };
    const snapshot = await buildSnapshot(tx, authority);
    const inserted = await tx.insert(replicationAuthorityRecovery).values({
      workspaceId: options.workspaceId,
      authorityEpoch: options.newAuthorityEpoch,
      authorityReplicaId: authority.authorityReplicaId,
      priorAuthorityEpoch: options.expectedAuthorityEpoch,
      restoredSequence: authority.currentSequence,
      snapshotDigest: snapshot.snapshotDigest,
      reason,
      recoveredAt: now,
    }).returning();
    return { authority, snapshot, recovery: recoveryRecord(inserted[0]!) };
  });
}

export async function pullReplication(
  db: TasqDb,
  options: PullReplicationOptions,
): Promise<ReplicationPullResponseT> {
  assertWorkspaceId(options.workspaceId);
  UuidV7.parse(options.replicaId);
  UuidV7.parse(options.generationId);
  UuidV7.parse(options.authenticatedReplicaId);
  if (options.replicaId !== options.authenticatedReplicaId) {
    throw new ReplicationProtocolError(
      "unauthenticated_origin",
      "Authenticated replica does not match the requested pull generation",
    );
  }
  const now = clockSnapshot(options.clock);
  const limit = options.limit ?? REPLICATION_LIMITS.pullEntries;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > REPLICATION_LIMITS.pullEntries) {
    throw new Error(`Replication pull limit must be 1..${REPLICATION_LIMITS.pullEntries}`);
  }
  return runOperationalTransaction(db, async (tx) => {
    const authority = authorityIdentity(await requireAuthority(tx, options.workspaceId));
    const registrations = await tx.select().from(replicationReplica).where(and(
      eq(replicationReplica.workspaceId, options.workspaceId),
      eq(replicationReplica.replicaId, options.replicaId),
      eq(replicationReplica.generationId, options.generationId),
    )).limit(1);
    const registration = registrations[0];
    if (!registration) throw new ReplicationProtocolError("replica_not_registered", "Replica generation is not registered");
    if (registration.status === "revoked") throw new ReplicationProtocolError("replica_revoked", "Replica is revoked");
    if (registration.status === "stale" ||
      now - registration.lastContactAt > REPLICATION_RETENTION.activeReplicaMs) {
      throw new ReplicationProtocolError(
        "replica_stale",
        "Replica generation is stale; fetch a verified snapshot and register a new generation",
      );
    }

    let cursorSequence = 0;
    let cursorExpired = false;
    if (options.cursor) {
      const cursor = decodeCursor(options.cursor);
      cursorSequence = cursor.authoritySequence;
      cursorExpired = cursor.workspaceId !== options.workspaceId ||
        cursor.authorityReplicaId !== authority.authorityReplicaId ||
        cursor.authorityEpoch !== authority.authorityEpoch ||
        cursorSequence < authority.minimumRetainedSequence ||
        cursorSequence > authority.currentSequence;
    } else if (authority.minimumRetainedSequence > 0) {
      cursorExpired = true;
    }
    if (cursorExpired) {
      const snapshot = await buildSnapshot(tx, authority);
      const nextCursor = encodeCursor(authority, snapshot.coveredSequence);
      await tx.update(replicationReplica).set({
        lastContactAt: now,
        acknowledgedSequence: snapshot.coveredSequence,
        status: "active",
        updatedAt: now,
      }).where(and(
        eq(replicationReplica.workspaceId, options.workspaceId),
        eq(replicationReplica.replicaId, options.replicaId),
        eq(replicationReplica.generationId, options.generationId),
      ));
      return ReplicationPullResponse.parse({
        contractVersion: REPLICATION_PULL_CONTRACT_VERSION,
        disposition: "cursor_expired",
        workspaceId: options.workspaceId,
        authorityReplicaId: authority.authorityReplicaId,
        authorityEpoch: authority.authorityEpoch,
        minimumRetainedSequence: authority.minimumRetainedSequence,
        snapshot,
        nextCursor,
      });
    }
    const rows = await tx.select().from(replicationAccepted).where(and(
      eq(replicationAccepted.workspaceId, options.workspaceId),
      gt(replicationAccepted.authoritySequence, cursorSequence),
    )).orderBy(asc(replicationAccepted.authoritySequence)).limit(limit + 1);
    const page = rows.slice(0, limit);
    const nextSequence = page.at(-1)?.authoritySequence ?? cursorSequence;
    const entries = page.map((row) => ReplicationOperationResult.parse(JSON.parse(row.resultJson)));
    const nextCursor = encodeCursor(authority, nextSequence);
    const snapshot = await buildSnapshot(tx, authority);
    await tx.update(replicationReplica).set({
      lastContactAt: now,
      acknowledgedSequence: Math.max(registration.acknowledgedSequence, nextSequence),
      status: "active",
      updatedAt: now,
    }).where(and(
      eq(replicationReplica.workspaceId, options.workspaceId),
      eq(replicationReplica.replicaId, options.replicaId),
      eq(replicationReplica.generationId, options.generationId),
    ));
    return ReplicationPullResponse.parse({
      contractVersion: REPLICATION_PULL_CONTRACT_VERSION,
      disposition: "incremental",
      workspaceId: options.workspaceId,
      authorityReplicaId: authority.authorityReplicaId,
      authorityEpoch: authority.authorityEpoch,
      entries,
      snapshot,
      nextCursor,
      hasMore: rows.length > limit,
    });
  });
}

export async function acknowledgeReplicationPush(
  db: TasqDb,
  input: unknown,
  clock: Clock,
): Promise<void> {
  const response = ReplicationPushResponse.parse(input);
  const now = clockSnapshot(clock);
  await runOperationalTransaction(db, async (tx) => {
    const local = await requireLocalReplica(tx, response.workspaceId);
    if (local.authorityReplicaId !== response.authorityReplicaId || local.authorityEpoch !== response.authorityEpoch) {
      throw new ReplicationProtocolError("authority_epoch_mismatch", "Push response belongs to another authority epoch");
    }
    for (const result of response.results) {
      if (result.replicaId !== local.replicaId || result.generationId !== local.generationId) {
        throw new ReplicationProtocolError("unauthenticated_origin", "Push result belongs to another local generation");
      }
      const updated = await tx.update(replicationOutgoing).set({
        status: result.disposition,
        authoritySequence: result.authoritySequence,
        updatedAt: now,
      }).where(and(
        eq(replicationOutgoing.workspaceId, response.workspaceId),
        eq(replicationOutgoing.replicaId, local.replicaId),
        eq(replicationOutgoing.generationId, local.generationId),
        eq(replicationOutgoing.counter, result.counter),
        eq(replicationOutgoing.operationDigest, result.operationDigest),
        eq(replicationOutgoing.status, "pending"),
      )).returning({ counter: replicationOutgoing.counter });
      if (updated.length === 1) continue;

      // A transport may repeat the exact response after our first local ack
      // committed but its own response was lost. Accept only byte-equivalent
      // durable state; a different digest/disposition/sequence still fails
      // closed as identity corruption.
      const existing = await tx.select().from(replicationOutgoing).where(and(
        eq(replicationOutgoing.workspaceId, response.workspaceId),
        eq(replicationOutgoing.replicaId, local.replicaId),
        eq(replicationOutgoing.generationId, local.generationId),
        eq(replicationOutgoing.counter, result.counter),
      )).limit(1);
      const row = existing[0];
      if (!row || row.operationDigest !== result.operationDigest ||
        row.status !== result.disposition || row.authoritySequence !== result.authoritySequence) {
        throw new ReplicationProtocolError(
          "identity_corruption",
          `Acknowledgement differs from durable state for counter ${result.counter}`,
        );
      }
    }
  });
}

export async function listReplicationConflicts(
  db: TasqDbOrTx,
  workspaceId: string,
  options: { includeResolved?: boolean } = {},
): Promise<ReplicationConflictT[]> {
  const filters = [eq(replicationConflict.workspaceId, workspaceId)];
  if (!options.includeResolved) filters.push(isNull(replicationConflict.resolvedByOperationDigest));
  const rows = await db.select().from(replicationConflict).where(and(...filters))
    .orderBy(asc(replicationConflict.authoritySequence));
  return rows.map(conflictFromRow);
}

function verifySnapshot(input: unknown): ReplicationSnapshotT {
  const parsed = ReplicationSnapshot.parse(input);
  const { snapshotDigest: claimed, ...unsigned } = parsed;
  if (snapshotDigest(unsigned) !== claimed) throw new Error("Replication snapshot digest mismatch");
  if (parsed.projectionDigest !== REPLICATION_PROJECTION_DIGEST) {
    throw new ReplicationProtocolError("projection_violation", "Replication projection digest is unsupported");
  }
  for (const record of parsed.records) {
    if (stateDigest(record.snapshot) !== record.stateDigest || record.recordId !== record.snapshot.id) {
      throw new Error(`Replication snapshot record digest mismatch: ${record.recordId}`);
    }
  }
  const assertUnique = (values: string[], label: string) => {
    if (new Set(values).size !== values.length) {
      throw new ReplicationProtocolError("projection_violation", `Replication snapshot has duplicate ${label}`);
    }
  };
  assertUnique(parsed.records.map((record) => record.recordId), "record identities");
  assertUnique(parsed.retiredIdentities.map((record) => record.recordId), "retired identities");
  assertUnique(parsed.acceptedFrontiers.map((frontier) =>
    `${frontier.replicaId}\0${frontier.generationId}`), "accepted frontiers");
  assertUnique(parsed.unresolvedConflicts.map((conflict) => conflict.id), "conflict identities");
  const liveOrTombstoned = new Set(parsed.records.map((record) => record.recordId));
  if (parsed.retiredIdentities.some((retired) => liveOrTombstoned.has(retired.recordId))) {
    throw new ReplicationProtocolError(
      "projection_violation",
      "A record identity cannot be both materialized and retired",
    );
  }
  for (const conflict of parsed.unresolvedConflicts) {
    if (conflict.workspaceId !== parsed.workspaceId || conflict.resolvedByOperationDigest !== null ||
      conflict.authoritySequence > parsed.coveredSequence) {
      throw new ReplicationProtocolError(
        "projection_violation",
        "Snapshot conflict escapes its workspace, sequence, or unresolved projection",
      );
    }
  }
  return parsed;
}

function replicationSnapshotPageDigest(
  page: Omit<ReplicationSnapshotPageT, "pageDigest">,
): string {
  return replicationDigest(REPLICATION_SNAPSHOT_PAGE_CONTRACT_VERSION, page);
}

function replicationSnapshotManifestDigest(
  manifest: Omit<ReplicationSnapshotManifestT, "manifestDigest">,
): string {
  return replicationDigest(`${REPLICATION_SNAPSHOT_PAGE_CONTRACT_VERSION}.manifest`, manifest);
}

/** Split one verified canonical snapshot into independently verified transport pages. */
export function paginateReplicationSnapshot(input: unknown): {
  manifest: ReplicationSnapshotManifestT;
  pages: ReplicationSnapshotPageT[];
} {
  const snapshot = verifySnapshot(input);
  const items: ReplicationSnapshotPageItemT[] = [
    ...snapshot.acceptedFrontiers.map((value) => ({ kind: "accepted_frontier" as const, value })),
    ...snapshot.records.map((value) => ({ kind: "record" as const, value })),
    ...snapshot.retiredIdentities.map((value) => ({ kind: "retired_identity" as const, value })),
    ...snapshot.unresolvedConflicts.map((value) => ({ kind: "unresolved_conflict" as const, value })),
  ];
  const chunks: ReplicationSnapshotPageItemT[][] = [];
  if (items.length === 0) chunks.push([]);
  for (let index = 0; index < items.length; index += REPLICATION_LIMITS.snapshotPageItems) {
    chunks.push(items.slice(index, index + REPLICATION_LIMITS.snapshotPageItems));
  }
  if (chunks.length > REPLICATION_LIMITS.snapshotPages) {
    throw new ReplicationProtocolError("payload_too_large", "Replication snapshot requires too many pages");
  }
  const pages = chunks.map((pageItems, pageIndex) => {
    const unsigned: Omit<ReplicationSnapshotPageT, "pageDigest"> = {
      contractVersion: REPLICATION_SNAPSHOT_PAGE_CONTRACT_VERSION,
      snapshotDigest: snapshot.snapshotDigest,
      pageIndex,
      pageCount: chunks.length,
      items: pageItems,
    };
    const page = ReplicationSnapshotPage.parse({
      ...unsigned,
      pageDigest: replicationSnapshotPageDigest(unsigned),
    });
    if (Buffer.byteLength(replicationCanonicalJson(page), "utf8") > REPLICATION_LIMITS.snapshotPageBytes) {
      throw new ReplicationProtocolError(
        "payload_too_large",
        `Replication snapshot page ${pageIndex} exceeds 8 MiB`,
      );
    }
    return page;
  });
  const unsignedManifest: Omit<ReplicationSnapshotManifestT, "manifestDigest"> = {
    contractVersion: REPLICATION_SNAPSHOT_PAGE_CONTRACT_VERSION,
    workspaceId: snapshot.workspaceId,
    authorityReplicaId: snapshot.authorityReplicaId,
    authorityEpoch: snapshot.authorityEpoch,
    coveredSequence: snapshot.coveredSequence,
    projectionVersion: snapshot.projectionVersion,
    projectionDigest: snapshot.projectionDigest,
    snapshotDigest: snapshot.snapshotDigest,
    pageCount: pages.length,
    pageDigests: pages.map((page) => page.pageDigest),
  };
  return {
    manifest: ReplicationSnapshotManifest.parse({
      ...unsignedManifest,
      manifestDigest: replicationSnapshotManifestDigest(unsignedManifest),
    }),
    pages,
  };
}

/** Verify and assemble pages before the caller starts the atomic install transaction. */
export function assembleReplicationSnapshotPages(
  manifestInput: unknown,
  pageInputs: unknown[],
): ReplicationSnapshotT {
  const manifest = ReplicationSnapshotManifest.parse(manifestInput);
  const { manifestDigest: claimedManifestDigest, ...unsignedManifest } = manifest;
  if (replicationSnapshotManifestDigest(unsignedManifest) !== claimedManifestDigest ||
    manifest.pageDigests.length !== manifest.pageCount || pageInputs.length !== manifest.pageCount) {
    throw new Error("Replication snapshot manifest digest or page count mismatch");
  }
  const pages = pageInputs.map((input) => ReplicationSnapshotPage.parse(input));
  const indexes = new Set(pages.map((page) => page.pageIndex));
  if (indexes.size !== pages.length || [...indexes].some((index) => index >= manifest.pageCount)) {
    throw new Error("Replication snapshot pages have duplicate or invalid indexes");
  }
  pages.sort((left, right) => left.pageIndex - right.pageIndex);
  for (const [index, page] of pages.entries()) {
    const { pageDigest: claimedPageDigest, ...unsignedPage } = page;
    if (page.pageIndex !== index || page.pageCount !== manifest.pageCount ||
      page.snapshotDigest !== manifest.snapshotDigest ||
      replicationSnapshotPageDigest(unsignedPage) !== claimedPageDigest ||
      manifest.pageDigests[index] !== claimedPageDigest ||
      Buffer.byteLength(replicationCanonicalJson(page), "utf8") > REPLICATION_LIMITS.snapshotPageBytes) {
      throw new Error(`Replication snapshot page ${index} failed verification`);
    }
  }
  const acceptedFrontiers: ReplicationSnapshotT["acceptedFrontiers"] = [];
  const records: ReplicationSnapshotT["records"] = [];
  const retiredIdentities: ReplicationSnapshotT["retiredIdentities"] = [];
  const unresolvedConflicts: ReplicationSnapshotT["unresolvedConflicts"] = [];
  for (const item of pages.flatMap((page) => page.items)) {
    switch (item.kind) {
      case "accepted_frontier": acceptedFrontiers.push(item.value); break;
      case "record": records.push(item.value); break;
      case "retired_identity": retiredIdentities.push(item.value); break;
      case "unresolved_conflict": unresolvedConflicts.push(item.value); break;
    }
  }
  return verifySnapshot({
    contractVersion: REPLICATION_SNAPSHOT_CONTRACT_VERSION,
    workspaceId: manifest.workspaceId,
    authorityReplicaId: manifest.authorityReplicaId,
    authorityEpoch: manifest.authorityEpoch,
    coveredSequence: manifest.coveredSequence,
    projectionVersion: manifest.projectionVersion,
    projectionDigest: manifest.projectionDigest,
    acceptedFrontiers,
    records,
    retiredIdentities,
    unresolvedConflicts,
    snapshotDigest: manifest.snapshotDigest,
  });
}

export async function getReplicationSnapshotPages(
  db: TasqDb,
  workspaceId: string,
): Promise<ReturnType<typeof paginateReplicationSnapshot>> {
  return paginateReplicationSnapshot(await getReplicationSnapshot(db, workspaceId));
}

function rawTaskFromSnapshot(workspaceId: string, snapshot: ReplicatedCommitmentSnapshotT) {
  return {
    id: snapshot.id,
    tenantId: workspaceId,
    projectId: null,
    goalId: null,
    areaId: null,
    parentTaskId: null,
    title: snapshot.title,
    description: snapshot.description,
    nextAction: snapshot.nextAction,
    successCriteria: snapshot.successCriteria,
    completionMode: snapshot.completionMode,
    status: snapshot.status,
    priority: snapshot.priority,
    estimatedMinutes: snapshot.estimatedMinutes,
    scheduledAt: snapshot.scheduledAt,
    dueAt: snapshot.dueAt,
    startedAt: snapshot.startedAt,
    completedAt: snapshot.completedAt,
    recurrence: snapshot.recurrence,
    recurrenceInterval: snapshot.recurrenceInterval,
    recurrenceAnchor: snapshot.recurrenceAnchor,
    lastDoneAt: snapshot.lastDoneAt,
    streak: snapshot.streak,
    recurrenceParentId: snapshot.recurrenceParentId,
    metadata: replicationCanonicalJson(snapshot.metadata),
    revision: 1,
    createdAt: snapshot.createdAt,
    updatedAt: snapshot.updatedAt,
    deletedAt: snapshot.deletedAt,
  };
}

/**
 * Atomically install a canonical snapshot and replay/rebase still-pending
 * operations through the same service primitives. A failure leaves the prior
 * local state and queue untouched.
 */
export async function installReplicationSnapshotAndRebase(
  db: TasqDb,
  input: unknown,
  options: { clock: Clock; actor: string; cursor?: string },
): Promise<{ replayedOperations: number }> {
  const snapshot = verifySnapshot(input);
  const now = clockSnapshot(options.clock);
  const { replayed, events } = await runInTransaction(db, async (tx) => {
    const local = await requireLocalReplica(tx, snapshot.workspaceId);
    if (local.authorityReplicaId !== snapshot.authorityReplicaId || local.authorityEpoch !== snapshot.authorityEpoch) {
      throw new ReplicationProtocolError("authority_epoch_mismatch", "Snapshot belongs to another authority epoch");
    }
    if (snapshot.coveredSequence < local.observedSequence) {
      throw new ReplicationProtocolError(
        "authority_epoch_mismatch",
        "Authority sequence regressed without the mandatory authority epoch rotation",
      );
    }
    const pendingRows = await tx.select().from(replicationOutgoing).where(and(
      eq(replicationOutgoing.workspaceId, snapshot.workspaceId),
      eq(replicationOutgoing.replicaId, local.replicaId),
      eq(replicationOutgoing.generationId, local.generationId),
      eq(replicationOutgoing.status, "pending"),
    )).orderBy(asc(replicationOutgoing.counter));
    const pending = pendingRows.map((row) => ReplicationOperation.parse(JSON.parse(row.operationJson)));
    const acceptedFrontier = snapshot.acceptedFrontiers.find((frontier) =>
      frontier.replicaId === local.replicaId && frontier.generationId === local.generationId);
    if (!acceptedFrontier) {
      throw new ReplicationProtocolError(
        "projection_violation",
        "Snapshot does not contain the local registered generation frontier",
      );
    }
    if (acceptedFrontier.acceptedCounter >= local.nextCounter) {
      throw new ReplicationProtocolError(
        "identity_corruption",
        "Authority accepted a counter this local generation never durably allocated",
      );
    }
    if (acceptedFrontier.acceptedCounter > 0) {
      const acceptedLocalRows = await tx.select({
        operationDigest: replicationOutgoing.operationDigest,
      }).from(replicationOutgoing).where(and(
        eq(replicationOutgoing.workspaceId, snapshot.workspaceId),
        eq(replicationOutgoing.replicaId, local.replicaId),
        eq(replicationOutgoing.generationId, local.generationId),
        eq(replicationOutgoing.counter, acceptedFrontier.acceptedCounter),
      )).limit(1);
      if (!acceptedLocalRows[0] ||
        acceptedLocalRows[0].operationDigest !== acceptedFrontier.acceptedDigest) {
        throw new ReplicationProtocolError(
          "identity_corruption",
          "Authority and local generation disagree at the accepted frontier",
        );
      }
    }
    const materialized = await tx.select().from(replicationMaterializedRecord)
      .where(eq(replicationMaterializedRecord.workspaceId, snapshot.workspaceId));
    const resetIds = Array.from(new Set([
      ...materialized.map((row) => row.recordId),
      ...pending.map((operation) => operationRecordId(operation.command)),
      ...snapshot.records.map((record) => record.recordId),
      ...snapshot.retiredIdentities.map((record) => record.recordId),
    ]));
    if (resetIds.length > 0) {
      await tx.delete(task).where(and(eq(task.tenantId, snapshot.workspaceId), inArray(task.id, resetIds)));
    }
    await tx.delete(replicationMaterializedRecord)
      .where(eq(replicationMaterializedRecord.workspaceId, snapshot.workspaceId));
    await tx.delete(replicationRetiredIdentity)
      .where(eq(replicationRetiredIdentity.workspaceId, snapshot.workspaceId));
    await tx.delete(replicationConflict)
      .where(eq(replicationConflict.workspaceId, snapshot.workspaceId));
    for (const record of snapshot.records) {
      await tx.insert(task).values(rawTaskFromSnapshot(snapshot.workspaceId, record.snapshot));
      await tx.insert(replicationMaterializedRecord).values({
        workspaceId: snapshot.workspaceId,
        recordType: "commitment",
        recordId: record.recordId,
        stateDigest: record.stateDigest,
        coveredSequence: snapshot.coveredSequence,
        updatedAt: now,
      });
    }
    for (const retired of snapshot.retiredIdentities) {
      await tx.insert(replicationRetiredIdentity).values({
        workspaceId: snapshot.workspaceId,
        recordType: "commitment",
        recordId: retired.recordId,
        tombstoneDigest: retired.tombstoneDigest,
        retiredAt: retired.retiredAt,
      });
    }
    for (const conflict of snapshot.unresolvedConflicts) {
      await tx.insert(replicationConflict).values({
        id: conflict.id,
        workspaceId: conflict.workspaceId,
        authoritySequence: conflict.authoritySequence,
        replicaId: conflict.replicaId,
        generationId: conflict.generationId,
        counter: conflict.counter,
        operationDigest: conflict.operationDigest,
        recordType: conflict.recordType,
        recordId: conflict.recordId,
        reason: conflict.reason,
        baseSnapshotJson: conflict.baseSnapshot ? replicationCanonicalJson(conflict.baseSnapshot) : null,
        authoritySnapshotJson: conflict.authoritySnapshot
          ? replicationCanonicalJson(conflict.authoritySnapshot)
          : null,
        incomingSnapshotJson: conflict.incomingSnapshot
          ? replicationCanonicalJson(conflict.incomingSnapshot)
          : null,
        principalId: conflict.principalId,
        recordedAt: conflict.recordedAt,
        resolvedByOperationDigest: conflict.resolvedByOperationDigest,
      });
    }

    // `null` is a meaningful genesis predecessor; do not coalesce it to the
    // local tail digest when the first pending operation has counter 1.
    let previousDigest: string | null = pending.length > 0
      ? pending[0]!.origin.previousDigest
      : local.previousDigest;
    const replayEvents: Event[] = [];
    for (const operation of pending) {
      // A lost response can leave an already-accepted operation locally
      // pending. Its dot+digest is immutable: preserve the accepted prefix so
      // the next push is an exact retry, even if later authority mutations
      // mean the current snapshot no longer resembles its declared outcome.
      if (operation.origin.counter <= acceptedFrontier.acceptedCounter) {
        previousDigest = operation.operationDigest;
        continue;
      }
      const { operationDigest: _priorOperationDigest, ...priorUnsigned } = operation;
      const recordId = operationRecordId(operation.command);
      const before = await getProjection(tx, snapshot.workspaceId, recordId);
      const cannotReplay =
        (operation.command.operationUri === REPLICATION_OPERATION_URIS.createCommitment) === (before != null);
      const applied = cannotReplay
        ? null
        : await applyCommandInTransaction(tx, snapshot.workspaceId, operation.command, {
          actor: options.actor,
          now: operation.occurredAt,
        });
      if (applied) replayEvents.push(...applied.events);
      const unsigned: Omit<ReplicationOperationT, "operationDigest"> = {
        ...priorUnsigned,
        origin: { ...operation.origin, previousDigest },
        causalBase: {
          authorityReplicaId: snapshot.authorityReplicaId,
          authorityEpoch: snapshot.authorityEpoch,
          observedSequence: snapshot.coveredSequence,
        },
        preconditions: applied ? [{
          recordType: "commitment",
          recordId,
          stateDigest: before ? stateDigest(before) : null,
          snapshot: before,
        }] : priorUnsigned.preconditions,
        outcomes: applied ? [{
          recordType: "commitment",
          recordId,
          stateDigest: stateDigest(applied.snapshot),
          snapshot: applied.snapshot,
        }] : priorUnsigned.outcomes,
      };
      const rebased = ReplicationOperation.parse({ ...unsigned, operationDigest: operationDigest(unsigned) });
      await tx.update(replicationOutgoing).set({
        previousDigest,
        operationDigest: rebased.operationDigest,
        operationJson: replicationCanonicalJson(rebased),
        updatedAt: now,
      }).where(and(
        eq(replicationOutgoing.workspaceId, snapshot.workspaceId),
        eq(replicationOutgoing.replicaId, local.replicaId),
        eq(replicationOutgoing.generationId, local.generationId),
        eq(replicationOutgoing.counter, operation.origin.counter),
      ));
      previousDigest = rebased.operationDigest;
    }
    await tx.update(replicationLocalReplica).set({
      authorityReplicaId: snapshot.authorityReplicaId,
      authorityEpoch: snapshot.authorityEpoch,
      observedSequence: snapshot.coveredSequence,
      pullCursor: options.cursor ?? encodeCursor({
        workspaceId: snapshot.workspaceId,
        authorityReplicaId: snapshot.authorityReplicaId,
        authorityEpoch: snapshot.authorityEpoch,
        currentSequence: snapshot.coveredSequence,
        minimumRetainedSequence: 0,
      }),
      previousDigest: pending.length > 0 ? previousDigest : local.previousDigest,
      updatedAt: now,
    }).where(eq(replicationLocalReplica.workspaceId, snapshot.workspaceId));
    return { replayed: pending.length, events: replayEvents };
  });
  events.forEach(emitAfterCommit);
  return { replayedOperations: replayed };
}

/** Compact one old full tombstone while permanently retaining its identity. */
export async function retireReplicatedCommitment(
  db: TasqDb,
  workspaceId: string,
  recordId: string,
  clock: Clock,
): Promise<void> {
  const now = clockSnapshot(clock);
  await runOperationalTransaction(db, async (tx) => {
    await requireAuthority(tx, workspaceId);
    const snapshot = await getProjection(tx, workspaceId, recordId);
    if (snapshot?.deletedAt == null) throw new Error(`Commitment is not a full tombstone: ${recordId}`);
    if (now - snapshot.deletedAt < REPLICATION_RETENTION.fullTombstoneMinimumMs) {
      throw new Error("Full tombstone retention boundary has not elapsed");
    }
    const digest = stateDigest(snapshot);
    await tx.insert(replicationRetiredIdentity).values({
      workspaceId,
      recordType: "commitment",
      recordId,
      tombstoneDigest: digest,
      retiredAt: now,
    });
    await tx.delete(task).where(and(eq(task.tenantId, workspaceId), eq(task.id, recordId)));
    await tx.delete(replicationMaterializedRecord).where(and(
      eq(replicationMaterializedRecord.workspaceId, workspaceId),
      eq(replicationMaterializedRecord.recordType, "commitment"),
      eq(replicationMaterializedRecord.recordId, recordId),
    ));
  });
}

/**
 * Advance the cursor floor only across old entries acknowledged by every
 * active replica. The injected authority clock controls both age and staleness.
 */
export async function pruneReplicationHistory(
  db: TasqDb,
  workspaceId: string,
  clock: Clock,
): Promise<{ pruned: number; minimumRetainedSequence: number }> {
  const now = clockSnapshot(clock);
  return runOperationalTransaction(db, async (tx) => {
    const authority = await requireAuthority(tx, workspaceId);
    await tx.update(replicationReplica).set({ status: "stale", updatedAt: now }).where(and(
      eq(replicationReplica.workspaceId, workspaceId),
      eq(replicationReplica.status, "active"),
      sql`${replicationReplica.lastContactAt} < ${now - REPLICATION_RETENTION.activeReplicaMs}`,
    ));
    const active = await tx.select().from(replicationReplica).where(and(
      eq(replicationReplica.workspaceId, workspaceId),
      eq(replicationReplica.status, "active"),
    ));
    const acknowledged = active.length > 0
      ? Math.min(...active.map((row) => row.acknowledgedSequence))
      : authority.currentSequence;
    const oldRows = await tx.select().from(replicationAccepted).where(and(
      eq(replicationAccepted.workspaceId, workspaceId),
      sql`${replicationAccepted.authoritySequence} <= ${acknowledged}`,
      sql`${replicationAccepted.recordedAt} <= ${now - REPLICATION_RETENTION.operationMinimumMs}`,
    )).orderBy(asc(replicationAccepted.authoritySequence));
    if (oldRows.length === 0) {
      return { pruned: 0, minimumRetainedSequence: authority.minimumRetainedSequence };
    }
    const floor = oldRows.at(-1)!.authoritySequence;
    await tx.delete(replicationAccepted).where(and(
      eq(replicationAccepted.workspaceId, workspaceId),
      sql`${replicationAccepted.authoritySequence} <= ${floor}`,
    ));
    await tx.update(replicationAuthority).set({
      minimumRetainedSequence: floor,
      updatedAt: now,
    }).where(eq(replicationAuthority.workspaceId, workspaceId));
    return { pruned: oldRows.length, minimumRetainedSequence: floor };
  });
}

export function replicationDiscoveryDescriptor(authority: ReplicationAuthorityIdentity) {
  return {
    authorityReplicaId: authority.authorityReplicaId,
    authorityEpoch: authority.authorityEpoch,
    currentSequence: authority.currentSequence,
    minimumRetainedSequence: authority.minimumRetainedSequence,
    operationContractVersion: REPLICATION_OPERATION_CONTRACT_VERSION,
    snapshotContractVersion: REPLICATION_SNAPSHOT_CONTRACT_VERSION,
    snapshotPageContractVersion: REPLICATION_SNAPSHOT_PAGE_CONTRACT_VERSION,
    cursorContractVersion: REPLICATION_CURSOR_CONTRACT_VERSION,
    projectionVersion: REPLICATION_PROJECTION_VERSION,
    projectionDigest: REPLICATION_PROJECTION_DIGEST,
    operationRegistry: REPLICATION_OPERATION_REGISTRY.map((entry) => ({ ...entry })),
    limits: { ...REPLICATION_LIMITS },
    retention: { ...REPLICATION_RETENTION },
  };
}

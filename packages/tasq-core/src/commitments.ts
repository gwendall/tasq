/** Profile-neutral commitment API over the v1 `task` storage adapter. */

import { z } from "zod";
import {
  CompletionMode,
  Metadata,
  Priority,
  TaskStatus,
  UnixMs,
  type Clock,
  type Metadata as MetadataT,
  type Task,
  type TaskStatus as TaskStatusT,
} from "@tasq-run/schema";
import type { TasqDb, TasqDbOrTx } from "./db.js";
import {
  blockTask,
  cancelTask,
  completeTask,
  createTask,
  getTask,
  listTasks,
  reopenTask,
  startTask,
  unblockTask,
  updateTask,
  type StatusChangeOptions,
} from "./service/tasks.js";
import { captureDiscovery as captureDiscoveryRecord } from "./service/discoveries.js";
import {
  attachAssumption as attachAssumptionRecord,
  getTaskAssumptions as getTaskAssumptionsRecord,
  listAssumptions as listAssumptionsRecord,
  withdrawAssumption as withdrawAssumptionRecord,
} from "./service/assumptions.js";
import type {
  AssumptionLinkRecord,
  AssumptionRecord,
  AssumptionSummary,
  TaskAssumptionState,
} from "./service/assumptions.js";
import type { CaptureDiscoveryResult } from "./service/discoveries.js";

export interface KernelContext {
  /** Explicit workspace identity; the minimal kernel has no local-person default. */
  workspaceId: string;
  actor: string;
  /** Stable subject mapped by the transport; attribution is not authority. */
  principalId?: string;
  idempotencyKey?: string;
  clock?: Clock;
  now?: number;
}

export interface Commitment {
  id: string;
  workspaceId: string;
  title: string;
  description: string | null;
  /** The commitment this one is a part of, when it is part of one. */
  parentCommitmentId?: string | null;
  successCriteria: string | null;
  completionPolicy: "assertion" | "evidence";
  validationRequired: boolean;
  status: TaskStatusT;
  priority: number | null;
  notBefore: number | null;
  dueAt: number | null;
  startedAt: number | null;
  completedAt: number | null;
  metadata: MetadataT;
  revision: number;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
}

const CommitmentCreate = z.object({
  title: z.string().min(1).max(500),
  description: z.string().nullable().default(null),
  successCriteria: z.string().min(1).max(2_000).nullable().default(null),
  completionPolicy: CompletionMode.default("assertion"),
  validationRequired: z.boolean().default(false),
  priority: Priority.nullable().default(null),
  notBefore: UnixMs.nullable().default(null),
  dueAt: UnixMs.nullable().default(null),
  metadata: Metadata.default({}),
  /**
   * Decomposition: the commitment this one is a part of (ADR-023). A commitment
   * has exactly one parent or none, which is what makes decomposition mean
   * anything, and the column gets that from a foreign key.
   */
  parentCommitmentId: z.string().uuid().nullable().default(null),
}).strict();

const CommitmentUpdate = CommitmentCreate.partial().strict();

export interface CreateCommitmentInput {
  title: string;
  description?: string | null;
  successCriteria?: string | null;
  completionPolicy?: "assertion" | "evidence";
  validationRequired?: boolean;
  priority?: number | null;
  notBefore?: number | null;
  dueAt?: number | null;
  metadata?: MetadataT;
  /** The commitment this one is a part of. One parent or none. */
  parentCommitmentId?: string | null;
}

export type UpdateCommitmentInput = Partial<CreateCommitmentInput>;

export interface ListCommitmentsOptions {
  workspaceId: string;
  status?: TaskStatusT | TaskStatusT[];
  includeDeleted?: boolean;
  includeDeferred?: boolean;
  limit?: number;
  /** Exclusive stable cursor for `updatedAt DESC, id DESC`. */
  before?: { updatedAt: number; id: string };
  clock?: Clock;
  now?: number;
}

export interface CommitmentTransitionOptions extends KernelContext {
  expectedRevision: number;
  reason?: string;
  note?: string;
  source?: string;
  occurredAt?: number;
  evidenceIds?: string[];
  validationDecisionId?: string;
  /**
   * Take a terminal transition over another principal's active claim, as a
   * recorded, deliberate supervision act (a maintainer closing agent work on
   * independent evidence). The MCP surface deliberately does not expose this.
   */
  force?: boolean;
}

export async function createCommitment(
  db: TasqDb,
  input: CreateCommitmentInput,
  context: KernelContext,
): Promise<Commitment> {
  const parsed = CommitmentCreate.parse(input);
  const row = await createTask(db, {
    tenantId: context.workspaceId,
    title: parsed.title,
    description: parsed.description,
    successCriteria: parsed.successCriteria,
    completionMode: parsed.completionPolicy,
    validationRequired: parsed.validationRequired,
    priority: parsed.priority,
    scheduledAt: parsed.notBefore,
    dueAt: parsed.dueAt,
    metadata: parsed.metadata,
    parentTaskId: parsed.parentCommitmentId,
  }, legacyContext(context));
  return toCommitment(row);
}

export async function getCommitment(
  db: TasqDbOrTx,
  id: string,
  workspaceId: string,
): Promise<Commitment | null> {
  const row = await getTask(db, id, workspaceId);
  return row ? toCommitment(row) : null;
}

export async function listCommitments(
  db: TasqDb,
  options: ListCommitmentsOptions,
): Promise<Commitment[]> {
  const rows = await listTasks(db, {
    tenantId: options.workspaceId,
    status: options.status,
    includeDeleted: options.includeDeleted,
    includeScheduled: options.includeDeferred,
    limit: options.limit,
    beforeUpdatedAt: options.before?.updatedAt,
    beforeId: options.before?.id,
    clock: options.clock,
    now: options.now,
  });
  return rows.map(toCommitment);
}

export async function updateCommitment(
  db: TasqDb,
  id: string,
  input: UpdateCommitmentInput,
  context: KernelContext & { expectedRevision: number },
): Promise<Commitment> {
  const parsed = CommitmentUpdate.parse(input);
  const row = await updateTask(db, id, {
    ...(parsed.title !== undefined ? { title: parsed.title } : {}),
    ...(parsed.description !== undefined ? { description: parsed.description } : {}),
    ...(parsed.successCriteria !== undefined ? { successCriteria: parsed.successCriteria } : {}),
    ...(parsed.completionPolicy !== undefined
      ? { completionMode: parsed.completionPolicy }
      : {}),
    ...(parsed.validationRequired !== undefined
      ? { validationRequired: parsed.validationRequired }
      : {}),
    ...(parsed.priority !== undefined ? { priority: parsed.priority } : {}),
    ...(parsed.notBefore !== undefined ? { scheduledAt: parsed.notBefore } : {}),
    ...(parsed.dueAt !== undefined ? { dueAt: parsed.dueAt } : {}),
    ...(parsed.metadata !== undefined ? { metadata: parsed.metadata } : {}),
  }, { ...legacyContext(context), expectedRevision: context.expectedRevision });
  return toCommitment(row);
}

/**
 * Record work discovered while executing a commitment, linked to the
 * commitment that surfaced it.
 *
 * The source commitment and any active claim are read ONLY. Capture never
 * widens, renews or releases execution authority, which is what makes it safe
 * to call in the middle of a task and why it needs no coordination capability.
 * See ADR-020: the relation table and the `discovered_from` type were already
 * kernel, but no kernel API wrote a relation, so an agent working over MCP had
 * no way to report anything at all.
 */
export async function captureCommitmentDiscovery(
  db: TasqDb,
  input: {
    sourceCommitmentId: string;
    title: string;
    nextAction?: string | null;
    sourceCommand?: string | null;
    context?: Record<string, unknown>;
  },
  context: KernelContext,
): Promise<{ commitment: Commitment; discoveredFrom: string; replayed: boolean }> {
  const captured: CaptureDiscoveryResult = await captureDiscoveryRecord(db, {
    sourceTaskId: input.sourceCommitmentId,
    title: input.title,
    nextAction: input.nextAction ?? null,
    sourceCommand: input.sourceCommand ?? null,
    context: input.context ?? {},
  }, legacyContext(context));
  return {
    commitment: toCommitment(captured.task),
    discoveredFrom: captured.relation.toTaskId,
    replayed: captured.replayed,
  };
}

/**
 * ADR-021 — record why a commitment exists, in the kernel's vocabulary.
 *
 * Assumptions are matched by their text inside a workspace, so two agents that
 * phrase one belief differently attach to the same record and a single
 * withdrawal reaches all the work resting on it.
 */
export async function attachCommitmentAssumption(
  db: TasqDb,
  input: { commitmentId: string; because: string },
  context: KernelContext,
): Promise<{ assumption: AssumptionRecord; link: AssumptionLinkRecord }> {
  return attachAssumptionRecord(db, {
    taskId: input.commitmentId,
    text: input.because,
  }, legacyContext(context));
}

/**
 * Withdraw a belief and pause every OPEN commitment resting on it. Nothing is
 * cancelled, the effect stops at one hop, and the history stays readable.
 */
export async function withdrawCommitmentAssumption(
  db: TasqDb,
  input: { because: string; reason: string; evidenceIds?: string[] },
  context: KernelContext,
): Promise<{ assumption: AssumptionRecord; pausedCommitmentIds: string[]; replayed: boolean }> {
  const result = await withdrawAssumptionRecord(db, {
    text: input.because,
    reason: input.reason,
    evidenceIds: input.evidenceIds ?? [],
  }, legacyContext(context));
  return {
    assumption: result.assumption,
    pausedCommitmentIds: result.pausedTaskIds,
    replayed: result.replayed,
  };
}

/** What one commitment rests on, and whether it is paused. */
export async function getCommitmentAssumptions(
  db: TasqDb,
  commitmentId: string,
  context: KernelContext,
): Promise<TaskAssumptionState> {
  return getTaskAssumptionsRecord(db, commitmentId, legacyContext(context).tenantId);
}

/** Everything this workspace currently believes. */
export async function listWorkspaceAssumptions(
  db: TasqDb,
  context: KernelContext,
  options: { status?: "standing" | "withdrawn" } = {},
): Promise<AssumptionSummary[]> {
  return listAssumptionsRecord(db, legacyContext(context).tenantId, options);
}

export const startCommitment = transition(startTask);
export const completeCommitment = transition(completeTask);
export const blockCommitment = transition(blockTask);
export const unblockCommitment = transition(unblockTask);
export const cancelCommitment = transition(cancelTask);
export const reopenCommitment = transition(reopenTask);

function transition(
  operation: (db: TasqDb, id: string, options?: StatusChangeOptions) => Promise<Task>,
) {
  return async (
    db: TasqDb,
    id: string,
    options: CommitmentTransitionOptions,
  ): Promise<Commitment> => toCommitment(await operation(db, id, {
    ...legacyContext(options),
    expectedRevision: options.expectedRevision,
    reason: options.reason,
    note: options.note,
    source: options.source,
    occurredAt: options.occurredAt,
    evidenceIds: options.evidenceIds,
    validationDecisionId: options.validationDecisionId,
    force: options.force,
  }));
}

function legacyContext(context: KernelContext) {
  if (!context.workspaceId.trim()) throw new Error("workspaceId must not be blank");
  if (!context.actor.trim()) throw new Error("actor must not be blank");
  return {
    tenantId: context.workspaceId,
    actor: context.actor,
    principalId: context.principalId,
    idempotencyKey: context.idempotencyKey,
    clock: context.clock,
    now: context.now,
  };
}

function toCommitment(row: Task): Commitment {
  return {
    id: row.id,
    workspaceId: row.tenantId,
    title: row.title,
    description: row.description,
    successCriteria: row.successCriteria,
    completionPolicy: row.completionMode,
    validationRequired: row.validationRequired,
    status: row.status,
    priority: row.priority,
    notBefore: row.scheduledAt,
    dueAt: row.dueAt,
    parentCommitmentId: row.parentTaskId,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    metadata: row.metadata,
    revision: row.revision,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt,
  };
}

export { TaskStatus as CommitmentStatus };

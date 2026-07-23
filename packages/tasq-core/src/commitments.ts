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
  successCriteria: string | null;
  completionPolicy: "assertion" | "evidence";
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
  priority: Priority.nullable().default(null),
  notBefore: UnixMs.nullable().default(null),
  dueAt: UnixMs.nullable().default(null),
  metadata: Metadata.default({}),
}).strict();

const CommitmentUpdate = CommitmentCreate.partial().strict();

export interface ListCommitmentsOptions {
  workspaceId: string;
  status?: TaskStatusT | TaskStatusT[];
  includeDeleted?: boolean;
  includeDeferred?: boolean;
  limit?: number;
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
}

export async function createCommitment(
  db: TasqDb,
  input: unknown,
  context: KernelContext,
): Promise<Commitment> {
  const parsed = CommitmentCreate.parse(input);
  const row = await createTask(db, {
    tenantId: context.workspaceId,
    title: parsed.title,
    description: parsed.description,
    successCriteria: parsed.successCriteria,
    completionMode: parsed.completionPolicy,
    priority: parsed.priority,
    scheduledAt: parsed.notBefore,
    dueAt: parsed.dueAt,
    metadata: parsed.metadata,
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
    clock: options.clock,
    now: options.now,
  });
  return rows.map(toCommitment);
}

export async function updateCommitment(
  db: TasqDb,
  id: string,
  input: unknown,
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
    ...(parsed.priority !== undefined ? { priority: parsed.priority } : {}),
    ...(parsed.notBefore !== undefined ? { scheduledAt: parsed.notBefore } : {}),
    ...(parsed.dueAt !== undefined ? { dueAt: parsed.dueAt } : {}),
    ...(parsed.metadata !== undefined ? { metadata: parsed.metadata } : {}),
  }, { ...legacyContext(context), expectedRevision: context.expectedRevision });
  return toCommitment(row);
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
    status: row.status,
    priority: row.priority,
    notBefore: row.scheduledAt,
    dueAt: row.dueAt,
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

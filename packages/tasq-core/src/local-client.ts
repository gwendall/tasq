/**
 * Deep local composition for application and runtime embedders.
 *
 * The client owns store opening, compatible migrations, coordination-space
 * bootstrap and repetitive call context. Its interface deliberately keeps
 * the store URL, workspace, actor and authoritative clock explicit.
 */

import type {
  AttemptStatus,
  Clock,
  EntityType,
  Event,
  Metadata,
  TaskAttempt,
  TaskClaim,
  TaskEvidence,
} from "@tasq-run/schema";
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
import { openDb } from "./db.js";
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
    });
    const serviceContext = <T extends object>(extra?: T) => ({
      tenantId: options.workspaceId,
      actor: options.actor,
      principalId,
      clock: options.clock,
      ...(extra ?? {}),
    });
    const resourceContext = <T extends object>(extra?: T) => ({
      workspaceId: options.workspaceId,
      actor: options.actor,
      principalId,
      clock: options.clock,
      ...(extra ?? {}),
    });
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

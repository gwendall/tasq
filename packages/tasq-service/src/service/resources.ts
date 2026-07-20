/** Provider- and domain-neutral exclusive resource coordination. */

import { and, asc, desc, eq, isNull, lte, sql } from "drizzle-orm";
import {
  BootstrapActorAlias,
  CoordinationSpaceId,
  ResourceEvent as ResourceEventZ,
  ResourceKey,
  ResourceLease as ResourceLeaseZ,
  resourceEvent,
  resourceLease,
  uuidv7,
  type Clock,
  type Metadata,
  type ResourceEvent,
  type ResourceEventPage,
  type ResourceEventType,
  type ResourceFenceVerification,
  type ResourceLease,
  type ResourceLeaseOperation,
  type ResourceLeaseView,
  type ResourceProblemCode,
  type ResourceSweep,
  type ResourceWorld,
} from "@tasq/schema";
import type { TasqDb, TasqDbOrTx } from "../db.js";
import { runInTransaction } from "../db.js";
import { canonicalJson } from "../util/canonical-json.js";
import { getPrincipal, ensureLocalPrincipal, localPrincipalId } from "./principals.js";
import { getCoordinationSpace } from "./spaces.js";
import {
  findIdempotencyResult,
  prepareIdempotency,
  saveIdempotencyResult,
  type PreparedIdempotency,
} from "./idempotency.js";

export const MIN_RESOURCE_LEASE_MS = 1_000;
export const MAX_RESOURCE_LEASE_MS = 7 * 24 * 60 * 60 * 1_000;
export const DEFAULT_RESOURCE_LEASE_MS = 30 * 60 * 1_000;
export const MAX_RESOURCE_METADATA_BYTES = 16 * 1_024;

export class ResourceLeaseError extends Error {
  readonly code: ResourceProblemCode;
  readonly currentLease: ResourceLeaseView | null;

  constructor(code: ResourceProblemCode, message: string, currentLease: ResourceLeaseView | null = null) {
    super(message);
    this.name = "ResourceLeaseError";
    this.code = code;
    this.currentLease = currentLease;
  }
}

interface ResourceContext {
  workspaceId: string;
  actor: string;
  principalId?: string;
  /** Mandatory authoritative clock. This module never reads device time. */
  clock: Clock;
}

interface ResourceMutationContext extends ResourceContext {
  /** Mandatory stable retry identity. */
  idempotencyKey: string;
}

export interface AcquireResourceLeaseOptions extends ResourceMutationContext {
  leaseMs?: number;
  metadata?: Metadata;
}

export interface RenewResourceLeaseOptions extends ResourceMutationContext {
  leaseId: string;
  fence: number;
  expectedRevision: number;
  leaseMs?: number;
}

export interface ReleaseResourceLeaseOptions extends ResourceMutationContext {
  leaseId: string;
  fence: number;
  expectedRevision: number;
  reason?: string;
}

export interface VerifyResourceFenceOptions extends ResourceContext {
  leaseId: string;
  fence: number;
}

export interface ListResourceWorldOptions extends ResourceContext {
  activeOnly?: boolean;
  holderPrincipalId?: string;
  limit?: number;
}

export interface ListResourceEventsOptions extends ResourceContext {
  resourceKey?: string;
  afterSequence?: number;
  limit?: number;
}

export interface SweepExpiredResourcesOptions extends ResourceContext {
  limit?: number;
}

function nowFrom(clock: Clock | undefined): number {
  if (!clock || typeof clock.now !== "function") {
    throw new ResourceLeaseError("invalid_input", "clock is required for resource coordination");
  }
  const now = clock.now();
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new ResourceLeaseError("invalid_input", "clock must return a non-negative unix-ms integer");
  }
  return now;
}

function leaseDuration(value: number | undefined): number {
  const duration = value ?? DEFAULT_RESOURCE_LEASE_MS;
  if (!Number.isSafeInteger(duration) || duration < MIN_RESOURCE_LEASE_MS || duration > MAX_RESOURCE_LEASE_MS) {
    throw new ResourceLeaseError(
      "invalid_input",
      `leaseMs must be an integer between ${MIN_RESOURCE_LEASE_MS} and ${MAX_RESOURCE_LEASE_MS}`,
    );
  }
  return duration;
}

function safePositive(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ResourceLeaseError("invalid_input", `${label} must be a positive integer`);
  }
  return value;
}

function boundedLimit(value: number | undefined): number {
  const limit = value ?? 1_000;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) {
    throw new ResourceLeaseError("invalid_input", "limit must be an integer between 1 and 10000");
  }
  return limit;
}

function parseLease(row: typeof resourceLease.$inferSelect): ResourceLease {
  return ResourceLeaseZ.parse({
    ...row,
    metadata: typeof row.metadata === "string" ? JSON.parse(row.metadata) : row.metadata,
  });
}

function parseEvent(row: typeof resourceEvent.$inferSelect): ResourceEvent {
  return ResourceEventZ.parse({
    ...row,
    payload: typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload,
  });
}

function view(lease: ResourceLease, observedAt: number): ResourceLeaseView {
  const status = lease.releasedAt !== null
    ? lease.releaseReason === "expired" ? "expired" : "released"
    : lease.expiresAt <= observedAt ? "expired" : "active";
  return { status, observedAt, lease };
}

function validateScope(options: ResourceContext): { workspaceId: string; actor: string } {
  return {
    workspaceId: CoordinationSpaceId.parse(options.workspaceId),
    actor: BootstrapActorAlias.parse(options.actor),
  };
}

function validateMetadata(value: Metadata | undefined): { value: Metadata; json: string } {
  const metadata = value ?? {};
  const json = canonicalJson(metadata);
  if (Buffer.byteLength(json, "utf8") > MAX_RESOURCE_METADATA_BYTES) {
    throw new ResourceLeaseError("invalid_input", `metadata exceeds ${MAX_RESOURCE_METADATA_BYTES} UTF-8 bytes`);
  }
  return { value: metadata, json };
}

function requireIdempotencyKey(value: string | undefined): string {
  if (!value?.trim()) {
    throw new ResourceLeaseError("invalid_input", "idempotencyKey is required for resource mutations");
  }
  return value;
}

async function requireSpace(tx: TasqDbOrTx, workspaceId: string): Promise<void> {
  if (!await getCoordinationSpace(tx, workspaceId)) {
    throw new ResourceLeaseError("space_not_found", `Coordination space not found: ${workspaceId}`);
  }
}

async function resolvePrincipal(
  tx: TasqDbOrTx,
  workspaceId: string,
  actor: string,
  principalId: string | undefined,
  now: number,
) {
  if (!principalId) return ensureLocalPrincipal(tx, workspaceId, actor, now);
  const principal = await getPrincipal(tx, principalId, workspaceId);
  if (!principal) throw new ResourceLeaseError("not_holder", `Principal not found in space: ${principalId}`);
  if (principal.status !== "enabled") throw new ResourceLeaseError("not_holder", `Principal is disabled: ${principalId}`);
  return principal;
}

async function resolveExistingPrincipal(
  tx: TasqDbOrTx,
  workspaceId: string,
  actor: string,
  principalId: string | undefined,
) {
  const id = principalId ?? localPrincipalId(workspaceId, actor);
  const principal = await getPrincipal(tx, id, workspaceId);
  if (!principal || principal.status !== "enabled") {
    throw new ResourceLeaseError("not_holder", `Enabled principal not found in space: ${id}`);
  }
  return principal;
}

async function latestLease(
  tx: TasqDbOrTx,
  workspaceId: string,
  resourceKey: string,
): Promise<ResourceLease | null> {
  const rows = await tx.select().from(resourceLease).where(and(
    eq(resourceLease.workspaceId, workspaceId),
    eq(resourceLease.resourceKey, resourceKey),
  )).orderBy(desc(resourceLease.fence)).limit(1);
  return rows[0] ? parseLease(rows[0]) : null;
}

async function liveLease(
  tx: TasqDbOrTx,
  workspaceId: string,
  resourceKey: string,
): Promise<ResourceLease | null> {
  const rows = await tx.select().from(resourceLease).where(and(
    eq(resourceLease.workspaceId, workspaceId),
    eq(resourceLease.resourceKey, resourceKey),
    isNull(resourceLease.releasedAt),
  )).limit(1);
  return rows[0] ? parseLease(rows[0]) : null;
}

function assertClockNotBefore(lease: ResourceLease, now: number): void {
  if (now < lease.heartbeatAt || now < lease.updatedAt) {
    throw new ResourceLeaseError(
      "clock_regression",
      `Clock moved backwards for ${lease.resourceKey}: ${now} < ${Math.max(lease.heartbeatAt, lease.updatedAt)}`,
      view(lease, now),
    );
  }
}

async function appendResourceEvent(
  tx: TasqDbOrTx,
  lease: ResourceLease,
  actor: string,
  principalId: string,
  eventType: ResourceEventType,
  payload: Metadata,
  now: number,
): Promise<ResourceEvent> {
  const rows = await tx.insert(resourceEvent).values({
    id: uuidv7(now),
    workspaceId: lease.workspaceId,
    resourceKey: lease.resourceKey,
    leaseId: lease.id,
    actor,
    principalId,
    eventType,
    payload: canonicalJson(payload),
    createdAt: now,
  }).returning();
  if (!rows[0]) throw new ResourceLeaseError("storage_error", "Failed to append resource event");
  return parseEvent(rows[0]);
}

async function leaseEventCursor(tx: TasqDbOrTx, leaseId: string): Promise<number> {
  const rows = await tx.select({ cursor: sql<number>`coalesce(max(${resourceEvent.sequence}), 0)` })
    .from(resourceEvent).where(eq(resourceEvent.leaseId, leaseId));
  return Number(rows[0]?.cursor ?? 0);
}

function retryIdentity(
  options: ResourceMutationContext,
  operation: string,
  request: unknown,
  now: number,
): PreparedIdempotency {
  const prepared = prepareIdempotency({
    tenantId: options.workspaceId,
    actor: options.actor,
    principalId: options.principalId,
    idempotencyKey: requireIdempotencyKey(options.idempotencyKey),
  }, operation, request, { now });
  if (!prepared) throw new ResourceLeaseError("invalid_input", "idempotencyKey is required");
  return prepared;
}

async function replayOperation(
  tx: TasqDbOrTx,
  identity: PreparedIdempotency,
  observedAt: number,
): Promise<ResourceLeaseOperation | null> {
  const prior = await findIdempotencyResult(tx, identity);
  if (!prior) return null;
  const rows = await tx.select().from(resourceLease).where(eq(resourceLease.id, prior.resultId)).limit(1);
  if (!rows[0]) throw new ResourceLeaseError("storage_error", `Retry identity points at missing lease ${prior.resultId}`);
  const lease = parseLease(rows[0]);
  assertClockNotBefore(lease, observedAt);
  return {
    contractVersion: "tasq.resource-operation.v1",
    disposition: (prior.resultStatus ?? "acquired") as ResourceLeaseOperation["disposition"],
    observedAt: prior.createdAt,
    lease,
    eventCursor: { afterSequence: prior.eventSequence ?? 0 },
  };
}

async function saveOperation(
  tx: TasqDbOrTx,
  identity: PreparedIdempotency,
  disposition: ResourceLeaseOperation["disposition"],
  lease: ResourceLease,
  eventSequence: number,
): Promise<void> {
  await saveIdempotencyResult(tx, identity, {
    resultType: "resource_lease",
    resultId: lease.id,
    resultStatus: disposition,
    resultRevision: lease.revision,
    eventSequence: eventSequence > 0 ? eventSequence : null,
  });
}

async function expireLease(
  tx: TasqDbOrTx,
  lease: ResourceLease,
  actor: string,
  principalId: string,
  now: number,
  expectedRevision?: number,
): Promise<{ lease: ResourceLease; event: ResourceEvent }> {
  assertClockNotBefore(lease, now);
  const rows = await tx.update(resourceLease).set({
    releasedAt: now,
    releaseReason: "expired",
    revision: sql`${resourceLease.revision} + 1`,
    updatedAt: now,
  }).where(and(
    eq(resourceLease.id, lease.id),
    isNull(resourceLease.releasedAt),
    ...(expectedRevision === undefined ? [] : [eq(resourceLease.revision, expectedRevision)]),
  )).returning();
  if (!rows[0]) throw new ResourceLeaseError("stale_fence", `Lease changed while expiring ${lease.resourceKey}`);
  const expired = parseLease(rows[0]);
  const event = await appendResourceEvent(tx, expired, actor, principalId, "resource_lease_expired", {
    fence: expired.fence,
    expiredAt: now,
  }, now);
  return { lease: expired, event };
}

export async function acquireResourceLease(
  db: TasqDb,
  resourceKeyInput: string,
  options: AcquireResourceLeaseOptions,
): Promise<ResourceLeaseOperation> {
  const { workspaceId, actor } = validateScope(options);
  const resourceKey = ResourceKey.parse(resourceKeyInput);
  const duration = leaseDuration(options.leaseMs);
  const metadata = validateMetadata(options.metadata);
  requireIdempotencyKey(options.idempotencyKey);

  return runInTransaction(db, async (tx) => {
    // Sample authority time only after this transaction has entered SQLite's
    // serialization boundary. A process that waited for another writer must
    // not carry an older pre-lock device sample into the ordered ledger.
    const now = nowFrom(options.clock);
    const expiresAt = now + duration;
    if (!Number.isSafeInteger(expiresAt)) throw new ResourceLeaseError("invalid_input", "lease expiry exceeds unix-ms range");
    const identity = retryIdentity({ ...options, workspaceId, actor }, "resource.acquire", {
      resourceKey, principalId: options.principalId ?? null, leaseMs: duration, metadata: metadata.value,
    }, now);
    const replay = await replayOperation(tx, identity, now);
    if (replay) return replay;
    await requireSpace(tx, workspaceId);
    const principal = await resolvePrincipal(tx, workspaceId, actor, options.principalId, now);
    const current = await liveLease(tx, workspaceId, resourceKey);
    let disposition: ResourceLeaseOperation["disposition"] = "acquired";
    let priorFence = 0;
    if (current) {
      assertClockNotBefore(current, now);
      if (current.expiresAt > now) {
        if (current.holderPrincipalId !== principal.id) {
          throw new ResourceLeaseError(
            "contended",
            `Resource ${resourceKey} is held by ${current.holderActor} until ${current.expiresAt}`,
            view(current, now),
          );
        }
        const cursor = await leaseEventCursor(tx, current.id);
        await saveOperation(tx, identity, "already_held", current, cursor);
        return {
          contractVersion: "tasq.resource-operation.v1",
          disposition: "already_held",
          observedAt: now,
          lease: current,
          eventCursor: { afterSequence: cursor },
        };
      }
      priorFence = current.fence;
      await expireLease(tx, current, actor, principal.id, now);
      disposition = "reclaimed";
    } else {
      priorFence = (await latestLease(tx, workspaceId, resourceKey))?.fence ?? 0;
    }
    if (priorFence >= Number.MAX_SAFE_INTEGER) {
      throw new ResourceLeaseError("unavailable", `Fence space exhausted for ${resourceKey}`);
    }
    const id = uuidv7(now);
    const inserted = await tx.insert(resourceLease).values({
      id,
      workspaceId,
      resourceKey,
      holderActor: actor,
      holderPrincipalId: principal.id,
      revision: 1,
      fence: priorFence + 1,
      acquiredAt: now,
      heartbeatAt: now,
      expiresAt,
      releasedAt: null,
      releaseReason: null,
      metadata: metadata.json,
      createdAt: now,
      updatedAt: now,
    }).returning();
    if (!inserted[0]) throw new ResourceLeaseError("storage_error", `Failed to acquire ${resourceKey}`);
    const lease = parseLease(inserted[0]);
    const event = await appendResourceEvent(tx, lease, actor, principal.id, "resource_lease_acquired", {
      fence: lease.fence,
      expiresAt: lease.expiresAt,
      disposition,
    }, now);
    await saveOperation(tx, identity, disposition, lease, event.sequence);
    return {
      contractVersion: "tasq.resource-operation.v1",
      disposition,
      observedAt: now,
      lease,
      eventCursor: { afterSequence: event.sequence },
    };
  });
}

function assertOwned(
  lease: ResourceLease,
  principalId: string,
  leaseId: string,
  fence: number,
  now: number,
): void {
  assertClockNotBefore(lease, now);
  const current = view(lease, now);
  if (lease.releasedAt !== null) throw new ResourceLeaseError("released", `Lease ${lease.id} was released`, current);
  if (lease.expiresAt <= now) throw new ResourceLeaseError("expired", `Lease ${lease.id} expired at ${lease.expiresAt}`, current);
  if (lease.id !== leaseId || lease.fence !== fence) {
    throw new ResourceLeaseError("stale_fence", `Stale lease or fence for ${lease.resourceKey}`, current);
  }
  if (lease.holderPrincipalId !== principalId) {
    throw new ResourceLeaseError("not_holder", `Resource ${lease.resourceKey} is held by ${lease.holderActor}`, current);
  }
}

export async function renewResourceLease(
  db: TasqDb,
  resourceKeyInput: string,
  options: RenewResourceLeaseOptions,
): Promise<ResourceLeaseOperation> {
  const { workspaceId, actor } = validateScope(options);
  const resourceKey = ResourceKey.parse(resourceKeyInput);
  const duration = leaseDuration(options.leaseMs);
  const leaseId = options.leaseId;
  const fence = safePositive(options.fence, "fence");
  const expectedRevision = safePositive(options.expectedRevision, "expectedRevision");
  requireIdempotencyKey(options.idempotencyKey);
  return runInTransaction(db, async (tx) => {
    const now = nowFrom(options.clock);
    const expiresAt = now + duration;
    if (!Number.isSafeInteger(expiresAt)) throw new ResourceLeaseError("invalid_input", "lease expiry exceeds unix-ms range");
    const identity = retryIdentity({ ...options, workspaceId, actor }, "resource.renew", {
      resourceKey, principalId: options.principalId ?? null, leaseId, fence, expectedRevision, leaseMs: duration,
    }, now);
    const replay = await replayOperation(tx, identity, now);
    if (replay) return replay;
    await requireSpace(tx, workspaceId);
    const principal = await resolvePrincipal(tx, workspaceId, actor, options.principalId, now);
    const current = await liveLease(tx, workspaceId, resourceKey);
    if (!current) {
      const latest = await latestLease(tx, workspaceId, resourceKey);
      throw new ResourceLeaseError(latest ? "released" : "not_found", `No live lease for ${resourceKey}`, latest ? view(latest, now) : null);
    }
    assertOwned(current, principal.id, leaseId, fence, now);
    const rows = await tx.update(resourceLease).set({
      heartbeatAt: now,
      expiresAt,
      revision: sql`${resourceLease.revision} + 1`,
      updatedAt: now,
    }).where(and(
      eq(resourceLease.id, current.id),
      eq(resourceLease.revision, expectedRevision),
      isNull(resourceLease.releasedAt),
    )).returning();
    if (!rows[0]) throw new ResourceLeaseError("stale_fence", `Stale revision for ${resourceKey}`, view(current, now));
    const lease = parseLease(rows[0]);
    const event = await appendResourceEvent(tx, lease, actor, principal.id, "resource_lease_renewed", {
      fence: lease.fence, previousRevision: expectedRevision, expiresAt,
    }, now);
    await saveOperation(tx, identity, "renewed", lease, event.sequence);
    return {
      contractVersion: "tasq.resource-operation.v1",
      disposition: "renewed",
      observedAt: now,
      lease,
      eventCursor: { afterSequence: event.sequence },
    };
  });
}

export async function releaseResourceLease(
  db: TasqDb,
  resourceKeyInput: string,
  options: ReleaseResourceLeaseOptions,
): Promise<ResourceLeaseOperation> {
  const { workspaceId, actor } = validateScope(options);
  const resourceKey = ResourceKey.parse(resourceKeyInput);
  const leaseId = options.leaseId;
  const fence = safePositive(options.fence, "fence");
  const expectedRevision = safePositive(options.expectedRevision, "expectedRevision");
  const reason = options.reason ?? "released";
  if (!reason.trim() || reason.length > 1_000) throw new ResourceLeaseError("invalid_input", "reason must contain 1..1000 characters");
  requireIdempotencyKey(options.idempotencyKey);
  return runInTransaction(db, async (tx) => {
    const now = nowFrom(options.clock);
    const identity = retryIdentity({ ...options, workspaceId, actor }, "resource.release", {
      resourceKey, principalId: options.principalId ?? null, leaseId, fence, expectedRevision, reason,
    }, now);
    const replay = await replayOperation(tx, identity, now);
    if (replay) return replay;
    await requireSpace(tx, workspaceId);
    const principal = await resolvePrincipal(tx, workspaceId, actor, options.principalId, now);
    const current = await liveLease(tx, workspaceId, resourceKey);
    if (!current) {
      const latest = await latestLease(tx, workspaceId, resourceKey);
      throw new ResourceLeaseError(latest ? "released" : "not_found", `No live lease for ${resourceKey}`, latest ? view(latest, now) : null);
    }
    assertClockNotBefore(current, now);
    if (current.expiresAt <= now) {
      if (current.id !== leaseId || current.fence !== fence) {
        throw new ResourceLeaseError("stale_fence", `Stale lease or fence for ${resourceKey}`, view(current, now));
      }
      if (current.holderPrincipalId !== principal.id) {
        throw new ResourceLeaseError("not_holder", `Resource ${resourceKey} is held by ${current.holderActor}`, view(current, now));
      }
      const expired = await expireLease(tx, current, actor, principal.id, now, expectedRevision);
      await saveOperation(tx, identity, "expired", expired.lease, expired.event.sequence);
      return {
        contractVersion: "tasq.resource-operation.v1",
        disposition: "expired",
        observedAt: now,
        lease: expired.lease,
        eventCursor: { afterSequence: expired.event.sequence },
      };
    }
    assertOwned(current, principal.id, leaseId, fence, now);
    const rows = await tx.update(resourceLease).set({
      releasedAt: now,
      releaseReason: reason,
      revision: sql`${resourceLease.revision} + 1`,
      updatedAt: now,
    }).where(and(
      eq(resourceLease.id, current.id),
      eq(resourceLease.revision, expectedRevision),
      isNull(resourceLease.releasedAt),
    )).returning();
    if (!rows[0]) throw new ResourceLeaseError("stale_fence", `Stale revision for ${resourceKey}`, view(current, now));
    const lease = parseLease(rows[0]);
    const event = await appendResourceEvent(tx, lease, actor, principal.id, "resource_lease_released", {
      fence: lease.fence, reason,
    }, now);
    await saveOperation(tx, identity, "released", lease, event.sequence);
    return {
      contractVersion: "tasq.resource-operation.v1",
      disposition: "released",
      observedAt: now,
      lease,
      eventCursor: { afterSequence: event.sequence },
    };
  });
}

export async function verifyResourceFence(
  db: TasqDb,
  resourceKeyInput: string,
  options: VerifyResourceFenceOptions,
): Promise<ResourceFenceVerification> {
  const { workspaceId, actor } = validateScope(options);
  const resourceKey = ResourceKey.parse(resourceKeyInput);
  const fence = safePositive(options.fence, "fence");
  await requireSpace(db, workspaceId);
  const principal = await resolveExistingPrincipal(db, workspaceId, actor, options.principalId);
  const current = await liveLease(db, workspaceId, resourceKey);
  const now = nowFrom(options.clock);
  if (!current) {
    const latest = await latestLease(db, workspaceId, resourceKey);
    throw new ResourceLeaseError(latest ? "released" : "not_found", `No live lease for ${resourceKey}`, latest ? view(latest, now) : null);
  }
  assertOwned(current, principal.id, options.leaseId, fence, now);
  return {
    contractVersion: "tasq.resource-fence.v1",
    status: "valid",
    workspaceId,
    resourceKey,
    leaseId: current.id,
    fence: current.fence,
    holderPrincipalId: current.holderPrincipalId,
    verifiedAt: now,
    expiresAt: current.expiresAt,
  };
}

export async function getResourceLeaseView(
  db: TasqDb,
  resourceKeyInput: string,
  options: ResourceContext,
): Promise<ResourceLeaseView | null> {
  const { workspaceId } = validateScope(options);
  const resourceKey = ResourceKey.parse(resourceKeyInput);
  await requireSpace(db, workspaceId);
  const lease = await latestLease(db, workspaceId, resourceKey);
  if (!lease) return null;
  const now = nowFrom(options.clock);
  assertClockNotBefore(lease, now);
  return view(lease, now);
}

export async function listResourceWorld(
  db: TasqDb,
  options: ListResourceWorldOptions,
): Promise<ResourceWorld> {
  const { workspaceId } = validateScope(options);
  const limit = boundedLimit(options.limit);
  await requireSpace(db, workspaceId);
  const filters = [eq(resourceLease.workspaceId, workspaceId)];
  if (options.holderPrincipalId) filters.push(eq(resourceLease.holderPrincipalId, options.holderPrincipalId));
  const rows = await db.select().from(resourceLease).where(and(...filters))
    .orderBy(asc(resourceLease.resourceKey), desc(resourceLease.fence));
  const now = nowFrom(options.clock);
  const seen = new Set<string>();
  const leases: ResourceLeaseView[] = [];
  for (const row of rows) {
    if (seen.has(row.resourceKey)) continue;
    seen.add(row.resourceKey);
    const lease = parseLease(row);
    assertClockNotBefore(lease, now);
    const item = view(lease, now);
    if (options.activeOnly && item.status !== "active") continue;
    leases.push(item);
    if (leases.length >= limit) break;
  }
  const cursorRows = await db.select({ cursor: sql<number>`coalesce(max(${resourceEvent.sequence}), 0)` })
    .from(resourceEvent).where(eq(resourceEvent.workspaceId, workspaceId));
  return {
    contractVersion: "tasq.resource-world.v1",
    workspaceId,
    observedAt: now,
    leases,
    eventCursor: { afterSequence: Number(cursorRows[0]?.cursor ?? 0) },
  };
}

export async function listResourceEvents(
  db: TasqDb,
  options: ListResourceEventsOptions,
): Promise<ResourceEventPage> {
  const { workspaceId } = validateScope(options);
  const afterSequence = options.afterSequence ?? 0;
  if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
    throw new ResourceLeaseError("invalid_input", "afterSequence must be a non-negative integer");
  }
  const limit = boundedLimit(options.limit);
  await requireSpace(db, workspaceId);
  const filters = [
    eq(resourceEvent.workspaceId, workspaceId),
    sql`${resourceEvent.sequence} > ${afterSequence}`,
  ];
  if (options.resourceKey !== undefined) filters.push(eq(resourceEvent.resourceKey, ResourceKey.parse(options.resourceKey)));
  const rows = await db.select().from(resourceEvent).where(and(...filters))
    .orderBy(asc(resourceEvent.sequence)).limit(limit);
  const events = rows.map(parseEvent);
  return {
    contractVersion: "tasq.resource-events.v1",
    workspaceId,
    events,
    nextCursor: { afterSequence: events.at(-1)?.sequence ?? afterSequence },
  };
}

export async function sweepExpiredResources(
  db: TasqDb,
  options: SweepExpiredResourcesOptions,
): Promise<ResourceSweep> {
  const { workspaceId, actor } = validateScope(options);
  const limit = boundedLimit(options.limit);
  return runInTransaction(db, async (tx) => {
    const now = nowFrom(options.clock);
    await requireSpace(tx, workspaceId);
    const principal = await resolvePrincipal(tx, workspaceId, actor, options.principalId, now);
    const rows = await tx.select().from(resourceLease).where(and(
      eq(resourceLease.workspaceId, workspaceId),
      isNull(resourceLease.releasedAt),
      lte(resourceLease.expiresAt, now),
    )).orderBy(asc(resourceLease.expiresAt), asc(resourceLease.resourceKey)).limit(limit);
    const expired: ResourceLease[] = [];
    let cursor = 0;
    for (const row of rows) {
      const result = await expireLease(tx, parseLease(row), actor, principal.id, now);
      expired.push(result.lease);
      cursor = result.event.sequence;
    }
    if (cursor === 0) {
      const cursorRows = await tx.select({ cursor: sql<number>`coalesce(max(${resourceEvent.sequence}), 0)` })
        .from(resourceEvent).where(eq(resourceEvent.workspaceId, workspaceId));
      cursor = Number(cursorRows[0]?.cursor ?? 0);
    }
    return {
      contractVersion: "tasq.resource-sweep.v1",
      workspaceId,
      observedAt: now,
      expired,
      eventCursor: { afterSequence: cursor },
    };
  });
}

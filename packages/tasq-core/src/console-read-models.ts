/** Bounded, redacted operator projections shared by every Console transport. */

import { Buffer } from "node:buffer";
import { and, desc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import {
  CONSOLE_HEALTH_CONTRACT_VERSION,
  CONSOLE_OVERVIEW_CONTRACT_VERSION,
  CONSOLE_PAGE_CONTRACT_VERSION,
  ConsoleHealth as ConsoleHealthSchema,
  ConsoleOverview as ConsoleOverviewSchema,
  ConsolePage as ConsolePageSchema,
  ConsoleSection,
  coordinationSpace,
  deliveryOutbox,
  effect,
  event,
  principal,
  replicationConflict,
  replicationOutgoing,
  resourceEvent,
  resourceLease,
  task,
  taskClaim,
  waitCondition,
  type Clock,
  type ConsoleHealth,
  type ConsoleOperationalCounts,
  type ConsoleOverview,
  type ConsolePage,
  type ConsoleSection as ConsoleSectionT,
} from "@tasq/schema";
import type { TasqDb, TasqDbOrTx } from "./db.js";
import { serviceNow } from "./util/clock.js";

const UNRESOLVED_EFFECTS = ["proposed", "authorized", "executing", "indeterminate"] as const;

export interface ConsoleReadOptions {
  workspaceId: string;
  clock?: Clock;
  now?: number;
}

export interface ConsolePageOptions extends ConsoleReadOptions {
  section: ConsoleSectionT;
  limit?: number;
  cursor?: string | null;
}

interface KeysetCursor {
  v: 1;
  workspaceId: string;
  section: ConsoleSectionT;
  sort: number;
  id: string;
}

function scope(options: ConsoleReadOptions): { workspaceId: string; inspectedAt: number } {
  const workspaceId = options.workspaceId.trim();
  if (!workspaceId) throw new Error("console workspaceId must not be blank");
  if (options.clock === undefined && options.now === undefined) {
    throw new Error("console reads require an injected clock or explicit now");
  }
  return { workspaceId, inspectedAt: serviceNow(options, options.now) };
}

function boundedLimit(value: number | undefined): number {
  const limit = value ?? 50;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("console limit must be between 1 and 100");
  }
  return limit;
}

function encodeCursor(cursor: KeysetCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(
  value: string | null | undefined,
  workspaceId: string,
  section: ConsoleSectionT,
): KeysetCursor | null {
  if (!value) return null;
  if (value.length > 2048) throw new Error("console cursor is too long");
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    throw new Error("console cursor is invalid");
  }
  const cursor = decoded as Partial<KeysetCursor>;
  if (cursor.v !== 1 || cursor.workspaceId !== workspaceId || cursor.section !== section ||
      !Number.isSafeInteger(cursor.sort) || Number(cursor.sort) < 0 ||
      typeof cursor.id !== "string" || cursor.id.length < 1 || cursor.id.length > 2000) {
    throw new Error("console cursor does not match this workspace and section");
  }
  return cursor as KeysetCursor;
}

function descendingCursor(column: unknown, idColumn: unknown, cursor: KeysetCursor | null) {
  if (!cursor) return undefined;
  return or(
    lt(column as never, cursor.sort),
    and(eq(column as never, cursor.sort), lt(idColumn as never, cursor.id)),
  );
}

function makePage(
  section: ConsoleSectionT,
  workspaceId: string,
  inspectedAt: number,
  limit: number,
  rows: Array<Record<string, unknown>>,
  cursorFor: (row: Record<string, unknown>) => { sort: number; id: string },
): ConsolePage {
  const hasMore = rows.length > limit;
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  const next = hasMore && last ? cursorFor(last) : null;
  return ConsolePageSchema.parse({
    contractVersion: CONSOLE_PAGE_CONTRACT_VERSION,
    section,
    workspaceId,
    inspectedAt,
    requestedLimit: limit,
    returned: items.length,
    hasMore,
    nextCursor: next ? encodeCursor({ v: 1, workspaceId, section, ...next }) : null,
    items,
  });
}

/**
 * Return one stable keyset page. Pages intentionally contain no metadata,
 * effect request body, event payload or provider body; record detail remains
 * available through canonical, explicitly scoped inspection contracts.
 */
export async function buildConsolePage(db: TasqDb, options: ConsolePageOptions): Promise<ConsolePage> {
  const section = ConsoleSection.parse(options.section);
  const { workspaceId, inspectedAt } = scope(options);
  const limit = boundedLimit(options.limit);
  const cursor = decodeCursor(options.cursor, workspaceId, section);

  if (section === "work") {
    const after = descendingCursor(task.createdAt, task.id, cursor);
    const rows = await db.select({
      id: task.id, title: task.title, status: task.status, revision: task.revision,
      priority: task.priority, dueAt: task.dueAt, createdAt: task.createdAt, updatedAt: task.updatedAt,
    }).from(task).where(and(
      eq(task.tenantId, workspaceId), isNull(task.deletedAt),
      sql`${task.status} not in ('done', 'cancelled')`, after,
    )).orderBy(desc(task.createdAt), desc(task.id)).limit(limit + 1);
    return makePage(section, workspaceId, inspectedAt, limit, rows,
      (row) => ({ sort: Number(row.createdAt), id: String(row.id) }));
  }

  if (section === "actors") {
    const after = descendingCursor(principal.createdAt, principal.id, cursor);
    const rows = await db.select({
      id: principal.id, kind: principal.kind, displayName: principal.displayName,
      localAlias: principal.localAlias, status: principal.status,
      revision: principal.revision, createdAt: principal.createdAt, updatedAt: principal.updatedAt,
    }).from(principal).where(and(eq(principal.tenantId, workspaceId), after))
      .orderBy(desc(principal.createdAt), desc(principal.id)).limit(limit + 1);
    return makePage(section, workspaceId, inspectedAt, limit, rows,
      (row) => ({ sort: Number(row.createdAt), id: String(row.id) }));
  }

  if (section === "claims") {
    const after = descendingCursor(taskClaim.acquiredAt, taskClaim.id, cursor);
    const rows = await db.select({
      id: taskClaim.id, commitmentId: taskClaim.taskId, commitmentTitle: task.title,
      actor: taskClaim.actor, principalId: taskClaim.principalId, revision: taskClaim.revision,
      fence: taskClaim.fence, acquiredAt: taskClaim.acquiredAt,
      heartbeatAt: taskClaim.heartbeatAt, expiresAt: taskClaim.expiresAt,
    }).from(taskClaim).innerJoin(task, and(
      eq(task.id, taskClaim.taskId), eq(task.tenantId, workspaceId),
    )).where(and(eq(taskClaim.tenantId, workspaceId), isNull(taskClaim.releasedAt), after))
      .orderBy(desc(taskClaim.acquiredAt), desc(taskClaim.id)).limit(limit + 1);
    const projected = rows.map((row) => ({
      ...row,
      temporalStatus: row.expiresAt > inspectedAt ? "active" as const : "expired" as const,
    }));
    return makePage(section, workspaceId, inspectedAt, limit, projected,
      (row) => ({ sort: Number(row.acquiredAt), id: String(row.id) }));
  }

  if (section === "resources") {
    const after = descendingCursor(resourceLease.acquiredAt, resourceLease.id, cursor);
    const rows = await db.select({
      id: resourceLease.id, resourceKey: resourceLease.resourceKey,
      holderActor: resourceLease.holderActor, holderPrincipalId: resourceLease.holderPrincipalId,
      revision: resourceLease.revision, fence: resourceLease.fence,
      acquiredAt: resourceLease.acquiredAt, heartbeatAt: resourceLease.heartbeatAt,
      expiresAt: resourceLease.expiresAt,
    }).from(resourceLease).where(and(
      eq(resourceLease.workspaceId, workspaceId), isNull(resourceLease.releasedAt), after,
    )).orderBy(desc(resourceLease.acquiredAt), desc(resourceLease.id)).limit(limit + 1);
    const projected = rows.map((row) => ({
      ...row,
      temporalStatus: row.expiresAt > inspectedAt ? "active" as const : "expired" as const,
    }));
    return makePage(section, workspaceId, inspectedAt, limit, projected,
      (row) => ({ sort: Number(row.acquiredAt), id: String(row.id) }));
  }

  if (section === "waits") {
    const after = descendingCursor(waitCondition.createdAt, waitCondition.id, cursor);
    const rows = await db.select({
      id: waitCondition.id, commitmentId: waitCondition.taskId, commitmentTitle: task.title,
      kind: waitCondition.kind, status: waitCondition.status, notBefore: waitCondition.notBefore,
      deadlineAt: waitCondition.deadlineAt, createdAt: waitCondition.createdAt,
      updatedAt: waitCondition.updatedAt,
    }).from(waitCondition).innerJoin(task, and(
      eq(task.id, waitCondition.taskId), eq(task.tenantId, workspaceId),
    )).where(and(
      eq(waitCondition.tenantId, workspaceId), eq(waitCondition.status, "waiting"), after,
    )).orderBy(desc(waitCondition.createdAt), desc(waitCondition.id)).limit(limit + 1);
    const projected = rows.map((row) => ({
      ...row,
      overdue: row.deadlineAt !== null && row.deadlineAt <= inspectedAt,
    }));
    return makePage(section, workspaceId, inspectedAt, limit, projected,
      (row) => ({ sort: Number(row.createdAt), id: String(row.id) }));
  }

  if (section === "effects") {
    const after = descendingCursor(effect.createdAt, effect.id, cursor);
    const rows = await db.select({
      id: effect.id, commitmentId: effect.taskId, commitmentTitle: task.title,
      status: effect.status, effectTypeUri: effect.effectTypeUri,
      requestDigest: effect.requestDigest, revision: effect.revision,
      createdByPrincipalId: effect.createdByPrincipalId, createdAt: effect.createdAt,
      updatedAt: effect.updatedAt,
    }).from(effect).innerJoin(task, and(
      eq(task.id, effect.taskId), eq(task.tenantId, workspaceId),
    )).where(and(
      eq(effect.tenantId, workspaceId), inArray(effect.status, [...UNRESOLVED_EFFECTS]), after,
    )).orderBy(desc(effect.createdAt), desc(effect.id)).limit(limit + 1);
    return makePage(section, workspaceId, inspectedAt, limit, rows,
      (row) => ({ sort: Number(row.createdAt), id: String(row.id) }));
  }

  const after = cursor ? lt(event.sequence, cursor.sort) : undefined;
  const rows = await db.select({
    sequence: event.sequence, id: event.id, actor: event.actor, principalId: event.principalId,
    entityType: event.entityType, entityId: event.entityId, eventType: event.eventType,
    occurredAt: event.occurredAt, createdAt: event.createdAt,
  }).from(event).where(and(eq(event.tenantId, workspaceId), after))
    .orderBy(desc(event.sequence)).limit(limit + 1);
  const projected = rows.map((row) => ({
    ...row,
    payload: { omitted: true as const, reason: "operator_index_redaction" as const },
  }));
  return makePage(section, workspaceId, inspectedAt, limit, projected,
    (row) => ({ sort: Number(row.sequence), id: String(row.id) }));
}

function countMap(rows: Array<{ status: string; count: number }>): Record<string, number> {
  return Object.fromEntries(rows.map((row) => [row.status, Number(row.count)]));
}

async function operationalCounts(
  db: TasqDbOrTx,
  workspaceId: string,
  inspectedAt: number,
): Promise<ConsoleOperationalCounts> {
  const [
    commitmentRows, actorRows, claimRows, resourceRows, waitRows,
    effectRows, deliveryRows, pendingOutgoingRows, conflictRows,
  ] = await Promise.all([
    db.select({ status: task.status, count: sql<number>`count(*)` }).from(task)
      .where(and(eq(task.tenantId, workspaceId), isNull(task.deletedAt))).groupBy(task.status),
    db.select({ status: principal.status, count: sql<number>`count(*)` }).from(principal)
      .where(eq(principal.tenantId, workspaceId)).groupBy(principal.status),
    db.select({
      active: sql<number>`coalesce(sum(case when ${taskClaim.expiresAt} > ${inspectedAt} then 1 else 0 end), 0)`,
      expired: sql<number>`coalesce(sum(case when ${taskClaim.expiresAt} <= ${inspectedAt} then 1 else 0 end), 0)`,
    }).from(taskClaim).where(and(eq(taskClaim.tenantId, workspaceId), isNull(taskClaim.releasedAt))),
    db.select({
      active: sql<number>`coalesce(sum(case when ${resourceLease.expiresAt} > ${inspectedAt} then 1 else 0 end), 0)`,
      expired: sql<number>`coalesce(sum(case when ${resourceLease.expiresAt} <= ${inspectedAt} then 1 else 0 end), 0)`,
    }).from(resourceLease).where(and(eq(resourceLease.workspaceId, workspaceId), isNull(resourceLease.releasedAt))),
    db.select({
      waiting: sql<number>`count(*)`,
      overdue: sql<number>`coalesce(sum(case when ${waitCondition.deadlineAt} is not null and ${waitCondition.deadlineAt} <= ${inspectedAt} then 1 else 0 end), 0)`,
    }).from(waitCondition).where(and(eq(waitCondition.tenantId, workspaceId), eq(waitCondition.status, "waiting"))),
    db.select({ status: effect.status, count: sql<number>`count(*)` }).from(effect)
      .where(eq(effect.tenantId, workspaceId)).groupBy(effect.status),
    db.select({ status: deliveryOutbox.status, count: sql<number>`count(*)` }).from(deliveryOutbox)
      .where(eq(deliveryOutbox.tenantId, workspaceId)).groupBy(deliveryOutbox.status),
    db.select({ count: sql<number>`count(*)` }).from(replicationOutgoing)
      .where(and(eq(replicationOutgoing.workspaceId, workspaceId), eq(replicationOutgoing.status, "pending"))),
    db.select({ count: sql<number>`count(*)` }).from(replicationConflict)
      .where(and(eq(replicationConflict.workspaceId, workspaceId), isNull(replicationConflict.resolvedByOperationDigest))),
  ]);
  const actors = countMap(actorRows);
  const deliveries = countMap(deliveryRows);
  return {
    commitments: countMap(commitmentRows),
    actors: { enabled: actors.enabled ?? 0, disabled: actors.disabled ?? 0 },
    claims: { active: Number(claimRows[0]?.active ?? 0), expiredHeld: Number(claimRows[0]?.expired ?? 0) },
    resources: { active: Number(resourceRows[0]?.active ?? 0), expiredHeld: Number(resourceRows[0]?.expired ?? 0) },
    waits: { waiting: Number(waitRows[0]?.waiting ?? 0), overdue: Number(waitRows[0]?.overdue ?? 0) },
    effects: countMap(effectRows),
    delivery: {
      pending: deliveries.pending ?? 0,
      delivering: deliveries.delivering ?? 0,
      delivered: deliveries.delivered ?? 0,
      quarantined: deliveries.quarantined ?? 0,
    },
    replication: {
      pendingOutgoing: Number(pendingOutgoingRows[0]?.count ?? 0),
      unresolvedConflicts: Number(conflictRows[0]?.count ?? 0),
    },
  };
}

function attention(counts: ConsoleOperationalCounts, workspaceExists = true): ConsoleOverview["attention"] {
  const result: ConsoleOverview["attention"] = [];
  if (!workspaceExists) result.push("workspace_missing");
  if (counts.actors.disabled > 0) result.push("disabled_actors");
  if (counts.claims.expiredHeld > 0) result.push("expired_claims");
  if (counts.resources.expiredHeld > 0) result.push("expired_resources");
  if (counts.waits.overdue > 0) result.push("overdue_waits");
  if ((counts.effects.indeterminate ?? 0) > 0) result.push("indeterminate_effects");
  if (counts.delivery.quarantined > 0) result.push("quarantined_delivery");
  if (counts.replication.unresolvedConflicts > 0) result.push("replication_conflicts");
  return result;
}

export async function buildConsoleOverview(
  db: TasqDb,
  options: ConsoleReadOptions,
): Promise<ConsoleOverview> {
  const { workspaceId, inspectedAt } = scope(options);
  const [counts, spaceRows] = await Promise.all([
    operationalCounts(db, workspaceId, inspectedAt),
    db.select({ workspaceId: coordinationSpace.workspaceId }).from(coordinationSpace)
      .where(eq(coordinationSpace.workspaceId, workspaceId)).limit(1),
  ]);
  const workspaceExists = spaceRows.length === 1;
  const pages = Object.fromEntries(ConsoleSection.options.map((section) => [section, `/api/console/${section}`]));
  return ConsoleOverviewSchema.parse({
    contractVersion: CONSOLE_OVERVIEW_CONTRACT_VERSION,
    workspaceId,
    inspectedAt,
    counts,
    attention: attention(counts, workspaceExists),
    workspaceExists,
    pages,
    canonicalCommitmentDetailTemplate: "/api/commitments/{commitmentId}",
  });
}

export async function buildConsoleHealth(
  db: TasqDb,
  options: ConsoleReadOptions,
): Promise<ConsoleHealth> {
  const { workspaceId, inspectedAt } = scope(options);
  const [counts, spaceRows, eventRows, resourceRows] = await Promise.all([
    operationalCounts(db, workspaceId, inspectedAt),
    db.select({ workspaceId: coordinationSpace.workspaceId }).from(coordinationSpace)
      .where(eq(coordinationSpace.workspaceId, workspaceId)).limit(1),
    db.select({ cursor: sql<number>`coalesce(max(${event.sequence}), 0)` }).from(event)
      .where(eq(event.tenantId, workspaceId)),
    db.select({ cursor: sql<number>`coalesce(max(${resourceEvent.sequence}), 0)` }).from(resourceEvent)
      .where(eq(resourceEvent.workspaceId, workspaceId)),
  ]);
  const workspaceExists = spaceRows.length === 1;
  const signals = attention(counts, workspaceExists);
  return ConsoleHealthSchema.parse({
    contractVersion: CONSOLE_HEALTH_CONTRACT_VERSION,
    workspaceId,
    inspectedAt,
    assessment: signals.length === 0 ? "nominal_signals" : "attention",
    scope: "bounded_operational_signals",
    fullIntegrity: {
      checked: false,
      reason: "full_doctor_is_explicit_and_not_request_bounded",
      argv: ["tasq", "doctor", "--tenant", workspaceId],
    },
    workspaceExists,
    counts,
    cursors: {
      eventSequence: Number(eventRows[0]?.cursor ?? 0),
      resourceEventSequence: Number(resourceRows[0]?.cursor ?? 0),
    },
    attention: signals,
  });
}


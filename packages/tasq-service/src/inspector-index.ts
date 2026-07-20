/** Bounded profile-neutral index for the local read-only inspector. */

import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import {
  INSPECTOR_INDEX_CONTRACT_VERSION,
  InspectorIndex as InspectorIndexSchema,
  effect,
  effectApproval,
  effectReceipt,
  task,
  waitCondition,
  type Clock,
  type InspectorIndex,
  type TaskStatus,
} from "@tasq/schema";
import type { TasqDb } from "./db.js";
import { serviceNow } from "./util/clock.js";

export interface BuildInspectorIndexOptions {
  workspaceId: string;
  status?: TaskStatus | null;
  query?: string | null;
  limit?: number;
  clock?: Clock;
  now?: number;
}

const UNRESOLVED_EFFECT_STATUSES = new Set([
  "proposed", "authorized", "executing", "indeterminate",
]);

function boundedLimit(value: number | undefined): number {
  const limit = value ?? 50;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("inspector limit must be between 1 and 100");
  }
  return limit;
}

function normalizedQuery(value: string | null | undefined): string | null {
  if (value == null) return null;
  const query = value.trim();
  if (query.length === 0) return null;
  if (query.length > 200) throw new Error("inspector query must be at most 200 characters");
  return query;
}

function literalLikePattern(value: string): string {
  return `%${value.toLocaleLowerCase("en-US")
    .split("\\").join("\\\\")
    .split("%").join("\\%")
    .split("_").join("\\_")}%`;
}

function increment(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

/**
 * Read one bounded index in a constant number of queries. Detail remains the
 * canonical tasq.inspect.v1 graph and is never copied into this envelope.
 */
export async function buildInspectorIndex(
  db: TasqDb,
  options: BuildInspectorIndexOptions,
): Promise<InspectorIndex> {
  const workspaceId = options.workspaceId.trim();
  if (!workspaceId) throw new Error("workspaceId must not be blank");
  if (options.now === undefined && options.clock === undefined) {
    throw new Error("inspector index requires an injected clock or explicit now");
  }
  const limit = boundedLimit(options.limit);
  const query = normalizedQuery(options.query);
  const inspectedAt = serviceNow(options, options.now);

  const filters = [
    eq(task.tenantId, workspaceId),
    sql`${task.deletedAt} IS NULL`,
  ];
  if (options.status) filters.push(eq(task.status, options.status));
  if (query) {
    filters.push(sql`lower(${task.title}) LIKE ${literalLikePattern(query)} ESCAPE ${"\\"}`);
  }

  const where = and(...filters);
  const [matchedRows, commitmentRows] = await Promise.all([
    db.select({ count: sql<number>`count(*)` }).from(task).where(where),
    db.select({
      id: task.id,
      title: task.title,
      status: task.status,
      revision: task.revision,
      priority: task.priority,
      dueAt: task.dueAt,
      updatedAt: task.updatedAt,
    }).from(task).where(where).orderBy(desc(task.updatedAt), asc(task.id)).limit(limit),
  ]);
  const matched = Number(matchedRows[0]?.count ?? 0);
  const taskIds = commitmentRows.map((row) => row.id);
  if (taskIds.length === 0) {
    return InspectorIndexSchema.parse({
      contractVersion: INSPECTOR_INDEX_CONTRACT_VERSION,
      inspectedAt,
      workspaceId,
      filter: { status: options.status ?? null, query, limit },
      matched,
      truncated: matched > 0,
      items: [],
    });
  }

  const [waitRows, effectRows] = await Promise.all([
    db.select({ taskId: waitCondition.taskId, status: waitCondition.status })
      .from(waitCondition).where(and(
        eq(waitCondition.tenantId, workspaceId),
        inArray(waitCondition.taskId, taskIds),
      )),
    db.select({ id: effect.id, taskId: effect.taskId, status: effect.status })
      .from(effect).where(and(
        eq(effect.tenantId, workspaceId),
        inArray(effect.taskId, taskIds),
      )),
  ]);
  const effectIds = effectRows.map((row) => row.id);
  const [approvalRows, receiptRows] = effectIds.length === 0
    ? [[], []] as const
    : await Promise.all([
      db.select({ effectId: effectApproval.effectId }).from(effectApproval).where(and(
        eq(effectApproval.tenantId, workspaceId), inArray(effectApproval.effectId, effectIds),
      )),
      db.select({ effectId: effectReceipt.effectId }).from(effectReceipt).where(and(
        eq(effectReceipt.tenantId, workspaceId), inArray(effectReceipt.effectId, effectIds),
      )),
    ]);

  const waits = new Map<string, number>();
  const waiting = new Map<string, number>();
  for (const row of waitRows) {
    increment(waits, row.taskId);
    if (row.status === "waiting") increment(waiting, row.taskId);
  }
  const effects = new Map<string, number>();
  const unresolvedEffects = new Map<string, number>();
  const taskByEffect = new Map(effectRows.map((row) => [row.id, row.taskId]));
  for (const row of effectRows) {
    increment(effects, row.taskId);
    if (UNRESOLVED_EFFECT_STATUSES.has(row.status)) increment(unresolvedEffects, row.taskId);
  }
  const authorityDecisions = new Map<string, number>();
  for (const row of approvalRows) {
    const taskId = taskByEffect.get(row.effectId);
    if (taskId) increment(authorityDecisions, taskId);
  }
  const receipts = new Map<string, number>();
  for (const row of receiptRows) {
    const taskId = taskByEffect.get(row.effectId);
    if (taskId) increment(receipts, taskId);
  }

  const items = commitmentRows.map((row) => ({
    commitmentId: row.id,
    title: row.title,
    status: row.status,
    revision: row.revision,
    priority: row.priority,
    dueAt: row.dueAt,
    updatedAt: row.updatedAt,
    signals: {
      waits: waits.get(row.id) ?? 0,
      waiting: waiting.get(row.id) ?? 0,
      effects: effects.get(row.id) ?? 0,
      unresolvedEffects: unresolvedEffects.get(row.id) ?? 0,
      authorityDecisions: authorityDecisions.get(row.id) ?? 0,
      receipts: receipts.get(row.id) ?? 0,
    },
  }));
  return InspectorIndexSchema.parse({
    contractVersion: INSPECTOR_INDEX_CONTRACT_VERSION,
    inspectedAt,
    workspaceId,
    filter: { status: options.status ?? null, query, limit },
    matched,
    truncated: matched > items.length,
    items,
  });
}

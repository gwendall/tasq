/** Universal durable mutation identity, replay lookup and bounded retention. */

import { and, asc, eq, lte } from "drizzle-orm";
import {
  IdempotencyRecord as IdempotencyRecordZ,
  idempotencyKey,
  type Clock,
  type IdempotencyRecord,
  type IdempotencyRetentionClass,
} from "@tasq/schema";
import type { TasqDb, TasqDbOrTx } from "../db.js";
import { runOperationalTransaction } from "../db.js";
import { canonicalJson, sha256Digest } from "../util/canonical-json.js";
import { serviceNow } from "../util/clock.js";

export const IDEMPOTENCY_REQUEST_DIGEST_VERSION = "tasq.jcs.sha256.v1" as const;
export const LEGACY_IDEMPOTENCY_DIGEST_VERSION = "tasq.legacy.sha256.v0" as const;
export const DEFAULT_IDEMPOTENCY_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
export const MAX_IDEMPOTENCY_RETENTION_MS = 365 * 24 * 60 * 60 * 1_000;

export interface IdempotencyContext {
  tenantId?: string;
  actor?: string;
  principalId?: string;
  idempotencyKey?: string;
}

export interface PrepareIdempotencyOptions {
  now: number;
  retentionClass?: IdempotencyRetentionClass;
  retentionMs?: number;
  /** Exact pre-TQ-403 digest input, used only to preserve upgrade replays. */
  legacyRequest?: unknown;
}

export interface PreparedIdempotency {
  tenantId: string;
  callerScope: string;
  operation: string;
  key: string;
  requestDigest: string;
  legacyRequestDigest: string | null;
  retentionClass: IdempotencyRetentionClass;
  expiresAt: number | null;
  createdAt: number;
}

export interface IdempotencyOutcome {
  resultType: string;
  resultId: string;
  resultStatus?: string | null;
  resultRevision?: number | null;
  eventSequence?: number | null;
}

function safeTime(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative unix-ms integer`);
  }
  return value;
}

function bounded(value: string, label: string, max: number): string {
  if (!value.trim() || value.length > max) {
    throw new Error(`${label} must contain 1..${max} characters`);
  }
  return value;
}

export function idempotencyCallerScope(context: IdempotencyContext): string {
  if (context.principalId !== undefined) {
    return `principal:${bounded(context.principalId, "principalId", 980)}`;
  }
  return `actor:${bounded(context.actor ?? "system", "actor", 500)}`;
}

/**
 * Build the identity before opening the mutation transaction. Recording time
 * and generated IDs are deliberately absent from the request digest.
 */
export function prepareIdempotency(
  context: IdempotencyContext,
  operation: string,
  request: unknown,
  options: PrepareIdempotencyOptions,
): PreparedIdempotency | null {
  const key = context.idempotencyKey;
  if (key === undefined) return null;
  bounded(key, "idempotencyKey", 500);
  bounded(operation, "idempotency operation", 200);
  const tenantId = bounded(context.tenantId ?? "gwendall", "idempotency workspace", 500);
  const now = safeTime(options.now, "idempotency now");
  const retentionClass = options.retentionClass ?? "standard";
  let expiresAt: number | null = null;
  if (retentionClass === "standard") {
    const retentionMs = options.retentionMs ?? DEFAULT_IDEMPOTENCY_RETENTION_MS;
    if (!Number.isSafeInteger(retentionMs) || retentionMs <= 0 ||
      retentionMs > MAX_IDEMPOTENCY_RETENTION_MS) {
      throw new Error(
        `idempotency retentionMs must be an integer between 1 and ${MAX_IDEMPOTENCY_RETENTION_MS}`,
      );
    }
    expiresAt = now + retentionMs;
    if (!Number.isSafeInteger(expiresAt)) throw new Error("idempotency expiry exceeds unix-ms range");
  }
  const canonical = canonicalJson({
    contract: "tasq.idempotency-request.v1",
    operation,
    request,
  });
  return {
    tenantId,
    callerScope: idempotencyCallerScope(context),
    operation,
    key,
    requestDigest: sha256Digest(canonical),
    legacyRequestDigest: options.legacyRequest === undefined
      ? null
      : sha256Digest(canonicalJson(options.legacyRequest)),
    retentionClass,
    expiresAt,
    createdAt: now,
  };
}

function parseRecord(row: typeof idempotencyKey.$inferSelect): IdempotencyRecord {
  return IdempotencyRecordZ.parse(row);
}

/**
 * Resolve an exact replay. A legacy workspace-global row is honored for safe
 * upgrade compatibility. Expired standard identities are removed only when
 * the same caller explicitly reuses that exact tuple.
 */
export async function findIdempotencyResult(
  tx: TasqDbOrTx,
  prepared: PreparedIdempotency | null,
): Promise<IdempotencyRecord | null> {
  if (!prepared) return null;
  const exactRows = await tx.select().from(idempotencyKey).where(and(
    eq(idempotencyKey.tenantId, prepared.tenantId),
    eq(idempotencyKey.callerScope, prepared.callerScope),
    eq(idempotencyKey.operation, prepared.operation),
    eq(idempotencyKey.key, prepared.key),
  )).limit(1);
  let row: typeof idempotencyKey.$inferSelect | undefined = exactRows[0];
  if (row?.retentionClass === "standard" && row.expiresAt !== null &&
    row.expiresAt <= prepared.createdAt) {
    await tx.delete(idempotencyKey).where(and(
      eq(idempotencyKey.tenantId, prepared.tenantId),
      eq(idempotencyKey.callerScope, prepared.callerScope),
      eq(idempotencyKey.operation, prepared.operation),
      eq(idempotencyKey.key, prepared.key),
      eq(idempotencyKey.expiresAt, row.expiresAt),
    ));
    row = undefined;
  }
  if (!row) {
    const legacyRows = await tx.select().from(idempotencyKey).where(and(
      eq(idempotencyKey.tenantId, prepared.tenantId),
      eq(idempotencyKey.callerScope, "workspace:legacy"),
      eq(idempotencyKey.operation, prepared.operation),
      eq(idempotencyKey.key, prepared.key),
    )).limit(1);
    row = legacyRows[0];
  }
  if (!row) return null;
  const expected = row.digestVersion === LEGACY_IDEMPOTENCY_DIGEST_VERSION
    ? prepared.legacyRequestDigest
    : prepared.requestDigest;
  if (!expected || row.requestDigest !== expected) {
    throw new Error(
      `Idempotency identity already used with a different request: ` +
      `${prepared.callerScope}/${prepared.operation}/${prepared.key}`,
    );
  }
  return parseRecord(row);
}

export async function saveIdempotencyResult(
  tx: TasqDbOrTx,
  prepared: PreparedIdempotency | null,
  outcome: IdempotencyOutcome,
): Promise<void> {
  if (!prepared) return;
  bounded(outcome.resultType, "idempotency resultType", 200);
  bounded(outcome.resultId, "idempotency resultId", 2_000);
  if (outcome.resultStatus != null) bounded(outcome.resultStatus, "idempotency resultStatus", 200);
  if (outcome.resultRevision != null &&
    (!Number.isSafeInteger(outcome.resultRevision) || outcome.resultRevision <= 0)) {
    throw new Error("idempotency resultRevision must be a positive integer");
  }
  if (outcome.eventSequence != null &&
    (!Number.isSafeInteger(outcome.eventSequence) || outcome.eventSequence <= 0)) {
    throw new Error("idempotency eventSequence must be a positive integer");
  }
  await tx.insert(idempotencyKey).values({
    tenantId: prepared.tenantId,
    callerScope: prepared.callerScope,
    operation: prepared.operation,
    key: prepared.key,
    digestVersion: IDEMPOTENCY_REQUEST_DIGEST_VERSION,
    requestDigest: prepared.requestDigest,
    resultType: outcome.resultType,
    resultId: outcome.resultId,
    resultStatus: outcome.resultStatus ?? null,
    resultRevision: outcome.resultRevision ?? null,
    eventSequence: outcome.eventSequence ?? null,
    retentionClass: prepared.retentionClass,
    expiresAt: prepared.expiresAt,
    createdAt: prepared.createdAt,
  });
}

export interface ListIdempotencyOptions {
  tenantId?: string;
  callerScope?: string;
  operation?: string;
  key?: string;
  retentionClass?: IdempotencyRetentionClass;
  limit?: number;
}

export async function listIdempotencyRecords(
  db: TasqDb,
  options: ListIdempotencyOptions = {},
): Promise<IdempotencyRecord[]> {
  const filters = [eq(idempotencyKey.tenantId, options.tenantId ?? "gwendall")];
  if (options.callerScope) filters.push(eq(idempotencyKey.callerScope, options.callerScope));
  if (options.operation) filters.push(eq(idempotencyKey.operation, options.operation));
  if (options.key) filters.push(eq(idempotencyKey.key, options.key));
  if (options.retentionClass) {
    filters.push(eq(idempotencyKey.retentionClass, options.retentionClass));
  }
  const limit = options.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 10_000) {
    throw new Error("idempotency list limit must be between 1 and 10000");
  }
  const rows = await db.select().from(idempotencyKey).where(and(...filters))
    .orderBy(asc(idempotencyKey.createdAt), asc(idempotencyKey.key)).limit(limit);
  return rows.map(parseRecord);
}

export interface PruneIdempotencyOptions {
  tenantId?: string;
  clock?: Clock;
  now?: number;
  limit?: number;
}

/** Explicit retention operation; ordinary reads never use ambient time or GC. */
export async function pruneExpiredIdempotency(
  db: TasqDb,
  options: PruneIdempotencyOptions = {},
): Promise<{ pruned: number; through: number }> {
  const tenantId = options.tenantId ?? "gwendall";
  const now = safeTime(serviceNow(options, options.now), "idempotency prune now");
  const limit = options.limit ?? 1_000;
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 10_000) {
    throw new Error("idempotency prune limit must be between 1 and 10000");
  }
  return runOperationalTransaction(db, async (tx) => {
    const expired = await tx.select({
      callerScope: idempotencyKey.callerScope,
      operation: idempotencyKey.operation,
      key: idempotencyKey.key,
    }).from(idempotencyKey).where(and(
      eq(idempotencyKey.tenantId, tenantId),
      eq(idempotencyKey.retentionClass, "standard"),
      lte(idempotencyKey.expiresAt, now),
    )).orderBy(asc(idempotencyKey.expiresAt)).limit(limit);
    for (const row of expired) {
      await tx.delete(idempotencyKey).where(and(
        eq(idempotencyKey.tenantId, tenantId),
        eq(idempotencyKey.callerScope, row.callerScope),
        eq(idempotencyKey.operation, row.operation),
        eq(idempotencyKey.key, row.key),
        eq(idempotencyKey.retentionClass, "standard"),
      ));
    }
    return { pruned: expired.length, through: now };
  });
}

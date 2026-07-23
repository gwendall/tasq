/** Lossless, bounded change-feed reads for the local operator Console. */

import { Buffer } from "node:buffer";
import { and, asc, eq, gt, sql } from "drizzle-orm";
import {
  CONSOLE_EVENT_BATCH_CONTRACT_VERSION,
  CONSOLE_LIVE_PROBLEM_CONTRACT_VERSION,
  ConsoleEventBatch as ConsoleEventBatchSchema,
  ConsoleLiveProblem as ConsoleLiveProblemSchema,
  event,
  type Clock,
  type ConsoleEventBatch,
  type ConsoleLiveProblem,
} from "@tasq-run/schema";
import type { TasqDb } from "./db.js";
import { buildConsoleOverview } from "./console-read-models.js";
import { serviceNow } from "./util/clock.js";

interface LiveCursor {
  v: 1;
  workspaceId: string;
  sequence: number;
}

export interface ConsoleEventBatchOptions {
  workspaceId: string;
  clock?: Clock;
  now?: number;
  cursor?: string | null;
  limit?: number;
}

export class ConsoleLiveCursorError extends Error {
  readonly problem: ConsoleLiveProblem;

  constructor(problem: ConsoleLiveProblem) {
    super(problem.message);
    this.name = "ConsoleLiveCursorError";
    this.problem = problem;
  }
}

function boundedLimit(value: number | undefined): number {
  const limit = value ?? 50;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("console live limit must be between 1 and 100");
  }
  return limit;
}

function encodeCursor(cursor: LiveCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(value: string, workspaceId: string): LiveCursor {
  if (value.length > 2048) throw new Error("console live cursor is too long");
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    throw new Error("console live cursor is invalid");
  }
  const cursor = decoded as Partial<LiveCursor>;
  if (cursor.v !== 1 || cursor.workspaceId !== workspaceId ||
      !Number.isSafeInteger(cursor.sequence) || Number(cursor.sequence) < 0) {
    throw new Error("console live cursor does not match this workspace");
  }
  return cursor as LiveCursor;
}

function cursorProblem(
  code: ConsoleLiveProblem["code"],
  workspaceId: string,
  inspectedAt: number,
): ConsoleLiveCursorError {
  const message = code === "cursor_expired"
    ? "The retained event log no longer contains this Console cursor. Refresh the canonical snapshot."
    : "The Console cursor is ahead of the canonical event log. Refresh the canonical snapshot.";
  return new ConsoleLiveCursorError(ConsoleLiveProblemSchema.parse({
    contractVersion: CONSOLE_LIVE_PROBLEM_CONTRACT_VERSION,
    code,
    workspaceId,
    inspectedAt,
    message,
    recovery: { action: "refresh_snapshot", href: "/api/console/events" },
  }));
}

/**
 * With no cursor, capture a canonical overview and the event high-water mark.
 * With a cursor, return events strictly after it in durable SQLite order.
 * Event payloads are always omitted: the feed invalidates canonical views but
 * never becomes a competing client-side state machine.
 */
export async function buildConsoleEventBatch(
  db: TasqDb,
  options: ConsoleEventBatchOptions,
): Promise<ConsoleEventBatch> {
  const workspaceId = options.workspaceId.trim();
  if (!workspaceId) throw new Error("console live workspaceId must not be blank");
  if (options.clock === undefined && options.now === undefined) {
    throw new Error("console live reads require an injected clock or explicit now");
  }
  const inspectedAt = serviceNow(options, options.now);
  const limit = boundedLimit(options.limit);
  const cursorValue = options.cursor ?? null;

  if (cursorValue === null || cursorValue === "") {
    // Capture the cursor before the overview. A concurrent mutation may then
    // be reflected both in the snapshot and the next invalidation, but can
    // never be missed between them.
    const highWaterRows = await db.select({
      sequence: sql<number>`coalesce(max(${event.sequence}), 0)`,
    }).from(event).where(eq(event.tenantId, workspaceId));
    const sequence = Number(highWaterRows[0]?.sequence ?? 0);
    const snapshot = await buildConsoleOverview(db, { workspaceId, now: inspectedAt });
    return ConsoleEventBatchSchema.parse({
      contractVersion: CONSOLE_EVENT_BATCH_CONTRACT_VERSION,
      workspaceId,
      inspectedAt,
      mode: "snapshot",
      requestedLimit: limit,
      returned: 0,
      hasMore: false,
      nextCursor: encodeCursor({ v: 1, workspaceId, sequence }),
      events: [],
      snapshot,
    });
  }

  const cursor = decodeCursor(cursorValue, workspaceId);
  const boundRows = await db.select({
    minimum: sql<number>`coalesce(min(${event.sequence}), 0)`,
    maximum: sql<number>`coalesce(max(${event.sequence}), 0)`,
  }).from(event).where(eq(event.tenantId, workspaceId));
  const minimum = Number(boundRows[0]?.minimum ?? 0);
  const maximum = Number(boundRows[0]?.maximum ?? 0);
  if (cursor.sequence > maximum) throw cursorProblem("cursor_ahead", workspaceId, inspectedAt);
  if (cursor.sequence > 0 && minimum > cursor.sequence) {
    throw cursorProblem("cursor_expired", workspaceId, inspectedAt);
  }

  const rows = await db.select({
    sequence: event.sequence,
    id: event.id,
    actor: event.actor,
    principalId: event.principalId,
    entityType: event.entityType,
    entityId: event.entityId,
    eventType: event.eventType,
    occurredAt: event.occurredAt,
    createdAt: event.createdAt,
  }).from(event).where(and(
    eq(event.tenantId, workspaceId),
    gt(event.sequence, cursor.sequence),
  )).orderBy(asc(event.sequence)).limit(limit + 1);

  const hasMore = rows.length > limit;
  const events = rows.slice(0, limit).map((row) => ({
    ...row,
    payload: { omitted: true as const, reason: "operator_stream_redaction" as const },
  }));
  const nextSequence = events.at(-1)?.sequence ?? cursor.sequence;
  return ConsoleEventBatchSchema.parse({
    contractVersion: CONSOLE_EVENT_BATCH_CONTRACT_VERSION,
    workspaceId,
    inspectedAt,
    mode: "changes",
    requestedLimit: limit,
    returned: events.length,
    hasMore,
    nextCursor: encodeCursor({ v: 1, workspaceId, sequence: nextSequence }),
    events,
    snapshot: null,
  });
}

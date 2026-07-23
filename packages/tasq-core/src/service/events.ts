/**
 * Event log — append-only, immutable. Internal to the service layer.
 *
 * Planning, coordination and reconciliation mutations emit one or more
 * task-scoped events. Immutable observation ingestion deliberately emits none
 * until reconciliation establishes a task relationship. Callers do not write
 * event rows directly; service functions call `recordEvent` internally.
 *
 * Reads (querying the audit log) are exposed publicly.
 */

import { and, asc, desc, eq, gt, lt } from "drizzle-orm";
import {
  event,
  uuidv7,
  EventInsert,
  Event as EventZ,
  type Event as EventT,
  type EntityType,
  type Clock,
} from "@tasq-run/schema";
import type { TasqDb, TasqDbOrTx } from "../db.js";
import { serviceNow } from "../util/clock.js";
import { ensureLocalPrincipal, getPrincipal } from "./principals.js";

/**
 * Optional listener invoked after every successful `recordEvent` DB insert.
 * The CLI runtime wires this up to an external append-only JSONL journal
 * (`~/.tasq/events.jsonl` by default) so the audit trail survives any
 * accidental DB loss. The journal is not replay-complete event sourcing;
 * verified SQLite snapshots remain the recovery mechanism.
 *
 * Listener errors are caught + logged to stderr ; they never block the
 * mutation. The DB is the source of truth; the journal is forensic parity
 * evidence and not a replay-complete backup.
 */
type EventListener = (e: EventT) => void;

let eventListener: EventListener | null = null;

export function setEventListener(listener: EventListener | null): void {
  eventListener = listener;
}

/**
 * Fire the external-journal listener for a single event, swallowing any
 * listener error (the DB is the source of truth; the journal is a mirror,
 * so a journal write must never propagate as a mutation failure).
 *
 * Service mutations call this AFTER the surrounding `db.transaction(...)`
 * has committed (see `recordEvent`'s `defer` option) so we never journal a
 * row that subsequently rolls back. Recording the row + the event commit or
 * roll back together inside the tx ; the journal mirrors only what landed.
 */
export function emitAfterCommit(e: EventT): void {
  if (!eventListener) return;
  try {
    eventListener(e);
  } catch (err) {
    // Journal failure must never prevent the mutation from being durable
    // in the DB. Log + continue.
    process.stderr.write(
      `tasq: event-journal listener threw — ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }
}

export interface RecordEventOptions {
  /**
   * When true, the listener is NOT fired inline — the event row is inserted
   * (typically against a `tx`) and the parsed event is returned so the
   * caller can `emitAfterCommit(event)` once the transaction commits. This
   * keeps the external journal in sync with what actually durably landed in
   * the DB even when the insert happens inside a not-yet-committed tx.
   */
  defer?: boolean;
  /** Explicit creation snapshot wins over the injected clock. */
  now?: number;
  clock?: Clock;
}

/**
 * Record a task-scoped audit event. Event-emitting service mutations pass the
 * surrounding `tx` so the event commits/rolls back atomically with the row
 * write. Returns the inserted event (parsed through Zod for safety).
 *
 * Accepts either the top-level db handle or a transaction handle
 * (`TasqDbOrTx`) ; the body only uses `.insert(event)`, which both expose.
 *
 * By default the external-journal listener fires inline (preserves the
 * behavior for direct callers recording ad-hoc events). Service mutations
 * pass `{ defer: true }` and call `emitAfterCommit` after the tx resolves.
 */
export async function recordEvent(
  db: TasqDbOrTx,
  input: unknown,
  options: RecordEventOptions = {},
): Promise<EventT> {
  const parsed = EventInsert.parse(input);
  const now = serviceNow(options, options.now);
  const id = parsed.id ?? uuidv7(now);
  const attribution = parsed.principalId
    ? await getPrincipal(db, parsed.principalId, parsed.tenantId)
    : await ensureLocalPrincipal(db, parsed.tenantId, parsed.actor, now);
  if (!attribution) {
    throw new Error(`Principal not found in workspace: ${parsed.principalId}`);
  }
  if (attribution.status !== "enabled") {
    throw new Error(`Principal is disabled: ${attribution.id}`);
  }

  const rows = await db.insert(event).values({
    id,
    tenantId: parsed.tenantId,
    actor: parsed.actor,
    principalId: attribution.id,
    entityType: parsed.entityType,
    entityId: parsed.entityId,
    eventType: parsed.eventType,
    payload: JSON.stringify(parsed.payload),
    occurredAt: parsed.occurredAt,
    createdAt: now,
  }).returning();

  const inserted = rows[0];
  if (!inserted) throw new Error(`Failed to read back event ${id}`);
  const e = EventZ.parse({ ...inserted, payload: parsed.payload });

  if (!options.defer) emitAfterCommit(e);

  return e;
}

export interface ListEventsOptions {
  tenantId?: string;
  entityType?: EntityType;
  entityId?: string;
  actor?: string;
  /** Filter to events created strictly after this unix-ms timestamp. */
  sinceMs?: number;
  /** Filter to events created strictly before this unix-ms timestamp. */
  beforeMs?: number;
  /** Stable cursor: events with a sequence strictly greater than this value. */
  afterSequence?: number;
  /** Stable reverse cursor: events with a sequence strictly below this value. */
  beforeSequence?: number;
  limit?: number;
  /** Ascending by createdAt if true ; descending (newest first) by default. */
  ascending?: boolean;
}

export async function listEvents(
  db: TasqDb,
  options: ListEventsOptions = {},
): Promise<EventT[]> {
  const filters = [eq(event.tenantId, options.tenantId ?? "gwendall")];

  if (options.entityType) filters.push(eq(event.entityType, options.entityType));
  if (options.entityId) filters.push(eq(event.entityId, options.entityId));
  if (options.actor) filters.push(eq(event.actor, options.actor));
  if (options.sinceMs != null) filters.push(gt(event.createdAt, options.sinceMs));
  if (options.beforeMs != null) filters.push(lt(event.createdAt, options.beforeMs));
  if (options.afterSequence != null) filters.push(gt(event.sequence, options.afterSequence));
  if (options.beforeSequence != null) filters.push(lt(event.sequence, options.beforeSequence));

  const orderFn = options.ascending ? asc : desc;

  const rows = await db
    .select()
    .from(event)
    .where(and(...filters))
    .orderBy(orderFn(event.sequence))
    .limit(options.limit ?? 100);

  return rows.map((r) =>
    EventZ.parse({
      ...r,
      payload: typeof r.payload === "string" ? JSON.parse(r.payload) : r.payload,
    }),
  );
}

export async function getEvent(
  db: TasqDb,
  id: string,
  tenantId = "gwendall",
): Promise<EventT | null> {
  const rows = await db
    .select()
    .from(event)
    .where(and(eq(event.id, id), eq(event.tenantId, tenantId)))
    .limit(1);

  const row = rows[0];
  if (!row) return null;

  return EventZ.parse({
    ...row,
    payload: typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload,
  });
}

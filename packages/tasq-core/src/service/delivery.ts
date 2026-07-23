/**
 * Durable delivery registry and outbox reads.
 *
 * Sinks are local operational state, never replicated domain state. The
 * `delivery_outbox_after_event_insert` SQLite trigger owns enqueueing so an
 * event and all of its enabled-sink delivery intents commit or roll back as
 * one write, even when an event is recorded through a low-level service call.
 */

import { and, asc, desc, eq, ne, sql } from "drizzle-orm";
import {
  deliveryOutbox,
  deliverySink,
  event,
  DeliveryOutbox as DeliveryOutboxZ,
  DeliverySink as DeliverySinkZ,
  Event as EventZ,
  type Clock,
  type DeliveryOutbox as DeliveryOutboxT,
  type DeliveryOutboxStatus,
  type DeliverySink as DeliverySinkT,
  type Event as EventT,
} from "@tasq-run/schema";
import type { TasqDb, TasqDbOrTx } from "../db.js";
import { runOperationalTransaction } from "../db.js";
import { serviceNow } from "../util/clock.js";

export interface DeliveryClockOptions {
  tenantId?: string;
  now?: number;
  clock?: Clock;
}

export interface EnsureDeliverySinkInput {
  id: string;
  kind: string;
  configurationDigest: string;
}

function validateInput(input: EnsureDeliverySinkInput): void {
  if (!input.id.trim() || input.id.length > 500) {
    throw new Error("delivery sink id must contain 1..500 characters");
  }
  if (!input.kind.trim() || input.kind.length > 500) {
    throw new Error("delivery sink kind must contain 1..500 characters");
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(input.configurationDigest)) {
    throw new Error("delivery sink configurationDigest must be sha256:<64 lowercase hex>");
  }
}

function parseSink(row: typeof deliverySink.$inferSelect): DeliverySinkT {
  return DeliverySinkZ.parse(row);
}

function assertSameBinding(
  row: typeof deliverySink.$inferSelect,
  input: EnsureDeliverySinkInput,
): void {
  if (row.kind !== input.kind || row.configurationDigest !== input.configurationDigest) {
    throw new Error(
      `Delivery sink ${input.id} is already bound to a different kind or configuration`,
    );
  }
}

async function findSink(
  db: TasqDbOrTx,
  id: string,
  tenantId: string,
): Promise<typeof deliverySink.$inferSelect | null> {
  const rows = await db.select().from(deliverySink).where(and(
    eq(deliverySink.tenantId, tenantId),
    eq(deliverySink.id, id),
  )).limit(1);
  return rows[0] ?? null;
}

/**
 * Register or re-enable one stable sink. First registration starts strictly
 * after the current event cursor: an upgrade never replays historical events
 * into an already-existing external journal.
 *
 * Reusing an id with another configuration fails closed. TQ-402 adds the
 * explicit repair/rebind workflow; silent retargeting would make pending
 * deliveries ambiguous.
 */
export async function ensureDeliverySink(
  db: TasqDb,
  input: EnsureDeliverySinkInput,
  options: DeliveryClockOptions = {},
): Promise<DeliverySinkT> {
  validateInput(input);
  const tenantId = options.tenantId ?? "gwendall";
  const current = await findSink(db, input.id, tenantId);
  if (current) {
    assertSameBinding(current, input);
    if (current.status === "enabled") return parseSink(current);
  }

  const now = serviceNow(options, options.now);
  return runOperationalTransaction(db, async (tx) => {
    const inside = await findSink(tx, input.id, tenantId);
    if (inside) {
      assertSameBinding(inside, input);
      if (inside.status === "enabled") return parseSink(inside);
      const rows = await tx.update(deliverySink).set({
        status: "enabled",
        updatedAt: now,
      }).where(and(
        eq(deliverySink.tenantId, tenantId),
        eq(deliverySink.id, input.id),
      )).returning();
      return parseSink(rows[0]!);
    }

    const latest = await tx.select({ sequence: event.sequence }).from(event)
      .where(eq(event.tenantId, tenantId))
      .orderBy(desc(event.sequence))
      .limit(1);
    const startAfterSequence = latest[0]?.sequence ?? 0;
    const rows = await tx.insert(deliverySink).values({
      id: input.id,
      tenantId,
      kind: input.kind,
      configurationDigest: input.configurationDigest,
      status: "enabled",
      startAfterSequence,
      createdAt: now,
      updatedAt: now,
    }).returning();
    return parseSink(rows[0]!);
  });
}

/** Disable future enqueueing without deleting the sink or its pending queue. */
export async function disableDeliverySink(
  db: TasqDb,
  id: string,
  options: DeliveryClockOptions = {},
): Promise<DeliverySinkT | null> {
  const tenantId = options.tenantId ?? "gwendall";
  const current = await findSink(db, id, tenantId);
  if (!current) return null;
  if (current.status === "disabled") return parseSink(current);
  const now = serviceNow(options, options.now);
  return runOperationalTransaction(db, async (tx) => {
    const rows = await tx.update(deliverySink).set({
      status: "disabled",
      updatedAt: now,
    }).where(and(
      eq(deliverySink.tenantId, tenantId),
      eq(deliverySink.id, id),
    )).returning();
    return rows[0] ? parseSink(rows[0]) : null;
  });
}

export async function getDeliverySink(
  db: TasqDb,
  id: string,
  tenantId = "gwendall",
): Promise<DeliverySinkT | null> {
  const row = await findSink(db, id, tenantId);
  return row ? parseSink(row) : null;
}

export interface ListDeliveryOutboxOptions {
  tenantId?: string;
  sinkId?: string;
  status?: DeliveryOutboxStatus;
  ascending?: boolean;
  limit?: number;
}

export async function listDeliveryOutbox(
  db: TasqDb,
  options: ListDeliveryOutboxOptions = {},
): Promise<DeliveryOutboxT[]> {
  const filters = [eq(deliveryOutbox.tenantId, options.tenantId ?? "gwendall")];
  if (options.sinkId) filters.push(eq(deliveryOutbox.sinkId, options.sinkId));
  if (options.status) filters.push(eq(deliveryOutbox.status, options.status));
  const order = options.ascending ? asc : desc;
  const rows = await db.select().from(deliveryOutbox)
    .where(and(...filters))
    .orderBy(order(deliveryOutbox.eventSequence))
    .limit(options.limit ?? 100);
  return rows.map((row) => DeliveryOutboxZ.parse(row));
}

export interface LeaseNextDeliveryOptions extends DeliveryClockOptions {
  leaseOwner: string;
  leaseMs: number;
}

export interface LeasedDelivery {
  delivery: DeliveryOutboxT;
  event: EventT;
}

function validateLeaseOwner(owner: string): void {
  if (!owner.trim() || owner.length > 500) {
    throw new Error("delivery leaseOwner must contain 1..500 characters");
  }
}

function validateLease(owner: string, leaseMs: number): void {
  validateLeaseOwner(owner);
  if (!Number.isSafeInteger(leaseMs) || leaseMs <= 0) {
    throw new Error("delivery leaseMs must be a positive safe integer");
  }
}

async function findDeliveryHead(
  db: TasqDbOrTx,
  tenantId: string,
  sinkId: string,
): Promise<typeof deliveryOutbox.$inferSelect | null> {
  const rows = await db.select().from(deliveryOutbox).where(and(
    eq(deliveryOutbox.tenantId, tenantId),
    eq(deliveryOutbox.sinkId, sinkId),
    ne(deliveryOutbox.status, "delivered"),
  )).orderBy(asc(deliveryOutbox.eventSequence)).limit(1);
  return rows[0] ?? null;
}

function isLeaseableHead(
  head: typeof deliveryOutbox.$inferSelect | null,
  now: number,
): head is typeof deliveryOutbox.$inferSelect {
  if (!head || head.status === "quarantined") return false;
  if (head.status === "pending") return head.availableAt <= now;
  return (head.leaseExpiresAt ?? 0) <= now;
}

/**
 * Lease the oldest non-delivered record for one sink.
 *
 * Strict head-of-line ordering is intentional: an active lease, backoff or
 * quarantine on sequence N blocks N+1. A journal can therefore never look
 * healthy while silently skipping a poison record. Expired leases are
 * reclaimed atomically and count as a new attempt.
 */
export async function leaseNextDelivery(
  db: TasqDb,
  sinkId: string,
  options: LeaseNextDeliveryOptions,
): Promise<LeasedDelivery | null> {
  validateLease(options.leaseOwner, options.leaseMs);
  const tenantId = options.tenantId ?? "gwendall";
  const now = serviceNow(options, options.now);
  const leaseExpiresAt = now + options.leaseMs;
  if (!Number.isSafeInteger(leaseExpiresAt)) {
    throw new Error("delivery lease expiry exceeds safe unix-ms range");
  }

  // Avoid opening a write transaction on the overwhelmingly common empty or
  // blocked queue. This keeps read-only CLI commands from incrementing the
  // committed-mutation guard merely because their startup drain found no work.
  if (!isLeaseableHead(await findDeliveryHead(db, tenantId, sinkId), now)) return null;

  return runOperationalTransaction(db, async (tx) => {
    const head = await findDeliveryHead(tx, tenantId, sinkId);
    if (!isLeaseableHead(head, now)) return null;

    const rows = await tx.update(deliveryOutbox).set({
      status: "delivering",
      attemptCount: sql`${deliveryOutbox.attemptCount} + 1`,
      leaseOwner: options.leaseOwner,
      leaseExpiresAt,
      lastError: null,
      deliveredAt: null,
      quarantinedAt: null,
      updatedAt: now,
    }).where(and(
      eq(deliveryOutbox.tenantId, tenantId),
      eq(deliveryOutbox.id, head.id),
    )).returning();
    const leased = DeliveryOutboxZ.parse(rows[0]);
    const eventRows = await tx.select().from(event).where(and(
      eq(event.tenantId, tenantId),
      eq(event.sequence, leased.eventSequence),
    )).limit(1);
    const source = eventRows[0];
    if (!source || source.id !== leased.eventId) {
      throw new Error(`Delivery ${leased.id} points at a missing or mismatched event`);
    }
    return {
      delivery: leased,
      event: EventZ.parse({
        ...source,
        payload: typeof source.payload === "string" ? JSON.parse(source.payload) : source.payload,
      }),
    };
  });
}

export interface OwnedDeliveryOptions extends DeliveryClockOptions {
  leaseOwner: string;
}

/** Mark an externally delivered record terminal using its exact lease owner. */
export async function completeDelivery(
  db: TasqDb,
  id: string,
  options: OwnedDeliveryOptions,
): Promise<DeliveryOutboxT> {
  validateLeaseOwner(options.leaseOwner);
  const tenantId = options.tenantId ?? "gwendall";
  const now = serviceNow(options, options.now);
  return runOperationalTransaction(db, async (tx) => {
    const rows = await tx.update(deliveryOutbox).set({
      status: "delivered",
      leaseOwner: null,
      leaseExpiresAt: null,
      lastError: null,
      deliveredAt: now,
      quarantinedAt: null,
      updatedAt: now,
    }).where(and(
      eq(deliveryOutbox.tenantId, tenantId),
      eq(deliveryOutbox.id, id),
      eq(deliveryOutbox.status, "delivering"),
      eq(deliveryOutbox.leaseOwner, options.leaseOwner),
    )).returning();
    if (!rows[0]) throw new Error(`Delivery lease is no longer owned: ${id}`);
    return DeliveryOutboxZ.parse(rows[0]);
  });
}

export interface FailDeliveryOptions extends OwnedDeliveryOptions {
  error: string;
  maxAttempts?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
}

/** Release a failed lease into deterministic backoff or terminal quarantine. */
export async function failDelivery(
  db: TasqDb,
  id: string,
  options: FailDeliveryOptions,
): Promise<DeliveryOutboxT> {
  validateLeaseOwner(options.leaseOwner);
  const tenantId = options.tenantId ?? "gwendall";
  const now = serviceNow(options, options.now);
  const maxAttempts = options.maxAttempts ?? 5;
  const baseBackoffMs = options.baseBackoffMs ?? 1_000;
  const maxBackoffMs = options.maxBackoffMs ?? 300_000;
  for (const [label, value] of [
    ["maxAttempts", maxAttempts],
    ["baseBackoffMs", baseBackoffMs],
    ["maxBackoffMs", maxBackoffMs],
  ] as const) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`delivery ${label} must be a positive safe integer`);
    }
  }
  const error = options.error.trim().slice(0, 4_000) || "delivery failed without detail";

  return runOperationalTransaction(db, async (tx) => {
    const currentRows = await tx.select().from(deliveryOutbox).where(and(
      eq(deliveryOutbox.tenantId, tenantId),
      eq(deliveryOutbox.id, id),
      eq(deliveryOutbox.status, "delivering"),
      eq(deliveryOutbox.leaseOwner, options.leaseOwner),
    )).limit(1);
    const current = currentRows[0];
    if (!current) throw new Error(`Delivery lease is no longer owned: ${id}`);
    const quarantined = current.attemptCount >= maxAttempts;
    const delay = Math.min(
      maxBackoffMs,
      baseBackoffMs * 2 ** Math.max(0, current.attemptCount - 1),
    );
    const availableAt = now + delay;
    if (!Number.isSafeInteger(availableAt)) {
      throw new Error("delivery backoff exceeds safe unix-ms range");
    }
    const rows = await tx.update(deliveryOutbox).set({
      status: quarantined ? "quarantined" : "pending",
      availableAt: quarantined ? current.availableAt : availableAt,
      leaseOwner: null,
      leaseExpiresAt: null,
      lastError: error,
      deliveredAt: null,
      quarantinedAt: quarantined ? now : null,
      updatedAt: now,
    }).where(and(
      eq(deliveryOutbox.tenantId, tenantId),
      eq(deliveryOutbox.id, id),
      eq(deliveryOutbox.status, "delivering"),
      eq(deliveryOutbox.leaseOwner, options.leaseOwner),
    )).returning();
    if (!rows[0]) throw new Error(`Delivery lease changed while failing: ${id}`);
    return DeliveryOutboxZ.parse(rows[0]);
  });
}

export type DeliveryRepairAction = "retry" | "mark_delivered" | "redeliver";

/**
 * Explicit operator repair. The caller must first compare the authoritative
 * event with its external sink; Tasq never guesses whether an external effect
 * happened across a crash boundary.
 */
export async function repairDelivery(
  db: TasqDb,
  id: string,
  action: DeliveryRepairAction,
  options: DeliveryClockOptions = {},
): Promise<DeliveryOutboxT> {
  if (!(action === "retry" || action === "mark_delivered" || action === "redeliver")) {
    throw new Error(`Unknown delivery repair action: ${String(action)}`);
  }
  const tenantId = options.tenantId ?? "gwendall";
  const now = serviceNow(options, options.now);
  return runOperationalTransaction(db, async (tx) => {
    const currentRows = await tx.select().from(deliveryOutbox).where(and(
      eq(deliveryOutbox.tenantId, tenantId),
      eq(deliveryOutbox.id, id),
    )).limit(1);
    const current = currentRows[0];
    if (!current) throw new Error(`Delivery not found: ${id}`);
    if (action === "mark_delivered" && current.status === "delivered") {
      return DeliveryOutboxZ.parse(current);
    }
    if (action === "redeliver" && current.status !== "delivered") {
      throw new Error(`Only a delivered record can be redelivered: ${id}`);
    }
    if (action === "retry" && current.status === "delivered") {
      throw new Error(`A delivered record requires redeliver, not retry: ${id}`);
    }
    const delivered = action === "mark_delivered";
    const rows = await tx.update(deliveryOutbox).set({
      status: delivered ? "delivered" : "pending",
      attemptCount: delivered ? current.attemptCount : 0,
      availableAt: delivered ? current.availableAt : now,
      leaseOwner: null,
      leaseExpiresAt: null,
      lastError: null,
      deliveredAt: delivered ? now : null,
      quarantinedAt: null,
      updatedAt: now,
    }).where(and(
      eq(deliveryOutbox.tenantId, tenantId),
      eq(deliveryOutbox.id, id),
    )).returning();
    return DeliveryOutboxZ.parse(rows[0]);
  });
}

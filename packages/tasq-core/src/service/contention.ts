/**
 * What the ledger refused.
 *
 * Until this existed the ledger kept a complete account of everything it
 * ALLOWED and no trace of anything it PREVENTED - thirty-one event types, and
 * not one of them a refusal. The refusal is the product: `tasq demo` exists to
 * show three of them, and nobody could answer "how many collisions did this
 * stop for me last week."
 *
 * Two design constraints, both load-bearing.
 *
 * A refusal is NOT a mutation. It bumps no revision, changes no claim, and
 * emits no event: everything downstream of the event journal - the projection,
 * the outbox, replication - describes work that happened, and a refusal is
 * work that did not. So this is a separate table, written outside the
 * transaction that threw.
 *
 * A refusal is HIGH FREQUENCY. A polling agent turned away four hundred times
 * is one situation, not four hundred rows. The primary key is the shape of the
 * standoff and repeated attempts advance a counter, which bounds the table by
 * distinct situations rather than by attempts.
 */

import { and, desc, eq, gte, sql } from "drizzle-orm";
import { Contention, contention, type ContentionKind } from "@tasq-run/schema";
import type { TasqDb, TasqDbOrTx } from "../db.js";

/** The facts a refusal carries. Everything here is known at the throw site. */
export interface ContentionFacts {
  tenantId: string;
  commitmentId: string;
  kind: ContentionKind;
  requestedByPrincipalId: string;
  requestedByLabel: string;
  /** Empty when the refusal is not about a holder at all. */
  holderPrincipalId: string;
  holderLabel: string;
}

/**
 * A refusal that is worth counting.
 *
 * Typed so the boundary can record it without parsing a message. The message
 * stays the operator-facing text; this carries the facts.
 */
export class ContentionError extends Error {
  readonly facts: ContentionFacts;
  constructor(message: string, facts: ContentionFacts) {
    super(message);
    this.name = "ContentionError";
    this.facts = facts;
  }
}

/**
 * Record one standoff.
 *
 * Best effort by construction: the caller has already decided to refuse, and a
 * bookkeeping failure must never turn a refusal into a different error. The
 * operator sees the refusal either way; only the count is at stake.
 */
export async function recordContention(
  db: TasqDb,
  facts: ContentionFacts,
  now: number,
): Promise<void> {
  try {
    await db.insert(contention).values({
      tenantId: facts.tenantId,
      commitmentId: facts.commitmentId,
      kind: facts.kind,
      requestedByPrincipalId: facts.requestedByPrincipalId,
      requestedByLabel: facts.requestedByLabel,
      holderPrincipalId: facts.holderPrincipalId,
      holderLabel: facts.holderLabel,
      firstAt: now,
      lastAt: now,
      attempts: 1,
    }).onConflictDoUpdate({
      target: [
        contention.tenantId, contention.commitmentId, contention.kind,
        contention.requestedByPrincipalId, contention.holderPrincipalId,
      ],
      set: { lastAt: now, attempts: sql`${contention.attempts} + 1` },
    });
  } catch (error) {
    // Swallowed so a bookkeeping failure cannot turn a refusal into a
    // different error - but SAID, because the first version of this hid a
    // constraint violation that made every no-holder refusal vanish, and a
    // silent catch is how that survived being probed by hand.
    process.stderr.write(
      `tasq: contention not recorded (${facts.kind}): `
      + `${error instanceof Error ? error.message : String(error)}\n`,
    );
  }
}

/**
 * Run `work`, and count the refusal if it is one.
 *
 * The recording happens OUTSIDE the transaction that threw, which is the whole
 * reason this wrapper exists: the rollback that carries the refusal would
 * carry the record of it away too, and the one thing a refusal must leave
 * behind is the evidence that it happened.
 */
export async function withContentionRecorded<T>(
  db: TasqDb,
  now: number,
  work: () => Promise<T>,
): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof ContentionError) await recordContention(db, error.facts, now);
    throw error;
  }
}

/** Everything refused since `since`, most recent standoff first. */
export async function listContention(
  db: TasqDbOrTx,
  tenantId: string,
  since = 0,
): Promise<Contention[]> {
  const rows = await db.select().from(contention)
    .where(and(eq(contention.tenantId, tenantId), gte(contention.lastAt, since)))
    .orderBy(desc(contention.lastAt));
  return rows.map((row) => Contention.parse(row));
}

/**
 * What Tasq prevented in a period.
 *
 * `situations` counts distinct standoffs and `attempts` counts how many times
 * someone was turned away. Both matter and they are not the same number: one
 * agent politely retrying is a small problem, and two agents each convinced
 * the work is theirs is a large one.
 */
export async function contentionSummary(
  db: TasqDbOrTx,
  tenantId: string,
  since = 0,
): Promise<{
  since: number;
  situations: number;
  attempts: number;
  byKind: Record<string, { situations: number; attempts: number }>;
  commitments: number;
}> {
  const rows = await listContention(db, tenantId, since);
  const byKind: Record<string, { situations: number; attempts: number }> = {};
  for (const row of rows) {
    const entry = byKind[row.kind] ?? { situations: 0, attempts: 0 };
    entry.situations += 1;
    entry.attempts += row.attempts;
    byKind[row.kind] = entry;
  }
  return {
    since,
    situations: rows.length,
    attempts: rows.reduce((total, row) => total + row.attempts, 0),
    byKind,
    commitments: new Set(rows.map((row) => row.commitmentId)).size,
  };
}

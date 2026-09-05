/**
 * ADR-021 — shared assumptions.
 *
 * An assumption is one immutable sentence that work rests on. Several
 * commitments share it, so withdrawing it once reaches all of them: at many
 * agents on one ledger, the dominant failure is not two agents writing the same
 * commitment, it is one agent executing correctly against a belief another
 * agent disproved an hour ago.
 *
 * This is deliberately NOT the premise protocol. A premise adjudicates a
 * contested proposition between distinct principals, and requires a connector
 * observation plus a second validating principal. An assumption records what
 * work rests on, costs one sentence, and is withdrawn unilaterally.
 */

import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { assumption, assumptionLink, principal, uuidv7, LEGACY_DEFAULT_WORKSPACE_ID } from "@tasq-run/schema";
import type { TasqDb, TasqDbOrTx } from "../db.js";
import { runInTransaction } from "../db.js";
import { serviceNow } from "../util/clock.js";
import type { TaskServiceContext } from "./tasks.js";
import { getTask } from "./tasks.js";
import { ensureLocalPrincipal } from "./principals.js";
import { emitAfterCommit, recordEvent } from "./events.js";
import type { Event as EventT } from "@tasq-run/schema";

export const ASSUMPTION_TEXT_MAX = 200;
export const ASSUMPTION_REASON_MAX = 2_000;

/**
 * Identity of an assumption inside a tenant. Two agents that phrase the same
 * belief with different spacing or casing must land on the same record, or
 * "shared" is a claim the storage does not keep.
 */
export function normalizeAssumptionText(raw: string): string {
  return raw.normalize("NFC").trim().replace(/\s+/g, " ").toLowerCase();
}

const AssumptionText = z.string().trim().min(1).max(ASSUMPTION_TEXT_MAX);
const Reason = z.string().trim().min(1).max(ASSUMPTION_REASON_MAX);
const EvidenceIds = z.array(z.string().uuid()).max(128).default([])
  .transform((ids) => [...new Set(ids)].sort());

export interface AssumptionRecord {
  id: string;
  tenantId: string;
  text: string;
  normalizedText: string;
  status: "standing" | "withdrawn";
  statedByPrincipalId: string;
  statedAt: number;
  withdrawnByPrincipalId: string | null;
  withdrawnAt: number | null;
  withdrawalReason: string | null;
  withdrawalEvidenceIds: string[];
}

export interface AssumptionLinkRecord {
  id: string;
  assumptionId: string;
  taskId: string;
  status: "active" | "unlinked";
  linkedByPrincipalId: string;
  linkedAt: number;
  unlinkedByPrincipalId: string | null;
  unlinkedAt: number | null;
  unlinkReason: string | null;
}

function toRecord(row: typeof assumption.$inferSelect): AssumptionRecord {
  return {
    id: row.id,
    tenantId: row.tenantId,
    text: row.text,
    normalizedText: row.normalizedText,
    status: row.status as "standing" | "withdrawn",
    statedByPrincipalId: row.statedByPrincipalId,
    statedAt: row.statedAt,
    withdrawnByPrincipalId: row.withdrawnByPrincipalId,
    withdrawnAt: row.withdrawnAt,
    withdrawalReason: row.withdrawalReason,
    withdrawalEvidenceIds: row.withdrawalEvidenceIds ? JSON.parse(row.withdrawalEvidenceIds) : [],
  };
}

function toLinkRecord(row: typeof assumptionLink.$inferSelect): AssumptionLinkRecord {
  return {
    id: row.id,
    assumptionId: row.assumptionId,
    taskId: row.taskId,
    status: row.status as "active" | "unlinked",
    linkedByPrincipalId: row.linkedByPrincipalId,
    linkedAt: row.linkedAt,
    unlinkedByPrincipalId: row.unlinkedByPrincipalId,
    unlinkedAt: row.unlinkedAt,
    unlinkReason: row.unlinkReason,
  };
}

async function findStanding(
  tx: TasqDbOrTx,
  tenantId: string,
  normalized: string,
): Promise<typeof assumption.$inferSelect | undefined> {
  const rows = await tx.select().from(assumption).where(and(
    eq(assumption.tenantId, tenantId),
    eq(assumption.normalizedText, normalized),
    eq(assumption.status, "standing"),
  )).limit(1);
  return rows[0];
}

/**
 * Find-or-create by normalised text, then bind it to a commitment. Stating a
 * belief that already stands is not an error; it is the whole point, because it
 * is how two agents end up resting on one record instead of two.
 */
async function attachInTransaction(
  tx: TasqDbOrTx,
  args: { tenantId: string; actor: string; taskId: string; text: string; now: number },
): Promise<{ assumption: AssumptionRecord; link: AssumptionLinkRecord; events: EventT[] }> {
  const { tenantId, actor, taskId, now } = args;
  const text = AssumptionText.parse(args.text);
  const normalized = normalizeAssumptionText(text);
  if (normalized.length === 0) throw new Error("An assumption cannot be empty");

  const task = await getTask(tx, taskId, tenantId);
  if (!task) throw new Error(`Task not found: ${taskId}`);
  if (task.deletedAt !== null) throw new Error(`Task is deleted: ${taskId}`);

  const principal = await ensureLocalPrincipal(tx, tenantId, actor, now);
  const events: EventT[] = [];

  let row = await findStanding(tx, tenantId, normalized);
  if (!row) {
    const id = uuidv7(now);
    await tx.insert(assumption).values({
      id, tenantId, text, normalizedText: normalized, status: "standing",
      statedByPrincipalId: principal.id, statedAt: now,
      withdrawnByPrincipalId: null, withdrawnAt: null,
      withdrawalReason: null, withdrawalEvidenceIds: null,
    });
    events.push(await recordEvent(tx, {
      tenantId, actor, principalId: principal.id,
      entityType: "task", entityId: taskId,
      eventType: "assumption_stated",
      payload: { after: { assumptionId: id, text } },
    }, { defer: true, now }));
    row = (await tx.select().from(assumption).where(and(
      eq(assumption.tenantId, tenantId), eq(assumption.id, id),
    )).limit(1))[0]!;
  }

  const existingLinks = await tx.select().from(assumptionLink).where(and(
    eq(assumptionLink.tenantId, tenantId),
    eq(assumptionLink.assumptionId, row.id),
    eq(assumptionLink.taskId, taskId),
    eq(assumptionLink.status, "active"),
  )).limit(1);

  let linkRow = existingLinks[0];
  if (!linkRow) {
    const linkId = uuidv7(now);
    await tx.insert(assumptionLink).values({
      id: linkId, tenantId, assumptionId: row.id, taskId, status: "active",
      linkedByPrincipalId: principal.id, linkedAt: now,
      unlinkedByPrincipalId: null, unlinkedAt: null, unlinkReason: null,
    });
    events.push(await recordEvent(tx, {
      tenantId, actor, principalId: principal.id,
      entityType: "task", entityId: taskId,
      eventType: "assumption_linked",
      payload: { after: { assumptionId: row.id, linkId, text: row.text } },
    }, { defer: true, now }));
    linkRow = (await tx.select().from(assumptionLink).where(and(
      eq(assumptionLink.tenantId, tenantId), eq(assumptionLink.id, linkId),
    )).limit(1))[0]!;
  }

  return { assumption: toRecord(row), link: toLinkRecord(linkRow), events };
}

/** Public entry point used by `tasq add --because` and by MCP. */
export async function attachAssumption(
  db: TasqDb,
  input: unknown,
  context: TaskServiceContext = {},
): Promise<{ assumption: AssumptionRecord; link: AssumptionLinkRecord }> {
  const parsed = z.object({ taskId: z.string().uuid(), text: AssumptionText }).parse(input);
  const tenantId = context.tenantId ?? LEGACY_DEFAULT_WORKSPACE_ID;
  const actor = context.actor ?? "system";
  const now = serviceNow(context, context.now);
  const outcome = await runInTransaction(db, async (tx) => {
    const attached = await attachInTransaction(tx, { tenantId, actor, taskId: parsed.taskId, text: parsed.text, now });
    return { result: attached, events: attached.events };
  });
  for (const event of outcome.events) emitAfterCommit(event);
  return { assumption: outcome.result.assumption, link: outcome.result.link };
}

/** Used inside `createTask`'s own transaction so `add --because` stays atomic. */
export { attachInTransaction as attachAssumptionInTransaction };

export interface WithdrawAssumptionResult {
  assumption: AssumptionRecord;
  /** Open commitments that stopped being actionable because of this withdrawal. */
  pausedTaskIds: string[];
  replayed: boolean;
}

/**
 * Withdraw a belief. Unilateral by design: requiring a second principal is what
 * makes the premise protocol unusable for everyday work, and requiring evidence
 * would reproduce the same adoption failure. The record always names who
 * withdrew it and why, so an unwitnessed withdrawal is visible as such rather
 * than forbidden.
 *
 * The effect is ONE HOP and NEVER TERMINAL: directly linked commitments are
 * paused, nothing is cancelled, and `depends_on` is not traversed.
 */
export async function withdrawAssumption(
  db: TasqDb,
  input: unknown,
  context: TaskServiceContext = {},
): Promise<WithdrawAssumptionResult> {
  const parsed = z.object({
    text: AssumptionText.optional(),
    assumptionId: z.string().uuid().optional(),
    reason: Reason,
    evidenceIds: EvidenceIds,
  }).refine((value) => Boolean(value.text || value.assumptionId), {
    message: "Withdrawing an assumption requires its text or its id",
  }).parse(input);

  const tenantId = context.tenantId ?? LEGACY_DEFAULT_WORKSPACE_ID;
  const actor = context.actor ?? "system";
  const now = serviceNow(context, context.now);

  const outcome = await runInTransaction(db, async (tx) => {
    // Look up the standing belief first, then fall back to an already-withdrawn
    // one with the same text. Without the fallback a retried `tasq wrong` reports
    // that no such assumption exists, which reads as "your withdrawal never
    // happened" at the exact moment it already did.
    const row = parsed.assumptionId
      ? (await tx.select().from(assumption).where(and(
          eq(assumption.tenantId, tenantId), eq(assumption.id, parsed.assumptionId),
        )).limit(1))[0]
      : await findStanding(tx, tenantId, normalizeAssumptionText(parsed.text!))
        ?? (await tx.select().from(assumption).where(and(
            eq(assumption.tenantId, tenantId),
            eq(assumption.normalizedText, normalizeAssumptionText(parsed.text!)),
            eq(assumption.status, "withdrawn"),
          )).orderBy(desc(assumption.withdrawnAt)).limit(1))[0];

    if (!row) {
      throw new Error(parsed.assumptionId
        ? `Assumption not found: ${parsed.assumptionId}`
        : `No standing assumption matches: ${parsed.text}`);
    }
    if (row.status === "withdrawn") {
      // Withdrawal is idempotent by nature: the belief is already gone, and
      // reporting an error would punish a retry for arriving second.
      const links = await tx.select().from(assumptionLink).where(and(
        eq(assumptionLink.tenantId, tenantId),
        eq(assumptionLink.assumptionId, row.id),
        eq(assumptionLink.status, "active"),
      ));
      return {
        result: { assumption: toRecord(row), pausedTaskIds: links.map((l) => l.taskId).sort(), replayed: true },
        events: [],
      };
    }

    const principal = await ensureLocalPrincipal(tx, tenantId, actor, now);
    await tx.update(assumption).set({
      status: "withdrawn",
      withdrawnByPrincipalId: principal.id,
      withdrawnAt: now,
      withdrawalReason: parsed.reason,
      withdrawalEvidenceIds: JSON.stringify(parsed.evidenceIds),
    }).where(and(eq(assumption.tenantId, tenantId), eq(assumption.id, row.id)));

    const links = await tx.select().from(assumptionLink).where(and(
      eq(assumptionLink.tenantId, tenantId),
      eq(assumptionLink.assumptionId, row.id),
      eq(assumptionLink.status, "active"),
    ));

    // Only work that is still open can be paused; a finished commitment is not
    // retroactively undone because the reason it was started turned out wrong.
    const paused: string[] = [];
    for (const link of links) {
      const task = await getTask(tx, link.taskId, tenantId);
      if (!task || task.deletedAt !== null) continue;
      if (task.status === "done" || task.status === "cancelled") continue;
      paused.push(link.taskId);
    }
    paused.sort();

    // One event per paused commitment, never one keyed on the assumption:
    // `entityType` is a closed enum with no assumption member, so parking an
    // assumption id in `entityId` would silently corrupt every audit query that
    // joins events to tasks. The assumption row itself already records who
    // withdrew the belief and why; these events record why each commitment
    // changed state, which is what `tasq event list --entity-id <task>` answers.
    const events: EventT[] = [];
    for (const pausedTaskId of paused) {
      events.push(await recordEvent(tx, {
        tenantId, actor, principalId: principal.id,
        entityType: "task",
        entityId: pausedTaskId,
        eventType: "assumption_withdrawn",
        payload: {
          after: {
            assumptionId: row.id, text: row.text, reason: parsed.reason,
            evidenceIds: parsed.evidenceIds, pausedTaskIds: paused,
          },
        },
      }, { defer: true, now }));
    }

    const updated = (await tx.select().from(assumption).where(and(
      eq(assumption.tenantId, tenantId), eq(assumption.id, row.id),
    )).limit(1))[0]!;

    return { result: { assumption: toRecord(updated), pausedTaskIds: paused, replayed: false }, events };
  });

  for (const event of outcome.events) emitAfterCommit(event);
  return outcome.result;
}

/**
 * Return a commitment to actionable after its assumption was withdrawn, by
 * unlinking it from the withdrawn belief and saying why. This is the recovery
 * path that makes a wrong withdrawal cost one command instead of a restore.
 */
export async function resumeCommitment(
  db: TasqDb,
  input: unknown,
  context: TaskServiceContext = {},
): Promise<{ taskId: string; unlinked: AssumptionLinkRecord[] }> {
  const parsed = z.object({ taskId: z.string().uuid(), reason: Reason }).parse(input);
  const tenantId = context.tenantId ?? LEGACY_DEFAULT_WORKSPACE_ID;
  const actor = context.actor ?? "system";
  const now = serviceNow(context, context.now);

  const outcome = await runInTransaction(db, async (tx) => {
    const task = await getTask(tx, parsed.taskId, tenantId);
    if (!task) throw new Error(`Task not found: ${parsed.taskId}`);

    const withdrawn = await withdrawnLinksForTask(tx, parsed.taskId, tenantId);
    if (withdrawn.length === 0) {
      throw new Error(`Task ${parsed.taskId} is not paused by a withdrawn assumption`);
    }

    const principal = await ensureLocalPrincipal(tx, tenantId, actor, now);
    const events = [];
    const unlinked: AssumptionLinkRecord[] = [];
    for (const entry of withdrawn) {
      await tx.update(assumptionLink).set({
        status: "unlinked",
        unlinkedByPrincipalId: principal.id,
        unlinkedAt: now,
        unlinkReason: parsed.reason,
      }).where(and(eq(assumptionLink.tenantId, tenantId), eq(assumptionLink.id, entry.link.id)));
      events.push(await recordEvent(tx, {
        tenantId, actor, principalId: principal.id,
        entityType: "task", entityId: parsed.taskId,
        eventType: "assumption_unlinked",
        payload: {
          after: {
            assumptionId: entry.assumption.id, linkId: entry.link.id,
            text: entry.assumption.text, reason: parsed.reason,
          },
        },
      }, { defer: true, now }));
      unlinked.push({ ...entry.link, status: "unlinked", unlinkedByPrincipalId: principal.id, unlinkedAt: now, unlinkReason: parsed.reason });
    }
    return { result: { taskId: parsed.taskId, unlinked }, events };
  });

  for (const event of outcome.events) emitAfterCommit(event);
  return outcome.result;
}

export interface WithdrawnLink {
  assumption: AssumptionRecord;
  link: AssumptionLinkRecord;
}

/** Active links from one commitment to assumptions that have been withdrawn. */
export async function withdrawnLinksForTask(
  tx: TasqDbOrTx,
  taskId: string,
  tenantId: string,
): Promise<WithdrawnLink[]> {
  const rows = await tx.select({ link: assumptionLink, value: assumption })
    .from(assumptionLink)
    .innerJoin(assumption, eq(assumptionLink.assumptionId, assumption.id))
    .where(and(
      eq(assumptionLink.tenantId, tenantId),
      eq(assumptionLink.taskId, taskId),
      eq(assumptionLink.status, "active"),
      eq(assumption.status, "withdrawn"),
    ));
  return rows.map((row) => ({ assumption: toRecord(row.value), link: toLinkRecord(row.link) }));
}

/**
 * Every commitment currently paused by a withdrawn assumption, for the one
 * query selection needs. Mirrors how `pickNext` already filters commitments
 * carrying a premise invalidation.
 */
export async function pausedTaskIds(
  tx: TasqDbOrTx,
  tenantId: string,
): Promise<Set<string>> {
  const rows = await tx.select({ taskId: assumptionLink.taskId })
    .from(assumptionLink)
    .innerJoin(assumption, eq(assumptionLink.assumptionId, assumption.id))
    .where(and(
      eq(assumptionLink.tenantId, tenantId),
      eq(assumptionLink.status, "active"),
      eq(assumption.status, "withdrawn"),
    ));
  return new Set(rows.map((row) => row.taskId));
}

/**
 * Refuse execution authority over a commitment whose reason for existing has
 * been withdrawn. Selection filtering is advisory - a caller holding a stale
 * list can still reach claim - so this second layer is not redundant, exactly
 * as it is not redundant on the premise path.
 */
export async function assertCommitmentNotPaused(
  tx: TasqDbOrTx,
  taskId: string,
  tenantId: string,
): Promise<void> {
  const withdrawn = await withdrawnLinksForTask(tx, taskId, tenantId);
  if (withdrawn.length === 0) return;
  const first = withdrawn[0]!;
  throw new Error(
    `Task ${taskId} is paused: the assumption "${first.assumption.text}" was withdrawn`
      + `${first.assumption.withdrawalReason ? ` (${first.assumption.withdrawalReason})` : ""}. `
      + `Run \`tasq why ${taskId}\` to read the chain, or \`tasq resume ${taskId} --reason <text>\` to continue anyway.`,
  );
}

/**
 * Principal ids are the durable identity and stay in the payload, but no reader
 * recognises `urn:tasq:local-principal:<hex>:<hex>`. Resolve display names once
 * per read so every surface shows who, not what.
 */
export async function principalLabels(
  tx: TasqDbOrTx,
  tenantId: string,
  ids: string[],
): Promise<Record<string, string>> {
  const unique = [...new Set(ids.filter(Boolean))];
  if (unique.length === 0) return {};
  const rows = await tx.select({ id: principal.id, displayName: principal.displayName, localAlias: principal.localAlias })
    .from(principal)
    .where(and(eq(principal.tenantId, tenantId), inArray(principal.id, unique)));
  const labels: Record<string, string> = {};
  for (const row of rows) labels[row.id] = row.localAlias ?? row.displayName;
  return labels;
}

export interface TaskAssumptionState {
  contractVersion: "tasq.task-assumptions.v1";
  taskId: string;
  paused: boolean;
  assumptions: Array<{ assumption: AssumptionRecord; link: AssumptionLinkRecord }>;
  /** principalId -> the alias a human recognises. */
  principals: Record<string, string>;
}

/** Everything `tasq why` needs about one commitment's assumptions. */
export async function getTaskAssumptions(
  tx: TasqDbOrTx,
  taskId: string,
  tenantId: string,
): Promise<TaskAssumptionState> {
  const rows = await tx.select({ link: assumptionLink, value: assumption })
    .from(assumptionLink)
    .innerJoin(assumption, eq(assumptionLink.assumptionId, assumption.id))
    .where(and(eq(assumptionLink.tenantId, tenantId), eq(assumptionLink.taskId, taskId)))
    .orderBy(assumptionLink.linkedAt);
  const entries = rows.map((row) => ({ assumption: toRecord(row.value), link: toLinkRecord(row.link) }));
  const labels = await principalLabels(tx, tenantId, entries.flatMap((e) => [
    e.assumption.statedByPrincipalId,
    e.assumption.withdrawnByPrincipalId ?? "",
    e.link.linkedByPrincipalId,
    e.link.unlinkedByPrincipalId ?? "",
  ]));
  return {
    contractVersion: "tasq.task-assumptions.v1",
    taskId,
    paused: entries.some((e) => e.link.status === "active" && e.assumption.status === "withdrawn"),
    assumptions: entries,
    principals: labels,
  };
}

export interface AssumptionSummary extends AssumptionRecord {
  activeTaskIds: string[];
}

/** List assumptions in a tenant with the commitments that currently rest on them. */
export async function listAssumptions(
  tx: TasqDbOrTx,
  tenantId: string,
  options: { status?: "standing" | "withdrawn" } = {},
): Promise<AssumptionSummary[]> {
  const filters = [eq(assumption.tenantId, tenantId)];
  if (options.status) filters.push(eq(assumption.status, options.status));
  const rows = await tx.select().from(assumption).where(and(...filters)).orderBy(assumption.statedAt);
  if (rows.length === 0) return [];
  const links = await tx.select().from(assumptionLink).where(and(
    eq(assumptionLink.tenantId, tenantId),
    eq(assumptionLink.status, "active"),
    inArray(assumptionLink.assumptionId, rows.map((row) => row.id)),
  ));
  const byAssumption = new Map<string, string[]>();
  for (const link of links) {
    const list = byAssumption.get(link.assumptionId) ?? [];
    list.push(link.taskId);
    byAssumption.set(link.assumptionId, list);
  }
  return rows.map((row) => ({
    ...toRecord(row),
    activeTaskIds: (byAssumption.get(row.id) ?? []).sort(),
  }));
}

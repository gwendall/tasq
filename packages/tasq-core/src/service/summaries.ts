/**
 * Append-only semantic compaction for terminal commitments.
 *
 * A summary is a derived hint, never authority or truth. Its source digest,
 * raw audit frontier and exact drill-down references make staleness visible;
 * the underlying inspection/audit/evidence graph is never changed.
 */

import { and, asc, desc, eq, inArray, ne, sql } from "drizzle-orm";
import {
  AppendCommitmentSummaryInput as AppendInputZ,
  COMMITMENT_SUMMARY_CONTRACT_VERSION,
  COMMITMENT_SUMMARY_SOURCE_CONTRACT_VERSION,
  CommitmentSummary as CommitmentSummaryZ,
  commitmentSummary,
  event,
  task,
  uuidv7,
  type AppendCommitmentSummaryInput,
  type Clock,
  type CommitmentSummary,
  type CommitmentSummarySourceRefs,
  type Event,
} from "@tasq/schema";
import type { TasqDb, TasqDbOrTx } from "../db.js";
import { runInTransaction } from "../db.js";
import { inspectCommitmentInTransaction, type CommitmentInspection } from "../inspection.js";
import { canonicalJson, sha256Digest } from "../util/canonical-json.js";
import { serviceNow } from "../util/clock.js";
import { emitAfterCommit, recordEvent } from "./events.js";
import {
  findIdempotencyResult,
  prepareIdempotency,
  saveIdempotencyResult,
} from "./idempotency.js";
import { ensureLocalPrincipal, getPrincipal } from "./principals.js";

export const COMMITMENT_SUMMARY_EVENT_TYPE = "commitment_summary_appended" as const;

export interface CommitmentSummaryContext {
  actor?: string;
  principalId?: string;
  idempotencyKey: string;
  clock?: Clock;
  now?: number;
}

export interface ListCommitmentSummariesOptions {
  workspaceId: string;
  commitmentId?: string;
  limit?: number;
}

export interface ListCurrentCommitmentSummariesOptions {
  workspaceId: string;
  limit?: number;
}

type SummaryRow = typeof commitmentSummary.$inferSelect;
type TaskRow = typeof task.$inferSelect;

function sourceEvents(snapshot: CommitmentInspection) {
  return snapshot.events.filter((item) => item.eventType !== COMMITMENT_SUMMARY_EVENT_TYPE);
}

/** Deterministically derive the source contract from a canonical inspection. */
export function deriveCommitmentSummarySource(snapshot: CommitmentInspection) {
  const events = sourceEvents(snapshot);
  // Time-of-read, workspace-global cursors and display-only principal expansion
  // are deliberately excluded. Attribution IDs remain embedded in every raw
  // record, so a summary append cannot alter its own source digest.
  const { inspectedAt: _inspectedAt, resumeCursor: _resumeCursor,
    principals: _principals, events: _events, ...durableGraph } = snapshot;
  const sourceSnapshot = { ...durableGraph, events };
  const refs: CommitmentSummarySourceRefs = {
    inspect: { operation: "inspectCommitment", commitmentId: snapshot.commitment.id },
    audit: {
      entityType: "task",
      entityId: snapshot.commitment.id,
      throughSequence: events.at(-1)?.sequence ?? 0,
      eventCount: events.length,
    },
    evidenceIds: snapshot.evidence.map((item) => item.id),
    artifactIds: snapshot.artifacts.map((item) => item.id),
    completionRecordIds: snapshot.completionRecords.map((item) => item.id),
    effectReceiptIds: snapshot.effectReceipts.map((item) => item.id),
    externalRefIds: snapshot.externalRefs.map((item) => item.id),
    externalContextLinkIds: snapshot.externalContextLinks.map((item) => item.id),
  };
  return {
    contractVersion: COMMITMENT_SUMMARY_SOURCE_CONTRACT_VERSION,
    commitmentRevision: snapshot.commitment.revision,
    terminalStatus: snapshot.commitment.status as "done" | "cancelled",
    rawEventSequence: events.at(-1)?.sequence ?? 0,
    digest: sha256Digest(`tasq.commitment-summary-source.v1\0${canonicalJson(sourceSnapshot)}`),
    refs,
  } as const;
}

function staleReasons(row: SummaryRow, currentTask: TaskRow | null, rawEventSequence: number) {
  const reasons: CommitmentSummary["staleReasons"] = [];
  if (!currentTask || currentTask.deletedAt !== null ||
      (currentTask.status !== "done" && currentTask.status !== "cancelled")) {
    reasons.push("commitment_not_terminal");
  }
  if (currentTask && currentTask.revision !== row.sourceRevision) {
    reasons.push("commitment_revision_changed");
  }
  if (rawEventSequence !== row.sourceEventSequence) reasons.push("raw_audit_advanced");
  return reasons;
}

function parseSummary(
  row: SummaryRow,
  currentTask: TaskRow | null,
  rawEventSequence: number,
  superseded: boolean,
): CommitmentSummary {
  const reasons = staleReasons(row, currentTask, rawEventSequence);
  return CommitmentSummaryZ.parse({
    contractVersion: COMMITMENT_SUMMARY_CONTRACT_VERSION,
    id: row.id,
    workspaceId: row.tenantId,
    commitmentId: row.taskId,
    supersedesSummaryId: row.supersedesSummaryId,
    summary: row.summary,
    summaryDigest: row.summaryDigest,
    source: {
      contractVersion: COMMITMENT_SUMMARY_SOURCE_CONTRACT_VERSION,
      commitmentRevision: row.sourceRevision,
      terminalStatus: row.sourceStatus,
      rawEventSequence: row.sourceEventSequence,
      digest: row.sourceDigest,
      refs: JSON.parse(row.sourceRefs),
    },
    actorAlias: row.actor,
    principalId: row.principalId,
    createdAt: row.createdAt,
    state: superseded ? "superseded" : reasons.length === 0 ? "current" : "stale",
    staleReasons: reasons,
  });
}

async function rawFrontiers(db: TasqDbOrTx, workspaceId: string, ids: string[]) {
  const result = new Map<string, number>();
  if (ids.length === 0) return result;
  const rows = await db.select({
    taskId: event.entityId,
    sequence: sql<number>`coalesce(max(${event.sequence}), 0)`,
  }).from(event).where(and(
    eq(event.tenantId, workspaceId),
    eq(event.entityType, "task"),
    inArray(event.entityId, ids),
    ne(event.eventType, COMMITMENT_SUMMARY_EVENT_TYPE),
  )).groupBy(event.entityId);
  for (const row of rows) result.set(row.taskId, Number(row.sequence));
  return result;
}

async function materializeRows(db: TasqDbOrTx, rows: SummaryRow[]) {
  if (rows.length === 0) return [];
  const workspaceId = rows[0]!.tenantId;
  const taskIds = [...new Set(rows.map((row) => row.taskId))];
  const summaryIds = rows.map((row) => row.id);
  const [taskRows, frontiers, childRows] = await Promise.all([
    db.select().from(task).where(and(eq(task.tenantId, workspaceId), inArray(task.id, taskIds))),
    rawFrontiers(db, workspaceId, taskIds),
    db.select({ supersedesSummaryId: commitmentSummary.supersedesSummaryId })
      .from(commitmentSummary).where(and(
        eq(commitmentSummary.tenantId, workspaceId),
        inArray(commitmentSummary.supersedesSummaryId, summaryIds),
      )),
  ]);
  const tasks = new Map(taskRows.map((row) => [row.id, row]));
  // A correction may sit outside the requested page. State must be derived
  // from storage, never from whichever neighbouring rows happened to fit.
  const supersededIds = new Set(childRows.flatMap((row) =>
    row.supersedesSummaryId ? [row.supersedesSummaryId] : []));
  return rows.map((row) => parseSummary(
    row,
    tasks.get(row.taskId) ?? null,
    frontiers.get(row.taskId) ?? 0,
    supersededIds.has(row.id),
  ));
}

export async function getCommitmentSummary(
  db: TasqDbOrTx,
  id: string,
  workspaceId: string,
): Promise<CommitmentSummary | null> {
  const rows = await db.select().from(commitmentSummary).where(and(
    eq(commitmentSummary.id, id), eq(commitmentSummary.tenantId, workspaceId),
  )).limit(1);
  if (!rows[0]) return null;
  const children = await db.select({ id: commitmentSummary.id }).from(commitmentSummary).where(and(
    eq(commitmentSummary.tenantId, workspaceId),
    eq(commitmentSummary.supersedesSummaryId, id),
  )).limit(1);
  const taskRows = await db.select().from(task).where(and(
    eq(task.id, rows[0].taskId), eq(task.tenantId, workspaceId),
  )).limit(1);
  const frontiers = await rawFrontiers(db, workspaceId, [rows[0].taskId]);
  return parseSummary(rows[0], taskRows[0] ?? null, frontiers.get(rows[0].taskId) ?? 0,
    children.length > 0);
}

export async function listCommitmentSummaries(
  db: TasqDbOrTx,
  options: ListCommitmentSummariesOptions,
): Promise<CommitmentSummary[]> {
  const limit = options.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) {
    throw new Error("summary list limit must be between 1 and 10000");
  }
  const filters = [eq(commitmentSummary.tenantId, options.workspaceId)];
  if (options.commitmentId) filters.push(eq(commitmentSummary.taskId, options.commitmentId));
  const rows = await db.select().from(commitmentSummary).where(and(...filters))
    .orderBy(asc(commitmentSummary.createdAt), asc(commitmentSummary.id)).limit(limit);
  return materializeRows(db, rows);
}

/** Bounded newest-first leaf query used by context packets; no per-row reads. */
export async function listCurrentCommitmentSummaries(
  db: TasqDbOrTx,
  options: ListCurrentCommitmentSummariesOptions,
): Promise<CommitmentSummary[]> {
  const limit = options.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
    throw new Error("current summary limit must be between 1 and 500");
  }
  const rows = await db.select({ summary: commitmentSummary }).from(commitmentSummary)
    .innerJoin(task, and(
      eq(task.id, commitmentSummary.taskId),
      eq(task.tenantId, commitmentSummary.tenantId),
    )).where(and(
      eq(commitmentSummary.tenantId, options.workspaceId),
      sql`${task.deletedAt} IS NULL`,
      sql`${task.status} IN ('done', 'cancelled')`,
      eq(task.status, commitmentSummary.sourceStatus),
      eq(task.revision, commitmentSummary.sourceRevision),
      sql`${commitmentSummary.sourceEventSequence} = coalesce((
        SELECT max(raw_event.sequence) FROM event AS raw_event
        WHERE raw_event.tenant_id = ${commitmentSummary.tenantId}
          AND raw_event.entity_type = 'task'
          AND raw_event.entity_id = ${commitmentSummary.taskId}
          AND raw_event.event_type <> ${COMMITMENT_SUMMARY_EVENT_TYPE}
      ), 0)`,
      sql`NOT EXISTS (
        SELECT 1 FROM commitment_summary AS child
        WHERE child.tenant_id = ${commitmentSummary.tenantId}
          AND child.supersedes_summary_id = ${commitmentSummary.id}
      )`,
    )).orderBy(desc(sql`coalesce(${task.completedAt}, ${task.updatedAt})`),
      desc(commitmentSummary.createdAt), asc(commitmentSummary.id))
    .limit(limit);
  const materialized = await materializeRows(db, rows.map((row) => row.summary));
  return materialized;
}

/** Append the first summary or a CAS correction to the current chain leaf. */
export async function appendCommitmentSummary(
  db: TasqDb,
  input: AppendCommitmentSummaryInput,
  context: CommitmentSummaryContext,
): Promise<CommitmentSummary> {
  const parsed = AppendInputZ.parse(input);
  const actor = context.actor?.trim() || "system";
  if (!context.idempotencyKey?.trim()) throw new Error("idempotencyKey is required");
  const now = serviceNow(context, context.now);
  const identity = prepareIdempotency({
    tenantId: parsed.workspaceId,
    actor,
    principalId: context.principalId,
    idempotencyKey: context.idempotencyKey,
  }, "commitment_summary.append", parsed, { now, retentionClass: "durable" });

  const committed = await runInTransaction(db, async (tx) => {
    const prior = await findIdempotencyResult(tx, identity);
    if (prior) {
      const replay = await getCommitmentSummary(tx, prior.resultId, parsed.workspaceId);
      if (!replay) throw new Error(`Idempotency record points at missing summary ${prior.resultId}`);
      return { summary: replay, event: null as Event | null };
    }

    const snapshot = await inspectCommitmentInTransaction(tx, parsed.commitmentId, {
      workspaceId: parsed.workspaceId,
    }, now);
    if (!snapshot) throw new Error(`Commitment not found: ${parsed.commitmentId}`);
    if (snapshot.commitment.status !== "done" && snapshot.commitment.status !== "cancelled") {
      throw new Error("Only terminal commitments can be compacted");
    }
    const chain = await tx.select().from(commitmentSummary).where(and(
      eq(commitmentSummary.tenantId, parsed.workspaceId),
      eq(commitmentSummary.taskId, parsed.commitmentId),
    )).orderBy(asc(commitmentSummary.createdAt), asc(commitmentSummary.id));
    const parents = new Set(chain.flatMap((row) =>
      row.supersedesSummaryId ? [row.supersedesSummaryId] : []));
    const leaf = chain.find((row) => !parents.has(row.id)) ?? null;
    if ((leaf?.id ?? null) !== parsed.expectedPreviousSummaryId) {
      throw new Error(
        `Stale summary chain: expected previous ${parsed.expectedPreviousSummaryId ?? "none"}, ` +
        `current leaf is ${leaf?.id ?? "none"}`,
      );
    }

    const principal = context.principalId
      ? await getPrincipal(tx, context.principalId, parsed.workspaceId)
      : await ensureLocalPrincipal(tx, parsed.workspaceId, actor, now);
    if (!principal) throw new Error(`Principal not found in workspace: ${context.principalId}`);
    if (principal.status !== "enabled") throw new Error(`Principal is disabled: ${principal.id}`);
    const source = deriveCommitmentSummarySource(snapshot);
    const id = parsed.id ?? uuidv7(now);
    const summaryDigest = sha256Digest(
      `tasq.commitment-summary.v1\0${canonicalJson({ summary: parsed.summary })}`,
    );
    await tx.insert(commitmentSummary).values({
      id,
      tenantId: parsed.workspaceId,
      taskId: parsed.commitmentId,
      supersedesSummaryId: parsed.expectedPreviousSummaryId,
      summary: parsed.summary,
      summaryDigest,
      sourceRevision: source.commitmentRevision,
      sourceStatus: source.terminalStatus,
      sourceEventSequence: source.rawEventSequence,
      sourceDigest: source.digest,
      sourceRefs: canonicalJson(source.refs),
      actor,
      principalId: principal.id,
      createdAt: now,
    });
    const auditEvent = await recordEvent(tx, {
      tenantId: parsed.workspaceId,
      actor,
      principalId: principal.id,
      entityType: "task",
      entityId: parsed.commitmentId,
      eventType: "commitment_summary_appended",
      payload: {
        summaryId: id,
        supersedesSummaryId: parsed.expectedPreviousSummaryId,
        summaryDigest,
        sourceDigest: source.digest,
        sourceRevision: source.commitmentRevision,
        sourceEventSequence: source.rawEventSequence,
      },
    }, { defer: true, now });
    await saveIdempotencyResult(tx, identity, {
      resultType: "commitment_summary",
      resultId: id,
      resultStatus: "current",
      resultRevision: source.commitmentRevision,
      eventSequence: auditEvent.sequence,
    });
    const result = await getCommitmentSummary(tx, id, parsed.workspaceId);
    if (!result) throw new Error(`Failed to read back summary ${id}`);
    return { summary: result, event: auditEvent };
  });
  if (committed.event) emitAfterCommit(committed.event);
  return committed.summary;
}

/**
 * Bounded, profile-neutral context projection for cold and returning agents.
 *
 * This is an index, not a hidden planner: selection uses a documented tuple,
 * every item carries its reasons, and complete source data remains available
 * through `inspectCommitment` plus the returned audit cursor.
 */

import { Buffer } from "node:buffer";
import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  inArray,
  isNull,
  lte,
  or,
  sql,
} from "drizzle-orm";
import {
  CONTEXT_PACKET_CONTRACT_VERSION,
  CONTEXT_PACKET_TOKEN_ESTIMATOR_URI,
  ContextPacket as ContextPacketZ,
  ContextPacketRequest as ContextPacketRequestZ,
  assignment,
  commitmentRelation,
  effect,
  event,
  task,
  taskAttempt,
  taskClaim,
  Task as TaskZ,
  type Clock,
  type ContextPacket,
  type ContextPacketItem,
  type ContextPacketReason,
  type Task,
} from "@tasq-run/schema";
import type { TasqDb, TasqDbOrTx } from "./db.js";
import { canonicalJson } from "./util/canonical-json.js";
import { serviceNow } from "./util/clock.js";
import { parseRow } from "./util/row.js";

const ACTIVE_STATUSES = ["in_progress", "blocked", "open"] as const;
const ORDERING = [
  "status_tier_desc",
  "deadline_tier_desc",
  "explicit_priority_desc",
  "due_at_asc_nulls_last",
  "updated_at_desc",
  "commitment_id_asc",
] as const;
const DAY_MS = 24 * 60 * 60 * 1_000;
const DESCRIPTION_BYTES = 2_000;
const SUCCESS_CRITERIA_BYTES = 1_000;

export interface BuildContextPacketOptions {
  workspaceId: string;
  actor?: string | null;
  maxRecords?: number;
  maxTokens?: number;
  includeDeferred?: boolean;
  now?: number;
  clock?: Clock;
}

interface OmissionCounts {
  recordBudget: number;
  tokenBudget: number;
  candidateScanLimit: number;
}

interface CoordinationMaps {
  claims: Map<string, typeof taskClaim.$inferSelect>;
  attempts: Map<string, number>;
  assignments: Map<string, number>;
  relations: Map<string, number>;
  effects: Map<string, number>;
}

/** Build one transactionally consistent packet with hard record and token ceilings. */
export async function buildContextPacket(
  db: TasqDb,
  options: BuildContextPacketOptions,
): Promise<ContextPacket> {
  if (!options.workspaceId.trim()) throw new Error("workspaceId must not be blank");
  const request = ContextPacketRequestZ.parse({
    maxRecords: options.maxRecords,
    maxTokens: options.maxTokens,
    includeDeferred: options.includeDeferred,
    actor: options.actor ?? null,
  });
  const generatedAt = serviceNow(options, options.now);
  if (!Number.isSafeInteger(generatedAt) || generatedAt > Number.MAX_SAFE_INTEGER - DAY_MS) {
    throw new Error("Context snapshot time must leave room for the 24-hour deadline window");
  }

  return db.transaction(async (tx) => {
    const filters = [
      eq(task.tenantId, options.workspaceId),
      isNull(task.deletedAt),
      inArray(task.status, [...ACTIVE_STATUSES]),
    ];
    if (!request.includeDeferred) {
      filters.push(or(isNull(task.scheduledAt), lte(task.scheduledAt, generatedAt))!);
    }

    const candidateScanLimit = Math.min(Math.max(request.maxRecords * 20, 200), 5_000);
    const [eligibleRows, candidateRows, cursorRows] = await Promise.all([
      tx.select({ value: count(task.id) }).from(task).where(and(...filters)),
      tx.select().from(task).where(and(...filters)).orderBy(
        desc(sql<number>`CASE ${task.status}
          WHEN 'in_progress' THEN 3 WHEN 'blocked' THEN 2 ELSE 1 END`),
        desc(sql<number>`CASE
          WHEN ${task.dueAt} IS NULL THEN 0
          WHEN ${task.dueAt} < ${generatedAt} THEN 3
          WHEN ${task.dueAt} <= ${generatedAt + DAY_MS} THEN 2
          ELSE 1 END`),
        desc(sql<number>`COALESCE(${task.priority}, 0)`),
        asc(sql<number>`CASE WHEN ${task.dueAt} IS NULL THEN 1 ELSE 0 END`),
        asc(task.dueAt),
        desc(task.updatedAt),
        asc(task.id),
      ).limit(candidateScanLimit),
      tx.select({ sequence: event.sequence }).from(event)
        .where(eq(event.tenantId, options.workspaceId))
        .orderBy(desc(event.sequence)).limit(1),
    ]);

    const candidates = candidateRows.map((row) => TaskZ.parse(parseRow(row)));
    const coordination = await loadCoordination(tx, options.workspaceId, candidates, generatedAt);
    const eligibleRecords = Number(eligibleRows[0]?.value ?? 0);
    const omissions: OmissionCounts = {
      recordBudget: 0,
      tokenBudget: 0,
      candidateScanLimit: Math.max(0, eligibleRecords - candidates.length),
    };
    const selected: ContextPacketItem[] = [];

    for (const candidate of candidates) {
      if (selected.length >= request.maxRecords) {
        omissions.recordBudget += 1;
        continue;
      }
      const item = projectItem(candidate, coordination, request.actor, generatedAt);
      const tentative = packetObject({
        workspaceId: options.workspaceId,
        actor: request.actor,
        generatedAt,
        request,
        candidateScanLimit,
        eligibleRecords,
        evaluatedRecords: candidates.length,
        items: [...selected, item],
        omissions,
        afterEventSequence: cursorRows[0]?.sequence ?? 0,
      });
      if (measurePacket(tentative).usedTokens <= request.maxTokens) selected.push(item);
      else omissions.tokenBudget += 1;
    }

    // Final omission counters can add digits to the envelope. Remove complete
    // records from the tail until the final canonical payload itself fits.
    let measured = measurePacket(packetObject({
      workspaceId: options.workspaceId,
      actor: request.actor,
      generatedAt,
      request,
      candidateScanLimit,
      eligibleRecords,
      evaluatedRecords: candidates.length,
      items: selected,
      omissions,
      afterEventSequence: cursorRows[0]?.sequence ?? 0,
    }));
    while (measured.usedTokens > request.maxTokens && selected.length > 0) {
      selected.pop();
      omissions.tokenBudget += 1;
      measured = measurePacket(packetObject({
        workspaceId: options.workspaceId,
        actor: request.actor,
        generatedAt,
        request,
        candidateScanLimit,
        eligibleRecords,
        evaluatedRecords: candidates.length,
        items: selected,
        omissions,
        afterEventSequence: cursorRows[0]?.sequence ?? 0,
      }));
    }
    if (measured.usedTokens > request.maxTokens) {
      throw new Error(
        `Context budget ${request.maxTokens} is too small for the v1 envelope (${measured.usedTokens} required)`,
      );
    }
    return ContextPacketZ.parse(measured.packet);
  });
}

async function loadCoordination(
  db: TasqDbOrTx,
  workspaceId: string,
  candidates: Task[],
  now: number,
): Promise<CoordinationMaps> {
  const ids = candidates.map((candidate) => candidate.id);
  const empty: CoordinationMaps = {
    claims: new Map(), attempts: new Map(), assignments: new Map(),
    relations: new Map(), effects: new Map(),
  };
  if (ids.length === 0) return empty;

  const [claimRows, attemptRows, assignmentRows, outgoingRows, incomingRows, effectRows] =
    await Promise.all([
      db.select().from(taskClaim).where(and(
        eq(taskClaim.tenantId, workspaceId),
        inArray(taskClaim.taskId, ids),
        isNull(taskClaim.releasedAt),
        gt(taskClaim.expiresAt, now),
      )),
      db.select({ taskId: taskAttempt.taskId, value: count(taskAttempt.id) })
        .from(taskAttempt).where(and(
          eq(taskAttempt.tenantId, workspaceId),
          inArray(taskAttempt.taskId, ids),
          inArray(taskAttempt.status, ["running", "input_required"]),
        )).groupBy(taskAttempt.taskId),
      db.select({ taskId: assignment.taskId, value: count(assignment.id) })
        .from(assignment).where(and(
          eq(assignment.tenantId, workspaceId),
          inArray(assignment.taskId, ids),
          inArray(assignment.status, ["proposed", "accepted"]),
        )).groupBy(assignment.taskId),
      db.select({ taskId: commitmentRelation.fromTaskId, value: count(commitmentRelation.id) })
        .from(commitmentRelation).where(and(
          eq(commitmentRelation.tenantId, workspaceId),
          inArray(commitmentRelation.fromTaskId, ids),
          isNull(commitmentRelation.endedAt),
        )).groupBy(commitmentRelation.fromTaskId),
      db.select({ taskId: commitmentRelation.toTaskId, value: count(commitmentRelation.id) })
        .from(commitmentRelation).where(and(
          eq(commitmentRelation.tenantId, workspaceId),
          inArray(commitmentRelation.toTaskId, ids),
          isNull(commitmentRelation.endedAt),
        )).groupBy(commitmentRelation.toTaskId),
      db.select({ taskId: effect.taskId, value: count(effect.id) }).from(effect).where(and(
        eq(effect.tenantId, workspaceId),
        inArray(effect.taskId, ids),
        inArray(effect.status, ["proposed", "authorized", "executing", "indeterminate"]),
      )).groupBy(effect.taskId),
    ]);

  for (const row of claimRows) empty.claims.set(row.taskId, row);
  addCounts(empty.attempts, attemptRows);
  addCounts(empty.assignments, assignmentRows);
  addCounts(empty.relations, outgoingRows);
  addCounts(empty.relations, incomingRows);
  addCounts(empty.effects, effectRows);
  return empty;
}

function addCounts(
  target: Map<string, number>,
  rows: Array<{ taskId: string; value: number }>,
): void {
  for (const row of rows) target.set(row.taskId, (target.get(row.taskId) ?? 0) + Number(row.value));
}

function projectItem(
  candidate: Task,
  coordination: CoordinationMaps,
  actor: string | null,
  now: number,
): ContextPacketItem {
  const description = boundedText(candidate.description, DESCRIPTION_BYTES, "description");
  const successCriteria = boundedText(
    candidate.successCriteria,
    SUCCESS_CRITERIA_BYTES,
    "successCriteria",
  );
  const claim = coordination.claims.get(candidate.id);
  const activeAttemptCount = coordination.attempts.get(candidate.id) ?? 0;
  const activeAssignmentCount = coordination.assignments.get(candidate.id) ?? 0;
  const activeRelationCount = coordination.relations.get(candidate.id) ?? 0;
  const unresolvedEffectCount = coordination.effects.get(candidate.id) ?? 0;
  const reasonTrace: ContextPacketReason[] = [{
    code: `status.${candidate.status}`,
    detail: candidate.status === "in_progress"
      ? "Already in progress; continuity outranks unopened work."
      : candidate.status === "blocked"
        ? "Blocked work is included so an agent can inspect or remove the impediment."
        : "Open commitment is eligible for coordination.",
  }];
  const deadlineTier = deadlineRank(candidate.dueAt, now);
  if (candidate.dueAt != null) {
    reasonTrace.push({
      code: deadlineTier === 3 ? "deadline.overdue" : deadlineTier === 2
        ? "deadline.within_24h" : "deadline.future",
      detail: `Due at ${candidate.dueAt}; deadline tier ${deadlineTier}.`,
    });
  }
  if (candidate.priority != null) {
    reasonTrace.push({
      code: "priority.explicit",
      detail: `Explicit priority ${candidate.priority} of 5.`,
    });
  }
  if (claim) {
    reasonTrace.push({
      code: actor != null && claim.actor === actor
        ? "coordination.claimed_by_requester" : "coordination.claimed",
      detail: `Active claim is held until ${claim.expiresAt}; the exact holder is in coordination.activeClaim.`,
    });
  }
  for (const [code, value, label] of [
    ["coordination.active_attempts", activeAttemptCount, "active attempt"],
    ["coordination.active_assignments", activeAssignmentCount, "active assignment"],
    ["coordination.active_relations", activeRelationCount, "active relation"],
    ["authority.unresolved_effects", unresolvedEffectCount, "unresolved effect"],
  ] as const) {
    if (value > 0) reasonTrace.push({ code, detail: `${value} ${label}${value === 1 ? "" : "s"}.` });
  }

  return {
    recordType: "commitment",
    commitment: {
      id: candidate.id,
      workspaceId: candidate.tenantId,
      title: candidate.title,
      description: description.value,
      successCriteria: successCriteria.value,
      completionPolicy: candidate.completionMode,
      status: candidate.status,
      priority: candidate.priority,
      notBefore: candidate.scheduledAt,
      dueAt: candidate.dueAt,
      startedAt: candidate.startedAt,
      revision: candidate.revision,
      updatedAt: candidate.updatedAt,
    },
    coordination: {
      activeClaim: claim ? {
        id: claim.id,
        actorAlias: claim.actor,
        principalId: claim.principalId,
        fence: claim.fence,
        revision: claim.revision,
        expiresAt: claim.expiresAt,
        ownedByRequestingActor: actor != null && claim.actor === actor,
      } : null,
      activeAttemptCount,
      activeAssignmentCount,
      activeRelationCount,
      unresolvedEffectCount,
    },
    rank: {
      statusTier: statusRank(candidate.status),
      deadlineTier,
      explicitPriority: candidate.priority ?? 0,
      updatedAt: candidate.updatedAt,
    },
    reasonTrace,
    truncatedFields: [description.truncation, successCriteria.truncation]
      .filter((item): item is NonNullable<typeof item> => item != null),
    inspect: { operation: "inspectCommitment", commitmentId: candidate.id },
  };
}

function statusRank(status: Task["status"]): 1 | 2 | 3 {
  return status === "in_progress" ? 3 : status === "blocked" ? 2 : 1;
}

function deadlineRank(dueAt: number | null, now: number): 0 | 1 | 2 | 3 {
  if (dueAt == null) return 0;
  if (dueAt < now) return 3;
  if (dueAt <= now + DAY_MS) return 2;
  return 1;
}

function boundedText(
  value: string | null,
  maxBytes: number,
  field: "description" | "successCriteria",
) {
  if (value == null) return { value: null, truncation: null };
  const originalUtf8Bytes = Buffer.byteLength(value, "utf8");
  if (originalUtf8Bytes <= maxBytes) return { value, truncation: null };
  const ellipsis = "…";
  const ellipsisBytes = Buffer.byteLength(ellipsis, "utf8");
  let projected = "";
  let projectedBytes = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (projectedBytes + characterBytes + ellipsisBytes > maxBytes) break;
    projected += character;
    projectedBytes += characterBytes;
  }
  projected += ellipsis;
  projectedBytes += ellipsisBytes;
  return {
    value: projected,
    truncation: { field, originalUtf8Bytes, projectedUtf8Bytes: projectedBytes },
  };
}

function packetObject(input: {
  workspaceId: string;
  actor: string | null;
  generatedAt: number;
  request: ReturnType<typeof ContextPacketRequestZ.parse>;
  candidateScanLimit: number;
  eligibleRecords: number;
  evaluatedRecords: number;
  items: ContextPacketItem[];
  omissions: OmissionCounts;
  afterEventSequence: number;
}) {
  return {
    contractVersion: CONTEXT_PACKET_CONTRACT_VERSION,
    generatedAt: input.generatedAt,
    workspaceId: input.workspaceId,
    requestingActor: input.actor,
    scope: {
      statuses: ACTIVE_STATUSES,
      deferred: input.request.includeDeferred ? "include" : "exclude_future_not_before",
    },
    ordering: ORDERING,
    budget: {
      maxRecords: input.request.maxRecords,
      maxTokens: input.request.maxTokens,
      usedRecords: input.items.length,
      usedTokens: 0,
      measuredUtf8Bytes: 0,
      tokenEstimator: CONTEXT_PACKET_TOKEN_ESTIMATOR_URI,
      encoding: "canonical-json-utf8" as const,
      hardLimitSatisfied: true as const,
    },
    selection: {
      eligibleRecords: input.eligibleRecords,
      evaluatedRecords: input.evaluatedRecords,
      selectedRecords: input.items.length,
      candidateScanLimit: input.candidateScanLimit,
      omitted: { ...input.omissions },
    },
    items: input.items,
    resumeCursor: { afterEventSequence: input.afterEventSequence },
  };
}

/** Resolve the self-referential byte count in at most a handful of digit changes. */
function measurePacket(packet: ReturnType<typeof packetObject>) {
  let usedTokens = 0;
  for (let iteration = 0; iteration < 16; iteration += 1) {
    packet.budget.usedTokens = usedTokens;
    packet.budget.measuredUtf8Bytes = usedTokens;
    const next = Buffer.byteLength(canonicalJson(packet), "utf8");
    if (next === usedTokens) return { packet, usedTokens };
    usedTokens = next;
  }
  throw new Error("Context packet byte measurement did not converge");
}

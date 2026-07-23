/**
 * Progress + ETA — pure read-only computation over the current DB state.
 *
 * No caching. Single-user, small datasets ; computing on the fly is well
 * under 10ms even with hundreds of tasks. If we ever scale past that,
 * add a `progress_cache` table — but not before.
 *
 * Two scopes :
 *   - Project progress : aggregates all tasks belonging to a project_id
 *   - Task progress    : aggregates a task + its descendant sub-tasks
 *
 * Both share the same shape so callers (CLI, agents, projection) can
 * render uniformly.
 *
 * ETA :
 *   - Computed from observed completion throughput of recent similar tasks
 *     (same area, last 30 days), never from summed lead times. Lead times
 *     overlap, so multiplying them by remaining work produces fake precision.
 *   - If sample size < ETA_MIN_SAMPLE_SIZE, no ETA returned (don't
 *     bullshit on tiny samples).
 *   - Single mean estimate ; not a confidence interval. Sample size is
 *     returned so callers can communicate honesty.
 */

import { and, eq, gt, isNull } from "drizzle-orm";
import { task, type Task as TaskT, Task as TaskZ, type Clock } from "@tasq-run/schema";
import type { TasqDb } from "../db.js";
import { getTaskTree } from "./tasks.js";
import { serviceNow } from "../util/clock.js";

export interface ProgressOptions {
  tenantId?: string;
  now?: number;
  clock?: Clock;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const ETA_WINDOW_MS = 30 * DAY_MS;
const ETA_MIN_SAMPLE_SIZE = 3;
const ETA_MIN_OBSERVATION_MS = 7 * DAY_MS;

export interface StatusCounts {
  total: number;
  open: number;
  in_progress: number;
  blocked: number;
  done: number;
  cancelled: number;
  /** total - cancelled, the denominator for the % */
  denominator: number;
}

export interface Eta {
  /** Mean observed interval between completions, in ms. */
  meanCompletionIntervalMs: number;
  /** Estimated remaining time from observed throughput, in ms. */
  remainingMs: number;
  /** Sample size used. */
  sampleSize: number;
  /** ISO timestamp of estimated completion (now + remainingMs). */
  estimatedCompletionAt: string;
}

export interface Progress {
  counts: StatusCounts;
  /** Percentage 0-100, rounded to nearest int. 100 only if denominator > 0 and done == denominator. */
  percentDone: number;
  /** Set only when sample size meets threshold and remaining > 0. */
  eta: Eta | null;
}

function countByStatus(tasks: readonly TaskT[]): StatusCounts {
  const counts: StatusCounts = {
    total: tasks.length,
    open: 0,
    in_progress: 0,
    blocked: 0,
    done: 0,
    cancelled: 0,
    denominator: 0,
  };
  for (const t of tasks) {
    counts[t.status]++;
  }
  counts.denominator = counts.total - counts.cancelled;
  return counts;
}

function computePercentDone(counts: StatusCounts): number {
  if (counts.denominator === 0) return 0;
  return Math.round((counts.done / counts.denominator) * 100);
}

/**
 * Pull "similar tasks completed in the last 30 days" for ETA computation.
 *
 * Similarity heuristic for v0.2 = "same area_id". Reasoning: area is the
 * coarsest natural grouping in tasq, and cycle times vary much more across
 * areas (sport session = hours, file declaration = days) than within.
 *
 * If `areaId` is null (e.g., orphan tasks), falls back to global mean.
 */
async function fetchEtaSample(
  db: TasqDb,
  tenantId: string,
  areaId: string | null,
  nowMs: number,
): Promise<TaskT[]> {
  const cutoff = nowMs - ETA_WINDOW_MS;
  const filters = [
    eq(task.tenantId, tenantId),
    eq(task.status, "done"),
    gt(task.completedAt, cutoff),
    isNull(task.deletedAt),
  ];
  if (areaId != null) filters.push(eq(task.areaId, areaId));

  const rows = await db
    .select()
    .from(task)
    .where(and(...filters));

  return rows.map((r) =>
    TaskZ.parse({
      ...r,
      metadata:
        typeof r.metadata === "string" ? JSON.parse(r.metadata) : r.metadata,
    }),
  );
}

/**
 * Build the ETA object given the sample and tasks remaining.
 * Returns null if sample is too small or nothing is left to do.
 */
async function computeEta(
  db: TasqDb,
  tenantId: string,
  areaId: string | null,
  tasksRemaining: number,
  nowMs: number,
): Promise<Eta | null> {
  if (tasksRemaining <= 0) return null;

  const sample = await fetchEtaSample(db, tenantId, areaId, nowMs);
  if (sample.length < ETA_MIN_SAMPLE_SIZE) return null;

  const completions = sample
    .map((t) => t.completedAt)
    .filter((value): value is number => value != null)
    .sort((a, b) => a - b);
  const observedMs = completions.at(-1)! - completions[0]!;
  // Several rows completed in one batch do not establish a delivery rate.
  if (observedMs < ETA_MIN_OBSERVATION_MS) return null;
  const meanCompletionIntervalMs = Math.round(observedMs / (completions.length - 1));

  const remainingMs = meanCompletionIntervalMs * tasksRemaining;
  return {
    meanCompletionIntervalMs,
    remainingMs,
    sampleSize: sample.length,
    estimatedCompletionAt: new Date(nowMs + remainingMs).toISOString(),
  };
}

// ──────────────────────────────────────────────────────────────────────
// Project progress
// ──────────────────────────────────────────────────────────────────────

export async function getProjectProgress(
  db: TasqDb,
  projectId: string,
  options: ProgressOptions = {},
): Promise<Progress> {
  const tenantId = options.tenantId ?? "gwendall";
  const nowMs = serviceNow(options, options.now);

  const rows = await db
    .select()
    .from(task)
    .where(
      and(
        eq(task.tenantId, tenantId),
        eq(task.projectId, projectId),
        isNull(task.deletedAt),
      ),
    );

  const tasks: TaskT[] = rows.map((r) =>
    TaskZ.parse({
      ...r,
      metadata:
        typeof r.metadata === "string" ? JSON.parse(r.metadata) : r.metadata,
    }),
  );

  const leafTasks = progressLeaves(tasks);
  const counts = countByStatus(leafTasks);
  const percentDone = computePercentDone(counts);

  // Pick the dominant area for the ETA sample (most-frequent areaId among project tasks)
  const areaId = dominantAreaId(leafTasks);
  const remaining = counts.open + counts.in_progress + counts.blocked;
  const eta = await computeEta(db, tenantId, areaId, remaining, nowMs);

  return { counts, percentDone, eta };
}

// ──────────────────────────────────────────────────────────────────────
// Task progress (a task + its descendants)
// ──────────────────────────────────────────────────────────────────────

export async function getTaskProgress(
  db: TasqDb,
  taskId: string,
  options: ProgressOptions = {},
): Promise<Progress | null> {
  const tenantId = options.tenantId ?? "gwendall";
  const nowMs = serviceNow(options, options.now);

  const tree = await getTaskTree(db, taskId, tenantId);
  if (!tree) return null;

  // Exclude the root itself from the counts so progress reflects sub-tasks.
  // If a task has no sub-tasks, progress is trivially 0% or 100% based on
  // its own status — we still return a Progress for symmetry, including
  // the root in counts in that case.
  const hasSubtasks = tree.length > 1;
  const subset = hasSubtasks ? progressLeaves(tree.slice(1)) : tree;

  const counts = countByStatus(subset);
  const percentDone = computePercentDone(counts);

  const root = tree[0]!;
  const remaining = counts.open + counts.in_progress + counts.blocked;
  const eta = await computeEta(db, tenantId, root.areaId, remaining, nowMs);

  return { counts, percentDone, eta };
}

// ──────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────

function dominantAreaId(tasks: readonly TaskT[]): string | null {
  const tally = new Map<string, number>();
  for (const t of tasks) {
    if (t.areaId == null) continue;
    tally.set(t.areaId, (tally.get(t.areaId) ?? 0) + 1);
  }
  let best: { id: string; n: number } | null = null;
  for (const [id, n] of tally) {
    if (best === null || n > best.n) best = { id, n };
  }
  return best?.id ?? null;
}

/** Count executable leaves, not both a planning container and its children. */
function progressLeaves(tasks: readonly TaskT[]): TaskT[] {
  const parentIds = new Set(
    tasks.map((candidate) => candidate.parentTaskId).filter((id): id is string => id != null),
  );
  return tasks.filter((candidate) => !parentIds.has(candidate.id));
}

export const PROGRESS_CONFIG = {
  ETA_WINDOW_MS,
  ETA_MIN_SAMPLE_SIZE,
  ETA_MIN_OBSERVATION_MS,
} as const;

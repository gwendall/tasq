/**
 * Prioritizer — the `tasq next` formula.
 *
 * Returns tasks sorted by a transparent score combining four signals:
 *
 *   score = LEVERAGE_WEIGHT * leverage
 *         + URGENCY_WEIGHT  * urgency
 *         + AVOIDANCE_WEIGHT * avoidance
 *         + ACTIVE_WEIGHT   * active
 *
 * Each component is normalized to [0, 5] so weights stay legible.
 *
 *   leverage  — derived from goal.importance (or area.importance if loose task).
 *               If the task has a `priority`, it overrides upward.
 *               High goal importance + matching priority = high leverage.
 *
 *   urgency   — derived from `due_at` and `scheduled_at`.
 *               • overdue (due_at < now)         → 5
 *               • due today                       → 4
 *               • due within 3 days               → 3
 *               • due within 7 days               → 2
 *               • due within 30 days              → 1
 *               • no due_at                       → 0
 *               If `scheduled_at <= now`, urgency floor is 2.
 *
 *   avoidance — derived from age in `open` state (or in `blocked`).
 *               • created > 14 days ago, never started → 5
 *               • > 7 days                              → 4
 *               • > 3 days                              → 3
 *               • > 1 day                               → 1
 *               If status is `blocked`, multiply by 0.5 (it's a known wait).
 *
 *   active    — "finish what you started" (SPEC §5.2.1's W_active term).
 *               • status == in_progress → 5
 *               • else                  → 0
 *               Without this term, an `open` task that has aged accrues
 *               avoidance, but the moment it becomes `in_progress` its
 *               avoidance drops to 0 — so *starting* a task would LOWER its
 *               score. The active term compensates: ACTIVE_WEIGHT*5 = 1.0
 *               exactly offsets the max avoidance contribution
 *               (AVOIDANCE_WEIGHT*5 = 1.0) an open task could have, so an
 *               in_progress task always scores >= the same task while it was
 *               untouched. (SPEC §5.2.1 specifies W_active=4.0 in the
 *               *additive* Taskwarrior model; in this normalized model the
 *               equivalent is ACTIVE_WEIGHT=0.2 × a [0,5] term.)
 *
 * Ties broken by (a) due_at ascending, (b) created_at ascending.
 *
 * The pure formula is owned by `@tasq-internal/life-planning-profile`. This file is
 * the compatibility adapter: it loads candidate views from the DB, applies
 * coordination filters, invokes the profile and preserves the historical
 * service exports.
 */

import { and, eq, inArray, isNull, or } from "drizzle-orm";
import {
  task,
  goal,
  area,
  project,
  Task as TaskZ,
  Goal as GoalZ,
  Area as AreaZ,
  Project as ProjectZ,
  type Task as TaskT,
  type Goal as GoalT,
  type Area as AreaT,
  type Project as ProjectT,
  type TaskClaim,
  type Clock,
} from "@tasq-run/schema";
import type { TasqDb } from "./db.js";
import { parseRow } from "./util/row.js";
import { unresolvedBlockerMap } from "./service/dependencies.js";
import { activeTaskClaimMap } from "./service/agentic.js";
import { scoreTask } from "@tasq-internal/life-planning-profile";
import { serviceNow } from "./util/clock.js";

export {
  LIFE_PRIORITIZER_CONFIG as PRIORITIZER_CONFIG,
  scoreTask,
} from "@tasq-internal/life-planning-profile";
export type {
  ScoreBreakdown,
  ScoreInputs,
} from "@tasq-internal/life-planning-profile";
import type { ScoreBreakdown } from "@tasq-internal/life-planning-profile";

// ──────────────────────────────────────────────────────────────────────
// `tasq next` — DB-aware
// ──────────────────────────────────────────────────────────────────────

export interface PickNextOptions {
  tenantId?: string;
  limit?: number;
  areaId?: string;
  goalId?: string;
  projectId?: string;
  /**
   * If true, parent tasks with open sub-tasks are also returned.
   * Default false — sub-tasks are the natural next-action ; surfacing the
   * parent too would be a duplicate distraction in the daily push.
   */
  includeParentsWithOpenSubtasks?: boolean;
  /**
   * Override the default defer filter. By default tasks with
   * `scheduledAt != null && scheduledAt > now` are EXCLUDED so deliberately
   * deferred work does not pollute `tasq next` (SPEC §5.2 / §5.2.1). Pass
   * `true` to surface deferred tasks too. The urgency floor for tasks whose
   * `scheduledAt <= now` is unchanged.
   */
  includeScheduled?: boolean;
  /** Requesting actor. Active claims owned by others are excluded by default. */
  actor?: string;
  /** Surface work currently claimed by another actor. */
  includeClaimed?: boolean;
  /** Override now() — useful for tests. */
  now?: number;
  clock?: Clock;
}

export interface NextResult {
  task: TaskT;
  goal: GoalT | null;
  area: AreaT | null;
  claim: TaskClaim | null;
  score: ScoreBreakdown;
}

/**
 * Return the next-action list sorted by score (descending).
 *
 * Considers only open / in_progress / blocked tasks (not done/cancelled),
 * excludes soft-deleted, applies optional area/goal/project filters,
 * loads their referenced goal + area, computes the score, sorts, slices.
 *
 * Tasks with open / in_progress / blocked sub-tasks are EXCLUDED from the
 * result by default — their sub-tasks are the real next-actions. Pass
 * `includeParentsWithOpenSubtasks: true` to override (useful for tree views).
 */
export async function pickNext(
  db: TasqDb,
  options: PickNextOptions = {},
): Promise<NextResult[]> {
  const tenantId = options.tenantId ?? "gwendall";
  const now = serviceNow(options, options.now);

  const candidateStatuses = ["open", "in_progress", "blocked"] as const;

  const filters = [
    eq(task.tenantId, tenantId),
    isNull(task.deletedAt),
    or(...candidateStatuses.map((s) => eq(task.status, s))),
  ];
  if (options.areaId) filters.push(eq(task.areaId, options.areaId));
  if (options.goalId) filters.push(eq(task.goalId, options.goalId));
  if (options.projectId) filters.push(eq(task.projectId, options.projectId));

  const taskRows = await db
    .select()
    .from(task)
    .where(and(...filters));

  if (taskRows.length === 0) return [];

  let tasks: TaskT[] = taskRows.map((r) => TaskZ.parse(parseRow(r)));

  // Default defer filter (SPEC §5.2.1): a task scheduled for the future is
  // hidden from the daily push until its `scheduledAt` arrives. Survivors with
  // `scheduledAt <= now` keep the urgency floor applied in computeUrgency.
  if (!options.includeScheduled) {
    tasks = tasks.filter((t) => t.scheduledAt == null || t.scheduledAt <= now);
  }

  // `next` is an action queue, not a status report. Manually blocked tasks are
  // visible in list/tree views but cannot be selected as the next action.
  tasks = tasks.filter((t) => t.status !== "blocked");

  // Default behavior: exclude parents that have open/in_progress/blocked sub-tasks.
  if (!options.includeParentsWithOpenSubtasks) {
    const parentIdsWithOpenChildren = new Set(
      tasks.map((t) => t.parentTaskId).filter((id): id is string => id != null),
    );
    tasks = tasks.filter((t) => !parentIdsWithOpenChildren.has(t.id));
  }

  // Batch-load referenced goals + areas
  const goalIds = Array.from(
    new Set(tasks.map((t) => t.goalId).filter((x): x is string => x != null)),
  );
  const areaIds = Array.from(
    new Set(tasks.map((t) => t.areaId).filter((x): x is string => x != null)),
  );
  const projectIds = Array.from(
    new Set(tasks.map((t) => t.projectId).filter((x): x is string => x != null)),
  );

  // Filter out soft-deleted goals/areas: a still-live task may point at a
  // tombstoned ancestor. Excluding them here means `goalById`/`areaById` lack
  // that id, so leverage falls back to area-or-default importance and the
  // misleading `goal-importance:` reason-trace is suppressed (SPEC §4.4: a
  // tombstone is excluded from every default query).
  const goalRows = goalIds.length
    ? await db
        .select()
        .from(goal)
        .where(and(inArray(goal.id, goalIds), isNull(goal.deletedAt)))
    : [];
  const areaRows = areaIds.length
    ? await db
        .select()
        .from(area)
        .where(and(inArray(area.id, areaIds), isNull(area.deletedAt)))
    : [];
  const projectRows = projectIds.length
    ? await db
        .select()
        .from(project)
        .where(and(inArray(project.id, projectIds), isNull(project.deletedAt)))
    : [];

  const goalById = new Map<string, GoalT>();
  for (const r of goalRows) {
    const parsed = GoalZ.parse(parseRow(r));
    goalById.set(parsed.id, parsed);
  }
  const areaById = new Map<string, AreaT>();
  for (const r of areaRows) {
    const parsed = AreaZ.parse(parseRow(r));
    areaById.set(parsed.id, parsed);
  }
  const projectById = new Map<string, ProjectT>();
  for (const r of projectRows) {
    const parsed = ProjectZ.parse(parseRow(r));
    projectById.set(parsed.id, parsed);
  }

  // Ancestor state is part of actionability. Work under a paused/done goal or
  // a blocked/waiting/done/cancelled project stays inspectable but does not
  // leak into the execution queue.
  tasks = tasks.filter((t) => {
    const linkedGoal = t.goalId ? goalById.get(t.goalId) : null;
    if (t.goalId && (!linkedGoal || linkedGoal.status !== "active")) return false;
    const linkedProject = t.projectId ? projectById.get(t.projectId) : null;
    if (t.projectId && (!linkedProject || linkedProject.status !== "active")) return false;
    return true;
  });

  // W_blocked down-weight input (SPEC §4.5 / §5.2.1). One tenant-scoped SELECT
  // of live `blocks` edges, aggregated in-memory against the already-loaded
  // task statuses — no N+1, no extra per-candidate query. The status map is
  // built from the UNFILTERED candidate rows (every live open/in_progress/
  // blocked task in the tenant), not the post-defer/parent-filtered `tasks`, so
  // a blocker that is itself deferred or parent-excluded still counts as a real
  // unresolved blocker. Blockers absent from the map are done/cancelled/deleted
  // (the SQL candidate filter already dropped them) → resolved. Blocked-by-dep
  // tasks are removed from the actionable result below; their status is not
  // auto-mutated, so list/tree views still represent the original state.
  const statusById = new Map<string, string>(
    taskRows.map((r) => [r.id as string, r.status as string]),
  );
  const blockerCounts = await unresolvedBlockerMap(db, tenantId, statusById);
  const claimByTask = await activeTaskClaimMap(db, tenantId, now);

  const scored: NextResult[] = tasks
    .filter((t) => (blockerCounts.get(t.id) ?? 0) === 0)
    .filter((t) => {
      if (options.includeClaimed) return true;
      const claim = claimByTask.get(t.id);
      return !claim || (options.actor != null && claim.actor === options.actor);
    })
    .map((t) => ({
    task: t,
    goal: t.goalId ? goalById.get(t.goalId) ?? null : null,
    area: t.areaId ? areaById.get(t.areaId) ?? null : null,
    claim: claimByTask.get(t.id) ?? null,
    score: scoreTask({
      task: t,
      goal: t.goalId ? goalById.get(t.goalId) ?? null : null,
      area: t.areaId ? areaById.get(t.areaId) ?? null : null,
      unresolvedBlockers: blockerCounts.get(t.id) ?? 0,
      now,
    }),
    }));

  scored.sort((a, b) => {
    if (a.score.total !== b.score.total) return b.score.total - a.score.total;
    // Tie-break 1: earlier due_at first (nulls last)
    const aDue = a.task.dueAt ?? Number.POSITIVE_INFINITY;
    const bDue = b.task.dueAt ?? Number.POSITIVE_INFINITY;
    if (aDue !== bDue) return aDue - bDue;
    // Tie-break 2: earlier created_at first
    return a.task.createdAt - b.task.createdAt;
  });

  return scored.slice(0, options.limit ?? 5);
}

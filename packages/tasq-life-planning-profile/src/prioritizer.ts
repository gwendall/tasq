/**
 * The historical `_life` next-action policy, expressed as a pure profile.
 *
 * Inputs are deliberately structural rather than Tasq database records. This
 * keeps planning policy replaceable and lets a minimal kernel omit this package.
 */

const LEVERAGE_WEIGHT = 0.5;
const URGENCY_WEIGHT = 0.3;
const AVOIDANCE_WEIGHT = 0.2;
const ACTIVE_WEIGHT = 0.2;
const BLOCKED_WEIGHT = 1.0;
const MISSING_NEXT_ACTION_PENALTY = 0.5;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface LifePlanningTask {
  status: string;
  priority: number | null;
  nextAction: string | null;
  createdAt: number;
  dueAt: number | null;
  scheduledAt: number | null;
  recurrence: "daily" | "weekly" | "monthly" | "yearly" | null;
  recurrenceInterval: number;
  lastDoneAt: number | null;
  streak: number;
}

export interface LifePlanningGoal {
  importance: number;
}

export interface LifePlanningArea {
  importance: number;
}

export interface ScoreInputs {
  task: LifePlanningTask;
  goal: LifePlanningGoal | null;
  area: LifePlanningArea | null;
  /** Number of unresolved dependencies blocking this commitment. */
  unresolvedBlockers?: number;
  /** Evaluation clock. Required so policy never reads a device clock. */
  now: number;
}

export interface ScoreBreakdown {
  total: number;
  leverage: number;
  urgency: number;
  avoidance: number;
  active: number;
  blocked: number;
  actionabilityPenalty: number;
  reasons: string[];
}

function cadencePeriodMs(
  unit: NonNullable<LifePlanningTask["recurrence"]>,
  interval: number,
): number {
  const n = Math.max(1, interval);
  switch (unit) {
    case "daily":
      return n * DAY_MS;
    case "weekly":
      return n * 7 * DAY_MS;
    case "monthly":
      return n * 30 * DAY_MS;
    case "yearly":
      return n * 365 * DAY_MS;
  }
}

export function scoreTask(inputs: ScoreInputs): ScoreBreakdown {
  const now = inputs.now;
  const reasons: string[] = [];

  const leverage = computeLeverage(inputs, reasons);
  const urgency = computeUrgency(inputs, now, reasons);
  const avoidance = computeAvoidance(inputs, now, reasons);
  const active = computeActive(inputs, reasons);

  const unresolvedBlockers = inputs.unresolvedBlockers ?? 0;
  const blocked = unresolvedBlockers > 0 ? BLOCKED_WEIGHT : 0;
  if (unresolvedBlockers > 0) reasons.push(`blocked-by:${unresolvedBlockers}`);

  if (inputs.task.streak > 0) reasons.push(`streak:${inputs.task.streak}`);

  const actionabilityPenalty =
    inputs.task.status === "open" && !inputs.task.nextAction
      ? MISSING_NEXT_ACTION_PENALTY
      : 0;
  if (actionabilityPenalty > 0) reasons.push("missing-next-action");

  const total =
    LEVERAGE_WEIGHT * leverage +
    URGENCY_WEIGHT * urgency +
    AVOIDANCE_WEIGHT * avoidance +
    ACTIVE_WEIGHT * active -
    blocked -
    actionabilityPenalty;

  return {
    total,
    leverage,
    urgency,
    avoidance,
    active,
    blocked,
    actionabilityPenalty,
    reasons,
  };
}

function computeLeverage(inputs: ScoreInputs, reasons: string[]): number {
  const importance = inputs.goal?.importance ?? inputs.area?.importance ?? 3;
  const priority = inputs.task.priority;
  const base = priority != null && priority > importance ? priority : importance;

  if (inputs.goal?.importance != null) {
    reasons.push(`goal-importance:${inputs.goal.importance}`);
  } else if (inputs.area?.importance != null) {
    reasons.push(`area-importance:${inputs.area.importance}`);
  }
  if (priority != null) reasons.push(`priority:${priority}`);

  return base;
}

function computeUrgency(
  inputs: ScoreInputs,
  now: number,
  reasons: string[],
): number {
  const { dueAt, scheduledAt } = inputs.task;

  let urgency = 0;
  if (dueAt != null) {
    const daysToDue = (dueAt - now) / DAY_MS;
    if (daysToDue < 0) {
      urgency = 5;
      reasons.push(`overdue:${Math.ceil(-daysToDue)}d`);
    } else if (daysToDue < 1) {
      urgency = 4;
      reasons.push("due-today");
    } else if (daysToDue < 3) {
      urgency = 3;
      reasons.push(`due-in-${Math.ceil(daysToDue)}d`);
    } else if (daysToDue < 7) {
      urgency = 2;
      reasons.push("due-this-week");
    } else if (daysToDue < 30) {
      urgency = 1;
      reasons.push("due-this-month");
    }
  }

  if (scheduledAt != null && scheduledAt <= now && urgency < 2) {
    urgency = 2;
    reasons.push("scheduled-now");
  }

  const { recurrence, lastDoneAt, recurrenceInterval } = inputs.task;
  if (
    recurrence != null &&
    lastDoneAt != null &&
    now - lastDoneAt > cadencePeriodMs(recurrence, recurrenceInterval) &&
    urgency < 2
  ) {
    urgency = 2;
    reasons.push("cadence-overdue");
  }

  return urgency;
}

function computeAvoidance(
  inputs: ScoreInputs,
  now: number,
  reasons: string[],
): number {
  const { task } = inputs;
  if (task.status !== "open" && task.status !== "blocked") return 0;

  const ageDays = (now - task.createdAt) / DAY_MS;
  let raw = 0;
  if (ageDays > 14) {
    raw = 5;
    reasons.push(`age:${Math.floor(ageDays)}d`);
  } else if (ageDays > 7) {
    raw = 4;
    reasons.push(`age:${Math.floor(ageDays)}d`);
  } else if (ageDays > 3) {
    raw = 3;
    reasons.push(`age:${Math.floor(ageDays)}d`);
  } else if (ageDays > 1) {
    raw = 1;
    reasons.push(`age:${Math.floor(ageDays)}d`);
  }

  if (task.status === "blocked") {
    raw *= 0.5;
    reasons.push("blocked-discount");
  }

  return raw;
}

function computeActive(inputs: ScoreInputs, reasons: string[]): number {
  if (inputs.task.status === "in_progress") {
    reasons.push("in-progress-boost");
    return 5;
  }
  return 0;
}

export const LIFE_PRIORITIZER_CONFIG = {
  LEVERAGE_WEIGHT,
  URGENCY_WEIGHT,
  AVOIDANCE_WEIGHT,
  ACTIVE_WEIGHT,
  BLOCKED_WEIGHT,
  MISSING_NEXT_ACTION_PENALTY,
} as const;

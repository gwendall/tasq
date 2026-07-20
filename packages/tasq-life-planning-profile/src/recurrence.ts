/** Pure recurrence policy for the bundled life-planning profile. */

export type LifeRecurrenceUnit = "daily" | "weekly" | "monthly" | "yearly";
export type LifeRecurrenceAnchor = "due" | "scheduled" | "completion";

export interface CompletedRecurringTask {
  id: string;
  dueAt: number | null;
  scheduledAt: number | null;
  recurrence: LifeRecurrenceUnit | null;
  recurrenceInterval: number;
  recurrenceAnchor: LifeRecurrenceAnchor;
  recurrenceParentId: string | null;
  streak: number;
}

export interface NextRecurrencePlan {
  unit: LifeRecurrenceUnit;
  interval: number;
  anchor: LifeRecurrenceAnchor;
  nextDueAt: number | null;
  nextScheduledAt: number | null;
  chainRootId: string;
  streak: number;
}

/** Step a timestamp by one recurrence interval using deterministic UTC rules. */
export function nextOccurrence(
  baseMs: number,
  unit: LifeRecurrenceUnit,
  interval: number,
): number {
  const step = Math.max(1, Math.trunc(interval));
  if (unit === "daily") return baseMs + step * 24 * 60 * 60 * 1000;
  if (unit === "weekly") return baseMs + step * 7 * 24 * 60 * 60 * 1000;

  const date = new Date(baseMs);
  const day = date.getUTCDate();
  date.setUTCDate(1);
  if (unit === "monthly") date.setUTCMonth(date.getUTCMonth() + step);
  else date.setUTCFullYear(date.getUTCFullYear() + step);
  clampUtcDayOfMonth(date, day);
  return date.getTime();
}

/**
 * Decide the next recurrence instance without persistence or kernel records.
 * The host remains responsible for atomically materializing the returned plan.
 */
export function planNextRecurrence(
  completed: CompletedRecurringTask,
  now: number,
): NextRecurrencePlan {
  const unit = completed.recurrence;
  if (unit == null) throw new Error("Cannot plan recurrence for a non-recurring task");
  const interval = Math.max(1, Math.trunc(completed.recurrenceInterval));
  const anchor = completed.recurrenceAnchor;
  const anchorBase = anchor === "scheduled"
    ? completed.scheduledAt ?? now
    : anchor === "completion"
      ? now
      : completed.dueAt ?? now;
  const nextAt = nextOccurrence(anchorBase, unit, interval);

  let nextDueAt = completed.dueAt == null
    ? null
    : anchor === "completion"
      ? nextAt
      : nextOccurrence(completed.dueAt, unit, interval);
  let nextScheduledAt = completed.scheduledAt == null
    ? null
    : anchor === "completion"
      ? nextAt
      : nextOccurrence(completed.scheduledAt, unit, interval);
  if (completed.dueAt == null && completed.scheduledAt == null) {
    if (anchor === "scheduled") nextScheduledAt = nextAt;
    else nextDueAt = nextAt;
  }

  const expectedAt = anchor === "due"
    ? completed.dueAt
    : anchor === "scheduled"
      ? completed.scheduledAt
      : null;
  const missedAtLeastOneCadence = expectedAt != null &&
    now >= nextOccurrence(expectedAt, unit, interval);

  return {
    unit,
    interval,
    anchor,
    nextDueAt,
    nextScheduledAt,
    chainRootId: completed.recurrenceParentId ?? completed.id,
    streak: missedAtLeastOneCadence ? 1 : completed.streak + 1,
  };
}

function clampUtcDayOfMonth(date: Date, desiredDay: number): void {
  const lastDay = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0),
  ).getUTCDate();
  date.setUTCDate(Math.min(desiredDay, lastDay));
}

import { describe, expect, test } from "bun:test";
import { nextOccurrence, planNextRecurrence } from "../src/index.js";

const DAY = 24 * 60 * 60 * 1000;

describe("bundled recurrence policy", () => {
  test("uses deterministic UTC calendar stepping with month-end clamping", () => {
    const january31 = Date.UTC(2025, 0, 31, 12);
    expect(new Date(nextOccurrence(january31, "monthly", 1)).toISOString())
      .toBe("2025-02-28T12:00:00.000Z");
    const leapDay = Date.UTC(2024, 1, 29, 12);
    expect(new Date(nextOccurrence(leapDay, "yearly", 1)).toISOString())
      .toBe("2025-02-28T12:00:00.000Z");
  });

  test("plans materialization without database or kernel records", () => {
    const dueAt = Date.UTC(2026, 6, 15, 12);
    const scheduledAt = dueAt - DAY;
    const plan = planNextRecurrence({
      id: "instance",
      dueAt,
      scheduledAt,
      recurrence: "weekly",
      recurrenceInterval: 2,
      recurrenceAnchor: "due",
      recurrenceParentId: "root",
      streak: 4,
    }, dueAt + DAY);

    expect(plan).toEqual({
      unit: "weekly",
      interval: 2,
      anchor: "due",
      nextDueAt: dueAt + 14 * DAY,
      nextScheduledAt: scheduledAt + 14 * DAY,
      chainRootId: "root",
      streak: 5,
    });
  });

  test("resets a missed streak and requires a recurring input", () => {
    const dueAt = Date.UTC(2026, 6, 1);
    expect(planNextRecurrence({
      id: "instance",
      dueAt,
      scheduledAt: null,
      recurrence: "daily",
      recurrenceInterval: 1,
      recurrenceAnchor: "due",
      recurrenceParentId: null,
      streak: 9,
    }, dueAt + 2 * DAY).streak).toBe(1);

    expect(() => planNextRecurrence({
      id: "instance",
      dueAt: null,
      scheduledAt: null,
      recurrence: null,
      recurrenceInterval: 1,
      recurrenceAnchor: "completion",
      recurrenceParentId: null,
      streak: 0,
    }, dueAt)).toThrow(/non-recurring/);
  });
});

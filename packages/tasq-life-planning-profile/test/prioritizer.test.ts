import { describe, expect, test } from "bun:test";
import {
  LIFE_PRIORITIZER_CONFIG,
  renderLifePlanningMarkdown,
  scoreTask,
  type LifePlanningProjectionTask,
  type LifePlanningTask,
} from "../src/index.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 6, 15, 12);

function task(overrides: Partial<LifePlanningTask> = {}): LifePlanningTask {
  return {
    status: "open",
    priority: null,
    nextAction: "Open the relevant file",
    createdAt: NOW,
    dueAt: null,
    scheduledAt: null,
    recurrence: null,
    recurrenceInterval: 1,
    lastDoneAt: null,
    streak: 0,
    ...overrides,
  };
}

describe("bundled life-planning policy", () => {
  test("is deterministic over structural inputs", () => {
    const input = {
      task: task({ createdAt: NOW - 15 * DAY_MS, dueAt: NOW - DAY_MS }),
      goal: { importance: 5 },
      area: { importance: 2 },
      now: NOW,
    };

    expect(scoreTask(input)).toEqual(scoreTask(input));
    expect(scoreTask(input).reasons).toEqual([
      "goal-importance:5",
      "overdue:1d",
      "age:15d",
    ]);
  });

  test("keeps planning heuristics outside kernel state", () => {
    const base = scoreTask({ task: task(), goal: null, area: null, now: NOW });
    const blocked = scoreTask({
      task: task(),
      goal: null,
      area: null,
      unresolvedBlockers: 1,
      now: NOW,
    });

    expect(blocked.total).toBe(base.total - LIFE_PRIORITIZER_CONFIG.BLOCKED_WEIGHT);
    expect(blocked.reasons).toContain("blocked-by:1");
  });

  test("renders the human surface from structural views only", () => {
    const inboxTask: LifePlanningProjectionTask = {
      ...task({ dueAt: NOW + DAY_MS }),
      id: "01800000-0000-7000-8000-000000000001",
      title: "Review the brief",
      areaId: null,
      goalId: null,
      projectId: null,
      parentTaskId: null,
      successCriteria: "Comments are resolved",
      completionMode: "assertion",
      completedAt: null,
      updatedAt: NOW,
    };

    const markdown = renderLifePlanningMarkdown({
      areas: [],
      goals: [],
      projects: [],
      tasks: [inboxTask],
      next: [],
      now: NOW,
      sourceLabel: "structural fixture",
    });

    expect(markdown).toContain("Source of truth: structural fixture");
    expect(markdown).toContain("## 📥 Inbox (no area assigned)");
    expect(markdown).toContain("Review the brief ⏰ tomorrow");
    expect(markdown).toContain("✓ done when: Comments are resolved");
    expect(markdown).toContain("`01800000-0000-7000`");
  });
});

/**
 * Eval: prioritizer quality on realistic datasets.
 *
 * The prioritizer is the heart of the agent experience. If it puts
 * "newsletter triage" above "wire the $58k Flamingo payment", the whole
 * system is dysfunctional. These evals check the formula behaves the way
 * a human would expect on plausible scenarios.
 */

import { describe, expect, it } from "bun:test";
import { scoreTask, type Task, type Goal, type Area } from "@tasq-internal/local-service";

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_750_000_000_000;

function task(over: Partial<Task>): Task {
  return {
    id: "01900000-0000-7000-8000-000000000000",
    tenantId: "gwendall",
    projectId: null,
    goalId: null,
    areaId: null,
    parentTaskId: null,
    title: "test",
    description: null,
    nextAction: null,
    successCriteria: null,
    completionMode: "assertion",
    status: "open",
    priority: null,
    estimatedMinutes: null,
    scheduledAt: null,
    dueAt: null,
    startedAt: null,
    completedAt: null,
    recurrence: null,
    recurrenceInterval: 1,
    recurrenceAnchor: "due",
    lastDoneAt: null,
    streak: 0,
    recurrenceParentId: null,
    metadata: {},
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt: null,
    ...over,
  };
}

const HIGH_GOAL: Goal = {
  id: "g",
  tenantId: "gwendall",
  areaId: "a",
  title: "Ship Kami Series A",
  description: null,
  horizon: "Q2 2027",
  importance: 5,
  status: "active",
  targetDate: null,
  metadata: {},
  createdAt: NOW,
  updatedAt: NOW,
  deletedAt: null,
};

const LOW_GOAL: Goal = { ...HIGH_GOAL, id: "lg", title: "Random low-priority", importance: 1 };

const HIGH_AREA: Area = {
  id: "a",
  tenantId: "gwendall",
  name: "Career — Kami",
  slug: "kami",
  importance: 5,
  cadenceTarget: "daily",
  description: null,
  metadata: {},
  createdAt: NOW,
  updatedAt: NOW,
  deletedAt: null,
};

describe("Prioritizer quality on realistic comparisons", () => {
  it("overdue urgent task scores higher than scary-avoided low-urgency task", () => {
    const overdue = task({
      title: "Wire payment (deadline yesterday)",
      dueAt: NOW - DAY,
    });
    const avoided = task({
      title: "Hire first engineer (avoided 30 days)",
      createdAt: NOW - 30 * DAY,
    });

    const sOverdue = scoreTask({ task: overdue, goal: HIGH_GOAL, area: HIGH_AREA, now: NOW });
    const sAvoided = scoreTask({ task: avoided, goal: HIGH_GOAL, area: HIGH_AREA, now: NOW });

    expect(sOverdue.total).toBeGreaterThan(sAvoided.total);
  });

  it("scary high-leverage task scores higher than fresh low-priority task", () => {
    const scary = task({
      title: "Hire first engineer",
      createdAt: NOW - 14 * DAY,
    });
    const fresh = task({
      title: "Read newsletter",
      createdAt: NOW - 2 * 60 * 60 * 1000, // 2h old
      priority: 1,
    });

    const sScary = scoreTask({ task: scary, goal: HIGH_GOAL, area: HIGH_AREA, now: NOW });
    const sFresh = scoreTask({ task: fresh, goal: LOW_GOAL, area: HIGH_AREA, now: NOW });

    expect(sScary.total).toBeGreaterThan(sFresh.total);
  });

  it("priority override: high task priority beats medium goal importance", () => {
    const lowGoalHighPrio = task({
      title: "Urgent thing in low-importance area",
      priority: 5,
    });
    const sLowGoalHighPrio = scoreTask({
      task: lowGoalHighPrio,
      goal: LOW_GOAL,
      area: { ...HIGH_AREA, importance: 2 },
      now: NOW,
    });
    expect(sLowGoalHighPrio.leverage).toBe(5);
  });

  it("blocked tasks discounted compared to plain open with same age", () => {
    const openOld = task({ status: "open", createdAt: NOW - 20 * DAY });
    const blockedOld = task({ status: "blocked", createdAt: NOW - 20 * DAY });

    const sOpen = scoreTask({ task: openOld, goal: null, area: null, now: NOW });
    const sBlocked = scoreTask({ task: blockedOld, goal: null, area: null, now: NOW });

    expect(sBlocked.avoidance).toBeLessThan(sOpen.avoidance);
  });

  it("in_progress tasks have zero avoidance (currently engaged, not avoided)", () => {
    const inProgress = task({ status: "in_progress", createdAt: NOW - 30 * DAY });
    const s = scoreTask({ task: inProgress, goal: HIGH_GOAL, area: null, now: NOW });
    expect(s.avoidance).toBe(0);
    // The avoidance an open task would have accrued is replaced by the
    // explicit active boost (SPEC §5.2.1 W_active — "finish what you started").
    expect(s.active).toBe(5);
    expect(s.reasons).toContain("in-progress-boost");
  });

  it("starting a task never lowers its score (in_progress boost ≥ lost avoidance)", () => {
    // Same task, same age, same goal — only the status differs. Before the
    // W_active term, the open task accrued avoidance and the in_progress one
    // did not, so *starting* it dropped its score. The active boost must fully
    // compensate so engaged work ranks at least as high as untouched work.
    const aged = { createdAt: NOW - 20 * DAY };
    const open = task({ ...aged, status: "open" });
    const inProgress = task({ ...aged, status: "in_progress" });

    const sOpen = scoreTask({ task: open, goal: HIGH_GOAL, area: null, now: NOW });
    const sInProgress = scoreTask({ task: inProgress, goal: HIGH_GOAL, area: null, now: NOW });

    expect(sInProgress.total).toBeGreaterThanOrEqual(sOpen.total);
    expect(sInProgress.reasons).toContain("in-progress-boost");
    // open tasks must NOT get the boost
    expect(sOpen.active).toBe(0);
    expect(sOpen.reasons).not.toContain("in-progress-boost");
  });

  it("no goal, no area: still scores something via the default importance of 3", () => {
    const orphan = task({ title: "Random thought" });
    const s = scoreTask({ task: orphan, goal: null, area: null, now: NOW });
    // Default importance = 3, default urgency = 0, default avoidance = 0 for fresh task
    expect(s.leverage).toBe(3);
    expect(s.urgency).toBe(0);
    expect(s.avoidance).toBe(0);
    expect(s.total).toBe(1); // leverage 1.5 minus missing-next-action friction 0.5
    expect(s.reasons).toContain("missing-next-action");
  });

  it("reasons trace the formula for explainability", () => {
    const t = task({
      dueAt: NOW + 2 * DAY,
      priority: 4,
      createdAt: NOW - 10 * DAY,
    });
    const s = scoreTask({ task: t, goal: HIGH_GOAL, area: HIGH_AREA, now: NOW });
    expect(s.reasons.length).toBeGreaterThan(0);
    expect(s.reasons.join(" ")).toContain("goal-importance:5");
    expect(s.reasons.join(" ")).toContain("priority:4");
    expect(s.reasons.join(" ")).toContain("due-in");
  });
});

describe("Prioritizer balance — sanity comparisons", () => {
  it("same leverage, different urgency: more urgent wins", () => {
    const t1 = task({ dueAt: NOW + DAY }); // due tomorrow
    const t2 = task({ dueAt: NOW + 7 * DAY }); // due in a week
    const s1 = scoreTask({ task: t1, goal: HIGH_GOAL, area: null, now: NOW });
    const s2 = scoreTask({ task: t2, goal: HIGH_GOAL, area: null, now: NOW });
    expect(s1.urgency).toBeGreaterThan(s2.urgency);
    expect(s1.total).toBeGreaterThan(s2.total);
  });

  it("same urgency, different leverage: higher goal importance wins", () => {
    const t1 = task({ dueAt: NOW + DAY });
    const t2 = task({ dueAt: NOW + DAY });
    const s1 = scoreTask({ task: t1, goal: HIGH_GOAL, area: null, now: NOW });
    const s2 = scoreTask({ task: t2, goal: LOW_GOAL, area: null, now: NOW });
    expect(s1.leverage).toBeGreaterThan(s2.leverage);
    expect(s1.total).toBeGreaterThan(s2.total);
  });
});

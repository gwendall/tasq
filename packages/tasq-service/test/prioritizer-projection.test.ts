/**
 * Tests for the prioritizer + markdown projection.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  openDb,
  runMigrations,
  createArea,
  createGoal,
  createProject,
  updateProject,
  createTask,
  completeTask,
  cancelTask,
  startTask,
  dependTask,
  pickNext,
  scoreTask,
  renderProjection,
  shortId,
  PRIORITIZER_CONFIG,
  type Goal,
  type Task,
} from "../src/index.js";

const tmpDirs: string[] = [];

afterEach(() => {
  while (tmpDirs.length > 0) {
    const d = tmpDirs.pop()!;
    rmSync(d, { recursive: true, force: true });
  }
});

async function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "tasq-test-"));
  tmpDirs.push(dir);
  const url = `file:${join(dir, "db.sqlite")}`;
  const h = await openDb({ url, wal: false });
  await runMigrations(h.client);
  return h;
}

const DAY_MS = 24 * 60 * 60 * 1000;

describe("prioritizer score formula (pure)", () => {
  it("urgency: due today scores 4", () => {
    const now = 1_700_000_000_000;
    const task = baseTask({ dueAt: now + 6 * 60 * 60 * 1000 }); // 6h from now
    const score = scoreTask({ task, goal: null, area: null, now });
    expect(score.urgency).toBe(4);
    expect(score.reasons).toContain("due-today");
  });

  it("urgency: overdue scores 5", () => {
    const now = 1_700_000_000_000;
    const task = baseTask({ dueAt: now - 2 * DAY_MS });
    const score = scoreTask({ task, goal: null, area: null, now });
    expect(score.urgency).toBe(5);
  });

  it("avoidance: older open task scores higher", () => {
    const now = 1_700_000_000_000;
    const old = baseTask({ createdAt: now - 20 * DAY_MS });
    const fresh = baseTask({ createdAt: now - 12 * 60 * 60 * 1000 });
    expect(scoreTask({ task: old, goal: null, area: null, now }).avoidance).toBe(5);
    expect(scoreTask({ task: fresh, goal: null, area: null, now }).avoidance).toBe(0);
  });

  it("leverage: goal importance dominates", () => {
    const now = 1_700_000_000_000;
    const t = baseTask({});
    const lowGoal = baseGoal({ importance: 1 });
    const highGoal = baseGoal({ importance: 5 });
    expect(scoreTask({ task: t, goal: lowGoal, area: null, now }).leverage).toBe(1);
    expect(scoreTask({ task: t, goal: highGoal, area: null, now }).leverage).toBe(5);
  });

  it("blocked tasks have discounted avoidance", () => {
    const now = 1_700_000_000_000;
    const open = baseTask({ createdAt: now - 20 * DAY_MS, status: "open" });
    const blocked = baseTask({ createdAt: now - 20 * DAY_MS, status: "blocked" });
    const openScore = scoreTask({ task: open, goal: null, area: null, now });
    const blockedScore = scoreTask({ task: blocked, goal: null, area: null, now });
    expect(blockedScore.avoidance).toBeLessThan(openScore.avoidance);
    expect(blockedScore.reasons).toContain("blocked-discount");
  });

  it("W_blocked: unresolved blockers strictly lower the score + add a reason", () => {
    const now = 1_700_000_000_000;
    const t = baseTask({ dueAt: now + 6 * 60 * 60 * 1000 });
    const free = scoreTask({ task: t, goal: null, area: null, now });
    const blocked = scoreTask({ task: t, goal: null, area: null, unresolvedBlockers: 2, now });
    expect(blocked.total).toBeLessThan(free.total);
    expect(blocked.total).toBeCloseTo(free.total - PRIORITIZER_CONFIG.BLOCKED_WEIGHT, 10);
    expect(blocked.blocked).toBe(PRIORITIZER_CONFIG.BLOCKED_WEIGHT);
    expect(blocked.reasons).toContain("blocked-by:2");
    // The penalty is binary (any unresolved blocker), not proportional.
    const blockedOne = scoreTask({ task: t, goal: null, area: null, unresolvedBlockers: 1, now });
    expect(blockedOne.blocked).toBe(blocked.blocked);
  });

  it("W_blocked: omitting unresolvedBlockers is byte-identical to 0 (baseline guard)", () => {
    const now = 1_700_000_000_000;
    const t = baseTask({ dueAt: now + 6 * 60 * 60 * 1000, priority: 4 });
    const omitted = scoreTask({ task: t, goal: null, area: null, now });
    const zero = scoreTask({ task: t, goal: null, area: null, unresolvedBlockers: 0, now });
    expect(omitted.total).toBe(zero.total);
    expect(omitted.blocked).toBe(0);
    expect(omitted.reasons).not.toContain("blocked-by:0");
  });

  it("cadence-overdue: a recurring task last done past its cadence period gets urgency floor 2", () => {
    const now = 1_700_000_000_000;
    // weekly cadence, last done 10 days ago → overdue against cadence.
    const overdue = baseTask({
      recurrence: "weekly",
      recurrenceInterval: 1,
      lastDoneAt: now - 10 * DAY_MS,
    });
    const s = scoreTask({ task: overdue, goal: null, area: null, now });
    expect(s.urgency).toBe(2);
    expect(s.reasons).toContain("cadence-overdue");
  });

  it("cadence-overdue: a recurring task done recently does NOT get the floor", () => {
    const now = 1_700_000_000_000;
    const fresh = baseTask({
      recurrence: "weekly",
      recurrenceInterval: 1,
      lastDoneAt: now - 2 * DAY_MS, // well within the 7-day cadence
    });
    const s = scoreTask({ task: fresh, goal: null, area: null, now });
    expect(s.urgency).toBe(0);
    expect(s.reasons).not.toContain("cadence-overdue");
  });

  it("cadence-overdue never lowers a stronger due-date urgency", () => {
    const now = 1_700_000_000_000;
    const overdueDue = baseTask({
      recurrence: "weekly",
      lastDoneAt: now - 30 * DAY_MS,
      dueAt: now - 1 * DAY_MS, // overdue due-date → urgency 5
    });
    const s = scoreTask({ task: overdueDue, goal: null, area: null, now });
    expect(s.urgency).toBe(5); // due-date dominates; floor does not pull it down
  });

  it("streak is SURFACED in reasons but does NOT change the score (anti-pattern #19)", () => {
    const now = 1_700_000_000_000;
    const noStreak = baseTask({ priority: 4, dueAt: now + 6 * 60 * 60 * 1000, streak: 0 });
    const withStreak = baseTask({ priority: 4, dueAt: now + 6 * 60 * 60 * 1000, streak: 7 });
    const a = scoreTask({ task: noStreak, goal: null, area: null, now });
    const b = scoreTask({ task: withStreak, goal: null, area: null, now });
    expect(b.total).toBe(a.total); // identical score
    expect(b.reasons).toContain("streak:7");
    expect(a.reasons).not.toContain("streak:0");
  });
});

describe("pickNext — DB-aware", () => {
  it("orders by score, due-then-created tie-break", async () => {
    const { db, close } = await freshDb();
    try {
      const now = Date.now();
      const career = await createArea(db, {
        name: "Career",
        slug: "career",
        importance: 5,
      });
      const body = await createArea(db, {
        name: "Body",
        slug: "body",
        importance: 5,
      });

      const careerGoal = await createGoal(db, {
        areaId: career.id,
        title: "Ship Kami SAS",
        importance: 5,
      });
      const bodyGoal = await createGoal(db, {
        areaId: body.id,
        title: "Strong at 65",
        importance: 5,
      });

      // a low-leverage fresh task
      await createTask(db, {
        title: "Read newsletter",
        areaId: career.id,
      });
      // a high-leverage scary task (avoided 20 days, no due_at)
      const scary = await createTask(db, {
        title: "Hire 1st engineer",
        areaId: career.id,
        goalId: careerGoal.id,
      });
      // simulate creation 20d ago via a direct event log entry would mean
      // editing createdAt directly; for the test, we set up the DB then
      // pass `now` 20d in the future to pickNext.

      // an urgent due task
      await createTask(db, {
        title: "File 3916",
        areaId: career.id,
        goalId: careerGoal.id,
        dueAt: now + 2 * DAY_MS, // urgent
      });

      // body sport
      await createTask(db, {
        title: "Sport session",
        areaId: body.id,
        goalId: bodyGoal.id,
      });

      const futureNow = now + 20 * DAY_MS;
      const next = await pickNext(db, { limit: 5, now: futureNow });
      expect(next.length).toBeGreaterThan(0);

      // Top result should have a non-zero score
      expect(next[0]!.score.total).toBeGreaterThan(0);
      // Sorted descending
      for (let i = 1; i < next.length; i++) {
        expect(next[i - 1]!.score.total).toBeGreaterThanOrEqual(next[i]!.score.total);
      }
    } finally {
      await close();
    }
  });

  it("respects area filter", async () => {
    const { db, close } = await freshDb();
    try {
      const a = await createArea(db, { name: "A", slug: "a", importance: 3 });
      const b = await createArea(db, { name: "B", slug: "b", importance: 3 });
      await createTask(db, { title: "ta", areaId: a.id });
      await createTask(db, { title: "tb1", areaId: b.id });
      await createTask(db, { title: "tb2", areaId: b.id });

      const onlyA = await pickNext(db, { areaId: a.id });
      expect(onlyA).toHaveLength(1);
      expect(onlyA[0]!.task.title).toBe("ta");

      const onlyB = await pickNext(db, { areaId: b.id });
      expect(onlyB).toHaveLength(2);
    } finally {
      await close();
    }
  });

  it("does not surface work under a non-active project", async () => {
    const { db, close } = await freshDb();
    try {
      const p = await createProject(db, { title: "waiting project" });
      const t = await createTask(db, { title: "not actionable", projectId: p.id });
      await updateProject(db, p.id, { status: "waiting" });
      const next = await pickNext(db, { limit: 10 });
      expect(next.some((result) => result.task.id === t.id)).toBe(false);
    } finally {
      await close();
    }
  });

  it("excludes blocked-by-dependency work until its blocker resolves", async () => {
    const { db, close } = await freshDb();
    try {
      const now = Date.now();
      const a = await createArea(db, { name: "A", slug: "a", importance: 3 });
      // Two otherwise-identical candidate tasks + a separate live blocker.
      const peer = await createTask(db, { title: "unblocked-peer", areaId: a.id });
      const dependent = await createTask(db, { title: "blocked-dependent", areaId: a.id });
      const blocker = await createTask(db, { title: "the-blocker", areaId: a.id });
      await dependTask(db, { fromTaskId: dependent.id, toTaskId: blocker.id });

      const next = await pickNext(db, { now, limit: 10 });
      const titles = next.map((r) => r.task.title);
      expect(titles).toContain("unblocked-peer");
      expect(titles).not.toContain("blocked-dependent");

      // Resolving the blocker removes the down-weight on the next run.
      await completeTask(db, blocker.id);
      const after = await pickNext(db, { now, limit: 10 });
      const depAfter = after.find((r) => r.task.title === "blocked-dependent")!;
      expect(depAfter).toBeDefined();
      expect(depAfter.score.blocked).toBe(0);
    } finally {
      await close();
    }
  });

  it("hides deferred tasks (scheduledAt > now) by default, override surfaces them", async () => {
    const { db, close } = await freshDb();
    try {
      const now = Date.now();
      const a = await createArea(db, { name: "A", slug: "a", importance: 3 });
      await createTask(db, { title: "now-task", areaId: a.id });
      await createTask(db, {
        title: "deferred-task",
        areaId: a.id,
        scheduledAt: now + 7 * DAY_MS,
      });

      // Default: deferred task is excluded.
      const def = await pickNext(db, { now });
      expect(def).toHaveLength(1);
      expect(def[0]!.task.title).toBe("now-task");

      // Override: both surface.
      const all = await pickNext(db, { now, includeScheduled: true });
      expect(all.map((r) => r.task.title).sort()).toEqual([
        "deferred-task",
        "now-task",
      ]);
    } finally {
      await close();
    }
  });

  it("keeps the urgency floor once scheduledAt <= now (still returned by default)", async () => {
    const { db, close } = await freshDb();
    try {
      const now = Date.now();
      const a = await createArea(db, { name: "A", slug: "a", importance: 3 });
      await createTask(db, {
        title: "past-scheduled",
        areaId: a.id,
        scheduledAt: now - 1 * DAY_MS, // already due to surface
      });

      // Not deferred (scheduledAt <= now) → still returned by default.
      const def = await pickNext(db, { now });
      expect(def).toHaveLength(1);
      expect(def[0]!.task.title).toBe("past-scheduled");

      // Floor preserved: scoreTask yields urgency >= 2 with reason 'scheduled-now'.
      const score = scoreTask({
        task: baseTask({ scheduledAt: now - 1 * DAY_MS }),
        goal: null,
        area: null,
        now,
      });
      expect(score.urgency).toBeGreaterThanOrEqual(2);
      expect(score.reasons).toContain("scheduled-now");
    } finally {
      await close();
    }
  });
});

describe("renderProjection — markdown", () => {
  it("includes recently cancelled tasks in the closed section", async () => {
    const { db, close } = await freshDb();
    try {
      const cancelled = await createTask(db, { title: "cancelled recently" });
      await cancelTask(db, cancelled.id);
      const markdown = await renderProjection(db, { now: Date.now() });
      expect(markdown).toContain("cancelled recently");
      expect(markdown).toContain("Closed in last 30 days");
    } finally {
      await close();
    }
  });

  it("renders areas, goals, projects, tasks + top priorities + closed section", async () => {
    const { db, close } = await freshDb();
    try {
      const kami = await createArea(db, {
        name: "Career — Kami",
        slug: "kami",
        importance: 5,
        cadenceTarget: "daily",
      });
      const goal = await createGoal(db, {
        areaId: kami.id,
        title: "Ship Series A pitch",
        horizon: "Q2 2027",
        importance: 5,
      });
      const proj = await createProject(db, {
        title: "Pitch deck v1",
        goalId: goal.id,
        areaId: kami.id,
      });
      const t1 = await createTask(db, {
        title: "Outline 10 slides",
        nextAction: "Open Keynote, create outline",
        projectId: proj.id,
        goalId: goal.id,
        areaId: kami.id,
        priority: 5,
      });
      const t2 = await createTask(db, {
        title: "Newsletter triage",
        areaId: kami.id,
      });
      // close one
      await completeTask(db, t2.id, { note: "done" });

      const md = await renderProjection(db);

      expect(md).toContain("AUTO-GENERATED by tasq");
      expect(md).toContain("TASKS.md");
      expect(md).toContain("Career — Kami");
      expect(md).toContain("Ship Series A pitch");
      expect(md).toContain("Pitch deck v1");
      expect(md).toContain("Outline 10 slides");
      expect(md).toContain("Open Keynote");
      expect(md).toContain("Closed in last 30 days");
      expect(md).toContain("Newsletter triage");
      // Short id should be present
      expect(md).toContain(shortId(t1.id));
    } finally {
      await close();
    }
  });

  it("renders inbox section for tasks without area", async () => {
    const { db, close } = await freshDb();
    try {
      await createTask(db, {
        title: "Random thought",
        nextAction: "Decide where this belongs",
      });
      const md = await renderProjection(db);
      expect(md).toContain("📥 Inbox");
      expect(md).toContain("Random thought");
    } finally {
      await close();
    }
  });
});

// ──────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────

function baseTask(over: Partial<Task>): Task {
  return {
    id: "01900000-0000-7000-8000-000000000000",
    tenantId: "gwendall",
    projectId: null,
    goalId: null,
    areaId: null,
    title: "test",
    description: null,
    nextAction: null,
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
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    deletedAt: null,
    ...over,
  };
}

function baseGoal(over: Partial<Goal>): Goal {
  return {
    id: "01900000-0000-7000-8000-000000000001",
    tenantId: "gwendall",
    areaId: "01900000-0000-7000-8000-00000000aaaa",
    title: "test goal",
    description: null,
    horizon: null,
    importance: 3,
    status: "active",
    targetDate: null,
    metadata: {},
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    deletedAt: null,
    ...over,
  };
}

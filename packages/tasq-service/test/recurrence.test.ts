/**
 * Recurrence (SPEC §6.4-H) — the pure `nextOccurrence` stepper + the
 * materializer wired through the public `completeTask` verb.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  openDb,
  runMigrations,
  createTask,
  completeTask,
  cancelTask,
  reopenTask,
  listTasks,
  listEvents,
  getTask,
  nextOccurrence,
} from "../src/index.js";

const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length > 0) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

async function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "tasq-recur-"));
  tmpDirs.push(dir);
  const h = await openDb({ url: `file:${join(dir, "db.sqlite")}`, wal: false });
  await runMigrations(h.client);
  return h;
}

const DAY = 24 * 60 * 60 * 1000;

describe("nextOccurrence (pure)", () => {
  it("daily steps by interval days", () => {
    const base = Date.UTC(2026, 0, 10, 9, 0, 0); // 2026-01-10 09:00 UTC
    expect(nextOccurrence(base, "daily", 1)).toBe(base + DAY);
    expect(nextOccurrence(base, "daily", 3)).toBe(base + 3 * DAY);
  });

  it("weekly steps by interval weeks", () => {
    const base = Date.UTC(2026, 0, 10, 9, 0, 0);
    expect(nextOccurrence(base, "weekly", 1)).toBe(base + 7 * DAY);
    expect(nextOccurrence(base, "weekly", 2)).toBe(base + 14 * DAY);
  });

  it("monthly steps calendar months (15th → 15th)", () => {
    const base = Date.UTC(2026, 2, 15, 9, 0, 0);
    const next = new Date(nextOccurrence(base, "monthly", 1));
    expect(next.getUTCMonth()).toBe(3); // April
    expect(next.getUTCDate()).toBe(15);
  });

  it("monthly clamps month-end (Jan 31 + 1 month → Feb 28, non-leap)", () => {
    const base = Date.UTC(2026, 0, 31, 9, 0, 0);
    const next = new Date(nextOccurrence(base, "monthly", 1));
    expect(next.getUTCMonth()).toBe(1); // February
    expect(next.getUTCDate()).toBe(28); // clamped, NOT rolled into March
  });

  it("monthly with interval=2 (bi-monthly)", () => {
    const base = Date.UTC(2026, 0, 10, 9, 0, 0);
    const next = new Date(nextOccurrence(base, "monthly", 2));
    expect(next.getUTCMonth()).toBe(2); // March
    expect(next.getUTCDate()).toBe(10);
  });

  it("yearly steps calendar years and clamps Feb 29 → Feb 28 on a non-leap year", () => {
    const leapFeb29 = Date.UTC(2024, 1, 29, 9, 0, 0);
    const next = new Date(nextOccurrence(leapFeb29, "yearly", 1));
    expect(next.getUTCFullYear()).toBe(2025);
    expect(next.getUTCMonth()).toBe(1); // February
    expect(next.getUTCDate()).toBe(28); // clamped
  });
});

describe("materializer via completeTask", () => {
  it("advances both scheduledAt and dueAt when both are present", async () => {
    const { db, close } = await freshDb();
    try {
      const scheduledAt = Date.now() + DAY;
      const dueAt = scheduledAt + 2 * DAY;
      const t = await createTask(db, {
        title: "two clocks",
        recurrence: "weekly",
        recurrenceAnchor: "due",
        scheduledAt,
        dueAt,
      });
      await completeTask(db, t.id);
      const next = (await listTasks(db, { status: "open", includeScheduled: true }))[0]!;
      expect(next.scheduledAt).toBe(scheduledAt + 7 * DAY);
      expect(next.dueAt).toBe(dueAt + 7 * DAY);
    } finally {
      await close();
    }
  });

  it("completing a recurring task (anchor=due) spawns exactly ONE open instance ~1 cadence later", async () => {
    const { db, close } = await freshDb();
    try {
      const due = Date.now() + 2 * DAY;
      const t = await createTask(db, {
        title: "water plants",
        recurrence: "weekly",
        recurrenceInterval: 1,
        recurrenceAnchor: "due",
        dueAt: due,
      });
      await completeTask(db, t.id);

      const open = await listTasks(db, { status: "open", includeScheduled: true });
      expect(open.length).toBe(1);
      const child = open[0]!;
      expect(child.id).not.toBe(t.id);
      expect(child.title).toBe("water plants");
      expect(child.recurrence).toBe("weekly");
      expect(child.dueAt).toBe(due + 7 * DAY);
    } finally {
      await close();
    }
  });

  it("anchor=scheduled steps scheduledAt; anchor=completion steps from now", async () => {
    const { db, close } = await freshDb();
    try {
      const sched = Date.now() + 1 * DAY;
      const ts = await createTask(db, {
        title: "scheduled recur",
        recurrence: "daily",
        recurrenceAnchor: "scheduled",
        scheduledAt: sched,
      });
      await completeTask(db, ts.id);
      const childS = (await listTasks(db, { status: "open", includeScheduled: true })).find(
        (x) => x.title === "scheduled recur",
      )!;
      expect(childS.scheduledAt).toBe(sched + DAY);

      const before = Date.now();
      const tc = await createTask(db, {
        title: "completion recur",
        recurrence: "daily",
        recurrenceAnchor: "completion",
      });
      await completeTask(db, tc.id);
      const after = Date.now();
      const childC = (await listTasks(db, { status: "open", includeScheduled: true })).find(
        (x) => x.title === "completion recur",
      )!;
      // anchor=completion with no due/scheduled writes the stepped value to dueAt
      expect(childC.dueAt).not.toBeNull();
      expect(childC.dueAt!).toBeGreaterThanOrEqual(before + DAY);
      expect(childC.dueAt!).toBeLessThanOrEqual(after + DAY);
    } finally {
      await close();
    }
  });

  it("spawned instance links to chain root, carries streak+1 and lastDoneAt; completed instance keeps lastDoneAt + done", async () => {
    const { db, close } = await freshDb();
    try {
      const t = await createTask(db, {
        title: "chain",
        recurrence: "daily",
        dueAt: Date.now() + DAY,
      });
      const before = Date.now();
      const done = await completeTask(db, t.id);
      const after = Date.now();

      expect(done.status).toBe("done");
      expect(done.lastDoneAt).not.toBeNull();
      expect(done.lastDoneAt!).toBeGreaterThanOrEqual(before);
      expect(done.lastDoneAt!).toBeLessThanOrEqual(after);

      const child = (await listTasks(db, { status: "open", includeScheduled: true }))[0]!;
      expect(child.recurrenceParentId).toBe(t.id); // root = the template id
      expect(child.streak).toBe(1); // 0 + 1
      expect(child.lastDoneAt).not.toBeNull();

      // Completing the child again chains: streak 2, parent stays the root.
      const child2done = await completeTask(db, child.id);
      expect(child2done.streak).toBe(1); // the completed child's own streak is unchanged
      const grandchild = (await listTasks(db, { status: "open", includeScheduled: true }))[0]!;
      expect(grandchild.streak).toBe(2);
      expect(grandchild.recurrenceParentId).toBe(t.id); // still the original root
    } finally {
      await close();
    }
  });

  it("emits an instance_generated event on the spawned task with payload.source='recurrence' and fromTaskId", async () => {
    const { db, close } = await freshDb();
    try {
      const t = await createTask(db, {
        title: "evented",
        recurrence: "weekly",
        dueAt: Date.now() + DAY,
      });
      await completeTask(db, t.id);
      const child = (await listTasks(db, { status: "open", includeScheduled: true }))[0]!;

      const events = await listEvents(db, {
        entityType: "task",
        entityId: child.id,
      });
      const gen = events.find((e) => e.eventType === "instance_generated");
      expect(gen).toBeDefined();
      expect(gen!.payload.source).toBe("recurrence");
      expect((gen!.payload.after as Record<string, unknown>).fromTaskId).toBe(t.id);
    } finally {
      await close();
    }
  });

  it("non-recurring task completion spawns NOTHING (regression guard)", async () => {
    const { db, close } = await freshDb();
    try {
      const t = await createTask(db, { title: "one-shot", dueAt: Date.now() + DAY });
      await completeTask(db, t.id);
      const open = await listTasks(db, { status: "open", includeScheduled: true });
      expect(open.length).toBe(0);
    } finally {
      await close();
    }
  });

  it("done->done no-op does NOT double-spawn", async () => {
    const { db, close } = await freshDb();
    try {
      const t = await createTask(db, {
        title: "idempotent",
        recurrence: "daily",
        dueAt: Date.now() + DAY,
      });
      await completeTask(db, t.id);
      // Re-complete the already-done task — assertTransition's from===to early
      // return makes this a no-op; the materializer must not fire again.
      await completeTask(db, t.id);
      const open = await listTasks(db, { status: "open", includeScheduled: true });
      expect(open.length).toBe(1); // still exactly one child
    } finally {
      await close();
    }
  });

  it("reopen then re-done IS a genuine new completion and spawns again (documented behavior)", async () => {
    const { db, close } = await freshDb();
    try {
      const t = await createTask(db, {
        title: "reopen recur",
        recurrence: "daily",
        dueAt: Date.now() + DAY,
      });
      await completeTask(db, t.id); // spawn #1
      await reopenTask(db, t.id);
      await completeTask(db, t.id); // spawn #2 (a real new completion)
      const open = await listTasks(db, { status: "open", includeScheduled: true });
      expect(open.length).toBe(2);
    } finally {
      await close();
    }
  });

  it("cancelling a recurring task spawns nothing", async () => {
    const { db, close } = await freshDb();
    try {
      const t = await createTask(db, {
        title: "cancel recur",
        recurrence: "daily",
        dueAt: Date.now() + DAY,
      });
      await cancelTask(db, t.id);
      const open = await listTasks(db, { status: "open", includeScheduled: true });
      expect(open.length).toBe(0);
    } finally {
      await close();
    }
  });

  it("getTask on a pre-recurrence-shaped row reads recurrence=null defaults (forward-compat)", async () => {
    const { db, close } = await freshDb();
    try {
      const t = await createTask(db, { title: "plain" });
      const got = await getTask(db, t.id);
      expect(got!.recurrence).toBeNull();
      expect(got!.recurrenceInterval).toBe(1);
      expect(got!.recurrenceAnchor).toBe("due");
      expect(got!.streak).toBe(0);
      expect(got!.lastDoneAt).toBeNull();
      expect(got!.recurrenceParentId).toBeNull();
    } finally {
      await close();
    }
  });
});

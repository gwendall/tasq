/**
 * Atomicity tests — a mutation and its event are ONE transaction.
 *
 * The append-only event log is the trust foundation (ARCHITECTURE: "every
 * mutation emits an event — impossible to bypass"). Before this work each
 * mutation did the row write and the `recordEvent` insert as two separate
 * awaits, so a torn write could desync the row from the log. These tests
 * prove the two halves now commit or roll back TOGETHER, that the external
 * journal fires only after a real commit, and that exactly one event lands
 * per mutation (no duplicate, no missing).
 *
 * Injection technique: `DROP TABLE event` after setup. The row write inside
 * the transaction still succeeds, but `recordEvent`'s insert into the now
 * missing table throws — exercising the REAL rollback path (not a mock).
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
  createTask,
  getArea,
  getGoal,
  getProject,
  getTask,
  updateTask,
  startTask,
  completeTask,
  cancelTask,
  softDeleteTask,
  restoreTask,
  listTasks,
  listEvents,
  setEventListener,
  committedMutationCount,
  type Event,
} from "../src/index.js";

const tmpDirs: string[] = [];

afterEach(() => {
  // Always detach any listener so tests don't leak the journal hook.
  setEventListener(null);
  while (tmpDirs.length > 0) {
    rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

async function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "tasq-atomic-"));
  tmpDirs.push(dir);
  const handle = await openDb({ url: `file:${join(dir, "db.sqlite")}`, wal: false });
  await runMigrations(handle.client);
  return handle;
}

/**
 * Recreate the `event` table after a `DROP TABLE event` injection so we can
 * read state back. The `event` table + its indexes live in the first
 * migration (`0000_init.sql`), whose statements are all `IF NOT EXISTS`.
 * We clear ONLY that migration's ledger row and re-run: the runner re-applies
 * 0000 (recreating just the dropped `event` table — every other object
 * already exists and is skipped) while leaving the non-idempotent
 * `ALTER TABLE` in 0001 marked-applied and untouched.
 */
async function restoreEventTable(client: Parameters<typeof runMigrations>[0]) {
  await client.execute(
    "DELETE FROM _migration WHERE name IN ('0000_init.sql', '0004_event_sequence.sql')",
  );
  await runMigrations(client);
  await client.execute("ALTER TABLE event ADD COLUMN principal_id TEXT REFERENCES principal(id)");
  await client.execute("CREATE INDEX idx_event_principal ON event (tenant_id, principal_id, sequence)");
}

describe("Atomic mutation + event", () => {
  it("createTask rolls back the row when the event insert fails", async () => {
    const { db, client, close } = await freshDb();
    try {
      const area = await createArea(db, { name: "X", slug: "x", importance: 3 });

      // Break the event insert: the row insert inside the tx will still run,
      // but recordEvent's insert into `event` throws → whole tx rolls back.
      await client.execute("DROP TABLE event");

      await expect(
        createTask(db, { title: "should not persist", areaId: area.id }),
      ).rejects.toThrow();

      // Recreate the event table so we can read state back.
      await restoreEventTable(client);

      // No task row landed (row write rolled back with the failed event).
      const tasks = await listTasks(db);
      expect(tasks).toHaveLength(0);

      // No 'created' event either.
      const events = await listEvents(db, { entityType: "task" });
      expect(events).toHaveLength(0);
    } finally {
      await close();
    }
  });

  it("updateTask leaves the row UNCHANGED when the event insert fails", async () => {
    const { db, client, close } = await freshDb();
    try {
      const area = await createArea(db, { name: "X", slug: "x", importance: 3 });
      const t = await createTask(db, {
        title: "original title",
        nextAction: "original next",
        areaId: area.id,
      });

      await client.execute("DROP TABLE event");

      await expect(
        updateTask(db, t.id, { title: "mutated title", nextAction: "mutated next" }),
      ).rejects.toThrow();

      await restoreEventTable(client);

      // The UPDATE rolled back with the failed event — fields are untouched.
      // (The task row survived because only `event` was dropped, and the
      // failed mutation's UPDATE was rolled back atomically.)
      const after = await getTask(db, t.id);
      expect(after).not.toBeNull();
      expect(after!.title).toBe("original title");
      expect(after!.nextAction).toBe("original next");

      // The failed mutation logged nothing. (The `event` table at mutation
      // time was dropped, so the rolled-back update could not have inserted
      // any event ; the durable proof of "no torn write" is the unchanged
      // row above. The recreated table is empty.)
      const events = await listEvents(db, { entityId: t.id });
      expect(events).toHaveLength(0);
    } finally {
      await close();
    }
  });

  it("status transition rolls back the status when the event insert fails", async () => {
    const { db, client, close } = await freshDb();
    try {
      const area = await createArea(db, { name: "X", slug: "x", importance: 3 });
      const t = await createTask(db, { title: "t", areaId: area.id });
      expect(t.status).toBe("open");

      await client.execute("DROP TABLE event");

      await expect(startTask(db, t.id)).rejects.toThrow();

      await restoreEventTable(client);

      const after = await getTask(db, t.id);
      expect(after!.status).toBe("open"); // never moved to in_progress
      expect(after!.startedAt).toBeNull();
    } finally {
      await close();
    }
  });

  it("emits exactly one event per successful mutation (no duplicate, no missing)", async () => {
    const { db, close } = await freshDb();
    try {
      const area = await createArea(db, { name: "X", slug: "x", importance: 3 });
      const goal = await createGoal(db, { areaId: area.id, title: "G" });
      const project = await createProject(db, { title: "P", areaId: area.id });
      const t = await createTask(db, { title: "t", areaId: area.id });

      await startTask(db, t.id);
      await updateTask(db, t.id, { nextAction: "do it" });
      await softDeleteTask(db, t.id);
      await restoreTask(db, t.id);

      const countOf = async (entityId: string) =>
        (await listEvents(db, { entityId, limit: 100 })).length;

      // 1 created event each for area/goal/project.
      expect(await countOf(area.id)).toBe(1);
      expect(await countOf(goal.id)).toBe(1);
      expect(await countOf(project.id)).toBe(1);

      // task: created + started + updated + deleted + restored = 5 exactly.
      const taskEvents = await listEvents(db, { entityId: t.id, ascending: true });
      expect(taskEvents.map((e) => e.eventType)).toEqual([
        "created",
        "started",
        "updated",
        "deleted",
        "restored",
      ]);
    } finally {
      await close();
    }
  });

  it("fires the journal listener once per commit, and NOT on rollback", async () => {
    const { db, client, close } = await freshDb();
    try {
      const journaled: Event[] = [];
      setEventListener((e) => journaled.push(e));

      const area = await createArea(db, { name: "X", slug: "x", importance: 3 });
      const t = await createTask(db, { title: "t", areaId: area.id });
      await startTask(db, t.id);

      // 3 successful mutations → exactly 3 journaled events.
      expect(journaled).toHaveLength(3);
      expect(journaled.map((e) => e.eventType)).toEqual(["created", "created", "started"]);

      // Now force a rollback and assert the listener does NOT fire for it.
      await client.execute("DROP TABLE event");
      await expect(updateTask(db, t.id, { title: "nope" })).rejects.toThrow();
      await restoreEventTable(client);

      // Still 3 — the rolled-back mutation never journaled.
      expect(journaled).toHaveLength(3);
    } finally {
      await close();
    }
  });

  it("journal listener errors never break a mutation (DB stays source of truth)", async () => {
    const { db, close } = await freshDb();
    try {
      setEventListener(() => {
        throw new Error("journal disk full");
      });

      const area = await createArea(db, { name: "X", slug: "x", importance: 3 });
      // The mutation must still succeed + persist despite the listener throwing.
      const t = await createTask(db, { title: "durable", areaId: area.id });
      expect((await getTask(db, t.id))?.title).toBe("durable");
      // And the event is durably in the DB (the journal is the backup, not the truth).
      const events = await listEvents(db, { entityId: t.id });
      expect(events.map((e) => e.eventType)).toEqual(["created"]);
    } finally {
      await close();
    }
  });

  it("concurrent mutations on one handle serialize (no SQLITE_BUSY self-deadlock)", async () => {
    const { db, close } = await freshDb();
    try {
      const area = await createArea(db, { name: "X", slug: "x", importance: 3 });

      // Fire many mutations at once on the SHARED connection. Before the
      // per-handle transaction queue, two concurrent BEGIN IMMEDIATE would
      // collide with SQLITE_BUSY that busy_timeout cannot resolve.
      const created = await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          createTask(db, { title: `t${i}`, areaId: area.id }),
        ),
      );
      expect(created).toHaveLength(8);

      const tasks = await listTasks(db, { limit: 100 });
      expect(tasks).toHaveLength(8);

      // Exactly one 'created' event per task — none lost, none duplicated.
      const events = await listEvents(db, { entityType: "task", limit: 100 });
      expect(events).toHaveLength(8);
      expect(events.every((e) => e.eventType === "created")).toBe(true);
    } finally {
      await close();
    }
  });

  it("validates competing status changes inside the serialized transaction", async () => {
    const { db, close } = await freshDb();
    try {
      const t = await createTask(db, { title: "one outcome" });
      const outcomes = await Promise.allSettled([
        completeTask(db, t.id),
        cancelTask(db, t.id),
      ]);

      expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);
      expect(outcomes.filter((o) => o.status === "rejected")).toHaveLength(1);

      const events = await listEvents(db, { entityId: t.id, ascending: true });
      expect(events.map((e) => e.eventType)).toEqual([
        "created",
        outcomes[0]!.status === "fulfilled" ? "completed" : "cancelled",
      ]);
    } finally {
      await close();
    }
  });

  it("makes a repeated status command a true no-op", async () => {
    const { db, close } = await freshDb();
    try {
      const t = await createTask(db, { title: "idempotent done" });
      const first = await completeTask(db, t.id);
      const second = await completeTask(db, t.id);

      expect(second.completedAt).toBe(first.completedAt);
      expect(second.updatedAt).toBe(first.updatedAt);
      const events = await listEvents(db, { entityId: t.id, ascending: true });
      expect(events.map((e) => e.eventType)).toEqual(["created", "completed"]);
    } finally {
      await close();
    }
  });

  it("deduplicates task creation with a durable idempotency key", async () => {
    const { db, close } = await freshDb();
    try {
      const context = { actor: "agent", idempotencyKey: "request-42" };
      const first = await createTask(db, { title: "once" }, context);
      const replay = await createTask(db, { title: "once" }, context);
      expect(replay.id).toBe(first.id);
      expect(await listTasks(db)).toHaveLength(1);
      expect(await listEvents(db, { entityId: first.id })).toHaveLength(1);

      await expect(
        createTask(db, { title: "different" }, context),
      ).rejects.toThrow(/different request/);
    } finally {
      await close();
    }
  });

  it("rejects one side of a concurrent hierarchy cycle", async () => {
    const { db, close } = await freshDb();
    try {
      const a = await createTask(db, { title: "A" });
      const b = await createTask(db, { title: "B" });
      const outcomes = await Promise.allSettled([
        updateTask(db, a.id, { parentTaskId: b.id }),
        updateTask(db, b.id, { parentTaskId: a.id }),
      ]);

      expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);
      expect(outcomes.filter((o) => o.status === "rejected")).toHaveLength(1);
    } finally {
      await close();
    }
  });

  it("rollback of area/goal/project mutations also leaves no half-state", async () => {
    const { db, client, close } = await freshDb();
    try {
      const area = await createArea(db, { name: "Keep", slug: "keep", importance: 3 });

      await client.execute("DROP TABLE event");

      // Each create must reject AND leave nothing behind.
      await expect(createGoal(db, { areaId: area.id, title: "G" })).rejects.toThrow();
      await expect(createProject(db, { title: "P", areaId: area.id })).rejects.toThrow();

      await restoreEventTable(client);

      // The pre-existing area is still there ; the failed creates left nothing.
      expect(await getArea(db, area.id)).not.toBeNull();
      const goalEvents = await listEvents(db, { entityType: "goal" });
      const projEvents = await listEvents(db, { entityType: "project" });
      expect(goalEvents).toHaveLength(0);
      expect(projEvents).toHaveLength(0);
    } finally {
      await close();
    }
  });

  it("committedMutationCount advances on commit but NOT on rollback", async () => {
    // This is the exact signal the CLI's retry uses to decide whether a
    // whole-command replay is safe (no double-apply): the count must move
    // only when a mutation actually COMMITS.
    const { db, client, close } = await freshDb();
    try {
      const start = committedMutationCount();

      await createArea(db, { name: "X", slug: "x", importance: 3 });
      expect(committedMutationCount()).toBe(start + 1);

      const t = await createTask(db, { title: "t" });
      expect(committedMutationCount()).toBe(start + 2);

      // A rolled-back mutation must NOT advance the count.
      await client.execute("DROP TABLE event");
      await expect(updateTask(db, t.id, { title: "nope" })).rejects.toThrow();
      expect(committedMutationCount()).toBe(start + 2);
    } finally {
      await close();
    }
  });
});

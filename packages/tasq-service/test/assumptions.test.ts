/**
 * ADR-021 — shared assumptions.
 *
 * These tests pin the three limits the design depends on, because each one is
 * a place where a well-meaning change would make the primitive dangerous:
 * one hop, never terminal, never required.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireTaskClaim,
  attachAssumption,
  completeTask,
  createTask,
  dependTask,
  getTaskAssumptions,
  listAssumptions,
  listEvents,
  normalizeAssumptionText,
  openDb,
  pickNext,
  resumeCommitment,
  runMigrations,
  withdrawAssumption,
} from "../src/index.js";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const NOW = 1_800_000_000_000;

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "tasq-assumption-"));
  dirs.push(dir);
  const handle = await openDb({ url: `file:${join(dir, "db.sqlite")}`, wal: false });
  await runMigrations(handle.client);
  return handle;
}

describe("shared assumptions", () => {
  it("gives two differently phrased beliefs one shared record", async () => {
    const f = await fixture();
    try {
      const a = await createTask(f.db, { title: "make list paginate" });
      const b = await createTask(f.db, { title: "add a default --limit" });
      const first = await attachAssumption(f.db, {
        taskId: a.id, text: "list times out past 10k tasks",
      }, { now: NOW });
      const second = await attachAssumption(f.db, {
        taskId: b.id, text: "  List   Times Out   Past 10k Tasks  ",
      }, { now: NOW + 1 });

      expect(second.assumption.id).toBe(first.assumption.id);
      // The text stays as first written; only identity is normalised.
      expect(first.assumption.text).toBe("list times out past 10k tasks");

      const listed = await listAssumptions(f.db, "gwendall");
      expect(listed).toHaveLength(1);
      expect(listed[0]!.activeTaskIds).toEqual([a.id, b.id].sort());
    } finally {
      await f.close();
    }
  });

  it("normalises whitespace, case and unicode form into one identity", () => {
    expect(normalizeAssumptionText("  A   B  ")).toBe("a b");
    expect(normalizeAssumptionText("Ähnlich")).toBe(normalizeAssumptionText("Ähnlich".normalize("NFD")));
  });

  it("pauses every open commitment resting on a withdrawn belief, and cancels none", async () => {
    const f = await fixture();
    try {
      const a = await createTask(f.db, { title: "make list paginate" });
      const b = await createTask(f.db, { title: "add a default --limit" });
      for (const task of [a, b]) {
        await attachAssumption(f.db, { taskId: task.id, text: "list times out past 10k" }, { now: NOW });
      }

      const withdrawn = await withdrawAssumption(f.db, {
        text: "list times out past 10k",
        reason: "measured 10k in 240ms",
      }, { now: NOW + 1_000 });

      expect(withdrawn.pausedTaskIds).toEqual([a.id, b.id].sort());
      expect(withdrawn.assumption.status).toBe("withdrawn");

      // NEVER TERMINAL: the commitments are untouched, only unselectable.
      const next = await pickNext(f.db, { now: NOW + 2_000 });
      expect(next.map((entry) => entry.task.id)).not.toContain(a.id);
      expect(next.map((entry) => entry.task.id)).not.toContain(b.id);

      const state = await getTaskAssumptions(f.db, a.id, "gwendall");
      expect(state.paused).toBe(true);
    } finally {
      await f.close();
    }
  });

  it("refuses a claim on paused work, so a stale selection cannot slip through", async () => {
    const f = await fixture();
    try {
      const task = await createTask(f.db, { title: "make list paginate" });
      await attachAssumption(f.db, { taskId: task.id, text: "the cache is what is slow" }, { now: NOW });
      await withdrawAssumption(f.db, {
        text: "the cache is what is slow", reason: "profiled: it is serialisation",
      }, { now: NOW + 1 });

      await expect(acquireTaskClaim(f.db, task.id, {
        actor: "agent-a", now: NOW + 2, durationMs: 60_000, idempotencyKey: "claim:paused",
      })).rejects.toThrow(/paused/);
    } finally {
      await f.close();
    }
  });

  it("does not touch finished work, because a wrong reason does not undo a result", async () => {
    const f = await fixture();
    try {
      const done = await createTask(f.db, { title: "already shipped" });
      await attachAssumption(f.db, { taskId: done.id, text: "shared belief" }, { now: NOW });
      await completeTask(f.db, done.id, { now: NOW + 1 });

      const withdrawn = await withdrawAssumption(f.db, {
        text: "shared belief", reason: "turned out false",
      }, { now: NOW + 2 });

      expect(withdrawn.pausedTaskIds).toEqual([]);
    } finally {
      await f.close();
    }
  });

  it("stops at one hop: a dependent commitment is never dragged down", async () => {
    const f = await fixture();
    try {
      const root = await createTask(f.db, { title: "make list paginate" });
      const dependent = await createTask(f.db, { title: "document pagination" });
      await dependTask(f.db, { fromTaskId: dependent.id, toTaskId: root.id, type: "blocks" });
      await attachAssumption(f.db, { taskId: root.id, text: "list times out" }, { now: NOW });

      const withdrawn = await withdrawAssumption(f.db, {
        text: "list times out", reason: "measured otherwise",
      }, { now: NOW + 1 });

      expect(withdrawn.pausedTaskIds).toEqual([root.id]);
      const state = await getTaskAssumptions(f.db, dependent.id, "gwendall");
      expect(state.paused).toBe(false);
    } finally {
      await f.close();
    }
  });

  it("resumes paused work by unlinking it, and records why", async () => {
    const f = await fixture();
    try {
      const task = await createTask(f.db, { title: "make list paginate" });
      await attachAssumption(f.db, { taskId: task.id, text: "list times out" }, { now: NOW });
      await withdrawAssumption(f.db, { text: "list times out", reason: "measured otherwise" }, { now: NOW + 1 });

      const resumed = await resumeCommitment(f.db, {
        taskId: task.id, reason: "pagination is still wanted for interactive use",
      }, { now: NOW + 2 });

      expect(resumed.unlinked).toHaveLength(1);
      const state = await getTaskAssumptions(f.db, task.id, "gwendall");
      expect(state.paused).toBe(false);
      // The history survives the recovery: the belief and its death stay readable.
      expect(state.assumptions[0]!.assumption.status).toBe("withdrawn");
      expect(state.assumptions[0]!.link.unlinkReason).toContain("interactive use");

      const claim = await acquireTaskClaim(f.db, task.id, {
        actor: "agent-a", now: NOW + 3, durationMs: 60_000, idempotencyKey: "claim:resumed",
      });
      expect(claim.actor).toBe("agent-a");
    } finally {
      await f.close();
    }
  });

  it("leaves a commitment with no assumption exactly as it was", async () => {
    const f = await fixture();
    try {
      const plain = await createTask(f.db, { title: "ordinary work" });
      const state = await getTaskAssumptions(f.db, plain.id, "gwendall");
      expect(state.paused).toBe(false);
      expect(state.assumptions).toEqual([]);

      const next = await pickNext(f.db, { now: NOW });
      expect(next.map((entry) => entry.task.id)).toContain(plain.id);

      const claim = await acquireTaskClaim(f.db, plain.id, {
        actor: "agent-a", now: NOW + 1, durationMs: 60_000, idempotencyKey: "claim:plain",
      });
      expect(claim.actor).toBe("agent-a");
    } finally {
      await f.close();
    }
  });

  it("records the withdrawal against each paused commitment, never against the belief", async () => {
    // `entityType` is a closed enum with no assumption member. An event whose
    // entityId is an assumption would look like a task to every audit query.
    const f = await fixture();
    try {
      const a = await createTask(f.db, { title: "first" });
      const b = await createTask(f.db, { title: "second" });
      for (const task of [a, b]) {
        await attachAssumption(f.db, { taskId: task.id, text: "a shared belief" }, { now: NOW });
      }
      await withdrawAssumption(f.db, {
        text: "a shared belief", reason: "learned otherwise",
      }, { now: NOW + 1 });

      const events = await listEvents(f.db, { tenantId: "gwendall", limit: 200 });
      const withdrawals = events.filter((event) => event.eventType === "assumption_withdrawn");
      expect(withdrawals.map((event) => event.entityId).sort()).toEqual([a.id, b.id].sort());
      expect(withdrawals.every((event) => event.entityType === "task")).toBe(true);
    } finally {
      await f.close();
    }
  });

  it("treats a repeated withdrawal as already done rather than an error", async () => {
    const f = await fixture();
    try {
      const task = await createTask(f.db, { title: "work" });
      await attachAssumption(f.db, { taskId: task.id, text: "a belief" }, { now: NOW });
      await withdrawAssumption(f.db, { text: "a belief", reason: "first" }, { now: NOW + 1 });
      const again = await withdrawAssumption(f.db, { text: "a belief", reason: "second" }, { now: NOW + 2 });

      expect(again.replayed).toBe(true);
      expect(again.assumption.withdrawalReason).toBe("first");
    } finally {
      await f.close();
    }
  });

  it("lets a withdrawn belief be stated again as a new record when evidence changes", async () => {
    const f = await fixture();
    try {
      const first = await createTask(f.db, { title: "first" });
      const attached = await attachAssumption(f.db, { taskId: first.id, text: "the cache is slow" }, { now: NOW });
      await withdrawAssumption(f.db, { text: "the cache is slow", reason: "profiled otherwise" }, { now: NOW + 1 });

      const second = await createTask(f.db, { title: "second" });
      const restated = await attachAssumption(f.db, { taskId: second.id, text: "the cache is slow" }, { now: NOW + 2 });

      expect(restated.assumption.id).not.toBe(attached.assumption.id);
      expect(restated.assumption.status).toBe("standing");
      // Both rows survive, so the history shows the belief dying and returning.
      expect(await listAssumptions(f.db, "gwendall")).toHaveLength(2);
    } finally {
      await f.close();
    }
  });

  it("requires a reason for a withdrawal but never requires evidence", async () => {
    const f = await fixture();
    try {
      const task = await createTask(f.db, { title: "work" });
      await attachAssumption(f.db, { taskId: task.id, text: "a belief" }, { now: NOW });

      await expect(withdrawAssumption(f.db, { text: "a belief" }, { now: NOW + 1 })).rejects.toThrow();

      const withdrawn = await withdrawAssumption(f.db, {
        text: "a belief", reason: "learned otherwise",
      }, { now: NOW + 2 });
      expect(withdrawn.assumption.withdrawalEvidenceIds).toEqual([]);
    } finally {
      await f.close();
    }
  });
});

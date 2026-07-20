import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  blockTask,
  completeTask,
  createTask,
  createWaitCondition,
  diagnoseStore,
  evaluateWaitConditionDeadline,
  getTask,
  getWaitCondition,
  ingestObservation,
  listEvents,
  listTaskEvidence,
  listTasks,
  openDb,
  reconcileWaitObservation,
  runMigrations,
  sweepWaitConditionDeadlines,
} from "../src/index.js";

const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length > 0) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

async function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "tasq-deadline-"));
  tmpDirs.push(dir);
  const handle = await openDb({ url: `file:${join(dir, "db.sqlite")}`, wal: false });
  await runMigrations(handle.client);
  return handle;
}

const parameters = {
  connectorAccount: "gmail:primary",
  threadId: "thread-1",
  sender: "alice@example.test",
};

async function reply(db: Parameters<typeof ingestObservation>[0], id: string, occurredAt: number, recordedAt: number) {
  return ingestObservation(db, {
    source: "gmail:primary",
    externalEventId: id,
    kind: "gmail.message",
    payload: {
      connectorAccount: "gmail:primary",
      messageId: id,
      threadId: "thread-1",
      sender: "alice@example.test",
    },
    occurredAt,
  }, { now: recordedAt, actor: "gmail-watcher" });
}

describe("deadline sweeper", () => {
  it("expires a due wait once and records the sweep clock", async () => {
    const { db, client, close } = await freshDb();
    try {
      const source = await createTask(db, { title: "Wait for reply" });
      const condition = await createWaitCondition(db, {
        taskId: source.id,
        kind: "gmail.thread_reply",
        parameters,
        notBefore: 1_000,
        deadlineAt: 2_000,
      }, { now: 1_000 });

      const first = await evaluateWaitConditionDeadline(db, condition.id, { sweepNow: 2_500 });
      expect(first).toMatchObject({ outcome: "expired", sweepNow: 2_500, fallbackResultTaskId: null });
      expect(first.condition).toMatchObject({ status: "expired", expiredAt: 2_500 });
      const eventCount = (await listEvents(db, { entityId: source.id })).length;

      const retry = await evaluateWaitConditionDeadline(db, condition.id, { sweepNow: 3_000 });
      expect(retry.outcome).toBe("already_terminal");
      expect(retry.condition.expiredAt).toBe(2_500);
      expect((await listEvents(db, { entityId: source.id })).length).toBe(eventCount);
      const expiredEvent = (await listEvents(db, { entityId: source.id })).find(
        (event) => event.eventType === "wait_expired",
      );
      expect(expiredEvent?.payload.after).toMatchObject({ sweepNow: 2_500, deadlineAt: 2_000 });
    } finally {
      await close();
    }
  });

  it("reconciles an already-recorded eligible fact before allowing expiry", async () => {
    const { db, client, close } = await freshDb();
    try {
      const source = await createTask(db, { title: "Await queued reply" });
      const condition = await createWaitCondition(db, {
        taskId: source.id,
        kind: "gmail.thread_reply",
        parameters,
        notBefore: 1_000,
        deadlineAt: 5_000,
        fallbackKind: "create_task",
        fallbackSpec: { title: "Escalate", nextAction: "Call Alice" },
      }, { now: 1_000 });
      const observed = await reply(db, "pre-deadline", 4_000, 4_500);

      const result = await evaluateWaitConditionDeadline(db, condition.id, { sweepNow: 6_000 });
      expect(result.outcome).toBe("satisfied");
      expect(result.condition).toMatchObject({
        status: "satisfied",
        satisfiedByObservationId: observed.id,
        fallbackResultTaskId: null,
      });
      expect(result.reconciliations.at(-1)).toMatchObject({ decision: "matched", effect: "satisfied" });
      expect(await listTaskEvidence(db, source.id)).toHaveLength(1);
      expect(await listTasks(db, { includeScheduled: true })).toHaveLength(1);
    } finally {
      await close();
    }
  });

  it("treats either clock at the deadline as late and preserves late audit", async () => {
    const { db, close } = await freshDb();
    try {
      for (const scenario of [
        { id: "occurred-at", occurredAt: 5_000, recordedAt: 4_900 },
        { id: "recorded-at", occurredAt: 4_900, recordedAt: 5_000 },
      ]) {
        const source = await createTask(db, { title: `Strict ${scenario.id}` });
        const condition = await createWaitCondition(db, {
          taskId: source.id,
          kind: "gmail.thread_reply",
          parameters,
          notBefore: 1_000,
          deadlineAt: 5_000,
        }, { now: 1_000 });
        const observed = await reply(db, scenario.id, scenario.occurredAt, scenario.recordedAt);
        expect((await evaluateWaitConditionDeadline(db, condition.id, { sweepNow: 6_000 })).outcome)
          .toBe("expired");
        const late = await reconcileWaitObservation(db, condition.id, observed.id, { now: 7_000 });
        expect(late).toMatchObject({
          decision: "matched",
          effect: "condition_terminal",
          reasonCode: "condition_already_expired",
        });
      }
    } finally {
      await close();
    }
  });

  it("creates one canonically-scoped fallback under concurrent retries", async () => {
    const { db, client, close } = await freshDb();
    try {
      const parent = await createTask(db, { title: "Parent" });
      const source = await createTask(db, { title: "Source", parentTaskId: parent.id });
      const condition = await createWaitCondition(db, {
        taskId: source.id,
        kind: "gmail.thread_reply",
        parameters,
        notBefore: 1_000,
        deadlineAt: 2_000,
        fallbackKind: "create_task",
        fallbackSpec: {
          title: "Escalate unanswered email",
          nextAction: "Call Alice",
          priority: 1,
          metadata: { channel: "phone" },
        },
      }, { now: 1_000 });

      const [a, b] = await Promise.all([
        evaluateWaitConditionDeadline(db, condition.id, { sweepNow: 3_000 }),
        evaluateWaitConditionDeadline(db, condition.id, { sweepNow: 3_000 }),
      ]);
      expect(new Set([a.outcome, b.outcome])).toEqual(new Set(["expired", "already_terminal"]));
      const expired = await getWaitCondition(db, condition.id);
      const fallback = await getTask(db, expired!.fallbackResultTaskId!);
      expect(fallback).toMatchObject({
        title: "Escalate unanswered email",
        nextAction: "Call Alice",
        parentTaskId: parent.id,
        priority: 1,
      });
      expect(fallback?.metadata).toMatchObject({
        channel: "phone",
        waitFallback: { conditionId: condition.id, sourceTaskId: source.id, deadlineAt: 2_000 },
      });
      expect((await listTasks(db, { includeScheduled: true })).filter(
        (task) => (task.metadata.waitFallback as { conditionId?: string } | undefined)?.conditionId === condition.id,
      )).toHaveLength(1);
      const keys = await client.execute({
        sql: "SELECT * FROM idempotency_key WHERE tenant_id = ? AND key = ?",
        args: ["gwendall", `wait:${condition.id}:deadline-fallback:v1`],
      });
      expect(keys.rows).toHaveLength(1);
    } finally {
      await close();
    }
  });

  it("activates a blocked/deferred target without starting it", async () => {
    const { db, close } = await freshDb();
    try {
      const source = await createTask(db, { title: "Primary path" });
      const target = await createTask(db, { title: "Fallback path", scheduledAt: 99_000 });
      await blockTask(db, target.id, { reason: "Only after timeout" });
      const condition = await createWaitCondition(db, {
        taskId: source.id,
        kind: "gmail.thread_reply",
        parameters,
        notBefore: 1_000,
        deadlineAt: 2_000,
        fallbackKind: "activate_task",
        fallbackTargetTaskId: target.id,
      }, { now: 1_000 });

      const result = await evaluateWaitConditionDeadline(db, condition.id, { sweepNow: 3_000 });
      expect(result).toMatchObject({ outcome: "expired", fallbackResultTaskId: target.id });
      expect(await getTask(db, target.id)).toMatchObject({
        status: "open",
        scheduledAt: null,
        startedAt: null,
      });
      expect((await listEvents(db, { entityId: target.id })).filter(
        (event) => event.eventType === "wait_fallback_activated",
      )).toHaveLength(1);
    } finally {
      await close();
    }
  });

  it("rolls back an invalid fallback without starving other due waits", async () => {
    const { db, client, close } = await freshDb();
    try {
      const badSource = await createTask(db, { title: "Bad source" });
      const deadTarget = await createTask(db, { title: "Will be terminal" });
      const bad = await createWaitCondition(db, {
        taskId: badSource.id,
        kind: "gmail.thread_reply",
        parameters,
        notBefore: 1_000,
        deadlineAt: 2_000,
        fallbackKind: "activate_task",
        fallbackTargetTaskId: deadTarget.id,
      }, { now: 1_000 });
      await completeTask(db, deadTarget.id);

      const goodSource = await createTask(db, { title: "Good source" });
      const good = await createWaitCondition(db, {
        taskId: goodSource.id,
        kind: "gmail.thread_reply",
        parameters,
        notBefore: 1_000,
        deadlineAt: 2_000,
      }, { now: 1_000 });

      const swept = await sweepWaitConditionDeadlines(db, { sweepNow: 3_000 });
      expect(swept).toMatchObject({ evaluated: 1, expired: 1 });
      expect(swept.errors).toHaveLength(1);
      expect(swept.errors[0]?.conditionId).toBe(bad.id);
      expect(await getWaitCondition(db, bad.id)).toMatchObject({ status: "waiting" });
      expect(await getWaitCondition(db, good.id)).toMatchObject({ status: "expired" });
      const report = await diagnoseStore(db, client);
      expect(report.ok).toBe(false);
      expect(report.issues.some((issue) => issue.code === "wait_terminal_fallback_target")).toBe(true);
    } finally {
      await close();
    }
  });

  it("rejects a forged activate result at the SQLite boundary", async () => {
    const { db, client, close } = await freshDb();
    try {
      const source = await createTask(db, { title: "Source" });
      const target = await createTask(db, { title: "Target" });
      const wrong = await createTask(db, { title: "Wrong" });
      const condition = await createWaitCondition(db, {
        taskId: source.id,
        kind: "gmail.thread_reply",
        parameters,
        notBefore: 1_000,
        deadlineAt: 2_000,
        fallbackKind: "activate_task",
        fallbackTargetTaskId: target.id,
      }, { now: 1_000 });
      await expect(client.execute({
        sql: "UPDATE wait_condition SET status='expired', expired_at=3000, updated_at=3000, fallback_result_task_id=? WHERE id=?",
        args: [wrong.id, condition.id],
      })).rejects.toThrow("invalid wait deadline fallback result");
    } finally {
      await close();
    }
  });
});

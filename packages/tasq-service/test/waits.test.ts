import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cancelWaitCondition,
  completeTask,
  createTask,
  createWaitCondition,
  diagnoseStore,
  ensureBundledReferenceExtension,
  getTask,
  getWaitCondition,
  listEvents,
  listWaitConditions,
  openDb,
  runMigrations,
  softDeleteTask,
  REFERENCE_EVALUATOR_IMPLEMENTATION_DIGEST,
  WAIT_KIND_EXTENSION_IDENTITIES,
} from "../src/index.js";

const tmpDirs: string[] = [];

afterEach(() => {
  while (tmpDirs.length > 0) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

async function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "tasq-waits-"));
  tmpDirs.push(dir);
  const handle = await openDb({ url: `file:${join(dir, "db.sqlite")}`, wal: false });
  await runMigrations(handle.client);
  return handle;
}

const gmailParameters = {
  connectorAccount: "gmail:primary",
  threadId: "thread-123",
  sender: "alice@example.test",
};

describe("typed wait conditions", () => {
  it("creates a canonical typed wait and audits it", async () => {
    const { db, close } = await freshDb();
    try {
      const task = await createTask(db, { title: "Await Alice" });
      const condition = await createWaitCondition(
        db,
        {
          taskId: task.id,
          kind: "gmail.thread_reply",
          parameters: gmailParameters,
          deadlineAt: 20_000,
        },
        { actor: "agent-a", now: 10_000 },
      );

      expect(condition).toMatchObject({
        taskId: task.id,
        kind: "gmail.thread_reply",
        schemaVersion: 1,
        parameters: gmailParameters,
        status: "waiting",
        notBefore: 10_000,
        deadlineAt: 20_000,
        fallbackKind: "none",
        fallbackSpec: null,
        fallbackTargetTaskId: null,
        fallbackResultTaskId: null,
      });
      expect(await getWaitCondition(db, condition.id)).toEqual(condition);
      expect(await listWaitConditions(db, task.id)).toEqual([condition]);

      const event = (await listEvents(db, { entityId: task.id })).find(
        (candidate) => candidate.eventType === "wait_created",
      );
      expect(event?.actor).toBe("agent-a");
      expect((event?.payload.after as Record<string, unknown>)?.waitConditionId).toBe(condition.id);
    } finally {
      await close();
    }
  });

  it("rejects untyped payloads, unsupported versions, and incoherent deadlines", async () => {
    const { db, close } = await freshDb();
    try {
      const task = await createTask(db, { title: "Typed" });
      await expect(
        createWaitCondition(db, {
          taskId: task.id,
          kind: "gmail.thread_reply",
          parameters: { connectorAccount: "gmail:primary" },
        }),
      ).rejects.toThrow();
      await expect(
        createWaitCondition(db, {
          taskId: task.id,
          kind: "gmail.thread_reply",
          schemaVersion: 2,
          parameters: gmailParameters,
        }),
      ).rejects.toThrow(/Unsupported wait condition schema/);
      await expect(
        createWaitCondition(
          db,
          {
            taskId: task.id,
            kind: "gmail.thread_reply",
            parameters: gmailParameters,
            deadlineAt: 9_999,
          },
          { now: 10_000 },
        ),
      ).rejects.toThrow(/strictly after/);
    } finally {
      await close();
    }
  });

  it("deduplicates creation across a lost response without rebasing notBefore", async () => {
    const { db, close } = await freshDb();
    try {
      const task = await createTask(db, { title: "Retry" });
      const input = {
        taskId: task.id,
        kind: "gmail.thread_reply" as const,
        parameters: gmailParameters,
      };
      const first = await createWaitCondition(db, input, {
        actor: "agent-a",
        idempotencyKey: "wait-retry-1",
        now: 10_000,
      });
      const retried = await createWaitCondition(db, input, {
        actor: "agent-a",
        idempotencyKey: "wait-retry-1",
        now: 50_000,
      });
      expect(retried).toEqual(first);
      expect(retried.notBefore).toBe(10_000);
      expect(await listWaitConditions(db, task.id)).toHaveLength(1);
      expect(
        (await listEvents(db, { entityId: task.id })).filter(
          (event) => event.eventType === "wait_created",
        ),
      ).toHaveLength(1);

      await expect(
        createWaitCondition(
          db,
          { ...input, parameters: { ...gmailParameters, threadId: "different" } },
          { actor: "agent-a", idempotencyKey: "wait-retry-1", now: 60_000 },
        ),
      ).rejects.toThrow(/different request/);
    } finally {
      await close();
    }
  });

  it("cancels once and keeps terminal history immutable", async () => {
    const { db, client, close } = await freshDb();
    try {
      const task = await createTask(db, { title: "Cancel wait" });
      const condition = await createWaitCondition(
        db,
        { taskId: task.id, kind: "gmail.thread_reply", parameters: gmailParameters },
        { now: 10_000 },
      );
      const cancelled = await cancelWaitCondition(db, condition.id, {
        actor: "agent-a",
        reason: "no longer needed",
        now: 11_000,
      });
      expect(cancelled).toMatchObject({
        status: "cancelled",
        cancelledAt: 11_000,
        cancelReason: "no longer needed",
      });
      expect(
        await cancelWaitCondition(db, condition.id, {
          reason: "no longer needed",
          now: 12_000,
        }),
      ).toEqual(cancelled);
      await expect(
        cancelWaitCondition(db, condition.id, { reason: "changed story", now: 12_000 }),
      ).rejects.toThrow(/already cancelled/);
      await expect(
        client.execute({
          sql: "UPDATE wait_condition SET status='waiting', cancelled_at=NULL, cancel_reason=NULL WHERE id=?",
          args: [condition.id],
        }),
      ).rejects.toThrow(/exactly once/);
      await expect(
        client.execute({ sql: "DELETE FROM wait_condition WHERE id=?", args: [condition.id] }),
      ).rejects.toThrow(/append-only/);
    } finally {
      await close();
    }
  });

  it("supersedes atomically and does not allow correction branches", async () => {
    const { db, close } = await freshDb();
    try {
      const task = await createTask(db, { title: "Correct wait" });
      const original = await createWaitCondition(
        db,
        { taskId: task.id, kind: "gmail.thread_reply", parameters: gmailParameters },
        { now: 10_000 },
      );
      const replacement = await createWaitCondition(
        db,
        {
          taskId: task.id,
          kind: "gmail.thread_reply",
          parameters: { ...gmailParameters, sender: "bob@example.test" },
          supersedesConditionId: original.id,
        },
        { now: 11_000 },
      );
      expect(replacement.supersedesConditionId).toBe(original.id);
      expect(await getWaitCondition(db, original.id)).toMatchObject({
        status: "cancelled",
        cancelReason: "superseded",
      });
      await expect(
        createWaitCondition(
          db,
          {
            taskId: task.id,
            kind: "gmail.thread_reply",
            parameters: gmailParameters,
            supersedesConditionId: original.id,
          },
          { now: 12_000 },
        ),
      ).rejects.toThrow(/already terminal/);
    } finally {
      await close();
    }
  });

  it("validates fallback configuration and target liveness", async () => {
    const { db, close } = await freshDb();
    try {
      const task = await createTask(db, { title: "Primary" });
      const fallback = await createTask(db, { title: "Escalate" });
      const activate = await createWaitCondition(db, {
        taskId: task.id,
        kind: "gmail.thread_reply",
        parameters: gmailParameters,
        fallbackKind: "activate_task",
        fallbackTargetTaskId: fallback.id,
      });
      expect(activate.fallbackTargetTaskId).toBe(fallback.id);

      const create = await createWaitCondition(db, {
        taskId: task.id,
        kind: "gmail.thread_reply",
        parameters: { ...gmailParameters, threadId: "thread-456" },
        fallbackKind: "create_task",
        fallbackSpec: { title: "Follow up", nextAction: "Open Gmail and draft a follow-up" },
      });
      expect(create.fallbackSpec).toMatchObject({
        title: "Follow up",
        nextAction: "Open Gmail and draft a follow-up",
        priority: null,
      });

      await completeTask(db, fallback.id);
      await expect(
        createWaitCondition(db, {
          taskId: task.id,
          kind: "gmail.thread_reply",
          parameters: { ...gmailParameters, threadId: "thread-789" },
          fallbackKind: "activate_task",
          fallbackTargetTaskId: fallback.id,
        }),
      ).rejects.toThrow(/Fallback task is terminal/);
    } finally {
      await close();
    }
  });

  it("atomically cancels waiting conditions when a task completes or is deleted", async () => {
    const { db, client, close } = await freshDb();
    try {
      const completedTask = await createTask(db, { title: "Complete parent" });
      const completedWait = await createWaitCondition(db, {
        taskId: completedTask.id,
        kind: "gmail.thread_reply",
        parameters: gmailParameters,
      });
      await completeTask(db, completedTask.id, { actor: "agent-a" });
      expect(await getWaitCondition(db, completedWait.id)).toMatchObject({
        status: "cancelled",
        cancelReason: "task_terminal",
      });

      const deletedTask = await createTask(db, { title: "Delete parent" });
      const deletedWait = await createWaitCondition(db, {
        taskId: deletedTask.id,
        kind: "gmail.thread_reply",
        parameters: { ...gmailParameters, threadId: "delete-me" },
      });
      await softDeleteTask(db, deletedTask.id, { actor: "agent-a" });
      expect((await getTask(db, deletedTask.id))?.deletedAt).not.toBeNull();
      expect(await getWaitCondition(db, deletedWait.id)).toMatchObject({
        status: "cancelled",
        cancelReason: "task_terminal",
      });

      const guardedTask = await createTask(db, { title: "Raw SQL guard" });
      await createWaitCondition(db, {
        taskId: guardedTask.id,
        kind: "gmail.thread_reply",
        parameters: { ...gmailParameters, threadId: "guard" },
      });
      await expect(
        client.execute({
          sql: "UPDATE task SET status='done', completed_at=?, updated_at=?, revision=revision+1 WHERE id=?",
          args: [Date.now(), Date.now(), guardedTask.id],
        }),
      ).rejects.toThrow(/waiting conditions/);
    } finally {
      await close();
    }
  });

  it("rejects identity mutation and invalid cross-row SQL", async () => {
    const { db, client, close } = await freshDb();
    try {
      const task = await createTask(db, { title: "Guard" });
      const condition = await createWaitCondition(db, {
        taskId: task.id,
        kind: "gmail.thread_reply",
        parameters: gmailParameters,
      });
      await expect(
        client.execute({
          sql: `UPDATE wait_condition
            SET parameters='{}', status='cancelled', cancelled_at=updated_at+1,
                cancel_reason='tamper', updated_at=updated_at+1
            WHERE id=?`,
          args: [condition.id],
        }),
      ).rejects.toThrow(/identity is immutable/);
      await ensureBundledReferenceExtension(db, { tenantId: "other-tenant" });
      const identity = WAIT_KIND_EXTENSION_IDENTITIES["gmail.thread_reply"];
      await expect(
        client.execute({
          sql: `INSERT INTO wait_condition (
            id, tenant_id, task_id, kind, type_uri, schema_version,
            evaluator_uri, evaluator_version, evaluator_implementation_digest,
            parameters, status,
            not_before, fallback_kind, created_at, updated_at
          ) VALUES (?, 'other-tenant', ?, 'gmail.thread_reply', ?, 1, ?, 1, ?, '{}',
            'waiting', 1000, 'none', 1000, 1000)`,
          args: [
            "01920000-0000-7000-8000-000000000099",
            task.id,
            identity.typeUri,
            identity.evaluatorUri,
            REFERENCE_EVALUATOR_IMPLEMENTATION_DIGEST,
          ],
        }),
      ).rejects.toThrow(/invalid wait condition relationship/);
    } finally {
      await close();
    }
  });

  it("doctor reports waiting state stranded on a terminal task", async () => {
    const { db, client, close } = await freshDb();
    try {
      const task = await createTask(db, { title: "Corrupt wait owner" });
      await createWaitCondition(db, {
        taskId: task.id,
        kind: "gmail.thread_reply",
        parameters: gmailParameters,
      });
      await client.execute("DROP TRIGGER task_no_terminal_with_waiting_condition");
      await client.execute({
        sql: "UPDATE task SET status='done', completed_at=?, updated_at=?, revision=revision+1 WHERE id=?",
        args: [Date.now(), Date.now(), task.id],
      });
      const report = await diagnoseStore(db, client);
      expect(report.ok).toBe(false);
      expect(report.issues.map((issue) => issue.code)).toContain(
        "waiting_condition_inactive_task",
      );
    } finally {
      await close();
    }
  });
});

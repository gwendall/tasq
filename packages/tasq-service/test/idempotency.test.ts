import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_IDEMPOTENCY_RETENTION_MS,
  addCommitmentRelation,
  addTaskEvidence,
  committedMutationCount,
  createTask,
  listIdempotencyRecords,
  listTasks,
  openDb,
  pruneExpiredIdempotency,
  runMigrations,
  startTask,
  updateTask,
} from "../src/index.js";

const tmpDirs: string[] = [];

afterEach(() => {
  while (tmpDirs.length > 0) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

async function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "tasq-idempotency-"));
  tmpDirs.push(dir);
  const handle = await openDb({ url: `file:${join(dir, "db.sqlite")}`, wal: false });
  await runMigrations(handle.client, { now: 1 });
  return handle;
}

describe("universal durable idempotency", () => {
  it("scopes one client key by workspace caller and operation", async () => {
    const { db, close } = await freshDb();
    try {
      const first = await createTask(db, { title: "Runtime A" }, {
        actor: "runtime-a",
        idempotencyKey: "request-1",
        now: 1_000,
      });
      const second = await createTask(db, { title: "Runtime B" }, {
        actor: "runtime-b",
        idempotencyKey: "request-1",
        now: 1_000,
      });
      expect(second.id).not.toBe(first.id);

      const updated = await updateTask(db, first.id, { title: "Runtime A updated" }, {
        actor: "runtime-a",
        idempotencyKey: "request-1",
        expectedRevision: 1,
        now: 2_000,
      });
      expect(updated.revision).toBe(2);

      const records = await listIdempotencyRecords(db, { key: "request-1" });
      expect(records.map((value) => `${value.callerScope}/${value.operation}`).sort()).toEqual([
        "actor:runtime-a/task.create",
        "actor:runtime-a/task.update",
        "actor:runtime-b/task.create",
      ]);
      expect(records.every((value) => value.digestVersion === "tasq.jcs.sha256.v1")).toBe(true);
      expect(records.find((value) => value.operation === "task.update")).toMatchObject({
        resultType: "commitment",
        resultId: first.id,
        resultStatus: "open",
        resultRevision: 2,
      });
    } finally {
      await close();
    }
  });

  it("derives identity workspace from the accepted input when context omits it", async () => {
    const { db, close } = await freshDb();
    try {
      const task = await createTask(db, {
        tenantId: "remote-workspace",
        title: "Remote result",
      }, { actor: "runtime", now: 1_000 });
      const evidence = await addTaskEvidence(db, {
        tenantId: "remote-workspace",
        taskId: task.id,
        kind: "result",
        summary: "Recorded remotely",
      }, {
        actor: "runtime",
        idempotencyKey: "remote-evidence-1",
        now: 2_000,
      });
      const [record] = await listIdempotencyRecords(db, {
        tenantId: "remote-workspace",
        key: "remote-evidence-1",
      });
      expect(record).toMatchObject({
        tenantId: "remote-workspace",
        resultId: evidence.id,
      });
      expect(await listIdempotencyRecords(db, {
        tenantId: "gwendall",
        key: "remote-evidence-1",
      })).toEqual([]);
    } finally {
      await close();
    }
  });

  it("replays a lost update response before CAS and rejects conflicting reuse", async () => {
    const { db, close } = await freshDb();
    try {
      const task = await createTask(db, { title: "Original" }, { now: 10_000 });
      const options = {
        actor: "editor",
        idempotencyKey: "edit-1",
        expectedRevision: 1,
        now: 11_000,
      };
      const accepted = await updateTask(db, task.id, { title: "Accepted" }, options);
      const replayed = await updateTask(db, task.id, { title: "Accepted" }, {
        ...options,
        now: 99_000,
      });
      expect(replayed).toEqual(accepted);
      expect((await listTasks(db)).filter((value) => value.id === task.id)[0]?.revision).toBe(2);

      await expect(updateTask(db, task.id, { title: "Different" }, {
        ...options,
        now: 100_000,
      })).rejects.toThrow(/different request/);
    } finally {
      await close();
    }
  });

  it("replays mutable transitions and preserves their committed event cursor", async () => {
    const { db, close } = await freshDb();
    try {
      const task = await createTask(db, { title: "Transition" }, { now: 20_000 });
      const first = await startTask(db, task.id, {
        actor: "runner",
        expectedRevision: 1,
        idempotencyKey: "start-1",
        now: 21_000,
      });
      const replay = await startTask(db, task.id, {
        actor: "runner",
        expectedRevision: 1,
        idempotencyKey: "start-1",
        now: 90_000,
      });
      expect(replay).toEqual(first);
      const [record] = await listIdempotencyRecords(db, {
        callerScope: "actor:runner",
        operation: "task.transition.in_progress",
        key: "start-1",
      });
      expect(record).toMatchObject({ resultRevision: 2, resultStatus: "in_progress" });
      expect(record?.eventSequence).toBeNumber();
    } finally {
      await close();
    }
  });

  it("expires standard identities only at the injected boundary and prunes operationally", async () => {
    const { db, close } = await freshDb();
    try {
      const createdAt = 30_000;
      const request = { title: "May repeat after horizon" };
      const context = { actor: "importer", idempotencyKey: "batch-row-1", now: createdAt };
      const first = await createTask(db, request, context);
      const beforeBoundary = await createTask(db, request, {
        ...context,
        now: createdAt + DEFAULT_IDEMPOTENCY_RETENTION_MS - 1,
      });
      expect(beforeBoundary.id).toBe(first.id);

      const beforePruneMutationCount = committedMutationCount(db);
      const notYet = await pruneExpiredIdempotency(db, {
        now: createdAt + DEFAULT_IDEMPOTENCY_RETENTION_MS - 1,
      });
      expect(notYet.pruned).toBe(0);
      expect(committedMutationCount(db)).toBe(beforePruneMutationCount);

      const pruned = await pruneExpiredIdempotency(db, {
        now: createdAt + DEFAULT_IDEMPOTENCY_RETENTION_MS,
      });
      expect(pruned.pruned).toBe(1);
      expect(committedMutationCount(db)).toBe(beforePruneMutationCount);

      const second = await createTask(db, request, {
        ...context,
        now: createdAt + DEFAULT_IDEMPOTENCY_RETENTION_MS,
      });
      expect(second.id).not.toBe(first.id);
    } finally {
      await close();
    }
  });

  it("never prunes durable protocol and external identity records", async () => {
    const { db, close } = await freshDb();
    try {
      const from = await createTask(db, { title: "From" }, { actor: "planner", now: 1_000 });
      const to = await createTask(db, { title: "To" }, { actor: "planner", now: 1_001 });
      const relation = await addCommitmentRelation(db, {
        fromTaskId: from.id,
        relationType: "relates_to",
        toTaskId: to.id,
      }, {
        actor: "planner",
        idempotencyKey: "remote-relation-1",
        now: 2_000,
      });
      await pruneExpiredIdempotency(db, {
        now: 2_000 + 365 * 24 * 60 * 60 * 1_000,
      });
      const [record] = await listIdempotencyRecords(db, { key: "remote-relation-1" });
      expect(record).toMatchObject({
        retentionClass: "durable",
        expiresAt: null,
        resultId: relation.id,
        resultType: "commitment_relation",
      });
    } finally {
      await close();
    }
  });
});

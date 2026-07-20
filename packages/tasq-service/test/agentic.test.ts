import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireTaskClaim,
  addTaskEvidence,
  completeTask,
  createTask,
  diagnoseStore,
  getActiveTaskClaim,
  getTask,
  listEvents,
  listTaskAttempts,
  listTaskClaims,
  listTaskEvidence,
  openDb,
  pickNext,
  releaseTaskClaim,
  runMigrations,
  softDeleteTask,
  startTaskAttempt,
  transitionTaskAttempt,
} from "../src/index.js";

const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length > 0) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

async function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "tasq-agentic-"));
  tmpDirs.push(dir);
  const handle = await openDb({ url: `file:${join(dir, "db.sqlite")}`, wal: false });
  await runMigrations(handle.client);
  return handle;
}

describe("exclusive task claims", () => {
  it("allows exactly one actor to win a concurrent claim race", async () => {
    const { db, close } = await freshDb();
    try {
      const task = await createTask(db, { title: "Shared work" });
      const outcomes = await Promise.allSettled([
        acquireTaskClaim(db, task.id, { actor: "agent-a", leaseMs: 60_000 }),
        acquireTaskClaim(db, task.id, { actor: "agent-b", leaseMs: 60_000 }),
      ]);
      expect(outcomes.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(outcomes.filter((result) => result.status === "rejected")).toHaveLength(1);
      expect(await listTaskClaims(db, task.id, { activeOnly: true })).toHaveLength(1);
    } finally {
      await close();
    }
  });

  it("renews its own claim and replaces an expired claim atomically", async () => {
    const { db, close } = await freshDb();
    try {
      const task = await createTask(db, { title: "Lease" });
      const first = await acquireTaskClaim(db, task.id, {
        actor: "agent-a",
        leaseMs: 5_000,
        now: 10_000,
      });
      const renewed = await acquireTaskClaim(db, task.id, {
        actor: "agent-a",
        leaseMs: 8_000,
        now: 12_000,
        expectedRevision: first.revision,
      });
      expect(renewed.id).toBe(first.id);
      expect(renewed.fence).toBe(first.fence);
      expect(renewed.expiresAt).toBe(20_000);
      expect(renewed.revision).toBe(first.revision + 1);
      await expect(acquireTaskClaim(db, task.id, {
        actor: "agent-a",
        leaseMs: 8_000,
        now: 13_000,
        expectedRevision: first.revision,
      })).rejects.toThrow(/Stale claim revision/);

      const replacement = await acquireTaskClaim(db, task.id, {
        actor: "agent-b",
        leaseMs: 8_000,
        now: 21_000,
      });
      expect(replacement.id).not.toBe(first.id);
      expect(replacement.fence).toBe(first.fence + 1);
      const history = await listTaskClaims(db, task.id);
      expect(history).toHaveLength(2);
      expect(history.find((claim) => claim.id === first.id)?.releaseReason).toBe("expired");
    } finally {
      await close();
    }
  });

  it("keeps another actor's claimed work out of next", async () => {
    const { db, close } = await freshDb();
    try {
      const claimed = await createTask(db, { title: "Claimed", nextAction: "Do it" });
      const free = await createTask(db, { title: "Free", nextAction: "Do that" });
      await acquireTaskClaim(db, claimed.id, { actor: "agent-a", leaseMs: 60_000 });

      const forB = await pickNext(db, { actor: "agent-b", limit: 10 });
      expect(forB.map((item) => item.task.id)).toEqual([free.id]);
      const forA = await pickNext(db, { actor: "agent-a", limit: 10 });
      expect(forA.map((item) => item.task.id)).toContain(claimed.id);
      const all = await pickNext(db, { actor: "agent-b", includeClaimed: true, limit: 10 });
      expect(all.map((item) => item.task.id)).toContain(claimed.id);
    } finally {
      await close();
    }
  });

  it("requires ownership to release unless force is explicit", async () => {
    const { db, close } = await freshDb();
    try {
      const task = await createTask(db, { title: "Owned" });
      const claim = await acquireTaskClaim(db, task.id, { actor: "agent-a" });
      await expect(releaseTaskClaim(db, task.id, { actor: "agent-b" })).rejects.toThrow(/belongs to agent-a/);
      const released = await releaseTaskClaim(db, task.id, {
        actor: "operator",
        force: true,
        reason: "reassigned",
        expectedRevision: claim.revision,
        idempotencyKey: "operator-release-1",
      });
      expect(await releaseTaskClaim(db, task.id, {
        actor: "operator",
        force: true,
        reason: "reassigned",
        expectedRevision: claim.revision,
        idempotencyKey: "operator-release-1",
      })).toEqual(released);
      expect(await getActiveTaskClaim(db, task.id)).toBeNull();
    } finally {
      await close();
    }
  });
});

describe("attempts are executions, not commitments", () => {
  it("deduplicates claim, attempt and evidence creation across retries", async () => {
    const { db, close } = await freshDb();
    try {
      const task = await createTask(db, { title: "Retry-safe" });
      const claimA = await acquireTaskClaim(db, task.id, {
        actor: "agent-a",
        idempotencyKey: "claim-1",
      });
      const claimB = await acquireTaskClaim(db, task.id, {
        actor: "agent-a",
        idempotencyKey: "claim-1",
      });
      expect(claimB.id).toBe(claimA.id);

      const attemptA = await startTaskAttempt(db, task.id, {
        actor: "agent-a",
        idempotencyKey: "attempt-1",
      });
      const attemptB = await startTaskAttempt(db, task.id, {
        actor: "agent-a",
        idempotencyKey: "attempt-1",
        occurredAt: attemptA.startedAt + 1_000,
      });
      expect(attemptB.id).toBe(attemptA.id);
      expect(attemptB.startedAt).toBe(attemptA.startedAt);
      await expect(
        startTaskAttempt(db, task.id, {
          actor: "agent-a",
          idempotencyKey: "attempt-1",
          runtime: "different-runtime",
        }),
      ).rejects.toThrow(/different request/);

      const input = { taskId: task.id, attemptId: attemptA.id, kind: "log", summary: "ok" };
      const evidenceA = await addTaskEvidence(db, input, {
        actor: "agent-a",
        idempotencyKey: "evidence-1",
      });
      const evidenceB = await addTaskEvidence(db, input, {
        actor: "agent-a",
        idempotencyKey: "evidence-1",
      });
      expect(evidenceB.id).toBe(evidenceA.id);
    } finally {
      await close();
    }
  });

  it("records monotone nonterminal protocol progress without accepting older snapshots", async () => {
    const { db, close } = await freshDb();
    try {
      const task = await createTask(db, { title: "Remote progress" }, { now: 1_000 });
      const attempt = await startTaskAttempt(db, task.id, {
        actor: "adapter",
        occurredAt: 2_000,
      });
      const heartbeat = await transitionTaskAttempt(db, attempt.id, "running", {
        actor: "adapter",
        expectedRevision: attempt.revision,
        message: "remote worker accepted",
        occurredAt: 3_000,
        idempotencyKey: "remote-progress-1",
      });
      expect(heartbeat).toMatchObject({ status: "running", revision: 2, updatedAt: 3_000 });
      expect(await transitionTaskAttempt(db, attempt.id, "running", {
        actor: "adapter",
        expectedRevision: attempt.revision,
        message: "remote worker accepted",
        occurredAt: 3_000,
        idempotencyKey: "remote-progress-1",
        now: 9_000,
      })).toEqual(heartbeat);
      await expect(transitionTaskAttempt(db, attempt.id, "input_required", {
        actor: "adapter",
        expectedRevision: heartbeat.revision,
        occurredAt: 2_500,
      })).rejects.toThrow(/precedes revision time/);
    } finally {
      await close();
    }
  });

  it("keeps a succeeded attempt terminal and leaves the task open", async () => {
    const { db, close } = await freshDb();
    try {
      const task = await createTask(db, { title: "Outcome" });
      const attempt = await startTaskAttempt(db, task.id, {
        actor: "agent-a",
        runtime: "a2a",
        externalId: "remote-123",
        contextId: "context-9",
      });
      expect(attempt.revision).toBe(1);
      const waiting = await transitionTaskAttempt(db, attempt.id, "input_required", {
        actor: "agent-a",
        message: "needs a fixture",
        expectedRevision: attempt.revision,
      });
      expect(waiting.revision).toBe(2);
      await expect(transitionTaskAttempt(db, attempt.id, "succeeded", {
        actor: "agent-a",
        expectedRevision: attempt.revision,
      })).rejects.toThrow(/Stale attempt revision/);
      const succeeded = await transitionTaskAttempt(db, attempt.id, "succeeded", {
        actor: "agent-a",
        message: "tool returned successfully",
        expectedRevision: waiting.revision,
      });
      expect(succeeded.status).toBe("succeeded");
      expect(succeeded.revision).toBe(3);
      expect((await getTask(db, task.id))?.status).toBe("open");
      await expect(
        transitionTaskAttempt(db, attempt.id, "running", { actor: "agent-a" }),
      ).rejects.toThrow(/terminal.*immutable/);
    } finally {
      await close();
    }
  });

  it("refuses to finish a commitment while an attempt is still active", async () => {
    const { db, close } = await freshDb();
    try {
      const task = await createTask(db, { title: "Still executing" });
      const claim = await acquireTaskClaim(db, task.id, { actor: "agent-a" });
      const attempt = await startTaskAttempt(db, task.id, { actor: "agent-a" });
      expect(attempt.claimId).toBe(claim.id);
      await expect(completeTask(db, task.id, { actor: "agent-a" })).rejects.toThrow(/active attempt/);
      await transitionTaskAttempt(db, attempt.id, "succeeded", { actor: "agent-a" });
      await completeTask(db, task.id, { actor: "agent-a" });
      expect(await getActiveTaskClaim(db, task.id)).toBeNull();
      expect((await getTask(db, task.id))?.status).toBe("done");
    } finally {
      await close();
    }
  });

  it("won't start under another actor's live claim", async () => {
    const { db, close } = await freshDb();
    try {
      const task = await createTask(db, { title: "Exclusive execution" });
      await acquireTaskClaim(db, task.id, { actor: "agent-a" });
      await expect(startTaskAttempt(db, task.id, { actor: "agent-b" })).rejects.toThrow(/claimed by agent-a/);
      expect(await listTaskAttempts(db, task.id)).toHaveLength(0);
    } finally {
      await close();
    }
  });

  it("cancels active attempts and releases claims when a task is deleted", async () => {
    const { db, close } = await freshDb();
    try {
      const task = await createTask(db, { title: "Remove safely" });
      await acquireTaskClaim(db, task.id, { actor: "agent-a" });
      const attempt = await startTaskAttempt(db, task.id, { actor: "agent-a" });
      await softDeleteTask(db, task.id, { actor: "operator" });
      expect(await getActiveTaskClaim(db, task.id)).toBeNull();
      expect((await listTaskAttempts(db, task.id))[0]?.id).toBe(attempt.id);
      expect((await listTaskAttempts(db, task.id))[0]?.status).toBe("cancelled");
    } finally {
      await close();
    }
  });
});

describe("evidence-backed completion", () => {
  it("requires explicit evidence for evidence-mode tasks", async () => {
    const { db, close } = await freshDb();
    try {
      const task = await createTask(db, {
        title: "Ship release",
        successCriteria: "Published release is reachable",
        completionMode: "evidence",
      });
      await expect(completeTask(db, task.id, { actor: "agent-a" })).rejects.toThrow(/requires explicit evidence/);

      const evidence = await addTaskEvidence(
        db,
        {
          taskId: task.id,
          kind: "deployment",
          uri: "https://example.test/releases/1",
          summary: "Release endpoint returned 200",
          digest: "sha256:abc123",
          source: "watcher:http",
        },
        { actor: "watcher" },
      );
      const done = await completeTask(db, task.id, {
        actor: "agent-a",
        evidenceIds: [evidence.id, evidence.id],
      });
      expect(done.status).toBe("done");
      const completed = (await listEvents(db, { entityId: task.id })).find((event) => event.eventType === "completed");
      expect((completed?.payload.after as Record<string, unknown>)?.evidenceIds).toEqual([evidence.id]);
    } finally {
      await close();
    }
  });

  it("binds evidence and supersession to one task", async () => {
    const { db, close } = await freshDb();
    try {
      const a = await createTask(db, { title: "A" });
      const b = await createTask(db, { title: "B" });
      const prior = await addTaskEvidence(db, { taskId: a.id, kind: "assertion", summary: "First" });
      const correction = await addTaskEvidence(db, {
        taskId: a.id,
        kind: "observation",
        summary: "Corrected",
        supersedesEvidenceId: prior.id,
      });
      expect(correction.supersedesEvidenceId).toBe(prior.id);
      await expect(
        addTaskEvidence(db, {
          taskId: b.id,
          kind: "observation",
          summary: "Wrong task",
          supersedesEvidenceId: prior.id,
        }),
      ).rejects.toThrow(/does not belong/);
      expect(await listTaskEvidence(db, a.id)).toHaveLength(2);
    } finally {
      await close();
    }
  });
});

describe("database-level agentic invariants", () => {
  it("rejects invalid claim chronology and fence reuse below the service layer", async () => {
    const { db, client, close } = await freshDb();
    try {
      const task = await createTask(db, { title: "Fenced" });
      const claim = await acquireTaskClaim(db, task.id, {
        actor: "agent-a",
        now: 10_000,
        leaseMs: 5_000,
      });
      await expect(
        acquireTaskClaim(db, task.id, {
          actor: "agent-a",
          now: 9_999,
          leaseMs: 5_000,
        }),
      ).rejects.toThrow(/clock moved backwards/);
      await expect(
        releaseTaskClaim(db, task.id, { actor: "agent-a", now: 9_999 }),
      ).rejects.toThrow(/precedes claim acquisition/);
      await expect(
        client.execute({
          sql: "UPDATE task_claim SET heartbeat_at = ?, revision = revision + 1 WHERE id = ?",
          args: [9_999, claim.id],
        }),
      ).rejects.toThrow(/invalid task claim invariant/);

      await releaseTaskClaim(db, task.id, { actor: "agent-a", now: 11_000 });
      await expect(
        client.execute({
          sql: `INSERT INTO task_claim (
            id, tenant_id, task_id, actor, fence, acquired_at, heartbeat_at,
            expires_at, metadata, created_at, updated_at
          ) VALUES (?, 'gwendall', ?, 'agent-b', ?, 12000, 12000, 17000, '{}', 12000, 12000)`,
          args: ["01920000-0000-7000-8000-000000000001", task.id, claim.fence],
        }),
      ).rejects.toThrow(/UNIQUE constraint/);
    } finally {
      await close();
    }
  });

  it("makes terminal attempts and evidence physically append-only", async () => {
    const { db, client, close } = await freshDb();
    try {
      const task = await createTask(db, { title: "Immutable history" });
      const attempt = await startTaskAttempt(db, task.id, {
        actor: "agent-a",
        occurredAt: 20_000,
      });
      await expect(
        transitionTaskAttempt(db, attempt.id, "succeeded", {
          actor: "agent-a",
          occurredAt: 19_999,
        }),
      ).rejects.toThrow(/precedes start/);
      await transitionTaskAttempt(db, attempt.id, "succeeded", {
        actor: "agent-a",
        occurredAt: 21_000,
      });
      await expect(
        client.execute({
          sql: "UPDATE task_attempt SET status = 'running', ended_at = NULL, revision = revision + 1 WHERE id = ?",
          args: [attempt.id],
        }),
      ).rejects.toThrow(/terminal task attempts are immutable|invalid task attempt lifecycle/);
      await expect(
        client.execute({ sql: "DELETE FROM task_attempt WHERE id = ?", args: [attempt.id] }),
      ).rejects.toThrow(/append-only/);

      const evidence = await addTaskEvidence(db, {
        taskId: task.id,
        attemptId: attempt.id,
        kind: "receipt",
        summary: "original",
      });
      await expect(
        client.execute({
          sql: "UPDATE task_evidence SET summary = 'rewritten' WHERE id = ?",
          args: [evidence.id],
        }),
      ).rejects.toThrow(/append-only/);
      await expect(
        client.execute({ sql: "DELETE FROM task_evidence WHERE id = ?", args: [evidence.id] }),
      ).rejects.toThrow(/append-only/);
    } finally {
      await close();
    }
  });

  it("rejects cross-task links and terminal tasks with active attempts", async () => {
    const { db, client, close } = await freshDb();
    try {
      const a = await createTask(db, { title: "A" });
      const b = await createTask(db, { title: "B" });
      const attempt = await startTaskAttempt(db, a.id, {
        actor: "agent-a",
        occurredAt: 30_000,
      });

      await expect(
        client.execute({
          sql: `INSERT INTO task_evidence (
            id, tenant_id, task_id, attempt_id, actor, kind, summary,
            observed_at, metadata, created_at
          ) VALUES (?, 'gwendall', ?, ?, 'watcher', 'receipt', 'wrong task', 30001, '{}', 30001)`,
          args: ["01920000-0000-7000-8000-000000000002", b.id, attempt.id],
        }),
      ).rejects.toThrow(/invalid task evidence invariant/);

      await expect(
        client.execute({
          sql: "UPDATE task SET status = 'done', completed_at = 30002, revision = revision + 1 WHERE id = ?",
          args: [a.id],
        }),
      ).rejects.toThrow(/cannot have active attempts/);

      await expect(
        client.execute({
          sql: "UPDATE task SET completion_mode = 'evidence', success_criteria = NULL, revision = revision + 1 WHERE id = ?",
          args: [b.id],
        }),
      ).rejects.toThrow(/requires success criteria/);
    } finally {
      await close();
    }
  });

  it("doctor identifies corrupted agentic state even if guards were removed", async () => {
    const { db, client, close } = await freshDb();
    try {
      const claimTask = await createTask(db, { title: "Broken claim" });
      const claim = await acquireTaskClaim(db, claimTask.id, {
        actor: "agent-a",
        now: 10_000,
        leaseMs: 5_000,
      });
      await client.execute("DROP TRIGGER task_claim_validate_update");
      await client.execute({
        sql: "UPDATE task_claim SET heartbeat_at = 9000, revision = revision + 1 WHERE id = ?",
        args: [claim.id],
      });

      const terminalTask = await createTask(db, { title: "Broken attempt" });
      const terminalAttempt = await startTaskAttempt(db, terminalTask.id, {
        actor: "agent-a",
        occurredAt: 20_000,
      });
      await client.execute("DROP TRIGGER task_attempt_validate_update");
      await client.execute({
        sql: "UPDATE task_attempt SET status = 'succeeded', revision = revision + 1 WHERE id = ?",
        args: [terminalAttempt.id],
      });

      const evidenceA = await addTaskEvidence(db, {
        taskId: terminalTask.id,
        kind: "observation",
        summary: "A",
      });
      const otherTask = await createTask(db, { title: "Other evidence task" });
      const evidenceB = await addTaskEvidence(db, {
        taskId: otherTask.id,
        kind: "observation",
        summary: "B",
      });
      await client.execute("DROP TRIGGER task_evidence_no_update");
      await client.execute({
        sql: "UPDATE task_evidence SET supersedes_evidence_id = ? WHERE id = ?",
        args: [evidenceA.id, evidenceB.id],
      });

      const activeTask = await createTask(db, { title: "Terminal with active attempt" });
      await startTaskAttempt(db, activeTask.id, { actor: "agent-a" });
      await client.execute("DROP TRIGGER task_no_terminal_with_active_attempt");
      await client.execute({
        sql: "UPDATE task SET status = 'done', completed_at = ?, revision = revision + 1 WHERE id = ?",
        args: [Date.now(), activeTask.id],
      });

      const report = await diagnoseStore(db, client);
      expect(report.ok).toBe(false);
      const codes = new Set(report.issues.map((entry) => entry.code));
      expect(codes.has("claim_invalid_chronology")).toBe(true);
      expect(codes.has("terminal_attempt_without_end")).toBe(true);
      expect(codes.has("evidence_supersession_mismatch")).toBe(true);
      expect(codes.has("active_attempt_inactive_task")).toBe(true);
    } finally {
      await close();
    }
  });
});

/**
 * Eval: resilient agent execution across lost responses, crashes, retries and
 * stale leases.
 *
 * These are full agent narratives rather than isolated service invariants:
 * the assertions describe what a replacement worker can observe and safely do
 * after its predecessor disappears at an inconvenient point.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireTaskClaim,
  addTaskEvidence,
  completeTask,
  createTask,
  getActiveTaskClaim,
  getTask,
  listEvents,
  listTaskAttempts,
  listTaskClaims,
  listTaskEvidence,
  openDb,
  releaseTaskClaim,
  runMigrations,
  startTaskAttempt,
  transitionTaskAttempt,
} from "@tasq-internal/local-service";

const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length > 0) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

async function freshSetup() {
  const dir = mkdtempSync(join(tmpdir(), "tasq-agentic-eval-"));
  tmpDirs.push(dir);
  const handle = await openDb({ url: `file:${join(dir, "db.sqlite")}`, wal: false });
  await runMigrations(handle.client);
  return handle;
}

describe("agentic resilience", () => {
  it("assertion mode: a replacement worker reconciles a crash without duplicate work", async () => {
    const { db, close } = await freshSetup();
    try {
      // Keep the deterministic domain timeline behind recording time so the
      // eval does not manufacture a lease acquired in the wall-clock future.
      const base = Date.now() - 10_000;
      const task = await createTask(db, {
        title: "Regenerate local search index",
        nextAction: "Run the deterministic index builder",
        successCriteria: "Builder exits successfully and index opens",
        completionMode: "assertion",
      });

      // Agent A's claim response is lost. Retrying the same command identity
      // returns the original lease rather than creating a second claim/event.
      const lostClaimResponse = await acquireTaskClaim(db, task.id, {
        actor: "agent-a",
        leaseMs: 1_000,
        now: base,
        idempotencyKey: "reindex-claim-a",
      });
      const retriedClaim = await acquireTaskClaim(db, task.id, {
        actor: "agent-a",
        leaseMs: 1_000,
        now: base + 100,
        idempotencyKey: "reindex-claim-a",
      });
      expect(retriedClaim.id).toBe(lostClaimResponse.id);
      expect(retriedClaim.fence).toBe(1);

      // The worker starts an attempt, receives no response, retries safely,
      // then crashes before recording a terminal state.
      const lostAttemptResponse = await startTaskAttempt(db, task.id, {
        actor: "agent-a",
        occurredAt: base + 200,
        idempotencyKey: "reindex-attempt-a",
      });
      const retriedAttempt = await startTaskAttempt(db, task.id, {
        actor: "agent-a",
        occurredAt: base + 200,
        idempotencyKey: "reindex-attempt-a",
      });
      expect(retriedAttempt.id).toBe(lostAttemptResponse.id);
      expect(await listTaskAttempts(db, task.id)).toHaveLength(1);

      // After lease expiry, agent B takes over with a strictly newer fence.
      const replacement = await acquireTaskClaim(db, task.id, {
        actor: "agent-b",
        leaseMs: 5_000,
        now: base + 1_100,
        idempotencyKey: "reindex-claim-b",
      });
      expect(replacement.fence).toBe(lostClaimResponse.fence + 1);
      expect((await getActiveTaskClaim(db, task.id, "gwendall", base + 1_200))?.id)
        .toBe(replacement.id);

      // A late retry by the crashed worker resolves to its old, released lease;
      // it cannot start new work or release B's ownership.
      const staleRetry = await acquireTaskClaim(db, task.id, {
        actor: "agent-a",
        leaseMs: 1_000,
        now: base + 1_200,
        idempotencyKey: "reindex-claim-a",
      });
      expect(staleRetry.id).toBe(lostClaimResponse.id);
      expect(staleRetry.releaseReason).toBe("expired");
      expect(staleRetry.fence).toBeLessThan(replacement.fence);
      await expect(
        startTaskAttempt(db, task.id, {
          actor: "agent-a",
          claimId: staleRetry.id,
          occurredAt: base + 1_300,
        }),
      ).rejects.toThrow(/claimed by agent-b|not active/);
      await expect(
        releaseTaskClaim(db, task.id, { actor: "agent-a", now: base + 1_300 }),
      ).rejects.toThrow(/belongs to agent-b/);

      // The replacement explicitly reconciles the orphan attempt, performs a
      // fresh execution, then asserts the local deterministic outcome.
      await transitionTaskAttempt(db, lostAttemptResponse.id, "cancelled", {
        actor: "agent-b:reconciler",
        message: "predecessor lease expired before reporting a result",
        occurredAt: base + 1_400,
      });
      const replacementAttempt = await startTaskAttempt(db, task.id, {
        actor: "agent-b",
        occurredAt: base + 1_500,
        idempotencyKey: "reindex-attempt-b",
      });
      await transitionTaskAttempt(db, replacementAttempt.id, "succeeded", {
        actor: "agent-b",
        message: "index opened and query smoke test passed",
        occurredAt: base + 1_600,
      });

      // Completion response is lost too. Repeating completion is a true no-op:
      // same task, one completion event, no duplicated side effects in Tasq.
      await completeTask(db, task.id, {
        actor: "agent-b",
        note: "local smoke test passed",
        occurredAt: base + 1_700,
      });
      const completionRetry = await completeTask(db, task.id, {
        actor: "agent-b",
        note: "local smoke test passed",
        occurredAt: base + 1_800,
      });
      expect(completionRetry.status).toBe("done");

      const claims = await listTaskClaims(db, task.id);
      expect(claims).toHaveLength(2);
      expect(claims.find((item) => item.id === lostClaimResponse.id)?.releaseReason).toBe("expired");
      expect(claims.find((item) => item.id === replacement.id)?.releaseReason).toBe("task_done");
      const events = await listEvents(db, { entityId: task.id, ascending: true });
      expect(events.filter((event) => event.eventType === "claim_acquired")).toHaveLength(2);
      expect(events.filter((event) => event.eventType === "attempt_started")).toHaveLength(2);
      expect(events.filter((event) => event.eventType === "completed")).toHaveLength(1);
    } finally {
      await close();
    }
  });

  it("evidence mode: execution success remains open until one retry-safe receipt is bound", async () => {
    const { db, close } = await freshSetup();
    try {
      const base = Date.now() - 10_000;
      const task = await createTask(db, {
        title: "Publish public release",
        nextAction: "Deploy and poll the public endpoint",
        successCriteria: "Public release endpoint returns HTTP 200",
        completionMode: "evidence",
      });
      await acquireTaskClaim(db, task.id, {
        actor: "deploy-agent",
        leaseMs: 10_000,
        now: base,
      });

      const attempt = await startTaskAttempt(db, task.id, {
        actor: "deploy-agent",
        runtime: "a2a",
        externalId: "deploy-2026-07-14",
        occurredAt: base + 100,
        idempotencyKey: "deploy-attempt",
      });
      const attemptRetry = await startTaskAttempt(db, task.id, {
        actor: "deploy-agent",
        runtime: "a2a",
        externalId: "deploy-2026-07-14",
        occurredAt: base + 100,
        idempotencyKey: "deploy-attempt",
      });
      expect(attemptRetry.id).toBe(attempt.id);

      const succeeded = await transitionTaskAttempt(db, attempt.id, "succeeded", {
        actor: "deploy-agent",
        message: "provider accepted deployment",
        occurredAt: base + 200,
      });
      const terminalRetry = await transitionTaskAttempt(db, attempt.id, "succeeded", {
        actor: "deploy-agent",
        message: "duplicate callback",
        occurredAt: base + 300,
      });
      expect(terminalRetry.id).toBe(succeeded.id);
      expect((await getTask(db, task.id))?.status).toBe("open");
      await expect(
        completeTask(db, task.id, { actor: "deploy-agent", occurredAt: base + 400 }),
      ).rejects.toThrow(/requires explicit evidence/);

      // The watcher response is lost after commit. Its idempotency key makes
      // retry converge on one immutable receipt.
      const lostEvidenceResponse = await addTaskEvidence(
        db,
        {
          taskId: task.id,
          attemptId: attempt.id,
          kind: "http_observation",
          summary: "GET /release returned 200",
          uri: "https://example.test/release",
          digest: "sha256:response-abc",
          source: "watcher:http",
          observedAt: base + 500,
        },
        { actor: "watcher:http", idempotencyKey: "release-observation" },
      );
      const evidenceRetry = await addTaskEvidence(
        db,
        {
          taskId: task.id,
          attemptId: attempt.id,
          kind: "http_observation",
          summary: "GET /release returned 200",
          uri: "https://example.test/release",
          digest: "sha256:response-abc",
          source: "watcher:http",
          observedAt: base + 500,
        },
        { actor: "watcher:http", idempotencyKey: "release-observation" },
      );
      expect(evidenceRetry.id).toBe(lostEvidenceResponse.id);
      expect(await listTaskEvidence(db, task.id)).toHaveLength(1);

      const done = await completeTask(db, task.id, {
        actor: "deploy-agent",
        evidenceIds: [evidenceRetry.id],
        occurredAt: base + 600,
      });
      expect(done.status).toBe("done");
      await completeTask(db, task.id, {
        actor: "deploy-agent",
        evidenceIds: [evidenceRetry.id],
        occurredAt: base + 700,
      });

      const events = await listEvents(db, { entityId: task.id, ascending: true });
      expect(events.filter((event) => event.eventType === "attempt_started")).toHaveLength(1);
      expect(events.filter((event) => event.eventType === "attempt_succeeded")).toHaveLength(1);
      expect(events.filter((event) => event.eventType === "evidence_added")).toHaveLength(1);
      const completed = events.filter((event) => event.eventType === "completed");
      expect(completed).toHaveLength(1);
      expect((completed[0]?.payload.after as Record<string, unknown>)?.evidenceIds)
        .toEqual([evidenceRetry.id]);
      expect(await getActiveTaskClaim(db, task.id)).toBeNull();
    } finally {
      await close();
    }
  });
});

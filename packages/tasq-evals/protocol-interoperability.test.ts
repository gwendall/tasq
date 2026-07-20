/** UK-010 eval: two protocol executions remain subordinate to one commitment. */

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMutableClock } from "@tasq/schema";
import { syncA2ATask, syncMcpTask } from "@tasq/protocol-adapters";
import {
  addTaskEvidence,
  completeCommitment,
  createCommitment,
  createPrincipal,
  getCommitment,
  inspectCommitment,
  listArtifacts,
  listCompletionRecords,
  listExternalRefs,
  listTaskAttempts,
  listTaskEvidence,
  openDb,
  runKernelMigrations,
} from "@tasq/core";

const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length > 0) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

describe("UK-010 protocol interoperability", () => {
  it("imports MCP and A2A success as executions and requires a separate completion decision", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tasq-protocol-eval-"));
    tmpDirs.push(dir);
    const { db, client, close } = await openDb({ url: `file:${join(dir, "db.sqlite")}`, wal: false });
    const clock = createMutableClock(1_000);
    try {
      await runKernelMigrations(client, { clock });
      clock.set(1_100);
      const coordinator = await createPrincipal(db, {
        displayName: "Outcome coordinator",
        kind: "human",
      }, { clock });
      clock.set(1_200);
      const runtime = await createPrincipal(db, {
        displayName: "Protocol bridge",
        kind: "runtime",
      }, { clock });
      clock.set(1_300);
      const commitment = await createCommitment(db, {
        title: "Deliver a verified cross-runtime answer",
        successCriteria: "A coordinator verifies and binds one digest-bound output",
        completionPolicy: "evidence",
      }, {
        workspaceId: "gwendall",
        actor: "coordinator",
        principalId: coordinator.id,
        clock,
      });

      clock.set(3_000);
      const mcp = await syncMcpTask(db, commitment.id, {
        taskId: "mcp-run-1",
        status: "completed",
        statusMessage: "request finished",
        createdAt: "1970-01-01T00:00:02.000Z",
        lastUpdatedAt: "1970-01-01T00:00:02.500Z",
        result: { answer: 42, source: "runtime-a" },
      }, {
        remoteSystem: "https://mcp-runtime.example.test",
        actor: "bridge:mcp",
        principalId: runtime.id,
        clock,
      });
      clock.set(4_000);
      const a2a = await syncA2ATask(db, commitment.id, {
        id: "a2a-run-1",
        contextId: "conversation-9",
        // A2A timestamps are optional; this must use the injected observation clock.
        status: { state: "TASK_STATE_COMPLETED" },
        artifacts: [{
          artifactId: "answer",
          name: "Independent answer",
          parts: [{ data: { answer: 42, source: "runtime-b" }, mediaType: "application/json" }],
        }],
      }, {
        remoteSystem: "https://a2a-runtime.example.test",
        actor: "bridge:a2a",
        principalId: runtime.id,
        clock,
      });

      expect(mcp.attempt.status).toBe("succeeded");
      expect(a2a.attempt).toMatchObject({ status: "succeeded", startedAt: 4_000, endedAt: 4_000 });
      expect(await listTaskAttempts(db, commitment.id)).toHaveLength(2);
      expect(await listArtifacts(db, { taskId: commitment.id })).toHaveLength(2);
      expect(await listExternalRefs(db, { recordType: "attempt" })).toHaveLength(2);
      expect(await listTaskEvidence(db, commitment.id)).toHaveLength(0);
      expect(await listCompletionRecords(db, commitment.id)).toHaveLength(0);
      expect((await getCommitment(db, commitment.id, "gwendall"))?.status).toBe("open");

      const beforeDecision = await inspectCommitment(db, commitment.id, {
        workspaceId: "gwendall",
        clock,
      });
      if (!beforeDecision) throw new Error("commitment inspection disappeared");
      expect(beforeDecision.attempts.every((attempt) => attempt.status === "succeeded")).toBe(true);
      expect(beforeDecision.artifacts).toHaveLength(2);
      expect(beforeDecision.evidence).toHaveLength(0);
      expect(beforeDecision.completionRecords).toHaveLength(0);

      clock.set(5_000);
      const verified = await addTaskEvidence(db, {
        taskId: commitment.id,
        attemptId: a2a.attempt.id,
        kind: "coordinator_verification",
        summary: "Coordinator compared both outputs and verified the A2A artifact",
        uri: a2a.artifacts[0]!.uri,
        digest: a2a.artifacts[0]!.digest,
        source: "urn:tasq:coordinator-review",
        observedAt: 5_000,
      }, {
        actor: "coordinator",
        principalId: coordinator.id,
        idempotencyKey: "verify-cross-runtime-answer",
        clock,
      });
      clock.set(5_100);
      const completed = await completeCommitment(db, commitment.id, {
        workspaceId: "gwendall",
        actor: "coordinator",
        principalId: coordinator.id,
        expectedRevision: commitment.revision,
        evidenceIds: [verified.id],
        occurredAt: 5_100,
        clock,
      });
      expect(completed.status).toBe("done");
      expect(await listCompletionRecords(db, commitment.id)).toHaveLength(1);
    } finally {
      await close();
    }
  });
});

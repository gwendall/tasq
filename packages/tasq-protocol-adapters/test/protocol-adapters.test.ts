import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createMutableClock,
  type Clock,
} from "@tasq-run/schema";
import {
  createCommitment,
  getCommitment,
  listArtifacts,
  listExternalRefs,
  listTaskAttempts,
  openDb,
  runKernelMigrations,
  type TasqDb,
} from "@tasq-run/core";
import {
  A2ATaskSnapshot,
  INLINE_PROTOCOL_ARTIFACT_MAX_BYTES,
  MCP_TASKS_PROTOCOL_VERSION,
  PROTOCOL_SNAPSHOT_MAX_BYTES,
  ProtocolAdapterManifest,
  TASQ_PROTOCOL_ADAPTER_MANIFEST,
  a2aArtifactContentDigest,
  mapA2ATaskState,
  mapMcpTaskStatus,
  syncA2ATask,
  syncMcpTask,
} from "../src/index.js";

const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length > 0) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "tasq-protocol-adapters-"));
  tmpDirs.push(dir);
  const opened = await openDb({ url: `file:${join(dir, "db.sqlite")}`, wal: false });
  await runKernelMigrations(opened.client, { now: 1_000 });
  const commitment = await createCommitment(opened.db, {
    title: "Obtain a verified remote result",
    successCriteria: "An independently verified result is bound as evidence",
    completionPolicy: "evidence",
  }, { workspaceId: "gwendall", actor: "coordinator", now: 1_100 });
  return { ...opened, commitment };
}

function ctx(clock: Clock, remoteSystem = "https://runtime.example.test") {
  return { remoteSystem, actor: "adapter:remote", clock };
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

describe("protocol status mapping", () => {
  it("publishes a machine-readable no-authority adapter manifest", () => {
    expect(ProtocolAdapterManifest.parse(TASQ_PROTOCOL_ADAPTER_MANIFEST)).toMatchObject({
      contractVersion: "tasq.protocol-adapter.v1",
      completionAuthority: "none",
      requiresInjectedClock: true,
    });
    expect(TASQ_PROTOCOL_ADAPTER_MANIFEST.mappings.map((mapping) => mapping.protocolVersion))
      .toEqual(["2025-11-25", "1.0"]);
  });

  it("maps every MCP Tasks 2025-11-25 status without inventing commitment state", () => {
    expect([
      "working", "input_required", "completed", "failed", "cancelled",
    ].map((status) => mapMcpTaskStatus(status as Parameters<typeof mapMcpTaskStatus>[0]))).toEqual([
      "running", "input_required", "succeeded", "failed", "cancelled",
    ]);
    expect(() => mapMcpTaskStatus("queued" as never)).toThrow();
  });

  it("maps every concrete A2A 1.0 state and rejects unspecified state", () => {
    expect([
      "TASK_STATE_SUBMITTED", "TASK_STATE_WORKING", "TASK_STATE_COMPLETED",
      "TASK_STATE_FAILED", "TASK_STATE_CANCELED", "TASK_STATE_INPUT_REQUIRED",
      "TASK_STATE_REJECTED", "TASK_STATE_AUTH_REQUIRED",
    ].map((state) => mapA2ATaskState(state as Parameters<typeof mapA2ATaskState>[0]))).toEqual([
      "running", "running", "succeeded", "failed", "cancelled",
      "input_required", "failed", "input_required",
    ]);
    expect(() => A2ATaskSnapshot.parse({
      id: "remote-1",
      status: { state: "TASK_STATE_UNSPECIFIED" },
    })).toThrow();
  });
});

describe("MCP Tasks adapter", () => {
  it("replays a complete lifecycle into one attempt/result without completing the commitment", async () => {
    const { db, close, commitment } = await fixture();
    const clock = createMutableClock(10_000);
    try {
      const working = await syncMcpTask(db, commitment.id, {
        taskId: "mcp-task-1",
        status: "working",
        createdAt: iso(2_000),
        lastUpdatedAt: iso(2_000),
        ttl: 60_000,
        pollInterval: 1_000,
      }, ctx(clock));
      expect(working.attempt).toMatchObject({
        status: "running",
        runtime: `mcp:${MCP_TASKS_PROTOCOL_VERSION}`,
        externalId: "mcp-task-1",
        startedAt: 2_000,
      });

      clock.set(11_000);
      const waiting = await syncMcpTask(db, commitment.id, {
        taskId: "mcp-task-1",
        status: "input_required",
        statusMessage: "Approve the generated plan",
        createdAt: iso(2_000),
        lastUpdatedAt: iso(3_000),
      }, ctx(clock));
      expect(waiting.attempt).toMatchObject({ status: "input_required", revision: 2, updatedAt: 3_000 });

      clock.set(12_000);
      const completed = await syncMcpTask(db, commitment.id, {
        taskId: "mcp-task-1",
        status: "completed",
        createdAt: iso(2_000),
        lastUpdatedAt: iso(4_000),
        result: { content: [{ type: "text", text: "finished" }] },
      }, ctx(clock));
      expect(completed.attempt).toMatchObject({ status: "succeeded", revision: 3, endedAt: 4_000 });
      expect(completed.artifacts).toHaveLength(1);
      expect(completed.artifacts[0]).toMatchObject({
        attemptId: completed.attempt.id,
        typeUri: "https://schemas.tasq.dev/protocols/mcp/2025-11-25/result",
      });
      expect(completed.artifacts[0]!.uri).toStartWith("data:application/json;base64,");

      clock.set(13_000);
      const replay = await syncMcpTask(db, commitment.id, {
        taskId: "mcp-task-1",
        status: "completed",
        createdAt: iso(2_000),
        lastUpdatedAt: iso(4_000),
        result: { content: [{ type: "text", text: "finished" }] },
      }, ctx(clock));
      expect(replay.attempt.id).toBe(completed.attempt.id);
      expect(replay.artifacts[0]?.id).toBe(completed.artifacts[0]?.id);
      expect(await listTaskAttempts(db, commitment.id)).toHaveLength(1);
      expect(await listArtifacts(db, { taskId: commitment.id })).toHaveLength(1);
      expect(await listExternalRefs(db, { recordType: "attempt", recordId: completed.attempt.id })).toHaveLength(1);
      expect(await listExternalRefs(db, { recordType: "artifact", recordId: completed.artifacts[0]!.id })).toHaveLength(1);
      expect((await getCommitment(db, commitment.id, "gwendall"))?.status).toBe("open");

      await expect(syncMcpTask(db, commitment.id, {
        taskId: "mcp-task-1",
        status: "completed",
        createdAt: iso(2_000),
        lastUpdatedAt: iso(4_500),
        result: { content: [{ type: "text", text: "changed after terminal" }] },
      }, ctx(clock))).rejects.toThrow(/contradicts immutable terminal snapshot/);
      expect(await listArtifacts(db, { taskId: commitment.id })).toHaveLength(1);
    } finally {
      await close();
    }
  });

  it("namespaces identical remote IDs and refuses identity remapping", async () => {
    const { db, close, commitment } = await fixture();
    const clock = createMutableClock(10_000);
    try {
      const snapshot = {
        taskId: "shared-id",
        status: "working",
        createdAt: iso(2_000),
        lastUpdatedAt: iso(2_000),
      };
      const first = await syncMcpTask(db, commitment.id, snapshot, ctx(clock, "https://one.example.test"));
      const second = await syncMcpTask(db, commitment.id, snapshot, ctx(clock, "https://two.example.test"));
      expect(first.attempt.id).not.toBe(second.attempt.id);

      const other = await createCommitment(db, { title: "Another outcome" }, {
        workspaceId: "gwendall", actor: "coordinator", now: 2_500,
      });
      await expect(syncMcpTask(db, other.id, snapshot, ctx(clock, "https://one.example.test")))
        .rejects.toThrow(/different request/);
    } finally {
      await close();
    }
  });

  it("rejects malformed and oversized snapshots before mutation", async () => {
    const { db, client, close, commitment } = await fixture();
    const clock = createMutableClock(10_000);
    try {
      const before = await client.execute("SELECT total_changes() AS changes");
      await expect(syncMcpTask(db, commitment.id, {
        taskId: "bad",
        status: "queued",
        createdAt: iso(2_000),
        lastUpdatedAt: iso(2_000),
      }, ctx(clock))).rejects.toThrow();
      await expect(syncMcpTask(db, commitment.id, {
        taskId: "huge",
        status: "completed",
        createdAt: iso(2_000),
        lastUpdatedAt: iso(2_000),
        result: "x".repeat(PROTOCOL_SNAPSHOT_MAX_BYTES + 1),
      }, ctx(clock))).rejects.toThrow(/exceeds/);
      const after = await client.execute("SELECT total_changes() AS changes");
      expect(after.rows[0]?.changes).toBe(before.rows[0]?.changes);
    } finally {
      await close();
    }
  });
});

describe("A2A adapter", () => {
  it("preserves monotone progress, context and immutable artifact revisions", async () => {
    const { db, client, close, commitment } = await fixture();
    const clock = createMutableClock(5_000);
    try {
      const submitted = await syncA2ATask(db, commitment.id, {
        id: "a2a-task-1",
        contextId: "context-7",
        status: { state: "TASK_STATE_SUBMITTED", timestamp: iso(5_000) },
      }, ctx(clock));
      expect(submitted.attempt).toMatchObject({
        status: "running", contextId: "context-7", revision: 1,
      });

      clock.set(6_000);
      const working = await syncA2ATask(db, commitment.id, {
        id: "a2a-task-1",
        contextId: "context-7",
        status: { state: "TASK_STATE_WORKING", timestamp: iso(6_000) },
      }, ctx(clock));
      expect(working.attempt).toMatchObject({ status: "running", revision: 2, updatedAt: 6_000 });

      await expect(syncA2ATask(db, commitment.id, {
        id: "a2a-task-1",
        contextId: "context-7",
        status: { state: "TASK_STATE_INPUT_REQUIRED", timestamp: iso(5_500) },
      }, ctx(clock))).rejects.toThrow(/Out-of-order/);

      clock.set(7_000);
      const firstOutput = await syncA2ATask(db, commitment.id, {
        id: "a2a-task-1",
        contextId: "context-7",
        status: { state: "TASK_STATE_WORKING", timestamp: iso(7_000) },
        artifacts: [{ artifactId: "report", name: "Report", parts: [{ text: "draft" }] }],
      }, ctx(clock));
      expect(firstOutput.artifacts).toHaveLength(1);

      clock.set(8_000);
      const completed = await syncA2ATask(db, commitment.id, {
        id: "a2a-task-1",
        contextId: "context-7",
        status: { state: "TASK_STATE_COMPLETED", timestamp: iso(8_000) },
        artifacts: [{ artifactId: "report", name: "Report", parts: [{ text: "final" }] }],
      }, ctx(clock));
      expect(completed.attempt.status).toBe("succeeded");
      expect(completed.artifacts[0]?.id).not.toBe(firstOutput.artifacts[0]?.id);
      expect(await listArtifacts(db, { attemptId: completed.attempt.id })).toHaveLength(2);
      expect((await getCommitment(db, commitment.id, "gwendall"))?.status).toBe("open");

      const before = await client.execute("SELECT total_changes() AS changes");
      await expect(syncA2ATask(db, commitment.id, {
        id: "a2a-task-1",
        contextId: "context-7",
        status: { state: "TASK_STATE_REJECTED", timestamp: iso(9_000) },
      }, ctx(clock))).rejects.toThrow(/contradicts terminal/);
      const after = await client.execute("SELECT total_changes() AS changes");
      expect(after.rows[0]?.changes).toBe(before.rows[0]?.changes);
    } finally {
      await close();
    }
  });

  it("requires a digest-matching external URI for large artifacts", async () => {
    const { db, close, commitment } = await fixture();
    const clock = createMutableClock(5_000);
    const largeArtifact = {
      artifactId: "large",
      parts: [{ text: "x".repeat(INLINE_PROTOCOL_ARTIFACT_MAX_BYTES + 1) }],
    };
    try {
      await expect(syncA2ATask(db, commitment.id, {
        id: "a2a-large",
        status: { state: "TASK_STATE_COMPLETED", timestamp: iso(5_000) },
        artifacts: [largeArtifact],
      }, ctx(clock))).rejects.toThrow(/requires externalized content/);
      expect(await listTaskAttempts(db, commitment.id)).toHaveLength(0);

      await expect(syncA2ATask(db, commitment.id, {
        id: "a2a-large",
        status: { state: "TASK_STATE_COMPLETED", timestamp: iso(5_000) },
        artifacts: [largeArtifact],
      }, {
        ...ctx(clock),
        artifactContent: {
          large: {
            uri: "https://objects.example.test/large.json",
            digest: "sha256:wrong",
          },
        },
      })).rejects.toThrow(/digest mismatch/);
      expect(await listTaskAttempts(db, commitment.id)).toHaveLength(0);

      const accepted = await syncA2ATask(db, commitment.id, {
        id: "a2a-large",
        status: { state: "TASK_STATE_COMPLETED", timestamp: iso(5_000) },
        artifacts: [largeArtifact],
      }, {
        ...ctx(clock),
        artifactContent: {
          large: {
            uri: "https://objects.example.test/large.json",
            digest: a2aArtifactContentDigest({
              ...largeArtifact,
              ignoredByPinnedVersion: "forward-compatible field",
            }),
          },
        },
      });
      expect(accepted.artifacts[0]).toMatchObject({
        uri: "https://objects.example.test/large.json",
        digest: a2aArtifactContentDigest(largeArtifact),
      });
    } finally {
      await close();
    }
  });
});

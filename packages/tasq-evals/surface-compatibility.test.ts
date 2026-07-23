/** TQ-307: one commitment, one ledger, three public integration surfaces. */

import { afterEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createTasqMcpServer } from "@tasq-run/mcp";
import { syncA2ATask } from "@tasq-run/protocol-adapters";
import { createMutableClock } from "@tasq-run/schema";
import { openDb, runKernelMigrations } from "@tasq-run/core";

const WORKSPACE = "tq-307-surface-compatibility";
const CLI_ENTRY = fileURLToPath(new URL("../tasq-cli/src/index.ts", import.meta.url));
const tmpDirs: string[] = [];

// Full-suite runs execute many subprocess-heavy evals concurrently. The bound
// protects correctness from host contention while remaining finite.
setDefaultTimeout(30_000);

afterEach(() => {
  while (tmpDirs.length > 0) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function runCli(home: string, dbUrl: string, args: string[]): Promise<CliResult> {
  const child = Bun.spawn([process.execPath, "run", CLI_ENTRY, ...args], {
    env: {
      ...process.env,
      HOME: home,
      TASQ_DB_URL: dbUrl,
      TASQ_TENANT: WORKSPACE,
      TASQ_EVENT_JOURNAL_PATH: "",
      TASQ_PROJECTION_TARGET: "",
      NO_COLOR: "1",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, exitCode };
}

async function runCliJson<T>(home: string, dbUrl: string, args: string[]): Promise<T> {
  const result = await runCli(home, dbUrl, [...args, "--json"]);
  if (result.exitCode !== 0) {
    throw new Error(
      `tasq ${args.join(" ")} failed (${result.exitCode})\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
    );
  }
  return JSON.parse(result.stdout) as T;
}

describe("TQ-307 public-surface compatibility", () => {
  it("coordinates one commitment through CLI, MCP and A2A without split truth", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tasq-surface-compat-"));
    tmpDirs.push(dir);
    const home = join(dir, "home");
    const dbUrl = `file:${join(dir, "tasq.sqlite")}`;

    // Surface 1: an otherwise unprivileged CLI client creates the durable intent.
    const created = await runCliJson<{
      id: string;
      tenantId: string;
      status: string;
      completionMode: string;
      createdAt: number;
    }>(home, dbUrl, [
      "add",
      "Deliver a verified robot calibration",
      "--success", "A coordinator verifies the remote calibration artifact",
      "--completion", "evidence",
      "--idempotency-key", "tq307-create-v1",
      "--actor", "runtime:cli",
    ]);
    expect(created).toMatchObject({
      tenantId: WORKSPACE,
      status: "open",
      completionMode: "evidence",
    });

    const opened = await openDb({ url: dbUrl, wal: false });
    // The scenario clock is derived from ledger state, not from ambient device time.
    const clock = createMutableClock(created.createdAt + 1_000);
    const server = createTasqMcpServer({
      db: opened.db,
      workspaceId: WORKSPACE,
      actor: "runtime:coordinator",
      capabilities: ["read", "coordinate"],
      clock,
    });
    const mcp = new Client({ name: "tq-307-compatible-runtime", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await runKernelMigrations(opened.client, { clock });
      await server.connect(serverTransport);
      await mcp.connect(clientTransport);

      // Surface 2: a cold MCP client discovers only its granted surface, then
      // starts and claims the commitment created by the CLI.
      const toolNames = (await mcp.listTools()).tools.map((tool) => tool.name);
      expect(toolNames).toContain("tasq_discover");
      expect(toolNames).toContain("tasq_claim_acquire");
      expect(toolNames).not.toContain("tasq_effect_begin");

      const discovery = (await mcp.callTool({
        name: "tasq_discover",
        arguments: {},
      })).structuredContent as { workspaceId: string; generatedAt: number };
      expect(discovery).toMatchObject({ workspaceId: WORKSPACE, generatedAt: clock.now() });

      const read = (await mcp.callTool({
        name: "tasq_commitment_get",
        arguments: { commitmentId: created.id },
      })).structuredContent as { commitment: { id: string; status: string; revision: number } };
      expect(read.commitment).toMatchObject({ id: created.id, status: "open" });

      clock.advance(1_000);
      const started = (await mcp.callTool({
        name: "tasq_commitment_transition",
        arguments: {
          commitmentId: created.id,
          transition: "start",
          expectedRevision: read.commitment.revision,
          idempotencyKey: "tq307-start-v1",
        },
      })).structuredContent as { status: string; revision: number };
      expect(started.status).toBe("in_progress");

      clock.advance(1_000);
      const claim = (await mcp.callTool({
        name: "tasq_claim_acquire",
        arguments: {
          commitmentId: created.id,
          leaseMs: 60_000,
          idempotencyKey: "tq307-claim-v1",
        },
      })).structuredContent as { id: string; actor: string; fence: number; revision: number };
      expect(claim).toMatchObject({ actor: "runtime:coordinator", fence: 1 });

      // Surface 3: an A2A runtime reports execution. Its completed task is
      // imported as a succeeded attempt plus immutable artifact, never as the
      // commitment's completion decision.
      clock.advance(1_000);
      const remoteSnapshot = {
        id: "remote-calibration-run-1",
        contextId: "robot-cell-7",
        status: { state: "TASK_STATE_COMPLETED" as const },
        artifacts: [{
          artifactId: "calibration-report",
          name: "Calibration report",
          parts: [{
            data: { robot: "cell-7", maxErrorMm: 0.21, samples: 24 },
            mediaType: "application/json",
          }],
        }],
      };
      const remote = await syncA2ATask(opened.db, created.id, remoteSnapshot, {
        remoteSystem: "https://robot-runtime.example.test",
        actor: "runtime:coordinator",
        tenantId: WORKSPACE,
        claimId: claim.id,
        clock,
      });
      const replay = await syncA2ATask(opened.db, created.id, remoteSnapshot, {
        remoteSystem: "https://robot-runtime.example.test",
        actor: "runtime:coordinator",
        tenantId: WORKSPACE,
        claimId: claim.id,
        clock,
      });
      expect(remote.attempt).toMatchObject({ status: "succeeded", claimId: claim.id });
      expect(replay.attempt.id).toBe(remote.attempt.id);
      expect(replay.artifacts[0]?.id).toBe(remote.artifacts[0]?.id);

      const beforeDecision = (await mcp.callTool({
        name: "tasq_commitment_inspect",
        arguments: { commitmentId: created.id },
      })).structuredContent as {
        inspection: {
          commitment: { status: string; completedAt: number | null };
          attempts: Array<{ id: string; status: string }>;
          artifacts: Array<{ id: string; digest: string; uri: string }>;
          evidence: unknown[];
          completionRecords: unknown[];
        };
      };
      expect(beforeDecision.inspection.commitment).toMatchObject({
        status: "in_progress",
        completedAt: null,
      });
      expect(beforeDecision.inspection.attempts).toHaveLength(1);
      expect(beforeDecision.inspection.artifacts).toHaveLength(1);
      expect(beforeDecision.inspection.evidence).toHaveLength(0);
      expect(beforeDecision.inspection.completionRecords).toHaveLength(0);

      clock.advance(1_000);
      const artifact = beforeDecision.inspection.artifacts[0]!;
      const evidence = (await mcp.callTool({
        name: "tasq_evidence_add",
        arguments: {
          commitmentId: created.id,
          attemptId: remote.attempt.id,
          kind: "coordinator_verification",
          summary: "Coordinator verified the calibration report against the acceptance threshold",
          uri: artifact.uri,
          digest: artifact.digest,
          source: "urn:tasq:tq-307:coordinator",
          observedAt: clock.now(),
          idempotencyKey: "tq307-evidence-v1",
        },
      })).structuredContent as { id: string; taskId: string; attemptId: string };
      expect(evidence).toMatchObject({ taskId: created.id, attemptId: remote.attempt.id });

      // Back on surface 1, the CLI sees the exact MCP/A2A graph and remains
      // responsible for an explicit evidence-bound completion decision.
      const cliBefore = await runCliJson<{
        commitment: { status: string };
        attempts: Array<{ id: string }>;
        artifacts: Array<{ id: string }>;
        evidence: Array<{ id: string }>;
        completionRecords: unknown[];
      }>(home, dbUrl, ["inspect", created.id, "--actor", "runtime:cli"]);
      expect(cliBefore.commitment.status).toBe("in_progress");
      expect(cliBefore.attempts.map((attempt) => attempt.id)).toEqual([remote.attempt.id]);
      expect(cliBefore.artifacts.map((item) => item.id)).toEqual([artifact.id]);
      expect(cliBefore.evidence.map((item) => item.id)).toEqual([evidence.id]);
      expect(cliBefore.completionRecords).toHaveLength(0);

      clock.advance(1_000);
      const released = (await mcp.callTool({
        name: "tasq_claim_release",
        arguments: {
          commitmentId: created.id,
          expectedRevision: claim.revision,
          reason: "Remote execution and coordinator verification finished",
          idempotencyKey: "tq307-release-v1",
        },
      })).structuredContent as { id: string; releasedAt: number; releaseReason: string };
      expect(released).toMatchObject({
        id: claim.id,
        releasedAt: clock.now(),
        releaseReason: "Remote execution and coordinator verification finished",
      });

      clock.advance(1_000);
      const completed = await runCliJson<{ id: string; status: string; completedAt: number }>(
        home,
        dbUrl,
        [
          "done", created.id,
          "--evidence", evidence.id,
          "--at", new Date(clock.now()).toISOString(),
          "--actor", "runtime:cli",
        ],
      );
      expect(completed).toMatchObject({ id: created.id, status: "done", completedAt: clock.now() });

      const final = (await mcp.callTool({
        name: "tasq_commitment_inspect",
        arguments: { commitmentId: created.id },
      })).structuredContent as {
        inspection: {
          commitment: { status: string };
          attempts: unknown[];
          artifacts: unknown[];
          evidence: unknown[];
          completionRecords: Array<{ evidenceIds: string[] }>;
        };
      };
      expect(final.inspection.commitment.status).toBe("done");
      expect(final.inspection.attempts).toHaveLength(1);
      expect(final.inspection.artifacts).toHaveLength(1);
      expect(final.inspection.evidence).toHaveLength(1);
      expect(final.inspection.completionRecords).toHaveLength(1);
      expect(final.inspection.completionRecords[0]?.evidenceIds).toEqual([evidence.id]);
    } finally {
      await mcp.close();
      await server.close();
      await opened.close();
    }
  });
});

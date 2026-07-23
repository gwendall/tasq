/** TQ-304: executable Temporal, Restate and LangGraph reconciliation recipes. */

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createTasqMcpServer } from "@tasq-run/mcp";
import { createMutableClock } from "@tasq-run/schema";
import { openDb, runKernelMigrations } from "@tasq-run/core";

const WORKSPACE = "tq-304-runtime-recipes";
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

type AttemptStatus = "running" | "input_required" | "succeeded" | "failed" | "cancelled";

interface RuntimeRecipe {
  name: string;
  runtime: string;
  externalId: string;
  contextId: string;
  metadata: Record<string, unknown>;
  reconciledStatuses: AttemptStatus[];
}

const RECIPES: RuntimeRecipe[] = [
  {
    name: "Temporal",
    runtime: "temporal:workflow-chain",
    // The first execution Run ID is stable across Retry and Continue-As-New;
    // the mutable current Run ID is deliberately not Tasq attempt identity.
    externalId: "first-run-018f6f8d",
    contextId: "calibrate-robot-cell-7",
    metadata: { namespace: "production", workflowType: "CalibrateRobot" },
    reconciledStatuses: ["succeeded"],
  },
  {
    name: "Restate",
    runtime: "restate:workflow-invocation",
    externalId: "inv_1Q4Y8VX7J2",
    contextId: "calibrate-robot-cell-8",
    metadata: { service: "CalibrationWorkflow", handler: "run" },
    reconciledStatuses: ["input_required", "running", "succeeded"],
  },
  {
    name: "LangGraph",
    runtime: "langgraph:thread-run",
    // A thread can host multiple runs. The run ID is the attempt identity and
    // thread_id is only the resumable context pointer.
    externalId: "run-2026-07-19-001",
    contextId: "thread-robot-cell-9",
    metadata: { graph: "calibration-agent", checkpointNamespace: "" },
    reconciledStatuses: ["input_required", "running", "succeeded"],
  },
];

async function connect() {
  const dir = mkdtempSync(join(tmpdir(), "tasq-runtime-recipes-"));
  const opened = await openDb({ url: `file:${join(dir, "tasq.sqlite")}`, wal: false });
  const clock = createMutableClock(1_900_000_000_000);
  await runKernelMigrations(opened.client, { clock });
  const server = createTasqMcpServer({
    db: opened.db,
    workspaceId: WORKSPACE,
    actor: "runtime:reconciler",
    capabilities: ["read", "propose", "coordinate"],
    clock,
  });
  const client = new Client({ name: "runtime-recipe-eval", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  cleanups.push(async () => {
    await client.close();
    await server.close();
    await opened.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { client, clock };
}

async function call<T>(client: Client, name: string, args: Record<string, unknown>): Promise<T> {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) {
    throw new Error(`${name} failed: ${JSON.stringify(result.content)}`);
  }
  return result.structuredContent as T;
}

describe("TQ-304 durable-runtime reconciliation recipes", () => {
  it("maps three unrelated runtime lifecycles into attempts without importing their engines", async () => {
    const { client, clock } = await connect();

    for (const recipe of RECIPES) {
      clock.advance(1_000);
      const commitment = await call<{ id: string; revision: number }>(client, "tasq_commitment_create", {
        title: `${recipe.name}: deliver verified calibration`,
        successCriteria: "A coordinator verifies the runtime output",
        completionPolicy: "evidence",
        idempotencyKey: `tq304:${recipe.name}:commitment`,
      });
      const started = await call<{ revision: number }>(client, "tasq_commitment_transition", {
        commitmentId: commitment.id,
        transition: "start",
        expectedRevision: commitment.revision,
        idempotencyKey: `tq304:${recipe.name}:start`,
      });
      expect(started.revision).toBeGreaterThan(commitment.revision);

      clock.advance(1_000);
      const claim = await call<{ id: string; revision: number; fence: number }>(client, "tasq_claim_acquire", {
        commitmentId: commitment.id,
        leaseMs: 60_000,
        idempotencyKey: `tq304:${recipe.name}:claim`,
      });
      expect(claim.fence).toBe(1);

      clock.advance(1_000);
      const attemptInput = {
        commitmentId: commitment.id,
        claimId: claim.id,
        runtime: recipe.runtime,
        externalId: recipe.externalId,
        contextId: recipe.contextId,
        metadata: recipe.metadata,
        idempotencyKey: `tq304:${recipe.name}:attempt`,
      };
      let attempt = await call<{ id: string; revision: number; status: AttemptStatus }>(
        client,
        "tasq_attempt_start",
        attemptInput,
      );
      const replay = await call<{ id: string; revision: number }>(client, "tasq_attempt_start", attemptInput);
      expect(replay.id).toBe(attempt.id);
      expect(replay.revision).toBe(attempt.revision);

      for (const status of recipe.reconciledStatuses) {
        clock.advance(1_000);
        attempt = await call<{ id: string; revision: number; status: AttemptStatus }>(
          client,
          "tasq_attempt_transition",
          {
            attemptId: attempt.id,
            status,
            expectedRevision: attempt.revision,
            message: `${recipe.name} authoritative state mapped to ${status}`,
            idempotencyKey: `tq304:${recipe.name}:attempt:${status}`,
          },
        );
        expect(attempt.status).toBe(status);
      }

      const inspection = await call<{
        inspection: {
          commitment: { status: string; completedAt: number | null };
          claims: Array<{ id: string }>;
          attempts: Array<{
            id: string;
            runtime: string;
            externalId: string;
            contextId: string;
            status: string;
          }>;
          evidence: unknown[];
          completionRecords: unknown[];
        };
      }>(client, "tasq_commitment_inspect", { commitmentId: commitment.id });
      expect(inspection.inspection.commitment).toMatchObject({
        status: "in_progress",
        completedAt: null,
      });
      expect(inspection.inspection.attempts).toEqual([
        expect.objectContaining({
          id: attempt.id,
          runtime: recipe.runtime,
          externalId: recipe.externalId,
          contextId: recipe.contextId,
          status: "succeeded",
        }),
      ]);
      expect(inspection.inspection.evidence).toHaveLength(0);
      expect(inspection.inspection.completionRecords).toHaveLength(0);

      clock.advance(1_000);
      await call(client, "tasq_claim_release", {
        commitmentId: commitment.id,
        expectedRevision: claim.revision,
        reason: `${recipe.name} execution reconciled`,
        idempotencyKey: `tq304:${recipe.name}:release`,
      });
    }
  });
});

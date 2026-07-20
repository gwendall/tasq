import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMutableClock } from "@tasq/schema";
import {
  getCommitment,
  openDb,
  runKernelMigrations,
} from "@tasq/core";
import {
  createTasqMcpServer,
  parseTasqMcpCapabilities,
  type CreateTasqMcpServerOptions,
} from "../src/index.js";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

async function fixture(capabilities: CreateTasqMcpServerOptions["capabilities"]) {
  const dir = mkdtempSync(join(tmpdir(), "tasq-mcp-"));
  const opened = await openDb({ url: `file:${join(dir, "db.sqlite")}`, wal: false });
  const clock = createMutableClock(10_000);
  await runKernelMigrations(opened.client, { clock });
  const server = createTasqMcpServer({
    db: opened.db,
    workspaceId: "robotics-lab",
    actor: "agent:planner",
    principalId: undefined,
    capabilities,
    clock,
  });
  const client = new Client({ name: "tasq-mcp-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  cleanups.push(async () => {
    await client.close();
    await server.close();
    await opened.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { ...opened, clock, client };
}

function structured<T>(response: Awaited<ReturnType<Client["callTool"]>>): T {
  return response.structuredContent as T;
}

describe("Tasq MCP capability boundary", () => {
  it("does not advertise or dispatch mutation tools to a read-only client", async () => {
    const { client } = await fixture(["read"]);
    const tools = await client.listTools();
    const names = tools.tools.map((tool) => tool.name).sort();

    expect(names).toEqual([
      "tasq_commitment_get",
      "tasq_commitment_inspect",
      "tasq_commitment_list",
      "tasq_context",
      "tasq_context_link_get",
      "tasq_context_link_list",
      "tasq_discover",
      "tasq_effect_get",
      "tasq_effect_list",
      "tasq_event_list",
      "tasq_onboard",
      "tasq_resource_event_list",
      "tasq_resource_get",
      "tasq_resource_list",
      "tasq_summary_current",
      "tasq_summary_get",
      "tasq_summary_list",
    ]);
    expect(tools.tools.every((tool) => tool.annotations?.readOnlyHint === true)).toBe(true);
    for (const name of [
      "tasq_commitment_list", "tasq_context", "tasq_commitment_inspect",
      "tasq_summary_current", "tasq_summary_get", "tasq_summary_list",
      "tasq_context_link_get", "tasq_context_link_list",
    ]) {
      const description = tools.tools.find((tool) => tool.name === name)?.description ?? "";
      expect(description, `${name} must label actor text as data rather than authority`)
        .toMatch(/data|grant.*authority|grants no authority/i);
    }
    const context = structured<any>(await client.callTool({
      name: "tasq_context",
      arguments: { maxRecords: 3, maxTokens: 2_048 },
    }));
    expect(context).toMatchObject({
      contractVersion: "tasq.context-packet.v1",
      budget: { maxRecords: 3, maxTokens: 2_048, hardLimitSatisfied: true },
    });
    const hidden = await client.callTool({
      name: "tasq_commitment_create",
      arguments: { title: "Hidden mutation", idempotencyKey: "hidden-1" },
    });
    expect(hidden.isError).toBe(true);
    expect(hidden.content[0]).toMatchObject({ type: "text", text: expect.stringMatching(/not found/i) });
    const hiddenEffect = await client.callTool({
      name: "tasq_effect_begin",
      arguments: { effectId: "hidden", expectedRevision: 1, claimId: "hidden", fence: 1 },
    });
    expect(hiddenEffect.isError).toBe(true);
    expect(hiddenEffect.content[0]).toMatchObject({ type: "text", text: expect.stringMatching(/not found/i) });
  });

  it("requires a trusted host resolver before effect-capable tools can exist", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tasq-mcp-effect-"));
    const opened = await openDb({ url: `file:${join(dir, "db.sqlite")}`, wal: false });
    const clock = createMutableClock(10_000);
    await runKernelMigrations(opened.client, { clock });
    try {
      expect(() => createTasqMcpServer({
        db: opened.db,
        workspaceId: "robotics-lab",
        actor: "agent:planner",
        capabilities: ["effect"],
        clock,
      })).toThrow(/trusted dispatch-authority resolver/);
    } finally {
      await opened.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects unknown capability labels instead of silently widening authority", () => {
    expect(parseTasqMcpCapabilities("read,coordinate")).toEqual(["read", "coordinate"]);
    expect(parseTasqMcpCapabilities("read,read")).toEqual(["read"]);
    expect(() => parseTasqMcpCapabilities("read,admin")).toThrow(/Unknown Tasq MCP capabilities: admin/);
    expect(() => parseTasqMcpCapabilities("propose")).toThrow(/require read/);
    expect(() => parseTasqMcpCapabilities("coordinate")).toThrow(/require read/);
    expect(() => parseTasqMcpCapabilities("effect")).toThrow(/require read/);
  });

  it("advertises retriable writes only with a required idempotency key", async () => {
    const { client } = await fixture(["read", "propose", "coordinate"]);
    const tools = await client.listTools();
    const retriable = [
      "tasq_commitment_create",
      "tasq_commitment_update",
      "tasq_commitment_transition",
      "tasq_claim_acquire",
      "tasq_claim_release",
      "tasq_attempt_start",
      "tasq_attempt_transition",
      "tasq_evidence_add",
      "tasq_effect_propose",
      "tasq_resource_acquire",
      "tasq_resource_renew",
      "tasq_resource_release",
      "tasq_summary_append",
      "tasq_context_link_attach",
      "tasq_context_link_detach",
    ];
    for (const name of retriable) {
      const tool = tools.tools.find((candidate) => candidate.name === name);
      expect(tool?.annotations?.idempotentHint).toBe(true);
      expect((tool?.inputSchema as { required?: string[] } | undefined)?.required)
        .toContain("idempotencyKey");
    }
  });
});

describe("Tasq MCP agent flow", () => {
  it("shares a pinned external context identity without importing memory content", async () => {
    const { client, clock } = await fixture(["read", "propose", "coordinate"]);
    const created = structured<{ id: string }>(await client.callTool({
      name: "tasq_commitment_create",
      arguments: { title: "Calibrate arm", idempotencyKey: "context-create" },
    }));
    clock.set(11_000);
    const link = structured<{ id: string; binding: string; state: string }>(await client.callTool({
      name: "tasq_context_link_attach",
      arguments: {
        commitmentId: created.id,
        system: "https://memory.example.test",
        resourceType: "runbook",
        externalId: "robotics/calibration",
        version: "v7",
        idempotencyKey: "context-attach",
      },
    }));
    expect(link).toMatchObject({ binding: "pinned", state: "active" });
    const current = structured<{ items: Array<{ id: string }>; selection: unknown }>(
      await client.callTool({
        name: "tasq_context_link_list", arguments: { commitmentId: created.id },
      }),
    );
    expect(current.items.map((item) => item.id)).toEqual([link.id]);
    expect(current.selection).toBeDefined();
    const inspection = structured<{ inspection: { externalContextLinks: Array<{ id: string }> } }>(
      await client.callTool({
        name: "tasq_commitment_inspect", arguments: { commitmentId: created.id },
      }),
    );
    expect(inspection.inspection.externalContextLinks.map((item) => item.id)).toEqual([link.id]);

    clock.set(12_000);
    const detached = structured<{ state: string }>(await client.callTool({
      name: "tasq_context_link_detach",
      arguments: { currentLinkId: link.id, idempotencyKey: "context-detach" },
    }));
    expect(detached.state).toBe("detached");
    const after = structured<{ items: unknown[] }>(await client.callTool({
      name: "tasq_context_link_list", arguments: { commitmentId: created.id },
    }));
    expect(after.items).toEqual([]);
  });

  it("compacts terminal work through coordinate capability while read-only clients can inspect it", async () => {
    const { client, clock } = await fixture(["read", "propose", "coordinate"]);
    const created = structured<{ id: string; revision: number }>(await client.callTool({
      name: "tasq_commitment_create",
      arguments: { title: "Archived calibration", idempotencyKey: "summary-create" },
    }));
    clock.set(11_000);
    const terminal = structured<{ revision: number }>(await client.callTool({
      name: "tasq_commitment_transition",
      arguments: {
        commitmentId: created.id, transition: "cancel", expectedRevision: created.revision,
        reason: "Superseded experiment", idempotencyKey: "summary-cancel",
      },
    }));
    clock.set(12_000);
    const summary = structured<{ id: string; state: string; source: { commitmentRevision: number } }>(
      await client.callTool({
        name: "tasq_summary_append",
        arguments: {
          commitmentId: created.id,
          summary: "Experiment was superseded before execution.",
          expectedPreviousSummaryId: null,
          idempotencyKey: "summary-append",
        },
      }),
    );
    expect(summary).toMatchObject({
      state: "current", source: { commitmentRevision: terminal.revision },
    });
    const current = structured<{
      items: Array<{ id: string }>;
      selection: { emptyDoesNotProveNoHistory: boolean; historyRecipeId: string };
    }>(await client.callTool({
      name: "tasq_summary_current", arguments: { limit: 5 },
    }));
    expect(current.items.map((item) => item.id)).toEqual([summary.id]);
    expect(current.selection).toMatchObject({
      emptyDoesNotProveNoHistory: true, historyRecipeId: "summary.list",
    });
    await client.callTool({
      name: "tasq_commitment_transition",
      arguments: {
        commitmentId: created.id, transition: "reopen", expectedRevision: terminal.revision,
        idempotencyKey: "summary-reopen",
      },
    });
    const staleCurrent = structured<{ items: unknown[]; selection: { excludes: string[] } }>(
      await client.callTool({ name: "tasq_summary_current", arguments: { limit: 5 } }),
    );
    expect(staleCurrent.items).toEqual([]);
    expect(staleCurrent.selection.excludes).toEqual(["stale", "superseded"]);
    const history = structured<{ items: Array<{ id: string; state: string }> }>(
      await client.callTool({
        name: "tasq_summary_list", arguments: { commitmentId: created.id, limit: 5 },
      }),
    );
    expect(history.items).toEqual([expect.objectContaining({ id: summary.id, state: "stale" })]);
  });

  it("coordinates a full attempt without treating remote success as commitment completion", async () => {
    const { client, db, clock } = await fixture(["read", "propose", "coordinate"]);

    const createdResponse = await client.callTool({
      name: "tasq_commitment_create",
      arguments: {
        title: "Calibrate the robot arm",
        successCriteria: "Calibration report is attached",
        completionPolicy: "evidence",
        idempotencyKey: "create-calibration-v1",
      },
    });
    const created = structured<{ id: string; workspaceId: string; revision: number; createdAt: number }>(createdResponse);
    expect(created).toMatchObject({ workspaceId: "robotics-lab", revision: 1, createdAt: 10_000 });

    clock.set(11_000);
    const started = structured<{ revision: number; status: string }>(await client.callTool({
      name: "tasq_commitment_transition",
      arguments: {
        commitmentId: created.id,
        transition: "start",
        expectedRevision: 1,
        idempotencyKey: "start-calibration-v1",
      },
    }));
    expect(started).toMatchObject({ revision: 2, status: "in_progress" });

    clock.set(12_000);
    const claim = structured<{ id: string; fence: number; revision: number; acquiredAt: number }>(
      await client.callTool({
        name: "tasq_claim_acquire",
        arguments: { commitmentId: created.id, idempotencyKey: "claim-calibration-v1" },
      }),
    );
    expect(claim).toMatchObject({ fence: 1, revision: 1, acquiredAt: 12_000 });

    clock.set(13_000);
    const attemptResponse = await client.callTool({
        name: "tasq_attempt_start",
        arguments: {
          commitmentId: created.id,
          claimId: claim.id,
          runtime: "robot-controller",
          idempotencyKey: "attempt-calibration-v1",
        },
      });
    const attempt = structured<{ id: string; revision: number; status: string; startedAt: number }>(attemptResponse);
    expect(attempt).toMatchObject({ revision: 1, status: "running", startedAt: 13_000 });

    clock.set(14_000);
    const succeeded = structured<{ revision: number; status: string; endedAt: number }>(
      await client.callTool({
        name: "tasq_attempt_transition",
        arguments: {
          attemptId: attempt.id,
          status: "succeeded",
          expectedRevision: 1,
          idempotencyKey: "finish-calibration-attempt-v1",
        },
      }),
    );
    expect(succeeded).toMatchObject({ revision: 2, status: "succeeded", endedAt: 14_000 });

    const commitment = await getCommitment(db, created.id, "robotics-lab");
    expect(commitment).toMatchObject({ status: "in_progress", revision: 2, completedAt: null });
  });

  it("injects workspace identity and prevents client-side authority confusion", async () => {
    const { client } = await fixture(["read", "propose"]);
    const response = await client.callTool({
      name: "tasq_commitment_create",
      arguments: {
        title: "Bound to the host workspace",
        workspaceId: "attacker-workspace",
        actor: "attacker",
        idempotencyKey: "identity-bound-v1",
      },
    });
    const created = structured<{ workspaceId: string }>(response);
    expect(created.workspaceId).toBe("robotics-lab");

    const listed = structured<{ items: unknown[] }>(await client.callTool({
      name: "tasq_commitment_list",
      arguments: {},
    }));
    expect(listed.items).toHaveLength(1);
  });
});

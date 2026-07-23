import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMutableClock } from "@tasq-run/schema";
import { createTasqMcpServer } from "@tasq-run/mcp";
import { openDb, runKernelMigrations } from "@tasq-run/core";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

async function connect(capabilities: Array<"read" | "propose" | "coordinate">) {
  const dir = mkdtempSync(join(tmpdir(), "tasq-mcp-eval-"));
  const opened = await openDb({ url: `file:${join(dir, "db.sqlite")}`, wal: false });
  const clock = createMutableClock(50_000);
  await runKernelMigrations(opened.client, { clock });
  const server = createTasqMcpServer({
    db: opened.db,
    workspaceId: "unknown-runtime-eval",
    actor: "runtime:cold-start",
    capabilities,
    clock,
  });
  const client = new Client({ name: "unknown-runtime", version: "0.0.0" });
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

describe("MCP cold-start capability eval", () => {
  it("lets an unknown runtime discover and coordinate without repository knowledge", async () => {
    const { client, clock } = await connect(["read", "propose", "coordinate"]);
    const advertised = await client.listTools();
    const tools = new Map(advertised.tools.map((tool) => [tool.name, tool]));

    expect(tools.get("tasq_discover")?.annotations?.readOnlyHint).toBe(true);
    expect(tools.get("tasq_effect_begin")).toBeUndefined();
    expect(tools.get("tasq_attempt_start")?.description).toContain("Attempt success never completes");

    const discovery = await client.callTool({ name: "tasq_discover", arguments: {} });
    expect(discovery.structuredContent).toMatchObject({
      contractVersion: "tasq.discovery.v1",
      workspaceId: "unknown-runtime-eval",
      transportBoundary: "local_process",
      generatedAt: 50_000,
    });

    const created = (await client.callTool({
      name: "tasq_commitment_create",
      arguments: { title: "Inspect unknown sample", idempotencyKey: "unknown-create-v1" },
    })).structuredContent as { id: string; revision: number };

    clock.set(51_000);
    const started = (await client.callTool({
      name: "tasq_commitment_transition",
      arguments: {
        commitmentId: created.id,
        transition: "start",
        expectedRevision: created.revision,
        idempotencyKey: "unknown-start-v1",
      },
    })).structuredContent as { revision: number };

    clock.set(52_000);
    const attempt = (await client.callTool({
      name: "tasq_attempt_start",
      arguments: { commitmentId: created.id, runtime: "unknown", idempotencyKey: "unknown-attempt-v1" },
    })).structuredContent as { id: string; revision: number };

    clock.set(53_000);
    await client.callTool({
      name: "tasq_attempt_transition",
      arguments: {
        attemptId: attempt.id,
        status: "succeeded",
        expectedRevision: attempt.revision,
        idempotencyKey: "unknown-attempt-succeeded-v1",
      },
    });

    const current = (await client.callTool({
      name: "tasq_commitment_get",
      arguments: { commitmentId: created.id },
    })).structuredContent as { commitment: { status: string; revision: number; completedAt: number | null } };
    expect(current.commitment).toEqual(expect.objectContaining({
      status: "in_progress",
      revision: started.revision,
      completedAt: null,
    }));
  });

  it("publishes a genuinely smaller surface to a read-only runtime", async () => {
    const { client } = await connect(["read"]);
    const tools = (await client.listTools()).tools;
    expect(tools).not.toHaveLength(0);
    expect(tools.every((tool) => tool.annotations?.readOnlyHint === true)).toBe(true);
    expect(tools.some((tool) => tool.name.includes("create") || tool.name.includes("transition"))).toBe(false);
  });
});

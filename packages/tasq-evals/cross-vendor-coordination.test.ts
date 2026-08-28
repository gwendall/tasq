/**
 * Two vendors' agents, one ledger.
 *
 * This is the case no harness will ever serve, and until this file existed it
 * had never been demonstrated. `grep codex` across every test in the
 * repository returned config-file writing and nothing else.
 *
 * The argument, stated so a reader can disagree with it: the single-vendor
 * collision - three sessions of one tool on one repository - is the case that
 * tool can and probably will solve inside its own harness, and vendors are
 * actively doing so. The case that survives is the cross-vendor one, because
 * no model vendor will build the coordination layer that makes a competitor a
 * first-class peer. That is structural, not an oversight.
 *
 * So the cross-vendor claim is the part of the product worth defending, and it
 * had zero evidence behind it. These tests are that evidence, and they keep it
 * true rather than proving it once.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createTasqMcpServer } from "@tasq-run/mcp";
import { createMutableClock } from "@tasq-run/schema";
import { listContention, openDb, runKernelMigrations } from "@tasq-run/core";

const WORKSPACE = "cross-vendor/one-repo";
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { while (cleanups.length > 0) await cleanups.pop()!(); });

/** One store, and as many differently-identified clients as a test needs. */
async function sharedLedger() {
  const dir = mkdtempSync(join(tmpdir(), "tasq-cross-vendor-"));
  const clock = createMutableClock(1_700_000_000_000);
  const opened = await openDb({ url: `file:${join(dir, "db.sqlite")}`, wal: false });
  await runKernelMigrations(opened.client, { clock });
  cleanups.push(async () => {
    await opened.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { opened, clock, dir };
}

/**
 * An agent as a HOST identifies it, not as it describes itself.
 *
 * `clientInfo` is set by the client library during the MCP handshake, so
 * "which tool is this" is host-attested rather than a string the model chose.
 * That is the whole reason two vendors are distinguishable here at all.
 */
async function vendorAgent(
  ledger: Awaited<ReturnType<typeof sharedLedger>>,
  vendor: string,
  actor: string,
) {
  const server = createTasqMcpServer({
    db: ledger.opened.db,
    workspaceId: WORKSPACE,
    actor,
    capabilities: ["read", "propose", "coordinate"],
    clock: ledger.clock,
  });
  const client = new Client({ name: vendor, version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  cleanups.push(async () => { await client.close(); await server.close(); });
  return client;
}

function structured<T = Record<string, unknown>>(
  response: Awaited<ReturnType<Client["callTool"]>>,
): T {
  return response.structuredContent as T;
}

function text(response: Awaited<ReturnType<Client["callTool"]>>): string {
  const blocks = response.content as Array<{ type: string; text?: string }> | undefined;
  expect(blocks?.length, "tool response carried no content").toBeGreaterThan(0);
  return blocks![0]!.text ?? "";
}

describe("two vendors, one ledger", () => {
  test("the second vendor's agent is refused by name on a live claim", async () => {
    const ledger = await sharedLedger();
    const codex = await vendorAgent(ledger, "codex", "codex:implementer");
    const claude = await vendorAgent(ledger, "claude-code", "claude:reviewer");

    // The shape practitioners already run: one tool implements, another
    // reviews, both against one backlog, neither aware of the other.
    const work = structured<{ id: string }>(await codex.callTool({
      name: "tasq_commitment_create",
      arguments: { title: "Rework the export path", idempotencyKey: "create:1" },
    }));
    const held = structured<{ expiresAt: number }>(await codex.callTool({
      name: "tasq_claim_acquire",
      arguments: { commitmentId: work.id, leaseMs: 1_800_000, idempotencyKey: "hold" },
    }));
    expect(held.expiresAt).toBeGreaterThan(ledger.clock.now());

    const refused = await claude.callTool({
      name: "tasq_claim_acquire",
      arguments: { commitmentId: work.id, leaseMs: 1_800_000, idempotencyKey: "take" },
    });
    expect(refused.isError, "the second vendor was NOT refused").toBe(true);
    // Named, not merely denied: an agent that is told "no" cannot act, and an
    // agent told who holds it can wait, ask, or take other work.
    expect(text(refused)).toContain("codex:implementer");
  });

  test("the refusal is recorded as a cross-vendor standoff, with both names", async () => {
    const ledger = await sharedLedger();
    const codex = await vendorAgent(ledger, "codex", "codex:implementer");
    const claude = await vendorAgent(ledger, "claude-code", "claude:reviewer");

    const work = structured<{ id: string }>(await codex.callTool({
      name: "tasq_commitment_create",
      arguments: { title: "Rework the export path", idempotencyKey: "create:1" },
    }));
    await codex.callTool({
      name: "tasq_claim_acquire",
      arguments: { commitmentId: work.id, leaseMs: 1_800_000, idempotencyKey: "hold" },
    });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      // A distinct key per attempt: a repeated key would be answered by
      // idempotency and never reach the claim path this test is about.
      await claude.callTool({
        name: "tasq_claim_acquire",
        arguments: { commitmentId: work.id, leaseMs: 1_800_000, idempotencyKey: `take:${attempt}` },
      });
    }

    // This is the number the whole product rests on, and it is the number that
    // could not be produced at all until store format 35.
    const [standoff] = await listContention(ledger.opened.db, WORKSPACE);
    expect(standoff).toMatchObject({
      kind: "claim_held_by_another",
      requestedByLabel: "claude:reviewer",
      holderLabel: "codex:implementer",
      attempts: 3,
    });
  });

  test("the ledger records which VENDOR held the claim, not just what it called itself", async () => {
    // `tasq agent install codex|claude|generic` emits a byte-identical
    // invocation for all three, so before clientInfo was captured the ledger
    // could not tell two vendors apart at all - which would make every claim
    // above a story about two labels rather than about two tools.
    //
    // It is recorded on the CLAIM rather than on the commitment, which is the
    // right place: the question is not who typed an idea, it is who is holding
    // the work right now.
    const ledger = await sharedLedger();
    const codex = await vendorAgent(ledger, "codex", "codex:implementer");
    const claude = await vendorAgent(ledger, "claude-code", "claude:reviewer");

    const first = structured<{ id: string }>(await codex.callTool({
      name: "tasq_commitment_create",
      arguments: { title: "From codex", idempotencyKey: "create:codex" },
    }));
    const second = structured<{ id: string }>(await claude.callTool({
      name: "tasq_commitment_create",
      arguments: { title: "From claude", idempotencyKey: "create:claude" },
    }));
    await codex.callTool({
      name: "tasq_claim_acquire",
      arguments: { commitmentId: first.id, leaseMs: 60_000, idempotencyKey: "hold:codex" },
    });
    await claude.callTool({
      name: "tasq_claim_acquire",
      arguments: { commitmentId: second.id, leaseMs: 60_000, idempotencyKey: "hold:claude" },
    });

    const claims = await ledger.opened.client.execute({
      sql: `SELECT task_id, json_extract(metadata, '$."tasq.client".name') AS vendor
            FROM task_claim WHERE task_id IN (?, ?)`,
      args: [first.id, second.id],
    });
    const byTask = new Map(claims.rows.map((row) => [String(row["task_id"]), String(row["vendor"] ?? "")]));
    expect(byTask.get(first.id)).toBe("codex");
    expect(byTask.get(second.id)).toBe("claude-code");
  });

  test("a lapsed lease returns the work to whichever vendor asks next", async () => {
    // The property that makes a shared ledger survivable across tools: nobody
    // has to notice that the other one died. A holder that stops is not a
    // deadlock, it is an expiry.
    const ledger = await sharedLedger();
    const codex = await vendorAgent(ledger, "codex", "codex:implementer");
    const claude = await vendorAgent(ledger, "claude-code", "claude:reviewer");

    const work = structured<{ id: string }>(await codex.callTool({
      name: "tasq_commitment_create", arguments: { title: "Abandoned mid-flight", idempotencyKey: "create:abandoned" },
    }));
    await codex.callTool({
      name: "tasq_claim_acquire",
      arguments: { commitmentId: work.id, leaseMs: 60_000, idempotencyKey: "hold" },
    });
    expect((await claude.callTool({
      name: "tasq_claim_acquire",
      arguments: { commitmentId: work.id, leaseMs: 60_000, idempotencyKey: "early" },
    })).isError).toBe(true);

    ledger.clock.advance(60_001);
    const taken = await claude.callTool({
      name: "tasq_claim_acquire",
      arguments: { commitmentId: work.id, leaseMs: 60_000, idempotencyKey: "after-lapse" },
    });
    expect(taken.isError, "the lapsed lease did not release the work").toBeFalsy();
  });
});

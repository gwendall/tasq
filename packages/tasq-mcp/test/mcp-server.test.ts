import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMutableClock } from "@tasq-run/schema";
import {
  createCommitment,
  getActiveTaskClaim,
  getCommitment,
  localPrincipalId,
  openDb,
  runKernelMigrations,
} from "@tasq-run/core";
import {
  createTasqMcpServer,
  parseTasqMcpCapabilities,
  type CreateTasqMcpServerOptions,
} from "../src/index.js";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

async function fixture(
  capabilities: CreateTasqMcpServerOptions["capabilities"],
  defaultCompletionPolicy?: CreateTasqMcpServerOptions["defaultCompletionPolicy"],
) {
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
    defaultCompletionPolicy,
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

function structured<T = Record<string, unknown>>(
  response: Awaited<ReturnType<Client["callTool"]>>,
): T {
  return response.structuredContent as T;
}

/**
 * The first content block of a tool response.
 *
 * `callTool` types `content` as unknown, so every assertion on a refusal
 * message reached through it silently. Narrowing once here also asserts the
 * block EXISTS - a refusal with no content would otherwise read as a pass.
 */
function firstContent(
  response: Awaited<ReturnType<Client["callTool"]>>,
): { type: string; text?: string } {
  const blocks = response.content as Array<{ type: string; text?: string }> | undefined;
  expect(blocks?.length, "tool response carried no content block").toBeGreaterThan(0);
  return blocks![0]!;
}

describe("Tasq MCP capability boundary", () => {
  it("does not advertise or dispatch mutation tools to a read-only client", async () => {
    const { client } = await fixture(["read"]);
    const tools = await client.listTools();
    const names = tools.tools.map((tool) => tool.name).sort();

    expect(names).toEqual([
      "tasq_assumption_list",
      "tasq_assumption_state",
      "tasq_commitment_get",
      "tasq_commitment_inspect",
      "tasq_commitment_list",
      "tasq_commitment_tree",
      "tasq_context",
      "tasq_context_link_get",
      "tasq_context_link_list",
      "tasq_discover",
      "tasq_effect_get",
      "tasq_effect_list",
      "tasq_event_list",
      "tasq_onboard",
      "tasq_relation_list",
      "tasq_resolution_get",
      "tasq_resource_event_list",
      "tasq_resource_get",
      "tasq_resource_list",
      "tasq_signed_statement_binding_list",
      "tasq_signed_statement_get",
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
    expect(structured<{ proof: unknown }>(await client.callTool({
      name: "tasq_signed_statement_get",
      arguments: { statementId: "missing-statement" },
    }))).toEqual({ proof: null });
    expect(structured<{ items: unknown[] }>(await client.callTool({
      name: "tasq_signed_statement_binding_list",
      arguments: { recordId: "missing-record" },
    }))).toEqual({ items: [] });
    const hidden = await client.callTool({
      name: "tasq_commitment_create",
      arguments: { title: "Hidden mutation", idempotencyKey: "hidden-1" },
    });
    expect(hidden.isError).toBe(true);
    expect(firstContent(hidden)).toMatchObject({ type: "text", text: expect.stringMatching(/not found/i) });
    const hiddenEffect = await client.callTool({
      name: "tasq_effect_begin",
      arguments: { effectId: "hidden", expectedRevision: 1, claimId: "hidden", fence: 1 },
    });
    expect(hiddenEffect.isError).toBe(true);
    expect(firstContent(hiddenEffect)).toMatchObject({ type: "text", text: expect.stringMatching(/not found/i) });
  });

  it("records which client holds a lease, from the handshake rather than the model", async () => {
    // The ledger could not tell a Claude Code client from a Codex client: the
    // only identity reaching a row was the actor label typed at install time,
    // and `tasq agent install codex|claude|generic` emits a byte-identical
    // invocation. clientInfo was received and thrown away. See ADR-022.
    const { db, client, clock } = await fixture(["read", "propose", "coordinate"]);
    const commitment = structured<{ id: string }>(await client.callTool({
      name: "tasq_commitment_create",
      arguments: { title: "Work someone holds", idempotencyKey: "who-holds-1" },
    }));
    await client.callTool({
      name: "tasq_claim_acquire",
      arguments: { commitmentId: commitment.id, leaseMs: 60_000, idempotencyKey: "who-holds-claim" },
    });

    const held = await getActiveTaskClaim(db, commitment.id, "robotics-lab", clock);
    const attribution = (held?.metadata as Record<string, any>)["tasq.client"];
    expect(attribution).toBeDefined();
    expect(attribution.name).toBe("tasq-mcp-test");
    expect(attribution.source).toBe("mcp.initialize");
    // It must never read as authentication. A local process cannot prove what
    // it is, and the record has to keep saying so.
    expect(attribution.attestation).toBe("client_library_self_asserted");

    // And where it runs, so a panel can say "this session, in this directory"
    // rather than only "someone".
    const runtime = (held?.metadata as Record<string, any>)["tasq.runtime"];
    expect(runtime.contract).toBe("tasq.runtime-location.v1");
    expect(runtime.pid).toBe(process.pid);
    expect(runtime.cwd).toBe(process.cwd());
    expect(runtime).toHaveProperty("parentCommand");
  });

  it("does not let a caller overwrite who the ledger says is holding", async () => {
    const { db, client, clock } = await fixture(["read", "propose", "coordinate"]);
    const commitment = structured<{ id: string }>(await client.callTool({
      name: "tasq_commitment_create",
      arguments: { title: "Work with forged metadata", idempotencyKey: "forge-1" },
    }));
    await client.callTool({
      name: "tasq_claim_acquire",
      arguments: {
        commitmentId: commitment.id,
        leaseMs: 60_000,
        idempotencyKey: "forge-claim",
        metadata: { "tasq.client": { name: "something-else" }, mine: "kept" },
      },
    });

    const held = await getActiveTaskClaim(db, commitment.id, "robotics-lab", clock);
    const metadata = held?.metadata as Record<string, any>;
    expect(metadata["tasq.client"].name).toBe("tasq-mcp-test");
    expect(metadata.mine).toBe("kept");
  });

  it("lets an agent retract a belief and reach every commitment resting on it", async () => {
    // Capture answers "I found something new". This is its mirror: "something we
    // believed is false". Without it an agent whose discovery invalidates queued
    // work will cancel it, which records that someone chose not to do the work
    // and says nothing about why it stopped making sense. See ADR-021.
    const { client } = await fixture(["read", "propose"]);
    const first = structured<{ id: string }>(await client.callTool({
      name: "tasq_commitment_create",
      arguments: { title: "Make list paginate", idempotencyKey: "assumption-a" },
    }));
    const second = structured<{ id: string }>(await client.callTool({
      name: "tasq_commitment_create",
      arguments: { title: "Add a default limit", idempotencyKey: "assumption-b" },
    }));

    // Both agents phrase the belief differently and must land on one record.
    const attached = structured<{ assumption: { id: string; text: string } }>(await client.callTool({
      name: "tasq_assumption_attach",
      arguments: { commitmentId: first.id, because: "list times out past 10k tasks" },
    }));
    const shared = structured<{ assumption: { id: string } }>(await client.callTool({
      name: "tasq_assumption_attach",
      arguments: { commitmentId: second.id, because: "List  Times Out  Past 10k Tasks" },
    }));
    expect(shared.assumption.id).toBe(attached.assumption.id);

    const state = structured<{ paused: boolean }>(await client.callTool({
      name: "tasq_assumption_state",
      arguments: { commitmentId: first.id },
    }));
    expect(state.paused).toBe(false);

    const withdrawn = structured<{ pausedCommitmentIds: string[]; assumption: { status: string } }>(
      await client.callTool({
        name: "tasq_assumption_withdraw",
        arguments: {
          because: "list times out past 10k tasks",
          reason: "measured 10k in 240ms; the cost is serialisation",
        },
      }),
    );
    expect(withdrawn.assumption.status).toBe("withdrawn");
    expect(withdrawn.pausedCommitmentIds.sort()).toEqual([first.id, second.id].sort());

    const after = structured<{ paused: boolean }>(await client.callTool({
      name: "tasq_assumption_state",
      arguments: { commitmentId: second.id },
    }));
    expect(after.paused).toBe(true);
  });

  it("lets an agent build the dependency graph, and refuses a cycle", async () => {
    // discovery.ts advertised a `relations` capability with four operations and
    // no wire surface served it: MCP had no relation tool at all, so an agent
    // could not add a single edge. See ADR-022.
    const { client } = await fixture(["read", "propose"]);
    const first = structured<{ id: string }>(await client.callTool({
      name: "tasq_commitment_create",
      arguments: { title: "Ship the fix", idempotencyKey: "rel-a" },
    }));
    const second = structured<{ id: string }>(await client.callTool({
      name: "tasq_commitment_create",
      arguments: { title: "Reproduce the bug", idempotencyKey: "rel-b" },
    }));

    const edge = structured<{ id: string; relationType: string; revision: number }>(await client.callTool({
      name: "tasq_relation_add",
      arguments: {
        fromCommitmentId: first.id,
        toCommitmentId: second.id,
        relationType: "depends_on",
        idempotencyKey: "rel-edge",
      },
    }));
    expect(edge.relationType).toBe("depends_on");

    // An array result is wrapped as { value }, because MCP structured content
    // must be a JSON object.
    const listed = structured<{ value: Array<{ fromTaskId: string; toTaskId: string }> }>(
      await client.callTool({ name: "tasq_relation_list", arguments: { commitmentId: first.id } }),
    );
    expect(listed.value).toHaveLength(1);
    expect(listed.value[0]!.toTaskId).toBe(second.id);

    // The cycle guard is the kernel's, reused rather than duplicated.
    const cycle = await client.callTool({
      name: "tasq_relation_add",
      arguments: {
        fromCommitmentId: second.id,
        toCommitmentId: first.id,
        relationType: "depends_on",
        idempotencyKey: "rel-cycle",
      },
    });
    expect(cycle.isError).toBe(true);
    expect(JSON.stringify(cycle.content)).toMatch(/cycle/i);

    const ended = structured<{ endedAt: number | null }>(await client.callTool({
      name: "tasq_relation_end",
      arguments: { relationId: edge.id, expectedRevision: edge.revision, idempotencyKey: "rel-end" },
    }));
    expect(ended.endedAt).not.toBeNull();
  });

  it("lets an agent decompose a commitment and read the tree back", async () => {
    // MCP had zero hierarchy tools across 57: an agent could only produce a flat
    // pile while a human on the CLI got decomposition. ADR-023 separates
    // decomposition from the planning vocabulary, which is what makes this
    // expressible without area/goal/project entering the kernel surface.
    const { client } = await fixture(["read", "propose"]);
    const parent = structured<{ id: string }>(await client.callTool({
      name: "tasq_commitment_create",
      arguments: { title: "Calibrate the arm", idempotencyKey: "tree-parent" },
    }));
    const child = structured<{ id: string; parentCommitmentId: string }>(await client.callTool({
      name: "tasq_commitment_create",
      arguments: {
        title: "Home all six axes",
        parentCommitmentId: parent.id,
        idempotencyKey: "tree-child",
      },
    }));
    expect(child.parentCommitmentId).toBe(parent.id);

    const tree = structured<{ value: Array<{ id: string }> }>(await client.callTool({
      name: "tasq_commitment_tree",
      arguments: { commitmentId: parent.id },
    }));
    expect(tree.value.map((node) => node.id)).toEqual([parent.id, child.id]);
  });

  it("lets an agent report a discovery without touching its claim", async () => {
    // The agents best placed to notice a defect had no way to record one: the
    // relation table and discovered_from were already kernel, but no kernel API
    // wrote a relation. See ADR-020.
    const { db, client, clock } = await fixture(["read", "propose", "coordinate"]);
    const source = structured<{ id: string }>(await client.callTool({
      name: "tasq_commitment_create",
      arguments: { title: "Port the client", idempotencyKey: "discovery-source" },
    }));
    const claim = structured<{ id: string; actor: string }>(await client.callTool({
      name: "tasq_claim_acquire",
      arguments: { commitmentId: source.id, leaseMs: 60_000, idempotencyKey: "discovery-claim" },
    }));

    const captured = structured<{ commitment: { id: string; title: string }; discoveredFrom: string; replayed: boolean }>(
      await client.callTool({
        name: "tasq_discovery_capture",
        arguments: {
          sourceCommitmentId: source.id,
          title: "The API drops the field we depend on",
          sourceCommand: "reading the changelog",
          idempotencyKey: "discovery-1",
        },
      }),
    );
    expect(captured.commitment.title).toBe("The API drops the field we depend on");
    expect(captured.discoveredFrom).toBe(source.id);
    expect(captured.replayed).toBe(false);

    // The whole point: reporting must be safe mid-task, so the claim the agent
    // is working under has to survive it untouched.
    const stillHeld = await getActiveTaskClaim(db, source.id, "robotics-lab", clock);
    expect(stillHeld).toMatchObject({ id: claim.id, releasedAt: null });

    // Replaying the same identity returns the same discovery, not a second one.
    const replayed = structured<{ commitment: { id: string }; replayed: boolean }>(
      await client.callTool({
        name: "tasq_discovery_capture",
        arguments: {
          sourceCommitmentId: source.id,
          title: "The API drops the field we depend on",
          sourceCommand: "reading the changelog",
          idempotencyKey: "discovery-1",
        },
      }),
    );
    expect(replayed.commitment.id).toBe(captured.commitment.id);
    expect(replayed.replayed).toBe(true);
  });

  it("makes agent-proposed work evidence-backed when the host registers it", async () => {
    // `tasq agent install` registers --completion evidence, which is what makes
    // "they cannot mark anything done without a receipt you can inspect" true
    // for the work an agent proposes.
    const { client } = await fixture(["read", "propose", "coordinate"], "evidence");

    const backed = structured<{ completionPolicy: string; id: string }>(await client.callTool({
      name: "tasq_commitment_create",
      arguments: {
        title: "Ship the release notes",
        successCriteria: "The published URL is attached as evidence",
        idempotencyKey: "evidence-default-1",
      },
    }));
    expect(backed.completionPolicy).toBe("evidence");

    // An explicit policy on the call still wins: the default is a default.
    const asserted = structured<{ completionPolicy: string }>(await client.callTool({
      name: "tasq_commitment_create",
      arguments: {
        title: "Quick note",
        completionPolicy: "assertion",
        idempotencyKey: "evidence-default-2",
      },
    }));
    expect(asserted.completionPolicy).toBe("assertion");

    // Evidence judges a receipt against stated criteria, so omitting them is
    // refused rather than silently downgraded, which would hole the guarantee.
    const refused = await client.callTool({
      name: "tasq_commitment_create",
      arguments: { title: "Vague work", idempotencyKey: "evidence-default-3" },
    });
    expect(refused.isError).toBe(true);
    expect(firstContent(refused)).toMatchObject({
      type: "text",
      text: expect.stringMatching(/successCriteria/),
    });
  });

  it("leaves completion policy alone when the host registers no default", async () => {
    const { client } = await fixture(["read", "propose", "coordinate"]);
    const created = structured<{ completionPolicy: string }>(await client.callTool({
      name: "tasq_commitment_create",
      arguments: { title: "Plain work", idempotencyKey: "no-default-1" },
    }));
    expect(created.completionPolicy).toBe("assertion");
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

  it("requires proposal authority before a host can add direction authority", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tasq-mcp-direction-"));
    const opened = await openDb({ url: `file:${join(dir, "db.sqlite")}`, wal: false });
    const clock = createMutableClock(10_000);
    await runKernelMigrations(opened.client, { clock });
    try {
      expect(() => createTasqMcpServer({
        db: opened.db,
        workspaceId: "robotics-lab",
        actor: "agent:planner",
        capabilities: ["read", "direction"],
        clock,
      })).toThrow(/direction capability requires propose/);
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
    expect(() => parseTasqMcpCapabilities("read,direction")).toThrow(/requires propose/);
    expect(parseTasqMcpCapabilities("read,propose,direction"))
      .toEqual(["read", "propose", "direction"]);
    expect(() => parseTasqMcpCapabilities("effect")).toThrow(/require read/);
  });

  it("reserves public-roadmap direction to a separately granted capability", async () => {
    const ordinary = await fixture(["read", "propose", "coordinate"]);
    const refusedCreate = await ordinary.client.callTool({
      name: "tasq_commitment_create",
      arguments: {
        title: "Publish a roadmap item",
        metadata: { publicId: "TQ-999" },
        idempotencyKey: "ordinary-direction-create",
      },
    });
    expect(refusedCreate.isError).toBe(true);
    expect(firstContent(refusedCreate)).toMatchObject({
      type: "text",
      text: expect.stringMatching(/requires.*direction capability/i),
    });

    const directionTask = await createCommitment(ordinary.db, {
      title: "Existing direction item",
      metadata: { roadmapProjectionVersion: 1, publicId: "TQ-998" },
    }, {
      workspaceId: "robotics-lab",
      actor: "maintainer",
      now: ordinary.clock.now(),
      clock: ordinary.clock,
    });
    const refusedUpdate = await ordinary.client.callTool({
      name: "tasq_commitment_update",
      arguments: {
        commitmentId: directionTask.id,
        expectedRevision: directionTask.revision,
        patch: { title: "Worker cannot redirect it" },
        idempotencyKey: "ordinary-direction-update",
      },
    });
    expect(refusedUpdate.isError).toBe(true);
    expect(firstContent(refusedUpdate)).toMatchObject({
      type: "text",
      text: expect.stringMatching(/requires.*direction capability/i),
    });

    const privileged = await fixture(["read", "propose", "direction"]);
    const created = structured<{ id: string }>(await privileged.client.callTool({
      name: "tasq_commitment_create",
      arguments: {
        title: "Authorized direction item",
        metadata: {
          roadmapProjectionVersion: 1,
          publicId: "TQ-997",
          publicOrder: 61,
          publicStatus: "pending",
          milestone: "future",
          dependsOn: [],
          outcome: "Prove direction authority is separately bounded",
        },
        idempotencyKey: "authorized-direction-create",
      },
    }));
    expect((await getCommitment(privileged.db, created.id, "robotics-lab"))?.metadata)
      .toMatchObject({ publicId: "TQ-997", publicStatus: "pending" });
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
      "tasq_resolution_contract_create",
      "tasq_evidence_trust_attest_unverified",
      "tasq_completion_propose",
      "tasq_completion_challenge",
      "tasq_completion_attest",
      "tasq_completion_settle_optimistic",
      "tasq_completion_adjudicate",
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
  it("resolves and completes a validated commitment through capability-scoped tools", async () => {
    const { client } = await fixture(["read", "propose", "coordinate"]);
    const created = structured<{ id: string; revision: number }>(await client.callTool({
      name: "tasq_commitment_create",
      arguments: {
        title: "Verify calibration artifact",
        successCriteria: "One calibration artifact exists",
        completionPolicy: "evidence",
        validationRequired: true,
        idempotencyKey: "validated-create",
      },
    }));
    const evidence = structured<{ id: string }>(await client.callTool({
      name: "tasq_evidence_add",
      arguments: {
        commitmentId: created.id,
        kind: "artifact",
        summary: "Calibration artifact exists",
        idempotencyKey: "validated-evidence",
      },
    }));
    const plannerPrincipalId = localPrincipalId("robotics-lab", "agent:planner");
    const contract = structured<{ id: string }>(await client.callTool({
      name: "tasq_resolution_contract_create",
      arguments: {
        commitmentId: created.id,
        criteria: [{
          id: "artifact",
          statement: "One calibration artifact exists",
          acceptedEvidenceKinds: ["artifact"],
          minimumAuthenticity: "unverified",
        }],
        policyKind: "attestation",
        policyUri: "urn:tasq:test:attestation",
        policyVersion: 1,
        implementationDigest: `sha256:${"a".repeat(64)}`,
        allowSelfValidation: true,
        eligibleValidatorPrincipalIds: [plannerPrincipalId],
        idempotencyKey: "validated-contract",
      },
    }));
    const trust = structured<{ id: string }>(await client.callTool({
      name: "tasq_evidence_trust_attest_unverified",
      arguments: {
        commitmentId: created.id,
        evidenceId: evidence.id,
        reason: "MCP-local attribution only",
        idempotencyKey: "validated-trust",
      },
    }));
    const proposal = structured<{ id: string }>(await client.callTool({
      name: "tasq_completion_propose",
      arguments: {
        commitmentId: created.id,
        resolutionContractId: contract.id,
        criterionEvidence: [{ criterionId: "artifact", evidenceIds: [evidence.id] }],
        idempotencyKey: "validated-proposal",
      },
    }));
    const decision = structured<{ id: string; outcome: string }>(await client.callTool({
      name: "tasq_completion_attest",
      arguments: {
        proposalId: proposal.id,
        outcome: "accepted",
        reasonCode: "verified",
        explanation: "Frozen criterion is satisfied",
        idempotencyKey: "validated-decision",
      },
    }));
    expect(decision.outcome).toBe("accepted");
    const completed = structured<{ status: string }>(await client.callTool({
      name: "tasq_commitment_transition",
      arguments: {
        commitmentId: created.id,
        transition: "complete",
        expectedRevision: created.revision,
        validationDecisionId: decision.id,
        idempotencyKey: "validated-complete",
      },
    }));
    expect(completed.status).toBe("done");
    const chain = structured<{
      resolution: {
        contract: { id: string };
        trustRecords: Array<{ id: string }>;
        decisions: Array<{ id: string }>;
      } | null;
    }>(await client.callTool({
      name: "tasq_resolution_get",
      arguments: { resolutionContractId: contract.id },
    }));
    expect(chain.resolution).toMatchObject({
      contract: { id: contract.id },
      trustRecords: [{ id: trust.id }],
      decisions: [{ id: decision.id }],
    });
  });

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
    if (!Array.isArray(listed.items)) throw new Error(`shape: ${JSON.stringify(listed).slice(0, 400)}`);
    expect(listed.items).toHaveLength(1);
  });
});

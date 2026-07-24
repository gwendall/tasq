/** TQ-809 — two-client enrollment, contention, retry, revocation and MCP parity. */

import { afterEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ACTION_URIS,
  definePermissionSet,
  getRegisteredAction,
  type ActionDefinition,
} from "@tasq-internal/authority";
import {
  HostedMutationError,
  IsolatedWorkspaceRouter,
  createHostedHttpHandler,
  createHostedMcpHandler,
  createRemoteEnrollmentAuthority,
  createRemoteEnrollmentHandler,
  openAuthorityStore,
  type AuthorityMutationContext,
  type HostedMutationCommand,
  type HostedMutationOperation,
  type HostedMutationOutcome,
  type HostedMutationWorkspace,
} from "@tasq-internal/server";
import { createRemoteTasq, redeemRemoteEnrollment } from "@tasq-run/client";

const NOW = 1_830_000_000_000;
const RESOURCE = "https://remote-eval.example/";
const ISSUER = "https://remote-issuer.example/";
const WORKSPACE = "operations/alpha";
const sha = (character: string) => `sha256:${character.repeat(64)}`;
const roots: string[] = [];
let operationNumber = 0;

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function action(name: keyof typeof ACTION_URIS): ActionDefinition {
  const found = getRegisteredAction(ACTION_URIS[name]);
  if (!found) throw new Error(`missing ${name}`);
  return found;
}

function actionIdentity(value: ActionDefinition) {
  return { uri: value.uri, version: value.version, implementationDigest: value.implementationDigest };
}

function context(revision: number | null): AuthorityMutationContext {
  operationNumber += 1;
  return {
    operationId: `remote-eval-authority-${operationNumber}`,
    actorPrincipalId: revision === null ? "local-operator" : "admin",
    reason: "TQ-809 clean-room eval",
    expectedAuthorityRevision: revision,
  };
}

function operation(id: string, actionUri: string): HostedMutationOperation {
  return {
    id,
    actionUri,
    summary: id,
    inputContract: {
      uri: `urn:eval:contract:${id}:input:v1`,
      version: 1,
      implementationDigest: sha("1"),
    },
    outputContract: {
      uri: `urn:eval:contract:${id}:output:v1`,
      version: 1,
      implementationDigest: sha("2"),
    },
    requiresExpectedRevision: false,
  };
}

describe("TQ-809 remote client and enrollment acceptance", () => {
  test("two clean clients resolve contention and keep REST/MCP on one live authority", async () => {
    const root = mkdtempSync(join(tmpdir(), "tasq-remote-client-eval-"));
    roots.push(root);
    operationNumber = 0;
    const clock = { now: () => NOW };
    const authorityStore = await openAuthorityStore({
      url: `file:${join(root, "authority.sqlite")}`,
      clock,
    });
    await authorityStore.provisionHostTenant({ id: "host", context: context(null) });
    await authorityStore.provisionWorkspace({
      workspaceId: WORKSPACE,
      hostTenantId: "host",
      storageBindingId: "workspace-ledger",
      context: context(null),
    });
    let revision = 0;
    await authorityStore.registerPrincipal({
      principal: { id: "admin", workspaceId: WORKSPACE, kind: "human", status: "enabled", revision: 1 },
      context: context(revision++),
    });
    const actions = [
      action("workspace.read"),
      action("commitment.read"),
      action("claim.coordinate"),
      action("resource.coordinate"),
    ];
    const permission = definePermissionSet({
      uri: "urn:eval:permission:remote-worker",
      version: 1,
      actions,
    });
    for (const worker of ["machine-a", "machine-b"]) {
      await authorityStore.registerPrincipal({
        principal: { id: worker, workspaceId: WORKSPACE, kind: "agent", status: "enabled", revision: 1 },
        context: context(revision++),
      });
      await authorityStore.bindSubject({
        binding: {
          contractVersion: "tasq.subject-binding.v1",
          id: `${worker}-binding`,
          workspaceId: WORKSPACE,
          principalId: worker,
          issuer: ISSUER,
          subject: `${worker}-subject`,
          method: "oauth_introspection",
          status: "enabled",
          revision: 1,
          createdAt: NOW,
          disabledAt: null,
          replacedByBindingId: null,
        },
        context: context(revision++),
      });
    }
    await authorityStore.activatePermissionSet({
      workspaceId: WORKSPACE,
      permissionSet: permission,
      context: context(revision++),
    });
    for (const worker of ["machine-a", "machine-b"]) {
      await authorityStore.createGrant({
        grant: {
          contractVersion: "tasq.authorization-grant.v1",
          id: `${worker}-grant`,
          workspaceId: WORKSPACE,
          grantorPrincipalId: "admin",
          granteePrincipalId: worker,
          permissionSet: {
            uri: permission.uri,
            version: permission.version,
            implementationDigest: permission.implementationDigest,
          },
          scope: { kind: "workspace" },
          notBefore: NOW,
          expiresAt: NOW + 86_400_000,
          status: "active",
          revision: 1,
        },
        context: context(revision++),
      });
    }

    const enrollmentAuthority = createRemoteEnrollmentAuthority({
      store: authorityStore,
      clock,
      pepper: new Uint8Array(32).fill(5),
      issuer: ISSUER,
      audience: RESOURCE,
    });
    const enrollmentTokens = new Map<string, string>();
    for (const worker of ["machine-a", "machine-b"]) {
      const created = await enrollmentAuthority.create({
        workspaceId: WORKSPACE,
        principalId: worker,
        subject: `${worker}-subject`,
        clientKind: "workload_agent",
        actionUpperBound: actions.map(actionIdentity),
        enrollmentExpiresAt: NOW + 600_000,
        accessExpiresAt: NOW + 3_600_000,
        context: context(revision++),
      });
      enrollmentTokens.set(worker, created.enrollmentToken);
    }

    const commitments = [{
      id: "commitment-one",
      workspaceId: WORKSPACE,
      title: "Coordinate deployment",
      status: "open",
      revision: 1,
      createdAt: NOW,
      updatedAt: NOW,
    }];
    const events: Array<{
      id: string;
      sequence: number;
      entityType: string;
      entityId: string;
      eventType: string;
      actorPrincipalId: string | null;
      createdAt: number;
    }> = [];
    const outcomes = new Map<string, HostedMutationOutcome>();
    let claimHolder: string | null = null;
    const resourceHolders = new Map<string, string>();
    async function mutate(command: HostedMutationCommand): Promise<HostedMutationOutcome> {
      const prior = outcomes.get(command.idempotencyKeyDigest);
      if (prior) {
        if (prior.requestDigest !== command.requestDigest) throw new HostedMutationError("conflict");
        return { ...prior, replayed: true };
      }
      const principal = command.decision.subjectPrincipalId;
      if (!principal) throw new HostedMutationError("conflict");
      if (command.operation.id === "claim.acquire") {
        if (claimHolder && claimHolder !== principal) throw new HostedMutationError("conflict");
        claimHolder = principal;
      } else if (command.operation.id === "claim.release") {
        if (claimHolder !== principal) throw new HostedMutationError("conflict");
        claimHolder = null;
      } else if (command.operation.id === "resource.acquire") {
        const holder = resourceHolders.get(command.resource.id);
        if (holder && holder !== principal) throw new HostedMutationError("conflict");
        resourceHolders.set(command.resource.id, principal);
      } else if (command.operation.id === "resource.release") {
        if (resourceHolders.get(command.resource.id) !== principal) throw new HostedMutationError("conflict");
        resourceHolders.delete(command.resource.id);
      }
      const sequence = events.length + 1;
      const event = {
        id: `event-${sequence}`,
        sequence,
        entityType: command.resource.kind,
        entityId: command.resource.id,
        eventType: command.operation.id,
        actorPrincipalId: principal,
        createdAt: NOW,
      };
      events.push(event);
      const outcome: HostedMutationOutcome = {
        contractVersion: "tasq.hosted-mutation-outcome.v1",
        workspaceId: WORKSPACE,
        operationId: command.operation.id,
        requestDigest: command.requestDigest,
        idempotencyKeyDigest: command.idempotencyKeyDigest,
        resultType: command.resource.kind,
        resultId: command.resource.id,
        resultRevision: sequence,
        eventSequence: sequence,
        replayed: false,
        result: {
          holder: command.operation.id.endsWith("release") ? null : principal,
          fence: sequence,
        },
      };
      outcomes.set(command.idempotencyKeyDigest, outcome);
      return outcome;
    }
    const workspace: HostedMutationWorkspace = {
      workspaceId: WORKSPACE,
      async getCommitment(id) {
        return commitments.find((item) => item.id === id) ?? null;
      },
      async listCommitments() {
        return { items: commitments, nextCursor: null };
      },
      async listEventMetadata({ afterSequence, limit }) {
        const items = events.filter(({ sequence }) => sequence > afterSequence).slice(0, limit);
        return { items, nextSequence: items.at(-1)?.sequence ?? null };
      },
      executeMutation: mutate,
    };
    const router = new IsolatedWorkspaceRouter(authorityStore, [{
      workspaceId: WORKSPACE,
      storageBindingId: "workspace-ledger",
      open: async () => workspace,
    }]);
    const operations = [
      operation("claim.acquire", ACTION_URIS["claim.coordinate"]),
      operation("claim.release", ACTION_URIS["claim.coordinate"]),
      operation("resource.acquire", ACTION_URIS["resource.coordinate"]),
      operation("resource.release", ACTION_URIS["resource.coordinate"]),
    ];
    const rest = createHostedHttpHandler({
      protectedResource: RESOURCE,
      authorizationServers: [ISSUER],
      clock,
      verifier: enrollmentAuthority.verifier,
      router,
      mutationOperations: operations,
    });
    const mcp = createHostedMcpHandler({
      protectedResource: RESOURCE,
      authorizationServers: [ISSUER],
      clock,
      verifier: enrollmentAuthority.verifier,
      router,
      mutationOperations: operations,
    });
    const enroll = createRemoteEnrollmentHandler({
      endpoint: RESOURCE,
      authority: enrollmentAuthority,
      clock,
    });
    const route = (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      if (new URL(request.url).pathname.endsWith("/enrollments/redeem")) return enroll(request);
      return rest(request);
    };
    const credentials = new Map<string, Awaited<ReturnType<typeof redeemRemoteEnrollment>>>();
    for (const worker of ["machine-a", "machine-b"]) {
      credentials.set(worker, await redeemRemoteEnrollment({
        endpoint: RESOURCE,
        workspaceId: WORKSPACE,
        enrollmentToken: enrollmentTokens.get(worker)!,
        fetch: route,
      }));
    }
    const clientA = createRemoteTasq({
      endpoint: RESOURCE,
      workspaceId: WORKSPACE,
      accessToken: credentials.get("machine-a")!.accessToken,
      fetch: route,
    });
    const clientB = createRemoteTasq({
      endpoint: RESOURCE,
      workspaceId: WORKSPACE,
      accessToken: credentials.get("machine-b")!.accessToken,
      fetch: route,
    });
    const claim = {
      resource: { kind: "commitment" as const, id: "commitment-one" },
      input: { durationMs: 30_000 },
      idempotencyKey: "machine-a-claim",
      requestId: "machine-a-claim-request",
    };
    expect((await clientA.executeOperation("claim.acquire", claim)).result).toMatchObject({
      holder: "machine-a",
    });
    await expect(clientB.executeOperation("claim.acquire", {
      ...claim,
      idempotencyKey: "machine-b-blocked-claim",
      requestId: "machine-b-blocked-claim-request",
    })).rejects.toMatchObject({ status: 409, code: "mutation_conflict" });
    await clientA.executeOperation("claim.release", {
      ...claim,
      idempotencyKey: "machine-a-release",
      requestId: "machine-a-release-request",
    });
    expect((await clientB.executeOperation("claim.acquire", {
      ...claim,
      idempotencyKey: "machine-b-claim",
      requestId: "machine-b-claim-request",
    })).result).toMatchObject({ holder: "machine-b" });

    const resource = {
      resource: { kind: "resource" as const, id: "deployment-slot" },
      input: { durationMs: 30_000 },
      idempotencyKey: "machine-a-resource",
      requestId: "machine-a-resource-request",
    };
    await clientA.executeOperation("resource.acquire", resource);
    await expect(clientB.executeOperation("resource.acquire", {
      ...resource,
      idempotencyKey: "machine-b-blocked-resource",
      requestId: "machine-b-blocked-resource-request",
    })).rejects.toMatchObject({ status: 409, code: "mutation_conflict" });
    await clientA.executeOperation("resource.release", {
      ...resource,
      idempotencyKey: "machine-a-resource-release",
      requestId: "machine-a-resource-release-request",
    });
    expect((await clientB.executeOperation("resource.acquire", {
      ...resource,
      idempotencyKey: "machine-b-resource",
      requestId: "machine-b-resource-request",
    })).result).toMatchObject({ holder: "machine-b" });

    let drop = true;
    const lossyA = createRemoteTasq({
      endpoint: RESOURCE,
      workspaceId: WORKSPACE,
      accessToken: credentials.get("machine-a")!.accessToken,
      fetch: async (input, init) => {
        const response = await route(input, init);
        if (drop) {
          drop = false;
          throw new TypeError("lost after commit");
        }
        return response;
      },
    });
    const retryInput = {
      resource: { kind: "resource" as const, id: "retry-slot" },
      input: { durationMs: 30_000 },
      idempotencyKey: "lost-response-key",
      requestId: "lost-response-request",
    };
    await expect(lossyA.executeOperation("resource.acquire", retryInput))
      .rejects.toMatchObject({ code: "network_error", retryable: true });
    expect((await lossyA.executeOperation("resource.acquire", retryInput)).replayed).toBe(true);

    const restCommitments = await clientA.listCommitments();
    const restEvents = await clientA.listEvents({ afterSequence: 0, limit: 100 });
    const transport = new StreamableHTTPClientTransport(
      new URL("/v1/workspaces/operations%2Falpha/mcp", RESOURCE),
      {
        requestInit: {
          headers: { authorization: `Bearer ${credentials.get("machine-a")!.accessToken}` },
        },
        fetch: async (input, init) => mcp(new Request(input, init)),
      },
    );
    const mcpClient = new Client({ name: "remote-eval", version: "1.0.0" });
    await mcpClient.connect(transport);
    try {
      const mcpCommitments = await mcpClient.callTool({
        name: "tasq_commitment_list",
        arguments: { limit: 100 },
      });
      const mcpEvents = await mcpClient.callTool({
        name: "tasq_event_list",
        arguments: { afterSequence: 0, limit: 100 },
      });
      expect(mcpCommitments.structuredContent).toMatchObject({
        items: restCommitments.items,
        nextCursor: restCommitments.nextCursor,
      });
      expect(mcpEvents.structuredContent).toMatchObject({
        items: restEvents.items,
        nextSequence: restEvents.nextSequence,
      });
    } finally {
      await mcpClient.close();
    }

    await authorityStore.revokeGrant({
      workspaceId: WORKSPACE,
      grantId: "machine-b-grant",
      expectedGrantRevision: 1,
      context: context(revision++),
    });
    await expect(clientB.listCommitments()).rejects.toMatchObject({
      status: 403,
      code: "access_denied",
    });
    await expect(clientB.executeOperation("resource.release", {
      ...resource,
      idempotencyKey: "machine-b-after-revocation",
      requestId: "machine-b-after-revocation-request",
    })).rejects.toMatchObject({ status: 403, code: "access_denied" });

    await authorityStore.close();
  });
});

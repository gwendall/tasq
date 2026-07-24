import { afterEach, beforeEach, describe, expect, test } from "bun:test";
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
  type VerifiedIdentity,
} from "@tasq-internal/authority";
import {
  HostedMutationError,
  IsolatedWorkspaceRouter,
  createHostedMcpHandler,
  openAuthorityStore,
  type AuthorityMutationContext,
  type AuthorityStore,
  type HostedMutationCommand,
  type HostedMutationOperation,
  type HostedMutationOutcome,
  type HostedMutationWorkspace,
} from "../src/index.js";

const NOW = 1_820_000_000_000;
const RESOURCE = "https://server.tasq.example/";
const ISSUER = "https://issuer.example/";
const WORKSPACE = "robotics/team-a";
const sha = (character: string) => `sha256:${character.repeat(64)}`;
const clock = { calls: 0, now() { this.calls += 1; return NOW; } };
const operationDefinition: HostedMutationOperation = {
  id: "commitment.propose",
  actionUri: ACTION_URIS["commitment.propose"],
  summary: "Propose one durable commitment",
  inputContract: {
    uri: "urn:test:contract:commitment-proposal:v1",
    version: 1,
    implementationDigest: sha("9"),
  },
  outputContract: {
    uri: "urn:test:contract:commitment-result:v1",
    version: 1,
    implementationDigest: sha("8"),
  },
  requiresExpectedRevision: false,
};

let root = "";
let authority: AuthorityStore;
let authorityRevision = 0;
let authorityOperation = 0;
let verifierCalls = 0;
let opens = 0;
let commits = 0;
const commitments = new Map<string, {
  id: string;
  workspaceId: string;
  title: string;
  status: string;
  revision: number;
  createdAt: number;
  updatedAt: number;
}>();
const outcomes = new Map<string, HostedMutationOutcome>();

function action(): ActionDefinition {
  const found = getRegisteredAction(ACTION_URIS["commitment.propose"]);
  if (!found) throw new Error("missing commitment.propose action");
  return found;
}

const actionIdentity = (value: ActionDefinition) => ({
  uri: value.uri,
  version: value.version,
  implementationDigest: value.implementationDigest,
});

function context(expected: number | null): AuthorityMutationContext {
  authorityOperation += 1;
  return {
    operationId: `remote-mcp-authority-${authorityOperation}`,
    actorPrincipalId: expected === null ? "local-operator" : "admin",
    reason: "remote MCP fixture",
    expectedAuthorityRevision: expected,
  };
}

const identity: VerifiedIdentity = {
  contractVersion: "tasq.verified-identity.v1",
  issuer: ISSUER,
  subject: "remote-agent",
  audience: [RESOURCE],
  authenticationMethod: "oauth_jwt_access_token",
  authenticatedAt: NOW - 1_000,
  notBefore: NOW - 1_000,
  expiresAt: NOW + 60_000,
  clientId: "remote-mcp-client",
  actor: null,
  credentialBinding: { kind: "none" },
  tokenIdDigest: sha("1"),
  issuerConfigurationDigest: sha("2"),
  credentialKeyDigest: sha("3"),
  actionUpperBound: [
    actionIdentity(action()),
    actionIdentity(getRegisteredAction(ACTION_URIS["workspace.read"])!),
  ],
};

async function configureAuthority() {
  await authority.provisionHostTenant({ id: "host", context: context(null) });
  await authority.provisionWorkspace({
    workspaceId: WORKSPACE,
    hostTenantId: "host",
    storageBindingId: "opaque-workspace-slot",
    context: context(null),
  });
  await authority.registerPrincipal({
    principal: { id: "admin", workspaceId: WORKSPACE, kind: "human", status: "enabled", revision: 1 },
    context: context(authorityRevision++),
  });
  await authority.registerPrincipal({
    principal: { id: "agent", workspaceId: WORKSPACE, kind: "agent", status: "enabled", revision: 1 },
    context: context(authorityRevision++),
  });
  await authority.bindSubject({
    binding: {
      contractVersion: "tasq.subject-binding.v1",
      id: "agent-binding",
      workspaceId: WORKSPACE,
      principalId: "agent",
      issuer: ISSUER,
      subject: "remote-agent",
      method: "oidc",
      status: "enabled",
      revision: 1,
      createdAt: NOW - 10_000,
      disabledAt: null,
      replacedByBindingId: null,
    },
    context: context(authorityRevision++),
  });
  const permission = definePermissionSet({
    uri: "urn:test:permission:remote-mcp",
    version: 1,
    actions: [
      action(),
      getRegisteredAction(ACTION_URIS["workspace.read"])!,
    ],
  });
  await authority.activatePermissionSet({
    workspaceId: WORKSPACE,
    permissionSet: permission,
    context: context(authorityRevision++),
  });
  await authority.createGrant({
    grant: {
      contractVersion: "tasq.authorization-grant.v1",
      id: "agent-grant",
      workspaceId: WORKSPACE,
      grantorPrincipalId: "admin",
      granteePrincipalId: "agent",
      permissionSet: {
        uri: permission.uri,
        version: permission.version,
        implementationDigest: permission.implementationDigest,
      },
      scope: { kind: "workspace" },
      notBefore: NOW,
      expiresAt: NOW + 50_000,
      status: "active",
      revision: 1,
    },
    context: context(authorityRevision++),
  });
}

async function executeMutation(command: HostedMutationCommand): Promise<HostedMutationOutcome> {
  const prior = outcomes.get(command.idempotencyKeyDigest);
  if (prior) {
    if (prior.requestDigest !== command.requestDigest) throw new HostedMutationError("conflict");
    return { ...prior, replayed: true };
  }
  const input = command.input as { title?: unknown };
  if (typeof input?.title !== "string" || !input.title) throw new HostedMutationError("invalid_input");
  const id = `commitment-${commitments.size + 1}`;
  commitments.set(id, {
    id,
    workspaceId: WORKSPACE,
    title: input.title,
    status: "open",
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
  });
  const outcome: HostedMutationOutcome = {
    contractVersion: "tasq.hosted-mutation-outcome.v1",
    workspaceId: WORKSPACE,
    operationId: command.operation.id,
    requestDigest: command.requestDigest,
    idempotencyKeyDigest: command.idempotencyKeyDigest,
    resultType: "commitment",
    resultId: id,
    resultRevision: 1,
    eventSequence: 1,
    replayed: false,
    result: commitments.get(id)!,
  };
  outcomes.set(command.idempotencyKeyDigest, outcome);
  commits += 1;
  return outcome;
}

const workspace: HostedMutationWorkspace = {
  workspaceId: WORKSPACE,
  async getCommitment(id) {
    return commitments.get(id) ?? null;
  },
  async listCommitments({ limit }) {
    return { items: [...commitments.values()].slice(0, limit), nextCursor: null };
  },
  async listEventMetadata() {
    return { items: [], nextSequence: null };
  },
  executeMutation,
};

function handler() {
  const router = new IsolatedWorkspaceRouter(authority, [{
    workspaceId: WORKSPACE,
    storageBindingId: "opaque-workspace-slot",
    open: async () => {
      opens += 1;
      return workspace;
    },
  }]);
  return createHostedMcpHandler({
    protectedResource: RESOURCE,
    authorizationServers: [ISSUER],
    clock,
    router,
    mutationOperations: [operationDefinition],
    requestIdFactory: () => `mcp-request-${clock.calls}`,
    verifier: {
      async verify(input, requestClock) {
        verifierCalls += 1;
        expect(input).toMatchObject({
          authorization: "Bearer remote-token",
          method: "POST",
          expectedAudience: RESOURCE,
        });
        expect(input.requestUrl).toMatch(/^https:\/\/server\.tasq\.example\/v1\/workspaces\/[^/]+\/mcp$/);
        expect(requestClock.now()).toBe(NOW);
        return identity;
      },
    },
  });
}

async function connect(mcpHandler = handler()) {
  const endpoint = new URL("/v1/workspaces/robotics%2Fteam-a/mcp", RESOURCE);
  const transport = new StreamableHTTPClientTransport(endpoint, {
    requestInit: { headers: { authorization: "Bearer remote-token" } },
    fetch: async (url, init) => mcpHandler(new Request(url, init)),
  });
  const client = new Client({ name: "remote-mcp-test", version: "1.0.0" });
  await client.connect(transport);
  return { client, transport };
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "tasq-remote-mcp-"));
  authorityRevision = 0;
  authorityOperation = 0;
  verifierCalls = 0;
  opens = 0;
  commits = 0;
  commitments.clear();
  outcomes.clear();
  clock.calls = 0;
  authority = await openAuthorityStore({ url: `file:${join(root, "authority.sqlite")}`, clock });
  await configureAuthority();
  clock.calls = 0;
});

afterEach(async () => {
  await authority.close();
  rmSync(root, { recursive: true, force: true });
});

describe("TQ-805 authenticated remote MCP", () => {
  test("rejects unauthenticated framing before verification or workspace access", async () => {
    const response = await handler()(new Request(
      new URL("/v1/workspaces/robotics%2Fteam-a/mcp", RESOURCE),
      {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "unauthenticated",
          method: "initialize",
          params: {
            protocolVersion: "2025-11-25",
            capabilities: {},
            clientInfo: { name: "probe", version: "1.0.0" },
          },
        }),
      },
    ));
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      contractVersion: "tasq.hosted-mcp-problem.v1",
      code: "authentication_required",
    });
    expect({ verifierCalls, opens, commits }).toEqual({ verifierCalls: 0, opens: 0, commits: 0 });
  });

  test("uses the official client and projects reads and idempotent mutations through the Server guard", async () => {
    const { client } = await connect();
    try {
      const tools = await client.listTools();
      expect(tools.tools.map(({ name }) => name).sort()).toEqual([
        "tasq_commitment_get",
        "tasq_commitment_list",
        "tasq_event_list",
        "tasq_operation_commitment_propose",
        "tasq_operation_list",
      ]);

      const first = await client.callTool({
        name: "tasq_operation_commitment_propose",
        arguments: {
          resource: { kind: "workspace", id: WORKSPACE },
          input: { title: "Coordinate remote agents" },
          idempotencyKey: "remote-create",
        },
      });
      expect(first.isError).not.toBe(true);
      expect(first.structuredContent).toMatchObject({
        contractVersion: "tasq.hosted-mutation-response.v1",
        outcome: {
          resultId: "commitment-1",
          replayed: false,
          result: { title: "Coordinate remote agents" },
        },
      });

      const replay = await client.callTool({
        name: "tasq_operation_commitment_propose",
        arguments: {
          resource: { kind: "workspace", id: WORKSPACE },
          input: { title: "Coordinate remote agents" },
          idempotencyKey: "remote-create",
        },
      });
      expect(replay.structuredContent).toMatchObject({ outcome: { resultId: "commitment-1", replayed: true } });

      const page = await client.callTool({ name: "tasq_commitment_list", arguments: { limit: 10 } });
      expect(page.structuredContent).toMatchObject({
        contractVersion: "tasq.hosted-commitment-page.v1",
        items: [{ id: "commitment-1", title: "Coordinate remote agents" }],
      });
      expect(commits).toBe(1);
      expect(opens).toBeGreaterThanOrEqual(3);
      expect(verifierCalls).toBeGreaterThanOrEqual(5);
      expect(JSON.stringify(await authority.readAudit({ workspaceId: WORKSPACE }))).not.toContain("remote-token");
    } finally {
      await client.close();
    }
  });

  test("denies conflicting replay, immediate revocation and foreign-workspace probes", async () => {
    const mcpHandler = handler();
    const { client } = await connect(mcpHandler);
    try {
      await client.callTool({
        name: "tasq_operation_commitment_propose",
        arguments: {
          resource: { kind: "workspace", id: WORKSPACE },
          input: { title: "Original" },
          idempotencyKey: "stable-key",
        },
      });
      const conflict = await client.callTool({
        name: "tasq_operation_commitment_propose",
        arguments: {
          resource: { kind: "workspace", id: WORKSPACE },
          input: { title: "Changed" },
          idempotencyKey: "stable-key",
        },
      });
      expect(conflict.isError).toBe(true);
      expect(conflict.structuredContent).toMatchObject({ code: "mutation_conflict" });

      await authority.revokeGrant({
        workspaceId: WORKSPACE,
        grantId: "agent-grant",
        expectedGrantRevision: 1,
        context: context(authorityRevision),
      });
      const denied = await client.callTool({ name: "tasq_commitment_list", arguments: { limit: 10 } });
      expect(denied.isError).toBe(true);
      expect(denied.structuredContent).toMatchObject({ code: "access_denied" });
      expect(commits).toBe(1);
    } finally {
      await client.close();
    }

    const opensBeforeProbe = opens;
    const probe = await mcpHandler(new Request(
      new URL("/v1/workspaces/robotics%2Fteam-b/mcp", RESOURCE),
      {
        method: "POST",
        headers: {
          authorization: "Bearer remote-token",
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "probe",
          method: "tools/call",
          params: { name: "tasq_commitment_list", arguments: { limit: 10 } },
        }),
      },
    ));
    expect(probe.status).toBe(200);
    expect(await probe.text()).toContain("access_denied");
    expect(opens).toBe(opensBeforeProbe);
  });

  test("rejects normalized operation tool collisions before serving", () => {
    const router = new IsolatedWorkspaceRouter(authority, [{
      workspaceId: WORKSPACE,
      storageBindingId: "opaque-workspace-slot",
      open: async () => workspace,
    }]);
    expect(() => createHostedMcpHandler({
      protectedResource: RESOURCE,
      authorizationServers: [ISSUER],
      clock,
      router,
      verifier: { async verify() { return identity; } },
      mutationOperations: [
        { ...operationDefinition, id: "commitment.propose" },
        { ...operationDefinition, id: "commitment-propose" },
      ],
    })).toThrow(/colliding tool names/);
  });
});

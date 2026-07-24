/** TQ-805 — clean-room remote MCP, live guard and revocation eval. */

import { afterEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  ACTION_URIS,
  definePermissionSet,
  getRegisteredAction,
  type VerifiedIdentity,
} from "@tasq-internal/authority";
import {
  HOSTED_MCP_IMPLEMENTATION_DIGEST,
  IsolatedWorkspaceRouter,
  createHostedMcpHandler,
  openAuthorityStore,
  type AuthorityMutationContext,
  type HostedMutationWorkspace,
} from "@tasq-internal/server";

const NOW = 1_825_100_000_000;
const RESOURCE = "https://clean-mcp.example/api";
const ISSUER = "https://clean-issuer.example/";
const WORKSPACE = "operations/alpha";
const sha = (character: string) => `sha256:${character.repeat(64)}`;
const roots: string[] = [];
let operationNumber = 0;

const certificate = JSON.parse(readFileSync(
  resolve(import.meta.dir, "../..", "docs/contracts/TQ-805_REMOTE_MCP_CERTIFICATION.json"),
  "utf8",
)) as {
  status: string;
  implementationDigest: string;
  transport: { mcpSessions: boolean; durableResume: string };
  deployableServer: boolean;
  tq805Complete: boolean;
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function context(revision: number | null): AuthorityMutationContext {
  operationNumber += 1;
  return {
    operationId: `clean-mcp-authority-${operationNumber}`,
    actorPrincipalId: revision === null ? "local-operator" : "admin",
    reason: "clean-room remote MCP configuration",
    expectedAuthorityRevision: revision,
  };
}

function identity(): VerifiedIdentity {
  const read = getRegisteredAction(ACTION_URIS["workspace.read"]);
  if (!read) throw new Error("missing workspace.read");
  return {
    contractVersion: "tasq.verified-identity.v1",
    issuer: ISSUER,
    subject: "unknown-runtime",
    audience: [RESOURCE],
    authenticationMethod: "oauth_introspection",
    authenticatedAt: NOW - 1_000,
    notBefore: NOW - 1_000,
    expiresAt: NOW + 60_000,
    clientId: "clean-mcp-client",
    actor: null,
    credentialBinding: { kind: "none" },
    tokenIdDigest: sha("1"),
    issuerConfigurationDigest: sha("2"),
    credentialKeyDigest: sha("3"),
    actionUpperBound: [{
      uri: read.uri,
      version: read.version,
      implementationDigest: read.implementationDigest,
    }],
  };
}

describe("TQ-805 clean-room remote MCP", () => {
  test("binds the certificate to a real official-client read and immediate revocation", async () => {
    expect(certificate).toMatchObject({
      status: "certified",
      implementationDigest: HOSTED_MCP_IMPLEMENTATION_DIGEST,
      transport: { mcpSessions: false, durableResume: "Tasq event sequence cursor" },
      deployableServer: false,
      tq805Complete: true,
    });

    const root = mkdtempSync(join(tmpdir(), "tasq-clean-remote-mcp-"));
    roots.push(root);
    operationNumber = 0;
    const clock = { now: () => NOW };
    const authority = await openAuthorityStore({
      url: `file:${join(root, "authority.sqlite")}`,
      clock,
    });
    await authority.provisionHostTenant({ id: "clean-host", context: context(null) });
    await authority.provisionWorkspace({
      workspaceId: WORKSPACE,
      hostTenantId: "clean-host",
      storageBindingId: "opaque-operations-ledger",
      context: context(null),
    });
    let revision = 0;
    await authority.registerPrincipal({
      principal: { id: "admin", workspaceId: WORKSPACE, kind: "human", status: "enabled", revision: 1 },
      context: context(revision++),
    });
    await authority.registerPrincipal({
      principal: { id: "runtime", workspaceId: WORKSPACE, kind: "agent", status: "enabled", revision: 1 },
      context: context(revision++),
    });
    await authority.bindSubject({
      binding: {
        contractVersion: "tasq.subject-binding.v1",
        id: "runtime-binding",
        workspaceId: WORKSPACE,
        principalId: "runtime",
        issuer: ISSUER,
        subject: "unknown-runtime",
        method: "oauth_introspection",
        status: "enabled",
        revision: 1,
        createdAt: NOW - 2_000,
        disabledAt: null,
        replacedByBindingId: null,
      },
      context: context(revision++),
    });
    const read = getRegisteredAction(ACTION_URIS["workspace.read"])!;
    const permission = definePermissionSet({
      uri: "urn:clean:permission:remote-mcp-read",
      version: 1,
      actions: [read],
    });
    await authority.activatePermissionSet({
      workspaceId: WORKSPACE,
      permissionSet: permission,
      context: context(revision++),
    });
    await authority.createGrant({
      grant: {
        contractVersion: "tasq.authorization-grant.v1",
        id: "runtime-grant",
        workspaceId: WORKSPACE,
        grantorPrincipalId: "admin",
        granteePrincipalId: "runtime",
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
      context: context(revision++),
    });

    const workspace: HostedMutationWorkspace = {
      workspaceId: WORKSPACE,
      async getCommitment(id) {
        return id === "clean-work" ? {
          id,
          workspaceId: WORKSPACE,
          title: "Coordinate one clean runtime",
          status: "open",
          revision: 1,
          createdAt: NOW,
          updatedAt: NOW,
        } : null;
      },
      async listCommitments() {
        return {
          items: [{
            id: "clean-work",
            workspaceId: WORKSPACE,
            title: "Coordinate one clean runtime",
            status: "open",
            revision: 1,
            createdAt: NOW,
            updatedAt: NOW,
          }],
          nextCursor: null,
        };
      },
      async listEventMetadata() {
        return { items: [], nextSequence: null };
      },
      async executeMutation() {
        throw new Error("clean read-only runtime cannot execute mutations");
      },
    };
    let opens = 0;
    const router = new IsolatedWorkspaceRouter(authority, [{
      workspaceId: WORKSPACE,
      storageBindingId: "opaque-operations-ledger",
      open: async () => {
        opens += 1;
        return workspace;
      },
    }]);
    const propose = getRegisteredAction(ACTION_URIS["commitment.propose"])!;
    const handler = createHostedMcpHandler({
      protectedResource: RESOURCE,
      authorizationServers: [ISSUER],
      clock,
      router,
      mutationOperations: [{
        id: "commitment.propose",
        actionUri: propose.uri,
        summary: "Propose a commitment",
        inputContract: {
          uri: "urn:clean:contract:proposal:v1",
          version: 1,
          implementationDigest: sha("9"),
        },
        outputContract: {
          uri: "urn:clean:contract:commitment:v1",
          version: 1,
          implementationDigest: sha("8"),
        },
        requiresExpectedRevision: false,
      }],
      verifier: {
        async verify(input, requestClock) {
          expect(input).toMatchObject({
            method: "POST",
            expectedAudience: RESOURCE,
            authorization: "Bearer clean-mcp",
          });
          expect(requestClock.now()).toBe(NOW);
          return identity();
        },
      },
    });
    const endpoint = new URL("/api/v1/workspaces/operations%2Falpha/mcp", RESOURCE);
    const transport = new StreamableHTTPClientTransport(endpoint, {
      requestInit: { headers: { authorization: "Bearer clean-mcp" } },
      fetch: async (url, init) => handler(new Request(url, init)),
    });
    const client = new Client({ name: "clean-unknown-runtime", version: "1.0.0" });
    await client.connect(transport);
    try {
      const page = await client.callTool({ name: "tasq_commitment_list", arguments: { limit: 5 } });
      expect(page.isError).not.toBe(true);
      expect(page.structuredContent).toMatchObject({
        items: [{ id: "clean-work", title: "Coordinate one clean runtime" }],
      });
      expect(opens).toBe(1);

      await authority.revokeGrant({
        workspaceId: WORKSPACE,
        grantId: "runtime-grant",
        expectedGrantRevision: 1,
        context: context(revision),
      });
      const denied = await client.callTool({ name: "tasq_commitment_list", arguments: { limit: 5 } });
      expect(denied.isError).toBe(true);
      expect(denied.structuredContent).toMatchObject({ code: "access_denied" });
      expect(opens).toBe(1);
    } finally {
      await client.close();
      await authority.close();
    }
  });
});

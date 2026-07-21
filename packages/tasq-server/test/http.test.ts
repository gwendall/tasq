import { afterEach, beforeEach, describe, expect, test } from "bun:test";
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
  CredentialVerificationError,
  IsolatedWorkspaceRouter,
  createHostedReadHandler,
  openAuthorityStore,
  type AuthorityMutationContext,
  type AuthorityStore,
  type HostedReadWorkspace,
} from "../src/index.js";

const NOW = 1_800_000_000_000;
const RESOURCE = "https://server.tasq.example/";
const ISSUER = "https://issuer.example/";
const sha = (c: string) => `sha256:${c.repeat(64)}`;
let root = "";
let store: AuthorityStore;
let revision = 0;
let operation = 0;
let opens = 0;
let verifierCalls = 0;
let lastVerifierTime = 0;
const rootClock = { calls: 0, now() { this.calls += 1; return NOW; } };

function action(name: keyof typeof ACTION_URIS): ActionDefinition {
  const found = getRegisteredAction(ACTION_URIS[name]);
  if (!found) throw new Error(`missing ${name}`);
  return found;
}

const identityOf = (value: ActionDefinition) => ({
  uri: value.uri, version: value.version, implementationDigest: value.implementationDigest,
});

function context(expected: number | null): AuthorityMutationContext {
  operation += 1;
  return {
    operationId: `http-operation-${operation}`,
    actorPrincipalId: expected === null ? "local-operator" : "admin",
    reason: "HTTP fixture",
    expectedAuthorityRevision: expected,
  };
}

const readActions = [action("workspace.read"), action("commitment.read")];
const verifiedIdentity: VerifiedIdentity = {
  contractVersion: "tasq.verified-identity.v1",
  issuer: ISSUER,
  subject: "subject-reader",
  audience: [RESOURCE],
  authenticationMethod: "oauth_jwt_access_token",
  authenticatedAt: NOW - 1_000,
  notBefore: NOW - 1_000,
  expiresAt: NOW + 10_000,
  clientId: "reader-client",
  actor: null,
  credentialBinding: { kind: "none" },
  tokenIdDigest: sha("1"),
  issuerConfigurationDigest: sha("2"),
  credentialKeyDigest: sha("3"),
  actionUpperBound: readActions.map(identityOf).sort((a, b) => a.uri.localeCompare(b.uri)),
};

const workspace: HostedReadWorkspace = {
  workspaceId: "robotics/team-a",
  async getCommitment(id) {
    if (id === "missing") return null;
    return {
      id,
      workspaceId: "robotics/team-a",
      title: "Calibrate arm",
      status: "open",
      revision: 2,
      createdAt: NOW - 10_000,
      updatedAt: NOW - 100,
    };
  },
  async listCommitments({ cursor, limit }) {
    return {
      items: [{
        id: "commitment-one",
        workspaceId: "robotics/team-a",
        title: `Page ${cursor ?? "first"}`,
        status: "open",
        revision: 2,
        createdAt: NOW - 10_000,
        updatedAt: NOW - 100,
      }].slice(0, limit),
      nextCursor: "opaque-next",
    };
  },
  async listEventMetadata() {
    return {
      items: [{
        id: "event-one",
        sequence: 7,
        entityType: "task",
        entityId: "commitment-one",
        eventType: "task.updated",
        actorPrincipalId: "reader",
        createdAt: NOW - 50,
      }],
      nextSequence: 7,
    };
  },
};

async function setup() {
  root = mkdtempSync(join(tmpdir(), "tasq-hosted-http-"));
  rootClock.calls = 0;
  operation = 0;
  revision = 0;
  opens = 0;
  verifierCalls = 0;
  store = await openAuthorityStore({ url: `file:${join(root, "authority.sqlite")}`, clock: rootClock });
  await store.provisionHostTenant({ id: "host", context: context(null) });
  await store.provisionWorkspace({
    workspaceId: "robotics/team-a", hostTenantId: "host", storageBindingId: "binding-alpha", context: context(null),
  });
  await store.registerPrincipal({
    principal: { id: "admin", workspaceId: "robotics/team-a", kind: "human", status: "enabled", revision: 1 },
    context: context(revision++),
  });
  await store.registerPrincipal({
    principal: { id: "reader", workspaceId: "robotics/team-a", kind: "human", status: "enabled", revision: 1 },
    context: context(revision++),
  });
  await store.bindSubject({
    binding: {
      contractVersion: "tasq.subject-binding.v1",
      id: "binding-reader",
      workspaceId: "robotics/team-a",
      principalId: "reader",
      issuer: ISSUER,
      subject: "subject-reader",
      method: "oidc",
      status: "enabled",
      revision: 1,
      createdAt: NOW - 2_000,
      disabledAt: null,
      replacedByBindingId: null,
    },
    context: context(revision++),
  });
  const permission = definePermissionSet({ uri: "urn:test:permission:hosted-read", version: 1, actions: readActions });
  await store.activatePermissionSet({ workspaceId: "robotics/team-a", permissionSet: permission, context: context(revision++) });
  await store.createGrant({
    grant: {
      contractVersion: "tasq.authorization-grant.v1",
      id: "grant-reader",
      workspaceId: "robotics/team-a",
      grantorPrincipalId: "admin",
      granteePrincipalId: "reader",
      permissionSet: {
        uri: permission.uri, version: permission.version, implementationDigest: permission.implementationDigest,
      },
      scope: { kind: "workspace" },
      notBefore: NOW,
      expiresAt: NOW + 5_000,
      status: "active",
      revision: 1,
    },
    context: context(revision++),
  });
}

function handler(input: {
  invalidToken?: boolean;
  verificationUnavailable?: boolean;
  identity?: VerifiedIdentity;
  routedWorkspace?: HostedReadWorkspace;
} = {}) {
  const router = new IsolatedWorkspaceRouter(store, [{
    workspaceId: "robotics/team-a",
    storageBindingId: "binding-alpha",
    open: async () => { opens += 1; return input.routedWorkspace ?? workspace; },
  }]);
  return createHostedReadHandler({
    protectedResource: RESOURCE,
    authorizationServers: [ISSUER],
    resourceDocumentation: "https://docs.tasq.example/server",
    dpopSigningAlgorithms: ["ES256"],
    clock: rootClock,
    router,
    requestIdFactory: () => "generated-request",
    verifier: {
      async verify(request, clock) {
        verifierCalls += 1;
        lastVerifierTime = clock.now();
        expect(request.expectedAudience).toBe(RESOURCE);
        if (input.verificationUnavailable) throw new CredentialVerificationError("temporarily_unavailable");
        if (input.invalidToken || request.authorization !== "Bearer valid-token") {
          throw new CredentialVerificationError("invalid_token");
        }
        return input.identity ?? verifiedIdentity;
      },
    },
  });
}

function request(path: string, init: RequestInit = {}, id = "request-one") {
  return new Request(new URL(path, RESOURCE), {
    ...init,
    headers: { "x-tasq-request-id": id, ...(init.headers ?? {}) },
  });
}

beforeEach(setup);
afterEach(async () => {
  await store.close();
  rmSync(root, { recursive: true, force: true });
});

describe("TQ-803 protected resource discovery and authentication", () => {
  test("publishes exact RFC 9728 metadata without workspace state", async () => {
    const before = rootClock.calls;
    const response = await handler()(request("/.well-known/oauth-protected-resource"));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(response.headers.get("cache-control")).toBe("public, max-age=300");
    expect(await response.json()).toEqual({
      resource: RESOURCE,
      authorization_servers: [ISSUER],
      bearer_methods_supported: ["header"],
      resource_name: "Tasq hosted read API",
      scopes_supported: [ACTION_URIS["commitment.read"], ACTION_URIS["workspace.read"]].sort(),
      resource_documentation: "https://docs.tasq.example/server",
      dpop_signing_alg_values_supported: ["ES256"],
    });
    expect(rootClock.calls).toBe(before + 1);
    expect(verifierCalls).toBe(0);
    expect(opens).toBe(0);
  });

  test("returns a typed RFC challenge before revealing workspace state", async () => {
    const response = await handler()(request("/v1/workspaces/robotics%2Fteam-a/commitments"));
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe(
      'Bearer resource_metadata="https://server.tasq.example/.well-known/oauth-protected-resource"',
    );
    expect(await response.json()).toMatchObject({ code: "authentication_required", decisionId: null });
    expect(opens).toBe(0);
  });

  test("maps invalid credentials to the same bounded challenge", async () => {
    const response = await handler({ invalidToken: true })(request("/v1/workspaces/robotics%2Fteam-a/commitments", {
      headers: { authorization: "Bearer stolen" },
    }));
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: "invalid_token", decisionId: null });
    expect(response.headers.get("www-authenticate")).toBe(
      'Bearer error="invalid_token", resource_metadata="https://server.tasq.example/.well-known/oauth-protected-resource"',
    );
    expect(opens).toBe(0);
  });

  test("separates verifier outages from invalid credentials without touching authority", async () => {
    const response = await handler({ verificationUnavailable: true })(request(
      "/v1/workspaces/robotics%2Fteam-a/commitments",
      { headers: { authorization: "Bearer valid-token" } },
    ));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "authentication_unavailable", decisionId: null });
    expect(response.headers.get("www-authenticate")).toBeNull();
    expect(opens).toBe(0);
  });
});

describe("TQ-803 guarded read-only REST", () => {
  test("uses one request-wide clock snapshot through verifier, authority and response", async () => {
    const before = rootClock.calls;
    const response = await handler()(request("/v1/workspaces/robotics%2Fteam-a/commitments?limit=10", {
      headers: { authorization: "Bearer valid-token" },
    }, "read-list"));
    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, unknown>;
    expect(body).toMatchObject({
      contractVersion: "tasq.hosted-commitment-page.v1",
      requestId: "read-list",
      evaluatedAt: NOW,
      nextCursor: "opaque-next",
    });
    expect(body["decisionId"]).toMatch(/^sha256:/);
    expect(rootClock.calls).toBe(before + 1);
    expect(lastVerifierTime).toBe(NOW);
    expect(opens).toBe(1);
  });

  test("reads one exact commitment and bounded redacted event metadata", async () => {
    const get = await handler()(request("/v1/workspaces/robotics%2Fteam-a/commitments/commitment-one", {
      headers: { authorization: "Bearer valid-token" },
    }, "read-one"));
    expect(get.status).toBe(200);
    expect(await get.json()).toMatchObject({ item: { id: "commitment-one", workspaceId: "robotics/team-a" } });

    const events = await handler()(request("/v1/workspaces/robotics%2Fteam-a/events?after=6&limit=1", {
      headers: { authorization: "Bearer valid-token" },
    }, "read-events"));
    expect(events.status).toBe(200);
    const eventBody = await events.json() as { items: Array<Record<string, unknown>> };
    expect(eventBody.items[0]).toEqual({
      id: "event-one", sequence: 7, entityType: "task", entityId: "commitment-one",
      eventType: "task.updated", actorPrincipalId: "reader", createdAt: NOW - 50,
    });
    expect(JSON.stringify(eventBody)).not.toContain("payload");
  });

  test("denies another workspace without invoking any workspace opener", async () => {
    const response = await handler()(request("/v1/workspaces/beta/commitments", {
      headers: { authorization: "Bearer valid-token" },
    }, "foreign-probe"));
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "access_denied", decisionId: expect.stringMatching(/^sha256:/) });
    expect(opens).toBe(0);
  });

  test("does not confuse identical subjects from different issuers", async () => {
    const response = await handler({
      identity: { ...verifiedIdentity, issuer: "https://other-issuer.example/" },
    })(request("/v1/workspaces/robotics%2Fteam-a/commitments", {
      headers: { authorization: "Bearer valid-token" },
    }, "wrong-issuer"));
    expect(response.status).toBe(403);
    expect(opens).toBe(0);
  });

  test("has no mutation method and bounds all query inputs", async () => {
    const post = await handler()(request("/v1/workspaces/robotics%2Fteam-a/commitments", { method: "POST" }, "post"));
    expect(post.status).toBe(405);
    expect(post.headers.get("allow")).toBe("GET");
    expect(verifierCalls).toBe(0);

    const invalid = await handler()(request("/v1/workspaces/robotics%2Fteam-a/commitments?limit=1000", {
      headers: { authorization: "Bearer valid-token" },
    }, "bad-limit"));
    expect(invalid.status).toBe(400);
    expect(verifierCalls).toBe(0);
    expect(opens).toBe(0);

    const queryToken = await handler()(request(
      "/v1/workspaces/robotics%2Fteam-a/commitments?access_token=leaked",
    ));
    expect(queryToken.status).toBe(400);
    const duplicate = await handler()(request(
      "/v1/workspaces/robotics%2Fteam-a/events?limit=1&limit=2",
      { headers: { authorization: "Bearer valid-token" } },
    ));
    expect(duplicate.status).toBe(400);
    const invalidRequestId = await handler()(request(
      "/v1/workspaces/robotics%2Fteam-a/events",
      { headers: { authorization: "Bearer valid-token" } },
      "",
    ));
    expect(invalidRequestId.status).toBe(400);
    expect(await invalidRequestId.json()).toMatchObject({ requestId: "generated-request", code: "invalid_request_id" });
    const oversizedCredential = await handler()(request(
      "/v1/workspaces/robotics%2Fteam-a/events",
      { headers: { authorization: `Bearer ${"x".repeat(33_000)}` } },
    ));
    expect(oversizedCredential.status).toBe(400);
    expect(verifierCalls).toBe(0);
    expect(opens).toBe(0);
  });

  test("observes grant revocation on the very next HTTP request", async () => {
    const before = await handler()(request("/v1/workspaces/robotics%2Fteam-a/commitments", {
      headers: { authorization: "Bearer valid-token" },
    }, "before-revoke"));
    expect(before.status).toBe(200);
    expect(opens).toBe(1);

    await store.revokeGrant({
      workspaceId: "robotics/team-a",
      grantId: "grant-reader",
      expectedGrantRevision: 1,
      context: context(revision),
    });
    const after = await handler()(request("/v1/workspaces/robotics%2Fteam-a/commitments", {
      headers: { authorization: "Bearer valid-token" },
    }, "after-revoke"));
    expect(after.status).toBe(403);
    expect(opens).toBe(1);
  });

  test("fails closed when a host reader violates its strict output contract", async () => {
    const corrupt: HostedReadWorkspace = {
      ...workspace,
      async listCommitments() {
        return { items: [{ ...await workspace.getCommitment("one"), workspaceId: "beta" } as never], nextCursor: null };
      },
    };
    const response = await handler({ routedWorkspace: corrupt })(request("/v1/workspaces/robotics%2Fteam-a/commitments", {
      headers: { authorization: "Bearer valid-token" },
    }, "corrupt-output"));
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ code: "read_contract_violation" });

    const wrongExact: HostedReadWorkspace = {
      ...workspace,
      async getCommitment() { return workspace.getCommitment("different-id"); },
    };
    const exact = await handler({ routedWorkspace: wrongExact })(request(
      "/v1/workspaces/robotics%2Fteam-a/commitments/requested-id",
      { headers: { authorization: "Bearer valid-token" } },
      "wrong-exact",
    ));
    expect(exact.status).toBe(500);

    const tooMany: HostedReadWorkspace = {
      ...workspace,
      async listCommitments() {
        const item = await workspace.getCommitment("one");
        return { items: [item!, { ...item!, id: "two" }], nextCursor: "next" };
      },
    };
    const page = await handler({ routedWorkspace: tooMany })(request(
      "/v1/workspaces/robotics%2Fteam-a/commitments?limit=1",
      { headers: { authorization: "Bearer valid-token" } },
      "too-many",
    ));
    expect(page.status).toBe(500);

    const unordered: HostedReadWorkspace = {
      ...workspace,
      async listEventMetadata() {
        const base = (await workspace.listEventMetadata({ afterSequence: 0, limit: 2 })).items[0]!;
        return { items: [base, { ...base, id: "event-two", sequence: 6 }], nextSequence: 6 };
      },
    };
    const events = await handler({ routedWorkspace: unordered })(request(
      "/v1/workspaces/robotics%2Fteam-a/events?limit=2",
      { headers: { authorization: "Bearer valid-token" } },
      "unordered-events",
    ));
    expect(events.status).toBe(500);
  });
});

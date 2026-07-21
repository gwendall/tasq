/** TQ-803 — clean-room authenticated read-only REST eval. */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  ACTION_URIS,
  definePermissionSet,
  getRegisteredAction,
  type ActionDefinition,
  type VerifiedIdentity,
} from "@tasq-internal/authority";
import {
  HOSTED_READ_HTTP_IMPLEMENTATION_DIGEST,
  IsolatedWorkspaceRouter,
  createHostedReadHandler,
  openAuthorityStore,
  type AuthorityMutationContext,
  type AuthorityStore,
  type HostedReadWorkspace,
} from "@tasq-internal/server";

const NOW = 1_810_000_000_000;
const RESOURCE = "https://server.clean-room.example/tasq";
const ISSUER = "https://identity.clean-room.example/";
const WORKSPACE = "robotics/team-a";
const sha = (character: string) => `sha256:${character.repeat(64)}`;
const roots: string[] = [];
let operation = 0;

const certificate = JSON.parse(readFileSync(
  resolve(import.meta.dir, "../..", "TQ-803_READ_REST_CERTIFICATION.json"),
  "utf8",
)) as {
  status: string;
  implementationDigest: string;
  implementedSurface: string;
  deployableServer: boolean;
  tq803Complete: boolean;
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function action(name: "workspace.read" | "commitment.read"): ActionDefinition {
  const found = getRegisteredAction(ACTION_URIS[name]);
  if (!found) throw new Error(`missing action ${name}`);
  return found;
}

const actionIdentity = (value: ActionDefinition) => ({
  uri: value.uri,
  version: value.version,
  implementationDigest: value.implementationDigest,
});

function context(revision: number | null): AuthorityMutationContext {
  operation += 1;
  return {
    operationId: `rest-clean-room-${operation}`,
    actorPrincipalId: revision === null ? "local-operator" : "admin",
    reason: "clean-room REST setup",
    expectedAuthorityRevision: revision,
  };
}

async function configureAuthority(store: AuthorityStore): Promise<number> {
  operation = 0;
  await store.provisionHostTenant({ id: "clean-host", context: context(null) });
  await store.provisionWorkspace({
    workspaceId: WORKSPACE,
    hostTenantId: "clean-host",
    storageBindingId: "opaque-ledger-slot-9",
    context: context(null),
  });
  let revision = 0;
  await store.registerPrincipal({
    principal: { id: "admin", workspaceId: WORKSPACE, kind: "human", status: "enabled", revision: 1 },
    context: context(revision++),
  });
  await store.registerPrincipal({
    principal: { id: "reader", workspaceId: WORKSPACE, kind: "agent", status: "enabled", revision: 1 },
    context: context(revision++),
  });
  await store.bindSubject({
    binding: {
      contractVersion: "tasq.subject-binding.v1",
      id: "reader-binding",
      workspaceId: WORKSPACE,
      principalId: "reader",
      issuer: ISSUER,
      subject: "clean-agent",
      method: "oidc",
      status: "enabled",
      revision: 1,
      createdAt: NOW - 1_000,
      disabledAt: null,
      replacedByBindingId: null,
    },
    context: context(revision++),
  });
  const actions = [action("workspace.read"), action("commitment.read")];
  const permission = definePermissionSet({ uri: "urn:clean:rest-reader", version: 1, actions });
  await store.activatePermissionSet({ workspaceId: WORKSPACE, permissionSet: permission, context: context(revision++) });
  await store.createGrant({
    grant: {
      contractVersion: "tasq.authorization-grant.v1",
      id: "reader-grant",
      workspaceId: WORKSPACE,
      grantorPrincipalId: "admin",
      granteePrincipalId: "reader",
      permissionSet: {
        uri: permission.uri,
        version: permission.version,
        implementationDigest: permission.implementationDigest,
      },
      scope: { kind: "workspace" },
      notBefore: NOW,
      expiresAt: NOW + 60_000,
      status: "active",
      revision: 1,
    },
    context: context(revision++),
  });
  return revision;
}

function identity(): VerifiedIdentity {
  return {
    contractVersion: "tasq.verified-identity.v1",
    issuer: ISSUER,
    subject: "clean-agent",
    audience: [RESOURCE],
    authenticationMethod: "oauth_jwt_access_token",
    authenticatedAt: NOW - 100,
    notBefore: NOW - 100,
    expiresAt: NOW + 30_000,
    clientId: "clean-client",
    actor: null,
    credentialBinding: { kind: "none" },
    tokenIdDigest: sha("1"),
    issuerConfigurationDigest: sha("2"),
    credentialKeyDigest: sha("3"),
    actionUpperBound: [action("workspace.read"), action("commitment.read")]
      .map(actionIdentity).sort((left, right) => left.uri.localeCompare(right.uri)),
  };
}

describe("TQ-803 clean-room hosted read REST", () => {
  test("binds the certificate to the exported HTTP contract", () => {
    expect(certificate).toEqual(expect.objectContaining({
      status: "certified",
      implementationDigest: HOSTED_READ_HTTP_IMPLEMENTATION_DIGEST,
      implementedSurface: "host_integrated_fetch_handler",
      deployableServer: false,
      tq803Complete: true,
    }));
  });

  test("discovers, authenticates, isolates, reads and immediately observes revocation", async () => {
    const root = mkdtempSync(join(tmpdir(), "tasq-read-rest-clean-"));
    roots.push(root);
    const clock = { calls: 0, now() { this.calls += 1; return NOW; } };
    const store = await openAuthorityStore({ url: `file:${join(root, "authority.sqlite")}`, clock });
    const revision = await configureAuthority(store);
    const counters = { verify: 0, open: 0 };
    const workspace: HostedReadWorkspace = {
      workspaceId: WORKSPACE,
      async getCommitment(id) {
        return { id, workspaceId: WORKSPACE, title: "Calibrate arm", status: "open", revision: 1,
          createdAt: NOW - 500, updatedAt: NOW - 50 };
      },
      async listCommitments() { return { items: [], nextCursor: null }; },
      async listEventMetadata() {
        return { items: [{ id: "event-1", sequence: 4, entityType: "commitment", entityId: "arm",
          eventType: "commitment.updated", actorPrincipalId: "reader", createdAt: NOW - 10 }], nextSequence: 4 };
      },
    };
    const router = new IsolatedWorkspaceRouter(store, [{
      workspaceId: WORKSPACE,
      storageBindingId: "opaque-ledger-slot-9",
      open: async () => { counters.open += 1; return workspace; },
    }]);
    let requestNumber = 0;
    const handler = createHostedReadHandler({
      protectedResource: RESOURCE,
      authorizationServers: [ISSUER],
      clock,
      router,
      requestIdFactory: () => `clean-request-${++requestNumber}`,
      verifier: {
        async verify(input, requestClock) {
          counters.verify += 1;
          expect(input).toMatchObject({ expectedAudience: RESOURCE, method: "GET", authorization: "Bearer clean" });
          expect(requestClock.now()).toBe(NOW);
          return identity();
        },
      },
    });
    const send = (path: string, authenticated = false) => handler(new Request(new URL(path, RESOURCE), {
      headers: authenticated ? { authorization: "Bearer clean" } : {},
    }));

    const metadata = await send("/.well-known/oauth-protected-resource/tasq");
    expect(metadata.status).toBe(200);
    expect(await metadata.json()).toMatchObject({ resource: RESOURCE, authorization_servers: [ISSUER] });
    expect(counters).toEqual({ verify: 0, open: 0 });

    const malformed = await send("/tasq/v1/workspaces/robotics%2Fteam-a/events?limit=999", true);
    expect(malformed.status).toBe(400);
    expect(counters).toEqual({ verify: 0, open: 0 });

    const events = await send("/tasq/v1/workspaces/robotics%2Fteam-a/events?after=0&limit=5", true);
    expect(events.status).toBe(200);
    const eventBody = await events.json();
    expect(eventBody).toMatchObject({ contractVersion: "tasq.hosted-event-metadata-page.v1", nextSequence: 4 });
    expect(JSON.stringify(eventBody)).not.toContain("payload");
    expect(counters).toEqual({ verify: 1, open: 1 });

    const probe = await send("/tasq/v1/workspaces/robotics%2Fteam-b/events", true);
    expect(probe.status).toBe(403);
    expect(counters).toEqual({ verify: 2, open: 1 });

    await store.revokeGrant({
      workspaceId: WORKSPACE,
      grantId: "reader-grant",
      expectedGrantRevision: 1,
      context: context(revision),
    });
    const revoked = await send("/tasq/v1/workspaces/robotics%2Fteam-a/events", true);
    expect(revoked.status).toBe(403);
    expect(counters).toEqual({ verify: 3, open: 1 });
    expect(clock.calls).toBeGreaterThan(0);
    await store.close();
  });
});

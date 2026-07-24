import { afterEach, beforeEach, describe, expect, test } from "bun:test";
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
  CredentialVerificationError,
  createRemoteEnrollmentAuthority,
  createRemoteEnrollmentHandler,
  openAuthorityStore,
  type AuthorityMutationContext,
  type AuthorityStore,
} from "../src/index.js";

const NOW = 1_800_000_000_000;
const WORKSPACE = "robotics/team-a";
const ISSUER = "https://issuer.example/";
const AUDIENCE = "https://server.tasq.example/";
let root = "";
let store: AuthorityStore;
let revision = 0;
let operation = 0;
let now = NOW;

const clock = { now: () => now };

function action(name: keyof typeof ACTION_URIS): ActionDefinition {
  const value = getRegisteredAction(ACTION_URIS[name]);
  if (!value) throw new Error(`missing action ${name}`);
  return value;
}

function identity(value: ActionDefinition) {
  return { uri: value.uri, version: value.version, implementationDigest: value.implementationDigest };
}

function context(expectedAuthorityRevision: number | null): AuthorityMutationContext {
  operation += 1;
  return {
    operationId: `operation-${operation}`,
    actorPrincipalId: expectedAuthorityRevision === null ? "operator" : "admin",
    reason: "enrollment fixture",
    expectedAuthorityRevision,
  };
}

async function setup() {
  root = mkdtempSync(join(tmpdir(), "tasq-enrollment-"));
  revision = 0;
  operation = 0;
  now = NOW;
  store = await openAuthorityStore({ url: `file:${join(root, "authority.sqlite")}`, clock });
  await store.provisionHostTenant({ id: "host", context: context(null) });
  await store.provisionWorkspace({
    workspaceId: WORKSPACE,
    hostTenantId: "host",
    storageBindingId: "workspace-slot",
    context: context(null),
  });
  await store.registerPrincipal({
    principal: { id: "admin", workspaceId: WORKSPACE, kind: "human", status: "enabled", revision: 1 },
    context: context(revision++),
  });
  await store.registerPrincipal({
    principal: { id: "agent-one", workspaceId: WORKSPACE, kind: "agent", status: "enabled", revision: 1 },
    context: context(revision++),
  });
  await store.bindSubject({
    binding: {
      contractVersion: "tasq.subject-binding.v1",
      id: "agent-binding",
      workspaceId: WORKSPACE,
      principalId: "agent-one",
      issuer: ISSUER,
      subject: "agent-subject",
      method: "oauth_introspection",
      status: "enabled",
      revision: 1,
      createdAt: NOW,
      disabledAt: null,
      replacedByBindingId: null,
    },
    context: context(revision++),
  });
  const permission = definePermissionSet({
    uri: "urn:test:permission:remote-agent",
    version: 1,
    actions: [action("workspace.read"), action("claim.coordinate")],
  });
  await store.activatePermissionSet({
    workspaceId: WORKSPACE,
    permissionSet: permission,
    context: context(revision++),
  });
  await store.createGrant({
    grant: {
      contractVersion: "tasq.authorization-grant.v1",
      id: "agent-grant",
      workspaceId: WORKSPACE,
      grantorPrincipalId: "admin",
      granteePrincipalId: "agent-one",
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

beforeEach(setup);
afterEach(async () => {
  await store.close();
  rmSync(root, { recursive: true, force: true });
});

describe("TQ-809 one-use remote enrollment", () => {
  test("atomically exchanges one bounded bootstrap secret for one revocable credential", async () => {
    let secret = 0;
    let id = 0;
    const authority = createRemoteEnrollmentAuthority({
      store,
      clock,
      pepper: new Uint8Array(32).fill(7),
      issuer: ISSUER,
      audience: AUDIENCE,
      randomSecret: () => `secret-${++secret}`.padEnd(40, "x"),
      randomId: () => `id-${++id}`,
    });
    const created = await authority.create({
      workspaceId: WORKSPACE,
      principalId: "agent-one",
      subject: "agent-subject",
      clientKind: "workload_agent",
      actionUpperBound: [identity(action("claim.coordinate")), identity(action("workspace.read"))],
      enrollmentExpiresAt: NOW + 600_000,
      accessExpiresAt: NOW + 3_600_000,
      context: context(revision++),
    });
    expect(created.enrollmentToken).toStartWith("tasq_enroll_");

    const handler = createRemoteEnrollmentHandler({
      endpoint: AUDIENCE,
      authority,
      clock,
      requestIdFactory: () => "redeem-request",
    });
    const redeem = () => handler(new Request(
      "https://server.tasq.example/v1/workspaces/robotics%2Fteam-a/enrollments/redeem",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contractVersion: "tasq.remote-enrollment.v1",
          enrollmentToken: created.enrollmentToken,
        }),
      },
    ));
    const response = await redeem();
    expect(response.status).toBe(201);
    const body = await response.json() as {
      credentialId: string;
      accessToken: string;
      expiresAt: number;
    };
    expect(body.accessToken).toStartWith("tasq_access_");
    expect(body.expiresAt).toBe(NOW + 3_600_000);
    const second = await redeem();
    expect(second.status).toBe(409);
    expect(await second.json()).toMatchObject({ code: "enrollment_consumed" });

    const verified = await authority.verifier.verify({
      authorization: `Bearer ${body.accessToken}`,
      dpopProof: null,
      method: "GET",
      requestUrl: `${AUDIENCE}v1/workspaces/robotics%2Fteam-a/commitments`,
      expectedAudience: AUDIENCE,
    }, clock);
    expect(verified).toMatchObject({
      issuer: ISSUER,
      subject: "agent-subject",
      clientId: body.credentialId,
      authenticationMethod: "oauth_introspection",
    });
    expect(verified.actionUpperBound.map(({ uri }) => uri)).toEqual([
      ACTION_URIS["claim.coordinate"],
      ACTION_URIS["workspace.read"],
    ].sort());

    await store.revokeAccessCredential({
      workspaceId: WORKSPACE,
      credentialId: body.credentialId,
      expectedCredentialRevision: 1,
      context: context(revision++),
    });
    await expect(authority.verifier.verify({
      authorization: `Bearer ${body.accessToken}`,
      dpopProof: null,
      method: "GET",
      requestUrl: AUDIENCE,
      expectedAudience: AUDIENCE,
    }, clock)).rejects.toEqual(expect.objectContaining({
      name: "CredentialVerificationError",
      code: "invalid_token",
    }));
  });

  test("fails expired and revoked bootstrap tokens closed without creating credentials", async () => {
    let secret = 0;
    let id = 0;
    const authority = createRemoteEnrollmentAuthority({
      store,
      clock,
      pepper: new Uint8Array(32).fill(9),
      issuer: ISSUER,
      audience: AUDIENCE,
      randomSecret: () => `secret-${++secret}`.padEnd(40, "y"),
      randomId: () => `id-${++id}`,
    });
    const expired = await authority.create({
      workspaceId: WORKSPACE,
      principalId: "agent-one",
      subject: "agent-subject",
      clientKind: "workload_agent",
      actionUpperBound: [identity(action("workspace.read"))],
      enrollmentExpiresAt: NOW + 1,
      accessExpiresAt: NOW + 10_000,
      context: context(revision++),
    });
    now = NOW + 1;
    await expect(authority.redeem({
      workspaceId: WORKSPACE,
      enrollmentToken: expired.enrollmentToken,
    })).rejects.toEqual(expect.objectContaining({ code: "expired" }));

    now = NOW + 2;
    const revoked = await authority.create({
      workspaceId: WORKSPACE,
      principalId: "agent-one",
      subject: "agent-subject",
      clientKind: "human_device",
      actionUpperBound: [identity(action("workspace.read"))],
      enrollmentExpiresAt: NOW + 10_000,
      accessExpiresAt: NOW + 20_000,
      context: context(revision++),
    });
    await store.revokeEnrollment({
      workspaceId: WORKSPACE,
      enrollmentId: revoked.enrollmentId,
      context: context(revision++),
    });
    await expect(authority.redeem({
      workspaceId: WORKSPACE,
      enrollmentToken: revoked.enrollmentToken,
    })).rejects.toEqual(expect.objectContaining({ code: "revoked" }));

    const raced = await authority.create({
      workspaceId: WORKSPACE,
      principalId: "agent-one",
      subject: "agent-subject",
      clientKind: "workload_agent",
      actionUpperBound: [identity(action("workspace.read"))],
      enrollmentExpiresAt: NOW + 10_000,
      accessExpiresAt: NOW + 20_000,
      context: context(revision++),
    });
    const contenders = await Promise.allSettled([
      authority.redeem({ workspaceId: WORKSPACE, enrollmentToken: raced.enrollmentToken }),
      authority.redeem({ workspaceId: WORKSPACE, enrollmentToken: raced.enrollmentToken }),
    ]);
    expect(contenders.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(contenders.filter(({ status }) => status === "rejected")).toHaveLength(1);
    const rejected = contenders.find(({ status }) => status === "rejected");
    expect(rejected && rejected.status === "rejected" ? rejected.reason : null)
      .toEqual(expect.objectContaining({ code: "consumed" }));
  });

  test("never accepts actor text, wrong audience or malformed bearer input as authentication", async () => {
    const authority = createRemoteEnrollmentAuthority({
      store,
      clock,
      pepper: new Uint8Array(32).fill(3),
      issuer: ISSUER,
      audience: AUDIENCE,
    });
    for (const input of [
      { authorization: "Bearer actor:agent-one", expectedAudience: AUDIENCE },
      { authorization: "Bearer tasq_access_fake", expectedAudience: "https://other.example/" },
    ]) {
      await expect(authority.verifier.verify({
        ...input,
        dpopProof: null,
        method: "POST",
        requestUrl: AUDIENCE,
      }, clock)).rejects.toBeInstanceOf(CredentialVerificationError);
    }
  });
});

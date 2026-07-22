/** TQ-801 — clean-room, transport-neutral hosted authority evals. */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  ACTION_REGISTRY,
  ACTION_URIS,
  AUTHORIZATION_POLICY_IMPLEMENTATION_DIGEST,
  Delegation,
  VerifiedIdentity,
  definePermissionSet,
  evaluateAuthorization,
  getRegisteredAction,
  type ActionDefinition,
  type AuthorityEligibility,
  type AuthorityPrincipal,
  type AuthorizationGrant,
  type SubjectBinding,
} from "@tasq-internal/authority";

const T = 1_800_000_000_000;
const AUDIENCE = "https://server.tasq.example/";
const sha = (c: string) => `sha256:${c.repeat(64)}`;
const clock = (now: number) => ({ now: () => now });
const certificate = JSON.parse(readFileSync(
  resolve(import.meta.dir, "../..", "docs/contracts/TQ-801_AUTHORITY_CERTIFICATION.json"),
  "utf8",
)) as {
  status: string;
  policyImplementationDigest: string;
  registeredActionCount: number;
  implementedRemoteSurfaces: string[];
  tq801Complete: boolean;
};

function action(name: keyof typeof ACTION_URIS): ActionDefinition {
  const value = getRegisteredAction(ACTION_URIS[name]);
  if (!value) throw new Error(`unknown action fixture ${name}`);
  return value;
}

const identityOf = ({ uri, version, implementationDigest }: ActionDefinition) => ({
  uri, version, implementationDigest,
});

function makeIdentity(input: {
  subject: string;
  issuer?: string;
  actions: ActionDefinition[];
  actor?: { issuer: string; subject: string } | null;
  binding?:
    | { kind: "none" }
    | { kind: "dpop"; keyThumbprintDigest: string }
    | { kind: "mtls_spiffe"; identityUri: string; certificateThumbprintDigest: string };
  method?: "oauth_jwt_access_token" | "oauth_introspection" | "spiffe_svid";
}) {
  return VerifiedIdentity.parse({
    contractVersion: "tasq.verified-identity.v1",
    issuer: input.issuer ?? "https://issuer-one.example/",
    subject: input.subject,
    audience: [AUDIENCE],
    authenticationMethod: input.method ?? "oauth_jwt_access_token",
    authenticatedAt: T - 1_000,
    notBefore: T - 1_000,
    expiresAt: T + 10_000,
    clientId: "eval-client",
    actor: input.actor ?? null,
    credentialBinding: input.binding ?? { kind: "none" },
    tokenIdDigest: sha("1"),
    issuerConfigurationDigest: sha("2"),
    credentialKeyDigest: sha("3"),
    actionUpperBound: input.actions.map(identityOf).sort((a, b) => a.uri.localeCompare(b.uri)),
  });
}

function principal(id: string, kind: AuthorityPrincipal["kind"]): AuthorityPrincipal {
  return { id, workspaceId: "alpha", kind, status: "enabled", revision: 1 };
}

function binding(id: string, principalId: string, issuer: string, subject: string): SubjectBinding {
  return {
    contractVersion: "tasq.subject-binding.v1",
    id,
    workspaceId: "alpha",
    principalId,
    issuer,
    subject,
    method: "oidc",
    status: "enabled",
    revision: 1,
    createdAt: T - 2_000,
    disabledAt: null,
    replacedByBindingId: null,
  };
}

function grant(id: string, grantee: string, permission: ReturnType<typeof definePermissionSet>): AuthorizationGrant {
  return {
    contractVersion: "tasq.authorization-grant.v1",
    id,
    workspaceId: "alpha",
    grantorPrincipalId: "admin",
    granteePrincipalId: grantee,
    permissionSet: {
      uri: permission.uri,
      version: permission.version,
      implementationDigest: permission.implementationDigest,
    },
    scope: { kind: "workspace" },
    notBefore: T,
    expiresAt: T + 5_000,
    status: "active",
    revision: 1,
  };
}

function directRequest(input: {
  action: ActionDefinition;
  subject?: string;
  issuer?: string;
  principalId?: string;
  principalKind?: AuthorityPrincipal["kind"];
  credentialBinding?: Parameters<typeof makeIdentity>[0]["binding"];
  authenticationMethod?: Parameters<typeof makeIdentity>[0]["method"];
  eligibility?: AuthorityEligibility;
}) {
  const subject = input.subject ?? "subject-human";
  const issuer = input.issuer ?? "https://issuer-one.example/";
  const principalId = input.principalId ?? "human";
  const permission = definePermissionSet({
    uri: `urn:eval:permission:${input.action.uri.split(":").at(-1)}`,
    version: 1,
    actions: [input.action],
  });
  return {
    contractVersion: "tasq.authorization-request.v1",
    requestId: "eval-request",
    workspaceId: "alpha",
    serviceAudience: AUDIENCE,
    action: identityOf(input.action),
    resource: input.action.resourceKinds[0] === "workspace"
      ? { kind: "workspace", id: "alpha" }
      : { kind: input.action.resourceKinds[0], id: "opaque-one" },
    identity: makeIdentity({
      subject,
      issuer,
      actions: [input.action],
      binding: input.credentialBinding,
      method: input.authenticationMethod,
    }),
    subject: {
      binding: binding(`binding-${principalId}`, principalId, issuer, subject),
      principal: principal(principalId, input.principalKind ?? "human"),
    },
    actor: null,
    permissionSets: [permission],
    subjectGrants: [grant(`grant-${principalId}`, principalId, permission)],
    actorGrants: [],
    delegation: null,
    eligibilities: input.eligibility ? [input.eligibility] : [],
  };
}

describe("TQ-801 clean-room consumers", () => {
  test("keeps the machine certificate bound to code and honest about surfaces", () => {
    expect(certificate).toEqual(expect.objectContaining({
      status: "certified",
      policyImplementationDigest: AUTHORIZATION_POLICY_IMPLEMENTATION_DIGEST,
      registeredActionCount: ACTION_REGISTRY.length,
      implementedRemoteSurfaces: [],
      tq801Complete: true,
    }));
  });

  test("normalizes browser, delegated headless and workload clients into one decision contract", () => {
    const browser = directRequest({ action: action("commitment.read") });
    expect(evaluateAuthorization(browser, clock(T))).toMatchObject({ decision: "allow", actorPrincipalId: "human" });

    const execute = action("attempt.execute");
    const permission = definePermissionSet({ uri: "urn:eval:permission:execute", version: 1, actions: [execute] });
    const delegated = {
      ...directRequest({ action: execute }),
      identity: makeIdentity({
        subject: "subject-human",
        actions: [execute],
        actor: { issuer: "https://issuer-two.example/", subject: "subject-agent" },
        binding: { kind: "dpop", keyThumbprintDigest: sha("4") },
      }),
      actor: {
        binding: binding("binding-agent", "agent", "https://issuer-two.example/", "subject-agent"),
        principal: principal("agent", "agent"),
      },
      permissionSets: [permission],
      subjectGrants: [grant("grant-human", "human", permission)],
      actorGrants: [grant("grant-agent", "agent", permission)],
      delegation: Delegation.parse({
        contractVersion: "tasq.delegation.v1",
        id: "delegation-human-agent",
        workspaceId: "alpha",
        subjectPrincipalId: "human",
        actorPrincipalId: "agent",
        actions: [identityOf(execute)],
        scope: { kind: "workspace" },
        notBefore: T,
        expiresAt: T + 1_000,
        status: "active",
        revision: 1,
      }),
    };
    expect(evaluateAuthorization(delegated, clock(T))).toMatchObject({
      decision: "allow",
      subjectPrincipalId: "human",
      actorPrincipalId: "agent",
      grantIds: ["grant-agent", "grant-human"],
    });

    const dispatch = action("effect.dispatch");
    const workload = directRequest({
      action: dispatch,
      subject: "connector-one",
      principalId: "connector",
      principalKind: "service",
      authenticationMethod: "spiffe_svid",
      credentialBinding: {
        kind: "mtls_spiffe",
        identityUri: "spiffe://tasq.example/connectors/one",
        certificateThumbprintDigest: sha("5"),
      },
      eligibility: {
        contractVersion: "tasq.authority-eligibility.v1",
        id: "connector-eligibility",
        workspaceId: "alpha",
        principalId: "connector",
        kind: "effect_connector",
        status: "active",
        notBefore: T,
        expiresAt: T + 1_000,
        revision: 1,
      },
    });
    expect(evaluateAuthorization(workload, clock(T))).toMatchObject({ decision: "allow", actorPrincipalId: "connector" });
  });

  test("cannot widen authority by switching future transport surfaces", () => {
    const normalized = directRequest({ action: action("commitment.read") });
    const decisions = ["rest", "remote_mcp", "hosted_web_bff"].map(() =>
      evaluateAuthorization(structuredClone(normalized), clock(T)));
    expect(decisions[1]).toEqual(decisions[0]);
    expect(decisions[2]).toEqual(decisions[0]);
  });
});

describe("TQ-801 hostile authority boundaries", () => {
  test("keeps issuer/subject and workspace membership exact", () => {
    const input = directRequest({ action: action("commitment.read") });
    const issuerCollision = structuredClone(input);
    issuerCollision.identity = makeIdentity({
      subject: "subject-human",
      issuer: "https://issuer-two.example/",
      actions: [action("commitment.read")],
    });
    expect(evaluateAuthorization(issuerCollision, clock(T))).toMatchObject({ reasonCode: "subject_binding_mismatch" });

    const foreignWorkspace = structuredClone(input);
    foreignWorkspace.workspaceId = "beta";
    expect(evaluateAuthorization(foreignWorkspace, clock(T))).toMatchObject({ reasonCode: "subject_binding_mismatch" });
  });

  test("revokes live authority despite an unexpired credential", () => {
    const input = directRequest({ action: action("commitment.read") });
    expect(evaluateAuthorization(input, clock(T))).toMatchObject({ decision: "allow" });
    input.subjectGrants[0]!.status = "revoked";
    input.subjectGrants[0]!.revision = 2;
    expect(evaluateAuthorization(input, clock(T))).toMatchObject({ decision: "deny", reasonCode: "subject_grant_denied" });
  });

  test("freezes, advances and rewinds only through the supplied clock", () => {
    const input = directRequest({ action: action("commitment.read") });
    expect(evaluateAuthorization(input, clock(T))).toMatchObject({ decision: "allow", evaluatedAt: T });
    expect(evaluateAuthorization(input, clock(T + 5_000))).toMatchObject({ reasonCode: "subject_grant_denied" });
    expect(evaluateAuthorization(input, clock(T - 1))).toMatchObject({ reasonCode: "subject_grant_denied" });
    expect(evaluateAuthorization(input, clock(T))).toMatchObject({ decision: "allow", evaluatedAt: T });
  });

  test("rejects privilege from bearer possession or effect grant alone", () => {
    const admin = directRequest({ action: action("workspace.admin") });
    expect(evaluateAuthorization(admin, clock(T))).toMatchObject({ reasonCode: "sender_constraint_required" });

    const approveAction = action("effect.approval.record");
    const approve = directRequest({
      action: approveAction,
      credentialBinding: { kind: "dpop", keyThumbprintDigest: sha("6") },
    });
    expect(evaluateAuthorization(approve, clock(T))).toMatchObject({ reasonCode: "effect_eligibility_required" });
  });
});

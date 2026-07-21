import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  ACTION_REGISTRY,
  ACTION_URIS,
  AUTHORIZATION_POLICY_IMPLEMENTATION_DIGEST,
  AuthorizationRequest,
  Delegation,
  VerifiedIdentity,
  definePermissionSet,
  evaluateAuthorization,
  getRegisteredAction,
  type ActionDefinition,
  type ActionIdentity,
  type AuthorityEligibility,
  type AuthorityPrincipal,
  type AuthorizationGrant,
  type SubjectBinding,
  type VerifiedIdentity as VerifiedIdentityValue,
} from "../src/index.js";

const NOW = 1_735_689_600_000;
const SERVICE = "https://tasq.example/";
const ISSUER_A = "https://issuer-a.example/";
const ISSUER_B = "https://issuer-b.example/";
const sha = (character: string) => `sha256:${character.repeat(64)}`;

function registered(name: keyof typeof ACTION_URIS): ActionDefinition {
  const action = getRegisteredAction(ACTION_URIS[name]);
  if (!action) throw new Error(`missing registered action ${name}`);
  return action;
}

function identityOf(action: ActionDefinition): ActionIdentity {
  return {
    uri: action.uri,
    version: action.version,
    implementationDigest: action.implementationDigest,
  };
}

function identity(
  actions: ActionDefinition[],
  overrides: Partial<VerifiedIdentityValue> = {},
): VerifiedIdentityValue {
  return VerifiedIdentity.parse({
    contractVersion: "tasq.verified-identity.v1",
    issuer: ISSUER_A,
    subject: "human-subject",
    audience: [SERVICE],
    authenticationMethod: "oauth_jwt_access_token",
    authenticatedAt: NOW - 10_000,
    notBefore: NOW - 10_000,
    expiresAt: NOW + 60_000,
    clientId: "headless-client",
    actor: null,
    credentialBinding: { kind: "none" },
    tokenIdDigest: sha("1"),
    issuerConfigurationDigest: sha("2"),
    credentialKeyDigest: sha("3"),
    actionUpperBound: actions.map(identityOf).sort((a, b) => a.uri.localeCompare(b.uri)),
    ...overrides,
  });
}

function binding(
  principalId: string,
  overrides: Partial<SubjectBinding> = {},
): SubjectBinding {
  return {
    contractVersion: "tasq.subject-binding.v1",
    id: `binding-${principalId}`,
    workspaceId: "workspace-a",
    principalId,
    issuer: ISSUER_A,
    subject: "human-subject",
    method: "oidc",
    status: "enabled",
    revision: 1,
    createdAt: NOW - 20_000,
    disabledAt: null,
    replacedByBindingId: null,
    ...overrides,
  };
}

function principal(
  id: string,
  kind: AuthorityPrincipal["kind"] = "human",
  overrides: Partial<AuthorityPrincipal> = {},
): AuthorityPrincipal {
  return {
    id,
    workspaceId: "workspace-a",
    kind,
    status: "enabled",
    revision: 1,
    ...overrides,
  };
}

function grant(
  id: string,
  granteePrincipalId: string,
  permissionSet: ReturnType<typeof definePermissionSet>,
  overrides: Partial<AuthorizationGrant> = {},
): AuthorizationGrant {
  return {
    contractVersion: "tasq.authorization-grant.v1",
    id,
    workspaceId: "workspace-a",
    grantorPrincipalId: "admin-1",
    granteePrincipalId,
    permissionSet: {
      uri: permissionSet.uri,
      version: permissionSet.version,
      implementationDigest: permissionSet.implementationDigest,
    },
    scope: { kind: "workspace" },
    notBefore: NOW - 1_000,
    expiresAt: NOW + 30_000,
    status: "active",
    revision: 1,
    ...overrides,
  };
}

function requestFor(
  action: ActionDefinition,
  overrides: Partial<ReturnType<typeof AuthorizationRequest.parse>> = {},
) {
  const permissionSet = definePermissionSet({
    uri: "urn:tasq:permission:test",
    version: 1,
    actions: [action],
  });
  const subject = { binding: binding("human-1"), principal: principal("human-1") };
  return AuthorizationRequest.parse({
    contractVersion: "tasq.authorization-request.v1",
    requestId: "request-1",
    workspaceId: "workspace-a",
    serviceAudience: SERVICE,
    action: identityOf(action),
    resource: action.resourceKinds[0] === "workspace"
      ? { kind: "workspace", id: "workspace-a" }
      : { kind: action.resourceKinds[0], id: "resource-1" },
    identity: identity([action]),
    subject,
    actor: null,
    permissionSets: [permissionSet],
    subjectGrants: [grant("grant-subject", "human-1", permissionSet)],
    actorGrants: [],
    delegation: null,
    eligibilities: [],
    ...overrides,
  });
}

const fixedClock = (value = NOW) => ({ now: () => value });

describe("TQ-801 registered authority vocabulary", () => {
  test("freezes sixteen exact, versioned and implementation-bound actions", () => {
    expect(ACTION_REGISTRY).toHaveLength(16);
    expect(new Set(ACTION_REGISTRY.map(({ uri }) => uri)).size).toBe(16);
    expect(Object.isFrozen(ACTION_REGISTRY)).toBe(true);
    for (const action of ACTION_REGISTRY) {
      expect(action.uri).toMatch(/^urn:tasq:action:[a-z.]+$/);
      expect(action.version).toBe(1);
      expect(action.implementationDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(Object.isFrozen(action)).toBe(true);
      expect(Object.isFrozen(action.resourceKinds)).toBe(true);
    }
    expect(AUTHORIZATION_POLICY_IMPLEMENTATION_DIGEST).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  test("does not accept wildcard, unknown or altered action identities", () => {
    const read = registered("workspace.read");
    const valid = identity([read]);
    expect(VerifiedIdentity.safeParse({ ...valid, unexpected: true }).success).toBe(false);
    expect(VerifiedIdentity.safeParse({ ...valid, issuer: "https://issuer-a.example" }).success).toBe(false);
    expect(VerifiedIdentity.safeParse({ ...valid, audience: [SERVICE, SERVICE] }).success).toBe(false);
    expect(VerifiedIdentity.safeParse({
      ...valid,
      actionUpperBound: [{ ...identityOf(read), uri: "urn:tasq:action:*" }],
    }).success).toBe(false);
    expect(VerifiedIdentity.safeParse({
      ...valid,
      actionUpperBound: [{ ...identityOf(read), implementationDigest: sha("f") }],
    }).success).toBe(false);
    expect(VerifiedIdentity.safeParse({
      ...valid,
      authenticationMethod: "spiffe_svid",
      credentialBinding: { kind: "none" },
    }).success).toBe(false);
  });
});

describe("TQ-801 direct live authorization", () => {
  test("allows only a live grant and captures the injected clock once", () => {
    const input = requestFor(registered("commitment.read"));
    let calls = 0;
    const clock = { now: () => { calls += 1; return NOW; } };
    const first = evaluateAuthorization(input, clock);
    const replay = evaluateAuthorization(input, fixedClock());

    expect(calls).toBe(1);
    expect(first).toEqual(replay);
    expect(first).toMatchObject({
      decision: "allow",
      reasonCode: "allowed",
      evaluatedAt: NOW,
      subjectPrincipalId: "human-1",
      actorPrincipalId: "human-1",
      grantIds: ["grant-subject"],
      policyImplementationDigest: AUTHORIZATION_POLICY_IMPLEMENTATION_DIGEST,
    });
    expect(first.requestDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(first.decisionId).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  test("binds the request digest to the complete authority snapshot", () => {
    const input = requestFor(registered("commitment.read"));
    const changed = structuredClone(input);
    changed.subjectGrants[0]!.revision = 2;
    const first = evaluateAuthorization(input, fixedClock());
    const second = evaluateAuthorization(changed, fixedClock());
    expect(first.decision).toBe("allow");
    expect(second.decision).toBe("allow");
    expect(second.requestDigest).not.toBe(first.requestDigest);
    expect(second.decisionId).not.toBe(first.decisionId);
  });

  test("canonicalizes authority collection order without erasing semantic changes", () => {
    const read = registered("commitment.read");
    const permissionA = definePermissionSet({ uri: "urn:tasq:permission:a", version: 1, actions: [read] });
    const permissionB = definePermissionSet({ uri: "urn:tasq:permission:b", version: 1, actions: [read] });
    const input = requestFor(read, {
      permissionSets: [permissionA, permissionB],
      subjectGrants: [grant("grant-b", "human-1", permissionB), grant("grant-a", "human-1", permissionA)],
    });
    const reordered = structuredClone(input);
    reordered.permissionSets.reverse();
    reordered.subjectGrants.reverse();

    const first = evaluateAuthorization(input, fixedClock());
    const second = evaluateAuthorization(reordered, fixedClock());
    expect(second).toEqual(first);

    reordered.subjectGrants[0]!.revision += 1;
    expect(evaluateAuthorization(reordered, fixedClock()).requestDigest).not.toBe(first.requestDigest);
  });

  test("treats token actions as upper bounds, never grants", () => {
    const input = requestFor(registered("commitment.read"), { subjectGrants: [] });
    expect(evaluateAuthorization(input, fixedClock())).toMatchObject({
      decision: "deny",
      reasonCode: "subject_grant_denied",
      grantIds: [],
      permissionSetDigests: [],
    });
  });

  test("uses inclusive not-before and exclusive expiry boundaries", () => {
    const action = registered("commitment.read");
    const base = requestFor(action);
    const atIdentityExpiry = structuredClone(base);
    atIdentityExpiry.identity.expiresAt = NOW;
    expect(evaluateAuthorization(atIdentityExpiry, fixedClock())).toMatchObject({ reasonCode: "identity_expired" });

    const atGrantStart = structuredClone(base);
    atGrantStart.subjectGrants[0]!.notBefore = NOW;
    expect(evaluateAuthorization(atGrantStart, fixedClock())).toMatchObject({ decision: "allow" });

    const atGrantExpiry = structuredClone(base);
    atGrantExpiry.subjectGrants[0]!.expiresAt = NOW;
    expect(evaluateAuthorization(atGrantExpiry, fixedClock())).toMatchObject({ reasonCode: "subject_grant_denied" });

    const rewoundBeforeBinding = structuredClone(base);
    rewoundBeforeBinding.subject!.binding.createdAt = NOW + 1;
    expect(evaluateAuthorization(rewoundBeforeBinding, fixedClock())).toMatchObject({ reasonCode: "subject_binding_not_yet_valid" });
  });

  test("revocation, issuer collisions and disabled principals fail closed immediately", () => {
    const action = registered("commitment.read");
    const revoked = requestFor(action);
    revoked.subjectGrants[0]!.status = "revoked";
    expect(evaluateAuthorization(revoked, fixedClock())).toMatchObject({ reasonCode: "subject_grant_denied" });

    const disabled = requestFor(action);
    disabled.subject!.binding.status = "disabled";
    disabled.subject!.binding.disabledAt = NOW - 1;
    expect(evaluateAuthorization(disabled, fixedClock())).toMatchObject({ reasonCode: "subject_binding_disabled" });

    const sameSubjectOtherIssuer = requestFor(action);
    sameSubjectOtherIssuer.identity = identity([action], { issuer: ISSUER_B });
    expect(evaluateAuthorization(sameSubjectOtherIssuer, fixedClock())).toMatchObject({ reasonCode: "subject_binding_mismatch" });

    const principalDisabled = requestFor(action);
    principalDisabled.subject!.principal.status = "disabled";
    expect(evaluateAuthorization(principalDisabled, fixedClock())).toMatchObject({ reasonCode: "subject_principal_disabled" });
  });

  test("rejects unknown actions, altered identities, wrong resources and wrong audiences", () => {
    const read = registered("commitment.read");
    const unknown = requestFor(read);
    unknown.action = { ...identityOf(read), uri: "urn:tasq:action:future.read" };
    expect(evaluateAuthorization(unknown, fixedClock())).toMatchObject({ reasonCode: "unknown_action" });

    const altered = requestFor(read);
    altered.action.implementationDigest = sha("e");
    expect(evaluateAuthorization(altered, fixedClock())).toMatchObject({ reasonCode: "action_identity_mismatch" });

    const wrongResource = requestFor(read);
    wrongResource.resource = { kind: "effect", id: "effect-1" };
    expect(evaluateAuthorization(wrongResource, fixedClock())).toMatchObject({ reasonCode: "action_resource_mismatch" });

    const wrongAudience = requestFor(read);
    wrongAudience.serviceAudience = "https://other.example/";
    expect(evaluateAuthorization(wrongAudience, fixedClock())).toMatchObject({ reasonCode: "service_audience_mismatch" });
  });
});

describe("TQ-801 delegated subject/actor intersection", () => {
  function delegatedRequest(action: ActionDefinition, delegatedActions = [action]) {
    const permissionSet = definePermissionSet({
      uri: "urn:tasq:permission:delegated",
      version: 1,
      actions: [registered("commitment.read"), registered("commitment.mutate")],
    });
    const request = requestFor(action, {
      identity: identity([registered("commitment.read"), registered("commitment.mutate")], {
        actor: { issuer: ISSUER_A, subject: "agent-subject" },
      }),
      permissionSets: [permissionSet],
      subjectGrants: [grant("grant-human", "human-1", permissionSet)],
      actorGrants: [grant("grant-agent", "agent-1", permissionSet)],
      actor: {
        binding: binding("agent-1", { id: "binding-agent", subject: "agent-subject" }),
        principal: principal("agent-1", "agent"),
      },
      delegation: Delegation.parse({
        contractVersion: "tasq.delegation.v1",
        id: "delegation-1",
        workspaceId: "workspace-a",
        subjectPrincipalId: "human-1",
        actorPrincipalId: "agent-1",
        actions: delegatedActions.map(identityOf).sort((a, b) => a.uri.localeCompare(b.uri)),
        scope: { kind: "workspace" },
        notBefore: NOW - 1_000,
        expiresAt: NOW + 30_000,
        status: "active",
        revision: 1,
      }),
    });
    return request;
  }

  test("allows only the intersection and preserves both audit identities", () => {
    const read = delegatedRequest(registered("commitment.read"));
    expect(evaluateAuthorization(read, fixedClock())).toMatchObject({
      decision: "allow",
      subjectPrincipalId: "human-1",
      actorPrincipalId: "agent-1",
      grantIds: ["grant-agent", "grant-human"],
    });

    const mutate = delegatedRequest(registered("commitment.mutate"), [registered("commitment.read")]);
    expect(evaluateAuthorization(mutate, fixedClock())).toMatchObject({
      decision: "deny",
      reasonCode: "delegation_denied",
      subjectPrincipalId: "human-1",
      actorPrincipalId: "agent-1",
    });
  });

  test("denies a missing actor grant, missing actor binding or stale delegation", () => {
    const noActorGrant = delegatedRequest(registered("commitment.read"));
    noActorGrant.actorGrants = [];
    expect(evaluateAuthorization(noActorGrant, fixedClock())).toMatchObject({ reasonCode: "actor_grant_denied" });

    const noActor = delegatedRequest(registered("commitment.read"));
    noActor.actor = null;
    expect(evaluateAuthorization(noActor, fixedClock())).toMatchObject({ reasonCode: "actor_binding_required" });

    const revokedDelegation = delegatedRequest(registered("commitment.read"));
    revokedDelegation.delegation!.status = "revoked";
    expect(evaluateAuthorization(revokedDelegation, fixedClock())).toMatchObject({ reasonCode: "delegation_denied" });
  });
});

describe("TQ-801 privileged operations", () => {
  const dpop = { kind: "dpop" as const, keyThumbprintDigest: sha("4") };

  test("requires sender binding for administration", () => {
    const action = registered("workspace.admin");
    const bearer = requestFor(action);
    expect(evaluateAuthorization(bearer, fixedClock())).toMatchObject({ reasonCode: "sender_constraint_required" });

    const bound = requestFor(action, { identity: identity([action], { credentialBinding: dpop }) });
    expect(evaluateAuthorization(bound, fixedClock())).toMatchObject({ decision: "allow" });
  });

  test("keeps effect approval eligibility separate from grants", () => {
    const action = registered("effect.approval.record");
    const input = requestFor(action, { identity: identity([action], { credentialBinding: dpop }) });
    expect(evaluateAuthorization(input, fixedClock())).toMatchObject({ reasonCode: "effect_eligibility_required" });

    input.eligibilities = [{
      contractVersion: "tasq.authority-eligibility.v1",
      id: "eligibility-approver",
      workspaceId: "workspace-a",
      principalId: "human-1",
      kind: "effect_approver",
      status: "active",
      notBefore: NOW,
      expiresAt: NOW + 1_000,
      revision: 1,
    } satisfies AuthorityEligibility];
    expect(evaluateAuthorization(input, fixedClock())).toMatchObject({ decision: "allow" });
  });

  test("limits dispatch to a sender-bound eligible service identity", () => {
    const action = registered("effect.dispatch");
    const permissionSet = definePermissionSet({ uri: "urn:tasq:permission:dispatch", version: 1, actions: [action] });
    const serviceBinding = binding("connector-1", { subject: "connector-subject", method: "spiffe" });
    const servicePrincipal = principal("connector-1", "service");
    const eligibility: AuthorityEligibility = {
      contractVersion: "tasq.authority-eligibility.v1",
      id: "eligibility-connector",
      workspaceId: "workspace-a",
      principalId: "connector-1",
      kind: "effect_connector",
      status: "active",
      notBefore: NOW - 1,
      expiresAt: NOW + 1_000,
      revision: 1,
    };
    const serviceRequest = requestFor(action, {
      identity: identity([action], {
        subject: "connector-subject",
        authenticationMethod: "spiffe_svid",
        credentialBinding: {
          kind: "mtls_spiffe",
          identityUri: "spiffe://tasq.example/connector/one",
          certificateThumbprintDigest: sha("5"),
        },
      }),
      subject: { binding: serviceBinding, principal: servicePrincipal },
      permissionSets: [permissionSet],
      subjectGrants: [grant("grant-connector", "connector-1", permissionSet)],
      eligibilities: [eligibility],
    });
    expect(evaluateAuthorization(serviceRequest, fixedClock())).toMatchObject({ decision: "allow" });

    const agentRequest = structuredClone(serviceRequest);
    agentRequest.subject!.principal.kind = "agent";
    expect(evaluateAuthorization(agentRequest, fixedClock())).toMatchObject({ reasonCode: "effect_eligibility_required" });
  });
});

describe("TQ-801 corrupt snapshots and purity", () => {
  test("rejects corrupt permission definitions, grant references and duplicate authority IDs", () => {
    const action = registered("commitment.read");
    const corruptDefinition = requestFor(action);
    corruptDefinition.permissionSets[0]!.implementationDigest = sha("d");
    expect(evaluateAuthorization(corruptDefinition, fixedClock())).toMatchObject({ reasonCode: "authority_snapshot_invalid" });

    const duplicateGrant = requestFor(action);
    duplicateGrant.actorGrants = [structuredClone(duplicateGrant.subjectGrants[0]!)];
    expect(evaluateAuthorization(duplicateGrant, fixedClock())).toMatchObject({ reasonCode: "authority_snapshot_invalid" });

    const duplicateEligibility = requestFor(action);
    const entry: AuthorityEligibility = {
      contractVersion: "tasq.authority-eligibility.v1",
      id: "same-id",
      workspaceId: "workspace-a",
      principalId: "human-1",
      kind: "effect_approver",
      status: "active",
      notBefore: null,
      expiresAt: null,
      revision: 1,
    };
    duplicateEligibility.eligibilities = [entry, structuredClone(entry)];
    expect(evaluateAuthorization(duplicateEligibility, fixedClock())).toMatchObject({ reasonCode: "authority_snapshot_invalid" });
  });

  test("has no device clock, transport, persistence or kernel dependency", () => {
    const source = readFileSync(resolve(import.meta.dir, "../src/index.ts"), "utf8");
    expect(source).not.toMatch(/\bDate\.now\s*\(/);
    expect(source).not.toMatch(/\bnew\s+Date\s*\(/);
    expect(source).not.toMatch(/systemClock|performance\.now|process\.hrtime/);
    expect(source).not.toMatch(/from\s+["'](?:node:)?(?:http|https|net|tls)|fetch\s*\(/);
    expect(source).not.toMatch(/@tasq\/(?:core|service|store)|sqlite|libsql|postgres/i);
    expect(() => evaluateAuthorization(requestFor(registered("workspace.read")), undefined as never)).toThrow(
      "authorization requires an injected Clock",
    );
  });
});

import { afterEach, describe, expect, test } from "bun:test";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalizeEffectJson } from "@tasq-run/schema";
import {
  ACTION_URIS,
  definePermissionSet,
  getRegisteredAction,
  type ActionDefinition,
  type VerifiedIdentity,
} from "@tasq-internal/authority";
import { openAuthorityStore, openSigningCredentialAuthority } from "../src/index.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));
const sha = (value: unknown) =>
  `sha256:${createHash("sha256").update(canonicalizeEffectJson(value as never)).digest("hex")}`;
const AUDIENCE = "https://server.tasq.example/";
const ISSUER = "https://issuer.example/";

function credentialAction(): ActionDefinition {
  const found = getRegisteredAction(ACTION_URIS["credential.manage"]);
  if (!found) throw new Error("credential.manage is not registered");
  return found;
}

function statementAction(): ActionDefinition {
  const found = getRegisteredAction(ACTION_URIS["statement.accept"]);
  if (!found) throw new Error("statement.accept is not registered");
  return found;
}

function actionIdentity(action: ActionDefinition) {
  return { uri: action.uri, version: action.version, implementationDigest: action.implementationDigest };
}

function verifiedIdentity(action: ActionDefinition, now: number): VerifiedIdentity {
  return {
    contractVersion: "tasq.verified-identity.v1",
    issuer: ISSUER,
    subject: "author-subject",
    audience: [AUDIENCE],
    authenticationMethod: "oauth_jwt_access_token",
    authenticatedAt: now - 1_000,
    notBefore: now - 1_000,
    expiresAt: now + 60_000,
    clientId: "credential-manager",
    actor: null,
    credentialBinding: { kind: "dpop", keyThumbprintDigest: `sha256:${"d".repeat(64)}` },
    tokenIdDigest: `sha256:${"e".repeat(64)}`,
    issuerConfigurationDigest: `sha256:${"f".repeat(64)}`,
    credentialKeyDigest: `sha256:${"1".repeat(64)}`,
    actionUpperBound: [actionIdentity(action)],
  };
}

async function bootstrapCredentialAuthority(
  authority: Awaited<ReturnType<typeof openAuthorityStore>>,
  now: number,
) {
  const action = credentialAction();
  await authority.provisionHostTenant({
    id: "host", context: { operationId: "host", actorPrincipalId: "root", reason: "test" },
  });
  await authority.provisionWorkspace({
    workspaceId: "team/acme", hostTenantId: "host", storageBindingId: "slot",
    context: { operationId: "workspace", actorPrincipalId: "root", reason: "test" },
  });
  await authority.registerPrincipal({
    principal: { workspaceId: "team/acme", id: "principal:author", kind: "agent", status: "enabled", revision: 1 },
    context: {
      operationId: "principal", actorPrincipalId: "root", reason: "test",
      expectedAuthorityRevision: 0,
    },
  });
  await authority.bindSubject({
    binding: {
      contractVersion: "tasq.subject-binding.v1",
      id: "binding-author", workspaceId: "team/acme", principalId: "principal:author",
      issuer: ISSUER, subject: "author-subject", method: "oidc", status: "enabled",
      revision: 1, createdAt: now - 2_000, disabledAt: null, replacedByBindingId: null,
    },
    context: {
      operationId: "binding", actorPrincipalId: "root", reason: "test",
      expectedAuthorityRevision: 1,
    },
  });
  const permissionSet = definePermissionSet({
    uri: "urn:test:permission:credential-manager",
    version: 1,
    actions: [action, statementAction()],
  });
  await authority.activatePermissionSet({
    workspaceId: "team/acme", permissionSet,
    context: {
      operationId: "permission", actorPrincipalId: "root", reason: "test",
      expectedAuthorityRevision: 2,
    },
  });
  await authority.createGrant({
    grant: {
      contractVersion: "tasq.authorization-grant.v1",
      id: "grant-author", workspaceId: "team/acme", grantorPrincipalId: "principal:author",
      granteePrincipalId: "principal:author",
      permissionSet: {
        uri: permissionSet.uri,
        version: permissionSet.version,
        implementationDigest: permissionSet.implementationDigest,
      },
      scope: { kind: "workspace" },
      notBefore: now - 1_000, expiresAt: now + 60_000, status: "active", revision: 1,
    },
    context: {
      operationId: "grant", actorPrincipalId: "root", reason: "test",
      expectedAuthorityRevision: 3,
    },
  });
  return action;
}

async function authorizeCredentialMutation(
  authority: Awaited<ReturnType<typeof openAuthorityStore>>,
  action: ActionDefinition,
  now: number,
  requestId: string,
) {
  const authorization = await authority.authorizeAt({
    requestId,
    workspaceId: "team/acme",
    serviceAudience: AUDIENCE,
    action: actionIdentity(action),
    resource: { kind: "workspace", id: "team/acme" },
    identity: verifiedIdentity(action, now),
  }, now);
  expect(authorization.decision.decision).toBe("allow");
  return authorization.decision.decisionId;
}

describe("TQ-614 signing credential authority", () => {
  test("proves possession, preserves immutable key identity and enforces lifecycle CAS", async () => {
    const root = await mkdtemp(join(tmpdir(), "tasq-signing-authority-"));
    roots.push(root);
    const url = `file:${join(root, "authority.sqlite")}`;
    let now = 1_900_000_000_000;
    const clock = { now: () => now };
    const authority = await openAuthorityStore({ url, clock });
    const action = await bootstrapCredentialAuthority(authority, now);
    const enrollDecision = await authorizeCredentialMutation(authority, action, now, "authorize-enroll");

    let credentials = await openSigningCredentialAuthority({ url, clock });
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const material = { format: "jwk-okp-ed25519", x: publicKey.export({ format: "jwk" }).x! };
    const challenge = "challenge-that-is-at-least-thirty-two-bytes";
    const proofInput = Buffer.from([
      "tasq-credential-enrollment-v1", "team/acme", "principal:author", "credential-1", challenge,
    ].join("\0"));
    const enrolled = await credentials.enrollEd25519({
      credentialId: "credential-1",
      workspaceId: "team/acme",
      principalId: "principal:author",
      publicMaterial: material,
      trustRootDigest: `sha256:${"a".repeat(64)}`,
      isolationClass: "isolated_process",
      challenge,
      proofOfPossession: sign(null, proofInput, privateKey).toString("base64url"),
      enrollmentMethod: "host-nonce",
      enrollmentEvidenceDigest: sha({ challenge }),
    }, {
      actorPrincipalId: "principal:author", authorityDecisionId: enrollDecision, reason: "authorized enrollment",
      expectedRevision: null,
    });
    expect(enrolled).toMatchObject({ status: "active", revision: 1, publicMaterial: material });
    now += 1;
    const suspendDecision = await authorizeCredentialMutation(authority, action, now, "authorize-suspend");
    const suspended = await credentials.transition("credential-1", "suspended", {
      actorPrincipalId: "principal:author", authorityDecisionId: suspendDecision, reason: "investigation",
      expectedRevision: 1,
    });
    expect(suspended).toMatchObject({ status: "suspended", revision: 2 });
    await expect(credentials.transition("credential-1", "active", {
      actorPrincipalId: "principal:author", authorityDecisionId: suspendDecision, reason: "stale",
      expectedRevision: 1,
    })).rejects.toThrow();
    const resumeDecision = await authorizeCredentialMutation(authority, action, now, "authorize-resume");
    const resumed = await credentials.transition("credential-1", "active", {
      actorPrincipalId: "principal:author", authorityDecisionId: resumeDecision, reason: "investigation closed",
      expectedRevision: 2,
    });
    expect(resumed).toMatchObject({ status: "active", revision: 3 });
    const compromiseDecision = await authorizeCredentialMutation(authority, action, now, "authorize-compromise");
    await credentials.transition("credential-1", "compromised", {
      actorPrincipalId: "principal:author", authorityDecisionId: compromiseDecision, reason: "key exposed",
      expectedRevision: 3, compromiseEffectiveAt: now - 100,
    });
    const illegalDecision = await authorizeCredentialMutation(authority, action, now, "authorize-illegal");
    await expect(credentials.transition("credential-1", "active", {
      actorPrincipalId: "principal:author", authorityDecisionId: illegalDecision, reason: "illegal recovery",
      expectedRevision: 4,
    })).rejects.toThrow();
    credentials.close();
    authority.close();
  });

  test("rejects a forged proof before credential creation", async () => {
    const root = await mkdtemp(join(tmpdir(), "tasq-signing-forged-"));
    roots.push(root);
    const url = `file:${join(root, "authority.sqlite")}`;
    const clock = { now: () => 1_900_000_000_000 };
    const authority = await openAuthorityStore({ url, clock });
    const action = await bootstrapCredentialAuthority(authority, clock.now());
    const decision = await authorizeCredentialMutation(authority, action, clock.now(), "authorize-forged");
    let credentials = await openSigningCredentialAuthority({ url, clock });
    const { publicKey } = generateKeyPairSync("ed25519");
    await expect(credentials.enrollEd25519({
      credentialId: "credential-forged", workspaceId: "team/acme", principalId: "principal:author",
      publicMaterial: { format: "jwk-okp-ed25519", x: publicKey.export({ format: "jwk" }).x! },
      trustRootDigest: `sha256:${"a".repeat(64)}`, challenge: "challenge-that-is-at-least-thirty-two-bytes",
      isolationClass: "shared_user_software",
      proofOfPossession: Buffer.alloc(64).toString("base64url"),
      enrollmentMethod: "host-nonce", enrollmentEvidenceDigest: `sha256:${"b".repeat(64)}`,
    }, {
      actorPrincipalId: "principal:author", authorityDecisionId: decision, reason: "test", expectedRevision: null,
    })).rejects.toThrow("proof of possession");
    expect(await credentials.get("credential-forged")).toBeNull();
    credentials.close();
    authority.close();
  });

  test("rejects invented, stale and replayed authority decisions", async () => {
    const root = await mkdtemp(join(tmpdir(), "tasq-signing-authority-binding-"));
    roots.push(root);
    const url = `file:${join(root, "authority.sqlite")}`;
    const now = 1_900_000_000_000;
    const clock = { now: () => now };
    const authority = await openAuthorityStore({ url, clock });
    const action = await bootstrapCredentialAuthority(authority, now);
    const decision = await authorizeCredentialMutation(authority, action, now, "authorize-once");
    const credentials = await openSigningCredentialAuthority({ url, clock });
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const material = { format: "jwk-okp-ed25519", x: publicKey.export({ format: "jwk" }).x! };
    const enroll = async (credentialId: string, authorityDecisionId: string) => {
      const challenge = `challenge-${credentialId}-that-is-at-least-thirty-two-bytes`;
      const proofInput = Buffer.from([
        "tasq-credential-enrollment-v1", "team/acme", "principal:author", credentialId, challenge,
      ].join("\0"));
      return credentials.enrollEd25519({
        credentialId, workspaceId: "team/acme", principalId: "principal:author",
        publicMaterial: material, trustRootDigest: `sha256:${"a".repeat(64)}`,
        isolationClass: "isolated_process", challenge,
        proofOfPossession: sign(null, proofInput, privateKey).toString("base64url"),
        enrollmentMethod: "host-nonce", enrollmentEvidenceDigest: sha({ challenge }),
      }, {
        actorPrincipalId: "principal:author", authorityDecisionId, reason: "test",
        expectedRevision: null,
      });
    };
    await expect(enroll("invented", "not-a-decision")).rejects.toThrow("authority decision");
    await enroll("credential-once", decision);
    await expect(enroll("credential-replay", decision)).rejects.toThrow();
    credentials.close();
    authority.close();
  });

  test("serializes statement acceptance with live credential revocation", async () => {
    const root = await mkdtemp(join(tmpdir(), "tasq-signing-revocation-race-"));
    roots.push(root);
    const url = `file:${join(root, "authority.sqlite")}`;
    const now = 1_900_000_000_000;
    const clock = { now: () => now };
    const authority = await openAuthorityStore({ url, clock });
    const manage = await bootstrapCredentialAuthority(authority, now);
    const enrollDecision = await authorizeCredentialMutation(
      authority,
      manage,
      now,
      "authorize-race-enroll",
    );
    let credentials = await openSigningCredentialAuthority({ url, clock });
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const challenge = "race-challenge-that-is-at-least-thirty-two-bytes";
    const proofInput = Buffer.from([
      "tasq-credential-enrollment-v1",
      "team/acme",
      "principal:author",
      "credential-race",
      challenge,
    ].join("\0"));
    await credentials.enrollEd25519({
      credentialId: "credential-race",
      workspaceId: "team/acme",
      principalId: "principal:author",
      publicMaterial: {
        format: "jwk-okp-ed25519",
        x: publicKey.export({ format: "jwk" }).x!,
      },
      trustRootDigest: `sha256:${"a".repeat(64)}`,
      isolationClass: "isolated_process",
      challenge,
      proofOfPossession: sign(null, proofInput, privateKey).toString("base64url"),
      enrollmentMethod: "host-nonce",
      enrollmentEvidenceDigest: sha({ challenge }),
    }, {
      actorPrincipalId: "principal:author",
      authorityDecisionId: enrollDecision,
      reason: "race setup",
      expectedRevision: null,
    });
    const revokeDecision = await authorizeCredentialMutation(
      authority,
      manage,
      now,
      "authorize-race-revoke",
    );
    const accept = statementAction();
    let callbackEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      callbackEntered = resolve;
    });
    let releaseCallback!: () => void;
    const release = new Promise<void>((resolve) => {
      releaseCallback = resolve;
    });
    const guardedAcceptance = authority.authorizeAndExecuteAt({
      requestId: "guarded-statement-acceptance",
      workspaceId: "team/acme",
      serviceAudience: AUDIENCE,
      action: actionIdentity(accept),
      resource: { kind: "workspace", id: "team/acme" },
      identity: verifiedIdentity(accept, now),
    }, now, async () => {
      expect(await credentials.get("credential-race")).toMatchObject({
        status: "active",
        revision: 1,
      });
      callbackEntered();
      await release;
      // Revocation is using another authority connection but cannot commit
      // while the production authority write gate is held.
      expect(await credentials.get("credential-race")).toMatchObject({
        status: "active",
        revision: 1,
      });
      return "accepted";
    });
    await entered;
    const revocationContext = {
      actorPrincipalId: "principal:author",
      authorityDecisionId: revokeDecision,
      reason: "race revocation",
      expectedRevision: 1,
    } as const;
    await expect(credentials.transition(
      "credential-race",
      "revoked",
      revocationContext,
    )).rejects.toMatchObject({ code: "SQLITE_BUSY" });
    releaseCallback();
    expect((await guardedAcceptance).execution).toBe("accepted");
    credentials.close();
    credentials = await openSigningCredentialAuthority({ url, clock });
    expect(await credentials.transition(
      "credential-race",
      "revoked",
      revocationContext,
    )).toMatchObject({ status: "revoked", revision: 2 });

    credentials.close();
    authority.close();
  });
});

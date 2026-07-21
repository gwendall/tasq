import { afterEach, describe, expect, test } from "bun:test";
import { createClient } from "@libsql/client";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  ACTION_URIS,
  Delegation,
  definePermissionSet,
  getRegisteredAction,
  type ActionDefinition,
  type AuthorityPrincipal,
  type AuthorizationGrant,
  type SubjectBinding,
  type VerifiedIdentity,
} from "@tasq-internal/authority";
import {
  AUTHORITY_MIGRATION_DIGEST,
  AuthorityStoreError,
  IsolatedWorkspaceRouter,
  openAuthorityStore,
  type AuthorityMutationContext,
  type AuthorityStore,
} from "../src/index.js";

const NOW = 1_800_000_000_000;
const AUDIENCE = "https://server.tasq.example/";
const ISSUER_A = "https://issuer-a.example/";
const ISSUER_B = "https://issuer-b.example/";
const sha = (c: string) => `sha256:${c.repeat(64)}`;

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function action(name: keyof typeof ACTION_URIS): ActionDefinition {
  const found = getRegisteredAction(ACTION_URIS[name]);
  if (!found) throw new Error(`missing action ${name}`);
  return found;
}

function actionIdentity(value: ActionDefinition) {
  return { uri: value.uri, version: value.version, implementationDigest: value.implementationDigest };
}

function identity(input: {
  subject: string;
  actions: ActionDefinition[];
  issuer?: string;
  actor?: { issuer: string; subject: string } | null;
  binding?: VerifiedIdentity["credentialBinding"];
}): VerifiedIdentity {
  return {
    contractVersion: "tasq.verified-identity.v1",
    issuer: input.issuer ?? ISSUER_A,
    subject: input.subject,
    audience: [AUDIENCE],
    authenticationMethod: "oauth_jwt_access_token",
    authenticatedAt: NOW - 1_000,
    notBefore: NOW - 1_000,
    expiresAt: NOW + 10_000,
    clientId: "client-one",
    actor: input.actor ?? null,
    credentialBinding: input.binding ?? { kind: "none" },
    tokenIdDigest: sha("1"),
    issuerConfigurationDigest: sha("2"),
    credentialKeyDigest: sha("3"),
    actionUpperBound: input.actions.map(actionIdentity).sort((a, b) => a.uri.localeCompare(b.uri)),
  };
}

function principal(workspaceId: string, id: string, kind: AuthorityPrincipal["kind"]): AuthorityPrincipal {
  return { workspaceId, id, kind, status: "enabled", revision: 1 };
}

function binding(input: {
  workspaceId: string;
  id: string;
  principalId: string;
  issuer: string;
  subject: string;
}): SubjectBinding {
  return {
    contractVersion: "tasq.subject-binding.v1",
    ...input,
    method: "oidc",
    status: "enabled",
    revision: 1,
    createdAt: NOW - 2_000,
    disabledAt: null,
    replacedByBindingId: null,
  };
}

function grant(input: {
  workspaceId: string;
  id: string;
  grantor: string;
  grantee: string;
  permission: ReturnType<typeof definePermissionSet>;
}): AuthorizationGrant {
  return {
    contractVersion: "tasq.authorization-grant.v1",
    id: input.id,
    workspaceId: input.workspaceId,
    grantorPrincipalId: input.grantor,
    granteePrincipalId: input.grantee,
    permissionSet: {
      uri: input.permission.uri,
      version: input.permission.version,
      implementationDigest: input.permission.implementationDigest,
    },
    scope: { kind: "workspace" },
    notBefore: NOW - 100,
    expiresAt: NOW + 5_000,
    status: "active",
    revision: 1,
  };
}

interface Fixture {
  root: string;
  path: string;
  store: AuthorityStore;
  clock: { value: number; calls: number; now(): number };
}

async function fixture(): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), "tasq-server-authority-"));
  roots.push(root);
  const path = join(root, "authority.sqlite");
  const clock = {
    value: NOW,
    calls: 0,
    now() { this.calls += 1; return this.value; },
  };
  const store = await openAuthorityStore({ url: `file:${path}`, clock });
  return { root, path, store, clock };
}

let operationCounter = 0;
function context(revision: number | null, reason = "test setup"): AuthorityMutationContext {
  operationCounter += 1;
  return {
    operationId: `operation-${operationCounter}`,
    actorPrincipalId: revision === null ? "local-operator" : "admin",
    reason,
    expectedAuthorityRevision: revision,
  };
}

async function bootstrapWorkspace(input: {
  fixture: Fixture;
  workspaceId?: string;
  storageBindingId?: string;
  action?: ActionDefinition;
  issuer?: string;
  subject?: string;
}) {
  const workspaceId = input.workspaceId ?? "alpha";
  const storageBindingId = input.storageBindingId ?? `storage-${workspaceId}`;
  const selectedAction = input.action ?? action("commitment.read");
  const subject = input.subject ?? "subject-human";
  const issuer = input.issuer ?? ISSUER_A;
  const tenantOperation = context(null);
  tenantOperation.operationId = `tenant-${workspaceId}`;
  try {
    await input.fixture.store.provisionHostTenant({ id: "host-one", context: tenantOperation });
  } catch (error) {
    if (!(error instanceof AuthorityStoreError) || error.code !== "already_exists") throw error;
  }
  const workspaceOperation = context(null);
  workspaceOperation.operationId = `workspace-${workspaceId}`;
  await input.fixture.store.provisionWorkspace({
    workspaceId,
    hostTenantId: "host-one",
    storageBindingId,
    context: workspaceOperation,
  });
  let revision = 0;
  await input.fixture.store.registerPrincipal({
    principal: principal(workspaceId, "admin", "human"),
    context: context(revision++),
  });
  await input.fixture.store.registerPrincipal({
    principal: principal(workspaceId, "human", "human"),
    context: context(revision++),
  });
  await input.fixture.store.bindSubject({
    binding: binding({ workspaceId, id: `binding-${workspaceId}-human`, principalId: "human", issuer, subject }),
    context: context(revision++),
  });
  const permission = definePermissionSet({
    uri: `urn:test:permission:${workspaceId}`,
    version: 1,
    actions: [selectedAction],
  });
  await input.fixture.store.activatePermissionSet({ workspaceId, permissionSet: permission, context: context(revision++) });
  await input.fixture.store.createGrant({
    grant: grant({ workspaceId, id: `grant-${workspaceId}-human`, grantor: "admin", grantee: "human", permission }),
    context: context(revision++),
  });
  return { workspaceId, storageBindingId, selectedAction, permission, revision, subject, issuer };
}

describe("TQ-802 authority migrations and mutation ledger", () => {
  test("applies one checksum-pinned migration idempotently without ambient time", async () => {
    const f = await fixture();
    const afterFirstOpen = f.clock.calls;
    await f.store.close();
    const reopened = await openAuthorityStore({ url: `file:${f.path}`, clock: f.clock });
    const client = createClient({ url: `file:${f.path}` });
    const migrations = await client.execute("SELECT name, digest, applied_at FROM authority_migration");
    expect(migrations.rows).toHaveLength(1);
    expect(migrations.rows[0]?.["digest"]).toBe(AUTHORITY_MIGRATION_DIGEST);
    expect(migrations.rows[0]?.["applied_at"]).toBe(NOW);
    expect(f.clock.calls).toBe(afterFirstOpen + 1);
    client.close();
    await reopened.close();
  });

  test("serializes concurrent cold migration without drift or partial schema", async () => {
    const root = mkdtempSync(join(tmpdir(), "tasq-server-migration-race-"));
    roots.push(root);
    const url = `file:${join(root, "authority.sqlite")}`;
    const clock = { now: () => NOW };
    const [first, second] = await Promise.all([
      openAuthorityStore({ url, clock }),
      openAuthorityStore({ url, clock }),
    ]);
    const client = createClient({ url });
    const migrations = await client.execute("SELECT name, digest FROM authority_migration");
    expect(migrations.rows).toHaveLength(1);
    expect(migrations.rows[0]?.["digest"]).toBe(AUTHORITY_MIGRATION_DIGEST);
    client.close();
    await first.close();
    await second.close();
  });

  test("makes mutations CAS-ordered, durable-idempotent and audit coupled", async () => {
    const f = await fixture();
    await f.store.provisionHostTenant({ id: "host", context: context(null) });
    await f.store.provisionWorkspace({
      workspaceId: "alpha", hostTenantId: "host", storageBindingId: "opaque-storage-a", context: context(null),
    });
    const mutationContext = context(0, "create initial administrator");
    const first = await f.store.registerPrincipal({ principal: principal("alpha", "admin", "human"), context: mutationContext });
    const replay = await f.store.registerPrincipal({ principal: principal("alpha", "admin", "human"), context: mutationContext });
    expect(first).toMatchObject({ authorityRevision: 1, replayed: false });
    expect(replay).toMatchObject({ authorityRevision: 1, replayed: true });

    await expect(f.store.registerPrincipal({
      principal: principal("alpha", "different", "human"), context: mutationContext,
    })).rejects.toMatchObject({ code: "idempotency_conflict" });
    await expect(f.store.registerPrincipal({
      principal: principal("alpha", "stale", "human"), context: context(0),
    })).rejects.toMatchObject({ code: "revision_conflict" });
    expect(await f.store.getWorkspaceAuthorityRevision("alpha")).toBe(1);
    const audit = await f.store.readAudit({ workspaceId: "alpha" });
    expect(audit.map(({ event_type }) => event_type)).toEqual(["workspace.provision", "principal.register"]);
    await f.store.close();
  });

  test("lets exactly one concurrent write win one authority revision", async () => {
    const f = await fixture();
    await f.store.provisionHostTenant({ id: "host", context: context(null) });
    await f.store.provisionWorkspace({ workspaceId: "alpha", hostTenantId: "host", storageBindingId: "s-a", context: context(null) });
    const outcomes = await Promise.allSettled([
      f.store.registerPrincipal({ principal: principal("alpha", "one", "human"), context: context(0) }),
      f.store.registerPrincipal({ principal: principal("alpha", "two", "agent"), context: context(0) }),
    ]);
    expect(outcomes.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter(({ status }) => status === "rejected")).toHaveLength(1);
    expect(await f.store.getWorkspaceAuthorityRevision("alpha")).toBe(1);
    await f.store.close();
  });
});

describe("TQ-802 isolated authorization router", () => {
  test("opens only the exact allowed workspace and never a probed foreign ledger", async () => {
    const f = await fixture();
    const alpha = await bootstrapWorkspace({ fixture: f, workspaceId: "alpha", storageBindingId: "opaque-alpha" });
    await bootstrapWorkspace({
      fixture: f, workspaceId: "beta", storageBindingId: "opaque-beta", issuer: ISSUER_B, subject: "other-subject",
    });
    const opens = { alpha: 0, beta: 0 };
    const router = new IsolatedWorkspaceRouter(f.store, [
      { workspaceId: "alpha", storageBindingId: "opaque-alpha", open: async () => { opens.alpha += 1; return "ledger-alpha"; } },
      { workspaceId: "beta", storageBindingId: "opaque-beta", open: async () => { opens.beta += 1; return "ledger-beta"; } },
    ]);
    const allowed = await router.authorizeAndOpen({
      requestId: "request-alpha",
      workspaceId: "alpha",
      serviceAudience: AUDIENCE,
      action: actionIdentity(alpha.selectedAction),
      resource: { kind: "commitment", id: "commitment-one" },
      identity: identity({ subject: alpha.subject, issuer: alpha.issuer, actions: [alpha.selectedAction] }),
    });
    expect(allowed).toMatchObject({ decision: { decision: "allow" }, workspace: "ledger-alpha" });
    expect(opens).toEqual({ alpha: 1, beta: 0 });

    const probe = await router.authorizeAndOpen({
      requestId: "request-beta-probe",
      workspaceId: "beta",
      serviceAudience: AUDIENCE,
      action: actionIdentity(alpha.selectedAction),
      resource: { kind: "commitment", id: "guessed-foreign-id" },
      identity: identity({ subject: alpha.subject, issuer: alpha.issuer, actions: [alpha.selectedAction] }),
    });
    expect(probe).toMatchObject({ decision: { decision: "deny", reasonCode: "membership_required" }, workspace: null });
    expect(opens).toEqual({ alpha: 1, beta: 0 });
    await f.store.close();
  });

  test("revokes immediately and cannot route a replayed pre-revocation allow", async () => {
    const f = await fixture();
    const alpha = await bootstrapWorkspace({ fixture: f });
    let opens = 0;
    const router = new IsolatedWorkspaceRouter(f.store, [{
      workspaceId: "alpha", storageBindingId: "storage-alpha", open: async () => { opens += 1; return { id: "alpha" }; },
    }]);
    const request = {
      requestId: "before-revocation",
      workspaceId: "alpha",
      serviceAudience: AUDIENCE,
      action: actionIdentity(alpha.selectedAction),
      resource: { kind: "commitment" as const, id: "one" },
      identity: identity({ subject: alpha.subject, actions: [alpha.selectedAction] }),
    };
    expect((await router.authorizeAndOpen(request)).workspace).toEqual({ id: "alpha" });
    await f.store.revokeGrant({
      workspaceId: "alpha",
      grantId: "grant-alpha-human",
      expectedGrantRevision: 1,
      context: context(alpha.revision),
    });
    await expect(router.authorizeAndOpen(request)).rejects.toMatchObject({ code: "revision_conflict" });
    const denied = await router.authorizeAndOpen({ ...request, requestId: "after-revocation" });
    expect(denied).toMatchObject({ decision: { decision: "deny", reasonCode: "subject_grant_denied" }, workspace: null });
    expect(opens).toBe(1);
    await f.store.close();
  });

  test("retires an immutable permission definition from live authority", async () => {
    const f = await fixture();
    const alpha = await bootstrapWorkspace({ fixture: f });
    await f.store.retirePermissionSet({
      workspaceId: "alpha",
      uri: alpha.permission.uri,
      version: alpha.permission.version,
      expectedPermissionRevision: 1,
      context: context(alpha.revision),
    });
    const denied = await f.store.authorize({
      requestId: "after-permission-retirement",
      workspaceId: "alpha",
      serviceAudience: AUDIENCE,
      action: actionIdentity(alpha.selectedAction),
      resource: { kind: "commitment", id: "one" },
      identity: identity({ subject: alpha.subject, actions: [alpha.selectedAction] }),
    });
    expect(denied.decision).toMatchObject({ decision: "deny", reasonCode: "subject_grant_denied" });
    await f.store.close();
  });

  test("refuses to derive or guess a storage route after an allow", async () => {
    const f = await fixture();
    const alpha = await bootstrapWorkspace({ fixture: f, storageBindingId: "host-secret-binding" });
    const router = new IsolatedWorkspaceRouter(f.store, []);
    await expect(router.authorizeAndOpen({
      requestId: "missing-host-binding",
      workspaceId: "alpha",
      serviceAudience: AUDIENCE,
      action: actionIdentity(alpha.selectedAction),
      resource: { kind: "commitment", id: "one" },
      identity: identity({ subject: alpha.subject, actions: [alpha.selectedAction] }),
    })).rejects.toThrow("authorized workspace has no exact host storage binding");
    await f.store.close();
  });

  test("persists effect eligibility separately from an ordinary live grant", async () => {
    const f = await fixture();
    const approve = action("effect.approval.record");
    const alpha = await bootstrapWorkspace({ fixture: f, action: approve });
    const authInput = {
      requestId: "approval-before-eligibility",
      workspaceId: "alpha",
      serviceAudience: AUDIENCE,
      action: actionIdentity(approve),
      resource: { kind: "effect" as const, id: "effect-one" },
      identity: identity({
        subject: alpha.subject,
        actions: [approve],
        binding: { kind: "dpop" as const, keyThumbprintDigest: sha("5") },
      }),
    };
    expect((await f.store.authorize(authInput)).decision).toMatchObject({
      decision: "deny", reasonCode: "effect_eligibility_required",
    });
    await f.store.grantEligibility({
      eligibility: {
        contractVersion: "tasq.authority-eligibility.v1",
        id: "approver-eligibility",
        workspaceId: "alpha",
        principalId: "human",
        kind: "effect_approver",
        status: "active",
        notBefore: NOW,
        expiresAt: NOW + 1_000,
        revision: 1,
      },
      context: context(alpha.revision),
    });
    expect((await f.store.authorize({ ...authInput, requestId: "approval-after-eligibility" })).decision).toMatchObject({
      decision: "allow", reasonCode: "allowed",
    });
    await f.store.close();
  });
});

describe("TQ-802 durable delegation, audit and corruption boundaries", () => {
  test("loads subject, actor, both grants and exact delegation from durable state", async () => {
    const f = await fixture();
    const execute = action("attempt.execute");
    const alpha = await bootstrapWorkspace({ fixture: f, action: execute });
    let revision = alpha.revision;
    await f.store.registerPrincipal({ principal: principal("alpha", "agent", "agent"), context: context(revision++) });
    await f.store.bindSubject({
      binding: binding({
        workspaceId: "alpha", id: "binding-agent", principalId: "agent",
        issuer: ISSUER_B, subject: "subject-agent",
      }),
      context: context(revision++),
    });
    await f.store.createGrant({
      grant: grant({
        workspaceId: "alpha", id: "grant-agent", grantor: "admin", grantee: "agent", permission: alpha.permission,
      }),
      context: context(revision++),
    });
    await f.store.createDelegation({
      delegation: Delegation.parse({
        contractVersion: "tasq.delegation.v1",
        id: "delegation-one",
        workspaceId: "alpha",
        subjectPrincipalId: "human",
        actorPrincipalId: "agent",
        actions: [actionIdentity(execute)],
        scope: { kind: "workspace" },
        notBefore: NOW,
        expiresAt: NOW + 1_000,
        status: "active",
        revision: 1,
      }),
      context: context(revision++),
    });
    const result = await f.store.authorize({
      requestId: "delegated-execute",
      workspaceId: "alpha",
      serviceAudience: AUDIENCE,
      action: actionIdentity(execute),
      resource: { kind: "commitment", id: "one" },
      identity: identity({
        subject: "subject-human",
        actions: [execute],
        actor: { issuer: ISSUER_B, subject: "subject-agent" },
        binding: { kind: "dpop", keyThumbprintDigest: sha("4") },
      }),
    });
    expect(result.decision).toMatchObject({
      decision: "allow",
      subjectPrincipalId: "human",
      actorPrincipalId: "agent",
      grantIds: ["grant-agent", "grant-alpha-human"],
    });
    await f.store.close();
  });

  test("persists decisions/audit append-only and logs no credential material", async () => {
    const f = await fixture();
    const alpha = await bootstrapWorkspace({ fixture: f });
    const tokenMarker = "raw-secret-token-must-not-appear";
    const authorization = await f.store.authorize({
      requestId: "audit-request",
      workspaceId: "alpha",
      serviceAudience: AUDIENCE,
      action: actionIdentity(alpha.selectedAction),
      resource: { kind: "commitment", id: "one" },
      identity: identity({ subject: alpha.subject, actions: [alpha.selectedAction] }),
    });
    expect(authorization.decision.decision).toBe("allow");
    const client = createClient({ url: `file:${f.path}` });
    await expect(client.execute({
      sql: "UPDATE authorization_decision SET reason_code = ? WHERE decision_id = ?",
      args: [tokenMarker, authorization.decision.decisionId],
    })).rejects.toThrow("authorization decisions are immutable");
    await expect(client.execute("DELETE FROM authority_audit")).rejects.toThrow("authority audit is append-only");
    await expect(client.execute("DELETE FROM authorization_grant")).rejects.toThrow("authorization grants cannot be deleted");
    await expect(client.execute(
      "UPDATE hosted_workspace SET storage_binding_id = 'attacker-path', authority_revision = authority_revision + 1",
    )).rejects.toThrow("invalid hosted workspace lifecycle");
    await expect(client.execute("UPDATE authority_idempotency SET result_json = '{}'"))
      .rejects.toThrow("authority idempotency is immutable");
    const dump = await client.execute("SELECT decision_json, request_digest FROM authorization_decision");
    const audit = await client.execute("SELECT reason, payload_json FROM authority_audit");
    expect(JSON.stringify([...dump.rows, ...audit.rows])).not.toContain(tokenMarker);
    expect(JSON.stringify([...dump.rows, ...audit.rows])).not.toContain("tokenIdDigest");
    client.close();
    await f.store.close();
  });

  test("fails closed on corrupt authority JSON without opening a workspace", async () => {
    const f = await fixture();
    const alpha = await bootstrapWorkspace({ fixture: f });
    await f.store.close();
    const client = createClient({ url: `file:${f.path}` });
    await client.execute("DROP TRIGGER permission_set_lifecycle");
    await client.execute("UPDATE permission_set SET actions_json = 'not-json' WHERE workspace_id = 'alpha'");
    client.close();
    const reopened = await openAuthorityStore({ url: `file:${f.path}`, clock: f.clock });
    let opens = 0;
    const router = new IsolatedWorkspaceRouter(reopened, [{
      workspaceId: "alpha", storageBindingId: "storage-alpha", open: async () => { opens += 1; return "bad"; },
    }]);
    await expect(router.authorizeAndOpen({
      requestId: "corrupt-authority",
      workspaceId: "alpha",
      serviceAudience: AUDIENCE,
      action: actionIdentity(alpha.selectedAction),
      resource: { kind: "commitment", id: "one" },
      identity: identity({ subject: alpha.subject, actions: [alpha.selectedAction] }),
    })).rejects.toMatchObject({ code: "authority_corrupt" });
    expect(opens).toBe(0);
    await reopened.close();
  });

  test("contains no raw clock or remote transport implementation", () => {
    const src = resolve(import.meta.dir, "../src");
    const source = ["store.ts", "router.ts", "migration.ts", "index.ts"]
      .map((name) => readFileSync(resolve(src, name), "utf8")).join("\n");
    expect(source).not.toMatch(/\bDate\.now\s*\(|\bnew\s+Date\s*\(|performance\.now|process\.hrtime/);
    expect(source).not.toMatch(/Bun\.serve|createServer|node:http|node:https|fetch\s*\(/);
  });
});

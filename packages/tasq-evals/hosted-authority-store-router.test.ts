/** TQ-802 — clean-process durable authority and isolated-routing eval. */

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
  AUTHORITY_MIGRATION_DIGEST,
  IsolatedWorkspaceRouter,
  openAuthorityStore,
  type AuthorityMutationContext,
} from "@tasq-internal/server";

const NOW = 1_800_000_000_000;
const AUDIENCE = "https://server.tasq.example/";
const ISSUER = "https://issuer-clean-room.example/";
const sha = (c: string) => `sha256:${c.repeat(64)}`;
const roots: string[] = [];
const certificate = JSON.parse(readFileSync(
  resolve(import.meta.dir, "../..", "docs/contracts/TQ-802_AUTHORITY_STORE_CERTIFICATION.json"),
  "utf8",
)) as {
  status: string;
  migrationDigest: string;
  implementedRemoteSurfaces: string[];
  tq802Complete: boolean;
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function action(name: keyof typeof ACTION_URIS): ActionDefinition {
  const found = getRegisteredAction(ACTION_URIS[name]);
  if (!found) throw new Error(`missing action ${name}`);
  return found;
}

const actionIdentity = (value: ActionDefinition) => ({
  uri: value.uri, version: value.version, implementationDigest: value.implementationDigest,
});

function identity(selected: ActionDefinition): VerifiedIdentity {
  return {
    contractVersion: "tasq.verified-identity.v1",
    issuer: ISSUER,
    subject: "clean-room-human",
    audience: [AUDIENCE],
    authenticationMethod: "oauth_introspection",
    authenticatedAt: NOW - 1_000,
    notBefore: NOW - 1_000,
    expiresAt: NOW + 10_000,
    clientId: "clean-room-client",
    actor: null,
    credentialBinding: { kind: "none" },
    tokenIdDigest: sha("1"),
    issuerConfigurationDigest: sha("2"),
    credentialKeyDigest: sha("3"),
    actionUpperBound: [actionIdentity(selected)],
  };
}

let operation = 0;
function context(revision: number | null): AuthorityMutationContext {
  operation += 1;
  return {
    operationId: `clean-operation-${operation}`,
    actorPrincipalId: revision === null ? "local-operator" : "admin",
    reason: "clean-room configuration",
    expectedAuthorityRevision: revision,
  };
}

describe("TQ-802 clean-process storage foundation", () => {
  test("binds the machine certificate to migration code without claiming a surface", () => {
    expect(certificate).toEqual(expect.objectContaining({
      status: "certified",
      migrationDigest: AUTHORITY_MIGRATION_DIGEST,
      implementedRemoteSurfaces: [],
      tq802Complete: true,
    }));
  });

  test("survives two independent cold-start migrators", async () => {
    const root = mkdtempSync(join(tmpdir(), "tasq-authority-process-race-"));
    roots.push(root);
    const url = `file:${join(root, "authority.sqlite")}`;
    const worker = resolve(import.meta.dir, "fixtures/authority-store-cold-worker.ts");
    const run = () => Bun.spawn([process.execPath, "run", worker, url], {
      cwd: root,
      env: { PATH: process.env.PATH ?? "" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const workers = [run(), run()];
    const results = await Promise.all(workers.map(async (child) => ({
      exit: await child.exited,
      stdout: await new Response(child.stdout).text(),
      stderr: await new Response(child.stderr).text(),
    })));
    expect(results, results.map(({ stderr }) => stderr).join("\n")).toEqual([
      { exit: 0, stdout: JSON.stringify({ ok: true }), stderr: "" },
      { exit: 0, stdout: JSON.stringify({ ok: true }), stderr: "" },
    ]);
    const store = await openAuthorityStore({ url, clock: { now: () => NOW } });
    await store.close();
  });

  test("reopens durable authority and touches only the authorized opaque binding", async () => {
    const root = mkdtempSync(join(tmpdir(), "tasq-authority-reopen-"));
    roots.push(root);
    const url = `file:${join(root, "control-plane.sqlite")}`;
    const clock = { value: NOW, now() { return this.value; } };
    let store = await openAuthorityStore({ url, clock });
    await store.provisionHostTenant({ id: "host-clean", context: context(null) });
    await store.provisionWorkspace({
      workspaceId: "robotics/team-a",
      hostTenantId: "host-clean",
      storageBindingId: "opaque-slot-7f4c",
      context: context(null),
    });
    let revision = 0;
    await store.registerPrincipal({
      principal: { id: "admin", workspaceId: "robotics/team-a", kind: "human", status: "enabled", revision: 1 },
      context: context(revision++),
    });
    await store.registerPrincipal({
      principal: { id: "operator", workspaceId: "robotics/team-a", kind: "human", status: "enabled", revision: 1 },
      context: context(revision++),
    });
    await store.bindSubject({
      binding: {
        contractVersion: "tasq.subject-binding.v1",
        id: "binding-operator",
        workspaceId: "robotics/team-a",
        principalId: "operator",
        issuer: ISSUER,
        subject: "clean-room-human",
        method: "oauth_introspection",
        status: "enabled",
        revision: 1,
        createdAt: NOW - 2_000,
        disabledAt: null,
        replacedByBindingId: null,
      },
      context: context(revision++),
    });
    const read = action("commitment.read");
    const permission = definePermissionSet({ uri: "urn:clean:permission:reader", version: 1, actions: [read] });
    await store.activatePermissionSet({
      workspaceId: "robotics/team-a", permissionSet: permission, context: context(revision++),
    });
    await store.createGrant({
      grant: {
        contractVersion: "tasq.authorization-grant.v1",
        id: "grant-operator-read",
        workspaceId: "robotics/team-a",
        grantorPrincipalId: "admin",
        granteePrincipalId: "operator",
        permissionSet: {
          uri: permission.uri,
          version: permission.version,
          implementationDigest: permission.implementationDigest,
        },
        scope: { kind: "workspace" },
        notBefore: NOW,
        expiresAt: NOW + 5_000,
        status: "active",
        revision: 1,
      },
      context: context(revision++),
    });
    await store.close();

    store = await openAuthorityStore({ url, clock });
    const opens = { exact: 0, guessed: 0 };
    const router = new IsolatedWorkspaceRouter(store, [
      {
        workspaceId: "robotics/team-a",
        storageBindingId: "opaque-slot-7f4c",
        open: async () => { opens.exact += 1; return { ledger: "robotics" }; },
      },
      {
        workspaceId: "robotics/team-b",
        storageBindingId: "robotics/team-a",
        open: async () => { opens.guessed += 1; return { ledger: "wrong" }; },
      },
    ]);
    const request = {
      requestId: "clean-read-1",
      workspaceId: "robotics/team-a",
      serviceAudience: AUDIENCE,
      action: actionIdentity(read),
      resource: { kind: "commitment" as const, id: "robot-arm-calibration" },
      identity: identity(read),
    };
    expect(await router.authorizeAndOpen(request)).toMatchObject({
      decision: { decision: "allow", subjectPrincipalId: "operator" },
      workspace: { ledger: "robotics" },
    });
    expect(opens).toEqual({ exact: 1, guessed: 0 });

    await store.revokeGrant({
      workspaceId: "robotics/team-a",
      grantId: "grant-operator-read",
      expectedGrantRevision: 1,
      context: context(revision),
    });
    await store.close();
    store = await openAuthorityStore({ url, clock });
    const afterRestart = new IsolatedWorkspaceRouter(store, [{
      workspaceId: "robotics/team-a",
      storageBindingId: "opaque-slot-7f4c",
      open: async () => { opens.exact += 1; return { ledger: "robotics" }; },
    }]);
    expect(await afterRestart.authorizeAndOpen({ ...request, requestId: "clean-read-2" })).toMatchObject({
      decision: { decision: "deny", reasonCode: "subject_grant_denied" },
      workspace: null,
    });
    expect(opens).toEqual({ exact: 1, guessed: 0 });
    const audit = await store.readAudit({ workspaceId: "robotics/team-a" });
    expect(audit.map(({ event_type }) => event_type)).toContain("grant.revoke");
    expect(audit.map(({ event_type }) => event_type)).toContain("authorization.deny");
    await store.close();
  });
});

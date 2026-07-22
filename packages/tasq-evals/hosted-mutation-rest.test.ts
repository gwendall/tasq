/** TQ-804 — clean-room registered mutation, restart and revocation eval. */

import { afterEach, describe, expect, test } from "bun:test";
import { createClient, type Client } from "@libsql/client";
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
  HOSTED_MUTATION_HTTP_IMPLEMENTATION_DIGEST,
  HostedMutationError,
  IsolatedWorkspaceRouter,
  createHostedHttpHandler,
  openAuthorityStore,
  type AuthorityMutationContext,
  type HostedMutationCommand,
  type HostedMutationOutcome,
  type HostedMutationWorkspace,
} from "@tasq-internal/server";

const NOW = 1_825_000_000_000;
const RESOURCE = "https://clean-host.example/api";
const ISSUER = "https://clean-issuer.example/";
const WORKSPACE = "research/lab-a";
const sha = (character: string) => `sha256:${character.repeat(64)}`;
const roots: string[] = [];
let operationNumber = 0;

const certificate = JSON.parse(readFileSync(
  resolve(import.meta.dir, "../..", "docs/contracts/TQ-804_MUTATION_REST_CERTIFICATION.json"),
  "utf8",
)) as {
  status: string;
  implementationDigest: string;
  atomicityModel: { crossDatabaseAcid: boolean; concurrentAuthorityWriter: string };
  bundledDomainOperations: unknown[];
  tq804Complete: boolean;
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function action(): ActionDefinition {
  const value = getRegisteredAction(ACTION_URIS["commitment.propose"]);
  if (!value) throw new Error("missing commitment.propose");
  return value;
}

const actionIdentity = (value: ActionDefinition) => ({
  uri: value.uri,
  version: value.version,
  implementationDigest: value.implementationDigest,
});

function context(revision: number | null): AuthorityMutationContext {
  operationNumber += 1;
  return {
    operationId: `clean-mutation-authority-${operationNumber}`,
    actorPrincipalId: revision === null ? "local-operator" : "admin",
    reason: "clean-room mutation configuration",
    expectedAuthorityRevision: revision,
  };
}

function identity(): VerifiedIdentity {
  return {
    contractVersion: "tasq.verified-identity.v1",
    issuer: ISSUER,
    subject: "unknown-agent",
    audience: [RESOURCE],
    authenticationMethod: "oauth_introspection",
    authenticatedAt: NOW - 1_000,
    notBefore: NOW - 1_000,
    expiresAt: NOW + 60_000,
    clientId: "clean-agent-client",
    actor: null,
    credentialBinding: { kind: "none" },
    tokenIdDigest: sha("1"),
    issuerConfigurationDigest: sha("2"),
    credentialKeyDigest: sha("3"),
    actionUpperBound: [actionIdentity(action())],
  };
}

describe("TQ-804 clean-room mutation REST", () => {
  test("binds the honest non-ACID certificate to the exported protocol", () => {
    expect(certificate).toMatchObject({
      status: "certified",
      implementationDigest: HOSTED_MUTATION_HTTP_IMPLEMENTATION_DIGEST,
      atomicityModel: {
        crossDatabaseAcid: false,
        concurrentAuthorityWriter: "typed authority_busy then exact retry",
      },
      bundledDomainOperations: [],
      tq804Complete: true,
    });
  });

  test("discovers an operation, commits once across restart, then observes revocation", async () => {
    const root = mkdtempSync(join(tmpdir(), "tasq-clean-mutation-"));
    roots.push(root);
    operationNumber = 0;
    const clock = { calls: 0, now() { this.calls += 1; return NOW; } };
    const authority = await openAuthorityStore({ url: `file:${join(root, "authority.sqlite")}`, clock });
    await authority.provisionHostTenant({ id: "clean-host", context: context(null) });
    await authority.provisionWorkspace({
      workspaceId: WORKSPACE,
      hostTenantId: "clean-host",
      storageBindingId: "opaque-research-ledger",
      context: context(null),
    });
    let revision = 0;
    await authority.registerPrincipal({
      principal: { id: "admin", workspaceId: WORKSPACE, kind: "human", status: "enabled", revision: 1 },
      context: context(revision++),
    });
    await authority.registerPrincipal({
      principal: { id: "agent", workspaceId: WORKSPACE, kind: "agent", status: "enabled", revision: 1 },
      context: context(revision++),
    });
    await authority.bindSubject({
      binding: {
        contractVersion: "tasq.subject-binding.v1",
        id: "agent-binding",
        workspaceId: WORKSPACE,
        principalId: "agent",
        issuer: ISSUER,
        subject: "unknown-agent",
        method: "oauth_introspection",
        status: "enabled",
        revision: 1,
        createdAt: NOW - 2_000,
        disabledAt: null,
        replacedByBindingId: null,
      },
      context: context(revision++),
    });
    const permission = definePermissionSet({ uri: "urn:clean:permission:propose", version: 1, actions: [action()] });
    await authority.activatePermissionSet({ workspaceId: WORKSPACE, permissionSet: permission, context: context(revision++) });
    await authority.createGrant({
      grant: {
        contractVersion: "tasq.authorization-grant.v1",
        id: "agent-grant",
        workspaceId: WORKSPACE,
        grantorPrincipalId: "admin",
        granteePrincipalId: "agent",
        permissionSet: { uri: permission.uri, version: permission.version,
          implementationDigest: permission.implementationDigest },
        scope: { kind: "workspace" },
        notBefore: NOW,
        expiresAt: NOW + 50_000,
        status: "active",
        revision: 1,
      },
      context: context(revision++),
    });

    const domainUrl = `file:${join(root, "domain.sqlite")}`;
    let domain: Client = createClient({ url: domainUrl });
    await domain.execute("CREATE TABLE result(key_digest TEXT PRIMARY KEY, request_digest TEXT, value_json TEXT)");
    await domain.execute("CREATE TABLE commitment(id TEXT PRIMARY KEY, title TEXT)");
    let writes = 0;
    const workspace: HostedMutationWorkspace = {
      workspaceId: WORKSPACE,
      async getCommitment() { return null; },
      async listCommitments() { return { items: [], nextCursor: null }; },
      async listEventMetadata() { return { items: [], nextSequence: null }; },
      async executeMutation(command: HostedMutationCommand) {
        const transaction = await domain.transaction("write");
        try {
          const found = await transaction.execute({
            sql: "SELECT request_digest, value_json FROM result WHERE key_digest = ?",
            args: [command.idempotencyKeyDigest],
          });
          const row = found.rows[0] as Record<string, unknown> | undefined;
          if (row) {
            if (row["request_digest"] !== command.requestDigest) throw new HostedMutationError("conflict");
            await transaction.commit();
            return { ...(JSON.parse(String(row["value_json"])) as HostedMutationOutcome), replayed: true };
          }
          const output: HostedMutationOutcome = {
            contractVersion: "tasq.hosted-mutation-outcome.v1",
            workspaceId: WORKSPACE,
            operationId: command.operation.id,
            requestDigest: command.requestDigest,
            idempotencyKeyDigest: command.idempotencyKeyDigest,
            resultType: "commitment",
            resultId: "clean-commitment",
            resultRevision: 1,
            eventSequence: 1,
            replayed: false,
            result: { id: "clean-commitment", title: (command.input as { title: string }).title, status: "open" },
          };
          await transaction.execute({ sql: "INSERT INTO commitment VALUES (?, ?)",
            args: ["clean-commitment", (command.input as { title: string }).title] });
          await transaction.execute({ sql: "INSERT INTO result VALUES (?, ?, ?)",
            args: [command.idempotencyKeyDigest, command.requestDigest, JSON.stringify(output)] });
          await transaction.commit();
          writes += 1;
          return output;
        } catch (error) {
          await transaction.rollback();
          throw error;
        }
      },
    };
    const router = new IsolatedWorkspaceRouter(authority, [{
      workspaceId: WORKSPACE,
      storageBindingId: "opaque-research-ledger",
      open: async () => workspace,
    }]);
    let requestNumber = 0;
    const handler = createHostedHttpHandler({
      protectedResource: RESOURCE,
      authorizationServers: [ISSUER],
      clock,
      router,
      mutationOperations: [{
        id: "commitment.propose",
        actionUri: ACTION_URIS["commitment.propose"],
        summary: "Propose a commitment",
        inputContract: { uri: "urn:clean:contract:proposal:v1", version: 1, implementationDigest: sha("9") },
        outputContract: { uri: "urn:clean:contract:commitment:v1", version: 1, implementationDigest: sha("8") },
        requiresExpectedRevision: false,
      }],
      requestIdFactory: () => `clean-${++requestNumber}`,
      verifier: { async verify(_input, requestClock) { expect(requestClock.now()).toBe(NOW); return identity(); } },
    });

    const catalogResponse = await handler(new Request(new URL("/api/v1/operations", RESOURCE)));
    const catalog = await catalogResponse.json() as { operations: Array<{ id: string; actionUri: string }> };
    const selected = catalog.operations.find(({ actionUri }) => actionUri === ACTION_URIS["commitment.propose"]);
    expect(selected?.id).toBe("commitment.propose");
    const call = (requestId: string, key: string) => handler(new Request(new URL(
      `/api/v1/workspaces/research%2Flab-a/operations/${selected!.id}`,
      RESOURCE,
    ), {
      method: "POST",
      headers: { authorization: "Bearer clean", "content-type": "application/json",
        "idempotency-key": key, "x-tasq-request-id": requestId },
      body: JSON.stringify({ contractVersion: "tasq.hosted-mutation-request.v1",
        resource: { kind: "workspace", id: WORKSPACE }, expectedRevision: null,
        input: { title: "Reproduce experiment" } }),
    }));

    const first = await call("clean-first", "stable-clean-key");
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ outcome: { resultId: "clean-commitment", replayed: false } });
    domain.close();
    domain = createClient({ url: domainUrl });
    const replay = await call("clean-replay", "stable-clean-key");
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ outcome: { resultId: "clean-commitment", replayed: true } });
    expect(writes).toBe(1);

    await authority.revokeGrant({ workspaceId: WORKSPACE, grantId: "agent-grant", expectedGrantRevision: 1,
      context: context(revision) });
    const denied = await call("clean-denied", "after-revoke");
    expect(denied.status).toBe(403);
    expect(writes).toBe(1);
    domain.close();
    await authority.close();
  });
});

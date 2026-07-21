import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createClient, type Client } from "@libsql/client";
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
  HostedMutationError,
  IsolatedWorkspaceRouter,
  createHostedHttpHandler,
  openAuthorityStore,
  type AuthorityMutationContext,
  type AuthorityStore,
  type HostedMutationCommand,
  type HostedMutationOperation,
  type HostedMutationOutcome,
  type HostedMutationWorkspace,
} from "../src/index.js";

const NOW = 1_820_000_000_000;
const RESOURCE = "https://server.tasq.example/";
const ISSUER = "https://issuer.example/";
const WORKSPACE = "robotics/team-a";
const sha = (character: string) => `sha256:${character.repeat(64)}`;
const clock = { calls: 0, now() { this.calls += 1; return NOW; } };
const operationDefinition: HostedMutationOperation = {
  id: "commitment.propose",
  actionUri: ACTION_URIS["commitment.propose"],
  summary: "Propose one durable commitment",
  inputContract: {
    uri: "urn:test:contract:commitment-proposal:v1",
    version: 1,
    implementationDigest: sha("9"),
  },
  outputContract: {
    uri: "urn:test:contract:commitment-result:v1",
    version: 1,
    implementationDigest: sha("8"),
  },
  requiresExpectedRevision: false,
};

let root = "";
let authority: AuthorityStore;
let domain: Client;
let authorityRevision = 0;
let authorityOperation = 0;
let verifierCalls = 0;
let opens = 0;
let domainCommits = 0;
let commandSeen: HostedMutationCommand | null = null;
let beforeDomainCommit: (() => Promise<void>) | null = null;

function action(): ActionDefinition {
  const found = getRegisteredAction(ACTION_URIS["commitment.propose"]);
  if (!found) throw new Error("missing commitment.propose");
  return found;
}

const actionIdentity = (value: ActionDefinition) => ({
  uri: value.uri,
  version: value.version,
  implementationDigest: value.implementationDigest,
});

function context(expected: number | null): AuthorityMutationContext {
  authorityOperation += 1;
  return {
    operationId: `mutation-authority-${authorityOperation}`,
    actorPrincipalId: expected === null ? "local-operator" : "admin",
    reason: "mutation HTTP fixture",
    expectedAuthorityRevision: expected,
  };
}

const identity: VerifiedIdentity = {
  contractVersion: "tasq.verified-identity.v1",
  issuer: ISSUER,
  subject: "mutation-agent",
  audience: [RESOURCE],
  authenticationMethod: "oauth_jwt_access_token",
  authenticatedAt: NOW - 1_000,
  notBefore: NOW - 1_000,
  expiresAt: NOW + 60_000,
  clientId: "mutation-client",
  actor: null,
  credentialBinding: { kind: "none" },
  tokenIdDigest: sha("1"),
  issuerConfigurationDigest: sha("2"),
  credentialKeyDigest: sha("3"),
  actionUpperBound: [actionIdentity(action())],
};

async function configureAuthority() {
  await authority.provisionHostTenant({ id: "host", context: context(null) });
  await authority.provisionWorkspace({
    workspaceId: WORKSPACE,
    hostTenantId: "host",
    storageBindingId: "opaque-domain-slot",
    context: context(null),
  });
  await authority.registerPrincipal({
    principal: { id: "admin", workspaceId: WORKSPACE, kind: "human", status: "enabled", revision: 1 },
    context: context(authorityRevision++),
  });
  await authority.registerPrincipal({
    principal: { id: "agent", workspaceId: WORKSPACE, kind: "agent", status: "enabled", revision: 1 },
    context: context(authorityRevision++),
  });
  await authority.bindSubject({
    binding: {
      contractVersion: "tasq.subject-binding.v1",
      id: "agent-binding",
      workspaceId: WORKSPACE,
      principalId: "agent",
      issuer: ISSUER,
      subject: "mutation-agent",
      method: "oidc",
      status: "enabled",
      revision: 1,
      createdAt: NOW - 10_000,
      disabledAt: null,
      replacedByBindingId: null,
    },
    context: context(authorityRevision++),
  });
  const permission = definePermissionSet({
    uri: "urn:test:permission:commitment-proposer",
    version: 1,
    actions: [action()],
  });
  await authority.activatePermissionSet({
    workspaceId: WORKSPACE,
    permissionSet: permission,
    context: context(authorityRevision++),
  });
  await authority.createGrant({
    grant: {
      contractVersion: "tasq.authorization-grant.v1",
      id: "agent-grant",
      workspaceId: WORKSPACE,
      grantorPrincipalId: "admin",
      granteePrincipalId: "agent",
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
    context: context(authorityRevision++),
  });
}

async function durableMutation(command: HostedMutationCommand): Promise<HostedMutationOutcome> {
  commandSeen = command;
  const transaction = await domain.transaction("write");
  try {
    const found = await transaction.execute({
      sql: "SELECT request_digest, outcome_json FROM mutation_result WHERE key_digest = ?",
      args: [command.idempotencyKeyDigest],
    });
    const prior = found.rows[0] as Record<string, unknown> | undefined;
    if (prior) {
      if (prior["request_digest"] !== command.requestDigest) throw new HostedMutationError("conflict");
      await transaction.commit();
      return { ...(JSON.parse(String(prior["outcome_json"])) as HostedMutationOutcome), replayed: true };
    }
    const count = await transaction.execute("SELECT COUNT(*) AS count FROM commitment");
    const id = `commitment-${Number((count.rows[0] as Record<string, unknown>)["count"]) + 1}`;
    const title = typeof command.input === "object" && command.input !== null
      ? String((command.input as Record<string, unknown>)["title"] ?? "")
      : "";
    if (!title || title.length > 500) throw new HostedMutationError("invalid_input");
    await transaction.execute({
      sql: "INSERT INTO commitment(id, workspace_id, title, decision_id, authority_revision) VALUES (?, ?, ?, ?, ?)",
      args: [id, command.workspaceId, title, command.decision.decisionId, command.authorityRevision],
    });
    const outcome: HostedMutationOutcome = {
      contractVersion: "tasq.hosted-mutation-outcome.v1",
      workspaceId: command.workspaceId,
      operationId: command.operation.id,
      requestDigest: command.requestDigest,
      idempotencyKeyDigest: command.idempotencyKeyDigest,
      resultType: "commitment",
      resultId: id,
      resultRevision: 1,
      eventSequence: 1,
      replayed: false,
      result: { id, title, status: "open", revision: 1 },
    };
    await transaction.execute({
      sql: "INSERT INTO mutation_result(key_digest, request_digest, outcome_json) VALUES (?, ?, ?)",
      args: [command.idempotencyKeyDigest, command.requestDigest, JSON.stringify(outcome)],
    });
    if (beforeDomainCommit) await beforeDomainCommit();
    await transaction.commit();
    domainCommits += 1;
    return outcome;
  } catch (error) {
    await transaction.rollback();
    throw error;
  }
}

const workspace: HostedMutationWorkspace = {
  workspaceId: WORKSPACE,
  async getCommitment() { return null; },
  async listCommitments() { return { items: [], nextCursor: null }; },
  async listEventMetadata() { return { items: [], nextSequence: null }; },
  executeMutation: durableMutation,
};

function createHandler(
  routedWorkspace: HostedMutationWorkspace = workspace,
  mutationOperations: HostedMutationOperation[] = [operationDefinition],
) {
  const router = new IsolatedWorkspaceRouter(authority, [{
    workspaceId: WORKSPACE,
    storageBindingId: "opaque-domain-slot",
    open: async () => { opens += 1; return routedWorkspace; },
  }]);
  let generated = 0;
  return createHostedHttpHandler({
    protectedResource: RESOURCE,
    authorizationServers: [ISSUER],
    clock,
    router,
    mutationOperations,
    requestIdFactory: () => `generated-${++generated}`,
    verifier: {
      async verify(input, requestClock) {
        verifierCalls += 1;
        expect(input).toMatchObject({ method: "POST", expectedAudience: RESOURCE, authorization: "Bearer mutation-token" });
        expect(requestClock.now()).toBe(NOW);
        return identity;
      },
    },
  });
}

function mutationRequest(input: unknown, options: { key?: string; requestId?: string; workspace?: string } = {}) {
  const target = options.workspace ?? "robotics%2Fteam-a";
  return new Request(new URL(`/v1/workspaces/${target}/operations/commitment.propose`, RESOURCE), {
    method: "POST",
    headers: {
      authorization: "Bearer mutation-token",
      "content-type": "application/json",
      ...(options.key === undefined ? {} : { "idempotency-key": options.key }),
      "x-tasq-request-id": options.requestId ?? "mutation-request",
    },
    body: JSON.stringify(input),
  });
}

const envelope = (title: string) => ({
  contractVersion: "tasq.hosted-mutation-request.v1",
  resource: { kind: "workspace", id: WORKSPACE },
  expectedRevision: null,
  input: { title },
});

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "tasq-hosted-mutation-"));
  authorityRevision = 0;
  authorityOperation = 0;
  verifierCalls = 0;
  opens = 0;
  domainCommits = 0;
  commandSeen = null;
  beforeDomainCommit = null;
  clock.calls = 0;
  authority = await openAuthorityStore({ url: `file:${join(root, "authority.sqlite")}`, clock });
  await configureAuthority();
  domain = createClient({ url: `file:${join(root, "workspace.sqlite")}` });
  await domain.execute("PRAGMA busy_timeout = 30000");
  await domain.execute("CREATE TABLE commitment(id TEXT PRIMARY KEY, workspace_id TEXT, title TEXT, decision_id TEXT, authority_revision INTEGER)");
  await domain.execute("CREATE TABLE mutation_result(key_digest TEXT PRIMARY KEY, request_digest TEXT, outcome_json TEXT)");
  clock.calls = 0;
});

afterEach(async () => {
  beforeDomainCommit = null;
  domain.close();
  await authority.close();
  rmSync(root, { recursive: true, force: true });
});

describe("TQ-804 guarded mutation HTTP", () => {
  test("publishes a state-free operation catalog and only implemented scopes", async () => {
    const handler = createHandler();
    const metadata = await handler(new Request(new URL("/.well-known/oauth-protected-resource", RESOURCE)));
    expect(metadata.status).toBe(200);
    expect(await metadata.json()).toMatchObject({
      resource: RESOURCE,
      tasq_operation_catalog: "https://server.tasq.example/v1/operations",
      scopes_supported: [
        ACTION_URIS["commitment.propose"], ACTION_URIS["commitment.read"], ACTION_URIS["workspace.read"],
      ].sort(),
    });
    const catalog = await handler(new Request(new URL("/v1/operations", RESOURCE)));
    expect(catalog.status).toBe(200);
    expect(await catalog.json()).toMatchObject({
      contractVersion: "tasq.hosted-operation-catalog.v1",
      operations: [{ id: "commitment.propose", action: actionIdentity(action()), resourceKinds: ["workspace"] }],
    });
    expect({ verifierCalls, opens, domainCommits }).toEqual({ verifierCalls: 0, opens: 0, domainCommits: 0 });
  });

  test("rejects missing idempotency and malformed envelopes before verification or storage", async () => {
    const handler = createHandler();
    const missing = await handler(mutationRequest(envelope("One")));
    expect(missing.status).toBe(400);
    expect(await missing.json()).toMatchObject({ code: "idempotency_key_required" });
    const malformed = await handler(mutationRequest({ ...envelope("One"), extra: true }, { key: "key-one" }));
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({ code: "invalid_mutation" });
    const updateHandler = createHandler(workspace, [{
      ...operationDefinition,
      id: "commitment.update",
      actionUri: ACTION_URIS["commitment.mutate"],
      requiresExpectedRevision: true,
    }]);
    const missingRevision = await updateHandler(new Request(new URL(
      "/v1/workspaces/robotics%2Fteam-a/operations/commitment.update",
      RESOURCE,
    ), {
      method: "POST",
      headers: { authorization: "Bearer mutation-token", "content-type": "application/json",
        "idempotency-key": "update-key", "x-tasq-request-id": "update-request" },
      body: JSON.stringify({ ...envelope("Update"), resource: { kind: "commitment", id: "commitment-one" } }),
    }));
    expect(missingRevision.status).toBe(400);
    expect(await missingRevision.json()).toMatchObject({ code: "expected_revision_required" });

    let pulls = 0;
    const oversizedStream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new Uint8Array(128 * 1024));
        if (pulls === 3) controller.close();
      },
    });
    const oversized = await handler(new Request(new URL(
      "/v1/workspaces/robotics%2Fteam-a/operations/commitment.propose",
      RESOURCE,
    ), {
      method: "POST",
      headers: { authorization: "Bearer mutation-token", "content-type": "application/json",
        "idempotency-key": "oversized-key", "x-tasq-request-id": "oversized-request" },
      body: oversizedStream,
      duplex: "half",
    } as RequestInit & { duplex: "half" }));
    expect(oversized.status).toBe(400);
    expect(await oversized.json()).toMatchObject({ code: "invalid_mutation" });
    expect(pulls).toBe(3);
    expect({ verifierCalls, opens, domainCommits }).toEqual({ verifierCalls: 0, opens: 0, domainCommits: 0 });
  });

  test("commits once, replays an exact retry and rejects conflicting key reuse", async () => {
    const handler = createHandler();
    const first = await handler(mutationRequest(envelope("Calibrate arm"), { key: "stable-key", requestId: "request-one" }));
    expect(first.status).toBe(200);
    const firstBody = await first.json() as Record<string, unknown>;
    expect(firstBody).toMatchObject({
      contractVersion: "tasq.hosted-mutation-response.v1",
      evaluatedAt: NOW,
      outcome: { resultId: "commitment-1", replayed: false, result: { title: "Calibrate arm" } },
    });
    expect(JSON.stringify(firstBody)).not.toContain("stable-key");
    expect(clock.calls).toBe(1);
    expect(commandSeen).toMatchObject({ evaluatedAt: NOW, authorityRevision: 5, idempotencyKey: "stable-key" });

    const replay = await handler(mutationRequest(envelope("Calibrate arm"), { key: "stable-key", requestId: "request-two" }));
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ outcome: { resultId: "commitment-1", replayed: true } });
    expect(domainCommits).toBe(1);
    const audit = await authority.readAudit({ workspaceId: WORKSPACE });
    expect(JSON.stringify(audit)).not.toContain("stable-key");

    const conflict = await handler(mutationRequest(envelope("Different"), { key: "stable-key", requestId: "request-three" }));
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ code: "mutation_conflict" });
    expect(domainCommits).toBe(1);
  });

  test("denies a foreign workspace without opening its ledger", async () => {
    const response = await createHandler()(mutationRequest({
      ...envelope("Probe"),
      resource: { kind: "workspace", id: "robotics/team-b" },
    }, { key: "probe", workspace: "robotics%2Fteam-b" }));
    expect(response.status).toBe(403);
    expect(opens).toBe(0);
    expect(domainCommits).toBe(0);
  });

  test("makes a concurrent revocation retry instead of crossing an admitted domain commit", async () => {
    let entered!: () => void;
    let release!: () => void;
    const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
    const releasePromise = new Promise<void>((resolve) => { release = resolve; });
    beforeDomainCommit = async () => { entered(); await releasePromise; };
    const handler = createHandler();
    let revoker = await openAuthorityStore({ url: `file:${join(root, "authority.sqlite")}`, clock });
    const mutation = handler(mutationRequest(envelope("Serialized"), { key: "serialized", requestId: "before-revoke" }));
    await enteredPromise;

    const revokeInput = {
      workspaceId: WORKSPACE,
      grantId: "agent-grant",
      expectedGrantRevision: 1,
      context: context(authorityRevision),
    };
    await expect(revoker.revokeGrant(revokeInput)).rejects.toMatchObject({ code: "authority_busy" });
    await revoker.close();

    release();
    const admitted = await mutation;
    expect(admitted.status).toBe(200);
    revoker = await openAuthorityStore({ url: `file:${join(root, "authority.sqlite")}`, clock });
    await revoker.revokeGrant(revokeInput);
    await revoker.close();

    beforeDomainCommit = null;
    const denied = await handler(mutationRequest(envelope("Too late"), { key: "after-revoke", requestId: "after-revoke" }));
    expect(denied.status).toBe(403);
    expect(domainCommits).toBe(1);
  });

  test("fails closed when the host returns an outcome for another request", async () => {
    const corrupt: HostedMutationWorkspace = {
      ...workspace,
      async executeMutation(command) {
        return { ...await durableMutation(command), requestDigest: sha("8") };
      },
    };
    const response = await createHandler(corrupt)(mutationRequest(envelope("Corrupt"), {
      key: "corrupt",
      requestId: "corrupt-output",
    }));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "mutation_outcome_unknown" });
    expect(domainCommits).toBe(1);

    const recovered = await createHandler()(mutationRequest(envelope("Corrupt"), {
      key: "corrupt",
      requestId: "recover-output",
    }));
    expect(recovered.status).toBe(200);
    expect(await recovered.json()).toMatchObject({ outcome: { resultId: "commitment-1", replayed: true } });
    expect(domainCommits).toBe(1);
  });
});

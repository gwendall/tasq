import { afterEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRemoteTasq, redeemRemoteEnrollment } from "../../tasq-client/src/index.js";
import {
  TasqServerConfig,
  backupTasqServer,
  bootstrapTasqServer,
  createTasqServerRuntime,
  registeredActionIdentities,
  restoreTasqServerBackup,
  type AuthorityMutationContext,
} from "../src/index.js";

const NOW = 1_920_000_000_000;
const PUBLIC = "https://server.tasq.example/";
const ISSUER = "https://identity.example/";
const WORKSPACE = "robotics/team-a";
const roots: string[] = [];
let operation = 0;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function context(expected: number | null): AuthorityMutationContext {
  operation += 1;
  return {
    operationId: `runtime-bootstrap-${operation}`,
    actorPrincipalId: expected === null ? "operator" : "admin",
    reason: "runtime test bootstrap",
    expectedAuthorityRevision: expected,
  };
}

async function fixture() {
  operation = 0;
  const root = await mkdtemp(join(tmpdir(), "tasq-server-runtime-"));
  roots.push(root);
  const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const actions = registeredActionIdentities();
  const config = TasqServerConfig.parse({
    contractVersion: "tasq.server-config.v1",
    publicUrl: PUBLIC,
    listen: { host: "127.0.0.1", port: 8787, trustTlsProxy: false },
    authorityDatabaseUrl: `file:${join(root, "authority.sqlite")}`,
    hostTenantId: "host",
    enrollment: { issuer: PUBLIC, accessLifetimeMs: 86_400_000 },
    jwt: {
      issuer: ISSUER,
      audience: PUBLIC,
      keys: [{ kid: "key-1", jwk: publicKey.export({ format: "jwk" }) }],
      scopeActions: { "tasq:all": actions },
      clockSkewMs: 0,
    },
    workspaces: [{
      id: WORKSPACE,
      storageBindingId: "workspace-slot-one",
      databaseUrl: `file:${join(root, "domain.sqlite")}`,
      receiptDatabaseUrl: `file:${join(root, "receipts.sqlite")}`,
    }],
    support: { documentationUrl: "https://tasq.run/docs" },
  });
  const enrollmentPepper = new Uint8Array(32).fill(9);
  const runtime = await createTasqServerRuntime({
    config,
    enrollmentPepper,
    clock: { now: () => NOW },
  });
  const bootstrap = {
    contractVersion: "tasq.server-bootstrap.v1" as const,
    hostTenantId: "host",
    createdAt: NOW,
    workspaces: [{
      id: WORKSPACE,
      principals: [
        {
          id: "admin",
          kind: "human" as const,
          issuer: ISSUER,
          subject: "admin-subject",
          method: "oidc" as const,
          role: "coordinator" as const,
        },
        {
          id: "agent",
          kind: "agent" as const,
          issuer: PUBLIC,
          subject: "agent-remote",
          method: "oauth_introspection" as const,
          role: "coordinator" as const,
        },
      ],
    }],
  };
  const bootstrapped = await bootstrapTasqServer({
    config,
    bootstrap,
    clock: { now: () => NOW },
    store: runtime.authority,
  });
  expect(await bootstrapTasqServer({
    config,
    bootstrap,
    clock: { now: () => NOW },
    store: runtime.authority,
  })).toEqual(bootstrapped);
  const state = await runtime.authority.getWorkspaceAuthorityState(WORKSPACE);
  const enrollment = await runtime.enrollment.create({
    workspaceId: WORKSPACE,
    principalId: "agent",
    subject: "agent-remote",
    clientKind: "workload_agent",
    actionUpperBound: actions,
    enrollmentExpiresAt: NOW + 60_000,
    accessExpiresAt: NOW + 100_000,
    context: context(state!.authorityRevision),
  });
  const fetcher = (request: RequestInfo | URL, init?: RequestInit) =>
    runtime.fetch(new Request(request, init));
  const redeemed = await redeemRemoteEnrollment({
    endpoint: PUBLIC,
    workspaceId: WORKSPACE,
    enrollmentToken: enrollment.enrollmentToken,
    fetch: fetcher,
  });
  return { runtime, fetcher, accessToken: redeemed.accessToken, config, root, enrollmentPepper };
}

describe("deployable Server runtime", () => {
  test("routes health, guarded REST, durable operations and the authenticated Console BFF", async () => {
    const { runtime, fetcher, accessToken } = await fixture();
    try {
      expect(await (await runtime.fetch(new Request("http://internal/healthz"))).json())
        .toEqual({ status: "ok" });
      expect(await (await runtime.fetch(new Request("http://internal/version"))).json())
        .toMatchObject({ contractVersion: "tasq.server-runtime.v1", effectsEnabled: false });

      const client = createRemoteTasq({
        endpoint: PUBLIC,
        workspaceId: WORKSPACE,
        accessToken,
        fetch: fetcher,
      });
      const created = await client.executeOperation("commitment.propose", {
        resource: { kind: "workspace", id: WORKSPACE },
        input: { title: "Hosted commitment" },
        idempotencyKey: "hosted-create-one",
      });
      expect(created).toMatchObject({ resultType: "commitment", replayed: false });
      expect((await client.listCommitments()).items[0]?.title).toBe("Hosted commitment");

      const session = await runtime.fetch(new Request("http://internal/v1/session", {
        method: "POST",
        headers: {
          authorization: `Bearer ${accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ workspaceId: WORKSPACE }),
      }));
      expect(session.status).toBe(201);
      const cookie = session.headers.get("set-cookie");
      expect(cookie).toContain("__Host-tasq_session=");
      const console = await runtime.fetch(new Request(
        `http://internal/console?workspace=${encodeURIComponent(WORKSPACE)}`,
        { headers: { cookie: cookie!.split(";", 1)[0]! } },
      ));
      expect(console.status).toBe(200);
      expect(await console.text()).toContain("Hosted commitment");
      const login = await runtime.fetch(new Request("http://internal/console"));
      expect(login.status).toBe(401);
      expect(await login.text()).toContain('action="/session/connect"');
      const browserSession = await runtime.fetch(new Request("http://internal/session/connect", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ workspaceId: WORKSPACE, accessToken }).toString(),
      }));
      expect(browserSession.status).toBe(303);
      expect(browserSession.headers.get("set-cookie")).toContain("Secure; HttpOnly; SameSite=Strict");
      const humanCreate = await runtime.fetch(new Request(
        `http://internal/console/action?workspace=${encodeURIComponent(WORKSPACE)}`,
        {
          method: "POST",
          headers: {
            cookie: cookie!.split(";", 1)[0]!,
            origin: PUBLIC.slice(0, -1),
            "content-type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({
            action: "create",
            idempotencyKey: "human-create-one",
            title: "Created from hosted Console",
          }).toString(),
        },
      ));
      expect(humanCreate.status).toBe(303);
      expect((await client.listCommitments()).items.map(({ title }) => title))
        .toContain("Created from hosted Console");
    } finally {
      await runtime.close();
    }
  });

  test("does not trust Host headers and exposes no anonymous state through operational endpoints", async () => {
    const { runtime } = await fixture();
    try {
      const response = await runtime.fetch(new Request(
        `http://attacker.invalid/v1/workspaces/${encodeURIComponent(WORKSPACE)}/commitments`,
        { headers: { host: "attacker.invalid" } },
      ));
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ code: "authentication_required" });
      const support = await runtime.fetch(new Request("http://internal/support"));
      expect(await support.json()).toMatchObject({
        publicUrl: PUBLIC,
        workspaceCount: 1,
      });
      expect(await (await runtime.fetch(new Request("http://internal/metrics"))).text())
        .not.toContain(WORKSPACE);
    } finally {
      await runtime.close();
    }
  });

  test("backs up and restores authority, domain state and exact mutation receipts", async () => {
    const initial = await fixture();
    const client = createRemoteTasq({
      endpoint: PUBLIC,
      workspaceId: WORKSPACE,
      accessToken: initial.accessToken,
      fetch: initial.fetcher,
    });
    const request = {
      resource: { kind: "workspace" as const, id: WORKSPACE },
      input: { title: "Retained through disaster recovery" },
      idempotencyKey: "retained-create",
    };
    const first = await client.executeOperation("commitment.propose", request);
    const backupDirectory = join(initial.root, "backup");
    const manifest = await backupTasqServer({
      config: initial.config,
      outputDirectory: backupDirectory,
      clock: { now: () => NOW },
    });
    expect(manifest.files).toHaveLength(3);
    await client.executeOperation("commitment.propose", {
      resource: { kind: "workspace", id: WORKSPACE },
      input: { title: "Newer than selected recovery point" },
      idempotencyKey: "post-backup-create",
    });
    await initial.runtime.close();
    for (const url of [
      initial.config.authorityDatabaseUrl,
      initial.config.workspaces[0]!.databaseUrl,
      initial.config.workspaces[0]!.receiptDatabaseUrl,
    ]) {
      const path = new URL(url).pathname;
      await rm(path, { force: true });
      await rm(`${path}-wal`, { force: true });
      await rm(`${path}-shm`, { force: true });
    }
    expect(await restoreTasqServerBackup({
      config: initial.config,
      backupDirectory,
    })).toEqual(manifest);
    const restored = await createTasqServerRuntime({
      config: initial.config,
      enrollmentPepper: initial.enrollmentPepper,
      clock: { now: () => NOW },
    });
    try {
      const restoredFetch = (requestInput: RequestInfo | URL, init?: RequestInit) =>
        restored.fetch(new Request(requestInput, init));
      const restoredClient = createRemoteTasq({
        endpoint: PUBLIC,
        workspaceId: WORKSPACE,
        accessToken: initial.accessToken,
        fetch: restoredFetch,
      });
      expect((await restoredClient.listCommitments()).items[0]?.title)
        .toBe("Retained through disaster recovery");
      expect((await restoredClient.listCommitments()).items).toHaveLength(1);
      expect(await restoredClient.executeOperation("commitment.propose", request))
        .toEqual({ ...first, replayed: true });
    } finally {
      await restored.close();
    }
  });
});

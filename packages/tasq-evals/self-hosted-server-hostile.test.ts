/** TQ-808 — hostile certification against a real Tasq Server daemon process. */

import { afterEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Buffer } from "node:buffer";
import { createSign, generateKeyPairSync, randomUUID, type KeyObject } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRemoteTasq, TasqRemoteError } from "@tasq-run/client";

const roots: string[] = [];
const daemons = new Set<ReturnType<typeof Bun.spawn>>();
const PUBLIC = "https://hostile.tasq.example/";
const ISSUER_A = "https://issuer-a.example/";
const ISSUER_B = "https://issuer-b.example/";
const WORKSPACE_A = "teams/alpha";
const WORKSPACE_B = "teams/beta";
const PEPPER = Buffer.from(new Uint8Array(32).fill(8)).toString("base64url");
const repository = resolve(import.meta.dir, "../..");

afterEach(async () => {
  for (const daemon of daemons) daemon.kill("SIGKILL");
  daemons.clear();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function encoded(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function jwt(input: {
  privateKey: KeyObject;
  issuer: string;
  subject: string;
  kid: string;
  audience?: string;
  issuedAt?: number;
  expiresAt?: number;
}): string {
  const now = Math.floor(Date.now() / 1_000);
  const header = encoded({ alg: "RS256", typ: "at+jwt", kid: input.kid });
  const payload = encoded({
    iss: input.issuer,
    sub: input.subject,
    aud: input.audience ?? PUBLIC,
    iat: input.issuedAt ?? now - 5,
    nbf: input.issuedAt ?? now - 5,
    exp: input.expiresAt ?? now + 300,
    jti: randomUUID(),
    scope: "tasq:coordinate",
  });
  const signature = createSign("RSA-SHA256")
    .update(`${header}.${payload}`)
    .end()
    .sign(input.privateKey)
    .toString("base64url");
  return `${header}.${payload}.${signature}`;
}

async function command(args: string[], env: Record<string, string> = {}) {
  const child = Bun.spawn(args, {
    cwd: repository,
    env: { ...process.env, TASQ_SERVER_ENROLLMENT_PEPPER: PEPPER, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(`${args.join(" ")} failed: ${stderr}`);
  return stdout.trim();
}

async function start(configPath: string) {
  const daemon = Bun.spawn([
    "bun", "packages/tasq-server/src/daemon.ts", "serve", "--config", configPath,
  ], {
    cwd: repository,
    env: { ...process.env, TASQ_SERVER_ENROLLMENT_PEPPER: PEPPER },
    stdout: "pipe",
    stderr: "pipe",
  });
  daemons.add(daemon);
  const reader = daemon.stdout.getReader();
  const first = await reader.read();
  if (first.done) throw new Error(await new Response(daemon.stderr).text());
  const announcement = JSON.parse(new TextDecoder().decode(first.value).trim()) as { status: string; listen: string };
  expect(announcement.status).toBe("ready");
  await reader.cancel();
  return {
    daemon,
    endpoint: `${announcement.listen}/`,
    async stop() {
      daemon.kill("SIGTERM");
      expect(await daemon.exited).toBe(0);
      daemons.delete(daemon);
    },
    async crash() {
      daemon.kill("SIGKILL");
      await daemon.exited;
      daemons.delete(daemon);
    },
  };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "tasq-hostile-server-"));
  roots.push(root);
  const first = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const second = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const port = 30_000 + (process.pid % 5_000);
  const configPath = join(root, "server.json");
  const bootstrapPath = join(root, "bootstrap.json");
  await writeFile(configPath, JSON.stringify({
    contractVersion: "tasq.server-config.v1",
    publicUrl: PUBLIC,
    listen: { host: "127.0.0.1", port, trustTlsProxy: false },
    authorityDatabaseUrl: `file:${join(root, "authority.sqlite")}`,
    hostTenantId: "hostile-host",
    enrollment: { issuer: PUBLIC, accessLifetimeMs: 86_400_000 },
    jwt: {
      issuer: ISSUER_A,
      audience: PUBLIC,
      keys: [{ kid: "issuer-a-key", jwk: first.publicKey.export({ format: "jwk" }) }],
      scopeActions: { "tasq:coordinate": "coordinator" },
      clockSkewMs: 0,
    },
    additionalJwtIssuers: [{
      issuer: ISSUER_B,
      audience: PUBLIC,
      keys: [{ kid: "issuer-b-key", jwk: second.publicKey.export({ format: "jwk" }) }],
      scopeActions: { "tasq:coordinate": "coordinator" },
      clockSkewMs: 0,
    }],
    workspaces: [
      {
        id: WORKSPACE_A,
        storageBindingId: "slot-alpha",
        databaseUrl: `file:${join(root, "alpha.sqlite")}`,
        receiptDatabaseUrl: `file:${join(root, "alpha-receipts.sqlite")}`,
      },
      {
        id: WORKSPACE_B,
        storageBindingId: "slot-beta",
        databaseUrl: `file:${join(root, "beta.sqlite")}`,
        receiptDatabaseUrl: `file:${join(root, "beta-receipts.sqlite")}`,
      },
    ],
    support: {},
  }));
  await writeFile(bootstrapPath, JSON.stringify({
    contractVersion: "tasq.server-bootstrap.v1",
    hostTenantId: "hostile-host",
    createdAt: Date.now(),
    workspaces: [
      {
        id: WORKSPACE_A,
        principals: [
          {
            id: "admin-a",
            kind: "human",
            issuer: ISSUER_A,
            subject: "subject-a",
            method: "oidc",
            role: "coordinator",
          },
          {
            id: "agent-cli",
            kind: "agent",
            issuer: PUBLIC,
            subject: "subject-cli",
            method: "oauth_introspection",
            role: "coordinator",
          },
        ],
      },
      {
        id: WORKSPACE_B,
        principals: [{
          id: "admin-b",
          kind: "human",
          issuer: ISSUER_B,
          subject: "subject-b",
          method: "oidc",
          role: "coordinator",
        }],
      },
    ],
  }));
  await command([
    "bun", "packages/tasq-server/src/daemon.ts", "bootstrap",
    "--config", configPath, "--bootstrap", bootstrapPath,
  ]);
  return {
    root,
    configPath,
    privateA: first.privateKey,
    privateB: second.privateKey,
  };
}

function remote(endpoint: string, workspaceId: string, accessToken: string) {
  return createRemoteTasq({ endpoint, workspaceId, accessToken });
}

describe("TQ-808 hostile self-hosted Server", () => {
  test("isolates issuers/workspaces and preserves parity, revocation and restart recovery", async () => {
    const prepared = await fixture();
    let running = await start(prepared.configPath);
    const tokenA = jwt({
      privateKey: prepared.privateA,
      issuer: ISSUER_A,
      subject: "subject-a",
      kid: "issuer-a-key",
    });
    const tokenB = jwt({
      privateKey: prepared.privateB,
      issuer: ISSUER_B,
      subject: "subject-b",
      kid: "issuer-b-key",
    });
    const alpha = remote(running.endpoint, WORKSPACE_A, tokenA);
    const beta = remote(running.endpoint, WORKSPACE_B, tokenB);
    const enrollment = JSON.parse(await command([
      "bun", "packages/tasq-server/src/daemon.ts", "enroll",
      "--config", prepared.configPath,
      "--workspace", WORKSPACE_A,
      "--principal", "agent-cli",
      "--subject", "subject-cli",
      "--client-kind", "workload_agent",
    ])) as { enrollmentToken: string };
    const cliHome = join(prepared.root, "cli-home");
    await command([
      "bun", "packages/tasq-cli/src/index.ts", "remote", "enroll",
      "--endpoint", running.endpoint,
      "--workspace", WORKSPACE_A,
      "--profile", "hostile",
      "--json",
    ], { TASQ_HOME: cliHome, TASQ_ENROLLMENT_TOKEN: enrollment.enrollmentToken });
    const createInput = {
      resource: { kind: "workspace" as const, id: WORKSPACE_A },
      input: { title: "Alpha-only commitment" },
      idempotencyKey: "alpha-create-lost-response",
      requestId: "alpha-create-request",
    };
    const created = await alpha.executeOperation("commitment.propose", createInput);
    expect((await beta.executeOperation("commitment.propose", {
      resource: { kind: "workspace", id: WORKSPACE_B },
      input: { title: "Beta-only commitment" },
      idempotencyKey: "beta-create",
    })).resultType).toBe("commitment");
    await expect(remote(running.endpoint, WORKSPACE_B, tokenA).listCommitments())
      .rejects.toEqual(expect.objectContaining({ status: 403, code: "access_denied" }));
    expect((await alpha.listCommitments()).items.map(({ title }) => title))
      .toEqual(["Alpha-only commitment"]);
    expect((await beta.listCommitments()).items.map(({ title }) => title))
      .toEqual(["Beta-only commitment"]);

    const now = Math.floor(Date.now() / 1_000);
    const tokenParts = tokenA.split(".");
    const invalidSignature = `${tokenParts[0]}.${tokenParts[1]}.${tokenParts[2]![0] === "a" ? "b" : "a"}${tokenParts[2]!.slice(1)}`;
    for (const hostile of [
      jwt({
        privateKey: prepared.privateA,
        issuer: ISSUER_A,
        subject: "subject-a",
        kid: "issuer-a-key",
        expiresAt: now - 1,
      }),
      jwt({
        privateKey: prepared.privateA,
        issuer: ISSUER_A,
        subject: "subject-a",
        kid: "issuer-a-key",
        audience: "https://wrong.example/",
      }),
      invalidSignature,
      "actor:admin-a",
    ]) {
      await expect(remote(running.endpoint, WORKSPACE_A, hostile).listCommitments())
        .rejects.toBeInstanceOf(TasqRemoteError);
    }

    const mcp = new Client({ name: "tq808-hostile-client", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(
      `v1/workspaces/${encodeURIComponent(WORKSPACE_A)}/mcp`,
      running.endpoint,
    ), { requestInit: { headers: { authorization: `Bearer ${tokenA}` } } });
    await mcp.connect(transport);
    const mcpList = await mcp.callTool({ name: "tasq_commitment_list", arguments: { limit: 10 } });
    expect(mcpList.structuredContent).toMatchObject({
      items: [{ id: created.resultId, title: "Alpha-only commitment" }],
    });
    await mcp.close();

    const cliList = JSON.parse(await command([
      "bun", "packages/tasq-cli/src/index.ts", "remote", "list",
      "--profile", "hostile",
      "--json",
    ], { TASQ_HOME: cliHome })) as { items: Array<{ id: string }> };
    expect(cliList.items[0]?.id).toBe(created.resultId);

    await running.crash();
    running = await start(prepared.configPath);
    const restartedAlpha = remote(running.endpoint, WORKSPACE_A, tokenA);
    expect(await restartedAlpha.executeOperation("commitment.propose", createInput))
      .toEqual({ ...created, replayed: true });

    const raceMutation = restartedAlpha.executeOperation("commitment.propose", {
      resource: { kind: "workspace", id: WORKSPACE_A },
      input: { title: "Revocation race" },
      idempotencyKey: "revocation-race",
      requestId: "revocation-race",
    });
    const revocation = command([
      "bun", "packages/tasq-server/src/daemon.ts", "revoke-grant",
      "--config", prepared.configPath,
      "--workspace", WORKSPACE_A,
      "--grant", "bootstrap-grant:admin-a",
      "--expected-revision", "1",
    ]);
    const raced = await Promise.allSettled([raceMutation, revocation]);
    expect(raced.some(({ status }) => status === "fulfilled")).toBe(true);
    await expect(restartedAlpha.listCommitments())
      .rejects.toEqual(expect.objectContaining({ status: 403, code: "access_denied" }));

    const support = await fetch(new URL("support", running.endpoint));
    const supportBody = await support.text();
    expect(supportBody).not.toContain(tokenA);
    expect(supportBody).not.toContain("Alpha-only commitment");
    const bundleUrl = new URL(
      `v1/workspaces/${encodeURIComponent(WORKSPACE_B)}/support-bundle`,
      running.endpoint,
    );
    expect((await fetch(bundleUrl)).status).toBe(401);
    const bundle = await fetch(bundleUrl, { headers: { authorization: `Bearer ${tokenB}` } });
    expect(bundle.status).toBe(200);
    const bundleBody = await bundle.text();
    expect(bundleBody).not.toContain(tokenB);
    expect(bundleBody).not.toContain("Beta-only commitment");
    expect(bundleBody).not.toContain(prepared.root);
    await running.stop();
  }, 30_000);
});

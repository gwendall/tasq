import { afterEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const roots: string[] = [];
const PUBLIC = "https://daemon.tasq.example/";
const PEPPER = Buffer.from(new Uint8Array(32).fill(4)).toString("base64url");

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function files() {
  const root = await mkdtemp(join(tmpdir(), "tasq-server-daemon-"));
  roots.push(root);
  const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const port = 20_000 + (process.pid % 10_000);
  const configPath = join(root, "server.json");
  const bootstrapPath = join(root, "bootstrap.json");
  await writeFile(configPath, JSON.stringify({
    contractVersion: "tasq.server-config.v1",
    publicUrl: PUBLIC,
    listen: { host: "127.0.0.1", port, trustTlsProxy: false },
    authorityDatabaseUrl: `file:${join(root, "authority.sqlite")}`,
    hostTenantId: "host",
    enrollment: { issuer: PUBLIC, accessLifetimeMs: 86_400_000 },
    jwt: {
      issuer: "https://identity.example/",
      audience: PUBLIC,
      keys: [{ kid: "key-1", jwk: publicKey.export({ format: "jwk" }) }],
      scopeActions: {
        "tasq:read": "reader",
        "tasq:coordinate": "coordinator",
      },
      clockSkewMs: 30_000,
    },
    workspaces: [{
      id: "team/main",
      storageBindingId: "slot-main",
      databaseUrl: `file:${join(root, "domain.sqlite")}`,
      receiptDatabaseUrl: `file:${join(root, "receipts.sqlite")}`,
    }],
    support: {},
  }));
  await writeFile(bootstrapPath, JSON.stringify({
    contractVersion: "tasq.server-bootstrap.v1",
    hostTenantId: "host",
    createdAt: Date.now(),
    workspaces: [{
      id: "team/main",
      principals: [{
        id: "agent",
        kind: "agent",
        issuer: PUBLIC,
        subject: "agent-subject",
        method: "oauth_introspection",
        role: "coordinator",
      }],
    }],
  }));
  return { root, configPath, bootstrapPath, port };
}

async function run(args: string[]) {
  const process = Bun.spawn(["bun", "packages/tasq-server/src/daemon.ts", ...args], {
    cwd: join(import.meta.dir, "../../.."),
    env: { ...globalThis.process.env, TASQ_SERVER_ENROLLMENT_PEPPER: PEPPER },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

describe("Tasq Server daemon lifecycle", () => {
  test("bootstraps idempotently, checks, enrolls and serves a healthy listener", async () => {
    const { configPath, bootstrapPath, port } = await files();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const bootstrap = await run(["bootstrap", "--config", configPath, "--bootstrap", bootstrapPath]);
      expect(bootstrap).toMatchObject({ exitCode: 0, stderr: "" });
      expect(JSON.parse(bootstrap.stdout)).toMatchObject({ status: "ok", workspaces: 1, principals: 1 });
    }
    const checked = await run(["check", "--config", configPath]);
    expect(checked.exitCode).toBe(0);
    expect(JSON.parse(checked.stdout)).toEqual({ status: "ok", workspaces: 1 });
    const enrollment = await run([
      "enroll",
      "--config", configPath,
      "--workspace", "team/main",
      "--principal", "agent",
      "--subject", "agent-subject",
      "--client-kind", "workload_agent",
    ]);
    expect(enrollment.exitCode).toBe(0);
    expect(JSON.parse(enrollment.stdout).enrollmentToken).toStartWith("tasq_enroll_");

    const daemon = Bun.spawn([
      "bun", "packages/tasq-server/src/daemon.ts",
      "serve", "--config", configPath,
    ], {
      cwd: join(import.meta.dir, "../../.."),
      env: { ...globalThis.process.env, TASQ_SERVER_ENROLLMENT_PEPPER: PEPPER },
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      const reader = daemon.stdout.getReader();
      const announcement = await reader.read();
      expect(announcement.done).toBe(false);
      expect(JSON.parse(new TextDecoder().decode(announcement.value).trim()))
        .toMatchObject({ status: "ready", publicUrl: PUBLIC, workspaces: 1 });
      const health = await fetch(`http://127.0.0.1:${port}/healthz`);
      expect(health.status).toBe(200);
      expect(await health.json()).toEqual({ status: "ok" });
      await reader.cancel();
    } finally {
      daemon.kill("SIGTERM");
      expect(await daemon.exited).toBe(0);
    }
  }, 20_000);
});

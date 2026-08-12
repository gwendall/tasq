#!/usr/bin/env bun
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const image = process.argv[2] ?? "tasq-server:tq807";
const root = await mkdtemp(join(tmpdir(), "tasq-server-container-"));
const data = join(root, "data");
const config = join(root, "server.json");
const bootstrap = join(root, "bootstrap.json");
const container = `tasq-server-smoke-${randomUUID()}`;
const publicUrl = "https://container.tasq.example/";
const pepper = Buffer.from(new Uint8Array(32).fill(7)).toString("base64url");
const certificationTime = 1_900_000_000_000;

async function command(args: string[], allowFailure = false): Promise<string> {
  const child = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (code !== 0 && !allowFailure) throw new Error(`${args.join(" ")} failed (${code}): ${stderr}`);
  return stdout.trim();
}

try {
  // The released image intentionally runs as uid 10001. A bind-mounted host
  // directory keeps host ownership, so make the isolated smoke fixture
  // traversable and its database directory writable by that unprivileged uid.
  await chmod(root, 0o755);
  await mkdir(data);
  // mkdir mode is filtered through the runner's umask; chmod is intentional.
  await chmod(data, 0o777);
  const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  await writeFile(config, JSON.stringify({
    contractVersion: "tasq.server-config.v1",
    publicUrl,
    listen: { host: "0.0.0.0", port: 8787, trustTlsProxy: true },
    authorityDatabaseUrl: "file:/var/lib/tasq/authority.sqlite",
    hostTenantId: "host",
    enrollment: { issuer: publicUrl, accessLifetimeMs: 86_400_000 },
    jwt: {
      issuer: "https://identity.example/",
      audience: publicUrl,
      keys: [{ kid: "key-1", jwk: publicKey.export({ format: "jwk" }) }],
      scopeActions: { "tasq:coordinate": "coordinator" },
      clockSkewMs: 30_000,
    },
    workspaces: [{
      id: "team/main",
      storageBindingId: "slot-main",
      databaseUrl: "file:/var/lib/tasq/domain.sqlite",
      receiptDatabaseUrl: "file:/var/lib/tasq/receipts.sqlite",
    }],
    support: {},
  }));
  await writeFile(bootstrap, JSON.stringify({
    contractVersion: "tasq.server-bootstrap.v1",
    hostTenantId: "host",
    createdAt: certificationTime,
    workspaces: [{
      id: "team/main",
      principals: [{
        id: "owner",
        kind: "human",
        issuer: "https://identity.example/",
        subject: "owner",
        method: "oidc",
        role: "coordinator",
      }],
    }],
  }));
  const mounts = [
    "-v", `${data}:/var/lib/tasq`,
    "-v", `${config}:/etc/tasq/server.json:ro`,
    "-v", `${bootstrap}:/etc/tasq/bootstrap.json:ro`,
  ];
  const environment = ["-e", `TASQ_SERVER_ENROLLMENT_PEPPER=${pepper}`];
  const bootstrapped = await command([
    "docker", "run", "--rm", ...mounts, ...environment, image,
    "bootstrap", "--config", "/etc/tasq/server.json", "--bootstrap", "/etc/tasq/bootstrap.json",
  ]);
  if (JSON.parse(bootstrapped).status !== "ok") throw new Error("container bootstrap did not report ok");
  await command([
    "docker", "run", "--rm", "--detach", "--name", container,
    "-p", "127.0.0.1::8787", ...mounts, ...environment, image,
    "serve", "--config", "/etc/tasq/server.json",
  ]);
  const published = await command(["docker", "port", container, "8787/tcp"]);
  const port = published.match(/:(\d+)$/)?.[1];
  if (!port) throw new Error(`could not parse published port: ${published}`);
  let health: Response | null = null;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      health = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (health.ok) break;
    } catch {
      // The daemon may still be completing migrations.
    }
    await Bun.sleep(100);
  }
  if (!health?.ok || (await health.json() as { status?: string }).status !== "ok") {
    throw new Error("container health endpoint did not become ready");
  }
  const inspected = JSON.parse(await command([
    "docker", "image", "inspect", image, "--format", "{{json .}}",
  ])) as {
    Id: string;
    RepoDigests: string[] | null;
    Architecture: string;
    Os: string;
    Config: { Labels?: Record<string, string> };
  };
  const labels = inspected.Config.Labels ?? {};
  if (labels["org.opencontainers.image.source"] !== "https://github.com/gwendall/tasq") {
    throw new Error("container is missing the canonical OCI source label");
  }
  if (labels["org.opencontainers.image.licenses"] !== "Apache-2.0") {
    throw new Error("container is missing the Apache-2.0 OCI license label");
  }
  process.stdout.write(`${JSON.stringify({
    contractVersion: "tasq.server-container-smoke.v1",
    status: "passed",
    image,
    imageId: inspected.Id,
    repoDigests: inspected.RepoDigests ?? [],
    platform: `${inspected.Os}/${inspected.Architecture}`,
    metadata: {
      source: labels["org.opencontainers.image.source"],
      version: labels["org.opencontainers.image.version"],
      revision: labels["org.opencontainers.image.revision"],
      license: labels["org.opencontainers.image.licenses"],
    },
    bootstrap: "passed",
    health: "passed",
  }, null, 2)}\n`);
} finally {
  await command(["docker", "rm", "--force", container], true);
  await rm(root, { recursive: true, force: true });
}

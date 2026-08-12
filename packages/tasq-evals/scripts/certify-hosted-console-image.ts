#!/usr/bin/env bun

import {
  X509Certificate,
  createHash,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { request as httpRequest } from "node:http";
import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  requireExplicitServerImage,
  requireTasqServerOciIdentity,
  resolvesRequestedPublishedDigest,
  sensitiveCommandFailure,
  type TasqServerImageInspection,
} from "../hosted-console-image-contract.js";

interface ProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

const workspaceId = "certification/browser";
const productRoot = resolve(import.meta.dir, "../../..");
const inspectorRoot = join(productRoot, "packages/tasq-inspector");
const imageFlagIndex = process.argv.indexOf("--image");
const requestedImage = requireExplicitServerImage(
  imageFlagIndex === -1 ? undefined : process.argv[imageFlagIndex + 1],
);
const suffix = randomUUID();
const containerName = `tasq-tq811-${suffix}`;
const volumeName = `tasq-tq811-${suffix}`;
let proxy: ReturnType<typeof Bun.serve> | null = null;
let upstreamPort: string | null = null;

async function run(
  args: string[],
  options: {
    cwd?: string;
    env?: Record<string, string>;
    allowFailure?: boolean;
    sensitive?: boolean;
  } = {},
): Promise<ProcessResult> {
  const child = Bun.spawn(args, {
    cwd: options.cwd ?? productRoot,
    env: { ...process.env, ...options.env },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0 && !options.allowFailure) {
    if (options.sensitive) throw new Error(sensitiveCommandFailure(exitCode, stdout, stderr));
    throw new Error(`${args[0]} failed (${exitCode}):\n${`${stderr}${stdout}`.slice(0, 16_384)}`);
  }
  return { exitCode, stdout, stderr };
}

function jsonOutput(result: ProcessResult, label: string): Record<string, unknown> {
  if (result.exitCode !== 0) throw new Error(`${label} failed`);
  try {
    return JSON.parse(result.stdout) as Record<string, unknown>;
  } catch {
    throw new Error(`${label} returned invalid JSON`);
  }
}

async function cleanup(): Promise<void> {
  if (proxy) {
    await proxy.stop(true);
    proxy = null;
  }
  await run(["docker", "rm", "--force", containerName], { allowFailure: true });
  await run(["docker", "volume", "rm", "--force", volumeName], { allowFailure: true });
}

const root = await mkdtemp(join(tmpdir(), "tasq-tq811-image-"));
try {
  const inspected = JSON.parse((await run([
    "docker",
    "image",
    "inspect",
    requestedImage,
    "--format",
    "{{json .}}",
  ])).stdout) as TasqServerImageInspection;
  const oci = requireTasqServerOciIdentity(inspected);
  const exactPublishedDigest = resolvesRequestedPublishedDigest(requestedImage, inspected);

  const keyPath = join(root, "tls.key");
  const certificatePath = join(root, "tls.crt");
  await run([
    "openssl",
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-sha256",
    "-nodes",
    "-keyout",
    keyPath,
    "-out",
    certificatePath,
    "-days",
    "1",
    "-subj",
    "/CN=localhost",
    "-addext",
    "subjectAltName=DNS:localhost,IP:127.0.0.1",
  ]);
  await chmod(keyPath, 0o600);
  const certificateSpki = createHash("sha256").update(
    new X509Certificate(await readFile(certificatePath)).publicKey.export({
      type: "spki",
      format: "der",
    }),
  ).digest("base64");
  proxy = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    tls: {
      key: Bun.file(keyPath),
      cert: Bun.file(certificatePath),
    },
    async fetch(request) {
      if (!upstreamPort) return new Response("Server is starting\n", { status: 503 });
      const target = new URL(request.url);
      const headers = new Headers(request.headers);
      headers.set("host", target.host);
      const body = request.method === "GET" || request.method === "HEAD"
        ? null
        : Buffer.from(await request.arrayBuffer());
      return new Promise<Response>((resolveResponse) => {
        const upstream = httpRequest({
          hostname: "127.0.0.1",
          port: upstreamPort!,
          path: `${target.pathname}${target.search}`,
          method: request.method,
          headers: Object.fromEntries(headers),
        }, (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
          response.on("end", () => {
            const responseHeaders = new Headers();
            for (const [name, value] of Object.entries(response.headers)) {
              if (Array.isArray(value)) {
                for (const item of value) responseHeaders.append(name, item);
              } else if (value !== undefined) {
                responseHeaders.set(name, value);
              }
            }
            resolveResponse(new Response(Buffer.concat(chunks), {
              status: response.statusCode ?? 502,
              headers: responseHeaders,
            }));
          });
        });
        upstream.on("error", () => {
          resolveResponse(new Response("Upstream unavailable\n", { status: 502 }));
        });
        if (body) upstream.end(body);
        else upstream.end();
      });
    },
  });

  const publicUrl = `https://localhost:${proxy.port}/`;
  await chmod(root, 0o755);
  const configPath = join(root, "server.json");
  const bootstrapPath = join(root, "bootstrap.json");
  const environmentPath = join(root, "server.env");
  const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  await writeFile(configPath, `${JSON.stringify({
    contractVersion: "tasq.server-config.v1",
    publicUrl,
    listen: { host: "0.0.0.0", port: 8787, trustTlsProxy: true },
    authorityDatabaseUrl: "file:/var/lib/tasq/authority.sqlite",
    hostTenantId: "tq811-certification",
    enrollment: { issuer: publicUrl, accessLifetimeMs: 3_600_000 },
    jwt: {
      issuer: "https://unused-issuer.tasq.invalid/",
      audience: publicUrl,
      keys: [{
        kid: "unused-key",
        jwk: publicKey.export({ format: "jwk" }),
      }],
      scopeActions: { "tasq:coordinate": "coordinator" },
      clockSkewMs: 0,
    },
    workspaces: [{
      id: workspaceId,
      storageBindingId: "tq811-browser-slot",
      databaseUrl: "file:/var/lib/tasq/domain.sqlite",
      receiptDatabaseUrl: "file:/var/lib/tasq/receipts.sqlite",
    }],
    support: {},
  })}\n`, { encoding: "utf8", mode: 0o644 });
  await writeFile(bootstrapPath, `${JSON.stringify({
    contractVersion: "tasq.server-bootstrap.v1",
    hostTenantId: "tq811-certification",
    createdAt: 0,
    workspaces: [{
      id: workspaceId,
      principals: [{
        id: "browser-operator",
        kind: "human",
        issuer: publicUrl,
        subject: "browser-operator",
        method: "oauth_introspection",
        role: "coordinator",
      }],
    }],
  })}\n`, { encoding: "utf8", mode: 0o644 });
  await writeFile(
    environmentPath,
    `TASQ_SERVER_ENROLLMENT_PEPPER=${randomBytes(32).toString("base64url")}\n`,
    { encoding: "utf8", mode: 0o600 },
  );

  await run(["docker", "volume", "create", volumeName]);
  const common = [
    "--read-only",
    "--tmpfs",
    "/tmp:rw,nosuid,nodev,noexec",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--volume",
    `${volumeName}:/var/lib/tasq`,
    "--volume",
    `${configPath}:/etc/tasq/server.json:ro`,
    "--env-file",
    environmentPath,
  ];
  const bootstrap = jsonOutput(await run([
    "docker",
    "run",
    "--rm",
    ...common,
    "--volume",
    `${bootstrapPath}:/etc/tasq/bootstrap.json:ro`,
    inspected.Id,
    "bootstrap",
    "--config",
    "/etc/tasq/server.json",
    "--bootstrap",
    "/etc/tasq/bootstrap.json",
  ]), "container bootstrap");
  if (bootstrap["status"] !== "ok" || bootstrap["workspaces"] !== 1) {
    throw new Error("container bootstrap did not initialize the certification workspace");
  }

  const enrollment = jsonOutput(await run([
    "docker",
    "run",
    "--rm",
    ...common,
    inspected.Id,
    "enroll",
    "--config",
    "/etc/tasq/server.json",
    "--workspace",
    workspaceId,
    "--principal",
    "browser-operator",
    "--subject",
    "browser-operator",
    "--client-kind",
    "human_device",
  ], { sensitive: true }), "one-use browser enrollment");
  const enrollmentToken = enrollment["enrollmentToken"];
  if (typeof enrollmentToken !== "string" || !enrollmentToken.startsWith("tasq_enroll_")) {
    throw new Error("container enrollment returned no one-use token");
  }

  await run([
    "docker",
    "run",
    "--detach",
    "--name",
    containerName,
    "--publish",
    "127.0.0.1::8787",
    ...common,
    inspected.Id,
    "serve",
    "--config",
    "/etc/tasq/server.json",
  ]);
  const published = (await run(["docker", "port", containerName, "8787/tcp"])).stdout.trim();
  upstreamPort = published.match(/:(\d+)$/)?.[1] ?? null;
  if (!upstreamPort) throw new Error("could not resolve the loopback Server port");

  let ready = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const health = await run([
      "curl",
      "--insecure",
      "--silent",
      "--show-error",
      "--fail",
      "--max-time",
      "1",
      new URL("/readyz", publicUrl).href,
    ], { allowFailure: true });
    if (health.exitCode === 0) {
      const body = JSON.parse(health.stdout) as { status?: string };
      if (body.status === "ready") {
        ready = true;
        break;
      }
    }
    await Bun.sleep(100);
  }
  if (!ready) throw new Error("container did not become ready behind the temporary TLS proxy");

  const redeemRequestPath = join(root, "redeem.json");
  await writeFile(redeemRequestPath, `${JSON.stringify({
    contractVersion: "tasq.remote-enrollment.v1",
    enrollmentToken,
  })}\n`, { encoding: "utf8", mode: 0o600 });
  const redeemed = jsonOutput(await run([
    "curl",
    "--insecure",
    "--silent",
    "--show-error",
    "--fail-with-body",
    "--header",
    "content-type: application/json",
    "--header",
    "x-tasq-request-id: tq811-browser-enrollment",
    "--data-binary",
    `@${redeemRequestPath}`,
    new URL(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/enrollments/redeem`,
      publicUrl,
    ).href,
  ], { sensitive: true }), "one-use browser enrollment redemption");
  const accessToken = redeemed["accessToken"];
  if (typeof accessToken !== "string" || !accessToken.startsWith("tasq_access_")) {
    throw new Error("enrollment redemption returned no access credential");
  }

  const browserResultPath = join(root, "browser-result.json");
  const browserInputPath = join(root, "browser-input.json");
  await writeFile(browserInputPath, `${JSON.stringify({
    contractVersion: "tasq.tq811-browser-input.v1",
    publicUrl,
    workspaceId,
    accessToken,
    resultPath: browserResultPath,
  })}\n`, { encoding: "utf8", mode: 0o600 });
  await run([
    "pnpm",
    "exec",
    "playwright",
    "test",
    "--config",
    "hosted-browser.playwright.config.ts",
  ], {
    cwd: inspectorRoot,
    env: {
      TASQ_TQ811_BROWSER_INPUT: browserInputPath,
      TASQ_TQ811_CERTIFICATE_SPKI: certificateSpki,
      TASQ_TQ811_PLAYWRIGHT_OUTPUT: join(root, "playwright-output"),
    },
  });
  const browser = JSON.parse(await readFile(browserResultPath, "utf8")) as Record<string, unknown>;
  if (browser["contractVersion"] !== "tasq.tq811-browser-result.v1" ||
    browser["receiptReplay"] !== true) {
    throw new Error("hosted Console browser certification returned incomplete evidence");
  }

  process.stdout.write(`${JSON.stringify({
    contractVersion: "tasq.tq811-hosted-console-image-certification.v1",
    status: "passed_local_image_candidate_only",
    image: {
      requestedReference: requestedImage,
      resolvedImageId: inspected.Id,
      repoDigests: inspected.RepoDigests ?? [],
      platform: `${inspected.Os}/${inspected.Architecture}`,
      oci,
      exactPublishedDigest,
    },
    bootstrap: "passed",
    credential: "one_use_human_device_enrollment_redeemed",
    tls: "temporary_local_reverse_proxy",
    browser,
    directConsoleCoreMutationPath: false,
    publicSupportClaim: false,
    remainingExternalGate: [
      "exact_published_server_image_browser_replay",
      "tq807_tq808_server_publication",
    ],
  }, null, 2)}\n`);
} finally {
  await cleanup();
  await rm(root, { recursive: true, force: true });
}

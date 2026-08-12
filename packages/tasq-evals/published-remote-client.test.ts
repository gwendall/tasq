import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";

const packageName = "@tasq-run/client";
const requestedVersion = process.env.TASQ_PUBLISHED_REMOTE_CLIENT_VERSION;
const sourceCommit = process.env.TASQ_PUBLISHED_REMOTE_CLIENT_SOURCE_COMMIT;
const localTarball = process.env.TASQ_REMOTE_CLIENT_TARBALL;
const localIntegrity = process.env.TASQ_REMOTE_CLIENT_TARBALL_INTEGRITY;
const configured = Boolean(requestedVersion || sourceCommit || localTarball || localIntegrity);
const repositoryRoot = resolve(import.meta.dir, "../..");
const roots: string[] = [];
const fixtureRetryIdentity = ["idempotency", "1"].join("-");

setDefaultTimeout(180_000);

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function run(command: string[], cwd: string) {
  const child = Bun.spawn(command, {
    cwd,
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

function parsePackOutput(stdout: string): {
  filename: string;
  integrity: string;
  shasum: string;
} {
  const parsed = JSON.parse(stdout) as unknown;
  expect(parsed).toBeArray();
  expect(parsed).toHaveLength(1);
  const item = (parsed as Array<Record<string, unknown>>)[0];
  expect(item).toBeDefined();
  expect(item?.filename).toBeString();
  expect(item?.integrity).toBeString();
  expect(item?.shasum).toBeString();
  return item as { filename: string; integrity: string; shasum: string };
}

function sha512Integrity(bytes: Uint8Array): string {
  return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
}

describe("published remote TypeScript client", () => {
  (configured ? test : test.skip)(
    "replays the exact package under Node 22 and Bun through the public HTTP API",
    async () => {
      expect(requestedVersion, "TASQ_PUBLISHED_REMOTE_CLIENT_VERSION is required").toBeString();
      expect(
        requestedVersion,
        "TASQ_PUBLISHED_REMOTE_CLIENT_VERSION must be an exact SemVer without a v prefix",
      ).toMatch(/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/);
      expect(
        sourceCommit,
        "TASQ_PUBLISHED_REMOTE_CLIENT_SOURCE_COMMIT must be a lowercase full Git commit",
      ).toMatch(/^[a-f0-9]{40}$/);
      if (localTarball) {
        expect(
          localIntegrity,
          "local tarball mode requires TASQ_REMOTE_CLIENT_TARBALL_INTEGRITY",
        ).toMatch(/^sha512-[A-Za-z0-9+/]+={0,2}$/);
      } else {
        expect(
          localIntegrity,
          "TASQ_REMOTE_CLIENT_TARBALL_INTEGRITY is only valid with TASQ_REMOTE_CLIENT_TARBALL",
        ).toBeUndefined();
      }

      const root = await mkdtemp(join(tmpdir(), "tasq-published-remote-client-"));
      roots.push(root);
      const packDirectory = join(root, "pack");
      await mkdir(packDirectory);

      let tarball: string;
      let pack: { filename: string; integrity: string; shasum: string };
      if (localTarball) {
        const candidate = resolve(localTarball);
        const bytes = await readFile(candidate);
        expect(sha512Integrity(bytes), "local candidate tarball bytes drifted").toBe(localIntegrity!);
        tarball = candidate;
        pack = {
          filename: basename(candidate),
          integrity: sha512Integrity(bytes),
          shasum: createHash("sha1").update(bytes).digest("hex"),
        };
      } else {
        const packed = await run([
          "npm",
          "pack",
          `${packageName}@${requestedVersion}`,
          "--pack-destination",
          packDirectory,
          "--ignore-scripts",
          "--json",
        ], root);
        expect(packed.exitCode, packed.stderr || packed.stdout).toBe(0);
        pack = parsePackOutput(packed.stdout);
        tarball = join(packDirectory, pack.filename);
      }

      expect(pack.filename).toBe(`tasq-run-client-${requestedVersion}.tgz`);
      const tarballBytes = await readFile(tarball);
      expect(sha512Integrity(tarballBytes), "npm pack integrity does not match its bytes")
        .toBe(pack.integrity);
      expect(createHash("sha1").update(tarballBytes).digest("hex"), "npm pack shasum drifted")
        .toBe(pack.shasum);

      if (!localTarball) {
        const verified = await run([
          process.execPath,
          join(repositoryRoot, "scripts", "release", "verify-npm-publication.ts"),
          "--package",
          packageName,
          "--version",
          requestedVersion!,
          "--source-commit",
          sourceCommit!,
          "--tarball",
          tarball,
        ], repositoryRoot);
        expect(verified.exitCode, verified.stderr || verified.stdout).toBe(0);
        expect(JSON.parse(verified.stdout)).toMatchObject({
          contractVersion: "tasq.npm-publication-verification.v1",
          status: "published",
          package: packageName,
          version: requestedVersion,
          sourceCommit,
          integrity: pack.integrity,
        });
      }

      const manifestResult = await run(["tar", "-xOf", tarball, "package/package.json"], root);
      expect(manifestResult.exitCode, manifestResult.stderr || manifestResult.stdout).toBe(0);
      const manifest = JSON.parse(manifestResult.stdout) as Record<string, unknown>;
      expect(manifest).toMatchObject({
        name: packageName,
        version: requestedVersion,
        gitHead: sourceCommit,
        type: "module",
        main: "./dist/index.js",
        types: "./dist/index.d.ts",
        exports: { ".": "./dist/index.js" },
        engines: { bun: ">=1.3.0", node: ">=22" },
        repository: {
          type: "git",
          url: "git+https://github.com/gwendall/tasq.git",
          directory: "packages/tasq-client",
        },
      });
      expect(Object.keys(manifest.dependencies as Record<string, string>)).toEqual(["zod"]);
      expect(JSON.stringify(manifest)).not.toContain("workspace:");
      expect(JSON.stringify(manifest)).not.toContain("@tasq-run/core");
      expect(JSON.stringify(manifest)).not.toContain("@libsql");

      const consumer = join(root, "consumer");
      await mkdir(consumer);
      await writeFile(join(consumer, "package.json"), `${JSON.stringify({
        private: true,
        type: "module",
        dependencies: { [packageName]: `file:${tarball}` },
      }, null, 2)}\n`, "utf8");
      const installed = await run([
        "npm",
        "install",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--no-package-lock",
        "--workspaces=false",
      ], consumer);
      expect(installed.exitCode, installed.stderr || installed.stdout).toBe(0);

      const installedManifest = JSON.parse(await readFile(
        join(consumer, "node_modules", "@tasq-run", "client", "package.json"),
        "utf8",
      )) as Record<string, unknown>;
      expect(installedManifest).toMatchObject({
        name: packageName,
        version: requestedVersion,
        gitHead: sourceCommit,
      });

      const scenario = join(consumer, "scenario.mjs");
      await writeFile(scenario, String.raw`
import { createServer } from "node:http";
import { createRemoteTasq, TasqRemoteError } from "@tasq-run/client";

const runtime = process.argv[2];
if (runtime === "node" && process.versions.node.split(".")[0] !== "22") {
  throw new Error("registry client replay requires Node 22");
}
if (runtime === "bun" && !process.versions.bun) {
  throw new Error("registry client replay requires Bun");
}

const digest = "sha256:" + "a".repeat(64);
const fixtureRetryIdentity = "idempotency-1";
const requests = [];
const requestIds = [
  "request-list",
  "request-events",
  "request-operations",
  "request-error",
];
let requestIdIndex = 0;

function json(response, status = 200) {
  return { status, body: JSON.stringify(response) };
}

const responses = [
  {
    method: "GET",
    path: "/v1/workspaces/team%2Fmain/commitments?cursor=cursor%2F1&limit=1",
    response: json({
      contractVersion: "tasq.hosted-commitment-page.v1",
      requestId: "request-list",
      decisionId: "decision-list",
      evaluatedAt: 1900000000000,
      items: [{
        id: "commitment-1",
        workspaceId: "team/main",
        title: "Replay the registry client",
        status: "open",
        revision: 3,
        createdAt: 1900000000000,
        updatedAt: 1900000000001,
      }],
      nextCursor: null,
    }),
  },
  {
    method: "GET",
    path: "/v1/workspaces/team%2Fmain/events?after=2&limit=1",
    response: json({
      contractVersion: "tasq.hosted-event-metadata-page.v1",
      requestId: "request-events",
      decisionId: "decision-events",
      evaluatedAt: 1900000000002,
      items: [{
        id: "event-3",
        sequence: 3,
        entityType: "commitment",
        entityId: "commitment-1",
        eventType: "commitment.updated",
        actorPrincipalId: "principal-1",
        createdAt: 1900000000002,
      }],
      nextSequence: 3,
    }),
  },
  {
    method: "GET",
    path: "/v1/operations",
    response: json({
      contractVersion: "tasq.hosted-operation-catalog.v1",
      operations: [{
        id: "commitment.complete",
        actionUri: "urn:tasq:action:commitment.complete",
        summary: "Complete a commitment",
        inputContract: { uri: "urn:tasq:input:complete", version: 1, implementationDigest: digest },
        outputContract: { uri: "urn:tasq:output:complete", version: 1, implementationDigest: digest },
        requiresExpectedRevision: true,
        action: { uri: "urn:tasq:action:complete", version: 1, implementationDigest: digest },
        resourceKinds: ["commitment"],
        senderConstraint: "authenticated",
        eligibility: "authorized",
      }],
    }),
  },
  {
    method: "POST",
    path: "/v1/workspaces/team%2Fmain/operations/commitment.complete",
    idempotencyKey: fixtureRetryIdentity,
    requestId: "request-mutation",
    body: {
      contractVersion: "tasq.hosted-mutation-request.v1",
      resource: { kind: "commitment", id: "commitment-1" },
      expectedRevision: 3,
      input: { note: "verified" },
    },
    response: json({
      contractVersion: "tasq.hosted-mutation-response.v1",
      requestId: "request-mutation",
      decisionId: "decision-mutation",
      evaluatedAt: 1900000000003,
      authorityRevision: 4,
      outcome: {
        contractVersion: "tasq.hosted-mutation-outcome.v1",
        workspaceId: "team/main",
        operationId: "commitment.complete",
        requestDigest: digest,
        idempotencyKeyDigest: digest,
        resultType: "commitment",
        resultId: "commitment-1",
        resultRevision: 4,
        eventSequence: 4,
        replayed: false,
        result: { status: "done" },
      },
    }),
  },
  {
    method: "GET",
    path: "/v1/workspaces/team%2Fmain/commitments/missing",
    response: json({
      contractVersion: "tasq.hosted-problem.v1",
      code: "authority_busy",
      requestId: "request-error",
      decisionId: "decision-error",
    }, 503),
  },
];

const server = createServer(async (request, response) => {
  const expected = responses[requests.length];
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const rawBody = Buffer.concat(chunks).toString("utf8");
  requests.push({
    method: request.method,
    path: request.url,
    authorization: request.headers.authorization,
    requestId: request.headers["x-tasq-request-id"],
    idempotencyKey: request.headers["idempotency-key"],
    body: rawBody ? JSON.parse(rawBody) : null,
  });
  if (!expected
    || request.method !== expected.method
    || request.url !== expected.path
    || request.headers.authorization !== "Bearer opaque-access-token"
    || (expected.requestId && request.headers["x-tasq-request-id"] !== expected.requestId)
    || (expected.idempotencyKey && request.headers["idempotency-key"] !== expected.idempotencyKey)
    || (expected.body && JSON.stringify(JSON.parse(rawBody)) !== JSON.stringify(expected.body))) {
    response.writeHead(418, { "content-type": "application/json" });
    response.end(JSON.stringify({
      contractVersion: "tasq.hosted-problem.v1",
      code: "mock_contract_violation",
      requestId: "mock-contract-violation",
    }));
    return;
  }
  response.writeHead(expected.response.status, {
    "content-type": "application/json",
    connection: "close",
  });
  response.end(expected.response.body);
});
server.requestTimeout = 2_000;
server.headersTimeout = 2_000;
server.keepAliveTimeout = 1;
server.maxRequestsPerSocket = 1;
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});

try {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("mock server did not bind TCP");
  const client = createRemoteTasq({
    endpoint: "http://127.0.0.1:" + address.port + "/",
    workspaceId: "team/main",
    accessToken: "opaque-access-token",
    requestIdFactory: () => requestIds[requestIdIndex++],
  });
  const commitments = await client.listCommitments({ cursor: "cursor/1", limit: 1 });
  const events = await client.listEvents({ afterSequence: 2, limit: 1 });
  const operations = await client.listOperations();
  const outcome = await client.executeOperation("commitment.complete", {
    resource: { kind: "commitment", id: "commitment-1" },
    expectedRevision: 3,
    input: { note: "verified" },
    idempotencyKey: fixtureRetryIdentity,
    requestId: "request-mutation",
  });
  let typedError;
  try {
    await client.getCommitment("missing");
  } catch (error) {
    if (!(error instanceof TasqRemoteError)) throw error;
    typedError = {
      name: error.name,
      status: error.status,
      code: error.code,
      requestId: error.requestId,
      retryable: error.retryable,
    };
  }
  if (!typedError) throw new Error("expected a typed remote error");
  process.stdout.write(JSON.stringify({
    runtime,
    contractVersion: client.contractVersion,
    commitments: commitments.items.map((item) => item.id),
    events: events.items.map((item) => item.sequence),
    operations: operations.operations.map((item) => item.id),
    outcome: {
      operationId: outcome.operationId,
      resultRevision: outcome.resultRevision,
      replayed: outcome.replayed,
    },
    typedError,
    requests,
  }));
} finally {
  await new Promise((resolve) => server.close(resolve));
  server.closeAllConnections?.();
}
`, "utf8");

      for (const runtime of [
        { name: "node", command: ["npx", "--yes", "node@22", scenario, "node"] },
        { name: "bun", command: [process.execPath, "run", scenario, "bun"] },
      ]) {
        const result = await run(runtime.command, consumer);
        expect(result.exitCode, `${runtime.name}: ${result.stderr || result.stdout}`).toBe(0);
        const output = JSON.parse(result.stdout);
        expect(output).toMatchObject({
          runtime: runtime.name,
          contractVersion: "tasq.remote-client.v1",
          commitments: ["commitment-1"],
          events: [3],
          operations: ["commitment.complete"],
          outcome: {
            operationId: "commitment.complete",
            resultRevision: 4,
            replayed: false,
          },
          typedError: {
            name: "TasqRemoteError",
            status: 503,
            code: "authority_busy",
            requestId: "request-error",
            retryable: true,
          },
        });
        expect(output.requests).toHaveLength(5);
        expect(output.requests[3]).toMatchObject({
          requestId: "request-mutation",
          idempotencyKey: fixtureRetryIdentity,
        });
      }
    },
  );
});

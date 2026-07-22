/** TQ-606 — black-box public-entrypoint adoption across human and agent consumers. */

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

setDefaultTimeout(180_000);

const roots: string[] = [];
const productRoot = resolve(import.meta.dir, "../..");
const builder = join(productRoot, "scripts/release/build-public-release.ts");
const sourceCommit = "0123456789abcdef0123456789abcdef01234567";
const target = process.platform === "darwin" && process.arch === "arm64"
  ? "darwin-arm64"
  : process.platform === "linux" && process.arch === "x64"
    ? "linux-x64-gnu"
    : null;

type Run = { exitCode: number; stdout: string; stderr: string };
type Selector = {
  outputContract: string;
  mutates: boolean;
  requiredCapability: "read" | "propose" | "coordinate";
  parameterNames: string[];
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function selector(
  outputContract: string,
  mutates: boolean,
  requiredCapability: Selector["requiredCapability"],
  parameterNames: string[] = [],
): Selector {
  return { outputContract, mutates, requiredCapability, parameterNames };
}

function action(selected: Selector, replacements: Record<string, string> = {}) {
  return { selector: selected, replacements };
}

async function run(
  executable: string,
  args: string[],
  options: { cwd: string; home?: string; stdin?: string } ,
): Promise<Run> {
  const child = Bun.spawn([executable, ...args], {
    cwd: options.cwd,
    env: {
      PATH: process.env.PATH ?? "",
      ...(options.home ? { TASQ_HOME: options.home } : {}),
      NO_COLOR: "1",
    },
    stdin: options.stdin === undefined ? "ignore" : "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (options.stdin !== undefined) {
    const stdin = child.stdin;
    if (stdin === undefined) {
      throw new Error("spawned adoption client did not expose the requested stdin pipe");
    }
    stdin.write(options.stdin);
    stdin.end();
  }
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

async function ok(
  executable: string,
  args: string[],
  options: Parameters<typeof run>[2],
): Promise<string> {
  const result = await run(executable, args, options);
  expect(result, `${basename(executable)} ${args.join(" ")}`).toMatchObject({ exitCode: 0, stderr: "" });
  return result.stdout;
}

function releasePaths(directory: string, version: string) {
  const name = `tasq-v${version}-${target}`;
  return {
    archive: join(directory, `${name}.tar.gz`),
    checksums: join(directory, `${name}.SHA256SUMS`),
    installer: join(directory, `${name}.install.ts`),
    manifest: join(directory, `${name}.release.json`),
  };
}

async function buildCandidate(directory: string): Promise<ReturnType<typeof releasePaths>> {
  const version = "0.1.0";
  await ok(process.execPath, [
    builder,
    "--version", version,
    "--source-commit", sourceCommit,
    "--target", target!,
    "--outdir", directory,
  ], { cwd: productRoot });
  const paths = releasePaths(directory, version);
  await chmod(paths.installer, 0o755);
  return paths;
}

async function installCandidate(
  release: ReturnType<typeof releasePaths>,
  prefix: string,
  cwd: string,
): Promise<string> {
  const installed = JSON.parse(await ok(release.installer, [
    "install",
    "--archive", release.archive,
    "--manifest", release.manifest,
    "--checksums", release.checksums,
    "--prefix", prefix,
  ], { cwd }));
  expect(installed).toMatchObject({
    contractVersion: "tasq.lifecycle-result.v1",
    status: "installed",
    version: "0.1.0",
    dataDisposition: "external-not-managed",
  });
  return join(prefix, "bin", "tasq");
}

async function runJsonClient(
  executable: string,
  request: unknown,
  cwd: string,
  home: string,
): Promise<any> {
  const output = await ok(executable, [], { cwd, home, stdin: JSON.stringify(request) });
  return JSON.parse(output);
}

async function firstLine(stream: ReadableStream<Uint8Array>): Promise<{
  line: string;
  reader: ReadableStreamDefaultReader<Uint8Array>;
}> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (!text.includes("\n")) {
    const chunk = await reader.read();
    if (chunk.done) throw new Error(`Console ended before its listener announcement: ${text}`);
    text += decoder.decode(chunk.value, { stream: true });
  }
  return { line: text.slice(0, text.indexOf("\n")), reader };
}

describe.skipIf(target === null)("TQ-606 blind public adoption", () => {
  test("takes an unbriefed human and agent from public pointer to one recovered Console ledger", async () => {
    const root = await mkdtemp(join(tmpdir(), "tasq-tq606-"));
    roots.push(root);
    const releaseDirectory = join(root, "release");
    const prefix = join(root, "installed");
    const home = join(root, "ledger");
    const publicEntry = join(root, "public-entry");
    const humanCwd = join(root, "human-session");
    const agentCwd = join(root, "agent-session");
    await Promise.all([
      mkdir(publicEntry, { recursive: true }),
      mkdir(humanCwd, { recursive: true }),
      mkdir(agentCwd, { recursive: true }),
    ]);

    const adoptionPath = join(publicEntry, "adopt.json");
    const schemaPath = join(publicEntry, "public-adoption.v1.schema.json");
    const humanClient = join(humanCwd, "human-shell-proxy.py");
    const agentClient = join(agentCwd, "unknown-agent.mjs");
    await Promise.all([
      copyFile(join(productRoot, "apps/site/public/adopt.json"), adoptionPath),
      copyFile(join(productRoot, "apps/site/public/schemas/public-adoption.v1.schema.json"), schemaPath),
      copyFile(join(import.meta.dir, "fixtures/discovery-recipe-client.py"), humanClient),
      copyFile(join(import.meta.dir, "fixtures/public-adoption-client.mjs"), agentClient),
    ]);
    await Promise.all([chmod(humanClient, 0o755), chmod(agentClient, 0o755)]);

    const adoption = JSON.parse(await readFile(adoptionPath, "utf8"));
    expect(adoption).toMatchObject({
      contractVersion: "tasq.public-adoption.v1",
      support: "implemented_candidate_not_published",
      distribution: {
        mode: "source_build",
        published: false,
        repositoryAccess: "public",
        preconditions: [],
        sourceRefMutable: true,
        integrity: { kind: "repository-contract-digests" },
      },
      human: { path: "/docs/getting-started/", primaryAction: "build_from_source" },
      agent: { executableRelativePath: "dist/cli/index.js" },
    });
    expect(adoption.distribution.integrity.sourceContracts).toHaveLength(3);
    expect(adoption.invariants).toContain("device_time_is_not_authority");
    expect(adoption.invariants).not.toContain("private_prelaunch_repository_requires_authorized_access");

    // Candidate bytes model the future protected download without claiming
    // that these workstation-generated bytes are published.
    const release = await buildCandidate(releaseDirectory);
    const cli = await installCandidate(release, prefix, publicEntry);
    expect((await ok(cli, ["--version"], { cwd: publicEntry, home })).trim()).toBe("0.1.0");

    const workspace = "adoption/robotics-team";
    const resourceKey = "robot:arm-a";
    const humanPointer = adoption.agent.onboardArgvTemplate.map((part: string) => ({
      "{tasqExecutable}": cli,
      "{workspaceId}": workspace,
      "{actorLabel}": "human:operator",
    })[part] ?? part);

    const humanStart = await runJsonClient(humanClient, {
      pointerArgv: humanPointer,
      actions: [
        action(selector("tasq.context-packet.v1", false, "read")),
        action(selector("tasq.cli-json.v1/TaskV1", true, "propose", ["title"]), {
          "{title}": "Calibrate arm A with inspectable evidence",
        }),
      ],
    }, humanCwd, home);
    expect(humanStart.bootstrap.stdout).toMatchObject({
      contractVersion: "tasq.autonomous-bootstrap.v1",
      disposition: "created",
      space: { workspaceId: workspace },
      actor: { alias: "human:operator" },
    });
    expect(humanStart.results.map((result: any) => result.selectedRecipeId)).toEqual([
      "context.read", "commitment.propose",
    ]);
    const commitment = humanStart.results[1].stdout;

    const humanLeaseSession = await runJsonClient(humanClient, {
      pointerArgv: humanPointer,
      actions: [
        action(selector("tasq.resource-world.v1", false, "read")),
        action(selector("tasq.resource-operation.v1", true, "coordinate", [
          "resourceKey", "duration", "idempotencyKey",
        ]), {
          "{resourceKey}": resourceKey,
          "{duration}": "30m",
          "{idempotencyKey}": "human-acquire-1",
        }),
      ],
    }, humanCwd, home);
    const humanLease = humanLeaseSession.results[1].stdout.lease;
    expect(humanLease).toMatchObject({ holderActor: "human:operator", resourceKey, fence: 1 });

    const agentBase = {
      manifestPath: adoptionPath,
      cwd: agentCwd,
      onboardReplacements: {
        "{tasqExecutable}": cli,
        "{workspaceId}": workspace,
        "{actorLabel}": "agent:builder",
      },
    };
    const contended = await runJsonClient(agentClient, {
      ...agentBase,
      actions: [
        action(selector("tasq.context-packet.v1", false, "read")),
        action(selector("tasq.resource-world.v1", false, "read")),
        action(selector("tasq.resource-operation.v1", true, "coordinate", [
          "resourceKey", "duration", "idempotencyKey",
        ]), {
          "{resourceKey}": resourceKey,
          "{duration}": "30m",
          "{idempotencyKey}": "agent-contended-1",
        }),
      ],
    }, agentCwd, home);
    expect(contended.manifestContract).toBe("tasq.public-adoption.v1");
    expect(contended.bootstrap.stdout).toMatchObject({ disposition: "joined", actor: { alias: "agent:builder" } });
    expect(contended.results[2]).toMatchObject({
      selectedRecipeId: "resource.acquire",
      exitCode: 1,
      stderr: "",
      stdout: {
        contractVersion: "tasq.resource-problem.v1",
        code: "contended",
        retryable: true,
        currentLease: { lease: { holderActor: "human:operator", fence: 1 } },
      },
    });

    const humanRelease = await runJsonClient(humanClient, {
      pointerArgv: humanPointer,
      actions: [action(selector("tasq.resource-operation.v1", true, "coordinate", [
        "resourceKey", "leaseId", "fence", "revision", "idempotencyKey",
      ]), {
        "{resourceKey}": resourceKey,
        "{leaseId}": humanLease.id,
        "{fence}": String(humanLease.fence),
        "{revision}": String(humanLease.revision),
        "{idempotencyKey}": "human-release-1",
      })],
    }, humanCwd, home);
    expect(humanRelease.results[0].stdout).toMatchObject({ disposition: "released" });

    const recovered = await runJsonClient(agentClient, {
      ...agentBase,
      actions: [action(selector("tasq.resource-operation.v1", true, "coordinate", [
        "resourceKey", "duration", "idempotencyKey",
      ]), {
        "{resourceKey}": resourceKey,
        "{duration}": "30m",
        "{idempotencyKey}": "agent-recovery-1",
      })],
    }, agentCwd, home);
    const agentLease = recovered.results[0].stdout.lease;
    expect(agentLease).toMatchObject({ holderActor: "agent:builder", resourceKey, fence: 2 });

    const verifiedAndStarted = await runJsonClient(agentClient, {
      ...agentBase,
      actions: [
        action(selector("tasq.resource-fence.v1", false, "coordinate", [
          "resourceKey", "leaseId", "fence",
        ]), {
          "{resourceKey}": resourceKey,
          "{leaseId}": agentLease.id,
          "{fence}": String(agentLease.fence),
        }),
        action(selector("tasq.cli-json.v1/TaskClaimV1", true, "coordinate", [
          "commitmentId", "duration",
        ]), {
          "{commitmentId}": commitment.id,
          "{duration}": "30m",
        }),
        action(selector("tasq.cli-json.v1/TaskV1", true, "coordinate", [
          "commitmentId", "startNote",
        ]), {
          "{commitmentId}": commitment.id,
          "{startNote}": "Authority verified; calibration started",
        }),
      ],
    }, agentCwd, home);
    expect(verifiedAndStarted.results.map((result: any) => result.selectedRecipeId)).toEqual([
      "resource.verify", "commitment.claim", "commitment.start",
    ]);
    expect(verifiedAndStarted.results[0].stdout).toMatchObject({ status: "valid", fence: 2 });

    const evidenceRun = await runJsonClient(agentClient, {
      ...agentBase,
      actions: [action(selector("tasq.cli-json.v1/TaskEvidenceV1", true, "coordinate", [
        "commitmentId", "kind", "summary",
      ]), {
        "{commitmentId}": commitment.id,
        "{kind}": "calibration-report",
        "{summary}": "Synthetic acceptance fixture: arm A calibration remained inside tolerance",
      })],
    }, agentCwd, home);
    const evidence = evidenceRun.results[0].stdout;
    const completed = await runJsonClient(agentClient, {
      ...agentBase,
      actions: [action(selector("tasq.cli-json.v1/TaskV1", true, "coordinate", [
        "commitmentId", "evidenceIdsCsv", "completionNote", "evidenceSource",
      ]), {
        "{commitmentId}": commitment.id,
        "{evidenceIdsCsv}": evidence.id,
        "{completionNote}": "Calibration evidence accepted",
        "{evidenceSource}": "tq606-synthetic-fixture",
      })],
    }, agentCwd, home);
    expect(completed.results[0]).toMatchObject({ selectedRecipeId: "commitment.complete", exitCode: 0 });
    expect(completed.results[0].stdout).toMatchObject({ id: commitment.id, status: "done" });

    const consoleProcess = Bun.spawn([
      cli, "web", "--tenant", workspace, "--host", "127.0.0.1", "--port", "0", "--json",
    ], {
      cwd: publicEntry,
      env: { PATH: process.env.PATH ?? "", TASQ_HOME: home, NO_COLOR: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const consoleStderr = new Response(consoleProcess.stderr).text();
    const startup = await firstLine(consoleProcess.stdout);
    const listener = JSON.parse(startup.line);
    expect(listener).toMatchObject({
      contractVersion: "tasq.console-listener.v1",
      workspaceId: workspace,
      process: { mode: "foreground", pid: consoleProcess.pid },
    });
    const baseUrl = listener.endpoint.url as string;
    const [html, work, actors, resources, runtime, detail] = await Promise.all([
      fetch(baseUrl).then((response) => response.text()),
      fetch(`${baseUrl}/api/console/work?limit=100`).then((response) => response.json()),
      fetch(`${baseUrl}/api/console/actors?limit=100`).then((response) => response.json()),
      fetch(`${baseUrl}/api/console/resources?limit=100`).then((response) => response.json()),
      fetch(`${baseUrl}/api/console/runtime`).then((response) => response.json()),
      fetch(`${baseUrl}/api/commitments/${commitment.id}`).then((response) => response.json()),
    ]);
    expect(html).toContain("Enabled actors</dt><dd>2");
    expect(JSON.stringify(work)).not.toContain(commitment.id);
    expect(detail).toMatchObject({
      contractVersion: "tasq.inspect.v1",
      commitment: { id: commitment.id, title: "Calibrate arm A with inspectable evidence", status: "done" },
    });
    expect(JSON.stringify(actors)).toContain("human:operator");
    expect(JSON.stringify(actors)).toContain("agent:builder");
    expect(JSON.stringify(resources)).toContain(resourceKey);
    expect(JSON.stringify(resources)).toContain('"fence":2');
    expect(runtime).toEqual(listener);

    const status = JSON.parse(await ok(cli, [
      "web", "status", "--tenant", workspace, "--json",
    ], { cwd: agentCwd, home }));
    expect(status).toMatchObject({ state: "running", descriptor: { instanceId: listener.instanceId } });
    consoleProcess.kill("SIGTERM");
    expect(await consoleProcess.exited).toBe(0);
    await startup.reader.cancel();
    expect(await consoleStderr).toBe("");

    const agentRelease = await runJsonClient(agentClient, {
      ...agentBase,
      actions: [action(selector("tasq.resource-operation.v1", true, "coordinate", [
        "resourceKey", "leaseId", "fence", "revision", "idempotencyKey",
      ]), {
        "{resourceKey}": resourceKey,
        "{leaseId}": agentLease.id,
        "{fence}": String(agentLease.fence),
        "{revision}": String(agentLease.revision),
        "{idempotencyKey}": "agent-release-1",
      })],
    }, agentCwd, home);
    expect(agentRelease.results[0].stdout).toMatchObject({ disposition: "released" });

    const stopped = await run(cli, ["web", "status", "--tenant", workspace, "--json"], {
      cwd: humanCwd,
      home,
    });
    expect(stopped).toMatchObject({ exitCode: 1, stderr: "" });
    expect(JSON.parse(stopped.stdout)).toMatchObject({ state: "stopped", workspaceId: workspace });
  });

  test("keeps the blind harness package-independent and free of device-clock authority", async () => {
    const [testSource, clientSource, certificateRaw] = await Promise.all([
      readFile(import.meta.filename, "utf8"),
      readFile(join(import.meta.dir, "fixtures/public-adoption-client.mjs"), "utf8"),
      readFile(join(productRoot, "TQ-606_ADOPTION_CERTIFICATION.json"), "utf8"),
    ]);
    for (const source of [testSource, clientSource]) {
      expect(source).not.toMatch(/from\s+["']@tasq\//);
      expect(source).not.toMatch(/Date\.now\s*\(/);
      expect(source).not.toMatch(/new\s+Date\s*\(/);
      expect(source).not.toMatch(/performance\.now\s*\(/);
    }
    expect(clientSource).not.toContain("packages/tasq");
    expect(clientSource).not.toContain("recipe.id ===");
    expect(JSON.parse(certificateRaw)).toMatchObject({
      contractVersion: "tasq.public-adoption-certification.v1",
      status: "candidate-certified-external-gates-pending",
      repositoryAccess: {
        state: "public-alpha",
        requiredPrecondition: null,
        publicSourceLaunchAuthorized: true,
      },
      publishedArtifactEvidence: {
        status: "not-run-no-public-release-exists",
        blockedBy: "TQ-603-first-protected-release",
      },
      independentHumanEvidence: { status: "not-run-automated-path-only" },
      tq606Complete: false,
    });
  });
});

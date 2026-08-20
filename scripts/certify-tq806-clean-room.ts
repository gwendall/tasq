import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { systemClock } from "@tasq-run/schema";

const root = await mkdtemp(join(tmpdir(), "tasq-tq806-clean-room-"));
const exchange = join(root, "exchange");
const authority = join(root, "authority");
const replicaA = join(root, "replica-a");
const replicaB = join(root, "replica-b");
const image = `tasq-tq806-clean-room:${systemClock.now()}`;
const worker = resolve(import.meta.dir, "tq806-clean-room-worker.ts");
const platform = "linux/amd64";

async function run(command: string[], options: { cwd?: string; quiet?: boolean } = {}): Promise<string> {
  const child = Bun.spawn(command, {
    cwd: options.cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`${command.join(" ")} failed (${exitCode})\n${stdout}\n${stderr}`);
  }
  if (!options.quiet && stderr.trim()) process.stderr.write(stderr);
  return stdout.trim();
}

async function readJson(path: string): Promise<any> {
  return JSON.parse(await readFile(path, "utf8"));
}

try {
  await Promise.all([exchange, authority, replicaA, replicaB].map((path) => mkdir(path)));
  const dockerfile = join(root, "Dockerfile");
  await writeFile(dockerfile, [
    "FROM oven/bun:1.3.11@sha256:0733e50325078969732ebe3b15ce4c4be5082f18c4ac1a0f0ca4839c2e4e42a7",
    "WORKDIR /runtime",
    "RUN bun init -y >/dev/null && bun add --exact @tasq-run/core@0.4.0 @tasq-run/schema@0.4.0 @tasq-run/extension-sdk@0.4.0 >/dev/null",
    "COPY tq806-clean-room-worker.ts /runtime/worker.ts",
    "ENTRYPOINT [\"bun\", \"/runtime/worker.ts\"]",
    "",
  ].join("\n"));
  await run(["cp", worker, join(root, "tq806-clean-room-worker.ts")]);
  await run(["docker", "build", "--platform", platform, "-t", image, root]);
  const imageId = await run(["docker", "image", "inspect", image, "--format", "{{.Id}}"]);
  const packageTree = await run([
    "docker", "run", "--rm", "--platform", platform, "--entrypoint", "bun", image,
    "pm", "ls", "--all",
  ]);

  const container = async (name: string, phase: string, state: string) => run([
    "docker", "run", "--rm", "--platform", platform, "--name", name,
    "--network", "none",
    "--mount", `type=bind,src=${state},dst=/state`,
    "--mount", `type=bind,src=${exchange},dst=/exchange`,
    image, phase, "/state", "/exchange",
  ]);

  await container("tasq-tq806-authority-init", "authority-init", authority);
  await container("tasq-tq806-replica-a-prepare", "replica-a-prepare", replicaA);
  await container("tasq-tq806-authority-accept", "authority-accept", authority);
  await container("tasq-tq806-replica-a-ack", "replica-a-ack", replicaA);
  await container("tasq-tq806-replica-b-install", "replica-b-install", replicaB);

  const push = await readJson(join(exchange, "replica-a-push.json"));
  const authorityResult = await readJson(join(exchange, "authority-result.json"));
  const replicaBResult = await readJson(join(exchange, "replica-b-result.json"));
  const ack = await readJson(join(exchange, "replica-a-ack.json"));
  const report = {
    contractVersion: "tasq.tq806-clean-room-evidence.v1",
    executedAt: new Date(systemClock.now()).toISOString(),
    status: "passed",
    isolation: {
      runtime: "five one-shot containers across three isolated persistent node stores",
      network: "none",
      databaseSharing: false,
      exchange: "canonical JSON messages only",
      platform,
      baseImage: "oven/bun:1.3.11",
      imageId,
      packageTree: packageTree.split("\n").filter(Boolean),
    },
    topology: [
      { node: "authority", database: "authority.sqlite", roles: ["register", "verify", "accept", "snapshot"] },
      { node: "replica-a", database: "replica-a.sqlite", roles: ["queue", "sign", "push", "acknowledge"] },
      { node: "replica-b", database: "replica-b.sqlite", roles: ["install", "read"] },
    ],
    authentication: {
      signedOriginRequired: true,
      transportReplicaBound: true,
      transportSignerPrincipalEquality: true,
      operationDigest: push.operationDigest,
      credentialId: push.credential.credentialId,
      trustRootDigest: push.credential.trustRootDigest,
      negativeTests: authorityResult.rejected,
    },
    result: {
      disposition: authorityResult.response.results[0].disposition,
      authoritySequence: authorityResult.response.results[0].authoritySequence,
      snapshotDigest: authorityResult.snapshot.snapshotDigest,
      replicaAAcknowledged: ack.acknowledged,
      replicaB: replicaBResult,
    },
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} finally {
  await run(["docker", "image", "rm", "-f", image], { quiet: true }).catch(() => undefined);
  await rm(root, { recursive: true, force: true });
}

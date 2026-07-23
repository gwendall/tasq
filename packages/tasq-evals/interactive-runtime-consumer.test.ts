/** TQ-320 candidate: package-installed interactive runtime conformance. */

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

setDefaultTimeout(240_000);

const roots: string[] = [];
const productRoot = resolve(import.meta.dir, "../..");
const builder = join(productRoot, "scripts/release/build-public-packages.ts");
const sourceCommit = "0123456789abcdef0123456789abcdef01234567";
const version = "0.1.0-tq320.1";
const publishedNpmVersion = process.env.TASQ_PUBLISHED_NPM_VERSION?.replace(/^v/, "");

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function run(command: string[], cwd: string, stdin?: string) {
  const child = Bun.spawn(command, {
    cwd,
    env: { PATH: process.env.PATH ?? "", NO_COLOR: "1" },
    stdin: stdin === undefined ? "ignore" : "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (stdin !== undefined) {
    const input = child.stdin;
    if (input === undefined) throw new Error("spawned runtime fixture did not expose stdin");
    input.write(stdin);
    input.end();
  }
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

describe("TQ-320 interactive runtime candidate", () => {
  test("survives pause, crash, reclaim and multi-run resume from installed package candidates", async () => {
    const root = await mkdtemp(join(tmpdir(), "tasq-tq320-"));
    roots.push(root);
    const packages = join(root, "packages");
    const consumer = join(root, "consumer");
    await mkdir(consumer, { recursive: true });

    const wanted = ["@tasq-run/schema", "@tasq-run/extension-sdk", "@tasq-run/core"];
    let dependencies: Record<string, string>;
    if (publishedNpmVersion === undefined) {
      const built = await run([
        process.execPath,
        builder,
        "--version", version,
        "--source-commit", sourceCommit,
        "--outdir", packages,
      ], productRoot);
      expect(built, built.stderr).toMatchObject({ exitCode: 0, stderr: "" });
      const release = JSON.parse(await readFile(
        join(packages, `tasq-packages-v${version}.release.json`),
        "utf8",
      ));
      dependencies = Object.fromEntries(wanted.map((name) => {
        const archive = release.packages.find((item: { name: string }) => item.name === name);
        return [name, `file:${join(packages, archive.filename)}`];
      }));
    } else {
      dependencies = Object.fromEntries(wanted.map((name) => [name, publishedNpmVersion]));
    }
    await writeFile(join(consumer, "package.json"), `${JSON.stringify({
      private: true,
      type: "module",
      dependencies,
    }, null, 2)}\n`, "utf8");
    const installed = await run([
      "npm", "install", "--ignore-scripts", "--no-audit", "--no-fund", "--no-package-lock",
    ], consumer);
    expect(installed.exitCode, installed.stderr || installed.stdout).toBe(0);

    const fixture = join(consumer, "interactive-runtime-client.ts");
    await copyFile(join(import.meta.dir, "fixtures/interactive-runtime-client.ts"), fixture);
    const prepared = await run([
      process.execPath, "run", fixture,
    ], consumer, JSON.stringify({ phase: "prepare", dbPath: join(root, "runtime.sqlite") }));
    expect(prepared, prepared.stderr).toMatchObject({ exitCode: 0, stderr: "" });
    const checkpoint = JSON.parse(prepared.stdout);
    expect(checkpoint.contractVersion).toBe("tasq.interactive-runtime-checkpoint.v1");
    expect(checkpoint.assignment).toBe("accepted");
    expect(typeof checkpoint.persistedCursor).toBe("number");
    expect(checkpoint.runtimeLookup).toMatchObject({
      externalId: "run-001", contextId: "conversation-001",
    });

    // A distinct adapter process receives only the durable checkpoint and runtime lookup.
    const resumed = await run([
      process.execPath, "run", fixture,
    ], consumer, JSON.stringify({ phase: "resume", checkpoint }));
    expect(resumed, resumed.stderr).toMatchObject({ exitCode: 0, stderr: "" });
    expect(JSON.parse(resumed.stdout)).toEqual({
      contractVersion: "tasq.interactive-runtime-candidate.v1",
      status: "candidate-certified-publication-gate-pending",
      workspaceId: "runtime/conformance",
      assignment: "accepted",
      processRestarts: 1,
      attempts: 2,
      conversations: 1,
      runs: 2,
      firstClaimFence: 1,
      replacementClaimFence: 2,
      staleClaimRejected: true,
      staleEffectClaimRejected: true,
      staleEffectFenceRejected: true,
      artifactDistinctFromEvidence: true,
      resumedAfterSequence: expect.any(Number),
      finalStatus: "done",
    });
  });

  test("keeps the external fixture checkout-independent and authority-time neutral", async () => {
    const [source, certificate] = await Promise.all([
      readFile(join(import.meta.dir, "fixtures/interactive-runtime-client.ts"), "utf8"),
      readFile(join(productRoot, "docs/contracts/TQ-320_INTERACTIVE_RUNTIME_CERTIFICATION.json"), "utf8"),
    ]);
    expect(source).not.toContain("packages/tasq");
    expect(source).not.toContain("Denshin");
    expect(source).not.toMatch(/Date\.now\s*\(/);
    expect(source).not.toMatch(/new\s+Date\s*\(/);
    expect(source).not.toMatch(/performance\.now\s*\(/);
    expect(JSON.parse(certificate)).toMatchObject({
      contractVersion: "tasq.interactive-runtime-certification.v1",
      status: "published-package-certified",
      publishedArtifactEvidence: {
        status: "passed",
        release: "https://github.com/gwendall/tasq/releases/tag/v0.1.0",
        workflowRun: "https://github.com/gwendall/tasq/actions/runs/30015923266",
      },
      tq320Complete: true,
    });
  });
});

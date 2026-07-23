import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync as readFileSyncNative } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");
const verifier = resolve(root, "scripts/release/verify-npm-publication.ts");
const sourceCommit = "0123456789abcdef0123456789abcdef01234567";
const bytes = new TextEncoder().encode("deterministic package bytes");
const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;

function registryMetadata(overrides: Record<string, unknown> = {}) {
  return {
    name: "@tasq-run/cli",
    version: "0.1.0-alpha.0",
    gitHead: sourceCommit,
    repository: {
      type: "git",
      url: "git+https://github.com/gwendall/tasq.git",
    },
    dist: {
      integrity,
      tarball: "https://registry.npmjs.org/@tasq-run/cli/-/cli-0.1.0-alpha.0.tgz",
    },
    ...overrides,
  };
}

describe("one-shot npm identity bootstrap", () => {
  test("accepts only the exact registry bytes, source commit and canonical repository", async () => {
    const scratch = await mkdtemp(`${tmpdir()}/tasq-npm-verification-`);
    const tarball = resolve(scratch, "candidate.tgz");
    await writeFile(tarball, bytes);
    let metadata = registryMetadata();
    const registry = Bun.serve({
      port: 0,
      fetch: () => Response.json(metadata),
    });
    async function verify() {
      const child = Bun.spawn([
        process.execPath,
        verifier,
        "--package", "@tasq-run/cli",
        "--version", "0.1.0-alpha.0",
        "--source-commit", sourceCommit,
        "--tarball", tarball,
      ], {
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, npm_config_registry: registry.url.toString() },
      });
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      return { exitCode, stdout, stderr };
    }

    const accepted = await verify();
    expect(accepted.exitCode, accepted.stderr).toBe(0);
    expect(JSON.parse(accepted.stdout)).toEqual({
      contractVersion: "tasq.npm-publication-verification.v1",
      status: "published",
      package: "@tasq-run/cli",
      version: "0.1.0-alpha.0",
      sourceCommit,
      integrity,
      tarball: "https://registry.npmjs.org/@tasq-run/cli/-/cli-0.1.0-alpha.0.tgz",
    });

    for (const invalid of [
      registryMetadata({ gitHead: "a".repeat(40) }),
      registryMetadata({ repository: { url: "https://example.com/not-tasq" } }),
      registryMetadata({ dist: { integrity: "sha512-wrong", tarball: "https://registry.npmjs.org/wrong.tgz" } }),
    ]) {
      metadata = invalid;
      expect((await verify()).exitCode).not.toBe(0);
    }
    registry.stop(true);
    await rm(scratch, { recursive: true, force: true });
  }, 20_000);

  test("keeps first publication manual, protected, provenance-bound and resumable", () => {
    const workflow = readFileSyncNative(resolve(root, ".github/workflows/bootstrap-npm.yml"), "utf8");
    const releaseWorkflow = readFileSyncNative(resolve(root, ".github/workflows/release.yml"), "utf8");
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).not.toContain("\n  push:");
    expect(workflow).toContain("test \"$GITHUB_REF\" = \"refs/heads/main\"");
    expect(workflow).toContain("test \"$(git rev-parse origin/main)\"");
    expect(workflow).toContain("environment: release");
    expect(workflow).toContain("secrets.NPM_BOOTSTRAP_TOKEN");
    expect(workflow).toContain("--version 0.1.0-alpha.0");
    expect(workflow).toContain("--tag alpha-bootstrap");
    expect(workflow).toContain("--provenance");
    expect(workflow).toContain("--allow-missing");
    expect(workflow).toContain("npm@11.18.0");
    expect(releaseWorkflow).toContain("npm@11.18.0");
    expect(releaseWorkflow).not.toContain("NPM_BOOTSTRAP_TOKEN");
  });
});

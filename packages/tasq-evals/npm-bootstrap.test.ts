import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
    expect(workflow).toContain("TASQ_BOOTSTRAP_PACKAGES:");
    expect(workflow).toContain('test "$handled" = "7"');
    expect(workflow).toContain('index($package) != null');
    expect(workflow).not.toContain("@tasq-run/client");
    expect(releaseWorkflow).toContain("npm@11.18.0");
    expect(releaseWorkflow).not.toContain("NPM_BOOTSTRAP_TOKEN");
  });

  test("treats only an explicit registry 404 as an absent npm coordinate", async () => {
    const scratch = await mkdtemp(`${tmpdir()}/tasq-npm-absence-`);
    const tarball = resolve(scratch, "candidate.tgz");
    await writeFile(tarball, bytes);
    let status = 404;
    const registry = Bun.serve({
      port: 0,
      fetch: () => new Response(
        JSON.stringify({ error: status === 404 ? "Not found" : "Unavailable" }),
        { status, headers: { "content-type": "application/json" } },
      ),
    });
    async function verify() {
      const child = Bun.spawn([
        process.execPath,
        verifier,
        "--package", "@tasq-run/client",
        "--version", "0.1.0-alpha.0",
        "--source-commit", sourceCommit,
        "--tarball", tarball,
        "--allow-missing",
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
    const absent = await verify();
    expect(absent.exitCode, absent.stderr).toBe(0);
    expect(JSON.parse(absent.stdout)).toMatchObject({
      status: "missing",
      package: "@tasq-run/client",
    });
    status = 503;
    const unavailable = await verify();
    expect(unavailable.exitCode).not.toBe(0);
    expect(unavailable.stderr).toContain("registry returned HTTP 503");
    registry.stop(true);
    await rm(scratch, { recursive: true, force: true });
  });

  test("repairs the immutable GitHub release asset by asset and fails closed on lookup errors", () => {
    const workflow = readFileSyncNative(resolve(root, ".github/workflows/release.yml"), "utf8");
    expect(workflow).toContain("--allow-missing");
    expect(workflow).not.toContain("npm view");
    expect(workflow).toContain("test \"$state\" = \"missing\" || test \"$state\" = \"published\"");
    expect(workflow).toContain("--write-out '%{http_code}'");
    expect(workflow).toContain('if test "$http_code" = "200"');
    expect(workflow).toContain('elif test "$http_code" = "404"');
    expect(workflow).toContain("GitHub release lookup failed with HTTP");
    expect(workflow).toContain("--json assets,isDraft,isPrerelease,tagName,targetCommitish");
    expect(workflow).toContain('[.assets[] | select(.name == $name)] | length');
    expect(workflow).toContain("gh release upload");
    expect(workflow).toContain("Release contains duplicate asset name");
    expect(workflow).not.toContain("gh release view \"$GITHUB_REF_NAME\" --repo \"$GITHUB_REPOSITORY\" >/dev/null 2>&1");
  });

  test("prepares a separately authorized one-shot bootstrap for only the remote client", async () => {
    const workflow = readFileSyncNative(
      resolve(root, ".github/workflows/bootstrap-npm-client.yml"),
      "utf8",
    );
    expect(workflow).toContain("test \"$GITHUB_REF\" = \"refs/heads/main\"");
    expect(workflow).toContain('test "$(git rev-parse HEAD)" = "$INPUT_SOURCE_COMMIT"');
    expect(workflow).toContain('test "$(git rev-parse origin/main)" = "$INPUT_SOURCE_COMMIT"');
    expect(workflow).toContain("verify-npm-client-bootstrap-authorization.ts");
    expect(workflow).toContain("NPM_CLIENT_BOOTSTRAP_TOKEN");
    expect(workflow).toContain('select(.name == "@tasq-run/client")');
    expect(workflow).toContain("--package @tasq-run/client");
    expect(workflow).toContain("--allow-missing");
    expect(workflow).toContain("--tag alpha-bootstrap");
    expect(workflow).not.toContain("--package @tasq-run/core");
    expect(workflow).not.toContain("NPM_BOOTSTRAP_TOKEN");

    const policy = JSON.parse(await readFile(
      resolve(root, "docs/releases/PUBLIC_RELEASE_POLICY.json"),
      "utf8",
    )) as Record<string, any>;
    const scratch = await mkdtemp(`${tmpdir()}/tasq-client-bootstrap-authorization-`);
    const policyPath = resolve(scratch, "policy.json");
    const commit = "b".repeat(40);
    async function verify(candidate: Record<string, any>) {
      await writeFile(policyPath, `${JSON.stringify(candidate)}\n`, "utf8");
      const child = Bun.spawn([
        process.execPath,
        resolve(root, "scripts/release/verify-npm-client-bootstrap-authorization.ts"),
        "--policy", policyPath,
        "--version", "0.1.0-alpha.0",
        "--source-commit", commit,
        "--repository", "gwendall/tasq",
      ], { stdout: "pipe", stderr: "pipe" });
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      return { exitCode, stdout, stderr };
    }

    const completed = await verify(policy);
    expect(completed.exitCode).not.toBe(0);
    expect(completed.stderr).toContain("authorization state is completed");

    const authorized = structuredClone(policy);
    authorized.npmClientBootstrap.state = "authorized";
    const accepted = await verify(authorized);
    expect(accepted.exitCode, accepted.stderr).toBe(0);
    expect(JSON.parse(accepted.stdout)).toMatchObject({
      contractVersion: "tasq.npm-client-bootstrap-authorization.v1",
      package: "@tasq-run/client",
      version: "0.1.0-alpha.0",
      sourceCommit: commit,
      sourceRef: "refs/heads/main",
      sourceBinding: "protected_main_runtime_commit",
      workflow: "bootstrap-npm-client.yml",
    });

    const pending = structuredClone(policy);
    Object.assign(pending.npmClientBootstrap, {
      state: "prepared_not_authorized",
      decision: "pending",
      authorizedBy: null,
      authorizedAt: null,
    });
    const blocked = await verify(pending);
    expect(blocked.exitCode).not.toBe(0);
    expect(blocked.stderr).toContain("authorization state is prepared_not_authorized");

    for (const [field, value, message] of [
      ["coordinate", "@tasq-run/core", "coordinate drift"],
      ["sourceBinding", "embedded_policy_commit", "source binding drift"],
      ["workflow", "release.yml", "workflow identity drift"],
    ] as const) {
      const hostile = structuredClone(authorized);
      hostile.npmClientBootstrap[field] = value;
      const rejected = await verify(hostile);
      expect(rejected.exitCode).not.toBe(0);
      expect(rejected.stderr).toContain(message);
    }
    await rm(scratch, { recursive: true, force: true });
  });
});

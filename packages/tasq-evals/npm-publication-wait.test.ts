/**
 * A 404 right after `npm publish` means "not yet", not "not published".
 *
 * npm acknowledges a publish before the version is readable. The v0.6.2
 * release asked for @tasq-run/cli in the same second, got 404, and stopped
 * with six packages unpublished. The verification now waits, with a deadline,
 * and the pre-check that expects "missing" still answers at once. Exercised
 * through the real script against a fake registry, the way the workflow runs it.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const productRoot = resolve(import.meta.dir, "../..");
const script = resolve(productRoot, "scripts/release/verify-npm-publication.ts");
const sourceCommit = "29f8c595da10095648e816d785d3bf680a061e8e";
const dir = mkdtempSync(join(tmpdir(), "tasq-npm-wait-"));
const tarball = join(dir, "cli.tgz");
writeFileSync(tarball, "not really a tarball, but bytes with an integrity");
const integrity = `sha512-${createHash("sha512").update(Bun.file(tarball).size ? await Bun.file(tarball).bytes() : new Uint8Array()).digest("base64")}`;

/** A registry that answers the scripted statuses in order, then repeats the last one. */
function registry(statuses: number[]) {
  const seen: number[] = [];
  const server = Bun.serve({
    port: 0,
    fetch() {
      const status = statuses[Math.min(seen.length, statuses.length - 1)]!;
      seen.push(status);
      if (status !== 200) return new Response("", { status });
      return Response.json({
        name: "@tasq-run/cli",
        version: "0.6.2",
        gitHead: sourceCommit,
        repository: { url: "git+https://github.com/gwendall/tasq.git" },
        dist: { integrity, tarball: "https://registry.npmjs.org/@tasq-run/cli/-/cli-0.6.2.tgz" },
      });
    },
  });
  servers.push(server);
  return { seen, url: `http://127.0.0.1:${server.port}/` };
}
const servers: ReturnType<typeof Bun.serve>[] = [];
afterAll(() => { for (const server of servers) server.stop(true); });

async function run(registryUrl: string, ...extra: string[]) {
  const child = Bun.spawn(["bun", script,
    "--package", "@tasq-run/cli", "--version", "0.6.2", "--source-commit", sourceCommit, "--tarball", tarball, ...extra,
  ], { env: { ...process.env, npm_config_registry: registryUrl }, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  return { stdout, stderr, exitCode };
}

describe("npm publication verification waits for the registry", () => {
  test("a version that appears after two 404s is verified", async () => {
    const { seen, url } = registry([404, 404, 200]);
    const result = await run(url, "--wait-seconds", "10", "--initial-delay-ms", "20");
    expect(result.exitCode, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: "published", package: "@tasq-run/cli", version: "0.6.2" });
    expect(seen).toEqual([404, 404, 200]);
  });

  test("a version that never appears fails once the deadline passes, and says how long it waited", async () => {
    const { seen, url } = registry([404]);
    const result = await run(url, "--wait-seconds", "0.3", "--initial-delay-ms", "50");
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("still returned HTTP 404");
    expect(result.stderr).toContain("over 0.3s");
    expect(seen.length).toBeGreaterThan(1);
  });

  test("the pre-check answers missing at once, even when the registry would answer later", async () => {
    const { seen, url } = registry([404, 200]);
    const result = await run(url, "--allow-missing");
    expect(result.exitCode, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: "missing" });
    expect(seen).toEqual([404]);
  });

  test("a registry error that is not transient is reported without retry", async () => {
    const { seen, url } = registry([403]);
    const result = await run(url, "--wait-seconds", "10", "--initial-delay-ms", "20");
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("HTTP 403");
    expect(seen).toEqual([403]);
  });
});

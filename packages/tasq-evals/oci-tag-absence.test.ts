import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");
const script = resolve(root, "scripts/release/require-absent-oci-image.sh");
const fixtures: string[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function inspectResult(output: string, status = 1) {
  const directory = await mkdtemp(join(tmpdir(), "tasq-oci-absence-"));
  fixtures.push(directory);
  const docker = join(directory, "docker");
  await writeFile(
    docker,
    [
      "#!/usr/bin/env bash",
      `printf '%s\\n' ${JSON.stringify(output)}`,
      `exit ${status}`,
      "",
    ].join("\n"),
  );
  await chmod(docker, 0o755);
  return Bun.spawnSync(["bash", script, "registry.example/tasq:v1"], {
    env: { ...process.env, PATH: `${directory}:${process.env.PATH ?? ""}` },
    stdout: "pipe",
    stderr: "pipe",
  });
}

describe("protected OCI tag absence proof", () => {
  test("accepts only an explicitly missing registry manifest", async () => {
    for (const output of [
      "ERROR: registry response: MANIFEST_UNKNOWN",
      "failed to resolve: manifest unknown",
      "HTTP 404: manifest does not exist",
    ]) {
      expect((await inspectResult(output)).exitCode, output).toBe(0);
    }
  });

  test("fails closed on ambiguous local, auth and network failures", async () => {
    for (const output of [
      "docker-credential-helper: executable not found",
      "unauthorized: authentication required",
      "dial tcp: network is unreachable",
      "404 page not found",
    ]) {
      const result = await inspectResult(output);
      expect(result.exitCode, output).not.toBe(0);
      expect(result.stderr.toString()).toContain(
        "Registry lookup failed without an explicit missing-manifest result",
      );
    }
  });

  test("refuses a tag that already resolves", async () => {
    const result = await inspectResult('{"schemaVersion":2}', 0);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("Refusing to overwrite existing image tag");
  });
});

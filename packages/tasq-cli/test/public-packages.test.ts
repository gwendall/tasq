import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

const roots: string[] = [];
const productRoot = resolve(import.meta.dir, "../../..");
const builder = join(productRoot, "scripts/release/build-public-packages.ts");
const version = "0.1.0-test.1";
const sourceCommit = "0123456789abcdef0123456789abcdef01234567";
const packageNames = [
  "@tasq/cli",
  "@tasq/console",
  "@tasq/core",
  "@tasq/extension-sdk",
  "@tasq/mcp",
  "@tasq/protocol-adapters",
  "@tasq/schema",
];

setDefaultTimeout(240_000);

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function run(command: string[], cwd: string, env: Record<string, string> = {}) {
  const child = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env, ...env } });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

async function firstLine(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (!text.includes("\n")) {
    const chunk = await reader.read();
    if (chunk.done) throw new Error(`Console process ended before startup: ${text}`);
    text += decoder.decode(chunk.value, { stream: true });
  }
  return { line: text.slice(0, text.indexOf("\n")), reader };
}

async function build(outdir: string) {
  return run([
    process.execPath,
    builder,
    "--version",
    version,
    "--source-commit",
    sourceCommit,
    "--outdir",
    outdir,
  ], productRoot);
}

async function digest(path: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(await readFile(path));
  return hasher.digest("hex");
}

async function files(root: string): Promise<string[]> {
  const result: string[] = [];
  async function visit(directory: string): Promise<void> {
    for (const name of (await readdir(directory)).sort()) {
      const path = join(directory, name);
      const info = await stat(path);
      if (info.isDirectory()) await visit(path);
      else result.push(path);
    }
  }
  await visit(root);
  return result;
}

describe("Tasq public npm package candidates", () => {
  test("are deterministic, public-only, and install together in a clean room", async () => {
    const root = await mkdtemp(join(tmpdir(), "tasq-public-packages-"));
    roots.push(root);
    const first = join(root, "first");
    const second = join(root, "second");
    expect(await build(first)).toMatchObject({ exitCode: 0, stderr: "" });
    expect(await build(second)).toMatchObject({ exitCode: 0, stderr: "" });

    const names = (await readdir(first)).sort();
    expect(names).toHaveLength(10);
    for (const name of names) {
      expect(await digest(join(first, name)), name).toBe(await digest(join(second, name)));
    }

    const release = JSON.parse(await readFile(
      join(first, `tasq-packages-v${version}.release.json`),
      "utf8",
    ));
    expect(release).toMatchObject({
      contractVersion: "tasq.public-packages.v1",
      version,
      source: { commit: sourceCommit },
      clockBoundary: "explicit inputs only; no device time is package authority",
      provenance: { localArtifactsPublishable: false },
    });
    expect(release.packages.map((item: { name: string }) => item.name).sort()).toEqual(packageNames);
    expect(JSON.stringify(release)).not.toMatch(/generatedAt|createdAt|timestamp/);

    const extracted = join(root, "extracted");
    await Bun.$`mkdir -p ${extracted}`;
    const archives = names.filter((name) => name.endsWith(".tgz"));
    for (const archive of archives) {
      const destination = join(extracted, basename(archive, ".tgz"));
      await Bun.$`mkdir -p ${destination}`;
      const unpack = await run(["tar", "-xzf", join(first, archive), "-C", destination], root);
      expect(unpack, archive).toMatchObject({ exitCode: 0, stderr: "" });
      const packageRoot = join(destination, "package");
      const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
      expect(packageNames).toContain(manifest.name);
      expect(manifest).not.toHaveProperty("private");
      expect(JSON.stringify(manifest)).not.toContain("workspace:");
      expect(JSON.stringify(manifest)).not.toContain("@kami/");
      for (const path of await files(packageRoot)) {
        if (path.endsWith(".sql")) continue; // immutable migrations retain historical comments
        const content = await readFile(path);
        expect(content.includes(Buffer.from("@kami/")), path).toBe(false);
        expect(content.includes(Buffer.from(productRoot)), path).toBe(false);
      }
    }

    for (const [releasedDirectory, sourceDirectory] of [
      [`tasq-schema-${version}`, "tasq-schema"],
      [`tasq-core-${version}`, "tasq-service"],
    ]) {
      const released = JSON.parse(await readFile(
        join(extracted, releasedDirectory, "package", "package.json"),
        "utf8",
      ));
      const source = JSON.parse(await readFile(
        join(productRoot, "packages", sourceDirectory, "package.json"),
        "utf8",
      ));
      expect(released.dependencies["drizzle-orm"]).toBe(source.dependencies["drizzle-orm"]);
    }

    const coreRoot = join(extracted, `tasq-core-${version}`, "package", "src");
    for (const forbidden of ["areas.ts", "goals.ts", "projects.ts", "recurrence.ts", "life-task-policy.ts"]) {
      expect((await files(coreRoot)).some((path) => path.endsWith(`/${forbidden}`)), forbidden).toBe(false);
    }

    const consumer = join(root, "consumer");
    await Bun.$`mkdir -p ${consumer}`;
    await writeFile(join(consumer, "package.json"), `${JSON.stringify({
      private: true,
      type: "module",
      dependencies: Object.fromEntries(packageNames.map((name) => {
        const archive = release.packages.find((item: { name: string }) => item.name === name).filename;
        return [name, `file:${join(first, archive)}`];
      })),
    }, null, 2)}\n`, "utf8");
    const install = await run([
      "npm", "install", "--ignore-scripts", "--no-audit", "--no-fund", "--no-package-lock",
    ], consumer);
    expect(install.exitCode, install.stderr || install.stdout).toBe(0);

    const smoke = join(consumer, "smoke.ts");
    await writeFile(smoke, `
      import { mkdtemp, rm } from "node:fs/promises";
      import { tmpdir } from "node:os";
      import { join } from "node:path";
      import { openDb, runKernelMigrations, createMutableClock, createCommitment,
        startCommitment, completeCommitment } from "@tasq/core";
      import * as schema from "@tasq/schema";
      import * as extensionSdk from "@tasq/extension-sdk";
      import * as mcp from "@tasq/mcp";
      import * as adapters from "@tasq/protocol-adapters";
      import * as consolePackage from "@tasq/console";
      const root = await mkdtemp(join(tmpdir(), "tasq-installed-core-"));
      const clock = createMutableClock(1900000000000);
      const handle = await openDb({ url: "file:" + join(root, "db.sqlite"), wal: false });
      try {
        await runKernelMigrations(handle.client, { clock });
        const context = { workspaceId: "robotics-lab", actor: "agent:fresh", clock };
        const created = await createCommitment(handle.db, {
          title: "Calibrate arm joint",
          successCriteria: "Receipt attached",
        }, context);
        clock.advance(1000);
        const started = await startCommitment(handle.db, created.id, { ...context, expectedRevision: created.revision });
        clock.advance(1000);
        const done = await completeCommitment(handle.db, created.id, { ...context, expectedRevision: started.revision });
        process.stdout.write(JSON.stringify({
          status: done.status,
          createdAt: done.createdAt,
          completedAt: done.completedAt,
          packageEntrypointsLoaded: [schema, extensionSdk, mcp, adapters, consolePackage]
            .every((module) => Object.keys(module).length > 0),
        }));
      } finally {
        await handle.close();
        await rm(root, { recursive: true, force: true });
      }
    `, "utf8");
    const boot = await run([process.execPath, "run", smoke], consumer);
    expect(boot.exitCode, boot.stderr).toBe(0);
    expect(JSON.parse(boot.stdout)).toEqual({
      status: "done",
      createdAt: 1_900_000_000_000,
      completedAt: 1_900_000_002_000,
      packageEntrypointsLoaded: true,
    });

    const cli = join(consumer, "node_modules", ".bin", "tasq");
    expect(await run([cli, "--version"], consumer)).toMatchObject({ exitCode: 0, stdout: `${version}\n`, stderr: "" });
    const packageHome = join(root, "package-home");
    const onboard = await run([
      cli,
      "onboard",
      "--space",
      "package-clean-room",
      "--actor",
      "agent:fresh",
      "--json",
    ], consumer, { TASQ_HOME: packageHome });
    expect(onboard.exitCode, onboard.stderr).toBe(0);
    expect(JSON.parse(onboard.stdout)).toMatchObject({
      contractVersion: "tasq.autonomous-bootstrap.v1",
      space: { workspaceId: "package-clean-room" },
      actor: { alias: "agent:fresh" },
    });

    const consoleProcess = Bun.spawn([
      cli, "web", "--tenant", "package-clean-room", "--host", "127.0.0.1", "--port", "0", "--json",
    ], {
      cwd: tmpdir(),
      env: { PATH: process.env.PATH ?? "", TASQ_HOME: packageHome },
      stdout: "pipe",
      stderr: "pipe",
    });
    const consoleStderr = new Response(consoleProcess.stderr).text();
    const startup = await firstLine(consoleProcess.stdout);
    const descriptor = JSON.parse(startup.line);
    expect(descriptor).toMatchObject({
      contractVersion: "tasq.console-listener.v1",
      productVersion: version,
      workspaceId: "package-clean-room",
    });
    expect(await fetch(descriptor.endpoint.url).then((response) => response.text())).toContain("Tasq Console");
    expect(await fetch(`${descriptor.endpoint.url}/api/console/runtime`).then((response) => response.json()))
      .toEqual(descriptor);
    consoleProcess.kill("SIGTERM");
    expect(await consoleProcess.exited).toBe(0);
    await startup.reader.cancel();
    expect(await consoleStderr).toBe("");
  });

  test("fails closed without explicit immutable release identity", async () => {
    const root = await mkdtemp(join(tmpdir(), "tasq-public-packages-invalid-"));
    roots.push(root);
    const invalid = await run([
      process.execPath,
      builder,
      "--version",
      "latest",
      "--source-commit",
      sourceCommit,
      "--outdir",
      join(root, "invalid"),
    ], productRoot);
    expect(invalid.exitCode).not.toBe(0);
    expect(invalid.stderr).toContain("SemVer");
  });
});

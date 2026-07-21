import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const temporaryPaths: string[] = [];

// Building a native release bundle can exceed Bun's 5s default when the full
// subprocess-heavy CLI suite runs concurrently on CI.
setDefaultTimeout(60_000);

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function firstLine(stream: ReadableStream<Uint8Array>): Promise<{
  line: string;
  reader: ReadableStreamDefaultReader<Uint8Array>;
}> {
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

describe("released CLI artifact", () => {
  test("boots from the artifact alone with its declared native binding", async () => {
    const root = await mkdtemp(join(tmpdir(), "tasq-cli-artifact-"));
    temporaryPaths.push(root);
    const artifact = join(root, "artifact");
    const build = Bun.spawn([
      "bun",
      "run",
      resolve(import.meta.dir, "../scripts/build.ts"),
      "--outdir",
      artifact,
    ], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await build.exited).toBe(0);

    const manifest = JSON.parse(await readFile(join(artifact, "artifact.json"), "utf8")) as {
      contractVersion: string;
      nativePackages: Array<{ package: string; target: string; sha256: string }>;
      migrations: Array<{ name: string; sha256: string }>;
    };
    expect(manifest.contractVersion).toBe("tasq.cli-artifact.v1");
    expect(manifest.nativePackages).toHaveLength(1);
    expect(manifest.nativePackages[0]?.package).toStartWith("@libsql/");
    expect(manifest.nativePackages[0]?.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(manifest.migrations.length).toBeGreaterThan(20);
    expect(manifest.migrations.at(-1)?.name).toMatch(/^\d{4}_.+\.sql$/);

    const tasqHome = join(root, "home");
    const run = Bun.spawn([
      join(artifact, "index.js"),
      "onboard",
      "--space",
      "artifact-smoke",
      "--actor",
      "artifact-smoke",
      "--json",
    ], {
      cwd: root,
      env: {
        PATH: process.env.PATH ?? "",
        TASQ_HOME: tasqHome,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      run.exited,
      new Response(run.stdout).text(),
      new Response(run.stderr).text(),
    ]);
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({
      contractVersion: "tasq.autonomous-bootstrap.v1",
      disposition: "created",
      space: { workspaceId: "artifact-smoke" },
      actor: { alias: "artifact-smoke" },
    });

    // `web` is dynamically imported so this specifically proves that the
    // inspector ships inside the standalone artifact instead of resolving
    // from the source workspace by accident.
    const web = Bun.spawn([
      join(artifact, "index.js"),
      "web",
      "--tenant",
      "artifact-smoke",
      "--host",
      "0.0.0.0",
      "--port",
      "0",
    ], {
      cwd: root,
      env: {
        PATH: process.env.PATH ?? "",
        TASQ_HOME: tasqHome,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [webExitCode, webStdout, webStderr] = await Promise.all([
      web.exited,
      new Response(web.stdout).text(),
      new Response(web.stderr).text(),
    ]);
    expect(webExitCode).toBe(1);
    expect(webStdout).toBe("");
    expect(webStderr).toContain("loopback");
    expect(webStderr).not.toContain("Cannot find package");

    const consoleProcess = Bun.spawn([
      join(artifact, "index.js"),
      "web",
      "--tenant",
      "artifact-smoke",
      "--host",
      "127.0.0.1",
      "--port",
      "0",
      "--json",
    ], {
      cwd: root,
      env: { PATH: process.env.PATH ?? "", TASQ_HOME: tasqHome },
      stdout: "pipe",
      stderr: "pipe",
    });
    const consoleStderr = new Response(consoleProcess.stderr).text();
    const startup = await firstLine(consoleProcess.stdout);
    const descriptor = JSON.parse(startup.line);
    expect(descriptor).toMatchObject({
      contractVersion: "tasq.console-listener.v1",
      workspaceId: "artifact-smoke",
      endpoint: { scope: "loopback" },
    });
    expect(await fetch(descriptor.endpoint.url).then((response) => response.text())).toContain("Tasq Console");
    expect(await fetch(`${descriptor.endpoint.url}/assets/console.css`).then((response) => response.status)).toBe(200);
    expect(await fetch(`${descriptor.endpoint.url}/api/console/runtime`).then((response) => response.json()))
      .toEqual(descriptor);
    consoleProcess.kill("SIGTERM");
    expect(await consoleProcess.exited).toBe(0);
    await startup.reader.cancel();
    expect(await consoleStderr).toBe("");
  });
});

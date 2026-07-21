import { afterEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { consoleRegistrationPath } from "../src/console-lifecycle.js";

setDefaultTimeout(30_000);

const testDir = dirname(fileURLToPath(import.meta.url));
const cli = join(testDir, "..", "src", "index.ts");
const tmpHomes: string[] = [];

afterEach(() => {
  while (tmpHomes.length > 0) rmSync(tmpHomes.pop()!, { recursive: true, force: true });
});

function freshHome(): string {
  const home = mkdtempSync(join(tmpdir(), "tasq-web-cli-"));
  tmpHomes.push(home);
  return home;
}

function spawnCli(home: string, args: string[]) {
  return Bun.spawn(["bun", "run", cli, ...args], {
    env: { ...process.env, HOME: home, TASQ_DB_URL: "" },
    stdout: "pipe",
    stderr: "pipe",
  });
}

async function runCli(home: string, args: string[]) {
  const child = spawnCli(home, args);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, exitCode };
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
    if (chunk.done) throw new Error(`web process ended before startup: ${text}`);
    text += decoder.decode(chunk.value, { stream: true });
  }
  return { line: text.slice(0, text.indexOf("\n")), reader };
}

describe("tasq web composition", () => {
  it("documents the explicit local-only contract and rejects unsafe invocations", async () => {
    const home = freshHome();
    const help = await runCli(home, ["web", "--help"]);
    expect(help).toMatchObject({ exitCode: 0, stderr: "" });
    expect(help.stdout).toContain("web --tenant <space>");
    expect(help.stdout).toContain("unauthenticated read-only Console on loopback");

    const missingSpace = await runCli(home, ["web", "--port", "0"]);
    expect(missingSpace.exitCode).toBe(2);
    const publicBind = await runCli(home, [
      "web", "--tenant", "inspection/test", "--host", "0.0.0.0", "--port", "0",
    ]);
    expect(publicBind.exitCode).toBe(1);
    expect(publicBind.stderr).toContain("only accepts a loopback host");
    const stopped = await runCli(home, ["web", "status", "--tenant", "inspection/test", "--json"]);
    expect(stopped).toMatchObject({ exitCode: 1, stderr: "" });
    expect(JSON.parse(stopped.stdout)).toMatchObject({ state: "stopped", reason: "not_registered" });
    expect(existsSync(join(home, ".tasq", "db.sqlite"))).toBe(false);
  });

  it("announces, discovers and cleans one explicit foreground listener", async () => {
    const home = freshHome();
    const child = spawnCli(home, [
      "web", "--tenant", "inspection/cli", "--host", "127.0.0.1", "--port", "0", "--json",
    ]);
    const stderr = new Response(child.stderr).text();
    const startup = await firstLine(child.stdout);
    const descriptor = JSON.parse(startup.line);
    expect(descriptor).toMatchObject({
      contractVersion: "tasq.console-listener.v1",
      productVersion: "0.1.0",
      workspaceId: "inspection/cli",
      endpoint: { scope: "loopback", transport: "http" },
      access: { readOnly: true, authentication: "none" },
      process: { mode: "foreground", pid: child.pid },
    });
    const url = descriptor.endpoint.url as string;

    const status = await runCli(home, ["web", "status", "--tenant", "inspection/cli", "--json"]);
    expect(status).toMatchObject({ exitCode: 0, stderr: "" });
    expect(JSON.parse(status.stdout)).toMatchObject({
      contractVersion: "tasq.console-discovery.v1",
      state: "running",
      descriptor: { instanceId: descriptor.instanceId, endpoint: { url } },
      reason: null,
    });

    const duplicate = await runCli(home, ["web", "--tenant", "inspection/cli", "--port", "0"]);
    expect(duplicate.exitCode).toBe(1);
    expect(duplicate.stderr).toContain("already registered");

    const response = await fetch(`${url}/api/index`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      contractVersion: "tasq.inspector-index.v1",
      workspaceId: "inspection/cli",
    });
    const root = await fetch(url).then((value) => value.text());
    expect(root).toContain("Tasq Console");
    expect(root).toContain("Tasq Local 0.1.0");
    expect(await fetch(`${url}/assets/console.css`).then((value) => value.status)).toBe(200);
    expect(await fetch(`${url}/api/console/runtime`).then((value) => value.json())).toEqual(descriptor);
    child.kill("SIGTERM");
    expect(await child.exited).toBe(0);
    await startup.reader.cancel();
    expect(await stderr).toBe("");

    await expect(fetch(`${url}/api/index`)).rejects.toThrow();
    const stopped = await runCli(home, ["web", "status", "--tenant", "inspection/cli", "--json"]);
    expect(stopped).toMatchObject({ exitCode: 1, stderr: "" });
    expect(JSON.parse(stopped.stdout)).toMatchObject({ state: "stopped", reason: "not_registered" });
    expect(() => statSync(consoleRegistrationPath("inspection/cli"), { throwIfNoEntry: true })).toThrow();
    const reopened = await runCli(home, ["list", "--tenant", "inspection/cli", "--json"]);
    expect(reopened).toMatchObject({ exitCode: 0, stderr: "" });
  });
});

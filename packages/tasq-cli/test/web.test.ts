import { afterEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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
    expect(help.stdout).toContain("unauthenticated read-only inspector on loopback");

    const missingSpace = await runCli(home, ["web", "--port", "0"]);
    expect(missingSpace.exitCode).toBe(2);
    const json = await runCli(home, ["web", "--tenant", "inspection/test", "--json"]);
    expect(json.exitCode).toBe(1);
    expect(json.stderr).toContain("--json is not accepted");
    const publicBind = await runCli(home, [
      "web", "--tenant", "inspection/test", "--host", "0.0.0.0", "--port", "0",
    ]);
    expect(publicBind.exitCode).toBe(1);
    expect(publicBind.stderr).toContain("only accepts a loopback host");
  });

  it("serves the selected workspace, handles SIGTERM and releases both listener and database", async () => {
    const home = freshHome();
    const child = spawnCli(home, [
      "web", "--tenant", "inspection/cli", "--host", "127.0.0.1", "--port", "0",
    ]);
    const stderr = new Response(child.stderr).text();
    const startup = await firstLine(child.stdout);
    const match = startup.line.match(/(http:\/\/127\.0\.0\.1:\d+)/);
    expect(match).not.toBeNull();
    const url = match![1]!;
    expect(startup.line).toContain('workspace "inspection/cli"');
    expect(startup.line).toContain("Unauthenticated local read access");

    const response = await fetch(`${url}/api/index`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      contractVersion: "tasq.inspector-index.v1",
      workspaceId: "inspection/cli",
    });
    child.kill("SIGTERM");
    expect(await child.exited).toBe(0);
    await startup.reader.cancel();
    expect(await stderr).toBe("");

    await expect(fetch(`${url}/api/index`)).rejects.toThrow();
    const reopened = await runCli(home, ["list", "--tenant", "inspection/cli", "--json"]);
    expect(reopened).toMatchObject({ exitCode: 0, stderr: "" });
  });
});

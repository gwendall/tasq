import { afterEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const cli = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "index.ts");
const homes: string[] = [];
setDefaultTimeout(60_000);
afterEach(() => {
  while (homes.length > 0) rmSync(homes.pop()!, { recursive: true, force: true });
});

async function run(home: string, args: string[]) {
  const process = Bun.spawn(["bun", "run", cli, ...args], {
    env: { ...globalThis.process.env, HOME: home, TASQ_DB_URL: "" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  return { stdout, stderr, exitCode };
}

describe("local discovery capture", () => {
  it("keeps the live claim, emits provenance, and prints an executable refusal recipe", async () => {
    const home = mkdtempSync(join(tmpdir(), "tasq-capture-cli-"));
    homes.push(home);
    expect((await run(home, ["setup", "--space", "capture-test", "--actor", "agent-a"])).exitCode).toBe(0);
    const source = JSON.parse((await run(home, ["add", "Current work", "--json"])).stdout);
    const claim = JSON.parse((await run(home, ["claim", source.id, "--for", "30m", "--idempotency-key", "claim:one", "--json"])).stdout);
    const capture = await run(home, [
      "capture", source.id, "Repair adjacent invariant",
      "--next", "Write the failing test",
      "--context", '{"runtime":"codex","code":"REFUSED"}',
      "--source", "block",
      "--idempotency-key", "capture:one",
      "--json",
    ]);
    expect(capture.exitCode).toBe(0);
    const body = JSON.parse(capture.stdout);
    expect(body).toMatchObject({
      contractVersion: "tasq.discovery-capture.v1",
      replayed: false,
      relation: { type: "discovered_from", toTaskId: source.id },
      task: { title: "Repair adjacent invariant" },
    });
    const shown = JSON.parse((await run(home, ["show", body.task.id, "--json"])).stdout);
    expect(shown.dependencies).toContainEqual(expect.objectContaining({
      type: "discovered_from", toTaskId: source.id,
    }));
    const after = JSON.parse((await run(home, ["show", source.id, "--json"])).stdout);
    expect(after.claim).toMatchObject({ id: claim.id, releasedAt: null });

    const refused = await run(home, ["start", source.id, "--expected-revision", "999"]);
    expect(refused.exitCode).not.toBe(0);
    expect(refused.stderr).toContain("capture discovered work without leaving this task");
    const recipe = refused.stderr.split("\n").find((line) => line.trimStart().startsWith("'"))?.trim();
    expect(recipe).toBeDefined();
    const shell = Bun.spawn(["sh", "-c", recipe!], {
      env: { ...globalThis.process.env, HOME: home, TASQ_DB_URL: "" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const shellStderr = new Response(shell.stderr).text();
    expect(await shell.exited, await shellStderr).toBe(0);
    const sourceAfterRecipe = JSON.parse((await run(home, ["show", source.id, "--json"])).stdout);
    expect(sourceAfterRecipe.claim).toMatchObject({ id: claim.id, releasedAt: null });
    expect(sourceAfterRecipe.dependencies.filter((edge: { type: string }) => edge.type === "discovered_from"))
      .toHaveLength(2);
  });
});

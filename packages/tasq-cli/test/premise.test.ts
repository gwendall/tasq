import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

setDefaultTimeout(60_000);
const cli = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "index.ts");
const homes: string[] = [];
afterEach(() => {
  while (homes.length > 0) rmSync(homes.pop()!, { recursive: true, force: true });
});

async function run(home: string, args: string[]) {
  // `tasq setup` binds the working directory and writes AGENTS.md into it, so
  // this runs in a project directory inside the throwaway home rather than in
  // the repository.
  const workspace = join(home, "workspace");
  mkdirSync(workspace, { recursive: true });
  const process = Bun.spawn(["bun", "run", cli, ...args], {
    cwd: workspace,
    env: { ...globalThis.process.env, HOME: home, TASQ_DB_URL: "" },
    stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited,
  ]);
  return { stdout, stderr, exitCode };
}

async function ok(home: string, args: string[]) {
  const result = await run(home, args);
  expect(result.exitCode, result.stderr).toBe(0);
  return result;
}

describe("task premise CLI", () => {
  test("attaches a motivating observation at add and refutes it independently", async () => {
    const home = mkdtempSync(join(tmpdir(), "tasq-premise-cli-"));
    homes.push(home);
    await ok(home, ["setup", "--space", "premise-cli", "--actor", "worker"]);
    await ok(home, ["add", "Validator identity seed", "--actor", "validator", "--idempotency-key", "validator-seed"]);
    const observation = JSON.parse((await ok(home, [
      "observation", "ingest",
      "--source", "github:work",
      "--external-event-id", "pr-42",
      "--kind", "github.pull_request",
      "--payload", JSON.stringify({
        host: "github.com", owner: "acme", repository: "product",
        pullRequestNumber: 42, state: "open",
      }),
      "--occurred-at", "2026-08-11T00:00:00Z",
      "--json",
    ])).stdout);
    const task = JSON.parse((await ok(home, [
      "add", "Review PR 42",
      "--premise-observation", observation.id,
      "--premise", "PR 42 remains open and needs review",
      "--premise-validators", "validator",
      "--idempotency-key", "premise-task",
      "--json",
    ])).stdout);
    expect(JSON.parse((await ok(home, ["premise", "show", task.id, "--json"])).stdout))
      .toMatchObject({ actionable: true, premise: { value: { observationId: observation.id } } });
    const evidence = JSON.parse((await ok(home, [
      "evidence", "add", task.id,
      "--kind", "github.pull_request.closed",
      "--summary", "PR 42 was closed",
      "--source", "github:work",
      "--idempotency-key", "closed-evidence",
      "--json",
    ])).stdout);
    const proposal = JSON.parse((await ok(home, [
      "premise", "propose", task.id,
      "--verdict", "refute",
      "--evidence", evidence.id,
      "--reason", "The pull request no longer needs review",
      "--idempotency-key", "refute-proposal",
      "--json",
    ])).stdout);
    await ok(home, [
      "premise", "decide", task.id,
      "--proposal", proposal.id,
      "--outcome", "accepted",
      "--reason", "Closure is authoritative",
      "--actor", "validator",
      "--idempotency-key", "refute-decision",
      "--json",
    ]);
    const invalidated = JSON.parse((await ok(home, ["premise", "show", task.id, "--json"])).stdout);
    expect(invalidated).toMatchObject({ actionable: false, task: { deletedAt: null } });
    const next = JSON.parse((await ok(home, ["next", "--limit", "100", "--json"])).stdout);
    expect(next.map((item: { task: { id: string } }) => item.task.id)).not.toContain(task.id);
    const refused = await run(home, ["claim", task.id, "--for", "30m", "--json"]);
    expect(refused.exitCode).not.toBe(0);
    expect(refused.stderr).toContain("premise is invalidated");
  });
});

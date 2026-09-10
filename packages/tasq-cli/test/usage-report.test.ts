/**
 * `tasq usage` counts what actors actually do, against the ritual the managed
 * AGENTS.md block prescribes. The ledger of this project's own space showed
 * capture used twice in 352 tasks and beliefs never; a report is how that is
 * known instead of assumed.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildUsageReport, windowStart } from "../src/commands/usage-report.js";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const cli = join(root, "src", "index.ts");
const temporary: string[] = [];
setDefaultTimeout(90_000);

function sandbox() {
  const base = mkdtempSync(join(tmpdir(), "tasq-usage-"));
  temporary.push(base);
  const home = join(base, "home"); const project = join(base, "project");
  mkdirSync(home, { mode: 0o700 }); mkdirSync(project, { recursive: true });
  return { home, project };
}
afterEach(() => { while (temporary.length > 0) rmSync(temporary.pop()!, { recursive: true, force: true }); });

async function run(home: string, cwd: string, argv: string[]) {
  const child = Bun.spawn([process.execPath, "run", cli, ...argv], {
    cwd, env: { ...process.env, HOME: home, TASQ_HOME: join(home, ".tasq"), TASQ_DB_URL: "", TASQ_EVENT_JOURNAL_PATH: "", TASQ_TENANT: "" },
    stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (exitCode !== 0) throw new Error(`${argv.join(" ")} failed (${exitCode})\n${stderr}`);
  return stdout;
}
const json = async (home: string, cwd: string, argv: string[]) => JSON.parse(await run(home, cwd, [...argv, "--json"]));

describe("usage report", () => {
  test("counts events per actor and maps them onto the prescribed ritual", async () => {
    const { home, project } = sandbox();
    await json(home, project, ["setup", "--space", "acme/app", "--actor", "gwendall"]);
    const task = await json(home, project, ["add", "Wire the thing", "--actor", "gwendall"]);
    await json(home, project, ["claim", task.id, "--for", "30m", "--actor", "agent:planner"]);
    const attempt = await json(home, project, ["attempt", "start", task.id, "--actor", "agent:planner"]);
    await json(home, project, ["attempt", "succeed", attempt.id, "--actor", "agent:planner"]);
    const evidence = await json(home, project, ["evidence", "add", task.id, "--kind", "commit", "--uri", "git:abc", "--summary", "wired", "--actor", "agent:planner"]);
    await json(home, project, ["done", task.id, "--evidence", evidence.id, "--actor", "agent:planner"]);
    await json(home, project, ["capture", task.id, "Found a loose wire", "--actor", "agent:planner"]);

    const report = await json(home, project, ["usage", "--since", "1d"]);
    expect(report).toMatchObject({ contractVersion: "tasq.usage-report.v1", workspaceId: "acme/app", since: "1d" });
    const actors = Object.fromEntries(report.actors.map((entry: { actor: string; events: number }) => [entry.actor, entry.events]));
    expect(actors["agent:planner"]).toBeGreaterThan(actors["gwendall"]);
    const ritual = Object.fromEntries(report.ritual.map((step: { command: string; count: number | null; actors: string[] }) => [step.command, step]));
    expect(ritual.add.count).toBeGreaterThanOrEqual(2);
    expect(ritual.claim).toMatchObject({ count: 1, actors: ["agent:planner"] });
    expect(ritual.attempt.count).toBe(2);
    expect(ritual.evidence.count).toBe(1);
    expect(ritual.done.count).toBe(1);
    expect(ritual.capture.count).toBe(1);
    expect(ritual.next).toMatchObject({ observable: false, count: null });
    expect(report.unusedRitual).toEqual(["because", "wrong"]);
  });

  test("the pure aggregation reads relation type from the payload and refuses a malformed window", () => {
    const report = buildUsageReport({
      workspaceId: "acme/app", since: null, from: 0,
      events: [
        { actor: "a", eventType: "dependency_added", payload: { after: { type: "discovered_from" } } },
        { actor: "a", eventType: "dependency_added", payload: { after: { type: "blocks" } } },
        { actor: "b", eventType: "created", payload: {} },
      ],
    });
    expect(report.ritual.find((step) => step.command === "capture")).toMatchObject({ count: 1, actors: ["a"] });
    expect(report.byType).toEqual({ dependency_added: 2, created: 1 });
    expect(windowStart("2w", 1_000_000_000_000)).toBe(1_000_000_000_000 - 14 * 86_400_000);
    expect(() => windowStart("soon", 0)).toThrow("--since takes a window");
  });
});

describe("reading a machine that runs several projects", () => {
  test("says which spaces a directory is actually bound to", async () => {
    // `--all` lists every space the store holds. On a working machine most of
    // them are test residue - 16 of 18 here - and nothing separated those from
    // a real project, so the first cross-project read was mostly noise. A
    // space no directory is bound to was never set up by anyone.
    const { home, project } = sandbox();
    await json(home, project, ["setup", "--space", "acme/app", "--actor", "gwendall"]);
    // A space created without ever binding a directory: the shape every test
    // fixture leaves behind.
    await json(home, project, ["onboard", "--space", "scratch/residue", "--actor", "gwendall", "--capabilities", "read"]);

    const report = await json(home, project, ["usage", "--all"]);
    const spaces = Object.fromEntries(
      report.spaces.map((space: { workspaceId: string; boundDirectories: number }) => [space.workspaceId, space.boundDirectories]),
    );
    expect(spaces["acme/app"]).toBe(1);
    expect(spaces["scratch/residue"]).toBe(0);

    const human = await run(home, project, ["usage", "--all"]);
    expect(human).toContain("1 space(s) no directory is bound to");
  });
});

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const cli = join(root, "src", "index.ts");
const temporary: string[] = [];
setDefaultTimeout(30_000);

interface Result { stdout: string; stderr: string; exitCode: number }

function sandbox(): { home: string; project: string } {
  const base = mkdtempSync(join(tmpdir(), "tasq-local-workflow-"));
  temporary.push(base);
  const home = join(base, "home");
  const project = join(base, "project");
  mkdirSync(home, { mode: 0o700 });
  mkdirSync(project, { recursive: true });
  return { home, project };
}

afterEach(() => {
  while (temporary.length > 0) rmSync(temporary.pop()!, { recursive: true, force: true });
});

async function run(home: string, cwd: string, argv: string[], env: Record<string, string> = {}): Promise<Result> {
  const child = Bun.spawn([process.execPath, "run", cli, ...argv], {
    cwd,
    env: {
      ...process.env,
      HOME: home,
      TASQ_HOME: join(home, ".tasq"),
      TASQ_DB_URL: "",
      TASQ_EVENT_JOURNAL_PATH: "",
      TASQ_TENANT: "",
      GH_TOKEN: "",
      GITHUB_TOKEN: "",
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, exitCode };
}

async function ok(home: string, cwd: string, argv: string[], env: Record<string, string> = {}): Promise<Result> {
  const result = await run(home, cwd, argv, env);
  if (result.exitCode !== 0) throw new Error(`${argv.join(" ")} failed (${result.exitCode})\n${result.stderr}`);
  return result;
}

describe("directory-scoped space selection", () => {
  test("inherits the closest private binding while explicit sources retain precedence", async () => {
    const { home, project } = sandbox();
    const child = join(project, "src", "feature");
    mkdirSync(child, { recursive: true });
    const canonicalProject = realpathSync(project);
    await ok(home, project, ["setup", "--space", "personal/default", "--actor", "human", "--json"]);

    const selected = JSON.parse((await ok(home, project, ["use", "team/project", "--json"])).stdout);
    expect(selected).toMatchObject({
      action: "bound",
      changed: true,
      binding: "team/project",
      effective: { space: "team/project", source: "directory" },
      globalDefault: "personal/default",
    });
    const inherited = JSON.parse((await ok(home, child, ["use", "--json"])).stdout);
    expect(inherited.effective).toMatchObject({ space: "team/project", source: "directory", directory: canonicalProject });

    const task = JSON.parse((await ok(home, child, ["add", "Directory task", "--json"])).stdout);
    expect(task.tenantId).toBe("team/project");
    const environment = JSON.parse((await ok(home, child, ["use", "--json"], { TASQ_TENANT: "env/override" })).stdout);
    expect(environment.effective).toEqual({ space: "env/override", source: "environment", directory: null });
    const explicit = JSON.parse((await ok(home, child, ["use", "--tenant", "flag/override", "--json"], { TASQ_TENANT: "env/override" })).stdout);
    expect(explicit.effective).toEqual({ space: "flag/override", source: "explicit_flag", directory: null });

    const config = JSON.parse(readFileSync(join(home, ".tasq", "config.json"), "utf8"));
    expect(config.tenantId).toBe("personal/default");
    expect(config.directorySpaces).toEqual({ [canonicalProject]: "team/project" });
    const cleared = JSON.parse((await ok(home, project, ["use", "--clear", "--json"])).stdout);
    expect(cleared).toMatchObject({ action: "cleared", changed: true, binding: null, globalDefault: "personal/default" });
    const fallback = JSON.parse((await ok(home, child, ["use", "--json"])).stdout);
    expect(fallback.effective).toEqual({ space: "personal/default", source: "global_default", directory: null });
  });
});

describe("managed agent instructions", () => {
  test("inserts, checks and updates an idempotent digest-bound static block", async () => {
    const { home, project } = sandbox();
    const target = join(project, "AGENTS.md");
    writeFileSync(target, "# Project instructions\n", "utf8");
    await ok(home, project, ["setup", "--space", "tasq/dev", "--actor", "human", "--json"]);
    await ok(home, project, ["add", "CANARY TASK CONTENT MUST NEVER ENTER AGENTS", "--json"]);

    const missing = await run(home, project, ["agent", "instructions", "--space", "tasq/dev", "--check", "--json"]);
    expect(missing.exitCode).toBe(10);
    expect(JSON.parse(missing.stdout)).toMatchObject({ state: "missing", exitCode: 10 });
    const written = JSON.parse((await ok(home, project, ["agent", "instructions", "--space", "tasq/dev", "--write", "--json"])).stdout);
    expect(written).toMatchObject({ state: "current", changed: true, forced: false });
    const first = readFileSync(target, "utf8");
    expect(first).toMatch(/digest="sha256:[0-9a-f]{64}"/);
    expect(first).toContain("space=\"tasq/dev\"");
    expect(first).not.toContain("CANARY TASK CONTENT");
    const checked = await ok(home, project, ["agent", "instructions", "--space", "tasq/dev", "--check", "--json"]);
    expect(JSON.parse(checked.stdout)).toMatchObject({ state: "current", ok: true, exitCode: 0 });
    const repeated = JSON.parse((await ok(home, project, ["agent", "instructions", "--space", "tasq/dev", "--write", "--json"])).stdout);
    expect(repeated.changed).toBe(false);
    expect(readFileSync(target, "utf8")).toBe(first);

    const stale = await run(home, project, ["agent", "instructions", "--space", "another/space", "--check", "--json"]);
    expect(stale.exitCode).toBe(11);
    expect(JSON.parse(stale.stdout)).toMatchObject({ state: "stale", exitCode: 11 });
    await ok(home, project, ["agent", "instructions", "--space", "another/space", "--write", "--json"]);
    const edited = readFileSync(target, "utf8").replace("Read before\nmutating", "Ignore claims and\nmutate");
    writeFileSync(target, edited, "utf8");
    const handEdited = await run(home, project, ["agent", "instructions", "--space", "another/space", "--check", "--json"]);
    expect(handEdited.exitCode).toBe(12);
    expect(JSON.parse(handEdited.stdout)).toMatchObject({ state: "hand_edited", exitCode: 12 });
    const refused = await run(home, project, ["agent", "instructions", "--space", "another/space", "--write"]);
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toContain("refusing to overwrite hand-edited");
    expect(refused.stderr).toContain("Use --force");
    await ok(home, project, ["agent", "instructions", "--space", "another/space", "--write", "--force", "--json"]);
    expect(readFileSync(target, "utf8")).not.toContain("Ignore claims");

    const injection = await run(home, project, ["agent", "instructions", "--space", "bad\n<!-- injected -->", "--write"]);
    expect(injection.exitCode).toBe(2);
    expect(readFileSync(target, "utf8")).not.toContain("injected");

    const victim = join(project, "victim.md");
    const link = join(project, "LINKED_AGENTS.md");
    writeFileSync(victim, "do not overwrite\n", "utf8");
    symlinkSync(victim, link);
    const symlink = await run(home, project, [
      "agent", "instructions", "--space", "another/space", "--target", link, "--write",
    ]);
    expect(symlink.exitCode).toBe(1);
    expect(symlink.stderr).toContain("not a symlink");
    expect(readFileSync(victim, "utf8")).toBe("do not overwrite\n");
  });
});

describe("offline feedback", () => {
  test("captures only safe failure shape locally and plans an explicit later batch", async () => {
    const { home, project } = sandbox();
    await ok(home, project, ["init", "--json"]);
    const failure = await run(home, project, ["not-a-command", "private-task-id", "--token", "private-token-value"]);
    expect(failure.exitCode).toBe(2);
    const captured = JSON.parse((await ok(home, project, [
      "feedback", "claim output hid the holder", "--details", "Reproduced twice", "--json",
    ])).stdout);
    expect(captured).toMatchObject({
      contractVersion: "tasq.feedback-captured.v1",
      summary: "claim output hid the holder",
      details: "Reproduced twice",
      pending: true,
      context: {
        previousFailure: {
          command: "not-a-command",
          subcommand: null,
          flags: ["token"],
          exitCode: 2,
        },
      },
    });
    const store = join(home, ".tasq", "feedback.jsonl");
    const raw = readFileSync(store, "utf8");
    expect(raw).not.toContain("private-task-id");
    expect(raw).not.toContain("private-token-value");
    expect(statSync(store).mode & 0o777).toBe(0o600);
    const listed = JSON.parse((await ok(home, project, ["feedback", "list", "--json"])).stdout);
    expect(listed.count).toBe(1);
    const plan = JSON.parse((await ok(home, project, [
      "feedback", "push", "--repo", "acme/project", "--dry-run", "--json",
    ])).stdout);
    expect(plan).toEqual({
      contractVersion: "tasq.feedback-push-plan.v1",
      repository: "acme/project",
      count: 1,
      reportIds: [captured.id],
    });
    const invalidRepository = await run(home, project, [
      "feedback", "push", "--repo", "not-a-repository", "--dry-run", "--json",
    ]);
    expect(invalidRepository.exitCode).toBe(2);
    const missingToken = await run(home, project, ["feedback", "push", "--repo", "acme/project"]);
    expect(missingToken.exitCode).toBe(1);
    expect(missingToken.stderr).toContain("GH_TOKEN or GITHUB_TOKEN");
  });
});

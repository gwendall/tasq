/**
 * The private config must never lose what it was not asked to change.
 *
 * On 2026-09-02 this project's own checkout lost its `tasq/dev` binding. A
 * session ran `tasq setup` for a scratch project, which made that space the
 * global default for every unbound directory; later rewrites from copies of
 * the file dropped the bindings the file had; nothing recorded who did it; and
 * the digest-bound block in AGENTS.md kept naming a space no command used.
 * Each test below is one of those four things, made impossible.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, saveConfig } from "../src/config.js";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const cli = join(root, "src", "index.ts");
const temporary: string[] = [];
setDefaultTimeout(60_000);

interface Result { stdout: string; stderr: string; exitCode: number }

function sandbox(): { home: string; base: string } {
  const base = mkdtempSync(join(tmpdir(), "tasq-config-safety-"));
  temporary.push(base);
  const home = join(base, "home");
  mkdirSync(home, { mode: 0o700 });
  return { home, base };
}

function project(base: string, name: string): string {
  const dir = join(base, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

afterEach(() => {
  delete process.env.TASQ_HOME;
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

async function json(home: string, cwd: string, argv: string[], env: Record<string, string> = {}): Promise<any> {
  return JSON.parse((await ok(home, cwd, [...argv, "--json"], env)).stdout);
}

function configFile(home: string): any {
  return JSON.parse(readFileSync(join(home, ".tasq", "config.json"), "utf8"));
}

function journal(home: string): any[] {
  const path = join(home, ".tasq", "config-journal.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line));
}

describe("the global default survives setting other projects up", () => {
  test("the first project becomes the default, later ones leave it alone unless asked", async () => {
    const { home, base } = sandbox();
    const first = project(base, "first");
    const second = project(base, "second");

    const a = await json(home, first, ["setup", "--space", "acme/first", "--actor", "gwendall"]);
    expect(a.contractVersion).toBe("tasq.human-setup.v3");
    expect(a.globalDefault).toEqual({ space: "acme/first", changed: true, source: "first" });
    expect(configFile(home).tenantId).toBe("acme/first");

    const b = await json(home, second, ["setup", "--space", "acme/second", "--actor", "gwendall"]);
    expect(b.globalDefault).toEqual({ space: "acme/first", changed: false, source: "kept" });
    expect(configFile(home).tenantId).toBe("acme/first");
    expect(configFile(home).directorySpaces).toEqual({
      [realpathSync(first)]: "acme/first",
      [realpathSync(second)]: "acme/second",
    });

    const c = await json(home, second, ["setup", "--space", "acme/second", "--actor", "gwendall", "--default"]);
    expect(c.globalDefault).toEqual({ space: "acme/second", changed: true, source: "flag" });
    expect(configFile(home).tenantId).toBe("acme/second");
  });

  test("setting a bound directory up again uses its own space, not the global default", async () => {
    const { home, base } = sandbox();
    const first = project(base, "first");
    const second = project(base, "second");
    await json(home, first, ["setup", "--space", "acme/first", "--actor", "gwendall"]);
    await json(home, second, ["setup", "--space", "acme/second", "--actor", "gwendall"]);
    expect(configFile(home).tenantId).toBe("acme/first");

    const again = await json(home, second, ["setup"]);
    expect(again).toMatchObject({
      disposition: "joined",
      space: "acme/second",
      spaceSource: "inherited-from-directory",
    });
    expect(configFile(home).tenantId).toBe("acme/first");
  });
});

describe("a config write keeps the bindings it was not asked to remove", () => {
  test("a stale copy preserves what another writer bound, and only a named unbind removes one", () => {
    const { home, base } = sandbox();
    const tasqHome = join(home, ".tasq");
    mkdirSync(tasqHome, { recursive: true, mode: 0o700 });
    process.env.TASQ_HOME = tasqHome;
    const dirA = realpathSync(project(base, "a"));
    const dirB = realpathSync(project(base, "b"));
    writeFileSync(join(tasqHome, "config.json"), JSON.stringify({
      dbPath: join(tasqHome, "db.sqlite"),
      eventJournalPath: join(tasqHome, "events.jsonl"),
      tenantId: "acme/first",
      defaultActor: "gwendall",
      directorySpaces: { [dirA]: "acme/first", [dirB]: "acme/second" },
    }), { mode: 0o600 });

    // A copy loaded before dirB was bound, saved afterwards.
    const stale = { ...loadConfig(), directorySpaces: { [dirA]: "acme/first" }, defaultActor: "someone-else" };
    const report = saveConfig(stale, { command: ["config", "set", "defaultActor"] });
    expect(report.changed).toBe(true);
    expect(report.preservedBindings).toEqual([dirB]);
    expect(configFile(home).directorySpaces).toEqual({ [dirA]: "acme/first", [dirB]: "acme/second" });
    expect(configFile(home).defaultActor).toBe("someone-else");

    // Unbinding names the directory it removes; the other survives.
    const cleared = { ...loadConfig(), directorySpaces: { [dirB]: "acme/second" } };
    saveConfig(cleared, { command: ["use", "--clear"], unbind: [dirA] });
    expect(configFile(home).directorySpaces).toEqual({ [dirB]: "acme/second" });

    // Saving an identical config writes nothing and records nothing.
    const unchanged = saveConfig(loadConfig(), { command: ["noop"] });
    expect(unchanged.changed).toBe(false);

    const records = journal(home);
    expect(records.map((record) => record.command)).toEqual([["config", "set", "defaultActor"], ["use", "--clear"]]);
    expect(records[0]).toMatchObject({
      contractVersion: "tasq.config-change.v1",
      changes: { defaultActor: { before: "gwendall", after: "someone-else" } },
      bindings: { added: [], removed: [], changed: [], preserved: [dirB] },
    });
    expect(records[1].bindings).toMatchObject({ removed: [dirA] });
  });

  test("every command that writes the config leaves a journal record naming itself", async () => {
    const { home, base } = sandbox();
    const first = project(base, "first");
    await json(home, first, ["setup", "--space", "acme/first", "--actor", "gwendall"]);
    await json(home, first, ["use", "acme/other"]);
    await json(home, first, ["use", "--clear"]);
    const commands = journal(home).map((record) => record.command);
    expect(commands).toEqual([["setup"], ["use"], ["use", "--clear"]]);
    const bound = journal(home)[1];
    expect(bound.bindings.changed).toEqual([realpathSync(first)]);
    expect(bound.changes).toEqual({});
  });
});

describe("what the repository declares is compared with what commands would do", () => {
  test("use reports the managed block, names the drift, and --from-instructions repairs it", async () => {
    const { home, base } = sandbox();
    const first = project(base, "first");
    const canonical = realpathSync(first);
    await json(home, first, ["setup", "--space", "acme/first", "--actor", "gwendall"]);

    const bound = await json(home, first, ["use"]);
    expect(bound.managedBlock).toMatchObject({
      directory: canonical,
      target: join(canonical, "AGENTS.md"),
      space: "acme/first",
      verified: true,
      matchesEffective: true,
    });
    expect(bound.drift).toBe(false);

    // The private binding is lost; the repository still says acme/first.
    await json(home, first, ["use", "--clear"]);
    const lost = await json(home, first, ["use"]);
    expect(lost.effective).toMatchObject({ space: "acme/first", source: "global_default" });
    expect(lost.managedBlock).toMatchObject({ space: "acme/first", verified: true, matchesEffective: false });
    expect(lost.drift).toBe(true);
    const human = await ok(home, first, ["use"]);
    expect(human.stdout).toContain("tasq use --from-instructions");

    // Bound to another space than the block names is drift too.
    const elsewhere = await json(home, first, ["use", "acme/other"]);
    expect(elsewhere.drift).toBe(true);

    // An explicit override is a decision, not drift.
    const overridden = await json(home, first, ["use"], { TASQ_TENANT: "env/override" });
    expect(overridden.drift).toBe(false);

    // The repair takes the space from AGENTS.md and binds the block's directory,
    // even from a subdirectory.
    const deep = join(first, "src", "feature");
    mkdirSync(deep, { recursive: true });
    const repaired = await json(home, deep, ["use", "--from-instructions"]);
    expect(repaired).toMatchObject({
      action: "bound",
      changed: true,
      directory: canonical,
      binding: "acme/first",
      restoredFrom: { target: join(canonical, "AGENTS.md"), space: "acme/first" },
      effective: { space: "acme/first", source: "directory", directory: canonical },
      drift: false,
    });
    expect(configFile(home).directorySpaces).toEqual({ [canonical]: "acme/first" });
  });

  test("--from-instructions refuses without a verified block, and says why", async () => {
    const { home, base } = sandbox();
    const bare = project(base, "bare");
    const refused = await run(home, bare, ["use", "--from-instructions"]);
    expect(refused.exitCode).not.toBe(0);
    expect(refused.stderr).toContain("No verified Tasq managed block");
    expect(existsSync(join(home, ".tasq", "config.json"))).toBe(false);

    const first = project(base, "first");
    await json(home, first, ["setup", "--space", "acme/first", "--actor", "gwendall"]);
    await json(home, first, ["use", "--clear"]);
    const target = join(first, "AGENTS.md");
    writeFileSync(target, readFileSync(target, "utf8").replace("claim exactly one task", "claim every task"), "utf8");
    const tampered = await run(home, first, ["use", "--from-instructions"]);
    expect(tampered.exitCode).not.toBe(0);
    expect(tampered.stderr).toContain("content digest differs from marker");
    const shown = await json(home, first, ["use"]);
    expect(shown.managedBlock).toMatchObject({ verified: false, reason: "content digest differs from marker" });
    expect(shown.drift).toBe(false);
  });
});

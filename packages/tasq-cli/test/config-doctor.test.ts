/**
 * `tasq doctor --config` reads the configuration that decides which store a
 * command reaches, and says what is wrong with it before anything is opened.
 *
 * On 2026-09-02 this project's own config held two bindings to deleted
 * scratch directories, a projection target under a test's temporary
 * directory, and no binding for this checkout while its AGENTS.md named
 * `tasq/dev`. Every command refused or wrote elsewhere, and nothing said so.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const cli = join(root, "src", "index.ts");
const temporary: string[] = [];
setDefaultTimeout(60_000);

interface Result { stdout: string; stderr: string; exitCode: number }

function sandbox(): { home: string; base: string } {
  const base = mkdtempSync(join(tmpdir(), "tasq-config-doctor-"));
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

async function doctorConfig(home: string, cwd: string): Promise<{ report: any; exitCode: number }> {
  const result = await run(home, cwd, ["doctor", "--config", "--json"]);
  return { report: JSON.parse(result.stdout), exitCode: result.exitCode };
}

function codes(report: any): string[] {
  return report.findings.map((finding: { code: string }) => finding.code);
}

function journal(home: string): any[] {
  const path = join(home, ".tasq", "config-journal.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line));
}

describe("doctor --config", () => {
  test("a project that is set up is consistent, and the check opens no store", async () => {
    const { home, base } = sandbox();
    const first = project(base, "first");
    await json(home, first, ["setup", "--space", "acme/first", "--actor", "gwendall"]);
    const { report, exitCode } = await doctorConfig(home, first);
    expect(exitCode).toBe(0);
    expect(report).toMatchObject({
      contractVersion: "tasq.config-doctor.v1",
      ok: true,
      effective: { space: "acme/first", source: "directory" },
      drift: false,
      bindings: { total: 1, dangling: [], temporary: [] },
      globalDefault: { space: "acme/first", boundIn: [realpathSync(first)] },
      findings: [],
    });
    expect(report.managedBlock).toMatchObject({ space: "acme/first", verified: true, matchesEffective: true });
  });

  test("a repository whose block names a space no command would use is drift, and doctor fails on it", async () => {
    const { home, base } = sandbox();
    const first = project(base, "first");
    await json(home, first, ["setup", "--space", "acme/first", "--actor", "gwendall"]);
    await json(home, first, ["use", "--clear"]);

    const { report, exitCode } = await doctorConfig(home, first);
    expect(exitCode).toBe(1);
    expect(report.ok).toBe(false);
    expect(report.findings).toEqual([
      expect.objectContaining({
        code: "binding_drift",
        severity: "error",
        entityType: "directory",
        entityId: realpathSync(first),
        repair: "tasq use --from-instructions",
      }),
    ]);
    expect(report.findings[0].message).toContain("is not bound");

    // The full doctor carries the same section and fails for the same reason.
    const full = await run(home, first, ["doctor", "--json"]);
    expect(full.exitCode).toBe(1);
    const fullReport = JSON.parse(full.stdout);
    expect(fullReport.ok).toBe(false);
    expect(codes(fullReport.config)).toEqual(["binding_drift"]);
    expect(fullReport.store.sqliteIntegrity).toBe("ok");

    // The human rendering keeps the doctor's shape: a finding, then its entity.
    const human = await run(home, first, ["doctor", "--config"]);
    const lines = human.stdout.split("\n");
    const index = lines.findIndex((line) => line.startsWith("  - binding_drift: "));
    expect(index).toBeGreaterThan(-1);
    expect(lines[index + 1]).toMatch(/^ {6}directory \S+/);

    await json(home, first, ["use", "--from-instructions"]);
    expect((await doctorConfig(home, first)).report.ok).toBe(true);
  });

  test("a machine with no config is not drifting, it is not set up, and that is a warning", async () => {
    const { home, base } = sandbox();
    const first = project(base, "first");
    await json(home, first, ["setup", "--space", "acme/first", "--actor", "gwendall"]);
    rmSync(join(home, ".tasq"), { recursive: true, force: true });
    const { report, exitCode } = await doctorConfig(home, first);
    expect(exitCode).toBe(0);
    expect(report.ok).toBe(true);
    expect(report.findings).toEqual([
      expect.objectContaining({
        code: "project_not_set_up",
        severity: "warning",
        repair: "tasq setup --space acme/first --actor <stable-label>",
      }),
    ]);
  });

  test("bound to another space than the block names is drift too, and an override is not", async () => {
    const { home, base } = sandbox();
    const first = project(base, "first");
    await json(home, first, ["setup", "--space", "acme/first", "--actor", "gwendall"]);
    await json(home, first, ["use", "acme/other"]);
    const { report } = await doctorConfig(home, first);
    // The global default acme/first is now bound nowhere, which is its own warning.
    expect(codes(report)).toEqual(["binding_drift", "default_space_unbound"]);
    expect(report.findings[0].message).toContain("is bound to acme/other");

    const overridden = await run(home, first, ["doctor", "--config", "--json"], { TASQ_TENANT: "env/override" });
    expect(overridden.exitCode).toBe(0);
    expect(JSON.parse(overridden.stdout).drift).toBe(false);
  });

  test("a binding to a directory that no longer exists is reported, and --prune-bindings removes only that one", async () => {
    const { home, base } = sandbox();
    const first = project(base, "first");
    const gone = project(base, "gone");
    await json(home, first, ["setup", "--space", "acme/first", "--actor", "gwendall"]);
    await json(home, gone, ["setup", "--space", "acme/gone", "--actor", "gwendall"]);
    const goneCanonical = realpathSync(gone);
    rmSync(gone, { recursive: true, force: true });

    const { report, exitCode } = await doctorConfig(home, first);
    expect(exitCode).toBe(0);
    expect(report.ok).toBe(true);
    expect(report.bindings.dangling).toEqual([goneCanonical]);
    expect(report.findings).toEqual([
      expect.objectContaining({ code: "dangling_binding", severity: "warning", entityId: goneCanonical }),
    ]);

    const pruned = await json(home, first, ["doctor", "--config", "--prune-bindings"]);
    expect(pruned.repairs.prunedBindings).toEqual([goneCanonical]);
    expect(pruned.findings).toEqual([]);
    expect(pruned.bindings).toMatchObject({ total: 1, dangling: [] });
    const record = journal(home).at(-1);
    expect(record.command).toEqual(["doctor", "--prune-bindings"]);
    expect(record.bindings.removed).toEqual([goneCanonical]);
    expect(JSON.parse(readFileSync(join(home, ".tasq", "config.json"), "utf8")).directorySpaces).toEqual({
      [realpathSync(first)]: "acme/first",
    });
  });

  test("a global default bound to no directory is named once other projects are bound", async () => {
    const { home, base } = sandbox();
    const first = project(base, "first");
    const second = project(base, "second");
    await json(home, first, ["setup", "--space", "acme/first", "--actor", "gwendall"]);
    await json(home, second, ["setup", "--space", "acme/second", "--actor", "gwendall"]);
    await json(home, first, ["use", "--clear"]);
    const { report } = await doctorConfig(home, second);
    expect(report.globalDefault).toEqual({ space: "acme/first", boundIn: [] });
    expect(codes(report)).toEqual(["default_space_unbound"]);
    expect(report.ok).toBe(true);
  });

  test("a global projection target is ignored in a bound directory, and said so", async () => {
    const { home, base } = sandbox();
    const first = project(base, "first");
    const elsewhere = project(base, "elsewhere");
    await json(home, first, ["setup", "--space", "acme/first", "--actor", "gwendall"]);
    await ok(home, first, ["config", "set", "projectionTarget", join(elsewhere, "TASKS.md")]);
    const ignored = await doctorConfig(home, first);
    expect(ignored.exitCode).toBe(0);
    expect(ignored.report.projection).toBeNull();
    expect(ignored.report.findings).toEqual([
      expect.objectContaining({ code: "global_projection_ignored_here", severity: "warning", entityType: "directory" }),
    ]);

    await json(home, first, ["use", "acme/first", "--project-to", "TASKS.md"]);
    const own = await doctorConfig(home, first);
    expect(own.report.projection).toBe(join(realpathSync(first), "TASKS.md"));
    expect(own.report.findings).toEqual([]);
  });

  test("a hand-edited projection outside its directory is an error", async () => {
    const { home, base } = sandbox();
    const first = project(base, "first");
    const elsewhere = project(base, "elsewhere");
    await json(home, first, ["setup", "--space", "acme/first", "--actor", "gwendall"]);
    const path = join(home, ".tasq", "config.json");
    const config = JSON.parse(readFileSync(path, "utf8"));
    config.directoryProjections = { [realpathSync(first)]: join(realpathSync(elsewhere), "TASKS.md") };
    await Bun.write(path, JSON.stringify(config));
    const { report, exitCode } = await doctorConfig(home, first);
    expect(exitCode).toBe(1);
    expect(report.findings).toEqual([
      expect.objectContaining({ code: "projection_outside_bound_tree", severity: "error", entityType: "file" }),
    ]);
  });

  test("an unreadable config is one finding, not a stack trace", async () => {
    const { home, base } = sandbox();
    const first = project(base, "first");
    mkdirSync(join(home, ".tasq"), { mode: 0o700 });
    await Bun.write(join(home, ".tasq", "config.json"), "{ not json");
    const result = await run(home, first, ["doctor", "--config", "--json"]);
    expect(result.exitCode).toBe(1);
    const report = JSON.parse(result.stdout);
    expect(codes(report)).toEqual(["config_unreadable"]);
    expect(report.effective).toBeNull();
  });
});

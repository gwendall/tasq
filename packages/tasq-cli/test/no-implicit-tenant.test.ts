/**
 * A machine with no configuration has no space.
 *
 * The built-in defaults named one person's space and actor, so every command
 * run before setup, on any machine, wrote into that person's ledger. Now an
 * unbound directory on an unconfigured machine refuses and says what to do,
 * `tasq init` creates a neutral local space it writes to the file, and the
 * first project set up becomes the default.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const cli = join(root, "src", "index.ts");
const temporary: string[] = [];
setDefaultTimeout(60_000);

interface Result { stdout: string; stderr: string; exitCode: number }

function sandbox(): { home: string; project: string } {
  const base = mkdtempSync(join(tmpdir(), "tasq-no-implicit-tenant-"));
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

async function run(home: string, cwd: string, argv: string[]): Promise<Result> {
  const child = Bun.spawn([process.execPath, "run", cli, ...argv], {
    cwd,
    env: {
      ...process.env,
      HOME: home,
      TASQ_HOME: join(home, ".tasq"),
      TASQ_DB_URL: "",
      TASQ_EVENT_JOURNAL_PATH: "",
      TASQ_TENANT: "",
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

describe("no implicit tenant", () => {
  test("an unconfigured machine refuses, names the two ways out, and writes nothing", async () => {
    const { home, project } = sandbox();
    const refused = await run(home, project, ["add", "Anything at all"]);
    expect(refused.exitCode).not.toBe(0);
    expect(refused.stderr).toContain("No Tasq space is selected here");
    expect(refused.stderr).toContain("tasq setup --space");
    expect(refused.stderr).toContain("tasq init");
    expect(existsSync(join(home, ".tasq", "config.json"))).toBe(false);
    expect(existsSync(join(home, ".tasq", "db.sqlite"))).toBe(false);

    const shown = JSON.parse((await run(home, project, ["use", "--json"])).stdout);
    expect(shown.effective).toEqual({ space: "", source: "global_default", directory: null });
    expect(shown.globalDefault).toBe("");
  });

  test("init creates a neutral local default and says so in the file", async () => {
    const { home, project } = sandbox();
    const initialized = JSON.parse((await run(home, project, ["init", "--json"])).stdout);
    expect(initialized.tenantId).toBe("local/default");
    const config = JSON.parse(readFileSync(join(home, ".tasq", "config.json"), "utf8"));
    expect(config.tenantId).toBe("local/default");
    // The default actor is the account running the command, whatever it is
    // called: the point is that no name is baked into the executable.
    expect(config.defaultActor).toBe(userInfo().username);

    const added = JSON.parse((await run(home, project, ["add", "First local task", "--json"])).stdout);
    expect(added.tenantId).toBe("local/default");

    // Running init again keeps what the file says.
    const again = JSON.parse((await run(home, project, ["init", "--json"])).stdout);
    expect(again.tenantId).toBe("local/default");
  });

  test("the first project set up becomes the default, and no personal name appears anywhere", async () => {
    const { home, project } = sandbox();
    const setup = JSON.parse((await run(home, project, ["setup", "--space", "acme/app", "--actor", "alpha", "--json"])).stdout);
    expect(setup.globalDefault).toEqual({ space: "acme/app", changed: true, source: "first" });
    const config = readFileSync(join(home, ".tasq", "config.json"), "utf8");
    expect(config).not.toContain("gwendall");
  });
});

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { publicCodeExamples } from "../src/lib/examples";
import { productTruth } from "../src/lib/product-truth";

const repositoryRoot = resolve(import.meta.dir, "../../..");
const releaseVersion = productTruth.release.version;
let home = "";
let environment: Record<string, string> = {};

async function runShell(source: string) {
  const child = Bun.spawn(["bash", "-lc", source], {
    cwd: home,
    env: environment,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

beforeAll(async () => {
  home = await mkdtemp(resolve(tmpdir(), "tasq-public-commands-"));
  environment = {
    ...process.env,
    HOME: home,
    TASQ_HOME: resolve(home, ".tasq"),
    TASQ_DB_URL: `file:${resolve(home, "sdk.sqlite")}`,
  };
});

afterAll(async () => {
  await rm(home, { recursive: true, force: true });
});

describe("displayed public commands", () => {
  test("keeps every code example classified and free of rendered diff markers", () => {
    expect(Object.keys(publicCodeExamples)).toEqual([
      "quickTry",
      "nativeInstall",
      "install",
      "onboard",
      "mcp",
      "console",
      "operations",
      "sdk",
      "lifecycle",
    ]);
    for (const example of Object.values(publicCodeExamples)) {
      expect(["shell", "typescript", "concept"]).toContain(example.kind);
      expect(example.display).not.toMatch(/(?:^|\n)\s*\+/);
    }
  });

  test("executes both exact one-shot package runners", async () => {
    const result = await runShell(publicCodeExamples.quickTry.display);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout.trim().split("\n")).toEqual([releaseVersion, releaseVersion]);
  }, 30_000);

  test("runs the generated verified installer lifecycle without touching data", async () => {
    const prefix = resolve(home, "native-prefix");
    const liveHome = resolve(home, "live-tasq-home");
    await mkdir(liveHome, { recursive: true });
    const marker = resolve(liveHome, "ledger-marker");
    await writeFile(marker, "preserve-me");
    const installer = resolve(repositoryRoot, `apps/site/public/install-v${releaseVersion}.sh`);

    const dryRun = await runShell(`sh "${installer}" --dry-run --version ${releaseVersion} --prefix "${prefix}"`);
    expect(dryRun.exitCode, dryRun.stderr).toBe(0);
    expect(dryRun.stdout).toContain("checksum-of-checksums");

    const install = await runShell(`TASQ_HOME="${liveHome}" sh "${installer}" --version ${releaseVersion} --prefix "${prefix}"`);
    expect(install.exitCode, install.stderr).toBe(0);
    const version = await runShell(`"${prefix}/bin/tasq" version`);
    expect(version.exitCode, version.stderr).toBe(0);
    expect(version.stdout.trim()).toBe(releaseVersion);

    const uninstall = await runShell(`TASQ_HOME="${liveHome}" sh "${installer}" --uninstall --version ${releaseVersion} --prefix "${prefix}"`);
    expect(uninstall.exitCode, uninstall.stderr).toBe(0);
    expect(await readFile(marker, "utf8")).toBe("preserve-me");
  }, 120_000);

  test("installs the exact published CLI and executes every displayed Local command", async () => {
    const install = await runShell(publicCodeExamples.install.display);
    expect(install.exitCode, install.stderr).toBe(0);
    expect(install.stdout).toContain(releaseVersion);

    const onboard = await runShell(publicCodeExamples.onboard.display);
    expect(onboard.exitCode, onboard.stderr).toBe(0);
    expect(JSON.parse(onboard.stdout)).toMatchObject({
      contractVersion: "tasq.autonomous-bootstrap.v1",
      space: { workspaceId: "robotics/team-a" },
      actor: {
        alias: "agent:planner",
        authentication: "local_process_self_asserted",
      },
      transportBoundary: "local_process",
      recipeCapabilities: ["read", "propose", "coordinate"],
      guide: { firstReadRecipeId: "context.read" },
    });

    const mcp = Bun.spawn(["bash", "-lc", publicCodeExamples.mcp.display], {
      cwd: home,
      env: environment,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    mcp.stdin.end();
    const [mcpExit, mcpError] = await Promise.all([
      mcp.exited,
      new Response(mcp.stderr).text(),
    ]);
    expect(mcpExit, mcpError).toBe(0);

    const [tasqBinding, webLine, statusLine] = publicCodeExamples.console.display.split("\n");
    const webCommand = `${tasqBinding}\n${webLine}`;
    const statusCommand = `${tasqBinding}\n${statusLine}`;
    const web = Bun.spawn(["bash", "-lc", webCommand], {
      cwd: home,
      env: environment,
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      let status: Awaited<ReturnType<typeof runShell>> | undefined;
      for (let attempt = 0; attempt < 50; attempt++) {
        status = await runShell(statusCommand);
        if (status.exitCode === 0) break;
        await Bun.sleep(100);
      }
      expect(status?.exitCode, status?.stderr).toBe(0);
      expect(JSON.parse(status!.stdout)).toMatchObject({
        contractVersion: "tasq.console-discovery.v1",
        state: "running",
        workspaceId: "robotics/team-a",
        descriptor: {
          contractVersion: "tasq.console-listener.v1",
          workspaceId: "robotics/team-a",
          access: { readOnly: true },
        },
      });
    } finally {
      web.kill("SIGTERM");
      await web.exited;
    }

    const operations = await runShell(publicCodeExamples.operations.display);
    expect(operations.exitCode, operations.stderr).toBe(0);
    expect(operations.stdout).toContain("backup written to");
  }, 120_000);

  test("executes the displayed embedded Core example against an isolated store", async () => {
    expect(publicCodeExamples.sdk.display as string).toBe(
      (await readFile(resolve(repositoryRoot, "packages/tasq-core/examples/local-client.mjs"), "utf8")).trim(),
    );
    const child = Bun.spawn([process.execPath, "-e", publicCodeExamples.sdk.display], {
      cwd: resolve(repositoryRoot, "packages/tasq-core"),
      env: environment,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(exitCode, stderr).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ status: "done" });
  }, 30_000);
});

/**
 * A dev build must never displace the published one.
 *
 * The published `tasq` is the only thing that can answer "does this work for
 * somebody who installed it", and a dev build that overwrites it takes that
 * question away silently.
 */

import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

const productRoot = resolve(import.meta.dir, "../../..");
const script = resolve(productRoot, "scripts/dev-cli.ts");

async function run(args: string[], home: string) {
  const child = Bun.spawn(["bun", script, ...args], {
    cwd: productRoot,
    env: { PATH: process.env.PATH ?? "", HOME: home },
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

describe("dev:link", () => {
  test("the shim it writes never names the published binary", async () => {
    const printed = await run(["--print"], process.env.HOME ?? "");
    expect(printed.exitCode, printed.stderr).toBe(0);
    // It runs the build, and it says which one out loud.
    expect(printed.stdout).toContain("dist/cli/index.js");
    // `exec "$BUILD"` is the only thing it execs, so `tasq` cannot be reached
    // through it even by accident.
    expect(printed.stdout).toContain('exec "$BUILD"');
    expect(printed.stdout).not.toMatch(/exec\s+["']?tasq["']?\s/);
  });

  test("a missing checkout or build fails with exit 3, not a stack trace", async () => {
    // A launcher pointing at a build that cannot run is the failure mode that
    // broke this machine once, so it is a contract, not a nicety.
    const printed = await run(["--print"], process.env.HOME ?? "");
    expect(printed.stdout).toContain("exit 3");
    expect(printed.stdout).toContain("pnpm dev:link");
    expect(printed.stdout).toContain("pnpm build:cli");
  });

  test("a git worktree, whose .git is a file, is a live checkout", async () => {
    // `git worktree add` leaves a .git FILE that points at the main repository.
    // The shim tested for a directory, so every worktree was reported as a
    // checkout that is gone, with the build sitting right there.
    const { chmodSync, mkdirSync, mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const checkout = mkdtempSync(join(tmpdir(), "tasq-dev-link-worktree-"));
    writeFileSync(join(checkout, ".git"), "gitdir: /elsewhere/.git/worktrees/main\n");
    mkdirSync(join(checkout, "dist", "cli"), { recursive: true });
    const build = join(checkout, "dist", "cli", "index.js");
    writeFileSync(build, '#!/bin/sh\necho "fake-build $@"\n');
    chmodSync(build, 0o755);
    const printed = await run(["--print"], process.env.HOME ?? "");
    expect(printed.exitCode, printed.stderr).toBe(0);
    const shim = join(checkout, "tasq-dev");
    writeFileSync(shim, printed.stdout
      .replace(/REPO="[^"]*"/, `REPO="${checkout}"`)
      .replace(/BUILD="[^"]*"/, `BUILD="${build}"`));
    chmodSync(shim, 0o755);
    const child = Bun.spawn([shim, "--version"], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(exitCode, stderr).toBe(0);
    expect(stdout).toContain("fake-build --version");
  });

  test("it refuses to replace a launcher it did not write", async () => {
    const { mkdirSync, writeFileSync, mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const home = mkdtempSync(join(tmpdir(), "tasq-dev-link-"));
    const bin = join(home, ".local", "bin");
    mkdirSync(bin, { recursive: true });
    const handWritten = "#!/bin/sh\n# somebody's own launcher\nexec true\n";
    writeFileSync(join(bin, "tasq-dev"), handWritten, "utf8");

    const refused = await run([], home);
    expect(refused.exitCode).not.toBe(0);
    expect(refused.stderr).toContain("this script did not write it");
    expect(refused.stderr).toContain("--force");
    // And it left the file exactly as it found it.
    const { readFileSync } = await import("node:fs");
    expect(readFileSync(join(bin, "tasq-dev"), "utf8")).toBe(handWritten);
  });
});

/** Guards that no suite can write into a developer's real ledger. */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dir, "../..");

function packagesWithTests(): string[] {
  const roots = ["packages", "apps"];
  const found: string[] = [];
  for (const root of roots) {
    const base = join(repositoryRoot, root);
    if (!existsSync(base)) continue;
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const manifest = join(base, entry.name, "package.json");
      if (!existsSync(manifest)) continue;
      const parsed = JSON.parse(readFileSync(manifest, "utf8")) as {
        scripts?: Record<string, string>;
      };
      if (parsed.scripts?.test) found.push(join(root, entry.name));
    }
  }
  return found;
}

describe("test isolation contract", () => {
  test("the guard neutralises every ambient Tasq variable", () => {
    const guard = readFileSync(join(repositoryRoot, "scripts/test-isolation.ts"), "utf8");
    for (const name of [
      "TASQ_HOME",
      "TASQ_TENANT",
      "TASQ_ACTOR",
      "TASQ_DB_URL",
      "TASQ_EVENT_JOURNAL_PATH",
      "TASQ_PROJECTION_TARGET",
    ]) {
      expect(guard, `${name} must be neutralised before any suite runs`).toContain(name);
    }
    expect(guard).toContain("mkdtempSync");
  });

  test("every package that runs tests preloads the guard", () => {
    const missing: string[] = [];
    for (const pkg of packagesWithTests()) {
      const bunfig = join(repositoryRoot, pkg, "bunfig.toml");
      if (!existsSync(bunfig)) {
        missing.push(`${pkg} (no bunfig.toml)`);
        continue;
      }
      const contents = readFileSync(bunfig, "utf8");
      if (!contents.includes("scripts/test-isolation.ts")) {
        missing.push(`${pkg} (bunfig.toml does not preload the guard)`);
      }
    }
    expect(missing, "a suite without the guard can write into a real ledger").toEqual([]);
  });

  test("the guard is actually in force while this suite runs", () => {
    // Proves the preload reached this process rather than merely existing on
    // disk: TASQ_HOME points at a throwaway directory, never a developer home.
    const home = process.env.TASQ_HOME ?? "";
    expect(home).toContain("tasq-test-home-");
    expect(home).not.toContain(`${process.env.HOME ?? "/nonexistent"}/.tasq`);
    for (const name of ["TASQ_TENANT", "TASQ_DB_URL", "TASQ_ACTOR"]) {
      expect(process.env[name], `${name} must not leak into a suite`).toBeUndefined();
    }
  });
});

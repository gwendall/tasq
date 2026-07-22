import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dir, "../..");
const ignoredDirectories = new Set([
  ".git",
  ".next",
  "dist",
  "node_modules",
  "out",
  "test-results",
]);

function walk(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) {
      if (ignoredDirectories.has(entry.name)) return [];
      return walk(join(directory, entry.name));
    }
    return [join(directory, entry.name)];
  });
}

function read(path: string): string {
  return readFileSync(join(repositoryRoot, path), "utf8");
}

function workspaceDirectories(): string[] {
  return ["apps", "packages"].flatMap((group) =>
    readdirSync(join(repositoryRoot, group), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(repositoryRoot, group, entry.name))
      .filter((directory) => existsSync(join(directory, "package.json"))),
  );
}

function markdownTargets(markdown: string): string[] {
  const targets: string[] = [];
  const pattern = /!?\[[^\]]*\]\(([^)]+)\)/g;
  for (const match of markdown.matchAll(pattern)) {
    let target = match[1]!.trim();
    if (target.startsWith("<") && target.endsWith(">")) {
      target = target.slice(1, -1);
    } else {
      target = target.split(/\s+["']/)[0]!;
    }
    targets.push(target);
  }
  return targets;
}

describe("standalone documentation contract", () => {
  test("every relative Markdown link resolves inside the repository", () => {
    const failures: string[] = [];
    const markdownFiles = walk(repositoryRoot).filter(
      (path) => extname(path).toLowerCase() === ".md",
    );

    for (const markdownPath of markdownFiles) {
      const markdown = readFileSync(markdownPath, "utf8");
      for (const rawTarget of markdownTargets(markdown)) {
        if (
          rawTarget === "" ||
          rawTarget.startsWith("#") ||
          /^[a-z][a-z0-9+.-]*:/i.test(rawTarget)
        ) {
          continue;
        }
        const pathPart = rawTarget.split("#", 1)[0]!;
        let decoded: string;
        try {
          decoded = decodeURIComponent(pathPart);
        } catch {
          failures.push(`${relative(repositoryRoot, markdownPath)} -> invalid URI ${rawTarget}`);
          continue;
        }
        const absoluteTarget = resolve(dirname(markdownPath), decoded);
        if (
          !absoluteTarget.startsWith(`${repositoryRoot}/`) ||
          !existsSync(absoluteTarget)
        ) {
          failures.push(`${relative(repositoryRoot, markdownPath)} -> ${rawTarget}`);
        }
      }
    }

    expect(failures).toEqual([]);
  });

  test("every workspace has local ownership documentation", () => {
    const missing = workspaceDirectories()
      .filter((directory) => !existsSync(join(directory, "README.md")))
      .map((directory) => relative(repositoryRoot, directory));
    expect(missing).toEqual([]);
  });

  test("root onboarding identifies the canonical repository and safe work loop", () => {
    const agents = read("AGENTS.md");
    const skill = read("SKILL.md");
    const development = read("DEVELOPMENT.md");
    const contributing = read("CONTRIBUTING.md");
    const rootPackage = JSON.parse(read("package.json")) as {
      scripts: Record<string, string>;
    };

    expect(agents).toContain("https://github.com/gwendall/tasq");
    expect(agents).toContain("DEVELOPMENT.md");
    expect(agents).toContain("pnpm docs:check");
    expect(agents).toContain("pnpm typecheck");
    expect(agents).toContain("pnpm test");
    expect(agents).toContain("Never publish packages");
    expect(skill).toContain("tasq onboard --space <explicit-context-id> --actor <stable-label> --json");
    expect(skill).toContain("Attempt success never completes");
    expect(skill).toContain("Never read or write the live SQLite database directly");
    expect(skill).not.toContain("@kami/");
    expect(skill).not.toContain("/Users/");
    expect(development).toContain("Repository map and change routing");
    expect(development).toContain("Do not publish, tag, deploy");
    expect(contributing).toContain("pnpm docs:check");
    expect(rootPackage.scripts["docs:check"]).toBe(
      "bun test packages/tasq-evals/documentation-contract.test.ts",
    );
  });

  test("current contributor commands never route back to the historical subtree", () => {
    for (const path of [
      "AGENTS.md",
      "CONTRIBUTING.md",
      "DEVELOPMENT.md",
      "README.md",
      "TESTING.md",
    ]) {
      const content = read(path);
      expect(content).not.toContain("cd products/tasq");
    }
    expect(read("CONTRIBUTING.md")).not.toContain("Run `bun test` from the Tasq root");
  });

  test("package metadata distinguishes publish candidates from private composition", () => {
    const failures: string[] = [];
    for (const directory of workspaceDirectories()) {
      const manifest = JSON.parse(
        readFileSync(join(directory, "package.json"), "utf8"),
      ) as { name?: string; private?: boolean; description?: string };
      const label = relative(repositoryRoot, directory);
      if (!manifest.name) failures.push(`${label}: missing name`);
      if (!manifest.description?.trim()) failures.push(`${label}: missing description`);
      if (manifest.description?.toLowerCase().includes("tasq-zero")) {
        failures.push(`${label}: obsolete tasq-zero description`);
      }
      if (manifest.name?.startsWith("@tasq-internal/") && manifest.private !== true) {
        failures.push(`${label}: internal package must be private`);
      }
      if (manifest.name?.startsWith("@tasq/") && manifest.private === true) {
        failures.push(`${label}: public candidate cannot be marked private`);
      }
    }
    expect(failures).toEqual([]);
  });

  test("standalone docs contain no workstation paths or references to omitted contracts", () => {
    const forbiddenReferences = [
      "UNIVERSAL_COMPATIBILITY_INVENTORY.md",
      "UK-011_UNIVERSAL_ACCEPTANCE.md",
      "TQ-311_AUTONOMOUS_ONBOARDING_ACCEPTANCE.md",
      "console-installed-contract.test.ts",
      "universal-from-scratch-onboarding.test.ts",
    ];
    const failures: string[] = [];
    for (const path of walk(repositoryRoot).filter((value) => extname(value) === ".md")) {
      const content = readFileSync(path, "utf8");
      const label = relative(repositoryRoot, path);
      if (content.includes("/Users/")) failures.push(`${label}: workstation path`);
      for (const forbidden of forbiddenReferences) {
        if (content.includes(forbidden)) failures.push(`${label}: ${forbidden}`);
      }
    }
    expect(failures).toEqual([]);
  });
});

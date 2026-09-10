import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
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

/**
 * Markdown this repository actually ships, which is exactly what git tracks.
 *
 * Walking the filesystem instead scans ignored directories - local research
 * notes, scratch files - and reports a workstation path in material that can
 * never be published. Found on 2026-08-27 when a gitignored notes directory
 * failed this gate.
 */
function trackedMarkdown(): string[] {
  const listed = spawnSync("git", ["ls-files", "-z", "--", "*.md"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  if (listed.status !== 0) {
    throw new Error(`git ls-files failed; cannot determine what this repository publishes: ${listed.stderr}`);
  }
  return listed.stdout.split("\0").filter(Boolean).map((value) => join(repositoryRoot, value));
}

/** Source files git tracks, repository-relative. Same reason as trackedMarkdown. */
function trackedFiles(pattern: string): string[] {
  const listed = spawnSync("git", ["ls-files", "-z", "--", pattern], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  if (listed.status !== 0) {
    throw new Error(`git ls-files failed: ${listed.stderr}`);
  }
  return listed.stdout.split("\0").filter(Boolean);
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

  test("keeps the repository root focused on public and agent entrypoints", () => {
    const allowedRootMarkdown = new Set([
      "AGENTS.md",
  // Claude Code reads CLAUDE.md and not AGENTS.md; this one only imports it.
  "CLAUDE.md",
      "CHANGELOG.md",
      "CODE_OF_CONDUCT.md",
      "CONTRIBUTING.md",
      "GOVERNANCE.md",
      "README.md",
      "SECURITY.md",
      "SKILL.md",
      "SUPPORT.md",
    ]);
    const rootMarkdown = readdirSync(repositoryRoot)
      .filter((name) => extname(name).toLowerCase() === ".md")
      .sort();
    expect(rootMarkdown).toEqual([...allowedRootMarkdown].sort());

    for (const directory of [
      "concepts",
      "contracts",
      "decisions",
      "guides",
      "integrations",
      "reference",
      "releases",
      "roadmap",
    ]) {
      expect(existsSync(join(repositoryRoot, "docs", directory, "README.md"))).toBe(true);
    }
  });

  test("every command quoted in the AGENTS.md tasq block exists in the CLI", () => {
    // A documented command the CLI never accepted once reached a real agent and
    // cost it a full detour. Fail here instead.
    const agents = read("AGENTS.md");
    const block = /<!-- tasq:begin[^>]*-->([\s\S]*?)<!-- tasq:end -->/.exec(agents);
    expect(block, "AGENTS.md must carry the generated tasq block").not.toBeNull();

    const quoted = new Set(
      Array.from(block![1].matchAll(/"\$TASQ"\s+([a-z-]+)/g), (match) => match[1]),
    );
    expect(quoted.size).toBeGreaterThan(0);

    const usage = read("packages/tasq-cli/src/commands/usage.ts")
      + read("packages/tasq-cli/src/index.ts");
    for (const command of quoted) {
      expect(usage, `AGENTS.md documents "${command}", which the CLI must accept`)
        .toContain(command);
    }

    // The block informs; it must never carry ledger content, which agents read
    // as instructions. Only the space id and static protocol text belong here.
    expect(block![1]).not.toMatch(/\b019[0-9a-f]{5,}/);
  });

  test("every JSON contract version the CLI reference names is one the code emits", () => {
    // Nothing read CLI_JSON_CONTRACT.md, and it is the document an integrator
    // builds a parser against. Two entries had drifted: it described
    // `tasq.isolated-demo.v1` with a `before` key long after `demo` started
    // emitting v2 with `claimed`, `refusals` and `evidence`. A reference no
    // test reads is a promise nobody keeps.
    const reference = read("docs/reference/CLI_JSON_CONTRACT.md");
    const documented = new Set(
      Array.from(reference.matchAll(/`(tasq\.[a-z0-9-]+\.v\d+)`/g), (match) => match[1]!),
    );
    expect(documented.size).toBeGreaterThan(20);

    const sources = [
      ...trackedFiles("packages/tasq-cli/src/*.ts"),
      ...trackedFiles("packages/tasq-cli/src/**/*.ts"),
      ...trackedFiles("packages/tasq-core/src/*.ts"),
      ...trackedFiles("packages/tasq-core/src/**/*.ts"),
    ].map((path) => read(path)).join("\n");
    // Asserted as a boolean, not with toContain: the corpus is megabytes, and a
    // failure that prints the whole CLI source is a failure nobody reads.
    const unemitted = [...documented].filter((version) => !sources.includes(version));
    expect(unemitted, "CLI_JSON_CONTRACT.md documents contract versions nothing emits").toEqual([]);

    // The reverse direction is the one that let the demo contract drift: the
    // code moved to a new major and the document kept describing the old one.
    const superseded = [...documented].filter((version) => {
      const [name, major] = [version.replace(/\.v\d+$/, ""), Number(version.match(/\.v(\d+)$/)![1])];
      return sources.includes(`${name}.v${major + 1}`);
    });
    expect(superseded, "CLI_JSON_CONTRACT.md documents a contract version the code has already superseded").toEqual([]);
  });

  test("no tracked text uses an em-dash or en-dash", () => {
    // House style is the plain hyphen. 851 of these had accumulated across 219
    // files, which is enough for the punctuation itself to read as machine
    // output in the one repository whose whole pitch is that a human wrote it.
    //
    // Two exemptions, both for the same reason: their bytes are pinned by a
    // digest somewhere else, so restyling them does not tidy a file, it
    // falsifies a record. Applied migrations are checksummed, and editing a
    // comment in one makes every existing store refuse to open. Recorded
    // evidence under `evidence/` is a transcript of a run that happened, bound
    // by sha256 from the certificate that cites it.
    const exempt = /^(packages\/tasq-core\/src\/migrations\/\d{4}_.*\.sql|evidence\/.*)$/;
    const offenders: string[] = [];
    for (const path of trackedFiles("*")) {
      if (exempt.test(path)) continue;
      let text: string;
      try {
        text = read(path);
      } catch {
        continue; // binary or unreadable: nothing to style
      }
      if (text.includes("\u2014") || text.includes("\u2013")) offenders.push(path);
    }
    expect(offenders, "these files use an em-dash or en-dash where house style is a plain hyphen").toEqual([]);
  });

  test("root onboarding identifies the canonical repository and safe work loop", () => {
    const agents = read("AGENTS.md");
    const skill = read("SKILL.md");
    const development = read("docs/guides/DEVELOPMENT.md");
    const contributing = read("CONTRIBUTING.md");
    const rootPackage = JSON.parse(read("package.json")) as {
      scripts: Record<string, string>;
    };

    expect(agents).toContain("https://github.com/gwendall/tasq");
    expect(agents).toContain("docs/guides/DEVELOPMENT.md");
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
      "docs/guides/DEVELOPMENT.md",
      "README.md",
      "docs/guides/TESTING.md",
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
      if (manifest.name?.startsWith("@tasq-run/") && manifest.private === true) {
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
    for (const path of trackedMarkdown()) {
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

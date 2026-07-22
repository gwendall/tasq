import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

const siteRoot = resolve(import.meta.dir, "..");

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) return sourceFiles(path);
      return /\.(?:ts|tsx|css)$/.test(entry.name) ? [path] : [];
    }),
  );
  return nested.flat();
}

async function sourceText(): Promise<string> {
  const paths = await sourceFiles(resolve(siteRoot, "src"));
  paths.push(resolve(siteRoot, "scripts/generate-truth.ts"));
  return (await Promise.all(paths.map((path) => readFile(path, "utf8")))).join("\n");
}

describe("public site boundary", () => {
  test("contains no ambient clock read", async () => {
    const source = await sourceText();
    expect(source).not.toMatch(/\bDate\.now\s*\(/);
    expect(source).not.toMatch(/\bnew\s+Date\s*\(/);
    expect(source).not.toMatch(/\bperformance\.now\s*\(/);
  });

  test("does not advertise a nonexistent install or remote surface", async () => {
    const source = await sourceText();
    expect(source).not.toMatch(/npm\s+(?:i|install)\s+@tasq\//i);
    expect(source).not.toMatch(/curl[^\n]+(?:install|releases\/download)/i);
    expect(source).not.toMatch(/remote MCP (?:is )?(?:available|shipped)/i);
    expect(source).not.toMatch(/self-host(?:ed|ing)[^\n]+(?:available|shipped|ready)/i);
  });

  test("has no API route or Console coupling", async () => {
    const files = await sourceFiles(resolve(siteRoot, "src"));
    expect(files.some((path) => /[/\\]api[/\\]/.test(path))).toBe(false);
    const source = await sourceText();
    expect(source).not.toMatch(/(?:from|import\s*)\s*["']@tasq\/console/);
    expect(source).not.toMatch(/(?:from|import\s*)\s*["']@tasq\/core/);
    expect(source).not.toContain("TASQ_HOME/run/console");
  });

  test("marks the only product-state illustration as synthetic", async () => {
    const home = await readFile(resolve(siteRoot, "src/app/page.tsx"), "utf8");
    expect(home).toContain('data-synthetic-demo="true"');
    expect(home).toContain("Synthetic diagram:");
  });

  test("publishes the exact generated machine truth as a static asset", async () => {
    const [internal, publicAsset] = await Promise.all([
      readFile(resolve(siteRoot, "src/generated/product-truth.json"), "utf8"),
      readFile(resolve(siteRoot, "public/product-truth.json"), "utf8"),
    ]);
    expect(publicAsset).toBe(internal);
  });

  test("publishes a fail-closed pre-executable adoption contract", async () => {
    const [internalRaw, publicRaw] = await Promise.all([
      readFile(resolve(siteRoot, "src/generated/adopt.json"), "utf8"),
      readFile(resolve(siteRoot, "public/adopt.json"), "utf8"),
    ]);
    expect(publicRaw).toBe(internalRaw);
    const adoption = JSON.parse(publicRaw);
    expect(adoption).toMatchObject({
      contractVersion: "tasq.public-adoption.v1",
      support: "implemented_candidate_not_published",
      distribution: {
        mode: "source_build",
        published: false,
        repositoryAccess: "public",
        preconditions: [],
        sourceRefMutable: true,
      },
      human: { path: "/docs/getting-started/", primaryAction: "build_from_source" },
      agent: { executableRelativePath: "dist/cli/index.js" },
    });
    expect(adoption.invariants).not.toContain("private_prelaunch_repository_requires_authorized_access");
    const declared = new Set<string>(adoption.agent.placeholders as string[]);
    const serializedVectors = JSON.stringify([
      ...adoption.agent.acquisition.flatMap((step: { cwd: string; argv: string[] }) => [step.cwd, ...step.argv]),
      ...adoption.agent.onboardArgvTemplate,
    ]);
    const used = new Set(serializedVectors.match(/\{[A-Za-z]+\}/g) ?? []);
    expect(used).toEqual(declared);
    for (const step of adoption.agent.acquisition) {
      expect(step.argv).not.toContain("sh");
      expect(step.argv.join(" ")).not.toMatch(/&&|\|\||[|;]/);
    }
  });
});

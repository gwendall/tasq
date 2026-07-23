import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
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

  test("guards package installation behind generated release truth and never invents remote surfaces", async () => {
    const source = await sourceText();
    expect(source).toContain("productTruth.release.published");
    expect(source).toContain("@tasq-run/cli@");
    expect(source).toContain("https://tasq.run/install-v${releaseVersion}.sh");
    expect(source).not.toMatch(/curl[^\n]*\|\s*(?:ba)?sh/i);
    expect(source).not.toMatch(/curl[^\n]+releases\/download/i);
    expect(source).not.toMatch(/remote MCP (?:is )?(?:available|shipped)/i);
    expect(source).not.toMatch(/self-host(?:ed|ing)[^\n]+(?:available|shipped|ready)/i);
  });

  test("has no API route or Console coupling", async () => {
    const files = await sourceFiles(resolve(siteRoot, "src"));
    expect(files.some((path) => /[/\\]api[/\\]/.test(path))).toBe(false);
    const source = await sourceText();
    expect(source).not.toMatch(/^\s*import.+["']@tasq-run\/console/m);
    expect(source).not.toMatch(/^\s*import.+["']@tasq-run\/core/m);
    expect(source).not.toContain("TASQ_HOME/run/console");
  });

  test("distinguishes the synthetic coordination diagram from the real Console capture", async () => {
    const home = await readFile(resolve(siteRoot, "src/app/page.tsx"), "utf8");
    const screenshot = await readFile(resolve(siteRoot, "public/console-local.png"));
    expect(home).toContain('data-synthetic-demo="true"');
    expect(home).toContain("Synthetic diagram:");
    expect(home).toContain('src="/console-local.png"');
    expect(screenshot.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    expect(home).toContain('className="map-network"');
    expect(home.match(/className="map-path"/g)).toHaveLength(3);
    expect(home).not.toContain('className="map-line');
  });

  test("keeps interaction feedback physical and motion-safe", async () => {
    const [buttons, styles] = await Promise.all([
      readFile(resolve(siteRoot, "src/components/ui/button.tsx"), "utf8"),
      readFile(resolve(siteRoot, "src/app/globals.css"), "utf8"),
    ]);
    expect(buttons).toContain('"ui-button ');
    expect(buttons).toContain('data-variant={variant ?? "default"}');
    expect(buttons).not.toContain("hover:bg-[var(--signal)]");
    expect(buttons).toContain("hover:shadow-[3px_6px_0_var(--signal)]");
    expect(buttons).toContain("active:shadow-[3px_2px_0_var(--signal)]");
    expect(styles).toContain("box-shadow 240ms var(--ease-in-out)");
    expect(styles).toContain("transform 240ms var(--ease-in-out)");
    expect(styles).toContain(".ui-button:hover { --button-y: var(--button-hover-y); }");
    expect(styles).toContain("--button-scale: .98;");
    expect(styles).toContain("@media (hover: hover) and (pointer: fine)");
    expect(styles).toContain("@media (prefers-reduced-motion: reduce)");
  });

  test("renders the hero emphasis as an opaque brand color", async () => {
    const styles = await readFile(resolve(siteRoot, "src/app/globals.css"), "utf8");
    expect(styles).toContain("-webkit-text-fill-color: var(--signal)");
    expect(styles).not.toMatch(/\.text-outline\s*\{[^}]*color:\s*transparent/s);
  });

  test("publishes the exact generated machine truth as a static asset", async () => {
    const [internal, publicAsset] = await Promise.all([
      readFile(resolve(siteRoot, "src/generated/product-truth.json"), "utf8"),
      readFile(resolve(siteRoot, "public/product-truth.json"), "utf8"),
    ]);
    expect(publicAsset).toBe(internal);
  });

  test("publishes generated generic-agent entrypoints and a non-authoritative rendezvous schema", async () => {
    const copies = [
      ["../../plugins/tasq/skills/tasq/SKILL.md", "public/SKILL.md"],
      ["../../docs/integrations/AGENT_INTEGRATIONS.json", "public/integration.json"],
      ["../../docs/integrations/llms.txt", "public/llms.txt"],
      ["../../docs/integrations/PROJECT_RENDEZVOUS.schema.json", "public/schemas/project-rendezvous.v1.schema.json"],
    ] as const;
    for (const [source, output] of copies) {
      expect(await readFile(resolve(siteRoot, source), "utf8")).toBe(
        await readFile(resolve(siteRoot, output), "utf8"),
      );
    }
    const schema = JSON.parse(await readFile(
      resolve(siteRoot, "public/schemas/project-rendezvous.v1.schema.json"),
      "utf8",
    ));
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties.activation.const).toBe(
      "explicit-user-or-trusted-project-instruction-required",
    );
    expect(schema.properties).not.toHaveProperty("token");
    expect(schema.properties).not.toHaveProperty("credentials");
    expect(schema.properties).not.toHaveProperty("authority");
    expect(schema.properties).not.toHaveProperty("effects");
  });

  test("uses the public domain as canonical metadata", async () => {
    const layout = await readFile(resolve(siteRoot, "src/app/layout.tsx"), "utf8");
    expect(layout).toContain("metadataBase: new URL(productTruth.release.website)");
    expect(layout).toContain('alternates: { canonical: "/" }');
  });

  test("publishes a fail-closed pre-executable adoption contract", async () => {
    const [internalRaw, publicRaw] = await Promise.all([
      readFile(resolve(siteRoot, "src/generated/adopt.json"), "utf8"),
      readFile(resolve(siteRoot, "public/adopt.json"), "utf8"),
    ]);
    expect(publicRaw).toBe(internalRaw);
    const adoption = JSON.parse(publicRaw);
    expect(adoption.contractVersion).toBe("tasq.public-adoption.v1");
    if (adoption.distribution.published) {
      expect(adoption).toMatchObject({
        support: "implemented_certified",
        distribution: {
          mode: "npm_and_github_release",
          version: expect.stringMatching(/^\d+\.\d+\.\d+$/),
          packages: expect.arrayContaining([expect.objectContaining({ name: "@tasq-run/cli" })]),
          integrity: { kind: "npm-provenance-and-github-attestation" },
        },
        requirements: expect.arrayContaining([{ runtime: "npm", version: ">=10" }]),
        human: { path: "/docs/getting-started/", primaryAction: "install_release" },
        agent: { executablePathTemplate: "{installPrefix}/node_modules/.bin/tasq" },
      });
    } else {
      expect(adoption).toMatchObject({
        support: "implemented_candidate_not_published",
        distribution: {
          mode: "source_build",
          repositoryAccess: "public",
          preconditions: [],
          sourceRefMutable: true,
        },
        human: { path: "/docs/getting-started/", primaryAction: "build_from_source" },
        agent: { executableRelativePath: "dist/cli/index.js" },
      });
      expect(adoption.invariants).not.toContain("private_prelaunch_repository_requires_authorized_access");
    }
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

  test("generates a complete install contract from immutable published coordinates", async () => {
    const scratch = await mkdtemp(resolve(tmpdir(), "tasq-published-adoption-"));
    try {
      const [policy, matrix] = await Promise.all([
        Bun.file(resolve(siteRoot, "../../docs/releases/PUBLIC_RELEASE_POLICY.json")).json(),
        Bun.file(resolve(siteRoot, "../../docs/concepts/PRODUCT_SURFACE_MATRIX.json")).json(),
      ]);
      policy.status = "published-alpha";
      policy.publishedRelease = {
        version: "0.1.0",
        tag: "v0.1.0",
        sourceCommit: "a".repeat(40),
        githubRelease: "https://github.com/gwendall/tasq/releases/tag/v0.1.0",
        publishedPackages: policy.packages
          .flatMap((entry: { firstRelease: boolean; publicName: string | null }) => (
            entry.firstRelease && entry.publicName
              ? [{ name: entry.publicName, version: "0.1.0" }]
              : []
          )),
      };
      matrix.productShapes = matrix.productShapes.map((shape: { id: string; publiclyDistributed: boolean }) => ({
        ...shape,
        publiclyDistributed: shape.id === "core" || shape.id === "local"
          ? true
          : shape.publiclyDistributed,
      }));
      const policyPath = resolve(scratch, "policy.json");
      const matrixPath = resolve(scratch, "matrix.json");
      await Promise.all([
        writeFile(policyPath, `${JSON.stringify(policy)}\n`, "utf8"),
        writeFile(matrixPath, `${JSON.stringify(matrix)}\n`, "utf8"),
      ]);
      const child = Bun.spawn([
        process.execPath,
        resolve(siteRoot, "scripts/generate-truth.ts"),
        "--policy", policyPath,
        "--matrix", matrixPath,
        "--stdout",
      ], { stdout: "pipe", stderr: "pipe" });
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(exitCode, stderr).toBe(0);
      const generated = JSON.parse(stdout);
      expect(generated.truth.release).toMatchObject({
        published: true,
        installAction: "install_release",
        version: "0.1.0",
        tag: "v0.1.0",
      });
      expect(generated.adoption).toMatchObject({
        support: "implemented_certified",
        distribution: {
          mode: "npm_and_github_release",
          published: true,
          version: "0.1.0",
          packages: expect.arrayContaining([expect.objectContaining({ name: "@tasq-run/cli" })]),
          integrity: {
            kind: "npm-provenance-and-github-attestation",
            sourceCommit: "a".repeat(40),
          },
        },
        requirements: expect.arrayContaining([{ runtime: "npm", version: ">=10" }]),
        human: { primaryAction: "install_release" },
        agent: { executablePathTemplate: "{installPrefix}/node_modules/.bin/tasq" },
      });
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });
});

import { describe, expect, test } from "bun:test";

import { docPages } from "../src/lib/docs";
import { productTruth, supportPresentation } from "../src/lib/product-truth";

describe("public site truth", () => {
  test("renders every machine support level with an honest presentation", () => {
    const levels = new Set([
      ...productTruth.productShapes.map((entry) => entry.support),
      ...productTruth.surfaces.map((entry) => entry.support),
      ...productTruth.journeys.map((entry) => entry.support),
    ]);
    for (const level of levels) expect(supportPresentation[level]).toBeDefined();
  });

  test("never gives an entrypoint to an unimplemented surface", () => {
    const unimplemented = productTruth.surfaces.filter((entry) => entry.support === "not_implemented");
    expect(unimplemented.every((entry) => entry.entrypoint === null)).toBe(true);
  });

  test("keeps source and published alpha states internally coherent", () => {
    expect(productTruth.release.website).toBe("https://tasq.run");
    expect(productTruth.release.repositoryState).toBe("public-alpha-source");
    expect(productTruth.release.publicPackages).toHaveLength(7);
    if (productTruth.release.published) {
      expect(productTruth.release.status).toBe("published-alpha");
      expect(productTruth.release.installAction).toBe("install_release");
      expect(productTruth.release.version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(productTruth.release.githubRelease).toMatch(/^https:\/\/github\.com\/gwendall\/tasq\/releases\/tag\/v/);
      expect(productTruth.productShapes.find((entry) => entry.id === "local")?.publiclyDistributed).toBe(true);
    } else {
      expect(productTruth.release.installAction).toBe("build_from_source");
      expect(productTruth.release.version).toBeNull();
      expect(productTruth.productShapes.every((entry) => !entry.publiclyDistributed)).toBe(true);
    }
  });

  test("publishes the deployed site as a certified ledger-free surface", () => {
    const surface = productTruth.surfaces.find((entry) => entry.id === "public_site");
    expect(surface).toMatchObject({
      support: "implemented_certified",
      transport: "public_https_static_files",
      mutations: false,
      authorityBoundary: "versioned_repository_truth_no_ledger_access",
    });
    expect(surface?.entrypoint).toContain("https://tasq.run");
    expect(productTruth.criticalTruths).toContain("public_site_is_deployed_at_tasq_run");
  });

  test("covers the current consumer journeys in public learning paths", () => {
    const slugs = new Set(docPages.map((page) => page.slug));
    expect(slugs).toEqual(
      new Set([
        "getting-started",
        "agents",
        "mcp",
        "humans",
        "sdk",
        "operators",
        "architecture",
        "support",
        "concepts",
      ]),
    );
    expect(productTruth.consumers.map((entry) => entry.id)).toContain("local_shell_agent");
    expect(productTruth.consumers.map((entry) => entry.id)).toContain("human_operator");
    expect(productTruth.consumers.map((entry) => entry.id)).toContain("remote_agent");
  });

  test("binds visible truth to the three canonical repository contracts", () => {
    expect(productTruth.sourceContracts.map((entry) => entry.path)).toEqual([
      "docs/concepts/PRODUCT_SURFACE_MATRIX.json",
      "docs/roadmap/BACKLOG.json",
      "docs/releases/PUBLIC_RELEASE_POLICY.json",
    ]);
    for (const source of productTruth.sourceContracts) expect(source.sha256).toMatch(/^[a-f0-9]{64}$/);
  });
  test("every command shown in the docs exists in the CLI", async () => {
    // Seven of the nine doc code blocks come from publicCodeExamples, which
    // public-commands.test.ts actually executes. Literal blocks are not run by
    // anything, so a command invented while writing prose reaches a reader
    // untouched. Check the verb of every literal line against the CLI.
    const docsSource = await Bun.file(new URL("../src/lib/docs.ts", import.meta.url)).text();
    const cliSource = await Bun.file(
      new URL("../../../packages/tasq-cli/src/index.ts", import.meta.url),
    ).text();
    const usageSource = await Bun.file(
      new URL("../../../packages/tasq-cli/src/commands/usage.ts", import.meta.url),
    ).text();
    const cli = cliSource + usageSource;

    const literals = [...docsSource.matchAll(/code:\s*`([^`]+)`/g)].map((match) => match[1]!);
    const verbs = new Set<string>();
    for (const block of literals) {
      for (const line of block.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("tasq ")) continue;
        const parts = trimmed.slice(5).split(/\s+/).filter((part) => !part.startsWith("-"));
        if (parts[0]) verbs.add(parts[0]);
        // Sub-verbs such as `evidence add` must exist too.
        if (parts[1] && /^[a-z-]+$/.test(parts[1])) verbs.add(`${parts[0]} ${parts[1]}`);
      }
    }

    expect(verbs.size).toBeGreaterThan(0);
    for (const verb of verbs) {
      expect(cli, `the docs show "tasq ${verb}", which the CLI must accept`).toContain(verb);
    }
  });
});

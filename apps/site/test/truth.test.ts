import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

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
    if (productTruth.release.published) {
      expect(productTruth.release.status).toBe("published-alpha");
      expect(productTruth.release.installAction).toBe("install_release");
      expect(productTruth.release.version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(productTruth.release.githubRelease).toMatch(/^https:\/\/github\.com\/gwendall\/tasq\/releases\/tag\/v/);
      expect(productTruth.release.publicPackages).toHaveLength(8);
      expect(productTruth.release.publicPackages).toContain("@tasq-run/client");
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
    const cliSource = await Bun.file(
      new URL("../../../packages/tasq-cli/src/index.ts", import.meta.url),
    ).text();
    const usageSource = await Bun.file(
      new URL("../../../packages/tasq-cli/src/commands/usage.ts", import.meta.url),
    ).text();
    const cli = cliSource + usageSource;

    const literals = docPages.flatMap((page) => page.sections.flatMap((section) => section.code ?? []));
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

  test("generates all documentation prose from the canonical docs source", async () => {
    const generated = (await import("../src/generated/docs.json")).default;
    const source = await Bun.file(
      new URL("../../../docs/site/PUBLIC_SITE_DOCS.json", import.meta.url),
    ).text();
    const adapter = await Bun.file(new URL("../src/lib/docs.ts", import.meta.url)).text();

    expect(generated.contractVersion).toBe("tasq.public-site-docs.v1");
    expect(generated.source).toEqual({
      path: "docs/site/PUBLIC_SITE_DOCS.json",
      contractVersion: "tasq.public-site-docs-source.v1",
      sha256: createHash("sha256").update(source).digest("hex"),
    });
    expect(generated.pages).toHaveLength(docPages.length);
    expect(adapter).not.toContain("One ledger. Two actors. Five minutes.");
    expect(adapter).not.toContain('slug: "getting-started"');
  });

  test("describes published self-hosting without implying managed Cloud availability", () => {
    const server = productTruth.productShapes.find((entry) => entry.id === "server");
    const cloud = productTruth.productShapes.find((entry) => entry.id === "cloud");
    const docs = JSON.stringify(docPages);

    expect(server).toMatchObject({ support: "implemented_certified", publiclyDistributed: true });
    expect(cloud).toMatchObject({ publiclyDistributed: false });
    expect(docs).toContain("ghcr.io/gwendall/tasq-server:0.4.0");
    expect(docs).toContain("authenticated Streamable HTTP remote MCP");
    expect(docs).toContain("Managed Cloud remains unavailable");
    expect(docs).not.toContain("there is no remote MCP endpoint today");
    expect(docs).not.toContain("no protected Server image");
  });

  test("the generated CLI reference matches the shipped help", async () => {
    const reference = (await import("../src/generated/cli-reference.json")).default as Array<{
      heading: string;
      entries: Array<{ usage: string; description: string }>;
    }>;
    const cliSource = await Bun.file(
      new URL("../../../packages/tasq-cli/src/index.ts", import.meta.url),
    ).text();

    expect(reference.length).toBeGreaterThan(10);
    for (const section of reference) {
      expect(section.entries.length, `${section.heading} must list commands`).toBeGreaterThan(0);
      for (const entry of section.entries) {
        // The first token is the verb; it has to exist in the binary's own help.
        const verb = entry.usage.split(/\s+/)[0]!;
        expect(cliSource, `"${verb}" is documented but absent from the CLI`).toContain(verb);
      }
    }

    // Commands whose product is not published must stay visibly marked, while
    // the current published Server must not inherit its historical marker.
    const page = await Bun.file(new URL("../src/app/docs/cli/page.tsx", import.meta.url)).text();
    if (reference.some((section) => section.heading === "REMOTE SERVER")) {
      expect(page).toContain("serverPublished ? new Set<string>()");
      expect(productTruth.productShapes.find(({ id }) => id === "server")?.publiclyDistributed).toBe(true);
    }
  });
});

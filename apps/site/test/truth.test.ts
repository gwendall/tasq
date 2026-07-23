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
    expect(unimplemented.length).toBeGreaterThan(0);
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
      new Set(["getting-started", "agents", "mcp", "humans", "sdk", "operators", "architecture", "support"]),
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
});

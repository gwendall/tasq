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

  test("keeps the private unpublished release behind explicit repository access", () => {
    expect(productTruth.release.published).toBe(false);
    expect(productTruth.release.installAction).toBe("request_access_then_build");
    expect(productTruth.release.repositoryState).toBe("private-canonical-unprotected-prelaunch");
    expect(productTruth.release.publicPackages).toHaveLength(7);
    expect(productTruth.productShapes.every((entry) => !entry.publiclyDistributed)).toBe(true);
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
      "PRODUCT_SURFACE_MATRIX.json",
      "BACKLOG.json",
      "PUBLIC_RELEASE_POLICY.json",
    ]);
    for (const source of productTruth.sourceContracts) expect(source.sha256).toMatch(/^[a-f0-9]{64}$/);
  });
});

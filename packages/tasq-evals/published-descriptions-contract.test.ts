/**
 * Guards what npm receives as each package's description.
 *
 * npm descriptions are immutable per version. The release builder used to carry
 * its own copy of all eight, so editing a package manifest changed the
 * repository and nothing else: a bootstrap publish shipped the stale text while
 * the repo showed the corrected one, and only inspecting the published tarball
 * revealed it. Anything duplicated here is published wrong forever.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dir, "../..");
const builder = readFileSync(
  resolve(repositoryRoot, "scripts/release/build-public-packages.ts"),
  "utf8",
);

const PUBLIC_PACKAGES = [
  ["tasq-schema", "@tasq-run/schema"],
  ["tasq-core", "@tasq-run/core"],
  ["tasq-cli", "@tasq-run/cli"],
  ["tasq-mcp", "@tasq-run/mcp"],
  ["tasq-extension-sdk", "@tasq-run/extension-sdk"],
  ["tasq-protocol-adapters", "@tasq-run/protocol-adapters"],
  ["tasq-inspector", "@tasq-run/console"],
  ["tasq-client", "@tasq-run/client"],
] as const;

function manifestDescription(directory: string): string {
  const manifest = JSON.parse(
    readFileSync(resolve(repositoryRoot, "packages", directory, "package.json"), "utf8"),
  ) as { description?: string };
  return (manifest.description ?? "").trim();
}

describe("published package descriptions", () => {
  test("the release builder holds no hardcoded description", () => {
    // One literal is enough to desynchronise a published package from its
    // manifest, and the mistake only surfaces after an immutable publish.
    expect(builder).not.toMatch(/^\s*description: "/m);
    expect(builder).toContain("sourceDescription");
  });

  test("the builder refuses a manifest with no usable description", () => {
    expect(builder).toContain("npm would publish it immutably");
  });

  test("every public package has a description worth publishing", () => {
    for (const [directory, name] of PUBLIC_PACKAGES) {
      const description = manifestDescription(directory);
      expect(description.length, `${name}: description too short to publish`).toBeGreaterThan(20);
      expect(description.length, `${name}: npm truncates long descriptions`).toBeLessThan(220);
    }
  });

  test("descriptions state what the package does, not how it is built", () => {
    // The repositioning removed this vocabulary from every public surface.
    // These words are what made a study of the field fail to recognise what
    // this project is.
    const jargon = /\b(runtime-neutral|substrate|kernel|profile-neutral|commitment coordination)\b/i;
    for (const [directory, name] of PUBLIC_PACKAGES) {
      const description = manifestDescription(directory);
      expect(jargon.test(description), `${name}: "${description}" reads as internal architecture`)
        .toBe(false);
    }
  });
});

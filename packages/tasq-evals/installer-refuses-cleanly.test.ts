/**
 * The first sixty seconds, when they go wrong.
 *
 * Installing over a pre-existing unmanaged `bin/tasq` used to refuse at the
 * very END - after the archive was extracted and the install record written -
 * so a refused install left `lib/tasq/<version>` and
 * `share/tasq/installations` behind. The next run then failed with a raw
 * EEXIST from a deliberately non-recursive mkdir, leaving an operator between
 * two errors with nothing documenting a way out. And `--dry-run` had already
 * printed a successful plan for the same command, so the plan did not predict
 * the refusal it exists to prevent.
 *
 * These read the shipped installer rather than reasoning about it, because the
 * shell script is what an operator actually runs.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const productRoot = resolve(import.meta.dir, "../..");
const policy = JSON.parse(readFileSync(
  join(productRoot, "docs/releases/PUBLIC_RELEASE_POLICY.json"), "utf8",
)) as { publishedRelease?: { version?: string } };
const published = policy.publishedRelease?.version;

describe("the installer refuses before it creates anything", () => {
  test("the shipped shell installer checks the blocker before the network", () => {
    expect(published).toBeTruthy();
    const shell = readFileSync(
      join(productRoot, `scripts/release/install-v${published}.sh`), "utf8",
    );
    // Knowable without touching the network, so it is decided before it.
    const blockerAt = shell.indexOf("BLOCKER=");
    const downloadAt = shell.indexOf("download \"$CHECKSUMS\"");
    expect(blockerAt).toBeGreaterThan(0);
    expect(downloadAt).toBeGreaterThan(blockerAt);

    // The plan must say it, and must not exit 0 while saying it.
    expect(shell).toContain("BLOCKED:");
    expect(shell).toContain("--prefix <path>");
  });

  test("the payload installer refuses activation before it stages anything", () => {
    const installer = readFileSync(
      join(productRoot, "scripts/release/install-public-release.ts"), "utf8",
    );
    const guardAt = installer.indexOf("await assertActivationPossible(prefix)");
    const stagingAt = installer.indexOf("await mkdtemp(join(layout.prefix");
    expect(guardAt).toBeGreaterThan(0);
    expect(stagingAt).toBeGreaterThan(guardAt);
    // The refusal has to name a way out, or it is a dead end.
    expect(installer).toContain("Nothing has been created");
    expect(installer).toContain("--prefix <path>");
  });

  test("a failed install removes the version directory it created", () => {
    // Removing only the target left the version directory behind, and the
    // next run's non-recursive mkdir turned that into a raw EEXIST.
    const installer = readFileSync(
      join(productRoot, "scripts/release/install-public-release.ts"), "utf8",
    );
    expect(installer).toContain("const versionDirectory = dirname(destination)");
    expect(installer).toContain("await rm(versionDirectory");
  });

  test("an error reaches a human as prose, and a machine as one contract", () => {
    const installer = readFileSync(
      join(productRoot, "scripts/release/install-public-release.ts"), "utf8",
    );
    // A raw contract document is not an error message for someone watching a
    // terminal, and prose alone is not parseable. Both, in that order.
    const proseAt = installer.indexOf('`tasq installer: ${message}');
    const contractAt = installer.indexOf('contractVersion: "tasq.lifecycle-error.v1"');
    expect(proseAt).toBeGreaterThan(0);
    expect(contractAt).toBeGreaterThan(proseAt);
  });
});

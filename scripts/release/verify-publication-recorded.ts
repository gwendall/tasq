#!/usr/bin/env bun
/**
 * Refuse a repository state where the published release is recorded but the
 * material describing it to the public still names an older version.
 *
 * This is the mirror of `verify-release-preflight.ts`. Version-pinned material
 * splits in two, and only one half had a gate:
 *
 *   - read from the immutable tagged commit, so it must be advanced BEFORE the
 *     tag and can never be fixed after: the preflight guards those;
 *   - describing what is already public, advanced AFTER publication because the
 *     site deploys continuously: nothing guarded those, which is how the
 *     comparison contract sat a full release behind twice in a row.
 *
 * Advancing this half early is also wrong - it makes the repository claim a
 * release that does not exist yet - so this runs against the recorded published
 * version rather than against a target.
 *
 * That left one hole, and v0.5.1 fell straight into it: every surface agreed
 * with `publishedRelease.version`, so the gate said ok, while the record itself
 * was a release behind reality and the documented installer for the new version
 * 404'd. A record that certifies itself against itself certifies nothing. So
 * the record is now checked against something OUTSIDE the file: the newest
 * release tag in the repository.
 *
 * A tag that published nothing - v0.5.0 failed at the identity job, and tag
 * protection refuses to delete an immutable tag - has to be RECORDED as
 * retired, in `policy.retiredReleases`. Writing it down is the point: a version
 * that silently does not count is how a burnt tag becomes folklore.
 */

import { execFileSync } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";

const productRoot = resolve(import.meta.dir, "../..");

function fail(message: string): never {
  throw new Error(`Publication record rejected: ${message}`);
}

const rootIndex = process.argv.indexOf("--policy-root");
const root = rootIndex === -1 ? productRoot : resolve(process.argv[rootIndex + 1] ?? productRoot);

async function exists(relative: string): Promise<boolean> {
  try {
    await stat(resolve(root, relative));
    return true;
  } catch {
    return false;
  }
}

const policy = JSON.parse(
  await readFile(resolve(root, "docs/releases/PUBLIC_RELEASE_POLICY.json"), "utf8"),
) as Record<string, any>;

const published: string | undefined = policy.publishedRelease?.version;
if (!published) fail("policy.publishedRelease.version is missing");

const stale: string[] = [];

const comparison = JSON.parse(
  await readFile(resolve(root, "docs/contracts/TQ-621_MULTI_AGENT_COMPARISON.json"), "utf8"),
) as Record<string, any>;
const boundary: string | undefined = comparison.tasqClaimBoundary?.version;
if (boundary !== published) {
  stale.push(
    `comparison.tasqClaimBoundary.version is ${boundary ?? "missing"}, not the published ${published} `
      + "(the /compare page and its browser test render this)",
  );
}

// The documented acquisition path is a versioned script. A published release
// whose installer does not exist leaves `curl .../install-vX.sh` returning 404,
// which is what the first attempt at v0.4.1 hit.
for (const relative of [
  `scripts/release/install-v${published}.sh`,
  `apps/site/public/install-v${published}.sh`,
]) {
  if (!(await exists(relative))) {
    stale.push(`${relative} does not exist (the documented install path for ${published})`);
  }
}

// The recording is captured from whatever npx resolves to, so a tape naming an
// older release records a demo that is no longer what users run.
const tape = await readFile(resolve(root, "apps/site/media/tasq-demo.tape"), "utf8");
if (!tape.includes(`@tasq-run/cli@${published} demo`)) {
  stale.push(
    `apps/site/media/tasq-demo.tape does not record @tasq-run/cli@${published} `
      + "(the homepage recording would show a different release)",
  );
}

/**
 * The reference point that is not the file being checked.
 *
 * Tags come from the release workflow, are immutable, and cannot be edited by
 * the commit that gets them wrong - which is exactly what makes them the right
 * thing to measure the record against.
 */
function releaseTags(gitRoot: string): string[] {
  try {
    return execFileSync("git", ["-C", gitRoot, "tag", "--list", "v*"], { encoding: "utf8" })
      .split("\n").map((line) => line.trim()).filter(Boolean);
  } catch (error) {
    fail(
      `cannot read release tags from ${gitRoot}: ${(error as Error).message}\n`
        + "This check compares the recorded release against the tags, so it cannot run without them. "
        + "In a shallow clone: `git fetch --tags`.",
    );
  }
}

function semverKey(version: string): number[] {
  return version.split(".").map((part) => Number(part));
}

function newer(a: string, b: string): boolean {
  const [x, y] = [semverKey(a), semverKey(b)];
  for (let index = 0; index < 3; index += 1) {
    if ((x[index] ?? 0) !== (y[index] ?? 0)) return (x[index] ?? 0) > (y[index] ?? 0);
  }
  return false;
}

const tags = releaseTags(root);
const retiredEntries: Array<Record<string, any>> = policy.retiredReleases ?? [];
for (const entry of retiredEntries) {
  // A retired entry naming a tag that does not exist is fiction, and fiction in
  // the one place that decides what counts as published is worse than nothing.
  if (!tags.includes(entry.tag)) {
    stale.push(`policy.retiredReleases names ${entry.tag}, which is not a tag in this repository`);
  }
  if (typeof entry.reason !== "string" || entry.reason.trim().length < 40) {
    stale.push(`policy.retiredReleases entry for ${entry.tag} must say why it published nothing`);
  }
}
const retired = new Set(retiredEntries.map((entry) => entry.tag));

const candidates = tags
  .filter((tag) => !retired.has(tag))
  .map((tag) => tag.slice(1))
  .filter((version) => /^\d+\.\d+\.\d+$/.test(version));

if (candidates.length === 0) {
  stale.push("this repository has no release tag, so nothing corroborates the recorded release");
} else {
  const newest = candidates.reduce((best, version) => (newer(version, best) ? version : best));
  if (newest !== published) {
    stale.push(
      `policy.publishedRelease.version is ${published}, but the newest release tag is v${newest}. `
        + (newer(newest, published)
          ? `Either this repository has not caught up with v${newest} - in which case every surface above `
            + `describes the wrong release and the documented installer for v${newest} does not exist - or `
            + `v${newest} published nothing and must be recorded in policy.retiredReleases with the reason.`
          : "The record claims a release with no tag behind it."),
    );
  }
}

if (stale.length > 0) {
  fail(
    `${stale.length} public surface(s) still describe an older release than the published ${published}:\n`
      + stale.map((entry) => `  - ${entry}`).join("\n"),
  );
}

process.stdout.write(`${JSON.stringify({
  contractVersion: "tasq.publication-record.v1",
  publishedVersion: published,
  corroboratedBy: `v${published}`,
  retiredReleases: retiredEntries.map((entry) => entry.tag),
  ok: true,
}, null, 2)}\n`);

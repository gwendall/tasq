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
 */

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

if (stale.length > 0) {
  fail(
    `${stale.length} public surface(s) still describe an older release than the published ${published}:\n`
      + stale.map((entry) => `  - ${entry}`).join("\n"),
  );
}

process.stdout.write(`${JSON.stringify({
  contractVersion: "tasq.publication-record.v1",
  publishedVersion: published,
  ok: true,
}, null, 2)}\n`);

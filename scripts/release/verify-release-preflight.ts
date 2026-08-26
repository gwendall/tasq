#!/usr/bin/env bun
/**
 * Refuse to tag a release while any version-pinned policy block still names an
 * older version than the one about to ship.
 *
 * Preparing v0.4.1 hit this seven times, and every occurrence was created by
 * the SUCCESS of the previous release: publishing v0.4.0 left blocks naming
 * v0.4.0, and each one only failed when the next release reached it. One of
 * them - the TQ-616 program block - was not caught before the tag, and because
 * the certification workflow reads the policy from the immutable tagged commit,
 * v0.4.1 could never be fully certified afterwards.
 *
 * This runs BEFORE the tag, where a stale block is still fixable.
 *
 * Two axes are guarded, and they fail differently:
 *
 *   - VERSION-pinned blocks, which go stale every time a release succeeds;
 *   - the FORMAT-pinned migration certification, which goes stale only when the
 *     store format moves - rarely, which is exactly why nobody remembers it.
 *     Nothing read that block at all until 2026-08-26, so a tag could have
 *     shipped store format 33 carrying a certification that says 32.
 *
 * Scope is deliberately narrow: only blocks a workflow reads from the tagged
 * commit. Anything that tracks the PUBLISHED version instead - the public
 * comparison contract, the site's generated truth - is corrected after
 * publication and would contradict this check if it were included here.
 */

import { readFile } from "node:fs/promises";
import { STORE_FORMAT_COMPATIBILITY } from "../../packages/tasq-core/src/migrations/index.js";
import { resolve } from "node:path";

const productRoot = resolve(import.meta.dir, "../..");

function fail(message: string): never {
  throw new Error(`Release preflight rejected: ${message}`);
}

function flag(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index === -1 ? undefined : process.argv[index + 1];
  if (!value || value.startsWith("--")) fail(`${name} is required`);
  return value;
}

function parseVersion(value: string, label: string): [number, number, number] {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value);
  if (!match) fail(`${label} is not a stable SemVer: ${value}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function isOlder(candidate: string, target: string): boolean {
  const [aMajor, aMinor, aPatch] = parseVersion(candidate, "version");
  const [bMajor, bMinor, bPatch] = parseVersion(target, "target");
  if (aMajor !== bMajor) return aMajor < bMajor;
  if (aMinor !== bMinor) return aMinor < bMinor;
  return aPatch < bPatch;
}

/**
 * Blocks whose version must equal the version being tagged, because a workflow
 * reads them from the tagged commit and cannot be corrected afterwards.
 */
interface PinnedBlock {
  readonly path: string;
  readonly version: string | undefined;
  readonly why: string;
}

function collect(policy: Record<string, any>): PinnedBlock[] {
  return [
    {
      path: "policy.releaseAuthorization.version",
      version: policy.releaseAuthorization?.version,
      why: "the release workflow refuses a tag whose authorized version differs",
    },
    {
      path: "policy.certificationPrograms.tq616SignedStatements.version",
      version: policy.certificationPrograms?.tq616SignedStatements?.version,
      why:
        "the published-release certification reads this from the immutable tag, "
        + "so a stale value cannot be fixed after tagging",
    },
  ];
}

/**
 * The protected migration certification proves that PUBLISHED binaries migrate
 * real stores forward to a specific target format. It is evidence about a
 * format, not about a version, so it survives release after release and then
 * silently stops describing what ships the one time the format moves.
 */
function certifiedMigrationFormat(policy: Record<string, any>): number | undefined {
  return policy.sourceCandidateCheckpoint?.protectedMigrationCandidate?.targetStoreFormat;
}

const targetVersion = flag("--version");
parseVersion(targetVersion, "--version");

// Tests point this at a copy of the policy shaped as it looks after a
// publication; the default is the repository this script ships in.
const rootIndex = process.argv.indexOf("--policy-root");
const policyRoot = rootIndex === -1 ? productRoot : resolve(process.argv[rootIndex + 1] ?? productRoot);

const policyRaw = await readFile(
  resolve(policyRoot, "docs/releases/PUBLIC_RELEASE_POLICY.json"),
  "utf8",
);
const policy = JSON.parse(policyRaw) as Record<string, any>;

const stale: string[] = [];
for (const block of collect(policy)) {
  if (block.version === undefined) {
    stale.push(`${block.path} is missing (${block.why})`);
    continue;
  }
  if (block.version !== targetVersion) {
    const relation = isOlder(block.version, targetVersion) ? "still names the older" : "names a different";
    stale.push(`${block.path} ${relation} version ${block.version} (${block.why})`);
  }
}

// The release being prepared must be newer than the one already out, otherwise
// the tag either repeats a published version or moves backwards.
const published = policy.publishedRelease?.version;
if (typeof published === "string" && !isOlder(published, targetVersion)) {
  stale.push(
    `policy.publishedRelease.version is ${published}, which is not older than ${targetVersion}`,
  );
}

// A release that moves the store format needs a certification describing THAT
// format. The candidate block records a passed run and no gate read it, which is
// the same shape that cost v0.4.1 its full certification, one axis over.
const certifiedFormat = certifiedMigrationFormat(policy);
const candidate = policy.sourceCandidateCheckpoint?.protectedMigrationCandidate;
if (candidate === undefined) {
  stale.push(
    "policy.sourceCandidateCheckpoint.protectedMigrationCandidate is missing "
      + "(no evidence that published binaries can migrate a real store to this release)",
  );
} else if (candidate.status !== "passed") {
  stale.push(
    `policy.sourceCandidateCheckpoint.protectedMigrationCandidate.status is ${candidate.status}, not passed`,
  );
} else if (certifiedFormat !== STORE_FORMAT_COMPATIBILITY.current) {
  stale.push(
    `policy.sourceCandidateCheckpoint.protectedMigrationCandidate.targetStoreFormat is `
      + `${certifiedFormat ?? "missing"}, but this source writes store format `
      + `${STORE_FORMAT_COMPATIBILITY.current}. Re-run the protected migration certification against `
      + "the new format: published binaries have never been proven to migrate a real store to it.",
  );
}

if (stale.length > 0) {
  fail(
    `${stale.length} release-pinned block(s) must be corrected before tagging ${targetVersion}:\n`
      + stale.map((entry) => `  - ${entry}`).join("\n"),
  );
}

process.stdout.write(`${JSON.stringify({
  contractVersion: "tasq.release-preflight.v1",
  version: targetVersion,
  checkedBlocks: [
    ...collect(policy).map((block) => block.path),
    "policy.sourceCandidateCheckpoint.protectedMigrationCandidate.targetStoreFormat",
  ],
  storeFormat: STORE_FORMAT_COMPATIBILITY.current,
  ok: true,
}, null, 2)}\n`);

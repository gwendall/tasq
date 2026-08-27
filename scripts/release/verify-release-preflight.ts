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

import { readFile, readdir } from "node:fs/promises";
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

/**
 * The store format this source writes, read from the migration files themselves.
 *
 * Deliberately NOT imported from @tasq-run/core: this script runs in the release
 * workflow's identity job, which has no `pnpm install` before it, because a gate
 * that needs dependencies installed is a gate that can be skipped by an install
 * failure. Importing core here made the whole v0.5.0 tag fail with
 * "Cannot find module '@tasq-run/schema'".
 *
 * Counting is exact rather than approximate: migrations are named `NNNN_*.sql`
 * from 0000, and `assertDefinitionEnvelope` in the migration runner refuses to
 * run at all unless the bundled count equals the declared format plus one. So
 * the highest migration number IS the current format, enforced everywhere else.
 */
async function currentStoreFormat(): Promise<number> {
  const entries = await readdir(resolve(productRoot, "packages/tasq-core/src/migrations"));
  const formats = entries
    .filter((name) => /^\d{4}_.+\.sql$/.test(name))
    .map((name) => Number.parseInt(name.slice(0, 4), 10));
  if (formats.length === 0) fail("no bundled migrations found; refusing to guess the store format");
  const highest = Math.max(...formats);
  if (formats.length !== highest + 1) {
    fail(`bundled migrations are non-contiguous: ${formats.length} files but the highest is ${highest}`);
  }
  return highest;
}

/**
 * A waiver for a format nothing has yet written.
 *
 * The certification proves that PUBLISHED binaries migrate real user stores.
 * Before a release has adopters there are no such stores, so re-running a
 * two-target workflow would prove a property nothing depends on. Record the
 * decision rather than faking the evidence: the certification block keeps
 * saying exactly what it proved, and the waiver says why this release ships
 * without a fresh one - and when it must stop being acceptable.
 */
function migrationWaiverCovers(policy: Record<string, any>, format: number): boolean {
  const waiver = policy.sourceCandidateCheckpoint?.migrationCertificationWaiver;
  if (!waiver) return false;
  if (waiver.storeFormat !== format) return false;
  if (typeof waiver.reason !== "string" || waiver.reason.trim().length < 40) {
    fail("policy.sourceCandidateCheckpoint.migrationCertificationWaiver.reason must state why, in one sentence");
  }
  if (typeof waiver.withdrawWhen !== "string" || waiver.withdrawWhen.trim().length < 20) {
    fail("policy.sourceCandidateCheckpoint.migrationCertificationWaiver.withdrawWhen must name what ends it");
  }
  return true;
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

// The TQ-616 program must be AUTHORIZED at the tag, not still carrying the
// previous release's post-certification state. verify-tq616-release-eligibility
// refuses anything but `authorized`, and it reads the policy from the immutable
// tagged commit - so `published_certified` left over from the last release makes
// the new one permanently uncertifiable. That is what happened to v0.4.1 on the
// `version` field and to v0.5.1 on this one, which is the same trap one field
// over.
const tq616State = policy.certificationPrograms?.tq616SignedStatements?.state;
if (tq616State !== "authorized") {
  stale.push(
    `policy.certificationPrograms.tq616SignedStatements.state is ${tq616State ?? "missing"}, not "authorized" `
      + "(the certification reads this from the immutable tag and refuses anything else, so it cannot be "
      + "corrected after tagging)",
  );
}

// A release that moves the store format needs a certification describing THAT
// format. The candidate block records a passed run and no gate read it, which is
// the same shape that cost v0.4.1 its full certification, one axis over.
const storeFormat = await currentStoreFormat();
const certifiedFormat = certifiedMigrationFormat(policy);
const waived = migrationWaiverCovers(policy, storeFormat);
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
} else if (certifiedFormat !== storeFormat && !waived) {
  stale.push(
    `policy.sourceCandidateCheckpoint.protectedMigrationCandidate.targetStoreFormat is `
      + `${certifiedFormat ?? "missing"}, but this source writes store format `
      + `${storeFormat}. Re-run the protected migration certification against `
      + "the new format, or record a waiver naming this format if no published store is at risk.",
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
  storeFormat,
  migrationCertificationWaived: waived,
  ok: true,
}, null, 2)}\n`);

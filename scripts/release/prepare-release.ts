#!/usr/bin/env bun
/**
 * `release:prepare --version <x.y.z> --rationale "<why>" [--surfaces all|none|server,python,client] [--date YYYY-MM-DD] [--root <dir>] [--no-verify]`
 *
 * The phase before the tag, per docs/releases/RELEASES.md: advance every
 * version-pinned block the protected workflows read from the immutable tagged
 * commit, open the changelog entry, regenerate the public-site truth, and run
 * the release preflight. Every candidate surface is authorized by default:
 * the v0.6.2 release shipped without the server image and the Python wheel
 * because nobody had authorized them before the tag.
 */
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  ALL_SURFACES, STABLE_VERSION, SURFACES, fail, parseFlags, parseSurfaces, policyPath, productRoot, readJson, sh, today, writeJson,
} from "./release-pipeline";

const flags = parseFlags(process.argv.slice(2), ["--version", "--rationale", "--surfaces", "--date", "--root"], ["--no-verify", "--dry-run"]);
const version = flags.require("--version");
if (!STABLE_VERSION.test(version)) fail(`--version must be a stable SemVer, got ${version}`);
const rationale = flags.require("--rationale").trim();
if (rationale.length < 20) fail("--rationale must say why, in at least twenty characters");
const surfaces = parseSurfaces(flags.get("--surfaces"));
const date = flags.get("--date") ?? today();
if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) fail(`--date must be YYYY-MM-DD, got ${date}`);
const root = flags.get("--root") ? resolve(flags.get("--root")!) : productRoot;
const dryRun = flags.has("--dry-run");

const policy = await readJson(policyPath(root));
const published: string = policy.publishedRelease?.version ?? fail("policy has no publishedRelease.version");

const authorization = policy.releaseAuthorization ?? fail("policy has no releaseAuthorization block");
Object.assign(authorization, {
  state: "authorized",
  version,
  decision: "go",
  authorizedBy: "@gwendall",
  authorizedAt: date,
  rationale: `Authorized for v${version}, not yet published. ${rationale}`,
});
const program = policy.certificationPrograms?.tq616SignedStatements ?? fail("policy has no TQ-616 program block");
Object.assign(program, { state: "authorized", version, decision: "go", authorizedBy: "@gwendall", authorizedAt: date });

const candidates = policy.candidatePublications ?? fail("policy has no candidatePublications");
const authorized: string[] = [];
for (const surface of ALL_SURFACES) {
  const key = SURFACES[surface].candidate;
  const block = candidates[key] ?? fail(`policy has no candidate ${key}`);
  if (!surfaces.includes(surface)) continue;
  // The shape a candidate has at authorization: the four identity fields it
  // already carries, and the decision. Publication facts (digest, wheel
  // digest, workflow runs) belong to the record, after the surface is public.
  candidates[key] = {
    state: "authorized",
    coordinate: block.coordinate,
    workflow: block.workflow,
    environment: block.environment,
    version,
    sourceBinding: block.sourceBinding,
    decision: "go",
    authorizedBy: "@gwendall",
    authorizedAt: date,
  };
  authorized.push(key);
}

// The changelog: what sits under "## Unreleased" becomes the entry for this
// version; the heading stays empty above it, ready for the next change.
const changelogPath = resolve(root, "CHANGELOG.md");
let changelog = await readFile(changelogPath, "utf8");
const unreleased = changelog.indexOf("## Unreleased\n");
if (unreleased === -1) fail("CHANGELOG.md has no '## Unreleased' heading");
const bodyStart = unreleased + "## Unreleased\n".length;
const nextHeading = changelog.indexOf("\n## ", bodyStart);
const body = changelog.slice(bodyStart, nextHeading === -1 ? undefined : nextHeading + 1);
if (body.trim().length === 0) fail("CHANGELOG.md has nothing under '## Unreleased'; a release with no entry is not a release");
if (changelog.includes(`## v${version} `)) fail(`CHANGELOG.md already has an entry for v${version}`);
const entry = `## Unreleased\n\n## v${version} - ${date}\n\n${rationale}\n${body.startsWith("\n") ? body : `\n${body}`}`;
changelog = changelog.slice(0, unreleased) + entry + changelog.slice(nextHeading === -1 ? changelog.length : nextHeading + 1);

const summary = {
  contractVersion: "tasq.release-prepare.v1",
  version,
  previous: published,
  date,
  authorizedSurfaces: authorized,
  changelogEntryOpened: true,
  dryRun,
};
if (dryRun) {
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  process.exit(0);
}
await writeJson(policyPath(root), policy);
await writeFile(changelogPath, changelog, "utf8");
if (!flags.has("--no-verify")) {
  sh(["pnpm", "--filter", "@tasq-internal/site", "generate"], { cwd: root });
  sh(["bun", "scripts/release/verify-release-preflight.ts", "--version", version], { cwd: root });
}
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);

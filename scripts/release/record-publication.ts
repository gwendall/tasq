#!/usr/bin/env bun
/**
 * `release:record --version <x.y.z> [--certification-run <url>] [--surfaces-json <file>] [--root <dir>] [--no-verify] [...explicit facts]`
 *
 * The phase after publication, per docs/releases/RELEASES.md: every surface
 * that describes what is public is advanced from what is actually public.
 * Facts are read from GitHub, npm, GHCR and PyPI; each can be given
 * explicitly, which is how the tests drive this against a fabricated tree.
 *
 * Explicit facts: --tag-commit, --release-url, --run-url, --run-id,
 * --published-at, --packages "@tasq-run/cli=0.6.3,...", --installer-from <file>.
 */
import { copyFile, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  STABLE_VERSION, SURFACES, fail, findRun, ghJson, npmVersionExists, parseFlags, policyPath, productRoot, readJson, sh, tagCommit, writeJson,
} from "./release-pipeline";

const flags = parseFlags(process.argv.slice(2), [
  "--version", "--certification-run", "--surfaces-json", "--root",
  "--tag-commit", "--release-url", "--run-url", "--run-id", "--published-at", "--packages", "--installer-from",
], ["--no-verify"]);
const version = flags.require("--version");
if (!STABLE_VERSION.test(version)) fail(`--version must be a stable SemVer, got ${version}`);
const tag = `v${version}`;
const root = flags.get("--root") ? resolve(flags.get("--root")!) : productRoot;
const verify = !flags.has("--no-verify");

const policy = await readJson(policyPath(root));
const previous = policy.publishedRelease ?? fail("policy has no publishedRelease");
const previousVersion: string = previous.version;
if (previousVersion === version) fail(`policy already records v${version} as published`);

// 1. What is public.
const commit = flags.get("--tag-commit") ?? tagCommit(tag);
const release = flags.get("--release-url")
  ? { url: flags.get("--release-url")!, publishedAt: flags.require("--published-at") }
  : (() => {
    const view = ghJson<{ url: string; publishedAt: string }>(["release", "view", tag, "--json", "url,publishedAt"]);
    return { url: view.url, publishedAt: view.publishedAt };
  })();
const run = flags.get("--run-url")
  ? { url: flags.get("--run-url")!, databaseId: Number(flags.require("--run-id")) }
  : (() => {
    const found = findRun("release.yml", commit);
    if (!found || found.conclusion !== "success") fail(`no successful release.yml run for ${tag}`);
    return { url: found.url, databaseId: found.databaseId };
  })();
const packages: Array<{ name: string; version: string }> = flags.get("--packages")
  ? flags.get("--packages")!.split(",").map((pair) => { const [name, v] = pair.split("="); return { name: name!.trim(), version: v!.trim() }; })
  : previous.publishedPackages.map((pkg: { name: string; version: string }) => ({
    name: pkg.name,
    version: npmVersionExists(pkg.name, version) ? version : pkg.version,
  }));
const surfacesJson = flags.get("--surfaces-json") ? await readJson(resolve(flags.get("--surfaces-json")!)) : null;
const certificationRun = flags.get("--certification-run") ?? null;

// 2. The versioned installer, generated from the published SHA256SUMS and mirrored to the site.
const installer = resolve(root, `scripts/release/install-v${version}.sh`);
if (flags.get("--installer-from")) {
  await copyFile(resolve(flags.get("--installer-from")!), installer);
} else {
  sh(["bun", "scripts/release/generate-versioned-installer.ts", "--version", version, "--from", previousVersion], { cwd: root });
}
await copyFile(installer, resolve(root, `apps/site/public/install-v${version}.sh`));
await copyFile(installer, resolve(root, "apps/site/public/install.sh"));

// 3. The policy: published release, states, candidate surfaces.
policy.publishedRelease = { ...previous, version, tag, sourceCommit: commit, githubRelease: release.url, workflowRun: run.url, publishedAt: release.publishedAt, publishedPackages: packages };
const authorization = policy.releaseAuthorization;
authorization.state = certificationRun ? "published_certified" : "published";
authorization.rationale = String(authorization.rationale).replace(`Authorized for v${version}, not yet published.`, `Consumed by v${version}, published ${release.publishedAt}.`);
const program = policy.certificationPrograms.tq616SignedStatements;
program.state = certificationRun ? "published_certified" : "published";
if (certificationRun) program.certificationWorkflowRun = certificationRun;
const candidates = policy.candidatePublications;
const recorded: string[] = [];
// A surface published without its certification is recorded as published,
// never as certified: the record says what happened, not what was meant.
function recordSurface(key: string, facts: Record<string, unknown> | undefined, identity: Record<string, unknown>) {
  if (!facts || candidates[key]?.version !== version) return;
  const certified = typeof facts.certificationWorkflowRun === "string" && facts.certificationWorkflowRun.length > 0;
  Object.assign(candidates[key], {
    state: certified ? "published_certified" : "published",
    ...identity,
    publicationWorkflowRun: facts.publicationWorkflowRun,
    ...(certified ? { certificationWorkflowRun: facts.certificationWorkflowRun } : {}),
  });
  recorded.push(key);
}
recordSurface(SURFACES.server.candidate, surfacesJson?.server, { digest: surfacesJson?.server?.digest });
recordSurface(SURFACES.python.candidate, surfacesJson?.python, { wheelSha256: surfacesJson?.python?.wheelSha256 });
const client = candidates[SURFACES.client.candidate];
if (client?.version === version && client.state === "authorized" && packages.some((pkg) => pkg.name === "@tasq-run/client" && pkg.version === version)) {
  Object.assign(client, { state: "published_certified", publicationWorkflowRun: run.url, ...(certificationRun ? { certificationWorkflowRun: certificationRun } : {}) });
  recorded.push("remoteTypeScriptClient");
}
await writeJson(policyPath(root), policy);

// 4. Comparison contract, demo tape, release notes.
const comparisonPath = resolve(root, "docs/contracts/TQ-621_MULTI_AGENT_COMPARISON.json");
const comparison = await readJson(comparisonPath);
comparison.tasqClaimBoundary.version = version;
await writeJson(comparisonPath, comparison);
const tapePath = resolve(root, "apps/site/media/tasq-demo.tape");
await writeFile(tapePath, (await readFile(tapePath, "utf8")).replace(/@tasq-run\/cli@[0-9.]+ demo/, `@tasq-run/cli@${version} demo`), "utf8");
// The README pins the same `npx` line by hand; a release that forgets it keeps
// advertising the previous release (0.6.1 survived two releases this way).
const readmePath = resolve(root, "README.md");
// The README names the release in prose as well as in the pin (the alpha
// notice, the package versions, the wheel pin, the release link), and the
// publication check reads all of it, so all of it advances here: a writer
// narrower than its checker leaves the next release to a hand edit.
await writeFile(readmePath, (await readFile(readmePath, "utf8")).replace(/\b(v?)\d+\.\d+\.\d+\b/g, `$1${version}`), "utf8");
// llms.txt is the page agents read to learn which release exists.
const llmsPath = resolve(root, "docs/integrations/llms.txt");
await writeFile(llmsPath, (await readFile(llmsPath, "utf8")).replace(/Tasq Local \d+\.\d+\.\d+ is published/, `Tasq Local ${version} is published`), "utf8");
// The acquisition manifests agent hosts read. Nothing advanced them, so both
// halves sat on v0.4.0 for two releases and told every host to install a stale
// CLI. Only the acquisition pins move: `minimumVersion` names the release a
// capability first shipped in and is history, not a pin.
for (const relative of [
  "docs/integrations/AGENT_INTEGRATIONS.json",
  "docs/integrations/AGENT_INTEGRATIONS.md",
  "apps/site/public/integration.json",
]) {
  const path = resolve(root, relative);
  const advanced = (await readFile(path, "utf8"))
    .replace(/@tasq-run\/cli@\d+\.\d+\.\d+/g, `@tasq-run/cli@${version}`)
    .replace(/install-v\d+\.\d+\.\d+\.sh/g, `install-v${version}.sh`)
    .replace(/(--version"?,?\s+"?)\d+\.\d+\.\d+/g, `$1${version}`)
    .replace(/("acquisition":\s*\{\s*"version":\s*")\d+\.\d+\.\d+/g, `$1${version}`);
  await writeFile(path, advanced, "utf8");
}
const notesPath = resolve(root, "docs/releases/RELEASES.md");
let notes = await readFile(notesPath, "utf8");
const previousTag = previous.tag as string;
if (!notes.includes(`## \`${previousTag}\` current release`)) fail(`RELEASES.md has no '## \`${previousTag}\` current release' section to advance`);
notes = notes.replace(`Current \`${previousTag}\` is published`, `Current \`${tag}\` is published`);
const changelog = await readFile(resolve(root, "CHANGELOG.md"), "utf8");
const entryStart = changelog.indexOf(`## v${version} - `);
const intro = entryStart === -1 ? "" : (changelog.slice(entryStart).split("\n").slice(2).find((line) => line.trim().length > 0) ?? "");
notes = notes.replace(
  `## \`${previousTag}\` current release`,
  `## \`${tag}\` current release\n\nPublished ${release.publishedAt} from tag \`${tag}\`, protected run\n[${run.databaseId}](${run.url}).${certificationRun ? `\nCertified by [${certificationRun.split("/").pop()}](${certificationRun}).` : ""}${recorded.length ? `\nSurfaces recorded: ${recorded.join(", ")}.` : ""}\n\n${intro}\n\n## \`${previousTag}\``,
);
await writeFile(notesPath, notes, "utf8");

if (verify) {
  sh(["pnpm", "--filter", "@tasq-internal/site", "generate"], { cwd: root });
  sh(["bun", "scripts/release/verify-publication-recorded.ts"], { cwd: root });
}
process.stdout.write(`${JSON.stringify({
  contractVersion: "tasq.release-record.v1", version, tag, sourceCommit: commit, releaseRun: run.url, publishedAt: release.publishedAt,
  packages, state: authorization.state, recordedSurfaces: recorded, verified: verify,
}, null, 2)}\n`);

/**
 * The two hand-done halves of a release, prepare and record, as commands.
 *
 * On 2026-09-06 v0.6.2 shipped without its server image and Python wheel
 * because their candidate blocks were never authorized before the tag, and
 * the record was filled by a throwaway script. Both halves are deterministic
 * edits of files this repository owns; these tests drive them against a
 * fabricated tree copied from the real one.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const productRoot = resolve(import.meta.dir, "../..");
const MIRRORED = [
  "docs/releases/PUBLIC_RELEASE_POLICY.json",
  "docs/contracts/TQ-621_MULTI_AGENT_COMPARISON.json",
  "apps/site/media/tasq-demo.tape",
  "docs/releases/RELEASES.md",
  "CHANGELOG.md",
];
const roots: string[] = [];
afterAll(async () => { for (const root of roots) await rm(root, { recursive: true, force: true }); });

async function fabricate(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "tasq-release-pipeline-"));
  roots.push(root);
  for (const relative of MIRRORED) {
    const target = join(root, relative);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, await readFile(join(productRoot, relative), "utf8"), "utf8");
  }
  await mkdir(join(root, "scripts/release"), { recursive: true });
  await mkdir(join(root, "apps/site/public"), { recursive: true });
  return root;
}

function run(script: string, args: string[]) {
  const child = Bun.spawnSync(["bun", resolve(productRoot, "scripts/release", script), ...args], { cwd: productRoot, stdout: "pipe", stderr: "pipe" });
  return { exitCode: child.exitCode, stdout: child.stdout.toString(), stderr: child.stderr.toString() };
}

async function policyOf(root: string) {
  return JSON.parse(await readFile(join(root, "docs/releases/PUBLIC_RELEASE_POLICY.json"), "utf8"));
}

describe("release:prepare", () => {
  test("authorizes the release, the TQ-616 program and every candidate surface, and opens the changelog entry", async () => {
    const root = await fabricate();
    const before = await policyOf(root);
    const version = `${Number(before.publishedRelease.version.split(".")[0]) + 1}.0.0`;
    await writeFile(join(root, "CHANGELOG.md"), "# Changelog\n\n## Unreleased\n\n### Fixed\n\n- Something real.\n\n## v0.0.1 - 2020-01-01\n\nOld.\n", "utf8");
    const result = run("prepare-release.ts", ["--version", version, "--rationale", "A fabricated release, to prove the command.", "--date", "2026-09-06", "--root", root, "--no-verify"]);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      contractVersion: "tasq.release-prepare.v1",
      version,
      authorizedSurfaces: ["serverImage", "pythonWheel", "remoteTypeScriptClient"],
    });
    const policy = await policyOf(root);
    expect(policy.releaseAuthorization).toMatchObject({ state: "authorized", version, decision: "go", authorizedBy: "@gwendall", authorizedAt: "2026-09-06" });
    expect(policy.releaseAuthorization.rationale).toContain(`Authorized for v${version}, not yet published.`);
    expect(policy.certificationPrograms.tq616SignedStatements).toMatchObject({ state: "authorized", version });
    for (const key of ["serverImage", "pythonWheel", "remoteTypeScriptClient"]) {
      const candidate = policy.candidatePublications[key];
      expect(candidate).toMatchObject({ state: "authorized", version, decision: "go", authorizedBy: "@gwendall", authorizedAt: "2026-09-06" });
      // Publication facts belong to the record, never to an authorization.
      expect(candidate).not.toHaveProperty("digest");
      expect(candidate).not.toHaveProperty("publicationWorkflowRun");
      expect(candidate.coordinate).toBe(before.candidatePublications[key].coordinate);
    }
    // publishedRelease is untouched: it describes what is public, and nothing is yet.
    expect(policy.publishedRelease).toEqual(before.publishedRelease);
    const changelog = await readFile(join(root, "CHANGELOG.md"), "utf8");
    expect(changelog).toContain(`## Unreleased\n\n## v${version} - 2026-09-06\n\nA fabricated release, to prove the command.\n\n### Fixed\n\n- Something real.\n`);
    expect(changelog.indexOf("## Unreleased")).toBeLessThan(changelog.indexOf(`## v${version}`));
  });

  test("authorizes only the surfaces asked for", async () => {
    const root = await fabricate();
    await writeFile(join(root, "CHANGELOG.md"), "## Unreleased\n\n- Something.\n\n## v0.0.1 - 2020-01-01\n", "utf8");
    const result = run("prepare-release.ts", ["--version", "9.9.9", "--rationale", "Only the server this time, on purpose.", "--surfaces", "server", "--root", root, "--no-verify"]);
    expect(result.exitCode, result.stderr).toBe(0);
    const policy = await policyOf(root);
    expect(policy.candidatePublications.serverImage).toMatchObject({ state: "authorized", version: "9.9.9" });
    expect(policy.candidatePublications.pythonWheel.version).not.toBe("9.9.9");
  });

  test("refuses a release with nothing under Unreleased, and a dry run writes nothing", async () => {
    const root = await fabricate();
    await writeFile(join(root, "CHANGELOG.md"), "## Unreleased\n\n## v0.0.1 - 2020-01-01\n", "utf8");
    const empty = run("prepare-release.ts", ["--version", "9.9.9", "--rationale", "There is nothing to release here.", "--root", root, "--no-verify"]);
    expect(empty.exitCode).not.toBe(0);
    expect(empty.stderr).toContain("nothing under '## Unreleased'");

    await writeFile(join(root, "CHANGELOG.md"), "## Unreleased\n\n- Something.\n\n## v0.0.1 - 2020-01-01\n", "utf8");
    const before = await readFile(join(root, "docs/releases/PUBLIC_RELEASE_POLICY.json"), "utf8");
    const dry = run("prepare-release.ts", ["--version", "9.9.9", "--rationale", "A dry run must change nothing.", "--root", root, "--dry-run"]);
    expect(dry.exitCode, dry.stderr).toBe(0);
    expect(JSON.parse(dry.stdout).dryRun).toBe(true);
    expect(await readFile(join(root, "docs/releases/PUBLIC_RELEASE_POLICY.json"), "utf8")).toBe(before);
  });
});

describe("release:record", () => {
  test("advances every public surface from explicit publication facts", async () => {
    const root = await fabricate();
    const before = await policyOf(root);
    const previousTag = before.publishedRelease.tag;
    const version = "9.9.9";
    await writeFile(join(root, "CHANGELOG.md"), "## Unreleased\n\n### Fixed\n\n- A thing.\n\n## v0.0.1 - 2020-01-01\n", "utf8");
    // The tree was prepared: authorized blocks for 9.9.9, client included, and the changelog entry opened.
    const prepared = run("prepare-release.ts", ["--version", version, "--rationale", "The release that proves the record command.", "--date", "2026-09-06", "--root", root, "--no-verify"]);
    expect(prepared.exitCode, prepared.stderr).toBe(0);
    const installer = join(root, "fake-installer.sh");
    await writeFile(installer, `#!/bin/sh\nVERSION="${version}"\nCHECKSUMS_SHA256="${"a".repeat(64)}"\nCHECKSUMS_SHA256="${"b".repeat(64)}"\n`, "utf8");
    const surfaces = join(root, "surfaces.json");
    await writeFile(surfaces, JSON.stringify({
      server: { digest: `sha256:${"c".repeat(64)}`, publicationWorkflowRun: "https://example.test/runs/1", certificationWorkflowRun: "https://example.test/runs/2" },
      python: { wheelSha256: "d".repeat(64), publicationWorkflowRun: "https://example.test/runs/3", certificationWorkflowRun: "https://example.test/runs/4" },
    }), "utf8");
    const packages = before.publishedRelease.publishedPackages.map((pkg: { name: string }) => `${pkg.name}=${version}`).join(",");
    const result = run("record-publication.ts", [
      "--version", version, "--root", root, "--no-verify",
      "--tag-commit", "f".repeat(40), "--release-url", "https://example.test/releases/v9.9.9", "--published-at", "2026-09-06T10:00:00Z",
      "--run-url", "https://example.test/runs/9", "--run-id", "9", "--packages", packages, "--installer-from", installer,
      "--certification-run", "https://example.test/runs/10", "--surfaces-json", surfaces,
    ]);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      contractVersion: "tasq.release-record.v1", version, state: "published_certified",
      recordedSurfaces: ["serverImage", "pythonWheel", "remoteTypeScriptClient"],
    });
    const policy = await policyOf(root);
    expect(policy.publishedRelease).toMatchObject({ version, tag: `v${version}`, sourceCommit: "f".repeat(40), publishedAt: "2026-09-06T10:00:00Z", workflowRun: "https://example.test/runs/9" });
    expect(policy.publishedRelease.publishedPackages.every((pkg: { version: string }) => pkg.version === version)).toBe(true);
    expect(policy.releaseAuthorization.state).toBe("published_certified");
    expect(policy.releaseAuthorization.rationale).toContain(`Consumed by v${version}, published 2026-09-06T10:00:00Z.`);
    expect(policy.certificationPrograms.tq616SignedStatements).toMatchObject({ state: "published_certified", certificationWorkflowRun: "https://example.test/runs/10" });
    expect(policy.candidatePublications.serverImage).toMatchObject({ state: "published_certified", version, digest: `sha256:${"c".repeat(64)}` });
    expect(policy.candidatePublications.pythonWheel).toMatchObject({ state: "published_certified", version, wheelSha256: "d".repeat(64) });
    expect(policy.candidatePublications.remoteTypeScriptClient).toMatchObject({ state: "published_certified", version, publicationWorkflowRun: "https://example.test/runs/9" });
    for (const relative of [`scripts/release/install-v${version}.sh`, `apps/site/public/install-v${version}.sh`, "apps/site/public/install.sh"]) {
      expect(await readFile(join(root, relative), "utf8")).toContain(`VERSION="${version}"`);
    }
    const comparison = JSON.parse(await readFile(join(root, "docs/contracts/TQ-621_MULTI_AGENT_COMPARISON.json"), "utf8"));
    expect(comparison.tasqClaimBoundary.version).toBe(version);
    expect(await readFile(join(root, "apps/site/media/tasq-demo.tape"), "utf8")).toContain(`@tasq-run/cli@${version} demo`);
    const notes = await readFile(join(root, "docs/releases/RELEASES.md"), "utf8");
    expect(notes).toContain(`Current \`v${version}\` is published`);
    expect(notes).toContain(`## \`v${version}\` current release`);
    expect(notes).toContain("The release that proves the record command.");
    expect(notes).toContain(`## \`${previousTag}\`\n`);
    expect(notes).not.toContain(`## \`${previousTag}\` current release`);
  });

  test("refuses to record a version the policy already records", async () => {
    const root = await fabricate();
    const policy = await policyOf(root);
    const result = run("record-publication.ts", ["--version", policy.publishedRelease.version, "--root", root, "--no-verify", "--tag-commit", "f".repeat(40)]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("already records");
  });
});

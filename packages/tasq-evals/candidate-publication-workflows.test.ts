import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");
setDefaultTimeout(20_000);
const read = (path: string) => readFileSync(resolve(root, path), "utf8");
type CandidatePublication = "serverImage" | "pythonWheel" | "remoteTypeScriptClient";
type CandidateAuthorization = {
  state: string;
  coordinate: string;
  workflow: string;
  environment: string;
  version: string | null;
  sourceBinding: string;
  decision: string;
  authorizedBy: string | null;
  authorizedAt: string | null;
};
type Policy = {
  releaseAuthorization: { version: string };
  externalPublicationGateStatus: Record<string, boolean>;
  candidatePublications: Record<CandidatePublication, CandidateAuthorization>;
  publishedRelease: {
    version: string;
    publishedPackages: Array<{ name: string; version: string }>;
  };
};
const policy = JSON.parse(read("docs/releases/PUBLIC_RELEASE_POLICY.json")) as Policy;
const publishedVersion = policy.publishedRelease.version;
const version = "0.4.0";
const sourceCommit = "a".repeat(40);
let scratch = "";

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "tasq-candidate-publication-"));
});

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

function nextPolicy(): Policy {
  const candidate = structuredClone(policy);
  candidate.releaseAuthorization.version = version;
  candidate.externalPublicationGateStatus.trusted_publishing_configured = true;
  candidate.externalPublicationGateStatus.data_safety_source_candidate = true;
  return candidate;
}

function authorized(surface: CandidatePublication): Policy {
  const candidate = nextPolicy();
  candidate.candidatePublications[surface] = {
    ...candidate.candidatePublications[surface],
    state: "authorized",
    version,
    decision: "go",
    authorizedBy: "@gwendall",
    authorizedAt: "2026-07-30",
  };
  return candidate;
}

async function verify(
  candidate: Policy,
  surface: CandidatePublication,
  commit = sourceCommit,
  requestedVersion = version,
) {
  const policyPath = join(scratch, `${surface}-${crypto.randomUUID()}.json`);
  await writeFile(policyPath, `${JSON.stringify(candidate)}\n`, "utf8");
  const child = Bun.spawn([
    process.execPath,
    resolve(root, "scripts/release/verify-candidate-publication-authorization.ts"),
    "--policy", policyPath,
    "--surface", surface,
    "--version", requestedVersion,
    "--source-commit", commit,
    "--repository", "gwendall/tasq",
  ], { stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

describe("protected candidate publication entrypoints", () => {
  test("authorizes every exact v0.4.0 coordinate and still fails closed otherwise", async () => {
    expect(policy.externalPublicationGateStatus.trusted_publishing_configured).toBe(true);
    const pendingTrust = structuredClone(policy);
    pendingTrust.externalPublicationGateStatus.trusted_publishing_configured = false;
    const pendingResult = await verify(pendingTrust, "serverImage");
    expect(pendingResult.exitCode).not.toBe(0);
    expect(pendingResult.stderr).toContain(
      "required gate trusted_publishing_configured is not verified",
    );

    for (const surface of [
      "serverImage",
      "pythonWheel",
      "remoteTypeScriptClient",
    ] as const) {
      expect(policy.candidatePublications[surface]).toMatchObject({
        state: "authorized",
        version,
        decision: "go",
        authorizedBy: "@gwendall",
        authorizedAt: "2026-07-31",
      });
      const accepted = await verify(nextPolicy(), surface);
      expect(accepted.exitCode, accepted.stderr).toBe(0);

      const blocked = nextPolicy();
      blocked.candidatePublications[surface].state = "prepared_not_authorized";
      blocked.candidatePublications[surface].decision = "pending";
      const rejected = await verify(blocked, surface);
      expect(rejected.exitCode).not.toBe(0);
      expect(rejected.stderr).toContain(
        `${surface} publication state is prepared_not_authorized`,
      );
    }
  });

  test("binds runtime source through the protected immutable version tag", async () => {
    for (const surface of ["serverImage", "pythonWheel"] as const) {
      const accepted = await verify(authorized(surface), surface);
      expect(accepted.exitCode, accepted.stderr).toBe(0);
      expect(JSON.parse(accepted.stdout)).toMatchObject({
        contractVersion: "tasq.candidate-publication-authorization.v1",
        surface,
        version,
        sourceCommit,
        sourceTag: `v${version}`,
        sourceBinding: "protected_immutable_version_tag_runtime_commit",
        environment: "release",
        authorizedBy: "@gwendall",
      });
      const invalidBinding = authorized(surface);
      invalidBinding.candidatePublications[surface].sourceBinding = "embedded_policy_commit";
      const drift = await verify(invalidBinding, surface);
      expect(drift.exitCode).not.toBe(0);
      expect(drift.stderr).toContain(`${surface} source binding drift`);

      const otherRuntimeCommit = "b".repeat(40);
      const rebound = await verify(authorized(surface), surface, otherRuntimeCommit);
      expect(rebound.exitCode, rebound.stderr).toBe(0);
      expect(JSON.parse(rebound.stdout)).toMatchObject({
        sourceCommit: otherRuntimeCommit,
        sourceTag: `v${version}`,
      });

      const historical = authorized(surface);
      historical.releaseAuthorization.version = publishedVersion;
      historical.candidatePublications[surface].version = publishedVersion;
      historical.candidatePublications.remoteTypeScriptClient.state =
        "prepared_not_authorized";
      historical.candidatePublications.remoteTypeScriptClient.decision = "pending";
      const regression = await verify(historical, surface, sourceCommit, publishedVersion);
      expect(regression.exitCode).not.toBe(0);
      expect(regression.stderr).toContain(
        `${surface} version ${publishedVersion} must be newer than published ${publishedVersion}`,
      );
    }
  });

  test("compares arbitrarily large SemVer components without numeric rounding", async () => {
    const surface = "serverImage";
    const large = authorized(surface);
    const next = "9007199254740993.0.0";
    large.publishedRelease.publishedPackages = [];
    large.publishedRelease.version = "9007199254740992.0.0";
    large.releaseAuthorization.version = next;
    large.candidatePublications[surface].version = next;
    large.candidatePublications.remoteTypeScriptClient.state =
      "prepared_not_authorized";
    large.candidatePublications.remoteTypeScriptClient.decision = "pending";
    const accepted = await verify(large, surface, sourceCommit, next);
    expect(accepted.exitCode, accepted.stderr).toBe(0);

    large.publishedRelease.version = "9007199254740994.0.0";
    const rejected = await verify(large, surface, sourceCommit, next);
    expect(rejected.exitCode).not.toBe(0);
    expect(rejected.stderr).toContain(
      `${surface} version ${next} must be newer than published 9007199254740994.0.0`,
    );
  });

  test("prepares multi-arch digest-bound Server publication and replay", () => {
    const publish = read(".github/workflows/publish-server.yml");
    const certify = read(".github/workflows/certify-published-server.yml");
    const resumeGuard = read("scripts/release/resolve-oci-publication-resume.sh");
    const tagGuard = read("scripts/release/ensure-oci-tag.sh");
    expect(publish).toContain("INPUT_CONFIRMATION: ${{ inputs.confirmation }}");
    expect(publish).toContain("test \"$INPUT_CONFIRMATION\" = \"publish-tasq-server\"");
    expect(publish).toContain('test "$(git rev-parse HEAD)" = "$INPUT_SOURCE_COMMIT"');
    expect(publish).toContain(
      'test "$GITHUB_REF" = "refs/heads/main" || test "$GITHUB_REF" = "refs/tags/${release_tag}"',
    );
    expect(publish).toContain(
      'test "$(git rev-parse "refs/tags/${release_tag}^{commit}")" = "$INPUT_SOURCE_COMMIT"',
    );
    expect(publish).toContain("--surface serverImage");
    expect(publish).toContain("environment: release");
    expect(publish).toContain("platforms: linux/amd64,linux/arm64");
    expect(publish).toContain("TASQ_VERSION=${{ needs.authorize.outputs.version }}");
    expect(publish).toContain("TASQ_SOURCE_COMMIT=${{ needs.authorize.outputs.commit }}");
    expect(publish).toContain("provenance: mode=max");
    expect(publish).toContain("sbom: true");
    expect(publish).toContain("subject-digest: ${{ steps.selected-image.outputs.digest }}");
    expect(publish).toContain("server-container-smoke.ts\" tasq-server:protected-amd64");
    expect(publish).toContain("server-container-smoke.ts\" tasq-server:protected-arm64");
    const smokeHarness = read("scripts/server-container-smoke.ts");
    expect(smokeHarness).toContain("attempt < 300");
    expect(smokeHarness).toContain('"docker", "logs", "--tail", "100", container');
    expect(publish.indexOf('docker image rm tasq-server:protected-amd64 "$reference"')).toBeLessThan(
      publish.indexOf('docker pull --platform linux/arm64 "$reference"'),
    );
    expect(publish).toContain('.metadata.version == $version');
    expect(publish).toContain('.metadata.revision == $revision');
    expect(publish).toContain("scripts/release/resolve-oci-publication-resume.sh");
    expect(publish).toContain("scripts/release/ensure-oci-tag.sh");
    expect(publish).toContain("ref: ${{ github.sha }}");
    expect(publish).toContain("$RUNNER_TEMP/tasq-release-automation");
    expect(resumeGuard).toContain(
      "Registry lookup failed without an explicit missing-manifest result",
    );
    expect(resumeGuard).toContain("MANIFEST_UNKNOWN");
    expect(resumeGuard).toContain(
      "Existing version and source tags resolve to different immutable digests",
    );
    expect(tagGuard).toContain("Refusing to overwrite");
    expect(tagGuard).not.toContain("docker tag");
    expect(publish).toContain(":sha-${{ needs.authorize.outputs.commit }}");
    expect(publish).toContain("steps.resume.outputs.action == 'reuse'");
    expect(publish).toContain(
      '--signer-workflow "gwendall/tasq/.github/workflows/publish-server.yml"',
    );
    expect(publish).toContain('--source-digest "${{ needs.authorize.outputs.commit }}"');
    expect(publish).toContain(
      'reference="${{ needs.authorize.outputs.image }}@${{ steps.selected-image.outputs.digest }}"',
    );
    expect(publish).toContain("gh release view \"$release_tag\"");
    expect(publish).toContain("run: pnpm verify:handoff");
    expect(publish).not.toContain(":latest");
    expect(publish.indexOf("id: build")).toBeLessThan(
      publish.indexOf("Replay both packaged Server platforms"),
    );
    expect(publish.indexOf("Replay both packaged Server platforms")).toBeLessThan(
      publish.indexOf("Promote the verified digest"),
    );
    expect(publish.indexOf('"$sha_tag" "$reference"')).toBeLessThan(
      publish.indexOf('"$version_tag" "$reference"'),
    );
    expect(publish.indexOf("Verify protected source provenance before reusing")).toBeLessThan(
      publish.lastIndexOf("ensure-oci-tag.sh"),
    );
    expect(publish).toContain('--json assets');
    expect(publish).toContain('[.assets[] | select(.name == $name)] | length');
    expect(publish).toContain("Release contains duplicate asset name");
    expect(publish).not.toContain("--pattern \"$name\" >/dev/null 2>&1");
    expect(certify).toContain("INPUT_CONFIRMATION: ${{ inputs.confirmation }}");
    expect(certify).toContain("test \"$INPUT_CONFIRMATION\" = \"certify-tasq-server\"");
    expect(certify).toContain(
      'test "$GITHUB_REF" = "refs/heads/main" || test "$GITHUB_REF" = "refs/tags/${release_tag}"',
    );
    expect(certify).toContain(
      'test "$(git rev-parse "refs/tags/${release_tag}^{commit}")" = "$INPUT_SOURCE_COMMIT"',
    );
    expect(certify).toContain("ref: ${{ github.sha }}");
    expect(certify).toContain("$RUNNER_TEMP/tasq-certification-automation/server-container-smoke.ts");
    expect(certify).toContain("ghcr.io/gwendall/tasq-server@$INPUT_DIGEST");
    expect(certify).toContain("tasq-server:published-certification");
    expect(certify).toContain("test \"$resolved\" = \"$INPUT_DIGEST\"");
    expect(certify).toContain("org.opencontainers.image.version");
    expect(certify).toContain("org.opencontainers.image.revision");
    expect(certify).toContain("certify-hosted-console-image.ts");
    expect(certify).toContain(".image.exactPublishedDigest == true");
    expect(certify).toContain(".publicSupportClaim == false");
    expect(certify).toContain(".browser.receiptReplay == true");
    expect(certify).toContain("tasq-server-tq811-browser-evidence");
  });

  test("prepares deterministic trusted PyPI publication and exact-wheel replay", () => {
    const publish = read(".github/workflows/publish-python.yml");
    const certify = read(".github/workflows/certify-published-python.yml");
    const builder = read("scripts/release/build-python-wheel.py");
    const resumeVerifier = read("scripts/release/verify_pypi_resume.py");
    expect(publish).toContain("INPUT_CONFIRMATION: ${{ inputs.confirmation }}");
    expect(publish).toContain("test \"$INPUT_CONFIRMATION\" = \"publish-tasq-python\"");
    expect(publish).toContain('test "$(git rev-parse HEAD)" = "$INPUT_SOURCE_COMMIT"');
    expect(publish).toContain(
      'test "$GITHUB_REF" = "refs/heads/main" || test "$GITHUB_REF" = "refs/tags/${release_tag}"',
    );
    expect(publish).toContain(
      'test "$(git rev-parse "refs/tags/${release_tag}^{commit}")" = "$INPUT_SOURCE_COMMIT"',
    );
    expect(publish).toContain("--surface pythonWheel");
    expect(publish).toContain("pypa/gh-action-pypi-publish@");
    expect(publish).toContain("attestations: true");
    expect(publish).toContain("scripts/release/verify_pypi_resume.py");
    expect(publish).toContain("steps.resume.outputs.state == 'identical'");
    expect(publish).toContain("steps.resume.outputs.state == 'absent'");
    expect(publish).toContain("Verify protected provenance before reusing PyPI bytes");
    expect(publish).toContain(
      '--signer-workflow "gwendall/tasq/.github/workflows/publish-python.yml"',
    );
    expect(publish).not.toContain("skip-existing");
    expect(resumeVerifier).toContain("existing PyPI wheel differs from protected candidate bytes");
    expect(resumeVerifier).toContain("error.code == 404");
    expect(resumeVerifier).toContain("refusing non-canonical PyPI URL");
    expect(resumeVerifier).toContain(
      "registry URLs must not contain credentials, query, or fragment",
    );
    expect(publish).toContain('--json assets');
    expect(publish).toContain('[.assets[] | select(.name == $name)] | length');
    expect(publish).toContain("Release contains duplicate asset name");
    expect(publish).not.toContain("--pattern \"$name\" >/dev/null 2>&1");
    expect(builder).toContain("ZIP_TIME = (1980, 1, 1, 0, 0, 0)");
    expect(builder).toContain("compression=zipfile.ZIP_STORED");
    expect(builder).toContain('"runtimeDependencies": []');
    expect(builder).not.toContain("datetime");
    expect(certify).toContain("INPUT_CONFIRMATION: ${{ inputs.confirmation }}");
    expect(certify).toContain("test \"$INPUT_CONFIRMATION\" = \"certify-tasq-python\"");
    expect(certify).toContain(
      'test "$GITHUB_REF" = "refs/heads/main" || test "$GITHUB_REF" = "refs/tags/${release_tag}"',
    );
    expect(certify).toContain(
      'test "$(git rev-parse "refs/tags/${release_tag}^{commit}")" = "$INPUT_SOURCE_COMMIT"',
    );
    expect(certify).toContain("tasq-remote==$INPUT_VERSION");
    expect(certify).toContain("sha256sum --check --status");
    expect(certify).toContain("--no-deps");
    expect(certify).toContain("INPUT_SERVER_DIGEST: ${{ inputs.server_digest }}");
    expect(certify).toContain("[[ \"$INPUT_SERVER_DIGEST\" =~ ^sha256:[a-f0-9]{64}$ ]]");
    expect(certify).toContain("ghcr.io/gwendall/tasq-server@$INPUT_SERVER_DIGEST");
    expect(certify).toContain(
      '--signer-workflow "gwendall/tasq/.github/workflows/publish-server.yml"',
    );
    expect(certify).toContain("org.opencontainers.image.version");
    expect(certify).toContain("org.opencontainers.image.revision");
    expect(certify).toContain(
      "\"$RUNNER_TEMP/tasq-python/bin/python\" \\\n            scripts/release/certify_published_python_server.py",
    );
    expect(certify).toContain(".python.installedWheelOnly == true");
    expect(certify).toContain(".server.exactPublishedDigest == true");
    expect(certify).toContain(".journey.exactMutationReplay == true");
    expect(certify).toContain("tasq-python-tq810-exact-artifact-evidence");
    expect(publish).toContain("python-remote-client.test.ts");
    expect(publish).toContain("python-wheel-build.test.ts");
    expect(publish).toContain("Install and import the exact wheel selected for PyPI");
    expect(publish).toContain("gh release view \"$release_tag\"");
  });

  test("keeps the eighth npm candidate in the builder but outside v0.3.0 by default", () => {
    const workflow = read(".github/workflows/release.yml");
    const certification = read(".github/workflows/certify-published-release.yml");
    const builder = read("scripts/release/build-public-packages.ts");
    expect(builder).toContain('name: "@tasq-run/client"');
    expect(workflow).toContain('test "$(git tag --points-at HEAD)" = "${GITHUB_REF_NAME}"');
    expect(workflow).toContain("TASQ_PUBLIC_PACKAGES: ${{ needs.identity.outputs.packages }}");
    expect(workflow).toContain("index($package) != null");
    expect(certification).toContain(".publicPackages[]");
    expect(certification).not.toContain("packages=(@tasq-run/");
    expect(certification).toContain("TASQ_PUBLISHED_REMOTE_CLIENT_VERSION");
    expect(certification).toContain("TASQ_PUBLISHED_REMOTE_CLIENT_SOURCE_COMMIT");
    expect(certification).toContain("published-remote-client.test.ts");
    expect(certification).toContain("--signer-workflow \"gwendall/tasq/.github/workflows/release.yml\"");
    expect(certification).toContain("target: linux-x64-gnu");
    expect(certification).toContain("target: darwin-arm64");
    expect(certification).toContain("verify-tq616-release-eligibility.ts");
    expect(certification).toContain('test "$GITHUB_REF" = "refs/tags/$INPUT_TAG"');
    expect(certification).toContain(
      'test "$(git rev-parse "${INPUT_TAG}^{commit}")" = "$INPUT_SOURCE_COMMIT"',
    );
    expect(certification).toContain("steps.tq616-eligibility.outputs.replay == 'true'");
    expect(certification).toContain("reconstruct-downloaded-package-manifest.ts");
    expect(certification).toContain("npm audit signatures");
    expect(certification).toContain("certify-signed-statement-package-candidate.ts");
    expect(certification).toContain("passed_protected_downloaded_artifact_replay");
    expect(certification).toContain(
      '.remainingExternalGate == ["unbriefed_agent_and_operator_trial"]',
    );
    expect(certification).toContain(".publicSupportClaim == false");
    expect(certification).toContain("tasq-tq616-${{ matrix.target }}");
    expect(certification).toContain("dist/npm-verifications/*.npm-publication.json");
    expect(certification).toContain("dist/packages/*.release.json");
    expect(policy.publishedRelease.publishedPackages).toHaveLength(7);
    expect(policy.publishedRelease.publishedPackages.map(({ name }) => name))
      .not.toContain("@tasq-run/client");
  });
});

import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  appendFile,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const roots: string[] = [];
const productRoot = resolve(import.meta.dir, "../..");
const builder = join(productRoot, "scripts/release/build-public-packages.ts");
const reconstructor = join(
  productRoot,
  "scripts/release/reconstruct-downloaded-package-manifest.ts",
);
const certifier = join(import.meta.dir, "scripts/certify-signed-statement-package-candidate.ts");
const version = "0.0.0-tq616-candidate.1";
const sourceCommit = "6166166166166166166166166166166166166166";

setDefaultTimeout(300_000);

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function run(command: string[], cwd: string) {
  const child = Bun.spawn(command, {
    cwd,
    env: process.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

test("TQ-616 verifies exact locally generated package-candidate bytes under Node, Bun and Python", async () => {
  const root = await mkdtemp(join(tmpdir(), "tasq-tq616-candidate-test-"));
  roots.push(root);
  const packages = join(root, "packages");
  const built = await run([
    process.execPath,
    builder,
    "--version",
    version,
    "--source-commit",
    sourceCommit,
    "--outdir",
    packages,
  ], productRoot);
  expect(built.exitCode, built.stderr || built.stdout).toBe(0);

  const certified = await run([
    process.execPath,
    certifier,
    "--packages-dir",
    packages,
  ], productRoot);
  expect(certified.exitCode, certified.stderr || certified.stdout).toBe(0);
  expect(certified.stderr).toBe("");
  expect(JSON.parse(certified.stdout)).toMatchObject({
    contractVersion: "tasq.tq616-package-candidate-clean-room.v1",
    status: "passed_local_candidate_only",
    artifact: {
      version,
      sourceCommit,
      tarballCount: 8,
      allDeclaredTarballDigestsVerified: true,
      localArtifactsPublishable: false,
    },
    installedBytes: {
      packages: [
        { name: "@tasq-run/core", version },
        { name: "@tasq-run/extension-sdk", version },
        { name: "@tasq-run/schema", version },
      ],
      extractedAndInstalledInventoriesMatch: true,
    },
    runtimes: {
      node: {
        runtime: "node",
        validStatement: "passed",
        alteredBytes: "rejected",
        corePurposeCount: 6,
        signatureIsAuthority: false,
      },
      bun: {
        runtime: "bun",
        validStatement: "passed",
        alteredBytes: "rejected",
        corePurposeCount: 6,
        signatureIsAuthority: false,
      },
      python: {
        contractVersion: "tasq.signed-statement-vector.v1",
        verified: true,
      },
    },
    publicSupportClaim: false,
    remainingExternalGate: [
      "protected_release_workflow",
      "exact_downloaded_bytes",
      "supported_macos_arm64_and_linux_x64",
      "node_bun_python_clean_room",
      "unbriefed_agent_and_operator_trial",
    ],
  });

  const releaseFile = (await readdir(packages))
    .find((name) => name.endsWith(".release.json"));
  expect(releaseFile).toBeDefined();
  const release = JSON.parse(await readFile(join(packages, releaseFile!), "utf8"));
  const downloaded = join(root, "downloaded");
  const verifications = join(root, "verifications");
  await Promise.all([
    mkdir(downloaded, { recursive: true }),
    mkdir(verifications, { recursive: true }),
  ]);
  for (const artifact of release.packages as Array<{
    name: string;
    filename: string;
  }>) {
    const source = join(packages, artifact.filename);
    await copyFile(source, join(downloaded, artifact.filename));
    const integrity = `sha512-${createHash("sha512")
      .update(await readFile(source))
      .digest("base64")}`;
    await writeFile(
      join(
        verifications,
        `${artifact.name.slice("@tasq-run/".length)}.npm-publication.json`,
      ),
      `${JSON.stringify({
        contractVersion: "tasq.npm-publication-verification.v1",
        status: "published",
        package: artifact.name,
        version,
        sourceCommit,
        integrity,
      })}\n`,
      "utf8",
    );
  }
  const downloadedManifest = join(
    downloaded,
    `tasq-packages-v${version}.release.json`,
  );
  const reconstructed = await run([
    process.execPath,
    reconstructor,
    "--packages-dir",
    downloaded,
    "--verification-dir",
    verifications,
    "--version",
    version,
    "--source-commit",
    sourceCommit,
    "--out",
    downloadedManifest,
    ...release.packages.flatMap((artifact: { name: string }) => [
      "--expected-package",
      artifact.name,
    ]),
  ], productRoot);
  expect(reconstructed.exitCode, reconstructed.stderr || reconstructed.stdout).toBe(0);

  const reconstructedManifest = JSON.parse(
    await readFile(downloadedManifest, "utf8"),
  );
  expect(reconstructedManifest).toMatchObject({
    contractVersion: "tasq.public-packages.v1",
    version,
    source: { commit: sourceCommit },
    provenance: {
      localArtifactsPublishable: false,
      artifactOrigin: "verified_npm_registry_download",
      registryIdentityAndIntegrityVerified: true,
    },
  });
  expect(reconstructedManifest.packages).toHaveLength(8);

  const downloadedCertification = await run([
    process.execPath,
    certifier,
    "--packages-dir",
    downloaded,
  ], productRoot);
  expect(
    downloadedCertification.exitCode,
    downloadedCertification.stderr || downloadedCertification.stdout,
  ).toBe(0);
  expect(JSON.parse(downloadedCertification.stdout)).toMatchObject({
    contractVersion: "tasq.tq616-protected-downloaded-clean-room.v1",
    status: "passed_protected_downloaded_artifact_replay",
    artifact: {
      version,
      sourceCommit,
      tarballCount: 8,
      allDeclaredTarballDigestsVerified: true,
      localArtifactsPublishable: false,
      artifactOrigin: "verified_npm_registry_download",
      exactDownloadedBytes: true,
      registryIdentityAndIntegrityVerified: true,
    },
    publicSupportClaim: false,
    remainingExternalGate: ["unbriefed_agent_and_operator_trial"],
  });

  const coreArchive = release.packages.find(
    (artifact: { name: string }) => artifact.name === "@tasq-run/core",
  ).filename;
  await appendFile(join(packages, coreArchive), "altered-after-manifest");
  const rejected = await run([
    process.execPath,
    certifier,
    "--packages-dir",
    packages,
  ], productRoot);
  expect(rejected.exitCode).not.toBe(0);
  expect(rejected.stderr).toContain("Candidate tarball digest mismatch: @tasq-run/core");
});

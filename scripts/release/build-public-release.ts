#!/usr/bin/env bun

import { chmod, copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { deterministicTarGzip } from "./deterministic-tar.js";

interface CliArtifact {
  contractVersion: "tasq.cli-artifact.v1";
  entrypoint: string;
  nativePackages: Array<{ package: string; target: string; sha256: string }>;
  bundledComponents: Array<{ name: string; version: string; license: string; purl: string }>;
}

interface ReleaseInputs {
  version: string;
  sourceCommit: string;
  target: "darwin-arm64" | "linux-x64-gnu";
  outdir: string;
}

function requiredFlag(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index === -1 ? undefined : process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} is required`);
  return value;
}

function inputs(): ReleaseInputs {
  const version = requiredFlag("--version");
  const sourceCommit = requiredFlag("--source-commit");
  const target = requiredFlag("--target");
  if (!/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`--version must be a SemVer release version: ${version}`);
  }
  if (!/^[a-f0-9]{40}$/.test(sourceCommit)) throw new Error("--source-commit must be a lowercase 40-character Git commit");
  if (target !== "darwin-arm64" && target !== "linux-x64-gnu") {
    throw new Error(`Unsupported release target: ${target}`);
  }
  return { version, sourceCommit, target, outdir: resolve(requiredFlag("--outdir")) };
}

async function sha256Bytes(bytes: Uint8Array): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(bytes);
  return hasher.digest("hex");
}

async function sha256File(path: string): Promise<string> {
  return sha256Bytes(await readFile(path));
}

function deterministicUuid(seed: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(seed);
  const hex = hasher.digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function thirdPartyNotices(components: CliArtifact["bundledComponents"]): string {
  return [
    "Tasq third-party notices",
    "",
    "This generated inventory lists software bundled into the CLI artifact.",
    "The corresponding CycloneDX SBOM is the machine-readable authority.",
    "",
    ...components.map((component) => `${component.name}@${component.version}\t${component.license}\t${component.purl}`),
    "",
  ].join("\n");
}

function cyclonedx(inputs: ReleaseInputs, artifact: CliArtifact) {
  const rootRef = `pkg:npm/%40tasq/cli@${inputs.version}`;
  return {
    bomFormat: "CycloneDX",
    specVersion: "1.6",
    serialNumber: `urn:uuid:${deterministicUuid(`${inputs.version}:${inputs.sourceCommit}:${inputs.target}`)}`,
    version: 1,
    metadata: {
      component: {
        type: "application",
        "bom-ref": rootRef,
        group: "tasq",
        name: "cli",
        version: inputs.version,
        licenses: [{ license: { id: "Apache-2.0" } }],
        purl: rootRef,
      },
      properties: [
        { name: "tasq:sourceCommit", value: inputs.sourceCommit },
        { name: "tasq:target", value: inputs.target },
        { name: "tasq:authoritativeTime", value: "not-read-build-inputs-only" },
      ],
    },
    components: artifact.bundledComponents.map((component) => ({
      type: "library",
      "bom-ref": component.purl,
      name: component.name,
      version: component.version,
      licenses: [{ license: { id: component.license } }],
      purl: component.purl,
    })),
    dependencies: [{ ref: rootRef, dependsOn: artifact.bundledComponents.map((component) => component.purl) }],
  };
}

async function main(): Promise<void> {
  const release = inputs();
  const productRoot = resolve(import.meta.dir, "../..");
  const payloadName = `tasq-v${release.version}-${release.target}`;
  const work = join(release.outdir, ".work");
  const payload = join(work, payloadName);
  await rm(release.outdir, { recursive: true, force: true });
  await mkdir(payload, { recursive: true });

  const build = Bun.spawn([
    process.execPath,
    resolve(productRoot, "packages/tasq-cli/scripts/build.ts"),
    "--version",
    release.version,
    "--outdir",
    payload,
  ], { cwd: productRoot, stdout: "inherit", stderr: "inherit" });
  if (await build.exited !== 0) throw new Error("Tasq CLI artifact build failed");

  const artifact = JSON.parse(await readFile(join(payload, "artifact.json"), "utf8")) as CliArtifact;
  const actualTargets = [...new Set(artifact.nativePackages.map((item) => item.target))];
  if (actualTargets.length !== 1 || actualTargets[0] !== release.target) {
    throw new Error(`Host built ${actualTargets.join(", ") || "no native target"}; requested ${release.target}`);
  }

  await copyFile(join(productRoot, "LICENSE"), join(payload, "LICENSE"));
  await writeFile(join(payload, "THIRD_PARTY_NOTICES.txt"), thirdPartyNotices(artifact.bundledComponents), "utf8");
  await chmod(join(payload, artifact.entrypoint), 0o755);

  const sbomName = `${payloadName}.cdx.json`;
  const sbomPath = join(release.outdir, sbomName);
  const sbomText = `${JSON.stringify(cyclonedx(release, artifact), null, 2)}\n`;
  await writeFile(join(payload, "SBOM.cdx.json"), sbomText, "utf8");
  await writeFile(sbomPath, sbomText, "utf8");

  const archiveName = `${payloadName}.tar.gz`;
  const archivePath = join(release.outdir, archiveName);
  await writeFile(archivePath, await deterministicTarGzip(payload, payloadName));

  const installerName = `${payloadName}.install.ts`;
  const installerPath = join(release.outdir, installerName);
  await copyFile(join(productRoot, "scripts/release/install-public-release.ts"), installerPath);
  await chmod(installerPath, 0o755);

  const manifestName = `${payloadName}.release.json`;
  const manifestPath = join(release.outdir, manifestName);
  const manifest = {
    contractVersion: "tasq.public-release.v1",
    product: "Tasq Local",
    version: release.version,
    source: {
      repository: "https://github.com/gwendall/tasq",
      commit: release.sourceCommit,
    },
    target: release.target,
    runtime: { name: "bun", minimumVersion: "1.3.0" },
    compatibility: {
      directUpgradeFromMinorLines: 2,
      rollback: "restore-matching-verified-snapshot-and-binary",
    },
    files: [
      { name: archiveName, mediaType: "application/gzip", sha256: await sha256File(archivePath) },
      { name: sbomName, mediaType: "application/vnd.cyclonedx+json", sha256: await sha256File(sbomPath) },
      { name: installerName, mediaType: "application/typescript", sha256: await sha256File(installerPath) },
    ],
    provenance: {
      requiredBuilder: "protected-github-actions-tag-workflow",
      attestation: "github-artifact-attestation",
      localArtifactsPublishable: false,
    },
    clockBoundary: "build receives explicit version, commit and target; no device time is release authority",
  };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  const checksums = await Promise.all([archiveName, installerName, sbomName, manifestName].sort().map(async (name) => (
    `${await sha256File(join(release.outdir, name))}  ${name}`
  )));
  await writeFile(join(release.outdir, `${payloadName}.SHA256SUMS`), `${checksums.join("\n")}\n`, "utf8");
  await rm(work, { recursive: true, force: true });
  console.log(`Built deterministic Tasq public release candidate: ${release.outdir}`);
}

await main();

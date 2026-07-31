#!/usr/bin/env bun

import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

interface NpmPublicationVerification {
  contractVersion: string;
  status: string;
  package: string;
  version: string;
  sourceCommit: string;
  integrity: string;
}

interface PackageManifest {
  name?: unknown;
  version?: unknown;
  gitHead?: unknown;
  repository?: unknown;
  dependencies?: Record<string, string>;
}

function requiredFlag(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index === -1 ? undefined : process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} is required`);
  return value;
}

function repeatedFlag(name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < process.argv.length; index += 1) {
    if (process.argv[index] !== name) continue;
    const value = process.argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
    values.push(value);
  }
  return values;
}

function repositoryUrl(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "url" in value) {
    const url = (value as { url?: unknown }).url;
    return typeof url === "string" ? url : undefined;
  }
  return undefined;
}

async function digest(path: string, algorithm: "sha256" | "sha512"): Promise<string> {
  return createHash(algorithm).update(await readFile(path)).digest(
    algorithm === "sha512" ? "base64" : "hex",
  );
}

async function packageManifest(tarball: string): Promise<PackageManifest> {
  const child = Bun.spawn(["tar", "-xOf", tarball, "package/package.json"], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(`Cannot read package identity from ${basename(tarball)}: ${stderr || stdout}`);
  }
  return JSON.parse(stdout) as PackageManifest;
}

async function main(): Promise<void> {
  const packagesDirectory = resolve(requiredFlag("--packages-dir"));
  const verificationDirectory = resolve(requiredFlag("--verification-dir"));
  const version = requiredFlag("--version");
  const sourceCommit = requiredFlag("--source-commit");
  const out = resolve(requiredFlag("--out"));
  const expectedPackages = repeatedFlag("--expected-package").sort();

  if (
    !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/.test(version)
  ) {
    throw new Error("version must be a valid SemVer");
  }
  if (!/^[a-f0-9]{40}$/.test(sourceCommit)) {
    throw new Error("source commit must be a lowercase 40-character Git commit");
  }
  if (
    expectedPackages.length === 0 ||
    new Set(expectedPackages).size !== expectedPackages.length ||
    expectedPackages.some((name) => !/^@tasq-run\/[a-z0-9-]+$/.test(name))
  ) {
    throw new Error("expected packages must be a unique non-empty @tasq-run/* set");
  }

  const verificationFiles = (await readdir(verificationDirectory))
    .filter((name) => name.endsWith(".npm-publication.json"))
    .sort();
  const verifications = new Map<string, NpmPublicationVerification>();
  for (const filename of verificationFiles) {
    const verification = JSON.parse(
      await readFile(join(verificationDirectory, filename), "utf8"),
    ) as NpmPublicationVerification;
    if (
      verification.contractVersion !== "tasq.npm-publication-verification.v1" ||
      verification.status !== "published" ||
      !expectedPackages.includes(verification.package) ||
      verification.version !== version ||
      verification.sourceCommit !== sourceCommit ||
      !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(verification.integrity)
    ) {
      throw new Error(`Invalid npm publication verification: ${filename}`);
    }
    if (verifications.has(verification.package)) {
      throw new Error(`Duplicate npm publication verification: ${verification.package}`);
    }
    verifications.set(verification.package, verification);
  }

  const tarballs = (await readdir(packagesDirectory))
    .filter((name) => name.endsWith(".tgz"))
    .sort();
  const artifacts: Array<{
    name: string;
    version: string;
    filename: string;
    sha256: string;
    dependencies: string[];
  }> = [];
  for (const filename of tarballs) {
    const path = join(packagesDirectory, filename);
    const manifest = await packageManifest(path);
    if (
      typeof manifest.name !== "string" ||
      !expectedPackages.includes(manifest.name) ||
      manifest.version !== version ||
      manifest.gitHead !== sourceCommit ||
      repositoryUrl(manifest.repository) !== "git+https://github.com/gwendall/tasq.git"
    ) {
      throw new Error(`Downloaded tarball identity drift: ${filename}`);
    }
    if (artifacts.some((artifact) => artifact.name === manifest.name)) {
      throw new Error(`Duplicate downloaded package: ${manifest.name}`);
    }
    const verification = verifications.get(manifest.name);
    if (!verification) {
      throw new Error(`Missing npm publication verification: ${manifest.name}`);
    }
    const integrity = `sha512-${await digest(path, "sha512")}`;
    if (verification.integrity !== integrity) {
      throw new Error(`Downloaded tarball integrity differs from registry: ${manifest.name}`);
    }
    artifacts.push({
      name: manifest.name,
      version,
      filename,
      sha256: await digest(path, "sha256"),
      dependencies: Object.keys(manifest.dependencies ?? {})
        .filter((name) => name.startsWith("@tasq-run/"))
        .sort(),
    });
  }
  artifacts.sort((left, right) => left.name.localeCompare(right.name));
  if (
    artifacts.length !== expectedPackages.length ||
    artifacts.some((artifact, index) => artifact.name !== expectedPackages[index])
  ) {
    throw new Error("Downloaded tarball set differs from the authorized public package set");
  }
  for (const artifact of artifacts) {
    const missingDependency = artifact.dependencies.find(
      (dependency) => !expectedPackages.includes(dependency),
    );
    if (missingDependency) {
      throw new Error(`${artifact.name} depends on absent public package ${missingDependency}`);
    }
  }

  await writeFile(out, `${JSON.stringify({
    contractVersion: "tasq.public-packages.v1",
    version,
    source: {
      repository: "https://github.com/gwendall/tasq",
      commit: sourceCommit,
    },
    runtime: {
      default: { name: "bun", minimumVersion: "1.3.0" },
      compiledEsm: {
        packages: [
          "@tasq-run/client",
          "@tasq-run/core",
          "@tasq-run/schema",
          "@tasq-run/extension-sdk",
        ].filter((name) => expectedPackages.includes(name)),
        supported: [
          { name: "bun", minimumVersion: "1.3.0" },
          { name: "node", minimumVersion: "22.0.0" },
        ],
      },
    },
    packages: artifacts,
    provenance: {
      requiredBuilder: "protected-github-actions-tag-workflow",
      npmPublishing: "trusted-publishing-oidc",
      localArtifactsPublishable: false,
      artifactOrigin: "verified_npm_registry_download",
      registryIdentityAndIntegrityVerified: true,
    },
    clockBoundary: "explicit inputs only; no device time is package authority",
  }, null, 2)}\n`, "utf8");
}

await main();

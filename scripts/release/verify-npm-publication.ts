#!/usr/bin/env bun

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

type RegistryMetadata = {
  name?: unknown;
  version?: unknown;
  gitHead?: unknown;
  repository?: unknown;
  dist?: {
    integrity?: unknown;
    tarball?: unknown;
  };
};

export type VerifiedNpmPublication = {
  contractVersion: "tasq.npm-publication-verification.v1";
  status: "published";
  package: string;
  version: string;
  sourceCommit: string;
  integrity: string;
  tarball: string;
};

function fail(message: string): never {
  throw new Error(`npm publication verification rejected: ${message}`);
}

function repositoryUrl(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "url" in value) {
    const url = (value as { url?: unknown }).url;
    return typeof url === "string" ? url : undefined;
  }
  return undefined;
}

export function verifyNpmPublication(input: {
  metadata: RegistryMetadata;
  packageName: string;
  version: string;
  sourceCommit: string;
  candidateBytes: Uint8Array;
}): VerifiedNpmPublication {
  const { metadata, packageName, version, sourceCommit, candidateBytes } = input;
  if (!/^@tasq\/[a-z0-9-]+$/.test(packageName)) fail(`unexpected package ${packageName}`);
  if (!/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    fail(`invalid SemVer ${version}`);
  }
  if (!/^[a-f0-9]{40}$/.test(sourceCommit)) fail("source commit must be a lowercase 40-character Git commit");
  if (metadata.name !== packageName) fail(`registry name drift for ${packageName}`);
  if (metadata.version !== version) fail(`registry version drift for ${packageName}`);
  if (metadata.gitHead !== sourceCommit) fail(`registry source commit drift for ${packageName}`);
  if (repositoryUrl(metadata.repository) !== "git+https://github.com/gwendall/tasq.git") {
    fail(`registry repository drift for ${packageName}`);
  }
  const integrity = `sha512-${createHash("sha512").update(candidateBytes).digest("base64")}`;
  if (metadata.dist?.integrity !== integrity) fail(`registry tarball integrity drift for ${packageName}`);
  const registryTarball = metadata.dist?.tarball;
  if (typeof registryTarball !== "string" || !registryTarball.startsWith("https://registry.npmjs.org/")) {
    fail(`registry tarball URL drift for ${packageName}`);
  }
  return {
    contractVersion: "tasq.npm-publication-verification.v1",
    status: "published",
    package: packageName,
    version,
    sourceCommit,
    integrity,
    tarball: registryTarball,
  };
}

function requiredFlag(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index === -1 ? undefined : process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} is required`);
  return value;
}

async function main(): Promise<void> {
  const packageName = requiredFlag("--package");
  const version = requiredFlag("--version");
  const sourceCommit = requiredFlag("--source-commit");
  const tarball = requiredFlag("--tarball");
  const registry = new URL(process.env.npm_config_registry ?? "https://registry.npmjs.org/");
  const endpoint = new URL(`${encodeURIComponent(packageName)}/${encodeURIComponent(version)}`, registry);
  const response = await fetch(endpoint, { redirect: "error" });
  if (response.status === 404 && process.argv.includes("--allow-missing")) {
    process.stdout.write(`${JSON.stringify({
      contractVersion: "tasq.npm-publication-verification.v1",
      status: "missing",
      package: packageName,
      version,
      sourceCommit,
    })}\n`);
    return;
  }
  if (!response.ok) fail(`registry returned HTTP ${response.status} for ${packageName}@${version}`);
  const certificate = verifyNpmPublication({
    metadata: await response.json() as RegistryMetadata,
    packageName,
    version,
    sourceCommit,
    candidateBytes: await readFile(tarball),
  });
  process.stdout.write(`${JSON.stringify(certificate)}\n`);
}

if (import.meta.main) await main();

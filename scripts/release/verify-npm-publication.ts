#!/usr/bin/env bun

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { systemClock } from "@tasq-run/schema";

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
  if (!/^@tasq-run\/[a-z0-9-]+$/.test(packageName)) fail(`unexpected package ${packageName}`);
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

/**
 * Fetch a published version's metadata, waiting for the registry to finish
 * processing it.
 *
 * npm now acknowledges a publish before the version is readable: "Your package
 * is being processed and may take a few minutes to become available". On
 * 2026-09-06 the v0.6.2 release published @tasq-run/cli, asked the registry
 * for it in the same second, got 404, and stopped there with six packages
 * unpublished and the GitHub release skipped; the version was readable a
 * minute later. A 404 right after a publish is "not yet", up to a deadline.
 * A 404 on the pre-check (`--allow-missing`) is the answer "not published",
 * and must not wait.
 */
export async function fetchPublishedMetadata(input: {
  endpoint: URL;
  waitSeconds: number;
  /** First delay between attempts; doubles up to a minute. Tests shrink it. */
  initialDelayMs?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}): Promise<{ status: "ok"; metadata: RegistryMetadata } | { status: "missing"; attempts: number } | { status: "error"; httpStatus: number }> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const sleep = input.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = input.now ?? (() => systemClock.now());
  const deadline = now() + input.waitSeconds * 1000;
  let attempts = 0;
  let delayMs = input.initialDelayMs ?? 5_000;
  while (true) {
    attempts++;
    const response = await fetchImpl(input.endpoint, { redirect: "error" });
    if (response.ok) return { status: "ok", metadata: await response.json() as RegistryMetadata };
    const transient = response.status === 404 || response.status >= 500;
    if (!transient || now() >= deadline) {
      return response.status === 404 ? { status: "missing", attempts } : { status: "error", httpStatus: response.status };
    }
    await sleep(Math.min(delayMs, Math.max(0, deadline - now())));
    delayMs = Math.min(delayMs * 2, 60_000);
  }
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
  const allowMissing = process.argv.includes("--allow-missing");
  const waitFlag = process.argv.indexOf("--wait-seconds");
  const waitSeconds = allowMissing ? 0 : waitFlag === -1 ? 600 : Number(process.argv[waitFlag + 1]);
  if (!Number.isFinite(waitSeconds) || waitSeconds < 0) throw new Error("--wait-seconds must be a non-negative number");
  const delayFlag = process.argv.indexOf("--initial-delay-ms");
  const initialDelayMs = delayFlag === -1 ? 5_000 : Number(process.argv[delayFlag + 1]);
  if (!Number.isFinite(initialDelayMs) || initialDelayMs < 0) throw new Error("--initial-delay-ms must be a non-negative number");
  const fetched = await fetchPublishedMetadata({ endpoint, waitSeconds, initialDelayMs });
  if (fetched.status === "missing" && allowMissing) {
    process.stdout.write(`${JSON.stringify({
      contractVersion: "tasq.npm-publication-verification.v1",
      status: "missing",
      package: packageName,
      version,
      sourceCommit,
    })}\n`);
    return;
  }
  if (fetched.status === "missing") {
    fail(`registry still returned HTTP 404 for ${packageName}@${version} after ${fetched.attempts} attempt(s) over ${waitSeconds}s`);
  }
  if (fetched.status === "error") fail(`registry returned HTTP ${fetched.httpStatus} for ${packageName}@${version}`);
  const certificate = verifyNpmPublication({
    metadata: fetched.metadata,
    packageName,
    version,
    sourceCommit,
    candidateBytes: await readFile(tarball),
  });
  process.stdout.write(`${JSON.stringify(certificate)}\n`);
}

if (import.meta.main) await main();

#!/usr/bin/env bun

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

type Tq616CertificationProgram = {
  state: "prepared_not_authorized" | "authorized";
  workflow: string;
  environment: string;
  version: string | null;
  sourceBinding: "protected_immutable_version_tag_runtime_commit";
  decision: "pending" | "go";
  authorizedBy: string | null;
  authorizedAt: string | null;
  historicalIncompatibleReleases: Array<{
    version: string;
    sourceCommit: string;
    reason: string;
  }>;
};

type ReleasePolicy = {
  releaseAuthorization: {
    state: string;
    version: string;
    decision: string;
    authorizedBy: string;
  };
  certificationPrograms?: {
    tq616SignedStatements?: Tq616CertificationProgram;
  };
};

function fail(message: string): never {
  throw new Error(`TQ-616 release eligibility rejected: ${message}`);
}

function flags(allowed: readonly string[]): Map<string, string> {
  const parsed = new Map<string, string>();
  for (let index = 2; index < process.argv.length; index += 2) {
    const name = process.argv[index];
    const value = process.argv[index + 1];
    if (!name?.startsWith("--") || !allowed.includes(name)) {
      fail(`unknown flag ${name ?? ""}`);
    }
    if (parsed.has(name)) fail(`duplicate flag ${name}`);
    if (!value || value.startsWith("--")) fail(`${name} requires a value`);
    parsed.set(name, value);
  }
  return parsed;
}

function calendarDate(value: string | null): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value ?? "");
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1]!;
}

export function verifyTq616ReleaseEligibility(input: {
  policy: ReleasePolicy;
  version: string;
  sourceCommit: string;
  repository: string;
}): Record<string, unknown> {
  const { policy, version, sourceCommit, repository } = input;
  if (repository !== "gwendall/tasq" && repository !== "https://github.com/gwendall/tasq") {
    fail("repository identity drift");
  }
  if (!/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(version)) {
    fail(`invalid stable SemVer ${version}`);
  }
  if (!/^[a-f0-9]{40}$/.test(sourceCommit)) fail("source commit is not immutable");

  const release = policy.releaseAuthorization;
  if (
    release?.state !== "authorized" ||
    release.version !== version ||
    release.decision !== "go" ||
    release.authorizedBy !== "@gwendall"
  ) {
    fail("base release is not explicitly authorized for the exact version");
  }

  const program = policy.certificationPrograms?.tq616SignedStatements;
  if (!program) fail("missing tq616SignedStatements certification program");
  if (program.workflow !== "certify-published-release.yml") fail("workflow identity drift");
  if (program.environment !== "release") fail("protected environment drift");
  if (program.sourceBinding !== "protected_immutable_version_tag_runtime_commit") {
    fail("source binding drift");
  }
  if (!Array.isArray(program.historicalIncompatibleReleases)) {
    fail("historical incompatibility registry is missing");
  }

  const historicalVersions = new Set<string>();
  for (const historical of program.historicalIncompatibleReleases) {
    if (
      !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(historical.version) ||
      !/^[a-f0-9]{40}$/.test(historical.sourceCommit) ||
      historical.reason.trim().length < 20
    ) {
      fail("historical incompatibility entry is invalid");
    }
    if (historicalVersions.has(historical.version)) {
      fail(`duplicate historical incompatibility entry for ${historical.version}`);
    }
    historicalVersions.add(historical.version);
  }
  const historical = program.historicalIncompatibleReleases.find(
    (entry) => entry.version === version && entry.sourceCommit === sourceCommit,
  );
  if (historical) {
    return {
      contractVersion: "tasq.tq616-release-eligibility.v1",
      status: "not_applicable_historical_release",
      version,
      sourceCommit,
      replayRequired: false,
      reason: historical.reason,
      gatesClosed: [],
      publicSupportClaim: false,
    };
  }
  if (historicalVersions.has(version)) {
    fail(`historical release ${version} source commit drift`);
  }

  if (
    program.state !== "authorized" ||
    program.decision !== "go" ||
    program.version !== version ||
    program.authorizedBy !== "@gwendall" ||
    !calendarDate(program.authorizedAt)
  ) {
    fail("exact release is not authorized as TQ-616 compatible");
  }
  return {
    contractVersion: "tasq.tq616-release-eligibility.v1",
    status: "authorized_compatible_release",
    version,
    sourceCommit,
    sourceTag: `v${version}`,
    sourceBinding: program.sourceBinding,
    replayRequired: true,
    workflow: program.workflow,
    environment: program.environment,
    authorizedBy: program.authorizedBy,
    gatesClosed: [],
    publicSupportClaim: false,
  };
}

if (import.meta.main) {
  const input = flags(["--policy", "--version", "--source-commit", "--repository"]);
  const required = (name: string): string => {
    const value = input.get(name);
    if (!value) fail(`${name} is required`);
    return value;
  };
  const policy = JSON.parse(await readFile(
    input.get("--policy") ??
      resolve(import.meta.dir, "../../docs/releases/PUBLIC_RELEASE_POLICY.json"),
    "utf8",
  )) as ReleasePolicy;
  process.stdout.write(`${JSON.stringify(verifyTq616ReleaseEligibility({
    policy,
    version: required("--version"),
    sourceCommit: required("--source-commit"),
    repository: required("--repository"),
  }))}\n`);
}

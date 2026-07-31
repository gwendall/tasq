#!/usr/bin/env bun

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

type BootstrapAuthorization = {
  state: "prepared_not_authorized" | "authorized";
  coordinate: string;
  workflow: string;
  environment: string;
  sourceRef: string;
  sourceBinding: string;
  version: string;
  distTag: string;
  decision: "pending" | "go";
  authorizedBy: string | null;
  authorizedAt: string | null;
};

type Policy = {
  contractVersion: string;
  identity: {
    canonicalRepository: string;
    npmScope: string;
  };
  npmClientBootstrap?: BootstrapAuthorization;
};

function fail(message: string): never {
  throw new Error(`npm client bootstrap authorization rejected: ${message}`);
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

function flags(allowed: readonly string[]): Map<string, string> {
  const parsed = new Map<string, string>();
  for (let index = 2; index < process.argv.length; index += 2) {
    const name = process.argv[index];
    const value = process.argv[index + 1];
    if (!name?.startsWith("--") || !allowed.includes(name)) fail(`unknown flag ${name ?? ""}`);
    if (parsed.has(name)) fail(`duplicate flag ${name}`);
    if (!value || value.startsWith("--")) fail(`${name} requires a value`);
    parsed.set(name, value);
  }
  return parsed;
}

export function verifyNpmClientBootstrapAuthorization(input: {
  policy: Policy;
  version: string;
  sourceCommit: string;
  repository: string;
}): Record<string, unknown> {
  const { policy, version, sourceCommit, repository } = input;
  if (repository !== "gwendall/tasq") fail("repository identity drift");
  if (!/^[a-f0-9]{40}$/.test(sourceCommit)) fail("source commit is not immutable");
  if (policy.contractVersion !== "tasq.public-release-policy.v1") fail("policy contract drift");
  if (policy.identity?.canonicalRepository !== "https://github.com/gwendall/tasq") {
    fail("canonical repository drift");
  }
  if (policy.identity?.npmScope !== "@tasq-run") fail("npm scope drift");

  const authorization = policy.npmClientBootstrap;
  if (!authorization) fail("missing npmClientBootstrap policy");
  if (authorization.coordinate !== "@tasq-run/client") fail("coordinate drift");
  if (authorization.workflow !== "bootstrap-npm-client.yml") fail("workflow identity drift");
  if (authorization.environment !== "release") fail("protected environment drift");
  if (authorization.sourceRef !== "refs/heads/main") fail("source ref drift");
  if (authorization.sourceBinding !== "protected_main_runtime_commit") fail("source binding drift");
  if (authorization.version !== version) fail(`authorized version ${authorization.version} does not match ${version}`);
  if (authorization.distTag !== "alpha-bootstrap") fail("dist-tag drift");
  if (authorization.state !== "authorized") fail(`authorization state is ${authorization.state}`);
  if (authorization.decision !== "go") fail(`authorization decision is ${authorization.decision}`);
  if (authorization.authorizedBy !== "@gwendall") fail("release owner did not authorize bootstrap");
  if (!calendarDate(authorization.authorizedAt)) fail("authorization date is not explicit");

  return {
    contractVersion: "tasq.npm-client-bootstrap-authorization.v1",
    package: authorization.coordinate,
    version,
    distTag: authorization.distTag,
    sourceCommit,
    sourceRef: authorization.sourceRef,
    sourceBinding: authorization.sourceBinding,
    workflow: authorization.workflow,
    environment: authorization.environment,
    authorizedBy: authorization.authorizedBy,
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
  )) as Policy;
  process.stdout.write(`${JSON.stringify(verifyNpmClientBootstrapAuthorization({
    policy,
    version: required("--version"),
    sourceCommit: required("--source-commit"),
    repository: required("--repository"),
  }))}\n`);
}

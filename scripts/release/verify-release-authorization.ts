#!/usr/bin/env bun

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  type ReleasePolicy,
  verifyReleaseAuthorization,
} from "./release-authorization";

function requiredFlag(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index === -1 ? undefined : process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} is required`);
  return value;
}

function optionalFlag(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  const value = index === -1 ? undefined : process.argv[index + 1];
  if (value?.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

const policy = JSON.parse(await readFile(
  optionalFlag("--policy") ??
    resolve(import.meta.dir, "../../docs/releases/PUBLIC_RELEASE_POLICY.json"),
  "utf8",
)) as ReleasePolicy;

const certificate = verifyReleaseAuthorization({
  policy,
  version: requiredFlag("--version"),
  sourceCommit: requiredFlag("--source-commit"),
  repository: requiredFlag("--repository"),
});

process.stdout.write(`${JSON.stringify(certificate)}\n`);

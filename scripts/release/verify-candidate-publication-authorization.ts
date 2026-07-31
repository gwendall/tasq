#!/usr/bin/env bun

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  type CandidatePublication,
  type ReleasePolicy,
  verifyCandidatePublicationAuthorization,
} from "./release-authorization";

function flags(allowed: readonly string[]): Map<string, string> {
  const parsed = new Map<string, string>();
  for (let index = 2; index < process.argv.length; index += 2) {
    const name = process.argv[index];
    const value = process.argv[index + 1];
    if (!name?.startsWith("--") || !allowed.includes(name)) {
      throw new Error(`unknown flag ${name ?? ""}`);
    }
    if (parsed.has(name)) throw new Error(`duplicate flag ${name}`);
    if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
    parsed.set(name, value);
  }
  return parsed;
}

const input = flags(["--policy", "--surface", "--version", "--source-commit", "--repository"]);
const required = (name: string): string => {
  const value = input.get(name);
  if (!value) throw new Error(`${name} is required`);
  return value;
};
const surface = required("--surface");
if (!["serverImage", "pythonWheel", "remoteTypeScriptClient"].includes(surface)) {
  throw new Error(`unknown --surface ${surface}`);
}
const policy = JSON.parse(await readFile(
  input.get("--policy") ??
    resolve(import.meta.dir, "../../docs/releases/PUBLIC_RELEASE_POLICY.json"),
  "utf8",
)) as ReleasePolicy;
const certificate = verifyCandidatePublicationAuthorization({
  policy,
  surface: surface as CandidatePublication,
  version: required("--version"),
  sourceCommit: required("--source-commit"),
  repository: required("--repository"),
});
process.stdout.write(`${JSON.stringify(certificate)}\n`);

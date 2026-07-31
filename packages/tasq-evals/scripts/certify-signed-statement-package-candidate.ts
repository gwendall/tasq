#!/usr/bin/env bun

import { createHash } from "node:crypto";
import {
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve } from "node:path";

interface PackageArtifact {
  name: string;
  version: string;
  filename: string;
  sha256: string;
}

interface CandidateRelease {
  contractVersion: string;
  version: string;
  source: { repository: string; commit: string };
  packages: PackageArtifact[];
  provenance: {
    localArtifactsPublishable: boolean;
    artifactOrigin?: string;
    registryIdentityAndIntegrityVerified?: boolean;
  };
}

interface ProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

const evalRoot = resolve(import.meta.dir, "..");
const signaturePackages = [
  "@tasq-run/core",
  "@tasq-run/extension-sdk",
  "@tasq-run/schema",
] as const;

function requiredFlag(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index === -1 ? undefined : process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} is required`);
  return value;
}

async function run(
  command: string[],
  cwd: string,
  env: Record<string, string> = {},
): Promise<ProcessResult> {
  const child = Bun.spawn(command, {
    cwd,
    env: { ...process.env, ...env },
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

function requireSuccess(result: ProcessResult, label: string): string {
  if (result.exitCode !== 0) {
    throw new Error(`${label} failed (${result.exitCode}):\n${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

async function sha256(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function inventory(root: string): Promise<Array<{ path: string; bytes: number; sha256: string }>> {
  const output: Array<{ path: string; bytes: number; sha256: string }> = [];
  async function visit(directory: string): Promise<void> {
    for (const name of (await readdir(directory)).sort()) {
      const path = join(directory, name);
      const info = await lstat(path);
      if (info.isDirectory()) {
        await visit(path);
      } else if (info.isFile()) {
        output.push({
          path: relative(root, path),
          bytes: info.size,
          sha256: await sha256(path),
        });
      } else {
        throw new Error(`Unsupported installed package entry: ${path}`);
      }
    }
  }
  await visit(root);
  return output;
}

async function readCandidateRelease(packagesDirectory: string): Promise<CandidateRelease> {
  const releaseFiles = (await readdir(packagesDirectory))
    .filter((name) => /^tasq-packages-v.+\.release\.json$/.test(name));
  if (releaseFiles.length !== 1) {
    throw new Error(`Expected exactly one candidate package release manifest, found ${releaseFiles.length}`);
  }
  const release = JSON.parse(
    await readFile(join(packagesDirectory, releaseFiles[0]!), "utf8"),
  ) as CandidateRelease;
  if (release.contractVersion !== "tasq.public-packages.v1") {
    throw new Error(`Unsupported candidate package contract: ${release.contractVersion}`);
  }
  if (release.provenance.localArtifactsPublishable !== false) {
    throw new Error("Candidate manifest must mark local artifacts as non-publishable");
  }
  if (
    release.provenance.artifactOrigin !== undefined &&
    release.provenance.artifactOrigin !== "verified_npm_registry_download"
  ) {
    throw new Error(`Unsupported candidate artifact origin: ${release.provenance.artifactOrigin}`);
  }
  if (
    release.provenance.artifactOrigin === "verified_npm_registry_download" &&
    release.provenance.registryIdentityAndIntegrityVerified !== true
  ) {
    throw new Error("Downloaded npm artifacts require verified registry identity and integrity");
  }
  if (!/^[a-f0-9]{40}$/.test(release.source.commit)) {
    throw new Error("Candidate manifest source commit is not immutable");
  }
  return release;
}

const runtimeProgram = `
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import {
  SignedStatementBundleV1,
  SignedStatementPayloadV1,
  canonicalizeEffectJson,
} from "@tasq-run/schema";
import {
  ED25519_STATEMENT_PROFILE_URI,
  signPurposeBoundStatement,
  verifyPurposeBoundStatement,
} from "@tasq-run/extension-sdk";
import {
  SIGNED_STATEMENT_PURPOSES,
  prepareSignedStatementAcceptance,
} from "@tasq-run/core";

const purpose = SIGNED_STATEMENT_PURPOSES.artifact_authorship;
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const publicMaterial = {
  format: "jwk-okp-ed25519",
  x: publicKey.export({ format: "jwk" }).x,
};
const digest = (value) =>
  "sha256:" + createHash("sha256").update(canonicalizeEffectJson(value)).digest("hex");
const credential = {
  credentialId: "candidate-credential",
  workspaceId: "candidate/workspace",
  principalId: "principal:candidate",
  profileUri: ED25519_STATEMENT_PROFILE_URI,
  profileVersion: 1,
  publicMaterial,
  publicMaterialDigest: digest(publicMaterial),
  trustRootDigest: "sha256:" + "a".repeat(64),
  isolationClass: "isolated_process",
  status: "active",
  revision: 1,
  validFrom: "2026-07-24T00:00:00.000Z",
  enrollmentMethod: "clean-room-proof-of-possession",
  enrollmentEvidenceDigest: "sha256:" + "b".repeat(64),
};
const payload = SignedStatementPayloadV1.parse({
  contractVersion: "tasq.signed-statement.v1",
  statementId: "candidate-statement",
  workspaceId: credential.workspaceId,
  audience: "https://candidate.tasq.example/",
  issuerPrincipalId: credential.principalId,
  credentialId: credential.credentialId,
  purpose: { uri: purpose, version: 1 },
  subject: {
    typeUri: "https://schemas.tasq.dev/subjects/artifact/v1",
    id: "candidate-artifact",
    digest: "sha256:" + "c".repeat(64),
  },
  nonce: "candidate-nonce",
  issuedAt: "2026-07-24T09:00:00.000Z",
  expiresAt: "2026-07-24T10:00:00.000Z",
  metadata: {},
});
const bundle = SignedStatementBundleV1.parse(await signPurposeBoundStatement(payload, {
  credentialId: credential.credentialId,
  profileUri: ED25519_STATEMENT_PROFILE_URI,
  profileVersion: 1,
  allowedPurposeUris: [purpose],
  signStatement: ({ preAuthenticationEncoding }) =>
    sign(null, preAuthenticationEncoding, privateKey),
}));
const verified = await verifyPurposeBoundStatement({
  bundle,
  expectedWorkspaceId: payload.workspaceId,
  expectedAudience: payload.audience,
  acceptanceTime: "2026-07-24T09:30:00.000Z",
  acceptedTrustRootDigests: [credential.trustRootDigest],
  resolveCredential: () => credential,
});
const changed = structuredClone(bundle);
changed.payload = changed.payload.slice(0, -1) +
  (changed.payload.endsWith("A") ? "B" : "A");
const rejected = await verifyPurposeBoundStatement({
  bundle: changed,
  expectedWorkspaceId: payload.workspaceId,
  expectedAudience: payload.audience,
  acceptanceTime: "2026-07-24T09:30:00.000Z",
  acceptedTrustRootDigests: [credential.trustRootDigest],
  resolveCredential: () => credential,
});
if (verified.outcome !== "valid" || verified.reasonCode !== "valid_at_acceptance") {
  throw new Error("installed signed-statement verifier rejected a valid statement");
}
if (rejected.outcome !== "invalid" || rejected.reasonCode !== "signature_invalid") {
  throw new Error("installed signed-statement verifier accepted altered bytes");
}
const purposeCount = Object.keys(SIGNED_STATEMENT_PURPOSES).length;
if (purposeCount !== 6 || typeof prepareSignedStatementAcceptance !== "function") {
  throw new Error("installed Core signed-statement API is incomplete");
}
process.stdout.write(JSON.stringify({
  contractVersion: "tasq.signed-statement-installed-runtime.v1",
  runtime: process.env.TASQ_CANDIDATE_RUNTIME,
  validStatement: "passed",
  alteredBytes: "rejected",
  publicSchema: "parsed",
  corePurposeCount: purposeCount,
  signatureIsAuthority: false,
}));
`;

async function main(): Promise<void> {
  const packagesDirectory = resolve(requiredFlag("--packages-dir"));
  const release = await readCandidateRelease(packagesDirectory);
  const downloadedRegistryArtifacts =
    release.provenance.artifactOrigin === "verified_npm_registry_download";
  const artifacts = new Map(release.packages.map((artifact) => [artifact.name, artifact]));
  if (artifacts.size !== release.packages.length ||
    release.packages.some((artifact) => !artifact.name.startsWith("@tasq-run/"))) {
    throw new Error("Candidate manifest contains duplicate or non-public package identities");
  }
  if (new Set(release.packages.map((artifact) => artifact.filename)).size !== release.packages.length) {
    throw new Error("Candidate manifest contains duplicate tarball filenames");
  }

  for (const artifact of release.packages) {
    if (artifact.version !== release.version) {
      throw new Error(`Candidate package version differs from release identity: ${artifact.name}`);
    }
    if (basename(artifact.filename) !== artifact.filename || !artifact.filename.endsWith(".tgz")) {
      throw new Error(`Candidate package filename is not a local tarball: ${artifact.name}`);
    }
    const archivePath = join(packagesDirectory, artifact.filename);
    if (await sha256(archivePath) !== artifact.sha256) {
      throw new Error(`Candidate tarball digest mismatch: ${artifact.name}`);
    }
  }
  for (const name of signaturePackages) {
    if (!artifacts.has(name)) throw new Error(`Candidate release omits ${name}`);
  }

  const cleanRoom = await mkdtemp(join(tmpdir(), "tasq-tq616-package-candidate-"));
  try {
    const consumer = join(cleanRoom, "consumer");
    const extracted = join(cleanRoom, "extracted");
    await Promise.all([mkdir(consumer, { recursive: true }), mkdir(extracted, { recursive: true })]);
    await writeFile(join(consumer, "package.json"), `${JSON.stringify({
      private: true,
      type: "module",
      dependencies: Object.fromEntries(signaturePackages.map((name) => {
        const artifact = artifacts.get(name)!;
        return [name, `file:${join(packagesDirectory, artifact.filename)}`];
      })),
    }, null, 2)}\n`, "utf8");

    requireSuccess(await run([
      "npm",
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--no-package-lock",
    ], consumer), "clean-room candidate install");

    const installedPackages: Array<{ name: string; version: string; fileCount: number }> = [];
    for (const name of signaturePackages) {
      const artifact = artifacts.get(name)!;
      const archiveRoot = join(extracted, basename(artifact.filename, ".tgz"));
      await mkdir(archiveRoot, { recursive: true });
      requireSuccess(
        await run(["tar", "-xzf", join(packagesDirectory, artifact.filename), "-C", archiveRoot], cleanRoom),
        `extract ${name}`,
      );
      const expectedRoot = join(archiveRoot, "package");
      const installedRoot = join(consumer, "node_modules", ...name.split("/"));
      const [expectedInventory, installedInventory] = await Promise.all([
        inventory(expectedRoot),
        inventory(installedRoot),
      ]);
      if (JSON.stringify(installedInventory) !== JSON.stringify(expectedInventory)) {
        throw new Error(`Installed package bytes differ from candidate tarball: ${name}`);
      }
      const manifest = JSON.parse(await readFile(join(installedRoot, "package.json"), "utf8")) as {
        name: string;
        version: string;
        gitHead: string;
      };
      if (manifest.name !== name ||
        manifest.version !== release.version ||
        manifest.gitHead !== release.source.commit) {
        throw new Error(`Installed package identity differs from candidate manifest: ${name}`);
      }
      installedPackages.push({ name, version: manifest.version, fileCount: installedInventory.length });
    }

    const runtimePath = join(consumer, "verify-installed-signed-statements.mjs");
    await writeFile(runtimePath, runtimeProgram, "utf8");
    const node = JSON.parse(requireSuccess(
      await run(["node", runtimePath], consumer, { TASQ_CANDIDATE_RUNTIME: "node" }),
      "Node installed-package verification",
    ));
    const bun = JSON.parse(requireSuccess(
      await run([process.execPath, "run", runtimePath], consumer, { TASQ_CANDIDATE_RUNTIME: "bun" }),
      "Bun installed-package verification",
    ));

    const pythonScript = join(cleanRoom, "verify-signed-statement-vector.py");
    const pythonVector = join(cleanRoom, "signed-statement-vector.json");
    await Promise.all([
      writeFile(
        pythonScript,
        await readFile(join(evalRoot, "fixtures/verify-signed-statement-vector.py"), "utf8"),
        "utf8",
      ),
      writeFile(
        pythonVector,
        await readFile(join(evalRoot, "fixtures/signed-statement-vector.json"), "utf8"),
        "utf8",
      ),
    ]);
    const python = JSON.parse(requireSuccess(
      await run(["python3", pythonScript, pythonVector], cleanRoom),
      "independent Python vector verification",
    ));

    process.stdout.write(`${JSON.stringify({
      contractVersion: downloadedRegistryArtifacts
        ? "tasq.tq616-protected-downloaded-clean-room.v1"
        : "tasq.tq616-package-candidate-clean-room.v1",
      status: downloadedRegistryArtifacts
        ? "passed_protected_downloaded_artifact_replay"
        : "passed_local_candidate_only",
      artifact: {
        releaseContract: release.contractVersion,
        version: release.version,
        sourceCommit: release.source.commit,
        tarballCount: release.packages.length,
        allDeclaredTarballDigestsVerified: true,
        localArtifactsPublishable: false,
        artifactOrigin: release.provenance.artifactOrigin ?? "local_candidate",
        exactDownloadedBytes: downloadedRegistryArtifacts,
        registryIdentityAndIntegrityVerified:
          release.provenance.registryIdentityAndIntegrityVerified === true,
      },
      installedBytes: {
        packages: installedPackages,
        extractedAndInstalledInventoriesMatch: true,
      },
      runtimes: { node, bun, python },
      publicSupportClaim: false,
      remainingExternalGate: downloadedRegistryArtifacts
        ? ["unbriefed_agent_and_operator_trial"]
        : [
          "protected_release_workflow",
          "exact_downloaded_bytes",
          "supported_macos_arm64_and_linux_x64",
          "node_bun_python_clean_room",
          "unbriefed_agent_and_operator_trial",
        ],
    })}\n`);
  } finally {
    await rm(cleanRoom, { recursive: true, force: true });
  }
}

await main();

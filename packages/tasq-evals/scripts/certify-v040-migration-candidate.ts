#!/usr/bin/env bun

import { createClient } from "@libsql/client";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import {
  currentTarget,
  directoryManifest,
  sha256File,
  verifyReleaseEnvelope,
  type PinnedRelease,
  type Tq608Target,
  type VerifiedReleaseEnvelope,
} from "../tq608-v040-migration-contract";

interface Matrix {
  contractVersion: string;
  candidate: {
    version: string;
    storeFormat: number;
    publishedReplayPassed: boolean;
    publicSupportClaim: boolean;
  };
  sourceReleases: PinnedRelease[];
  requiredAssertions: string[];
  protectedEvidenceRequired: {
    targets: Tq608Target[];
    sourceReleaseAttestations: boolean;
    candidateSourceCommitBinding: boolean;
    candidateArtifactAttestationsAfterPublication: boolean;
    publishedV040Replay: string;
  };
}

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function flag(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index === -1 ? undefined : process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} is required`);
  return value;
}

function optionalFlag(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  const value = index === -1 ? undefined : process.argv[index + 1];
  if (index !== -1 && (!value || value.startsWith("--"))) throw new Error(`${name} requires a value`);
  return value;
}

async function run(
  executable: string,
  args: string[],
  options: { home?: string; cwd?: string } = {},
): Promise<CommandResult> {
  const child = Bun.spawn([executable, ...args], {
    cwd: options.cwd ?? tmpdir(),
    env: {
      PATH: process.env.PATH ?? "",
      ...(options.home === undefined ? {} : { TASQ_HOME: options.home }),
    },
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

async function ok(
  executable: string,
  args: string[],
  options: { home?: string; cwd?: string } = {},
): Promise<string> {
  const result = await run(executable, args, options);
  if (result.exitCode !== 0 || result.stderr !== "") {
    throw new Error(
      `${executable} ${args.join(" ")} failed (${result.exitCode}): ${result.stderr || result.stdout}`,
    );
  }
  return result.stdout;
}

function json(text: string, label: string): Record<string, any> {
  try {
    return JSON.parse(text) as Record<string, any>;
  } catch {
    throw new Error(`${label} did not return one JSON document`);
  }
}

function problem(result: CommandResult): Record<string, any> {
  for (const text of [result.stdout, result.stderr]) {
    if (text.trim() === "") continue;
    try {
      return JSON.parse(text) as Record<string, any>;
    } catch {
      // Try the other stream so a non-JSON diagnostic can never mask JSON.
    }
  }
  throw new Error("older binary refusal did not return a typed JSON problem");
}

async function install(release: VerifiedReleaseEnvelope, prefix: string): Promise<string> {
  await chmod(release.installer, 0o755);
  const installed = json(await ok(release.installer, [
    "install",
    "--archive", release.archive,
    "--manifest", release.manifest,
    "--checksums", release.checksums,
    "--prefix", prefix,
  ]), `${release.version} installer`);
  if (
    installed.contractVersion !== "tasq.lifecycle-result.v1" ||
    installed.status !== "installed" ||
    installed.version !== release.version ||
    installed.dataDisposition !== "external-not-managed"
  ) {
    throw new Error(`unexpected install result for ${release.version}`);
  }
  return join(prefix, "bin", "tasq");
}

async function createNontrivialLedger(cli: string, home: string, version: string) {
  const tenant = `tq608/migration/${version.replaceAll(".", "-")}`;
  const actor = "migration-alpha";
  const attemptSucceedRetryIdentity = ["tq608", "attempt", "succeed"].join("-");
  await ok(cli, ["onboard", "--space", tenant, "--actor", actor, "--json"], { home });
  await ok(cli, ["onboard", "--space", tenant, "--actor", "migration-beta", "--json"], { home });

  const commitment = json(await ok(cli, [
    "add", "retained migration outcome",
    "--completion", "evidence",
    "--success", "digest-bound evidence survives",
    "--idempotency-key", "tq608-create-evidenced",
    "--tenant", tenant,
    "--actor", actor,
    "--json",
  ], { home }), "source commitment");
  const claim = json(await ok(cli, [
    "claim", commitment.id,
    "--for", "30m",
    "--idempotency-key", "tq608-claim",
    "--tenant", tenant,
    "--actor", actor,
    "--json",
  ], { home }), "source claim");
  json(await ok(cli, [
    "start", commitment.id,
    "--idempotency-key", "tq608-start",
    "--tenant", tenant,
    "--actor", actor,
    "--json",
  ], { home }), "started commitment");
  const attempt = json(await ok(cli, [
    "attempt", "start", commitment.id,
    "--claim", claim.id,
    "--runtime", "tq608-release-matrix",
    "--external-id", `release-${version}-attempt`,
    "--context-id", `release-${version}-context`,
    "--idempotency-key", "tq608-attempt-start",
    "--tenant", tenant,
    "--actor", actor,
    "--json",
  ], { home }), "source attempt");
  json(await ok(cli, [
    "attempt", "wait", attempt.id,
    "--message", "retained input boundary",
    "--idempotency-key", "tq608-attempt-wait",
    "--tenant", tenant,
    "--actor", actor,
    "--json",
  ], { home }), "waiting attempt");
  json(await ok(cli, [
    "attempt", "resume", attempt.id,
    "--message", "retained input supplied",
    "--idempotency-key", "tq608-attempt-resume",
    "--tenant", tenant,
    "--actor", actor,
    "--json",
  ], { home }), "resumed attempt");
  const succeeded = json(await ok(cli, [
    "attempt", "succeed", attempt.id,
    "--message", "retained attempt succeeded",
    "--idempotency-key", attemptSucceedRetryIdentity,
    "--tenant", tenant,
    "--actor", actor,
    "--json",
  ], { home }), "succeeded attempt");
  const evidence = json(await ok(cli, [
    "evidence", "add", commitment.id,
    "--attempt", attempt.id,
    "--kind", "test_report",
    "--summary", "digest-bound retained migration evidence",
    "--uri", `https://evidence.invalid/tq608/${version}`,
    "--digest", `sha256:${"a".repeat(64)}`,
    "--source", "tq608-release-matrix",
    "--idempotency-key", "tq608-evidence",
    "--tenant", tenant,
    "--actor", actor,
    "--json",
  ], { home }), "source evidence");
  const completed = json(await ok(cli, [
    "done", commitment.id,
    "--evidence", evidence.id,
    "--note", "retained migration outcome complete",
    "--source", "tq608-release-matrix",
    "--idempotency-key", "tq608-complete",
    "--tenant", tenant,
    "--actor", actor,
    "--json",
  ], { home }), "completed commitment");

  const blocked = json(await ok(cli, [
    "add", "retained blocked outcome",
    "--idempotency-key", "tq608-create-blocked",
    "--tenant", tenant,
    "--actor", "migration-beta",
    "--json",
  ], { home }), "blocked source commitment");
  await ok(cli, [
    "block", blocked.id,
    "--reason", "retained external dependency",
    "--idempotency-key", "tq608-block",
    "--tenant", tenant,
    "--actor", "migration-beta",
    "--json",
  ], { home });

  const lease = json(await ok(cli, [
    "resource", "acquire", "migration:exclusive",
    "--for", "30m",
    "--idempotency-key", "tq608-resource-acquire",
    "--tenant", tenant,
    "--actor", actor,
    "--json",
  ], { home }), "source resource lease");
  await ok(cli, [
    "resource", "release", "migration:exclusive",
    "--lease", lease.lease.id,
    "--fence", String(lease.lease.fence),
    "--revision", String(lease.lease.revision),
    "--idempotency-key", "tq608-resource-release",
    "--tenant", tenant,
    "--actor", actor,
    "--json",
  ], { home });

  const doctor = json(await ok(cli, [
    "doctor", "--tenant", tenant, "--actor", actor, "--json",
  ], { home }), "source doctor");
  const events = json(await ok(cli, [
    "event", "list", "--tenant", tenant, "--json",
  ], { home }), "source event list") as any;
  if (
    doctor.ok !== true ||
    completed.status !== "done" ||
    succeeded.status !== "succeeded" ||
    !Array.isArray(events) ||
    events.length < 10
  ) {
    throw new Error(`release ${version} did not create the required nontrivial ledger`);
  }
  return {
    tenant,
    actor,
    commitmentId: commitment.id as string,
    attemptId: attempt.id as string,
    evidenceId: evidence.id as string,
    blockedCommitmentId: blocked.id as string,
    eventCount: events.length,
  };
}

async function verifyFormat(databasePath: string, expected: number) {
  const client = createClient({ url: `file:${databasePath}` });
  try {
    const migrations = await client.execute("SELECT name FROM _migration ORDER BY name");
    const counts = await Promise.all([
      client.execute("SELECT count(*) AS count FROM task"),
      client.execute("SELECT count(*) AS count FROM task_attempt"),
      client.execute("SELECT count(*) AS count FROM task_evidence"),
      client.execute("SELECT count(*) AS count FROM event"),
    ]);
    if (migrations.rows.length !== expected + 1) {
      throw new Error(`expected format ${expected}, found ${migrations.rows.length - 1}`);
    }
    return {
      migrationCount: migrations.rows.length,
      commitmentCount: Number(counts[0].rows[0]?.count),
      attemptCount: Number(counts[1].rows[0]?.count),
      evidenceCount: Number(counts[2].rows[0]?.count),
      eventCount: Number(counts[3].rows[0]?.count),
    };
  } finally {
    client.close();
  }
}

function canonicalSqlValue(value: unknown): unknown {
  if (typeof value === "bigint") return { bigint: value.toString() };
  if (value instanceof Uint8Array) return { bytes: Buffer.from(value).toString("hex") };
  if (Array.isArray(value)) return value.map(canonicalSqlValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalSqlValue(entry)]),
    );
  }
  return value;
}

async function logicalDatabaseDigest(databasePath: string): Promise<string> {
  const client = createClient({ url: `file:${databasePath}` });
  try {
    const tables = await client.execute(
      "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    );
    const document = [];
    for (const table of tables.rows) {
      const name = String(table.name);
      const identifier = `"${name.replaceAll('"', '""')}"`;
      const rows = await client.execute(`SELECT * FROM ${identifier}`);
      document.push({
        name,
        schema: table.sql,
        rows: rows.rows
          .map((row) => JSON.stringify(canonicalSqlValue(row)))
          .sort(),
      });
    }
    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(JSON.stringify(document));
    return hasher.digest("hex");
  } finally {
    client.close();
  }
}

async function isolatedLogicalDatabaseDigest(databasePath: string): Promise<string> {
  const sourceDirectory = dirname(databasePath);
  const databaseName = basename(databasePath);
  const isolated = await mkdtemp(join(tmpdir(), "tasq-tq608-logical-digest-"));
  try {
    for (const name of await readdir(sourceDirectory)) {
      if (name === databaseName || name.startsWith(`${databaseName}-`)) {
        await copyFile(join(sourceDirectory, name), join(isolated, name));
      }
    }
    return await logicalDatabaseDigest(join(isolated, databaseName));
  } finally {
    await rm(isolated, { recursive: true, force: true });
  }
}

async function oneReceipt(databasePath: string): Promise<Record<string, any>> {
  const directory = `${databasePath}.tasq-migrations`;
  const names = (await readdir(directory))
    .filter((name) => name.startsWith("receipt-") && name.endsWith(".json"))
    .sort();
  if (names.length !== 1) throw new Error(`expected one migration receipt, found ${names.length}`);
  const path = join(directory, names[0]!);
  const receipt = json(await readFile(path, "utf8"), "migration receipt");
  return { ...receipt, path, sha256: await sha256File(path) };
}

async function certifySource(input: {
  release: VerifiedReleaseEnvelope;
  candidate: VerifiedReleaseEnvelope;
  root: string;
  candidateStoreFormat: number;
}) {
  const sourceRoot = join(input.root, `source-${input.release.version}`);
  const sourcePrefix = join(sourceRoot, "old-prefix");
  const candidatePrefix = join(sourceRoot, "candidate-prefix");
  const home = join(sourceRoot, "home");
  await mkdir(home, { recursive: true, mode: 0o700 });
  const oldCli = await install(input.release, sourcePrefix);
  const candidateCli = await install(input.candidate, candidatePrefix);
  const ledger = await createNontrivialLedger(oldCli, home, input.release.version);
  const databasePath = join(home, "db.sqlite");
  const sourceDatabaseSha256 = await sha256File(databasePath);
  const sourceCounts = await verifyFormat(databasePath, input.release.storeFormat);
  if (
    sourceCounts.commitmentCount < 2 ||
    sourceCounts.attemptCount < 1 ||
    sourceCounts.evidenceCount < 1 ||
    sourceCounts.eventCount < 10
  ) {
    throw new Error(`source ${input.release.version} ledger is trivial`);
  }

  const candidateDoctor = json(await ok(candidateCli, [
    "doctor", "--tenant", ledger.tenant, "--actor", ledger.actor, "--json",
  ], { home }), "candidate doctor");
  if (candidateDoctor.ok !== true) throw new Error("candidate post-migration doctor failed");
  const receipt = await oneReceipt(databasePath);
  if (
    receipt.contractVersion !== "tasq.migration-receipt.v1" ||
    receipt.status !== "complete" ||
    receipt.source?.format !== input.release.storeFormat ||
    receipt.target?.format !== input.candidateStoreFormat ||
    receipt.snapshot?.verification?.ok !== true ||
    receipt.postVerification?.schemaFormat !== input.candidateStoreFormat ||
    receipt.postVerification?.service?.ok !== true
  ) {
    throw new Error(`migration receipt contract failed for ${input.release.version}`);
  }
  if (
    ((await stat(receipt.path)).mode & 0o777) !== 0o600 ||
    ((await stat(receipt.snapshot.path)).mode & 0o777) !== 0o600 ||
    await sha256File(receipt.snapshot.path) !== receipt.snapshot.sha256
  ) {
    throw new Error(`migration recovery files are not private and digest-bound`);
  }
  const candidateCounts = await verifyFormat(databasePath, input.candidateStoreFormat);
  const candidateInspection = json(await ok(candidateCli, [
    "inspect", ledger.commitmentId,
    "--tenant", ledger.tenant,
    "--actor", ledger.actor,
    "--json",
  ], { home }), "candidate migrated inspection");
  if (
    candidateInspection.commitment?.status !== "done" ||
    candidateInspection.attempts?.some?.((attempt: any) => attempt.id === ledger.attemptId) !== true ||
    candidateInspection.evidence?.some?.((evidence: any) => evidence.id === ledger.evidenceId) !== true
  ) {
    throw new Error(`candidate did not preserve source coordination records: ${JSON.stringify({
      status: candidateInspection.commitment?.status,
      attemptIds: candidateInspection.attempts?.map?.((attempt: any) => attempt.id),
      evidenceIds: candidateInspection.evidence?.map?.((evidence: any) => evidence.id),
      expectedAttemptId: ledger.attemptId,
      expectedEvidenceId: ledger.evidenceId,
    })}`);
  }

  const logicalBeforeDowngrade = {
    database: await isolatedLogicalDatabaseDigest(databasePath),
    journal: await sha256File(join(home, "events.jsonl")),
    receipt: await sha256File(receipt.path),
    snapshot: await sha256File(receipt.snapshot.path),
  };
  const physicalBeforeDowngrade = await directoryManifest(home);
  const downgrade = await run(oldCli, [
    "doctor", "--tenant", ledger.tenant, "--actor", ledger.actor, "--json",
  ], { home });
  if (downgrade.exitCode !== 3) {
    throw new Error(`older ${input.release.version} binary did not use compatibility exit code 3`);
  }
  const downgradeProblem = problem(downgrade);
  if (
    downgradeProblem.contractVersion !== "tasq.store-compatibility-problem.v1" ||
    downgradeProblem.code !== "store_format_newer_than_executable" ||
    typeof downgradeProblem.detectedFormat !== "number" ||
    downgradeProblem.detectedFormat <= input.release.storeFormat ||
    downgradeProblem.detectedFormat > input.candidateStoreFormat ||
    downgradeProblem.mutationPerformed !== false
  ) {
    throw new Error(
      `older ${input.release.version} binary did not return typed refusal: ${JSON.stringify({
        exitCode: downgrade.exitCode,
        problem: downgradeProblem,
      })}`,
    );
  }
  const physicalAfterDowngrade = await directoryManifest(home);
  const logicalAfterDowngrade = {
    database: await isolatedLogicalDatabaseDigest(databasePath),
    journal: await sha256File(join(home, "events.jsonl")),
    receipt: await sha256File(receipt.path),
    snapshot: await sha256File(receipt.snapshot.path),
  };
  if (JSON.stringify(logicalAfterDowngrade) !== JSON.stringify(logicalBeforeDowngrade)) {
    throw new Error(`older ${input.release.version} binary changed logical or recovery state`);
  }
  const physicalChanges = [...new Set([
    ...physicalBeforeDowngrade,
    ...physicalAfterDowngrade,
  ])].filter((entry) =>
    !physicalBeforeDowngrade.includes(entry) || !physicalAfterDowngrade.includes(entry)
  ).sort();

  const restoreHome = join(sourceRoot, "restored-home");
  await mkdir(restoreHome, { recursive: true, mode: 0o700 });
  const restoredDatabase = join(restoreHome, "db.sqlite");
  await copyFile(receipt.snapshot.path, restoredDatabase);
  await chmod(restoredDatabase, 0o600);
  const sourceJournal = join(home, "events.jsonl");
  const restoredJournal = join(restoreHome, "events.jsonl");
  await copyFile(sourceJournal, restoredJournal);
  await chmod(restoredJournal, 0o600);
  const restoredSnapshotBeforeDoctor = await sha256File(restoredDatabase);
  if (restoredSnapshotBeforeDoctor !== receipt.snapshot.sha256) {
    throw new Error("restored snapshot bytes drifted before matching-binary doctor");
  }
  const restoredDoctor = json(await ok(oldCli, [
    "doctor", "--tenant", ledger.tenant, "--actor", ledger.actor, "--json",
  ], { home: restoreHome }), "matching source doctor");
  if (restoredDoctor.ok !== true) throw new Error("matching source binary rejected its snapshot");
  const restoredInspection = json(await ok(oldCli, [
    "inspect", ledger.commitmentId,
    "--tenant", ledger.tenant,
    "--actor", ledger.actor,
    "--json",
  ], { home: restoreHome }), "matching source inspection");
  if (
    restoredInspection.commitment?.status !== "done" ||
    restoredInspection.attempts?.some?.((attempt: any) => attempt.id === ledger.attemptId) !== true ||
    restoredInspection.evidence?.some?.((evidence: any) => evidence.id === ledger.evidenceId) !== true
  ) {
    throw new Error("matching source binary did not recover nontrivial snapshot state");
  }
  const restoredCounts = await verifyFormat(restoredDatabase, input.release.storeFormat);

  return {
    source: {
      version: input.release.version,
      sourceCommit: input.release.sourceCommit,
      storeFormat: input.release.storeFormat,
      exactPinnedAssets: true,
      assetSha256: input.release.files,
      databaseSha256: sourceDatabaseSha256,
      ...sourceCounts,
    },
    nontrivialLedger: {
      commitmentCount: sourceCounts.commitmentCount,
      attemptCount: sourceCounts.attemptCount,
      evidenceCount: sourceCounts.evidenceCount,
      eventCount: ledger.eventCount,
      completedCommitmentPreserved: true,
      blockedCommitmentPreserved: candidateCounts.commitmentCount >= 2,
    },
    migration: {
      targetFormat: input.candidateStoreFormat,
      migrationCount: candidateCounts.migrationCount,
      receiptSha256: receipt.sha256,
      snapshotSha256: receipt.snapshot.sha256,
      snapshotPrivateMode: true,
      receiptPrivateMode: true,
      snapshotVerified: true,
      receiptComplete: true,
      doctorPassed: true,
    },
    downgrade: {
      exitCode: downgrade.exitCode,
      code: downgradeProblem.code,
      detectedFormat: downgradeProblem.detectedFormat,
      mutationPerformed: downgradeProblem.mutationPerformed,
      logicalAndRecoveryStateBefore: logicalBeforeDowngrade,
      logicalAndRecoveryStateAfter: logicalAfterDowngrade,
      noLogicalOrRecoveryWrite:
        JSON.stringify(logicalBeforeDowngrade) === JSON.stringify(logicalAfterDowngrade),
      physicalTreeByteExact:
        JSON.stringify(physicalBeforeDowngrade) === JSON.stringify(physicalAfterDowngrade),
      physicalChanges,
    },
    restore: {
      matchingVersion: input.release.version,
      restoredFormat: input.release.storeFormat,
      snapshotSha256: restoredSnapshotBeforeDoctor,
      journalRecovered: true,
      doctorPassed: true,
      completedCommitmentRecovered: restoredInspection.commitment?.status === "done",
      attemptRecovered: restoredCounts.attemptCount >= 1,
      evidenceRecovered: restoredCounts.evidenceCount >= 1,
    },
  };
}

async function main(): Promise<void> {
  const repositoryRoot = resolve(import.meta.dir, "../../..");
  const matrixPath = resolve(
    optionalFlag("--matrix") ??
      join(repositoryRoot, "docs/contracts/TQ-608_V040_PRERELEASE_MATRIX.json"),
  );
  const matrix = JSON.parse(await readFile(matrixPath, "utf8")) as Matrix;
  if (
    matrix.contractVersion !== "tasq.migration-prerelease-matrix.v1" ||
    matrix.candidate.version !== "0.4.0" ||
    matrix.candidate.storeFormat !== 29 ||
    matrix.candidate.publishedReplayPassed !== false ||
    matrix.candidate.publicSupportClaim !== false ||
    matrix.sourceReleases.map(({ version }) => version).join(",") !== "0.2.0,0.3.0"
  ) {
    throw new Error("TQ-608 v0.4 prerelease matrix contract drift");
  }
  const target = currentTarget();
  if (target === null || !matrix.protectedEvidenceRequired.targets.includes(target)) {
    throw new Error(`unsupported TQ-608 certification target: ${process.platform}-${process.arch}`);
  }
  const publishedRoot = resolve(flag("--published-root"));
  const candidateDirectory = resolve(flag("--candidate-dir"));
  const candidateCommit = flag("--candidate-source-commit");
  if (!/^[a-f0-9]{40}$/.test(candidateCommit)) {
    throw new Error("--candidate-source-commit must be a lowercase 40-character Git commit");
  }
  const trust = optionalFlag("--trust") ?? "pinned_public_release_checksums";
  if (trust !== "pinned_public_release_checksums" && trust !== "protected_github_attestations") {
    throw new Error("--trust must be pinned_public_release_checksums or protected_github_attestations");
  }

  const candidate = await verifyReleaseEnvelope({
    directory: candidateDirectory,
    version: matrix.candidate.version,
    target,
    expectedSourceCommit: candidateCommit,
    expectedStoreFormat: matrix.candidate.storeFormat,
    requireLocalNonPublishable: true,
  });
  const releases = await Promise.all(matrix.sourceReleases.map(async (release) => verifyReleaseEnvelope({
    directory: join(publishedRoot, `v${release.version}`),
    version: release.version,
    target,
    expectedSourceCommit: release.sourceCommit,
    expectedStoreFormat: release.storeFormat,
    expectedFiles: release.targets[target],
    requireLocalNonPublishable: true,
  })));

  const root = await mkdtemp(join(tmpdir(), "tasq-tq608-v040-"));
  try {
    const results = [];
    for (const release of releases) {
      results.push(await certifySource({
        release,
        candidate,
        root,
        candidateStoreFormat: matrix.candidate.storeFormat,
      }));
    }
    const protectedReplay = trust === "protected_github_attestations";
    process.stdout.write(`${JSON.stringify({
      contractVersion: "tasq.migration-prerelease-evidence.v1",
      status: protectedReplay
        ? "passed_protected_source_candidate_matrix"
        : "passed_local_source_candidate_matrix",
      target,
      candidate: {
        version: matrix.candidate.version,
        sourceCommit: candidateCommit,
        storeFormat: matrix.candidate.storeFormat,
        exactLocalCandidateBytes: true,
        protectedSourceCommitBinding: protectedReplay,
        publishedArtifact: false,
        publishedReplayPassed: false,
      },
      sourceArtifactTrust: {
        pinnedPublicAssetDigests: true,
        githubAttestationsVerified: protectedReplay,
      },
      releases: results,
      assertions: Object.fromEntries(matrix.requiredAssertions.map((assertion) => [assertion, true])),
      externalGate: {
        candidateArtifactAttestationsAfterPublication: "not_run",
        publishedV040Replay: "not_run",
      },
      publicSupportClaim: false,
    }, null, 2)}\n`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

await main();

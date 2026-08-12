import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");
const policyPath = resolve(root, "docs/releases/PUBLIC_RELEASE_POLICY.json");
const script = resolve(root, "scripts/release/verify-tq616-release-eligibility.ts");
const historicalVersion = "0.3.0";
const historicalCommit = "c093ed58ab2a9e38dbd9d877ba75021997761057";
const nextVersion = "0.4.0";
const nextCommit = "a".repeat(40);
let scratch = "";

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "tasq-tq616-eligibility-"));
});

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

async function run(
  version: string,
  sourceCommit: string,
  policy = policyPath,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const child = Bun.spawn([
    process.execPath,
    script,
    "--policy",
    policy,
    "--version",
    version,
    "--source-commit",
    sourceCommit,
    "--repository",
    "gwendall/tasq",
  ], { cwd: root, stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

async function policyFile(change: (policy: Record<string, any>) => void): Promise<string> {
  const policy = JSON.parse(await readFile(policyPath, "utf8")) as Record<string, any>;
  change(policy);
  const path = join(scratch, `${crypto.randomUUID()}.json`);
  await writeFile(path, `${JSON.stringify(policy)}\n`, "utf8");
  return path;
}

describe("TQ-616 protected release eligibility", () => {
  test("keeps historical v0.3.0 certification green without replaying absent APIs", async () => {
    const path = await policyFile((policy) => {
      policy.releaseAuthorization.state = "authorized";
      policy.releaseAuthorization.version = historicalVersion;
    });
    const result = await run(historicalVersion, historicalCommit, path);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      contractVersion: "tasq.tq616-release-eligibility.v1",
      status: "not_applicable_historical_release",
      version: historicalVersion,
      sourceCommit: historicalCommit,
      replayRequired: false,
      reason: "v0.3.0 predates the TQ-613 through TQ-615 signed-statement public package surface",
      gatesClosed: [],
      publicSupportClaim: false,
    });
  });

  test("fails closed for a future release without exact compatibility authorization", async () => {
    const path = await policyFile((policy) => {
      policy.releaseAuthorization.state = "authorized";
      policy.releaseAuthorization.version = nextVersion;
      policy.certificationPrograms.tq616SignedStatements.state =
        "prepared_not_authorized";
      policy.certificationPrograms.tq616SignedStatements.decision = "pending";
    });
    const result = await run(nextVersion, nextCommit, path);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain(
      "exact release is not authorized as TQ-616 compatible",
    );
  });

  test("binds an authorized compatible version to the protected runtime tag commit", async () => {
    const path = await policyFile((policy) => {
      policy.releaseAuthorization.state = "authorized";
      policy.releaseAuthorization.version = nextVersion;
      policy.certificationPrograms.tq616SignedStatements = {
        ...policy.certificationPrograms.tq616SignedStatements,
        state: "authorized",
        version: nextVersion,
        decision: "go",
        authorizedBy: "@gwendall",
        authorizedAt: "2026-07-30",
      };
    });
    const accepted = await run(nextVersion, nextCommit, path);
    expect(accepted.exitCode, accepted.stderr).toBe(0);
    expect(JSON.parse(accepted.stdout)).toMatchObject({
      contractVersion: "tasq.tq616-release-eligibility.v1",
      status: "authorized_compatible_release",
      replayRequired: true,
      version: nextVersion,
      sourceCommit: nextCommit,
      sourceTag: `v${nextVersion}`,
      sourceBinding: "protected_immutable_version_tag_runtime_commit",
      gatesClosed: [],
      publicSupportClaim: false,
    });

    const alternateCommit = "b".repeat(40);
    const rebound = await run(nextVersion, alternateCommit, path);
    expect(rebound.exitCode, rebound.stderr).toBe(0);
    expect(JSON.parse(rebound.stdout)).toMatchObject({
      sourceCommit: alternateCommit,
      sourceTag: `v${nextVersion}`,
    });

    const invalidPath = await policyFile((policy) => {
      policy.releaseAuthorization.state = "authorized";
      policy.releaseAuthorization.version = nextVersion;
      policy.certificationPrograms.tq616SignedStatements = {
        ...policy.certificationPrograms.tq616SignedStatements,
        state: "authorized",
        version: nextVersion,
        sourceBinding: "embedded_policy_commit",
        decision: "go",
        authorizedBy: "@gwendall",
        authorizedAt: "2026-07-30",
      };
    });
    const invalid = await run(nextVersion, nextCommit, invalidPath);
    expect(invalid.exitCode).not.toBe(0);
    expect(invalid.stderr).toContain("source binding drift");
  });
});

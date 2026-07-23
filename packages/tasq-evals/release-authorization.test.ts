import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");
const policy = await Bun.file(resolve(root, "docs/releases/PUBLIC_RELEASE_POLICY.json")).json() as {
  releaseChannels: Record<string, { blockers: string[]; nonBlockingEvidence: string[] }>;
  releaseAuthorization: Record<string, unknown>;
  externalPublicationGateStatus: Record<string, boolean>;
  packages: Array<Record<string, unknown>>;
};
const sourceCommit = "a".repeat(40);
let scratch = "";

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "tasq-release-authorization-"));
});

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

function authorizedPolicy() {
  return {
    ...structuredClone(policy),
    releaseAuthorization: {
      ...policy.releaseAuthorization,
      state: "authorized",
    },
    externalPublicationGateStatus: {
      ...policy.externalPublicationGateStatus,
      npm_scope_control_verified: true,
      trusted_publishing_configured: true,
    },
  };
}

async function verify(candidate: unknown, version = "0.1.0") {
  const path = join(scratch, `policy-${crypto.randomUUID()}.json`);
  await writeFile(path, `${JSON.stringify(candidate)}\n`, "utf8");
  const child = Bun.spawn([
    process.execPath,
    resolve(root, "scripts/release/verify-release-authorization.ts"),
    "--policy", path,
    "--version", version,
    "--source-commit", sourceCommit,
    "--repository", "gwendall/tasq",
  ], { stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

describe("protected public release authorization", () => {
  test("accepts the exact maintainer-authorized alpha after every alpha blocker passes", async () => {
    const result = await verify(authorizedPolicy());
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      contractVersion: "tasq.release-authorization.v1",
      version: "0.1.0",
      sourceCommit,
      channel: "public-alpha",
      authorizedBy: "@gwendall",
      requiredGates: policy.releaseChannels["public-alpha"]!.blockers,
      publicPackages: [
        "@tasq/schema",
        "@tasq/core",
        "@tasq/cli",
        "@tasq/mcp",
        "@tasq/extension-sdk",
        "@tasq/protocol-adapters",
        "@tasq/console",
      ],
    });
  });

  test("keeps retained-data dogfood non-blocking for alpha but blocking for stable", () => {
    expect(policy.releaseChannels["public-alpha"]!.blockers)
      .not.toContain("private_multi_app_dogfood_accepted");
    expect(policy.releaseChannels["public-alpha"]!.nonBlockingEvidence)
      .toContain("private_multi_app_dogfood_accepted");
    expect(policy.releaseChannels.stable!.blockers)
      .toContain("private_multi_app_dogfood_accepted");
  });

  test("fails closed on pending authority, registry gaps, version drift, or package drift", async () => {
    const pending = await verify(policy);
    expect(pending.exitCode).not.toBe(0);
    expect(pending.stderr).toContain("authorization state is pending_external_registry");

    const missingRegistry = authorizedPolicy();
    missingRegistry.externalPublicationGateStatus.trusted_publishing_configured = false;
    const missing = await verify(missingRegistry);
    expect(missing.exitCode).not.toBe(0);
    expect(missing.stderr).toContain("required gate trusted_publishing_configured is not verified");

    const versionDrift = await verify(authorizedPolicy(), "0.1.1");
    expect(versionDrift.exitCode).not.toBe(0);
    expect(versionDrift.stderr).toContain("authorized version 0.1.0 does not match 0.1.1");

    const packageDrift = authorizedPolicy();
    packageDrift.packages[1] = { ...packageDrift.packages[1], source: "packages/tasq-service" };
    const drift = await verify(packageDrift);
    expect(drift.exitCode).not.toBe(0);
    expect(drift.stderr).toContain("first-release package boundary drift");
  });
});

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");
const policy = await Bun.file(resolve(root, "docs/releases/PUBLIC_RELEASE_POLICY.json")).json() as {
  compatibility: {
    scope: string;
    storeFormat: { current: number };
  };
  sourceCandidateCompatibility: {
    status: string;
    storeFormat: {
      contractVersion: string;
      current: number;
      readable: { min: number; max: number };
      writable: { min: number; max: number };
      directlyMigratable: { min: number; max: number };
      irreversible: boolean;
      rollback: string;
    };
    publishedSupportGranted: boolean;
  };
  certificationPrograms: {
    tq616SignedStatements: Record<string, unknown>;
  };
  releaseChannels: Record<string, { blockers: string[]; nonBlockingEvidence: string[] }>;
  releaseAuthorization: { version: string; [key: string]: unknown };
  publishedRelease: {
    version: string;
    publishedPackages: Array<{ name: string; version: string }>;
  };
  externalPublicationGateStatus: Record<string, boolean>;
  packages: Array<Record<string, unknown>>;
  candidatePublications: Record<string, {
    state: string;
    coordinate: string;
    workflow: string;
    environment: string;
    version: string | null;
    sourceBinding: string;
    decision: string;
    authorizedBy: string | null;
    authorizedAt: string | null;
  }>;
};
const sourceCommit = "a".repeat(40);
const authorizedVersion = String(policy.releaseAuthorization.version);
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
      agent_integration_candidate_certified: true,
      data_safety_source_candidate: true,
    },
  };
}

async function verify(candidate: unknown, version = authorizedVersion) {
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
      version: authorizedVersion,
      sourceCommit,
      channel: "public-alpha",
      authorizedBy: "@gwendall",
      requiredGates: policy.releaseChannels["public-alpha"]!.blockers,
      publicPackages: [
        "@tasq-run/schema",
        "@tasq-run/core",
        "@tasq-run/cli",
        "@tasq-run/mcp",
        "@tasq-run/extension-sdk",
        "@tasq-run/protocol-adapters",
        "@tasq-run/console",
        "@tasq-run/client",
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

  test("separates published format 26 from unshipped source-candidate format 29", () => {
    expect(policy.compatibility).toMatchObject({
      scope: "publishedRelease",
      storeFormat: { current: 26 },
    });
    expect(policy.sourceCandidateCompatibility).toEqual({
      status: "repository_source_candidate_not_published",
      storeFormat: {
        contractVersion: "tasq.store-format.v1",
        current: 29,
        readable: { min: 29, max: 29 },
        writable: { min: 29, max: 29 },
        directlyMigratable: { min: 0, max: 29 },
        irreversible: true,
        rollback: "restore-matching-verified-pre-migration-snapshot-and-binary",
      },
      publishedSupportGranted: false,
    });
    for (const authorization of Object.values(policy.candidatePublications)) {
      expect(authorization.sourceBinding)
        .toBe("protected_immutable_version_tag_runtime_commit");
      expect("sourceCommit" in authorization).toBe(false);
    }
    expect(policy.certificationPrograms.tq616SignedStatements.sourceBinding)
      .toBe("protected_immutable_version_tag_runtime_commit");
    expect("sourceCommit" in policy.certificationPrograms.tq616SignedStatements).toBe(false);
  });

  test("fails closed on pending authority, registry gaps, version drift, or package drift", async () => {
    const pendingPolicy = structuredClone(policy);
    pendingPolicy.releaseAuthorization = {
      ...pendingPolicy.releaseAuthorization,
      state: "pending_external_registry",
    };
    const pending = await verify(pendingPolicy);
    expect(pending.exitCode).not.toBe(0);
    expect(pending.stderr).toContain("authorization state is pending_external_registry");

    const missingRegistry = authorizedPolicy();
    missingRegistry.externalPublicationGateStatus.trusted_publishing_configured = false;
    const missing = await verify(missingRegistry);
    expect(missing.exitCode).not.toBe(0);
    expect(missing.stderr).toContain("required gate trusted_publishing_configured is not verified");

    const versionDrift = await verify(authorizedPolicy(), "0.1.2");
    expect(versionDrift.exitCode).not.toBe(0);
    expect(versionDrift.stderr).toContain(`authorized version ${authorizedVersion} does not match 0.1.2`);

    const scopeDrift = authorizedPolicy() as ReturnType<typeof authorizedPolicy> & {
      identity: { npmScope: string };
    };
    scopeDrift.identity.npmScope = "@tasq";
    const wrongScope = await verify(scopeDrift);
    expect(wrongScope.exitCode).not.toBe(0);
    expect(wrongScope.stderr).toContain("npm scope drift");

    const packageDrift = authorizedPolicy();
    packageDrift.packages[1] = { ...packageDrift.packages[1], source: "packages/tasq-service" };
    const drift = await verify(packageDrift);
    expect(drift.exitCode).not.toBe(0);
    expect(drift.stderr).toContain("first-release package boundary drift");
  });

  test("includes the remote TypeScript client only under exact v0.4.0 authorization", async () => {
    const candidate = authorizedPolicy();
    const accepted = await verify(candidate);
    expect(accepted.exitCode, accepted.stderr).toBe(0);
    expect(JSON.parse(accepted.stdout).publicPackages).toEqual([
      "@tasq-run/schema",
      "@tasq-run/core",
      "@tasq-run/cli",
      "@tasq-run/mcp",
      "@tasq-run/extension-sdk",
      "@tasq-run/protocol-adapters",
      "@tasq-run/console",
      "@tasq-run/client",
    ]);

    const pending = authorizedPolicy();
    pending.candidatePublications.remoteTypeScriptClient = {
      ...pending.candidatePublications.remoteTypeScriptClient,
      state: "prepared_not_authorized",
      decision: "pending",
      version: null,
      authorizedBy: null,
      authorizedAt: null,
    };
    const withoutClient = await verify(pending);
    expect(withoutClient.exitCode, withoutClient.stderr).toBe(0);
    expect(JSON.parse(withoutClient.stdout).publicPackages)
      .not.toContain("@tasq-run/client");

    candidate.candidatePublications.remoteTypeScriptClient.sourceBinding = "embedded_policy_commit";
    const drift = await verify(candidate);
    expect(drift.exitCode).not.toBe(0);
    expect(drift.stderr).toContain("remoteTypeScriptClient source binding drift");

    const historical = authorizedPolicy();
    historical.releaseAuthorization.version = historical.publishedRelease.version;
    historical.candidatePublications.remoteTypeScriptClient = {
      ...historical.candidatePublications.remoteTypeScriptClient,
      state: "authorized",
      decision: "go",
      version: historical.publishedRelease.version,
      authorizedBy: "@gwendall",
      authorizedAt: "2026-07-30",
    };
    const regression = await verify(historical, historical.publishedRelease.version);
    expect(regression.exitCode).not.toBe(0);
    expect(regression.stderr).toContain(
      `remoteTypeScriptClient version ${historical.publishedRelease.version} must be newer than published ${historical.publishedRelease.version}`,
    );
  });
});

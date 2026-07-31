import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");
const syntheticJwt = [
  "eyJhbGciOiJSUzI1NiJ9",
  "eyJzdWIiOiJhZG1pbiJ9",
  "c2lnbmF0dXJl",
].join(".");
const templatePath = resolve(
  root,
  "docs/contracts/MANAGED_CLOUD_PRODUCTION_READINESS.template.json",
);

type Manifest = Record<string, any>;

const REQUIRED_CLOUD_GATES = [
  "tq901.production_database",
  "tq901.secret_manager_and_server_digest",
  "tq901.independent_multitenant_review",
  "tq902.deployed_browser_matrix",
  "tq902.identity_callback_and_logout",
  "tq902.independent_web_security_review",
  "tq903.real_oidc_integration",
  "tq903.workload_secret_issuance",
  "tq903.recovery_and_revocation_drill",
  "tq904.provider_backup_restore",
  "tq904.provider_key_rotation",
  "tq904.export_and_verified_deletion",
  "tq904.oncall_incident_and_support_drill",
  "tq905.exact_artifact_deployment",
  "tq905.offsite_restore_and_region_failover",
  "tq905.independent_multitenant_security_review",
  "tq905.unbriefed_operator_incident_drill",
] as const;

async function template(): Promise<Manifest> {
  return JSON.parse(await readFile(templatePath, "utf8")) as Manifest;
}

async function validate(candidate: Manifest): Promise<Manifest> {
  const directory = await mkdtemp(resolve(tmpdir(), "tasq-cloud-readiness-"));
  const path = resolve(directory, "manifest.json");
  try {
    await writeFile(path, `${JSON.stringify(candidate)}\n`, { mode: 0o600 });
    const child = Bun.spawn([
      process.execPath,
      "scripts/validate-managed-cloud-readiness.ts",
      "--manifest",
      path,
    ], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
    ]);
    const result = JSON.parse(stdout) as Manifest;
    expect(exitCode).toBe(result.valid ? 0 : 1);
    return result;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function digest(character: string): string {
  return `sha256:${character.repeat(64)}`;
}

async function readyManifest(): Promise<Manifest> {
  const candidate = await template();
  candidate.state = "ready_for_maintainer_decision";
  candidate.candidate = {
    sourceCommit: "a".repeat(40),
    controlPlaneDigest: digest("b"),
    serverImage: {
      coordinate: `registry.example/tasq/server@${digest("c")}`,
      digest: digest("c"),
    },
    provenanceRefs: [`urn:${digest("d")}`],
  };
  candidate.deployment = {
    deploymentRef: "urn:tasq-provider:deployment/production",
    providerProfileRef: "urn:tasq-provider:profile/production-v1",
    deploymentIdentityRef: "urn:tasq-provider:identity/cloud-runtime",
    databaseRef: "urn:tasq-provider:database/control-plane",
    secretManagerRef: "urn:tasq-provider:secrets/cloud-runtime",
    publicOrigin: "https://cloud.example",
    tlsPolicyRef: `urn:${digest("e")}`,
    cspPolicyRef: `urn:${digest("f")}`,
    regions: [
      "urn:tasq-provider:region/primary",
      "urn:tasq-provider:region/recovery",
    ],
  };
  candidate.reliability = {
    availabilityTargetPercent: 99.9,
    measurementWindowDays: 30,
    recoveryPointObjectiveMinutes: 15,
    recoveryTimeObjectiveMinutes: 60,
    sloEvidenceRefs: [`urn:${digest("1")}`],
    disasterRecoveryEvidenceRefs: [`urn:${digest("2")}`],
  };
  candidate.gates = candidate.gates.map((gate: Manifest, index: number) => ({
    ...gate,
    status: "passed",
    observedAt: "2026-07-30T12:00:00.000Z",
    evidenceRefs: [`urn:${digest((index % 10).toString())}`],
    reviewerRef: gate.id.includes("independent_") ||
        gate.id === "tq905.unbriefed_operator_incident_drill"
      ? `urn:${digest("9")}`
      : null,
    notes: "External evidence was captured by the named independent boundary.",
  }));
  return candidate;
}

describe("managed Cloud production readiness manifest", () => {
  test("keeps the checked-in template valid, incomplete and non-authoritative", async () => {
    const candidate = await template();
    const result = await validate(candidate);
    expect(result.valid).toBeTrue();
    expect(result.readyForMaintainerDecision).toBeFalse();
    expect(result.passedGateCount).toBe(0);
    expect(result.totalGateCount).toBe(REQUIRED_CLOUD_GATES.length);
    expect(result.missing).toContain("gates.tq905.exact_artifact_deployment");
    expect(candidate.nonClaims).toEqual({
      managedCloudAvailable: false,
      remoteEffectsEnabled: false,
      manifestGrantsAuthority: false,
    });
  });

  test("accepts complete provider-neutral evidence without claiming availability", async () => {
    const candidate = await readyManifest();
    const first = await validate(candidate);
    const second = await validate(candidate);
    expect(first).toEqual(second);
    expect(first).toMatchObject({
      valid: true,
      readyForMaintainerDecision: true,
      state: "ready_for_maintainer_decision",
      passedGateCount: REQUIRED_CLOUD_GATES.length,
      missing: [],
      errors: [],
    });
    expect(candidate.nonClaims.managedCloudAvailable).toBeFalse();
    expect(candidate.nonClaims.remoteEffectsEnabled).toBeFalse();
  });

  test("fails closed on artifact drift, gate omission and premature state", async () => {
    const drift = await readyManifest();
    drift.candidate.serverImage.digest = digest("d");
    const driftResult = await validate(drift);
    expect(driftResult.valid).toBeFalse();
    expect(driftResult.errors).toContain(
      "candidate.serverImage coordinate and digest must identify the same bytes",
    );

    const omitted = await readyManifest();
    omitted.gates.pop();
    const omittedResult = await validate(omitted);
    expect(omittedResult.valid).toBeFalse();
    expect(omittedResult.readyForMaintainerDecision).toBeFalse();
    expect(omittedResult.errors).toContain(
      "missing required gate: tq905.unbriefed_operator_incident_drill",
    );

    const premature = await template();
    premature.state = "ready_for_maintainer_decision";
    const prematureResult = await validate(premature);
    expect(prematureResult.valid).toBeFalse();
    expect(prematureResult.errors).toContain(
      "state cannot claim ready_for_maintainer_decision while requirements are open",
    );
  });

  test("requires concluded and independent evidence for external reviews", async () => {
    const candidate = await readyManifest();
    const review = candidate.gates.find(
      ({ id }: Manifest) => id === "tq902.independent_web_security_review",
    );
    review.reviewerRef = null;
    review.evidenceRefs = [];
    const result = await validate(candidate);
    expect(result.valid).toBeFalse();
    expect(result.errors).toContain(
      "gates[5].evidenceRefs must prove a concluded gate",
    );
    expect(result.errors).toContain(
      "gates[5].reviewerRef must identify independent review evidence",
    );
  });

  test("rejects impossible UTC dates instead of accepting Date.parse normalization", async () => {
    const candidate = await readyManifest();
    candidate.gates[0].observedAt = "2026-02-30T12:00:00.000Z";
    const result = await validate(candidate);
    expect(result.valid).toBeFalse();
    expect(result.errors).toContain(
      "gates[0].observedAt must be an explicit UTC instant",
    );
  });

  test("rejects a trivial or incoherent production SLO", async () => {
    const trivial = await readyManifest();
    trivial.reliability.availabilityTargetPercent = 0;
    const trivialResult = await validate(trivial);
    expect(trivialResult.valid).toBeFalse();
    expect(trivialResult.errors).toContain(
      "reliability.availabilityTargetPercent must be a non-trivial target between 99 and 100",
    );

    const incoherent = await readyManifest();
    incoherent.reliability.measurementWindowDays = 1;
    const incoherentResult = await validate(incoherent);
    expect(incoherentResult.valid).toBeFalse();
    expect(incoherentResult.errors).toContain(
      "reliability.measurementWindowDays must be between 28 and 366",
    );
  });

  test("rejects secrets, unsafe references, extra fields and effect enablement", async () => {
    const secret = await template();
    secret.gates[0].notes = `Bearer ${syntheticJwt}`;
    expect((await validate(secret)).errors).toContain(
      "manifest contains forbidden bearer credential",
    );

    for (const [value, expectedError] of [
      [
        "tasq_access_this-is-a-secret-access-token",
        "manifest contains forbidden Tasq access credential",
      ],
      [
        "tasq_enroll_this-is-a-secret-enrollment-token",
        "manifest contains forbidden Tasq enrollment credential",
      ],
      [
        "__Host-tasq_session=this-is-a-secret-session-cookie",
        "manifest contains forbidden Tasq session cookie",
      ],
      [
        "C:\\Users\\operator\\private\\cloud-evidence.json",
        "manifest contains forbidden workstation path",
      ],
    ] as const) {
      const sensitive = await template();
      sensitive.gates[0].notes = value;
      expect((await validate(sensitive)).errors).toContain(expectedError);
    }

    const unsafe = await template();
    unsafe.gates[0].evidenceRefs = ["file:///Users/operator/private/report.json"];
    expect((await validate(unsafe)).valid).toBeFalse();

    const widened = await readyManifest();
    widened.nonClaims.remoteEffectsEnabled = true;
    widened.deployment.rawDatabaseUrl = "postgres://operator:secret@example/db";
    const widenedResult = await validate(widened);
    expect(widenedResult.valid).toBeFalse();
    expect(widenedResult.errors).toContain(
      "nonClaims.remoteEffectsEnabled must remain false",
    );
    expect(widenedResult.errors.some((error: string) =>
      error.startsWith("deployment must contain exactly:")
    )).toBeTrue();
  });

  test("the CLI distinguishes a valid open manifest from required readiness", async () => {
    const open = Bun.spawn([
      process.execPath,
      "scripts/validate-managed-cloud-readiness.ts",
    ], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await open.exited).toBe(0);
    const openOutput = JSON.parse(await new Response(open.stdout).text());
    expect(openOutput).toMatchObject({
      valid: true,
      readyForMaintainerDecision: false,
    });

    const required = Bun.spawn([
      process.execPath,
      "scripts/validate-managed-cloud-readiness.ts",
      "--require-ready",
    ], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await required.exited).toBe(2);
    const requiredOutput = JSON.parse(await new Response(required.stdout).text());
    expect(requiredOutput.missing.length).toBeGreaterThan(0);
  });

  test("schema and template freeze the same complete gate set", async () => {
    const schema = JSON.parse(
      await readFile(
        resolve(root, "docs/contracts/MANAGED_CLOUD_PRODUCTION_READINESS.schema.json"),
        "utf8",
      ),
    ) as Manifest;
    const candidate = await template();
    const schemaGateIds = schema.properties.gates.items.properties.id.enum;
    expect(schemaGateIds).toEqual([...REQUIRED_CLOUD_GATES]);
    expect(candidate.gates.map(({ id }: Manifest) => id)).toEqual([
      ...REQUIRED_CLOUD_GATES,
    ]);
  });
});

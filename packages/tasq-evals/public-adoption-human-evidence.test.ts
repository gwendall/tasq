/** TQ-606 — deterministic preparation for the still-external blind-human gate. */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");
const syntheticJwt = [
  "eyJhbGciOiJSUzI1NiJ9",
  "eyJzdWIiOiJhZG1pbiJ9",
  "c2lnbmF0dXJl",
].join(".");
const validator = resolve(root, "scripts/validate-tq606-human-evidence.ts");
const template = resolve(root, "docs/contracts/TQ-606_HUMAN_SESSION_EVIDENCE.template.json");
const scratch: string[] = [];
const evidenceRef = `urn:sha256:${"a".repeat(64)}`;
const stepIds = [
  "public-entrypoint-opened",
  "release-installed",
  "human-onboarded",
  "agent-connected",
  "contention-observed",
  "contention-recovered",
  "evidence-bound-completion-observed",
  "same-ledger-console-inspected",
];

afterEach(async () => {
  await Promise.all(scratch.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function completeEvidence() {
  const started = Date.parse("2026-07-30T10:00:00Z");
  const observedOffsets = [30, 120, 240, 360, 480, 600, 720, 840];
  return {
    contractVersion: "tasq.independent-human-adoption-evidence.v1",
    session: {
      id: "tq606-independent-01",
      target: "darwin-arm64",
      entrypoint: "https://tasq.run",
      releaseVersion: "0.3.0",
      releaseUrl: "https://github.com/gwendall/tasq/releases/tag/v0.3.0",
      startedAt: new Date(started).toISOString(),
      endedAt: new Date(started + 900_000).toISOString(),
    },
    independence: {
      participantExternal: true,
      participantPreviouslyUsedTasq: false,
      participantReceivedRepositoryBriefing: false,
      repositoryAccessDuringSession: false,
      facilitatorCoachingAfterStart: false,
      undocumentedHelpUsed: false,
      startingMaterials: ["https://tasq.run"],
    },
    journey: stepIds.map((id, index) => ({
      id,
      status: "completed",
      observedAt: new Date(started + observedOffsets[index]! * 1_000).toISOString(),
      evidenceRefs: [evidenceRef],
      note: `Redacted observation for ${id}.`,
    })),
    interventions: [{
      at: "2026-07-30T10:01:00Z",
      actor: "participant",
      kind: "public_documentation",
      description: "Participant opened the public getting-started guide without prompting.",
      documentedPath: "https://tasq.run/docs/getting-started/",
    }],
    failures: [{
      at: "2026-07-30T10:08:00Z",
      stepId: "contention-observed",
      severity: "friction",
      description: "Participant first retried the contended operation before reading the typed response.",
      disposition: "recovered_self_service",
      evidenceRefs: [evidenceRef],
    }],
    metrics: {
      activationStepId: "evidence-bound-completion-observed",
      timeToActivationSeconds: 720,
      totalElapsedSeconds: 900,
      stepsCompleted: 8,
    },
    attestation: {
      observerRef: "observer-independent-01",
      participantConsentRecorded: true,
      accountAccurate: true,
      privateTranscriptCommitted: false,
      evidenceDigest: `sha256:${"b".repeat(64)}`,
    },
    outcome: "completed_without_undocumented_help",
  };
}

async function validate(evidence: unknown) {
  const directory = await mkdtemp(join(tmpdir(), "tasq-tq606-human-"));
  scratch.push(directory);
  const path = join(directory, "evidence.json");
  await writeFile(path, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  const child = Bun.spawn([process.execPath, validator, "--evidence", path], {
    cwd: root,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, report: JSON.parse(stdout), stderr };
}

describe("TQ-606 independent-human evidence preparation", () => {
  test("accepts a complete redacted observation but never authorizes certificate mutation", async () => {
    const result = await validate(completeEvidence());
    expect(result).toEqual({
      exitCode: 0,
      stderr: "",
      report: {
        contractVersion: "tasq.independent-human-adoption-validation.v1",
        evidenceFile: "evidence.json",
        readyForExternalGateReview: true,
        certificateMutationAuthorized: false,
        errors: [],
      },
    });
  });

  test("fails closed on coaching, repository access, incomplete work and metric drift", async () => {
    const evidence: any = completeEvidence();
    evidence.independence.repositoryAccessDuringSession = true;
    evidence.independence.facilitatorCoachingAfterStart = true;
    evidence.journey[5]!.status = "failed";
    evidence.metrics.timeToActivationSeconds = 1;
    evidence.interventions.push({
      at: "2026-07-30T10:09:00Z",
      actor: "facilitator",
      kind: "facilitator_coaching",
      description: "Facilitator supplied an undocumented recovery command.",
      documentedPath: null,
    });
    evidence.outcome = "completed_with_undocumented_help";

    const result = await validate(evidence);
    expect(result.exitCode).toBe(1);
    expect(result.report.readyForExternalGateReview).toBe(false);
    expect(result.report.certificateMutationAuthorized).toBe(false);
    expect(result.report.errors).toEqual(expect.arrayContaining([
      "independence.repositoryAccessDuringSession must be false",
      "independence.facilitatorCoachingAfterStart must be false",
      "journey[5].status must be completed",
      "interventions[1] invalidates an independent blind completion",
      "metrics.timeToActivationSeconds must equal the observed activation interval",
      "outcome must be completed_without_undocumented_help",
    ]));
  });

  test("rejects reordered or out-of-session observations", async () => {
    const evidence: any = completeEvidence();
    evidence.journey[2].observedAt = evidence.journey[1].observedAt;
    evidence.journey[7].observedAt = "2026-07-30T10:16:00Z";
    evidence.interventions[0].at = "2026-07-30T09:59:59Z";
    evidence.failures[0].at = "2026-07-30T10:15:01Z";

    const result = await validate(evidence);
    expect(result.exitCode).toBe(1);
    expect(result.report.readyForExternalGateReview).toBe(false);
    expect(result.report.errors).toEqual(expect.arrayContaining([
      "journey[2].observedAt must be later than the previous journey step",
      "journey[7].observedAt must fall within the session interval",
      "interventions[0].at must fall within the session interval",
      "failures[0].at must fall within the session interval",
    ]));
  });

  test("rejects impossible UTC dates and sub-second sessions", async () => {
    const impossible: any = completeEvidence();
    impossible.session.startedAt = "2026-02-30T10:00:00Z";
    const impossibleResult = await validate(impossible);
    expect(impossibleResult.exitCode).toBe(1);
    expect(impossibleResult.report.errors).toContain(
      "session.startedAt must be an explicit UTC instant",
    );

    const subSecond: any = completeEvidence();
    subSecond.session.startedAt = "2026-07-30T10:00:00.000Z";
    subSecond.session.endedAt = "2026-07-30T10:00:00.900Z";
    subSecond.journey = subSecond.journey.map((step: any, index: number) => ({
      ...step,
      observedAt: `2026-07-30T10:00:00.${String(index + 1).padStart(3, "0")}Z`,
    }));
    subSecond.interventions[0].at = "2026-07-30T10:00:00.100Z";
    subSecond.failures[0].at = "2026-07-30T10:00:00.500Z";
    subSecond.metrics.timeToActivationSeconds = 0;
    subSecond.metrics.totalElapsedSeconds = 0;
    const subSecondResult = await validate(subSecond);
    expect(subSecondResult.exitCode).toBe(1);
    expect(subSecondResult.report.errors).toContain(
      "metrics.totalElapsedSeconds must be at least 1",
    );
  });

  test("rejects secret material, workstation paths and unsafe URLs in any text field", async () => {
    const vectors = [
      ["Bearer secret-token-value", "evidence contains forbidden bearer credential"],
      [
        syntheticJwt,
        "evidence contains forbidden JWT",
      ],
      [
        "An embedded -----BEGIN ENCRYPTED PRIVATE KEY----- must never be recorded.",
        "evidence contains forbidden private key material",
      ],
      [
        "tasq_access_this-is-a-secret-access-token",
        "evidence contains forbidden Tasq access credential",
      ],
      [
        "tasq_enroll_this-is-a-secret-enrollment-token",
        "evidence contains forbidden Tasq enrollment credential",
      ],
      [
        "__Host-tasq_session=this-is-a-secret-session-cookie",
        "evidence contains forbidden Tasq session cookie",
      ],
      ["/Users/operator/private/evidence.json", "evidence contains forbidden workstation path"],
      ["/home/operator/private/evidence.json", "evidence contains forbidden workstation path"],
      ["C:\\Users\\operator\\private\\evidence.json", "evidence contains forbidden workstation path"],
    ] as const;
    for (const [value, expectedError] of vectors) {
      const evidence: any = completeEvidence();
      evidence.journey[0].note = value;
      const result = await validate(evidence);
      expect(result.exitCode).toBe(1);
      expect(result.report.errors).toContain(expectedError);
    }

    const embeddedUrl: any = completeEvidence();
    embeddedUrl.journey[0].note =
      "The participant opened https://operator:secret@example.test/evidence?token=secret#private.";
    const embeddedResult = await validate(embeddedUrl);
    expect(embeddedResult.exitCode).toBe(1);
    expect(embeddedResult.report.errors).toContain(
      "evidence contains a URL with credentials, query or fragment",
    );

    for (const value of [
      "https://operator:secret@example.test/evidence",
      "https://example.test/evidence?token=secret",
      "https://example.test/evidence#private",
    ]) {
      const evidence: any = completeEvidence();
      evidence.journey[0].evidenceRefs = [value];
      const result = await validate(evidence);
      expect(result.exitCode).toBe(1);
      expect(result.report.errors).toContain(
        "evidence contains a URL with credentials, query or fragment",
      );
      expect(result.report.errors).toContain(
        "journey[0].evidenceRefs must contain safe evidence references",
      );
    }
  });

  test("ships an intentionally non-passing template and keeps the machine certificate pending", async () => {
    const templateEvidence = JSON.parse(await readFile(template, "utf8"));
    const result = await validate(templateEvidence);
    expect(result.exitCode).toBe(1);
    expect(result.report.readyForExternalGateReview).toBe(false);

    const certificate = JSON.parse(
      await readFile(resolve(root, "docs/contracts/TQ-606_ADOPTION_CERTIFICATION.json"), "utf8"),
    );
    expect(certificate).toMatchObject({
      independentHumanEvidence: {
        status: "not-run-automated-path-only",
        sessionKitReady: true,
        certificateMutationAuthorizedByValidator: false,
      },
      tq606Complete: false,
    });
  });
});

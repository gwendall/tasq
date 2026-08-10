import { createLocalTasq, createMutableClock } from "@tasq-run/core";

const clock = createMutableClock(2_600_000_000_000);
const client = await createLocalTasq({
  url: process.env.TASQ_DB_URL,
  workspaceId: "delegated/example",
  actor: "agent:executor",
  clock,
});

try {
  const commitment = await client.commitments.create({
    title: "Verify the deployment target",
    successCriteria: "A content-addressed report is attached",
    completionPolicy: "evidence",
    validationRequired: true,
  }, { idempotencyKey: "delegated-example:commitment" });
  const contract = await client.resolution.contracts.create({
    taskId: commitment.id,
    criteria: [{
      id: "report",
      statement: "A content-addressed report is attached",
      acceptedEvidenceKinds: ["report"],
    }],
    policyKind: "attestation",
    policyUri: "urn:tasq:example:delegated-review",
    policyVersion: 1,
    implementationDigest: `sha256:${"a".repeat(64)}`,
    allowSelfValidation: true,
    eligibleValidatorPrincipalIds: [client.principalId],
  }, { idempotencyKey: "delegated-example:contract" });
  const execution = await client.journeys.claimAndStart({
    commitmentId: commitment.id,
    runtime: "example-runner",
    idempotencyKey: "delegated-example:execution",
  });
  const outcome = await client.journeys.submitOutcome({
    commitmentId: commitment.id,
    attemptId: execution.attempt.id,
    expectedAttemptRevision: 1,
    resolutionContractId: contract.id,
    artifacts: [{
      typeUri: "https://schemas.tasq.dev/artifacts/report/v1",
      schemaVersion: 1,
      name: "report.json",
      mediaType: "application/json",
      uri: "https://objects.example.test/report.json",
      digest: `sha256:${"b".repeat(64)}`,
      inlineDataRef: null,
      metadata: {},
    }],
    evidence: [{
      evidence: {
        kind: "report",
        summary: "Content-addressed report",
        uri: "https://objects.example.test/report.json",
        digest: `sha256:${"b".repeat(64)}`,
        source: "example-runner",
        metadata: {},
      },
      criterionIds: ["report"],
    }],
    summary: "Target verified",
    idempotencyKey: "delegated-example:outcome",
  });
  process.stdout.write(JSON.stringify({
    commitmentId: commitment.id,
    claimId: execution.claim.id,
    attemptId: execution.attempt.id,
    artifactId: outcome.artifacts[0].id,
    evidenceId: outcome.evidence[0].id,
    proposalId: outcome.proposal.id,
    attemptStatus: outcome.attempt.status,
  }));
} finally {
  await client.close();
}

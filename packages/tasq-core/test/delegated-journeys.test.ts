import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createLocalTasq,
  createMutableClock,
  installExtension,
  openDb,
  runKernelMigrations,
} from "../src/kernel.js";
import { setEventListener } from "../src/service/events.js";

const roots: string[] = [];

afterEach(async () => {
  setEventListener(null);
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function store(name: string) {
  const root = await mkdtemp(join(tmpdir(), `tasq-${name}-`));
  roots.push(root);
  return `file:${join(root, "db.sqlite")}`;
}

describe("TQ-623 delegated-action embedded Interface", () => {
  test("exposes assignments, artifacts, external references and effects without a second store", async () => {
    const url = await store("delegated-surface");
    const clock = createMutableClock(2_200_000_000_000);
    const bootstrap = await openDb({ url, wal: false });
    try {
      await runKernelMigrations(bootstrap.client, { clock });
      await installExtension(bootstrap.db, {
        extensionUri: "https://example.test/extensions/inspection",
        version: "1.0.0",
        types: [{
          recordKind: "effect",
          typeUri: "https://example.test/effects/capture-photo",
          schemaVersion: 1,
          schema: {
            $schema: "https://json-schema.org/draft/2020-12/schema",
            type: "object",
            additionalProperties: false,
            properties: { targetRef: { type: "string" } },
            required: ["targetRef"],
          },
        }],
        evaluators: [],
      }, { tenantId: "field/team", actor: "admin", clock });
    } finally {
      await bootstrap.close();
    }

    const assigner = await createLocalTasq({
      url, workspaceId: "field/team", actor: "dispatcher", clock, wal: false,
    });
    const assignee = await createLocalTasq({
      url, workspaceId: "field/team", actor: "technician", clock, wal: false,
    });
    try {
      const commitment = await assigner.commitments.create({
        title: "Capture cabinet photo",
        successCriteria: "Fresh image attached",
        completionPolicy: "evidence",
      }, { idempotencyKey: "surface:commitment" });
      const assignment = await assigner.assignments.propose({
        taskId: commitment.id,
        assigneePrincipalId: assignee.principalId,
        role: "owner",
        instructionsRef: "urn:instructions:cabinet-photo:v1",
      }, { idempotencyKey: "surface:assignment" });
      const accepted = await assignee.assignments.accept(assignment.id, {
        expectedRevision: assignment.revision,
      });
      expect(accepted.status).toBe("accepted");
      expect(await assigner.assignments.list({ commitmentId: commitment.id })).toHaveLength(1);

      const execution = await assignee.journeys.claimAndStart({
        commitmentId: commitment.id,
        runtime: "field-runner",
        idempotencyKey: "surface:execution",
      });
      const artifact = await assignee.artifacts.append({
        taskId: commitment.id,
        attemptId: execution.attempt.id,
        typeUri: "https://example.test/artifacts/photo",
        schemaVersion: 1,
        name: "cabinet.jpg",
        mediaType: "image/jpeg",
        uri: "https://objects.example.test/cabinet.jpg",
        digest: `sha256:${"a".repeat(64)}`,
        inlineDataRef: null,
        metadata: {},
      }, { idempotencyKey: "surface:artifact" });
      const reference = await assignee.externalReferences.append({
        recordType: "artifact",
        recordId: artifact.id,
        system: "https://objects.example.test/",
        resourceType: "object",
        externalId: "cabinet.jpg",
        url: "https://objects.example.test/cabinet.jpg",
        version: "v1",
        digest: artifact.digest,
        metadata: {},
      }, { idempotencyKey: "surface:external-ref" });
      expect(await assignee.artifacts.get(artifact.id)).toEqual(artifact);
      expect(await assignee.externalReferences.get(reference.id)).toEqual(reference);

      const effect = await assignee.effects.propose({
        taskId: commitment.id,
        attemptId: execution.attempt.id,
        request: {
          protocol: "tasq.effect-request.v1",
          canonicalization: "tasq.jcs-safe-integer.v1",
          digestAlgorithm: "sha-256",
          effectTypeUri: "https://example.test/effects/capture-photo",
          effectSchemaVersion: 1,
          connector: {
            operationUri: "https://example.test/connectors/camera/capture",
            operationVersion: 1,
            contractDigest: `sha256:${"b".repeat(64)}`,
            instanceRef: "camera:field-1",
            bindingDigest: `sha256:${"c".repeat(64)}`,
          },
          parameters: { targetRef: "cabinet:42" },
          secretBindings: [],
        },
        supersedesEffectId: null,
        compensationOfEffectId: null,
      }, { idempotencyKey: "surface:effect" });
      expect(await assignee.effects.get(effect.id)).toEqual(effect);
      expect(await assignee.effects.list({ commitmentId: commitment.id })).toEqual([effect]);
    } finally {
      await assignee.close();
      await assigner.close();
    }
  });

  test("rolls claim-and-start back as one mutation and mirrors events only after commit", async () => {
    const url = await store("claim-start-rollback");
    const clock = createMutableClock(2_300_000_000_000);
    const client = await createLocalTasq({
      url, workspaceId: "ops/team", actor: "runner", clock, wal: false,
    });
    const mirrored: string[] = [];
    setEventListener((event) => mirrored.push(event.eventType));
    try {
      const commitment = await client.commitments.create({ title: "Restart service" }, {
        idempotencyKey: "rollback:commitment",
      });
      mirrored.length = 0;
      await expect(client.journeys.claimAndStart({
        commitmentId: commitment.id,
        runtime: "",
        idempotencyKey: "rollback:execution",
      })).rejects.toThrow();
      expect(await client.claims.list(commitment.id)).toEqual([]);
      expect(await client.attempts.list(commitment.id)).toEqual([]);
      expect((await client.events.list({ entityId: commitment.id })).map((event) => event.eventType))
        .not.toContain("claim_acquired");
      expect(mirrored).toEqual([]);

      const result = await client.journeys.claimAndStart({
        commitmentId: commitment.id,
        runtime: "service-runner",
        idempotencyKey: "rollback:execution:valid",
      });
      expect(result.attempt.claimId).toBe(result.claim.id);
      expect(mirrored).toEqual(["claim_acquired", "attempt_started"]);
    } finally {
      await client.close();
    }
  });

  test("replays claim-and-start and submit-outcome across restart without duplicate rows", async () => {
    const url = await store("outcome-restart");
    const clock = createMutableClock(2_400_000_000_000);
    const open = () => createLocalTasq({
      url, workspaceId: "verification/team", actor: "executor", clock, wal: false,
    });
    const first = await open();
    let commitmentId: string;
    let contractId: string;
    let execution: Awaited<ReturnType<typeof first.journeys.claimAndStart>>;
    let submitted: Awaited<ReturnType<typeof first.journeys.submitOutcome>>;
    try {
      const commitment = await first.commitments.create({
        title: "Verify exterior",
        successCriteria: "Exterior image is fresh",
        completionPolicy: "evidence",
        validationRequired: true,
      }, { idempotencyKey: "restart:commitment" });
      commitmentId = commitment.id;
      const contract = await first.resolution.contracts.create({
        taskId: commitment.id,
        criteria: [{
          id: "fresh-photo",
          statement: "Exterior image is fresh",
          acceptedEvidenceKinds: ["photo"],
        }],
        policyKind: "attestation",
        policyUri: "urn:tasq:test:photo-review",
        policyVersion: 1,
        implementationDigest: `sha256:${"d".repeat(64)}`,
        allowSelfValidation: true,
        eligibleValidatorPrincipalIds: [first.principalId],
      }, { idempotencyKey: "restart:contract" });
      contractId = contract.id;
      execution = await first.journeys.claimAndStart({
        commitmentId,
        runtime: "field-runner",
        idempotencyKey: "restart:execution",
      });
      submitted = await first.journeys.submitOutcome({
        commitmentId,
        attemptId: execution.attempt.id,
        expectedAttemptRevision: execution.attempt.revision,
        resolutionContractId: contractId,
        artifacts: [{
          typeUri: "https://example.test/artifacts/photo",
          schemaVersion: 1,
          name: "exterior.jpg",
          mediaType: "image/jpeg",
          uri: "https://objects.example.test/exterior.jpg",
          digest: `sha256:${"e".repeat(64)}`,
          inlineDataRef: null,
          metadata: {},
        }],
        evidence: [{
          evidence: {
            kind: "photo",
            summary: "Fresh exterior image",
            uri: "https://objects.example.test/exterior.jpg",
            digest: `sha256:${"e".repeat(64)}`,
            source: "field-runner",
            metadata: {},
          },
          criterionIds: ["fresh-photo"],
        }],
        summary: "Exterior verified",
        idempotencyKey: "restart:outcome",
      });
    } finally {
      await first.close();
    }

    const second = await open();
    try {
      const replayedExecution = await second.journeys.claimAndStart({
        commitmentId,
        runtime: "field-runner",
        idempotencyKey: "restart:execution",
      });
      const replayedOutcome = await second.journeys.submitOutcome({
        commitmentId,
        attemptId: execution.attempt.id,
        expectedAttemptRevision: execution.attempt.revision,
        resolutionContractId: contractId,
        artifacts: [{
          typeUri: "https://example.test/artifacts/photo",
          schemaVersion: 1,
          name: "exterior.jpg",
          mediaType: "image/jpeg",
          uri: "https://objects.example.test/exterior.jpg",
          digest: `sha256:${"e".repeat(64)}`,
          inlineDataRef: null,
          metadata: {},
        }],
        evidence: [{
          evidence: {
            kind: "photo",
            summary: "Fresh exterior image",
            uri: "https://objects.example.test/exterior.jpg",
            digest: `sha256:${"e".repeat(64)}`,
            source: "field-runner",
            metadata: {},
          },
          criterionIds: ["fresh-photo"],
        }],
        summary: "Exterior verified",
        idempotencyKey: "restart:outcome",
      });
      expect(replayedExecution.claim.id).toBe(execution.claim.id);
      expect(replayedExecution.attempt).toMatchObject({
        id: execution.attempt.id,
        status: "succeeded",
        revision: submitted.attempt.revision,
      });
      expect(replayedOutcome).toEqual(submitted);
      expect(await second.claims.list(commitmentId)).toHaveLength(1);
      expect(await second.attempts.list(commitmentId)).toHaveLength(1);
      expect(await second.artifacts.list({ commitmentId })).toHaveLength(1);
      expect(await second.evidence.list(commitmentId)).toHaveLength(1);
      expect(await second.resolution.proposals.list(commitmentId)).toHaveLength(1);
    } finally {
      await second.close();
    }
  });

  test("rolls every outcome row back when the final proposal is invalid", async () => {
    const url = await store("outcome-rollback");
    const clock = createMutableClock(2_500_000_000_000);
    const client = await createLocalTasq({
      url, workspaceId: "verification/rollback", actor: "executor", clock, wal: false,
    });
    try {
      const commitment = await client.commitments.create({
        title: "Verify target",
        successCriteria: "Valid proof",
        completionPolicy: "evidence",
        validationRequired: true,
      }, { idempotencyKey: "outcome-rollback:commitment" });
      const contract = await client.resolution.contracts.create({
        taskId: commitment.id,
        criteria: [{ id: "valid", statement: "Valid proof", acceptedEvidenceKinds: ["proof"] }],
        policyKind: "attestation",
        policyUri: "urn:tasq:test:rollback-review",
        policyVersion: 1,
        implementationDigest: `sha256:${"f".repeat(64)}`,
        allowSelfValidation: true,
        eligibleValidatorPrincipalIds: [client.principalId],
      }, { idempotencyKey: "outcome-rollback:contract" });
      const execution = await client.journeys.claimAndStart({
        commitmentId: commitment.id,
        idempotencyKey: "outcome-rollback:execution",
      });
      await expect(client.journeys.submitOutcome({
        commitmentId: commitment.id,
        attemptId: execution.attempt.id,
        expectedAttemptRevision: execution.attempt.revision,
        resolutionContractId: contract.id,
        artifacts: [{
          typeUri: "https://example.test/artifacts/proof",
          schemaVersion: 1,
          name: "proof.json",
          mediaType: "application/json",
          uri: "https://objects.example.test/proof.json",
          digest: `sha256:${"1".repeat(64)}`,
          inlineDataRef: null,
          metadata: {},
        }],
        evidence: [{
          evidence: { kind: "proof", summary: "Candidate proof", metadata: {} },
          criterionIds: ["unknown-criterion"],
        }],
        idempotencyKey: "outcome-rollback:submit",
      })).rejects.toThrow("every frozen criterion exactly once");
      expect(await client.artifacts.list({ commitmentId: commitment.id })).toEqual([]);
      expect(await client.evidence.list(commitment.id)).toEqual([]);
      expect(await client.resolution.proposals.list(commitment.id)).toEqual([]);
      expect(await client.attempts.get(execution.attempt.id)).toMatchObject({ status: "running", revision: 1 });
    } finally {
      await client.close();
    }
  });
});

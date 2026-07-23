/** Package-installed interactive runtime fixture. No checkout-relative imports. */

import assert from "node:assert/strict";
import { createHmacEffectPermitAuthenticator, type EffectConnectorPolicy } from "@tasq-run/extension-sdk";
import type { EffectJsonObject } from "@tasq-run/schema";
import {
  acceptAssignment,
  acquireTaskClaim,
  addTaskEvidence,
  appendArtifact,
  appendExternalRef,
  authorizeEffect,
  beginEffectExecution,
  bootstrapCoordinationSpace,
  completeCommitment,
  createCommitment,
  createMutableClock,
  getActiveTaskClaim,
  getCommitment,
  getTaskAttempt,
  inspectCommitment,
  installExtension,
  listArtifacts,
  listEvents,
  listTaskAttempts,
  listTaskEvidence,
  openDb,
  proposeAssignment,
  proposeEffect,
  recordEffectApproval,
  runKernelMigrations,
  startCommitment,
  startTaskAttempt,
  transitionTaskAttempt,
} from "@tasq-run/core";

const workspaceId = "runtime/conformance";
const coordinatorActor = "runtime:coordinator";
const workerActor = "runtime:worker";
const permitIssuer = createHmacEffectPermitAuthenticator("runtime-fixture-key", "p".repeat(32));
const effectBinding = {
  effectTypeUri: "https://runtime.example.invalid/effects/comment",
  operationUri: "https://runtime.example.invalid/connectors/comment/execute",
  contractDigest: `sha256:${"c".repeat(64)}`,
  instanceRef: "connector:runtime-fixture",
  bindingDigest: `sha256:${"b".repeat(64)}`,
};

type RuntimeLookup = {
  externalId: string;
  contextId: string;
  status: "input_required";
};

type Checkpoint = {
  contractVersion: "tasq.interactive-runtime-checkpoint.v1";
  dbPath: string;
  clockNow: number;
  commitmentId: string;
  assignment: "accepted";
  firstClaim: { id: string; fence: number };
  persistedCursor: number;
  runtimeLookup: RuntimeLookup;
};

type Request =
  | { phase: "prepare"; dbPath: string }
  | { phase: "resume"; checkpoint: Checkpoint };

const chunks: Uint8Array[] = [];
for await (const chunk of Bun.stdin.stream()) chunks.push(chunk);
const request = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Request;

function effectRequest(parameters: EffectJsonObject) {
  return {
    protocol: "tasq.effect-request.v1" as const,
    canonicalization: "tasq.jcs-safe-integer.v1" as const,
    digestAlgorithm: "sha-256" as const,
    workspaceId,
    effectTypeUri: effectBinding.effectTypeUri,
    effectSchemaVersion: 1,
    connector: {
      operationUri: effectBinding.operationUri,
      operationVersion: 1,
      contractDigest: effectBinding.contractDigest,
      instanceRef: effectBinding.instanceRef,
      bindingDigest: effectBinding.bindingDigest,
    },
    parameters,
    secretBindings: [],
  };
}

const effectPolicy: EffectConnectorPolicy = {
  ...effectBinding,
  effectSchemaVersion: 1,
  operationVersion: 1,
  parseParameters(input) {
    if (input === null || Array.isArray(input) || typeof input !== "object") {
      throw new Error("effect parameters must be an object");
    }
    const value = input as EffectJsonObject;
    assert.deepEqual(Object.keys(value).sort(), ["operation", "target"]);
    return value;
  },
  evaluateAuthority({ parameters, scope, limits, verificationLevel }) {
    const allowed = verificationLevel === "cryptographic" &&
      parameters.operation === scope.operation && parameters.target === scope.target &&
      limits.maxOperations === 1;
    return {
      allowed,
      reasonCode: allowed ? "exact_runtime_fixture_authority" : "outside_runtime_fixture_authority",
      explanation: allowed ? "Exact fixture operation authorized." : "Fixture operation exceeds authority.",
    };
  },
};

async function prepare(dbPath: string): Promise<Checkpoint> {
  const clock = createMutableClock(2_000_000_000_000);
  const opened = await openDb({ url: `file:${dbPath}`, wal: false });
  try {
    await runKernelMigrations(opened.client, { clock });
    const coordinator = await bootstrapCoordinationSpace(opened.db, {
      workspaceId, actor: coordinatorActor, clock,
    });
    clock.advance(1_000);
    const worker = await bootstrapCoordinationSpace(opened.db, {
      workspaceId, actor: workerActor, clock,
    });
    clock.advance(1_000);
    await installExtension(opened.db, {
      extensionUri: "https://runtime.example.invalid/extensions/fixture-effects",
      version: "1.0.0",
      types: [{
        recordKind: "effect",
        typeUri: effectBinding.effectTypeUri,
        schemaVersion: 1,
        schema: {
          $schema: "https://json-schema.org/draft/2020-12/schema",
          type: "object",
          additionalProperties: false,
          required: ["operation", "target"],
          properties: {
            operation: { type: "string" },
            target: { type: "string" },
          },
        },
      }],
      evaluators: [],
    }, {
      tenantId: workspaceId,
      actor: workerActor,
      clock,
    });
    clock.advance(1_000);
    const commitment = await createCommitment(opened.db, {
      title: "Verify one resumable interactive runtime result",
      successCriteria: "A digest-bound runtime artifact is independently accepted as evidence",
      completionPolicy: "evidence",
    }, {
      workspaceId,
      actor: coordinatorActor,
      principalId: coordinator.principal.id,
      idempotencyKey: "runtime:commitment:1",
      clock,
    });
    clock.advance(1_000);
    const assignment = await proposeAssignment(opened.db, {
      tenantId: workspaceId,
      taskId: commitment.id,
      assignerPrincipalId: coordinator.principal.id,
      assigneePrincipalId: worker.principal.id,
      role: "contributor",
      instructionsRef: "urn:runtime-instructions:bounded-v1",
    }, {
      tenantId: workspaceId,
      actor: coordinatorActor,
      principalId: coordinator.principal.id,
      idempotencyKey: "runtime:assignment:1",
      clock,
    });
    clock.advance(1_000);
    const accepted = await acceptAssignment(opened.db, assignment.id, {
      tenantId: workspaceId,
      actor: workerActor,
      principalId: worker.principal.id,
      expectedRevision: assignment.revision,
      clock,
    });
    assert.equal(accepted.status, "accepted");

    // Claim before any autonomous lifecycle mutation.
    clock.advance(1_000);
    const firstClaim = await acquireTaskClaim(opened.db, commitment.id, {
      tenantId: workspaceId,
      actor: workerActor,
      principalId: worker.principal.id,
      leaseMs: 3_000,
      idempotencyKey: "runtime:claim:1",
      clock,
    });
    clock.advance(1_000);
    await startCommitment(opened.db, commitment.id, {
      workspaceId,
      actor: workerActor,
      principalId: worker.principal.id,
      expectedRevision: commitment.revision,
      idempotencyKey: "runtime:commitment:start:1",
      clock,
    });

    const runtimeLookup: RuntimeLookup = {
      externalId: "run-001",
      contextId: "conversation-001",
      status: "input_required",
    };
    // A lost external launch response resolves to the same externally stable run.
    const launched = new Map([[runtimeLookup.externalId, runtimeLookup]]);
    assert.strictEqual(launched.get(runtimeLookup.externalId), runtimeLookup);
    assert.equal(launched.size, 1);

    clock.advance(500);
    const attemptInput = {
      tenantId: workspaceId,
      actor: workerActor,
      principalId: worker.principal.id,
      claimId: firstClaim.id,
      runtime: "interactive:fixture-v1",
      externalId: runtimeLookup.externalId,
      contextId: runtimeLookup.contextId,
      metadata: {
        machineRef: "urn:machine:fixture-a",
        sessionRef: "urn:session:conversation-001",
      },
      idempotencyKey: "runtime:attempt:start:run-001",
      clock,
    };
    const attempt = await startTaskAttempt(opened.db, commitment.id, attemptInput);
    assert.equal((await startTaskAttempt(opened.db, commitment.id, attemptInput)).id, attempt.id);
    assert.equal((await listTaskAttempts(opened.db, commitment.id, { tenantId: workspaceId })).length, 1);
    clock.advance(500);
    await transitionTaskAttempt(opened.db, attempt.id, "input_required", {
      tenantId: workspaceId,
      actor: workerActor,
      principalId: worker.principal.id,
      expectedRevision: attempt.revision,
      message: "Operator must approve the bounded fixture result",
      idempotencyKey: "runtime:attempt:wait:run-001",
      clock,
    });
    const events = await listEvents(opened.db, { tenantId: workspaceId, ascending: true });
    const persistedCursor = events.at(-1)?.sequence ?? 0;
    assert(persistedCursor > 0);
    return {
      contractVersion: "tasq.interactive-runtime-checkpoint.v1",
      dbPath,
      clockNow: clock.now(),
      commitmentId: commitment.id,
      assignment: "accepted",
      firstClaim: { id: firstClaim.id, fence: firstClaim.fence },
      persistedCursor,
      runtimeLookup,
    };
  } finally {
    await opened.close();
  }
}

async function resume(checkpoint: Checkpoint) {
  assert.equal(checkpoint.contractVersion, "tasq.interactive-runtime-checkpoint.v1");
  assert.equal(typeof checkpoint.persistedCursor, "number");
  // Authority advances only through the persisted injected clock, never device time.
  const clock = createMutableClock(checkpoint.clockNow + 2_000);
  const opened = await openDb({ url: `file:${checkpoint.dbPath}`, wal: false });
  try {
    await runKernelMigrations(opened.client, { clock });
    const coordinator = await bootstrapCoordinationSpace(opened.db, {
      workspaceId, actor: coordinatorActor, clock,
    });
    const worker = await bootstrapCoordinationSpace(opened.db, {
      workspaceId, actor: workerActor, clock,
    });
    assert.equal(
      await getActiveTaskClaim(opened.db, checkpoint.commitmentId, workspaceId, clock.now()),
      null,
    );
    const attemptsBeforeResume = await listTaskAttempts(opened.db, checkpoint.commitmentId, {
      tenantId: workspaceId,
    });
    const firstAttempt = attemptsBeforeResume.find(
      (item) => item.externalId === checkpoint.runtimeLookup.externalId,
    );
    assert(firstAttempt);
    assert.equal(firstAttempt.contextId, checkpoint.runtimeLookup.contextId);
    assert.equal((await getTaskAttempt(opened.db, firstAttempt.id, workspaceId))?.status, "input_required");

    const replacementClaim = await acquireTaskClaim(opened.db, checkpoint.commitmentId, {
      tenantId: workspaceId,
      actor: workerActor,
      principalId: worker.principal.id,
      leaseMs: 20_000,
      idempotencyKey: "runtime:claim:replacement:1",
      clock,
    });
    assert(replacementClaim.fence > checkpoint.firstClaim.fence);
    await assert.rejects(
      startTaskAttempt(opened.db, checkpoint.commitmentId, {
        tenantId: workspaceId,
        actor: workerActor,
        principalId: worker.principal.id,
        claimId: checkpoint.firstClaim.id,
        runtime: "interactive:fixture-v1",
        externalId: "stale-authority-run",
        contextId: checkpoint.runtimeLookup.contextId,
        idempotencyKey: "runtime:attempt:stale-claim",
        clock,
      }),
      /not active/,
    );

    clock.advance(1_000);
    const resumed = await transitionTaskAttempt(opened.db, firstAttempt.id, "running", {
      tenantId: workspaceId,
      actor: workerActor,
      principalId: worker.principal.id,
      expectedRevision: firstAttempt.revision,
      message: "Operator approved the bounded result",
      idempotencyKey: "runtime:attempt:resume:run-001",
      clock,
    });
    clock.advance(1_000);
    const succeeded = await transitionTaskAttempt(opened.db, firstAttempt.id, "succeeded", {
      tenantId: workspaceId,
      actor: workerActor,
      principalId: worker.principal.id,
      expectedRevision: resumed.revision,
      message: "Runtime result is ready for independent verification",
      idempotencyKey: "runtime:attempt:succeed:run-001",
      clock,
    });
    assert.equal((await getCommitment(opened.db, checkpoint.commitmentId, workspaceId))?.status, "in_progress");
    await assert.rejects(
      transitionTaskAttempt(opened.db, firstAttempt.id, "running", {
        tenantId: workspaceId,
        actor: workerActor,
        principalId: worker.principal.id,
        expectedRevision: succeeded.revision,
        idempotencyKey: "runtime:attempt:illegal-reopen:run-001",
        clock,
      }),
      /terminal.*immutable/,
    );

    clock.advance(1_000);
    const artifact = await appendArtifact(opened.db, {
      tenantId: workspaceId,
      taskId: checkpoint.commitmentId,
      attemptId: firstAttempt.id,
      typeUri: "https://tasq.dev/artifacts/runtime-result/v1",
      name: "result.json",
      mediaType: "application/json",
      uri: "https://runtime.example.invalid/artifacts/result-001",
      digest: `sha256:${"a".repeat(64)}`,
    }, {
      tenantId: workspaceId,
      actor: workerActor,
      principalId: worker.principal.id,
      idempotencyKey: "runtime:artifact:run-001",
      clock,
    });
    await appendExternalRef(opened.db, {
      tenantId: workspaceId,
      recordType: "attempt",
      recordId: firstAttempt.id,
      system: "https://runtime.example.invalid",
      resourceType: "conversation-run",
      externalId: `${checkpoint.runtimeLookup.contextId}/${checkpoint.runtimeLookup.externalId}`,
      url: "https://runtime.example.invalid/runs/run-001",
      version: "1",
    }, {
      tenantId: workspaceId,
      actor: workerActor,
      principalId: worker.principal.id,
      idempotencyKey: "runtime:external-ref:run-001",
      clock,
    });

    // A second run reuses the conversation but never the attempt identity.
    clock.advance(1_000);
    const secondAttempt = await startTaskAttempt(opened.db, checkpoint.commitmentId, {
      tenantId: workspaceId,
      actor: workerActor,
      principalId: worker.principal.id,
      claimId: replacementClaim.id,
      runtime: "interactive:fixture-v1",
      externalId: "run-002",
      contextId: checkpoint.runtimeLookup.contextId,
      idempotencyKey: "runtime:attempt:start:run-002",
      clock,
    });

    // The protected dispatch gate rejects both an expired claim and a stale fence.
    clock.advance(1_000);
    const proposed = await proposeEffect(opened.db, {
      tenantId: workspaceId,
      taskId: checkpoint.commitmentId,
      attemptId: secondAttempt.id,
      request: effectRequest({ operation: "comment", target: "fixture" }),
    }, {
      tenantId: workspaceId,
      actor: workerActor,
      principalId: worker.principal.id,
      idempotencyKey: "runtime:effect:propose:run-002",
      clock,
    });
    clock.advance(1_000);
    const approval = await recordEffectApproval(opened.db, {
      tenantId: workspaceId,
      effectId: proposed.id,
      decision: "approved",
      scope: { operation: "comment", target: "fixture" },
      limits: { maxOperations: 1 },
      expiresAt: clock.now() + 10_000,
    }, {
      tenantId: workspaceId,
      actor: coordinatorActor,
      principalId: coordinator.principal.id,
      authorityVerification: {
        level: "cryptographic",
        method: "runtime-fixture-approval",
        details: { keyId: "operator-key:fixture" },
      },
      clock,
    });
    clock.advance(1_000);
    const authorized = await authorizeEffect(opened.db, proposed.id, approval.id, {
      tenantId: workspaceId,
      actor: workerActor,
      principalId: worker.principal.id,
      expectedRevision: proposed.revision,
      clock,
    });
    await assert.rejects(beginEffectExecution(opened.db, authorized.id, {
      tenantId: workspaceId,
      actor: workerActor,
      principalId: worker.principal.id,
      expectedRevision: authorized.revision,
      claimId: checkpoint.firstClaim.id,
      fence: checkpoint.firstClaim.fence,
      policy: effectPolicy,
      permitIssuer,
      clock,
    }), /running attempt bound|live claim/);
    await assert.rejects(beginEffectExecution(opened.db, authorized.id, {
      tenantId: workspaceId,
      actor: workerActor,
      principalId: worker.principal.id,
      expectedRevision: authorized.revision,
      claimId: replacementClaim.id,
      fence: checkpoint.firstClaim.fence,
      policy: effectPolicy,
      permitIssuer,
      clock,
    }), /live claim fence/);

    clock.advance(1_000);
    await transitionTaskAttempt(opened.db, secondAttempt.id, "succeeded", {
      tenantId: workspaceId,
      actor: workerActor,
      principalId: worker.principal.id,
      expectedRevision: secondAttempt.revision,
      idempotencyKey: "runtime:attempt:succeed:run-002",
      clock,
    });
    const attempts = await listTaskAttempts(opened.db, checkpoint.commitmentId, {
      tenantId: workspaceId,
    });
    assert.equal(attempts.length, 2);
    assert.equal(new Set(attempts.map((item) => item.contextId)).size, 1);
    assert.equal(new Set(attempts.map((item) => item.externalId)).size, 2);

    clock.advance(1_000);
    const evidence = await addTaskEvidence(opened.db, {
      tenantId: workspaceId,
      taskId: checkpoint.commitmentId,
      attemptId: firstAttempt.id,
      kind: "runtime-result-verification",
      summary: "Digest-bound fixture result passed independent verification",
      uri: artifact.uri,
      digest: artifact.digest,
      source: "runtime:verifier",
      observedAt: clock.now(),
    }, {
      tenantId: workspaceId,
      actor: coordinatorActor,
      principalId: coordinator.principal.id,
      idempotencyKey: "runtime:evidence:run-001",
      clock,
    });
    assert.notEqual(evidence.id, artifact.id);
    assert.equal((await listArtifacts(opened.db, {
      tenantId: workspaceId, taskId: checkpoint.commitmentId,
    })).length, 1);
    assert.equal((await listTaskEvidence(opened.db, checkpoint.commitmentId, {
      tenantId: workspaceId,
    })).length, 1);
    const preCompletion = await inspectCommitment(opened.db, checkpoint.commitmentId, {
      workspaceId, clock,
    });
    assert(preCompletion);
    assert.equal(preCompletion.commitment.status, "in_progress");
    clock.advance(1_000);
    const completed = await completeCommitment(opened.db, checkpoint.commitmentId, {
      workspaceId,
      actor: coordinatorActor,
      principalId: coordinator.principal.id,
      expectedRevision: preCompletion.commitment.revision,
      evidenceIds: [evidence.id],
      idempotencyKey: "runtime:commitment:complete:1",
      clock,
    });
    assert.equal(completed.status, "done");
    const delta = await listEvents(opened.db, {
      tenantId: workspaceId,
      afterSequence: checkpoint.persistedCursor,
      ascending: true,
    });
    assert(delta.length > 0);
    assert(delta.every((event) => event.sequence > checkpoint.persistedCursor));
    const finalInspection = await inspectCommitment(opened.db, checkpoint.commitmentId, {
      workspaceId, clock,
    });
    assert(finalInspection);
    const serialized = JSON.stringify(finalInspection);
    assert(!serialized.includes("secret-token"));
    assert(!serialized.includes("raw terminal bytes"));
    return {
      contractVersion: "tasq.interactive-runtime-candidate.v1",
      status: "candidate-certified-publication-gate-pending",
      workspaceId,
      assignment: checkpoint.assignment,
      processRestarts: 1,
      attempts: attempts.length,
      conversations: new Set(attempts.map((item) => item.contextId)).size,
      runs: 2,
      firstClaimFence: checkpoint.firstClaim.fence,
      replacementClaimFence: replacementClaim.fence,
      staleClaimRejected: true,
      staleEffectClaimRejected: true,
      staleEffectFenceRejected: true,
      artifactDistinctFromEvidence: artifact.id !== evidence.id,
      resumedAfterSequence: checkpoint.persistedCursor,
      finalStatus: finalInspection.commitment.status,
    };
  } finally {
    await opened.close();
  }
}

if (request.phase === "prepare") {
  process.stdout.write(`${JSON.stringify(await prepare(request.dbPath))}\n`);
} else {
  process.stdout.write(`${JSON.stringify(await resume(request.checkpoint))}\n`);
}

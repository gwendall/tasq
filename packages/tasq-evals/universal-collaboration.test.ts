/**
 * Eval: two previously unrelated principals coordinate one durable outcome
 * without sharing a runtime, provider ontology or life-planning hierarchy.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acceptAssignment,
  acquireTaskClaim,
  addTaskEvidence,
  appendArtifact,
  appendExternalRef,
  completeCommitment,
  createCommitment,
  createPrincipal,
  listArtifacts,
  listAssignments,
  listCompletionRecords,
  listEvents,
  openDb,
  proposeAssignment,
  runKernelMigrations,
  startTaskAttempt,
  transitionTaskAttempt,
} from "@tasq-run/core";

const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length > 0) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

describe("universal collaboration", () => {
  it("hands an evidence-backed outcome across runtimes without conflating delegation, execution or completion", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tasq-universal-collaboration-"));
    tmpDirs.push(dir);
    const { db, client, close } = await openDb({ url: `file:${join(dir, "db.sqlite")}`, wal: false });
    try {
      await runKernelMigrations(client, { now: 1_000 });
      const coordinator = await createPrincipal(db, {
        displayName: "Research coordinator",
        kind: "human",
      }, { now: 1_100 });
      const worker = await createPrincipal(db, {
        displayName: "Unfamiliar remote runtime",
        kind: "runtime",
      }, { now: 1_200 });

      const commitment = await createCommitment(db, {
        title: "Establish the material's measured yield strength",
        successCriteria: "A digest-bound signed lab report is attached",
        completionPolicy: "evidence",
      }, {
        workspaceId: "gwendall",
        actor: "coordinator-session",
        principalId: coordinator.id,
        now: 1_300,
      });

      const proposed = await proposeAssignment(db, {
        taskId: commitment.id,
        assignerPrincipalId: coordinator.id,
        assigneePrincipalId: worker.id,
        role: "contributor",
        instructionsRef: "urn:example:work-packet:yield-test-v1",
      }, {
        principalId: coordinator.id,
        actor: "coordinator-session",
        idempotencyKey: "yield-assignment",
        now: 1_400,
      });
      expect((await listAssignments(db, { taskId: commitment.id }))[0]).toMatchObject({
        status: "proposed",
      });

      const accepted = await acceptAssignment(db, proposed.id, {
        principalId: worker.id,
        actor: "remote-session-7",
        expectedRevision: 1,
        now: 1_500,
      });
      expect(accepted.status).toBe("accepted");

      const claim = await acquireTaskClaim(db, commitment.id, {
        principalId: worker.id,
        actor: "remote-session-7",
        leaseMs: 10_000,
        idempotencyKey: "yield-claim",
        now: 1_600,
      });
      const attempt = await startTaskAttempt(db, commitment.id, {
        principalId: worker.id,
        actor: "remote-session-7",
        claimId: claim.id,
        runtime: "a2a",
        externalId: "remote-task-42",
        contextId: "remote-context-9",
        idempotencyKey: "yield-attempt",
        occurredAt: 1_700,
      });
      const report = await appendArtifact(db, {
        taskId: commitment.id,
        attemptId: attempt.id,
        typeUri: "https://schemas.example.test/lab-report",
        name: "yield-strength.json",
        mediaType: "application/json",
        uri: "https://lab.example.test/reports/42",
        digest: "sha256:lab-report-42",
      }, {
        principalId: worker.id,
        actor: "remote-session-7",
        idempotencyKey: "yield-artifact",
        now: 1_800,
      });
      await appendExternalRef(db, {
        recordType: "artifact",
        recordId: report.id,
        system: "https://lab.example.test",
        resourceType: "signed-report",
        externalId: "report-42",
        version: "1",
        digest: report.digest,
      }, {
        principalId: worker.id,
        actor: "remote-session-7",
        idempotencyKey: "yield-external-ref",
        now: 1_900,
      });
      await transitionTaskAttempt(db, attempt.id, "succeeded", {
        principalId: worker.id,
        actor: "remote-session-7",
        expectedRevision: attempt.revision,
        occurredAt: 2_000,
      });

      // Execution success and an artifact still do not complete the outcome.
      expect((await listCompletionRecords(db, commitment.id))).toHaveLength(0);
      expect(await listArtifacts(db, { taskId: commitment.id })).toHaveLength(1);
      const evidence = await addTaskEvidence(db, {
        taskId: commitment.id,
        attemptId: attempt.id,
        kind: "signed_lab_observation",
        summary: "Independent lab signed the measured yield-strength report",
        uri: report.uri,
        digest: report.digest,
        source: "https://lab.example.test",
        observedAt: 2_100,
      }, {
        principalId: coordinator.id,
        actor: "coordinator-session",
        idempotencyKey: "yield-evidence",
        now: 2_100,
      });
      const done = await completeCommitment(db, commitment.id, {
        workspaceId: "gwendall",
        actor: "coordinator-session",
        principalId: coordinator.id,
        expectedRevision: commitment.revision,
        evidenceIds: [evidence.id],
        occurredAt: 2_200,
        now: 2_200,
      });

      expect(done).toMatchObject({ status: "done", revision: 2 });
      expect((await listAssignments(db, { taskId: commitment.id }))[0]?.status).toBe("accepted");
      expect((await listCompletionRecords(db, commitment.id))[0]).toMatchObject({
        resultingRevision: 2,
        evidenceIds: [evidence.id],
        decidedByPrincipalId: coordinator.id,
      });
      const events = await listEvents(db, { entityId: commitment.id, ascending: true });
      expect(events.find((event) => event.eventType === "attempt_succeeded")?.principalId).toBe(worker.id);
      expect(events.find((event) => event.eventType === "completed")?.principalId).toBe(coordinator.id);
    } finally {
      await close();
    }
  });
});

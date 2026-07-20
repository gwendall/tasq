import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { artifact as artifactTable } from "@tasq/schema";
import {
  acceptAssignment,
  addCommitmentRelation,
  appendArtifact,
  appendExternalRef,
  completeCommitment,
  createCommitment,
  createPrincipal,
  endCommitmentRelation,
  getCommitment,
  listAssignments,
  listCommitmentRelations,
  listCompletionRecords,
  listEvents,
  localPrincipalId,
  openDb,
  proposeAssignment,
  releaseAssignment,
  reopenCommitment,
  runKernelMigrations,
  startTaskAttempt,
} from "../src/kernel.js";
import { dependTask, diagnoseStore, listDependencies, undependTask } from "../src/index.js";

const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length > 0) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

async function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "tasq-collab-"));
  tmpDirs.push(dir);
  const handle = await openDb({ url: `file:${join(dir, "db.sqlite")}`, wal: false });
  await runKernelMigrations(handle.client, { now: 10_000 });
  return handle;
}

describe("universal collaboration records", () => {
  it("keeps assignment, claim/execution and commitment state independent", async () => {
    const { db, close } = await freshDb();
    try {
      const assigner = await createPrincipal(db, {
        displayName: "Coordinator",
        kind: "agent",
        localAlias: "coordinator",
      }, { now: 11_000 });
      const worker = await createPrincipal(db, {
        displayName: "Robot worker",
        kind: "runtime",
      }, { now: 12_000, idempotencyKey: "principal-worker" });
      const workerRetry = await createPrincipal(db, {
        displayName: "Robot worker",
        kind: "runtime",
      }, { now: 12_500, idempotencyKey: "principal-worker" });
      expect(workerRetry.id).toBe(worker.id);
      const commitment = await createCommitment(db, {
        title: "Inspect joint torque",
        successCriteria: "Signed measurement artifact exists",
      }, { workspaceId: "gwendall", actor: "coordinator", now: 13_000 });

      const proposed = await proposeAssignment(db, {
        taskId: commitment.id,
        assignerPrincipalId: assigner.id,
        assigneePrincipalId: worker.id,
        role: "contributor",
        instructionsRef: "urn:instructions:torque-v1",
      }, {
        principalId: assigner.id,
        actor: "coordinator",
        now: 14_000,
        idempotencyKey: "assignment-1",
      });
      const retried = await proposeAssignment(db, {
        taskId: commitment.id,
        assignerPrincipalId: assigner.id,
        assigneePrincipalId: worker.id,
        role: "contributor",
        instructionsRef: "urn:instructions:torque-v1",
      }, {
        principalId: assigner.id,
        actor: "coordinator",
        now: 15_000,
        idempotencyKey: "assignment-1",
      });
      expect(retried.id).toBe(proposed.id);

      await expect(acceptAssignment(db, proposed.id, {
        principalId: assigner.id,
        expectedRevision: 1,
        now: 16_000,
      })).rejects.toThrow(/Only the assignee/);

      const accepted = await acceptAssignment(db, proposed.id, {
        principalId: worker.id,
        expectedRevision: 1,
        now: 17_000,
      });
      expect(accepted).toMatchObject({ status: "accepted", revision: 2 });
      expect(await acceptAssignment(db, proposed.id, {
        principalId: worker.id,
        expectedRevision: 1,
        now: 18_000,
      })).toEqual(accepted);
      await expect(releaseAssignment(db, proposed.id, {
        principalId: worker.id,
        expectedRevision: 1,
        now: 18_500,
      })).rejects.toThrow(/Stale assignment revision/);
      expect((await getCommitment(db, commitment.id, "gwendall"))?.status).toBe("open");
      expect(await listAssignments(db, { taskId: commitment.id })).toHaveLength(1);

      const events = await listEvents(db, { entityId: commitment.id, ascending: true });
      expect(events.at(-1)).toMatchObject({
        eventType: "assignment_accepted",
        principalId: worker.id,
      });
    } finally {
      await close();
    }
  });

  it("guards canonical relations with direction, cycles, revisions and tombstones", async () => {
    const { db, client, close } = await freshDb();
    try {
      const context = { workspaceId: "gwendall", actor: "planner" };
      const a = await createCommitment(db, { title: "A" }, context);
      const b = await createCommitment(db, { title: "B" }, context);
      const c = await createCommitment(db, { title: "C" }, context);
      const ab = await addCommitmentRelation(db, {
        fromTaskId: a.id,
        relationType: "depends_on",
        toTaskId: b.id,
      }, { actor: "planner", now: 20_000 });
      expect(await listDependencies(db, { taskId: a.id, direction: "from" })).toMatchObject([
        { id: ab.id, type: "blocks", toTaskId: b.id },
      ]);
      await addCommitmentRelation(db, {
        fromTaskId: b.id,
        relationType: "depends_on",
        toTaskId: c.id,
      }, { actor: "planner", now: 21_000 });
      await expect(addCommitmentRelation(db, {
        fromTaskId: c.id,
        relationType: "depends_on",
        toTaskId: a.id,
      }, { actor: "planner", now: 22_000 })).rejects.toThrow(/cycle/);
      await expect(endCommitmentRelation(db, ab.id, {
        actor: "planner",
        expectedRevision: 99,
        now: 23_000,
      })).rejects.toThrow(/Stale relation revision/);
      const ended = await endCommitmentRelation(db, ab.id, {
        actor: "planner",
        expectedRevision: 1,
        now: 24_000,
      });
      expect(ended).toMatchObject({ revision: 2, endedAt: 24_000 });
      expect(await listDependencies(db, { taskId: a.id, direction: "from" })).toHaveLength(0);
      expect(await listCommitmentRelations(db, { commitmentId: a.id, activeOnly: true })).toHaveLength(0);

      const legacy = await dependTask(db, {
        fromTaskId: a.id,
        toTaskId: b.id,
        type: "blocks",
      }, { actor: "legacy-planner", now: 25_000 });
      expect(await listCommitmentRelations(db, { commitmentId: a.id, activeOnly: true })).toHaveLength(1);
      await undependTask(db, legacy.id, { actor: "legacy-planner", now: 26_000 });
      expect(await listCommitmentRelations(db, { commitmentId: a.id, activeOnly: true })).toHaveLength(0);
      expect(await diagnoseStore(db, client)).toMatchObject({ ok: true, issues: [] });
    } finally {
      await close();
    }
  });

  it("stores immutable, digest-bound artifacts and stable external identities", async () => {
    const { db, client, close } = await freshDb();
    try {
      const commitment = await createCommitment(db, { title: "Produce report" }, {
        workspaceId: "gwendall",
        actor: "researcher",
      });
      const attempt = await startTaskAttempt(db, commitment.id, {
        actor: "researcher",
        occurredAt: 30_000,
      });
      const artifact = await appendArtifact(db, {
        taskId: commitment.id,
        attemptId: attempt.id,
        typeUri: "https://example.test/artifacts/report",
        name: "report.pdf",
        mediaType: "application/pdf",
        uri: "https://store.example/report-v1.pdf",
        digest: "sha256:abc123",
      }, { actor: "researcher", now: 31_000, idempotencyKey: "artifact-1" });
      const retry = await appendArtifact(db, {
        taskId: commitment.id,
        attemptId: attempt.id,
        typeUri: "https://example.test/artifacts/report",
        name: "report.pdf",
        mediaType: "application/pdf",
        uri: "https://store.example/report-v1.pdf",
        digest: "sha256:abc123",
      }, { actor: "researcher", now: 32_000, idempotencyKey: "artifact-1" });
      expect(retry.id).toBe(artifact.id);
      await expect(Promise.resolve(db.update(artifactTable).set({ digest: "sha256:tampered" })
        .where((await import("drizzle-orm")).eq(artifactTable.id, artifact.id))))
        .rejects.toThrow(/artifacts are immutable/);

      const external = await appendExternalRef(db, {
        recordType: "artifact",
        recordId: artifact.id,
        system: "https://github.com",
        resourceType: "pull-request",
        externalId: "acme/repo#42",
        url: "https://github.com/acme/repo/pull/42",
        version: "deadbeef",
        digest: "sha256:abc123",
      }, { actor: "researcher", now: 33_000, idempotencyKey: "ref-1" });
      expect(external.recordId).toBe(artifact.id);
      await expect(appendExternalRef(db, {
        recordType: "commitment",
        recordId: commitment.id,
        system: "https://github.com",
        resourceType: "pull-request",
        externalId: "acme/repo#42",
      }, { actor: "researcher", now: 34_000 })).rejects.toThrow(/UNIQUE/);
      expect(await client.execute("PRAGMA foreign_key_check")).toMatchObject({ rows: [] });
    } finally {
      await close();
    }
  });

  it("requires optimistic revisions and retains every completion basis", async () => {
    const { db, close } = await freshDb();
    try {
      const created = await createCommitment(db, { title: "Calibrate arm" }, {
        workspaceId: "gwendall",
        actor: "operator",
      });
      expect(created.revision).toBe(1);
      const done = await completeCommitment(db, created.id, {
        workspaceId: "gwendall",
        actor: "operator",
        expectedRevision: 1,
        occurredAt: 40_000,
      });
      expect(done.revision).toBe(2);
      expect(await listCompletionRecords(db, created.id)).toHaveLength(1);
      await expect(reopenCommitment(db, created.id, {
        workspaceId: "gwendall",
        actor: "operator",
        expectedRevision: 1,
      })).rejects.toThrow(/Stale task revision/);
      const reopened = await reopenCommitment(db, created.id, {
        workspaceId: "gwendall",
        actor: "operator",
        expectedRevision: 2,
      });
      const doneAgain = await completeCommitment(db, created.id, {
        workspaceId: "gwendall",
        actor: "operator",
        expectedRevision: reopened.revision,
        occurredAt: 50_000,
      });
      const completions = await listCompletionRecords(db, created.id);
      expect(doneAgain.revision).toBe(4);
      expect(completions.map((record) => record.resultingRevision)).toEqual([2, 4]);
      expect(new Set(completions.map((record) => record.policyInputDigest)).size).toBe(2);
      expect(completions.every((record) => record.decidedByPrincipalId === localPrincipalId("gwendall", "operator"))).toBe(true);
    } finally {
      await close();
    }
  });
});

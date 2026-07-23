import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalTasq, createMutableClock } from "../src/kernel.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("createLocalTasq", () => {
  test("owns initialization and preserves the canonical loop across restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "tasq-local-client-"));
    roots.push(root);
    const url = `file:${join(root, "db.sqlite")}`;
    const clock = createMutableClock(2_000_000_000_000);
    const first = await createLocalTasq({
      url,
      workspaceId: "robotics/team-a",
      actor: "agent:builder",
      clock,
      wal: false,
    });

    let commitmentId: string;
    try {
      expect(first.bootstrap.disposition).toBe("created");
      expect(first.migration.afterFormat).toBeGreaterThan(0);

      const created = await first.commitments.create({
        title: "Calibrate the left arm",
        successCriteria: "Calibration report attached",
        completionPolicy: "evidence",
      }, { idempotencyKey: "commitment:create:calibrate-left" });
      commitmentId = created.id;

      clock.advance(1_000);
      const started = await first.commitments.start(created.id, {
        expectedRevision: created.revision,
        idempotencyKey: "commitment:start:calibrate-left",
      });
      const claim = await first.claims.acquire(created.id, {
        leaseMs: 30_000,
        idempotencyKey: "claim:calibrate-left",
      });
      const attempt = await first.attempts.start(created.id, {
        claimId: claim.id,
        runtime: "test",
        idempotencyKey: "attempt:calibrate-left",
      });

      clock.advance(1_000);
      const evidence = await first.evidence.add({
        taskId: created.id,
        attemptId: attempt.id,
        kind: "report",
        summary: "All joints within tolerance",
      }, { idempotencyKey: "evidence:calibrate-left" });
      const succeeded = await first.attempts.transition(attempt.id, "succeeded", {
        expectedRevision: attempt.revision,
        idempotencyKey: "attempt:succeeded:calibrate-left",
      });
      expect(succeeded.status).toBe("succeeded");

      clock.advance(1_000);
      const done = await first.commitments.complete(created.id, {
        expectedRevision: started.revision,
        evidenceIds: [evidence.id],
        idempotencyKey: "commitment:complete:calibrate-left",
      });
      expect(done.status).toBe("done");

      const lease = await first.resources.acquire("robotics/arm:left", {
        leaseMs: 30_000,
        idempotencyKey: "resource:arm-left",
      });
      expect(await first.resources.verify("robotics/arm:left", {
        leaseId: lease.lease.id,
        fence: lease.lease.fence,
      })).toMatchObject({ status: "valid", resourceKey: "robotics/arm:left" });
      await first.resources.release("robotics/arm:left", {
        leaseId: lease.lease.id,
        fence: lease.lease.fence,
        expectedRevision: lease.lease.revision,
        idempotencyKey: "resource:arm-left:release",
      });

      const snapshot = await first.inspect(created.id);
      expect(snapshot).toMatchObject({
        commitment: { id: created.id, status: "done" },
        attempts: [{ id: attempt.id, status: "succeeded" }],
        evidence: [{ id: evidence.id }],
      });
      const page = await first.cursors.events(0, { limit: 100 });
      expect(page.events.length).toBeGreaterThan(0);
      expect(page.nextCursor.afterSequence).toBe(page.events.at(-1)?.sequence);
      expect((await first.cursors.resources(0)).events.length).toBe(2);
    } finally {
      await first.close();
    }

    clock.advance(1_000);
    const reopened = await createLocalTasq({
      url,
      workspaceId: "robotics/team-a",
      actor: "agent:builder",
      clock,
      wal: false,
    });
    try {
      expect(reopened.bootstrap.disposition).toBe("joined");
      expect(reopened.migration.applied).toEqual([]);
      expect(await reopened.commitments.get(commitmentId!)).toMatchObject({
        id: commitmentId!,
        status: "done",
      });
      expect(await reopened.commitments.list({ status: "done" })).toHaveLength(1);
    } finally {
      await reopened.close();
    }
  });

  test("rejects missing explicit rendezvous inputs before opening a store", async () => {
    const clock = createMutableClock(1);
    await expect(createLocalTasq({
      url: "",
      workspaceId: "space",
      actor: "agent",
      clock,
    })).rejects.toThrow("url is required");
    await expect(createLocalTasq({
      url: "file:/tmp/should-not-be-created.sqlite",
      workspaceId: "",
      actor: "agent",
      clock,
    })).rejects.toThrow("workspaceId is required");
  });

  test("exposes the complete validated-completion chain to embedded applications", async () => {
    const root = await mkdtemp(join(tmpdir(), "tasq-local-resolution-"));
    roots.push(root);
    const url = `file:${join(root, "db.sqlite")}`;
    const clock = createMutableClock(2_100_000_000_000);
    const worker = await createLocalTasq({
      url, workspaceId: "research/lab", actor: "worker", clock, wal: false,
    });
    const reviewer = await createLocalTasq({
      url, workspaceId: "research/lab", actor: "reviewer", clock, wal: false,
    });
    try {
      const commitment = await worker.commitments.create({
        title: "Verify result",
        successCriteria: "Result artifact exists",
        completionPolicy: "evidence",
        validationRequired: true,
      }, { idempotencyKey: "result:create" });
      const evidence = await worker.evidence.add({
        taskId: commitment.id,
        kind: "artifact",
        summary: "Result artifact exists",
      }, { idempotencyKey: "result:evidence" });
      const trust = await worker.resolution.trust.attest({
        taskId: commitment.id,
        evidenceId: evidence.id,
        authenticity: "unverified",
        authorityUri: "urn:tasq:authority:local-attribution",
        authorityVersion: 1,
        authorityDigest: `sha256:${"3".repeat(64)}`,
        reason: "Local attribution only",
        verifiedAt: clock.now(),
      }, { idempotencyKey: "result:trust" });
      const contract = await worker.resolution.contracts.create({
        taskId: commitment.id,
        criteria: [{
          id: "artifact",
          statement: "Result artifact exists",
          acceptedEvidenceKinds: ["artifact"],
        }],
        policyKind: "attestation",
        policyUri: "urn:tasq:test:embedded-attestation",
        policyVersion: 1,
        implementationDigest: `sha256:${"4".repeat(64)}`,
        eligibleValidatorPrincipalIds: [reviewer.principalId],
      }, { idempotencyKey: "result:contract" });
      const proposal = await worker.resolution.proposals.create({
        taskId: commitment.id,
        resolutionContractId: contract.id,
        criterionEvidence: [{ criterionId: "artifact", evidenceIds: [evidence.id] }],
      }, { idempotencyKey: "result:proposal" });
      const decision = await reviewer.resolution.decisions.attest({
        proposalId: proposal.id,
        outcome: "accepted",
        reasonCode: "verified",
        explanation: "Independent reviewer accepted the evidence",
      }, { idempotencyKey: "result:decision" });
      const done = await worker.commitments.complete(commitment.id, {
        expectedRevision: commitment.revision,
        validationDecisionId: decision.id,
        idempotencyKey: "result:complete",
      });
      expect(done.status).toBe("done");
      expect(await worker.resolution.inspect(contract.id)).toMatchObject({
        trustRecords: [{ id: trust.id }],
        proposals: [{ id: proposal.id }],
        decisions: [{ id: decision.id, outcome: "accepted" }],
      });
    } finally {
      await reviewer.close();
      await worker.close();
    }
  });
});

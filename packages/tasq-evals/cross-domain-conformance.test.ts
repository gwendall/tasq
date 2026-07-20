/**
 * UK-007: black-box cross-domain conformance.
 *
 * The scenarios deliberately use only the public embedded service surface and
 * one migrated store. Domain differences are data and reference-extension
 * types; they never change the kernel schema. Every time value is injected.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acceptAssignment,
  acquireTaskClaim,
  addCommitmentRelation,
  addTaskEvidence,
  appendArtifact,
  completeCommitment,
  createCommitment,
  createPrincipal,
  createWaitCondition,
  evaluateWaitConditionDeadline,
  getCommitment,
  ingestObservation,
  listCompletionRecords,
  listEvents,
  listTaskAttempts,
  openDb,
  proposeAssignment,
  reconcileWaitObservation,
  reopenCommitment,
  runMigrations,
  startTaskAttempt,
  transitionTaskAttempt,
} from "@tasq-internal/local-service";

const workspaceId = "uk-007-conformance";
const tmpDirs: string[] = [];

afterEach(() => {
  while (tmpDirs.length > 0) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

async function schemaFingerprint(client: Awaited<ReturnType<typeof openDb>>["client"]) {
  const result = await client.execute(`
    SELECT type, name, tbl_name, sql
    FROM sqlite_master
    WHERE name NOT LIKE 'sqlite_%'
    ORDER BY type, name
  `);
  return JSON.stringify(result.rows);
}

function principalContext(principalId: string, actor: string, now: number) {
  return { tenantId: workspaceId, principalId, actor, now };
}

describe("UK-007 cross-domain conformance", () => {
  it("runs software, research and operations narratives on one unchanged schema", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tasq-uk-007-"));
    tmpDirs.push(dir);
    const handle = await openDb({ url: `file:${join(dir, "db.sqlite")}`, wal: false });
    const { db, client, close } = handle;
    try {
      await runMigrations(client, { now: 1_000 });
      const baselineSchema = await schemaFingerprint(client);

      // ------------------------------------------------------------------
      // A. Software delivery
      // ------------------------------------------------------------------
      const maintainer = await createPrincipal(db, {
        tenantId: workspaceId,
        displayName: "Release maintainer",
        kind: "human",
      }, { now: 1_100 });
      const coderA = await createPrincipal(db, {
        tenantId: workspaceId,
        displayName: "Coding runtime A",
        kind: "runtime",
      }, { now: 1_110 });
      const coderB = await createPrincipal(db, {
        tenantId: workspaceId,
        displayName: "Coding runtime B",
        kind: "runtime",
      }, { now: 1_120 });
      const reproduction = await createCommitment(db, {
        title: "Reproduce issue 481",
        successCriteria: "A deterministic failing test exists",
      }, { workspaceId, actor: "maintainer", principalId: maintainer.id, now: 1_200 });
      const release = await createCommitment(db, {
        title: "Ship fix for issue 481",
        successCriteria: "PR 481 is merged at commit fix481abc",
        completionPolicy: "evidence",
      }, { workspaceId, actor: "maintainer", principalId: maintainer.id, now: 1_210 });
      await addCommitmentRelation(db, {
        tenantId: workspaceId,
        fromTaskId: release.id,
        relationType: "depends_on",
        toTaskId: reproduction.id,
      }, principalContext(maintainer.id, "maintainer", 1_220));
      await expect(addCommitmentRelation(db, {
        tenantId: workspaceId,
        fromTaskId: reproduction.id,
        relationType: "depends_on",
        toTaskId: release.id,
      }, principalContext(maintainer.id, "maintainer", 1_230)))
        .rejects.toThrow(/cycle/);

      const codingAssignment = await proposeAssignment(db, {
        tenantId: workspaceId,
        taskId: release.id,
        assignerPrincipalId: maintainer.id,
        assigneePrincipalId: coderA.id,
        role: "contributor",
      }, { ...principalContext(maintainer.id, "maintainer", 1_240), idempotencyKey: "software-assignment" });
      await acceptAssignment(db, codingAssignment.id, {
        ...principalContext(coderA.id, "coding-a", 1_250),
        expectedRevision: codingAssignment.revision,
      });
      const claimA = await acquireTaskClaim(db, release.id, {
        tenantId: workspaceId,
        principalId: coderA.id,
        actor: "coding-a",
        leaseMs: 1_000,
        now: 1_300,
      });
      await expect(acquireTaskClaim(db, release.id, {
        tenantId: workspaceId,
        principalId: coderB.id,
        actor: "coding-b",
        leaseMs: 1_000,
        now: 1_350,
      })).rejects.toThrow(/claimed by/);
      const claimB = await acquireTaskClaim(db, release.id, {
        tenantId: workspaceId,
        principalId: coderB.id,
        actor: "coding-b",
        leaseMs: 1_000,
        now: 2_301,
      });
      expect(claimB.fence).toBe(claimA.fence + 1);
      await expect(startTaskAttempt(db, release.id, {
        tenantId: workspaceId,
        principalId: coderA.id,
        actor: "coding-a",
        claimId: claimA.id,
        occurredAt: 2_310,
      })).rejects.toThrow(/not active|claimed by/);

      const codingAttempt = await startTaskAttempt(db, release.id, {
        tenantId: workspaceId,
        principalId: coderB.id,
        actor: "coding-b",
        claimId: claimB.id,
        runtime: "a2a",
        externalId: "coding-task-481",
        occurredAt: 2_320,
      });
      await appendArtifact(db, {
        tenantId: workspaceId,
        taskId: release.id,
        attemptId: codingAttempt.id,
        typeUri: "https://schemas.example.test/artifacts/pull-request",
        name: "PR 481",
        uri: "https://github.example.test/acme/kernel/pull/481",
        digest: "sha256:pr481",
      }, principalContext(coderB.id, "coding-b", 2_330));
      await transitionTaskAttempt(db, codingAttempt.id, "succeeded", {
        tenantId: workspaceId,
        principalId: coderB.id,
        actor: "coding-b",
        expectedRevision: codingAttempt.revision,
        occurredAt: 2_340,
      });
      expect((await getCommitment(db, release.id, workspaceId))?.status).toBe("open");

      const mergeWait = await createWaitCondition(db, {
        tenantId: workspaceId,
        taskId: release.id,
        kind: "github.pull_request_state",
        parameters: {
          host: "github.example.test",
          owner: "acme",
          repository: "kernel",
          pullRequestNumber: 481,
          state: "merged",
          mergeCommitSha: "fix481abc",
        },
      }, { tenantId: workspaceId, actor: "maintainer", now: 2_350 });
      const mergeDelivery = {
        tenantId: workspaceId,
        source: "github-app:acme",
        externalEventId: "delivery-481",
        kind: "github.pull_request" as const,
        payload: {
          host: "github.example.test",
          owner: "acme",
          repository: "kernel",
          pullRequestNumber: 481,
          state: "merged",
          mergeCommitSha: "fix481abc",
        },
        occurredAt: 2_360,
        verificationLevel: "authenticated_source" as const,
        verificationMethod: "github-app-signature",
        digest: "sha256:delivery481",
      };
      const mergeObservation = await ingestObservation(db, mergeDelivery, {
        tenantId: workspaceId,
        actor: "github-connector",
        now: 2_370,
      });
      const duplicateMerge = await ingestObservation(db, mergeDelivery, {
        tenantId: workspaceId,
        actor: "github-connector",
        now: 2_380,
      });
      expect(duplicateMerge.id).toBe(mergeObservation.id);
      const mergeResult = await reconcileWaitObservation(db, mergeWait.id, mergeObservation.id, {
        tenantId: workspaceId,
        actor: "reconciler",
        now: 2_390,
      });
      expect(mergeResult.effect).toBe("satisfied");
      const releaseBeforeCompletion = await getCommitment(db, release.id, workspaceId);
      await completeCommitment(db, release.id, {
        workspaceId,
        actor: "maintainer",
        principalId: maintainer.id,
        expectedRevision: releaseBeforeCompletion!.revision,
        evidenceIds: [mergeResult.evidenceId!],
        occurredAt: 2_400,
        now: 2_400,
      });
      expect(await schemaFingerprint(client)).toBe(baselineSchema);

      // ------------------------------------------------------------------
      // B. Research with explicit human acceptance
      // ------------------------------------------------------------------
      const researcher = await createPrincipal(db, {
        tenantId: workspaceId,
        displayName: "Research runtime",
        kind: "runtime",
      }, { now: 3_000 });
      const approver = await createPrincipal(db, {
        tenantId: workspaceId,
        displayName: "Named investment committee member",
        kind: "human",
      }, { now: 3_010 });
      const reportTask = await createCommitment(db, {
        title: "Produce a decision-ready market report",
        successCriteria: "Named human accepts the report digest and source coverage",
        completionPolicy: "evidence",
      }, { workspaceId, actor: "committee", principalId: approver.id, now: 3_020 });
      const authorAssignment = await proposeAssignment(db, {
        tenantId: workspaceId,
        taskId: reportTask.id,
        assignerPrincipalId: approver.id,
        assigneePrincipalId: researcher.id,
        role: "contributor",
      }, principalContext(approver.id, "committee", 3_030));
      await acceptAssignment(db, authorAssignment.id, {
        ...principalContext(researcher.id, "research-runtime", 3_040),
        expectedRevision: authorAssignment.revision,
      });
      const approvalAssignment = await proposeAssignment(db, {
        tenantId: workspaceId,
        taskId: reportTask.id,
        assignerPrincipalId: approver.id,
        assigneePrincipalId: approver.id,
        role: "approver",
      }, principalContext(approver.id, "committee", 3_050));
      await acceptAssignment(db, approvalAssignment.id, {
        ...principalContext(approver.id, "committee", 3_060),
        expectedRevision: approvalAssignment.revision,
      });
      const researchClaim = await acquireTaskClaim(db, reportTask.id, {
        tenantId: workspaceId,
        actor: "research-runtime",
        principalId: researcher.id,
        leaseMs: 1_000,
        now: 3_070,
      });
      const researchAttempt = await startTaskAttempt(db, reportTask.id, {
        tenantId: workspaceId,
        actor: "research-runtime",
        principalId: researcher.id,
        claimId: researchClaim.id,
        runtime: "remote-research",
        externalId: "run-77",
        occurredAt: 3_080,
      });
      const report = await appendArtifact(db, {
        tenantId: workspaceId,
        taskId: reportTask.id,
        attemptId: researchAttempt.id,
        typeUri: "https://schemas.example.test/artifacts/market-report",
        name: "market-report.pdf",
        uri: "https://research.example.test/report-77.pdf",
        digest: "sha256:report-v1",
      }, principalContext(researcher.id, "research-runtime", 3_090));
      await appendArtifact(db, {
        tenantId: workspaceId,
        taskId: reportTask.id,
        attemptId: researchAttempt.id,
        typeUri: "https://schemas.example.test/artifacts/source-bundle",
        name: "sources.json",
        uri: "https://research.example.test/sources-77.json",
        digest: "sha256:sources-v1",
      }, principalContext(researcher.id, "research-runtime", 3_100));
      await transitionTaskAttempt(db, researchAttempt.id, "succeeded", {
        tenantId: workspaceId,
        actor: "research-runtime",
        principalId: researcher.id,
        expectedRevision: researchAttempt.revision,
        occurredAt: 3_110,
      });
      expect((await getCommitment(db, reportTask.id, workspaceId))?.status).toBe("open");
      const coverage = await addTaskEvidence(db, {
        tenantId: workspaceId,
        taskId: reportTask.id,
        attemptId: researchAttempt.id,
        kind: "source_coverage",
        summary: "Coverage checklist and source digest verified",
        digest: "sha256:sources-v1",
        observedAt: 3_120,
      }, principalContext(researcher.id, "research-runtime", 3_120));
      const humanApproval = await addTaskEvidence(db, {
        tenantId: workspaceId,
        taskId: reportTask.id,
        kind: "human_acceptance",
        summary: `Named human accepted ${report.digest}`,
        digest: report.digest,
        observedAt: 3_130,
      }, principalContext(approver.id, "committee", 3_130));
      const beforeResearchCompletion = await getCommitment(db, reportTask.id, workspaceId);
      await completeCommitment(db, reportTask.id, {
        workspaceId,
        actor: "committee",
        principalId: approver.id,
        expectedRevision: beforeResearchCompletion!.revision,
        evidenceIds: [coverage.id, humanApproval.id],
        occurredAt: 3_140,
        now: 3_140,
      });
      const completedOnce = await getCommitment(db, reportTask.id, workspaceId);
      const reopened = await reopenCommitment(db, reportTask.id, {
        workspaceId,
        actor: "committee",
        principalId: approver.id,
        expectedRevision: completedOnce!.revision,
        reason: "Committee requested an inspectable revision",
        occurredAt: 3_150,
        now: 3_150,
      });
      const revisedAcceptance = await addTaskEvidence(db, {
        tenantId: workspaceId,
        taskId: reportTask.id,
        kind: "human_acceptance",
        summary: "Named human accepted the revised decision record",
        digest: "sha256:report-v2",
        observedAt: 3_160,
      }, principalContext(approver.id, "committee", 3_160));
      await completeCommitment(db, reportTask.id, {
        workspaceId,
        actor: "committee",
        principalId: approver.id,
        expectedRevision: reopened.revision,
        evidenceIds: [coverage.id, revisedAcceptance.id],
        occurredAt: 3_170,
        now: 3_170,
      });
      expect(await listCompletionRecords(db, reportTask.id, workspaceId)).toHaveLength(2);
      expect(await schemaFingerprint(client)).toBe(baselineSchema);

      // ------------------------------------------------------------------
      // C. Operations and external health
      // ------------------------------------------------------------------
      const operator = await createPrincipal(db, {
        tenantId: workspaceId,
        displayName: "Deployment runtime",
        kind: "runtime",
      }, { now: 4_000 });
      const deployment = await createCommitment(db, {
        title: "Deploy service version N and establish health",
        successCriteria: "Version N health endpoint returns the expected digest",
        completionPolicy: "evidence",
      }, { workspaceId, actor: "operations", principalId: operator.id, now: 4_010 });
      const opsClaim = await acquireTaskClaim(db, deployment.id, {
        tenantId: workspaceId,
        actor: "deploy-runtime",
        principalId: operator.id,
        leaseMs: 3_000,
        now: 4_020,
      });
      const timeoutAttempt = await startTaskAttempt(db, deployment.id, {
        tenantId: workspaceId,
        actor: "deploy-runtime",
        principalId: operator.id,
        claimId: opsClaim.id,
        runtime: "durable-deployment",
        externalId: "deploy-N-timeout",
        occurredAt: 4_030,
      });
      await transitionTaskAttempt(db, timeoutAttempt.id, "failed", {
        tenantId: workspaceId,
        actor: "deploy-runtime",
        principalId: operator.id,
        expectedRevision: timeoutAttempt.revision,
        message: "provider result unknown after timeout",
        occurredAt: 4_040,
      });
      // The ledger never manufactures a retry after an unknown provider result.
      expect(await listTaskAttempts(db, deployment.id, { tenantId: workspaceId })).toHaveLength(1);
      const healthWait = await createWaitCondition(db, {
        tenantId: workspaceId,
        taskId: deployment.id,
        kind: "http.response",
        parameters: {
          url: "https://service.example.test/health/version",
          method: "GET",
          allowedStatuses: [200],
          bodyDigest: "sha256:version-N",
        },
        notBefore: 4_050,
        deadlineAt: 4_100,
        fallbackKind: "create_task",
        fallbackSpec: {
          title: "Investigate or roll back version N",
          nextAction: "Establish provider truth before authorizing another effect",
          priority: 1,
        },
      }, { tenantId: workspaceId, actor: "operations", now: 4_050 });
      const expired = await evaluateWaitConditionDeadline(db, healthWait.id, {
        tenantId: workspaceId,
        actor: "deadline-sweeper",
        sweepNow: 4_101,
      });
      expect(expired.outcome).toBe("expired");
      expect(expired.fallbackResultTaskId).not.toBeNull();
      const repeatedSweep = await evaluateWaitConditionDeadline(db, healthWait.id, {
        tenantId: workspaceId,
        actor: "deadline-sweeper",
        sweepNow: 4_102,
      });
      expect(repeatedSweep.outcome).toBe("already_terminal");
      expect(repeatedSweep.fallbackResultTaskId).toBe(expired.fallbackResultTaskId);

      const lateHealth = await ingestObservation(db, {
        tenantId: workspaceId,
        source: "http-monitor:prod",
        externalEventId: "health-N-late",
        kind: "http.check",
        payload: {
          url: "https://service.example.test/health/version",
          method: "GET",
          statusCode: 200,
          bodyDigest: "sha256:version-N",
        },
        occurredAt: 4_103,
        verificationLevel: "authenticated_source",
        verificationMethod: "monitor-mtls",
        digest: "sha256:health-N-late",
      }, { tenantId: workspaceId, actor: "http-monitor", now: 4_104 });
      const lateResult = await reconcileWaitObservation(db, healthWait.id, lateHealth.id, {
        tenantId: workspaceId,
        actor: "reconciler",
        now: 4_105,
      });
      expect(lateResult.effect).toBe("condition_terminal");
      expect((await getCommitment(db, deployment.id, workspaceId))?.status).toBe("open");
      expect(await schemaFingerprint(client)).toBe(baselineSchema);

      const allEvents = await listEvents(db, { tenantId: workspaceId, ascending: true });
      expect(allEvents.some((event) => event.eventType === "wait_expired")).toBe(true);
      expect(allEvents.some((event) => event.eventType === "completed")).toBe(true);
    } finally {
      await close();
    }
  });
});

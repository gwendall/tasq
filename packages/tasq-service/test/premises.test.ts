import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  TASK_PREMISE_URI,
  acquireTaskClaim,
  addTaskEvidence,
  appendExternalRef,
  challengeTaskPremise,
  createPrincipal,
  createTaskWithPremise,
  decideTaskPremise,
  getActiveTaskClaim,
  getTaskAttempt,
  getTaskPremiseState,
  ingestObservation,
  listTasks,
  openDb,
  pickNext,
  proposeTaskPremise,
  runMigrations,
  startTaskAttempt,
} from "../src/index.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "tasq-premises-"));
  roots.push(root);
  const opened = await openDb({ url: `file:${join(root, "db.sqlite")}`, wal: false });
  await runMigrations(opened.client, { now: 1_000 });
  const worker = await createPrincipal(opened.db, {
    kind: "agent", displayName: "Worker", localAlias: "worker",
  }, { now: 2_000 });
  const validator = await createPrincipal(opened.db, {
    kind: "human", displayName: "Validator", localAlias: "validator",
  }, { now: 2_100 });
  const adjudicator = await createPrincipal(opened.db, {
    kind: "human", displayName: "Adjudicator", localAlias: "adjudicator",
  }, { now: 2_200 });
  const observed = await ingestObservation(opened.db, {
    source: "github:work",
    externalEventId: "issue-42",
    kind: "github.pull_request",
    payload: {
      host: "github.com", owner: "acme", repository: "product",
      pullRequestNumber: 42, state: "open",
    },
    occurredAt: 3_000,
  }, { actor: "watcher:github", now: 3_100 });
  return { ...opened, worker, validator, adjudicator, observed };
}

const digest = (character: string) => `sha256:${character.repeat(64)}`;

describe("TQ-619 refutable motivating premises", () => {
  test("creates task and observation-backed premise atomically and replays exactly", async () => {
    const f = await fixture();
    try {
      const input = {
        observationId: f.observed.id,
        proposition: "Issue 42 still represents work worth doing",
        eligibleValidatorPrincipalIds: [f.validator.id],
        adjudicatorPrincipalIds: [f.adjudicator.id],
      };
      const first = await createTaskWithPremise(f.db, { title: "Repair issue 42" }, input, {
        actor: "worker", principalId: f.worker.id, now: 4_000, idempotencyKey: "create-premise",
      });
      const replay = await createTaskWithPremise(f.db, { title: "Repair issue 42" }, input, {
        actor: "worker", principalId: f.worker.id, now: 4_500, idempotencyKey: "create-premise",
      });
      expect(replay.replayed).toBeTrue();
      expect(replay.task.id).toBe(first.task.id);
      expect(replay.premise.id).toBe(first.premise.id);
      expect(replay.premise.value.observationId).toBe(f.observed.id);
      expect(replay.premise.value.observationDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect((await getTaskPremiseState(f.db, first.task.id))?.actionable).toBeTrue();
    } finally {
      await f.close();
    }
  });

  test("rolls task creation back when the motivating observation is absent", async () => {
    const f = await fixture();
    try {
      await expect(createTaskWithPremise(f.db, { title: "Must not leak" }, {
        observationId: "01900000-0000-7000-8000-000000000001",
        proposition: "An absent fact is true",
        eligibleValidatorPrincipalIds: [f.validator.id],
      }, { actor: "worker", principalId: f.worker.id, now: 4_000, idempotencyKey: "bad" }))
        .rejects.toThrow(/Observation not found/);
      expect(await listTasks(f.db, { limit: 100 })).toHaveLength(0);
    } finally {
      await f.close();
    }
  });

  test("refutes through proposal, challenge and adjudication without deleting history", async () => {
    const f = await fixture();
    try {
      const created = await createTaskWithPremise(f.db, { title: "Repair issue 42" }, {
        observationId: f.observed.id,
        proposition: "Issue 42 remains open",
        eligibleValidatorPrincipalIds: [f.validator.id],
        adjudicatorPrincipalIds: [f.adjudicator.id],
      }, { actor: "worker", principalId: f.worker.id, now: 4_000, idempotencyKey: "create" });
      const claim = await acquireTaskClaim(f.db, created.task.id, {
        actor: "worker", principalId: f.worker.id, now: 4_100, leaseMs: 60_000,
      });
      const attempt = await startTaskAttempt(f.db, created.task.id, {
        actor: "worker", principalId: f.worker.id, occurredAt: 4_200, claimId: claim.id,
      });
      const refuting = await addTaskEvidence(f.db, {
        taskId: created.task.id, kind: "github.issue.closed", summary: "Issue was closed as duplicate",
        digest: digest("a"), source: "github:work", observedAt: 4_300,
      }, { actor: "worker", principalId: f.worker.id, now: 4_300, idempotencyKey: "refuting-evidence" });
      const counter = await addTaskEvidence(f.db, {
        taskId: created.task.id, kind: "github.issue.reopened", summary: "A stale mirror still reports open",
        digest: digest("b"), source: "mirror:github", observedAt: 4_400,
      }, { actor: "validator", principalId: f.validator.id, now: 4_400, idempotencyKey: "counter-evidence" });
      const proposal = await proposeTaskPremise(f.db, created.task.id, {
        verdict: "refute", evidenceIds: [refuting.id], rationale: "The motivating issue is no longer live",
      }, { actor: "worker", principalId: f.worker.id, now: 4_500, idempotencyKey: "proposal" });
      const challenge = await challengeTaskPremise(f.db, created.task.id, {
        proposalId: proposal.id, counterEvidenceIds: [counter.id], rationale: "Mirror contradicts closure",
      }, { actor: "validator", principalId: f.validator.id, now: 4_600, idempotencyKey: "challenge" });
      await expect(decideTaskPremise(f.db, created.task.id, {
        proposalId: proposal.id, outcome: "accepted", rationale: "Validator tries to overrule own challenge",
      }, { actor: "validator", principalId: f.validator.id, now: 4_700, idempotencyKey: "bad-decision" }))
        .rejects.toThrow(/named adjudicator/);
      const decision = await decideTaskPremise(f.db, created.task.id, {
        proposalId: proposal.id, outcome: "accepted", rationale: "Authoritative issue state is closed",
      }, { actor: "adjudicator", principalId: f.adjudicator.id, now: 4_800, idempotencyKey: "decision" });
      expect(decision.value.challengeIds).toEqual([challenge.id]);
      const state = await getTaskPremiseState(f.db, created.task.id);
      expect(state).toMatchObject({ actionable: false, task: { status: "open", deletedAt: null } });
      expect(state?.invalidation?.value.decisionId).toBe(decision.id);
      expect(state?.proposals).toHaveLength(1);
      expect(state?.challenges).toHaveLength(1);
      expect(state?.decisions).toHaveLength(1);
      expect(await getActiveTaskClaim(f.db, created.task.id, "gwendall", 4_800)).toBeNull();
      expect(await getTaskAttempt(f.db, attempt.id)).toMatchObject({ status: "cancelled" });
      expect((await pickNext(f.db, { now: 4_800 })).map((item) => item.task.id)).not.toContain(created.task.id);
      await expect(acquireTaskClaim(f.db, created.task.id, {
        actor: "worker", principalId: f.worker.id, now: 4_900, leaseMs: 60_000,
      })).rejects.toThrow(/premise is invalidated/);
    } finally {
      await f.close();
    }
  });

  test("reserves premise record types from generic external-reference insertion", async () => {
    const f = await fixture();
    try {
      const created = await createTaskWithPremise(f.db, { title: "Bound record" }, {
        observationId: f.observed.id, proposition: "Issue is open",
        eligibleValidatorPrincipalIds: [f.validator.id],
      }, { actor: "worker", principalId: f.worker.id, now: 4_000, idempotencyKey: "create" });
      await expect(appendExternalRef(f.db, {
        tenantId: "gwendall", recordType: "commitment", recordId: created.task.id,
        system: "https://tasq.run", resourceType: TASK_PREMISE_URI, externalId: "bypass",
      }, { actor: "worker", principalId: f.worker.id, now: 4_100 }))
        .rejects.toThrow(/must use the premise service/);
    } finally {
      await f.close();
    }
  });
});

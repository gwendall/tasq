import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cancelWaitCondition,
  createTask,
  createWaitCondition,
  diagnoseStore,
  getReconciliation,
  getTask,
  getWaitCondition,
  ingestObservation,
  listCandidateObservations,
  listEvents,
  listReconciliations,
  listTaskEvidence,
  openDb,
  reconcileWaitObservation,
  runMigrations,
} from "../src/index.js";

const tmpDirs: string[] = [];

afterEach(() => {
  while (tmpDirs.length > 0) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

async function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "tasq-reconcile-"));
  tmpDirs.push(dir);
  const handle = await openDb({ url: `file:${join(dir, "db.sqlite")}`, wal: false });
  await runMigrations(handle.client);
  return handle;
}

describe("deterministic reconciliation", () => {
  it("matches all five registry kinds through indexed candidate routing", async () => {
    const { db, close } = await freshDb();
    try {
      const task = await createTask(db, { title: "External outcomes remain owed" });
      const cases = [
        {
          condition: {
            kind: "gmail.thread_reply" as const,
            parameters: {
              connectorAccount: "gmail:primary",
              threadId: "thread-1",
              sender: "alice@example.test",
            },
          },
          observation: {
            source: "gmail:primary",
            externalEventId: "gmail-1",
            kind: "gmail.message" as const,
            payload: {
              connectorAccount: "gmail:primary",
              messageId: "message-1",
              threadId: "thread-1",
              sender: "alice@example.test",
            },
          },
        },
        {
          condition: {
            kind: "github.pull_request_state" as const,
            parameters: {
              host: "github.com",
              owner: "kami",
              repository: "robot",
              pullRequestNumber: 42,
              state: "merged" as const,
              mergeCommitSha: "abcdef1234567",
            },
          },
          observation: {
            source: "github:work",
            externalEventId: "github-1",
            kind: "github.pull_request" as const,
            payload: {
              host: "github.com",
              owner: "kami",
              repository: "robot",
              pullRequestNumber: 42,
              state: "merged" as const,
              mergeCommitSha: "abcdef1234567",
            },
          },
        },
        {
          condition: {
            kind: "mercury.transaction_state" as const,
            parameters: {
              connectorAccount: "mercury:kami",
              transactionId: "tx-1",
              settlementState: "sent",
            },
          },
          observation: {
            source: "mercury:kami",
            externalEventId: "mercury-1",
            kind: "mercury.transaction" as const,
            payload: {
              connectorAccount: "mercury:kami",
              transactionId: "tx-1",
              direction: "outgoing" as const,
              currency: "USD",
              minorUnits: 58_000_00,
              counterparty: "Acme",
              settlementState: "sent",
            },
          },
        },
        {
          condition: {
            kind: "http.response" as const,
            parameters: {
              url: "https://example.test/health",
              method: "GET" as const,
              allowedStatuses: [200, 204],
              bodyDigest: "sha256:healthy",
            },
          },
          observation: {
            source: "http:prod",
            externalEventId: "http-1",
            kind: "http.check" as const,
            payload: {
              url: "https://example.test/health",
              method: "GET" as const,
              statusCode: 200,
              bodyDigest: "sha256:healthy",
            },
          },
        },
        {
          condition: {
            kind: "filesystem.artifact" as const,
            parameters: {
              connectorRoot: "workspace",
              relativePath: "dist/release.tar.gz",
              kind: "file" as const,
              sizeBytes: 1234,
              digest: "sha256:release",
            },
          },
          observation: {
            source: "filesystem:workspace",
            externalEventId: "filesystem-1",
            kind: "filesystem.stat" as const,
            payload: {
              connectorRoot: "workspace",
              relativePath: "dist/release.tar.gz",
              kind: "file" as const,
              sizeBytes: 1234,
              digest: "sha256:release",
            },
          },
        },
      ];

      for (const [index, scenario] of cases.entries()) {
        const condition = await createWaitCondition(
          db,
          { taskId: task.id, ...scenario.condition, notBefore: 1_000 },
          { now: 1_000 + index },
        );
        const observation = await ingestObservation(
          db,
          { ...scenario.observation, occurredAt: 2_000 },
          { actor: `watcher:${index}`, now: 2_500 + index },
        );
        expect((await listCandidateObservations(db, condition.id)).map((row) => row.id)).toContain(
          observation.id,
        );
        const result = await reconcileWaitObservation(db, condition.id, observation.id, {
          actor: "reconciler",
          now: 3_000 + index,
        });
        expect(result).toMatchObject({
          decision: "matched",
          effect: "satisfied",
          matcherKind: scenario.condition.kind,
          matcherVersion: 1,
        });
        expect(result.evidenceId).not.toBeNull();
        expect(await getWaitCondition(db, condition.id)).toMatchObject({
          status: "satisfied",
          satisfiedByObservationId: observation.id,
        });
      }

      expect(await listTaskEvidence(db, task.id)).toHaveLength(5);
      expect(await getTask(db, task.id)).toMatchObject({ status: "open" });
    } finally {
      await close();
    }
  });

  it("records rejected and ambiguous decisions without changing the wait", async () => {
    const { db, close } = await freshDb();
    try {
      const task = await createTask(db, { title: "Interpret typed facts" });
      const rejectedCondition = await createWaitCondition(
        db,
        {
          taskId: task.id,
          kind: "gmail.thread_reply",
          parameters: {
            connectorAccount: "gmail:primary",
            threadId: "thread-1",
            sender: "alice@example.test",
          },
          notBefore: 1_000,
        },
        { now: 1_000 },
      );
      const wrongSender = await ingestObservation(
        db,
        {
          source: "gmail:primary",
          externalEventId: "wrong-sender",
          kind: "gmail.message",
          payload: {
            connectorAccount: "gmail:primary",
            messageId: "message-1",
            threadId: "thread-1",
            sender: "mallory@example.test",
          },
          occurredAt: 2_000,
        },
        { now: 2_100 },
      );
      expect(
        await reconcileWaitObservation(db, rejectedCondition.id, wrongSender.id, { now: 3_000 }),
      ).toMatchObject({
        decision: "rejected",
        effect: "no_change",
        reasonCode: "sender_mismatch",
        evidenceId: null,
      });

      const ambiguousCondition = await createWaitCondition(
        db,
        {
          taskId: task.id,
          kind: "github.pull_request_state",
          parameters: {
            host: "github.com",
            owner: "kami",
            repository: "robot",
            pullRequestNumber: 7,
            state: "merged",
            mergeCommitSha: "abcdef1234567",
          },
          notBefore: 1_000,
        },
        { now: 1_100 },
      );
      const missingSha = await ingestObservation(
        db,
        {
          source: "github:work",
          externalEventId: "missing-sha",
          kind: "github.pull_request",
          payload: {
            host: "github.com",
            owner: "kami",
            repository: "robot",
            pullRequestNumber: 7,
            state: "merged",
          },
          occurredAt: 2_000,
        },
        { now: 2_200 },
      );
      expect(
        await reconcileWaitObservation(db, ambiguousCondition.id, missingSha.id, { now: 3_100 }),
      ).toMatchObject({
        decision: "ambiguous",
        effect: "no_change",
        reasonCode: "merge_commit_sha_missing",
      });
      expect(await getWaitCondition(db, rejectedCondition.id)).toMatchObject({ status: "waiting" });
      expect(await getWaitCondition(db, ambiguousCondition.id)).toMatchObject({ status: "waiting" });
      expect(await listTaskEvidence(db, task.id)).toHaveLength(0);
    } finally {
      await close();
    }
  });

  it("keeps late matches from satisfying a still-waiting condition", async () => {
    const { db, close } = await freshDb();
    try {
      const task = await createTask(db, { title: "Deadline race" });
      const condition = await createWaitCondition(
        db,
        {
          taskId: task.id,
          kind: "gmail.thread_reply",
          parameters: { connectorAccount: "gmail:primary", threadId: "thread-1" },
          notBefore: 1_000,
          deadlineAt: 5_000,
        },
        { now: 1_000 },
      );
      const late = await ingestObservation(
        db,
        {
          source: "gmail:primary",
          externalEventId: "late",
          kind: "gmail.message",
          payload: {
            connectorAccount: "gmail:primary",
            messageId: "late-message",
            threadId: "thread-1",
            sender: "alice@example.test",
          },
          occurredAt: 4_999,
        },
        { now: 5_000 },
      );
      expect(
        await reconcileWaitObservation(db, condition.id, late.id, { now: 6_000 }),
      ).toMatchObject({
        decision: "matched",
        effect: "no_change",
        reasonCode: "observation_not_before_deadline",
      });
      expect(await getWaitCondition(db, condition.id)).toMatchObject({ status: "waiting" });
    } finally {
      await close();
    }
  });

  it("retains a matched decision against a terminal condition without reversing it", async () => {
    const { db, close } = await freshDb();
    try {
      const task = await createTask(db, { title: "Terminal wait" });
      const condition = await createWaitCondition(
        db,
        {
          taskId: task.id,
          kind: "gmail.thread_reply",
          parameters: { connectorAccount: "gmail:primary", threadId: "thread-1" },
          notBefore: 1_000,
        },
        { now: 1_000 },
      );
      const observation = await ingestObservation(
        db,
        {
          source: "gmail:primary",
          externalEventId: "terminal-match",
          kind: "gmail.message",
          payload: {
            connectorAccount: "gmail:primary",
            messageId: "message-1",
            threadId: "thread-1",
            sender: "alice@example.test",
          },
          occurredAt: 2_000,
        },
        { now: 2_100 },
      );
      await cancelWaitCondition(db, condition.id, { reason: "manual stop", now: 2_500 });
      expect(
        await reconcileWaitObservation(db, condition.id, observation.id, { now: 3_000 }),
      ).toMatchObject({
        decision: "matched",
        effect: "condition_terminal",
        reasonCode: "condition_already_cancelled",
        evidenceId: null,
      });
      expect(await getWaitCondition(db, condition.id)).toMatchObject({
        status: "cancelled",
        cancelReason: "manual stop",
      });
    } finally {
      await close();
    }
  });

  it("is retry-safe and lets only one racing match satisfy the condition", async () => {
    const { db, close } = await freshDb();
    try {
      const task = await createTask(db, { title: "Concurrent replies" });
      const condition = await createWaitCondition(
        db,
        {
          taskId: task.id,
          kind: "gmail.thread_reply",
          parameters: { connectorAccount: "gmail:primary", threadId: "thread-1" },
          notBefore: 1_000,
        },
        { now: 1_000 },
      );
      const observations = await Promise.all(
        ["a", "b"].map((suffix, index) =>
          ingestObservation(
            db,
            {
              source: "gmail:primary",
              externalEventId: `race-${suffix}`,
              kind: "gmail.message",
              payload: {
                connectorAccount: "gmail:primary",
                messageId: `message-${suffix}`,
                threadId: "thread-1",
                sender: `${suffix}@example.test`,
              },
              occurredAt: 2_000 + index,
            },
            { now: 2_100 + index },
          ),
        ),
      );
      const results = await Promise.all(
        observations.map((row, index) =>
          reconcileWaitObservation(db, condition.id, row.id, { now: 3_000 + index }),
        ),
      );
      expect(results.map((row) => row.effect).sort()).toEqual([
        "condition_terminal",
        "satisfied",
      ]);
      expect(await listTaskEvidence(db, task.id)).toHaveLength(1);
      expect(await listReconciliations(db, condition.id)).toHaveLength(2);

      const winner = results.find((row) => row.effect === "satisfied")!;
      expect(
        await reconcileWaitObservation(db, condition.id, winner.observationId, { now: 9_000 }),
      ).toEqual(winner);
      expect(await listTaskEvidence(db, task.id)).toHaveLength(1);
      expect(await getReconciliation(db, winner.id)).toEqual(winner);
      expect(
        (await listEvents(db, { entityId: task.id })).filter(
          (event) => event.eventType === "wait_satisfied",
        ),
      ).toHaveLength(1);
    } finally {
      await close();
    }
  });

  it("routes incomplete Mercury facts broadly enough to record ambiguity", async () => {
    const { db, close } = await freshDb();
    try {
      const task = await createTask(db, { title: "Mercury ambiguity" });
      const condition = await createWaitCondition(
        db,
        {
          taskId: task.id,
          kind: "mercury.transaction_state",
          parameters: {
            connectorAccount: "mercury:kami",
            direction: "outgoing",
            currency: "USD",
            minorUnits: 10_000,
            counterparty: "Acme",
            settlementState: "sent",
          },
          notBefore: 1_000,
        },
        { now: 1_000 },
      );
      const observation = await ingestObservation(
        db,
        {
          source: "mercury:kami",
          externalEventId: "missing-counterparty",
          kind: "mercury.transaction",
          payload: {
            connectorAccount: "mercury:kami",
            transactionId: "tx-missing",
            direction: "outgoing",
            currency: "USD",
            minorUnits: 10_000,
            counterparty: null,
            settlementState: "sent",
          },
          occurredAt: 2_000,
        },
        { now: 2_100 },
      );
      expect((await listCandidateObservations(db, condition.id)).map((row) => row.id)).toContain(
        observation.id,
      );
      expect(
        await reconcileWaitObservation(db, condition.id, observation.id, { now: 3_000 }),
      ).toMatchObject({ decision: "ambiguous", reasonCode: "counterparty_missing" });
    } finally {
      await close();
    }
  });

  it("makes reconciliations physically append-only and rejects unknown matcher versions", async () => {
    const { db, client, close } = await freshDb();
    try {
      const task = await createTask(db, { title: "Immutable decision" });
      const condition = await createWaitCondition(
        db,
        {
          taskId: task.id,
          kind: "gmail.thread_reply",
          parameters: { connectorAccount: "gmail:primary", threadId: "thread-1" },
          notBefore: 1_000,
        },
        { now: 1_000 },
      );
      const observation = await ingestObservation(
        db,
        {
          source: "gmail:primary",
          externalEventId: "immutable",
          kind: "gmail.message",
          payload: {
            connectorAccount: "gmail:primary",
            messageId: "message-1",
            threadId: "thread-1",
            sender: "alice@example.test",
          },
          occurredAt: 2_000,
        },
        { now: 2_100 },
      );
      await expect(
        reconcileWaitObservation(db, condition.id, observation.id, {
          matcherVersion: 2,
          now: 3_000,
        }),
      ).rejects.toThrow(/Unsupported matcher version/);
      const row = await reconcileWaitObservation(db, condition.id, observation.id, { now: 3_000 });
      await expect(
        client.execute({
          sql: "UPDATE reconciliation SET reason_code='rewritten' WHERE id=?",
          args: [row.id],
        }),
      ).rejects.toThrow(/append-only/);
      await expect(
        client.execute({ sql: "DELETE FROM reconciliation WHERE id=?", args: [row.id] }),
      ).rejects.toThrow(/append-only/);
      await client.execute("DROP TRIGGER reconciliation_no_update");
      await client.execute({
        sql: `UPDATE reconciliation
          SET decision='rejected', effect='no_change', evidence_id=NULL,
              reason_code='tampered', explanation='tampered'
          WHERE id=?`,
        args: [row.id],
      });
      const report = await diagnoseStore(db, client);
      expect(report.ok).toBe(false);
      expect(report.issues.map((issue) => issue.code)).toContain(
        "reconciliation_decision_drift",
      );
    } finally {
      await close();
    }
  });
});

/** TQ-109: a real adapter shape drives wait -> fact -> evidence -> completion. */

import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { watchFilesystemArtifact } from "@tasq-internal/filesystem-watcher";
import { createMutableClock } from "@tasq/schema";
import {
  completeCommitment,
  createCommitment,
  createWaitCondition,
  diagnoseStore,
  ingestObservation,
  inspectCommitment,
  openDb,
  reconcileWaitObservation,
  runMigrations,
} from "@tasq-internal/local-service";

const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length > 0) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

describe("TQ-109 manually invoked filesystem loop", () => {
  it("turns a read-only artifact fact into explicit evidence and a separately authorized completion", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tasq-life-loop-"));
    tmpDirs.push(dir);
    const lifeDir = join(dir, "life");
    const tasksPath = join(lifeDir, "TASKS.md");
    mkdirSync(lifeDir);
    writeFileSync(tasksPath, "# Legacy read-only projection\n\n- [ ] Keep this file untouched\n");
    utimesSync(tasksPath, 1_780_000_000, 1_780_000_000);
    const sourceBefore = readFileSync(tasksPath, "utf8");
    const clock = createMutableClock(1_900_000_000_000);
    const workspaceId = "tq109-life-loop";
    const { db, client, close } = await openDb({
      url: `file:${join(dir, "db.sqlite")}`,
      wal: false,
    });
    try {
      await runMigrations(client, { clock });
      clock.advance(100);
      const commitment = await createCommitment(db, {
        title: "Observe the current _life task projection",
        successCriteria: "A digest-bound filesystem observation matches TASKS.md",
        completionPolicy: "evidence",
      }, { workspaceId, actor: "life-loop", clock });

      const normalized = await watchFilesystemArtifact({
        connectorRoot: "life",
        rootPath: lifeDir,
        relativePath: "TASKS.md",
      });
      clock.advance(100);
      const condition = await createWaitCondition(db, {
        tenantId: workspaceId,
        taskId: commitment.id,
        kind: "filesystem.artifact",
        parameters: normalized.payload,
        // This wait asks for the current durable projection, not a future write.
        notBefore: 0,
      }, { tenantId: workspaceId, actor: "life-loop", clock });

      clock.advance(100);
      const observation = await ingestObservation(db, {
        tenantId: workspaceId,
        ...normalized,
      }, { tenantId: workspaceId, actor: "watcher:filesystem", clock });
      clock.advance(100);
      const replay = await ingestObservation(db, {
        tenantId: workspaceId,
        ...normalized,
      }, { tenantId: workspaceId, actor: "watcher:filesystem", clock });
      expect(replay.id).toBe(observation.id);

      clock.advance(100);
      const reconciliation = await reconcileWaitObservation(db, condition.id, observation.id, {
        tenantId: workspaceId,
        actor: "life-loop:reconciler",
        clock,
      });
      expect(reconciliation).toMatchObject({ decision: "matched", effect: "satisfied" });
      expect(reconciliation.evidenceId).not.toBeNull();

      // Matching creates evidence but deliberately does not complete the commitment.
      clock.advance(100);
      const beforeCompletion = await inspectCommitment(db, commitment.id, { workspaceId, clock });
      expect(beforeCompletion?.commitment.status).toBe("open");
      expect(beforeCompletion?.conditions[0]?.status).toBe("satisfied");
      expect(beforeCompletion?.evidence).toHaveLength(1);
      expect(beforeCompletion?.completionRecords).toHaveLength(0);

      clock.advance(100);
      await completeCommitment(db, commitment.id, {
        workspaceId,
        actor: "life-loop:decider",
        expectedRevision: commitment.revision,
        evidenceIds: [reconciliation.evidenceId!],
        occurredAt: clock.now(),
        clock,
      });
      clock.advance(100);
      const completed = await inspectCommitment(db, commitment.id, { workspaceId, clock });
      expect(completed?.commitment.status).toBe("done");
      expect(completed?.completionRecords).toHaveLength(1);
      expect(completed?.completionRecords[0]?.evidenceIds).toEqual([reconciliation.evidenceId!]);
      expect(completed?.observations[0]?.payload).toEqual(normalized.payload);
      expect(completed?.observations[0]?.occurredAt).toBe(1_780_000_000_000);

      const doctor = await diagnoseStore(db, client, workspaceId);
      expect(doctor.ok, JSON.stringify(doctor.issues, null, 2)).toBe(true);
      expect(readFileSync(tasksPath, "utf8")).toBe(sourceBefore);
    } finally {
      await close();
    }
  });
});

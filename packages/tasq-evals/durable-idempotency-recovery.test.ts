/** TQ-403: unrelated runtimes, lost CAS response and explicit retention. */

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMutableClock } from "@tasq-run/schema";
import {
  DEFAULT_IDEMPOTENCY_RETENTION_MS,
  addCommitmentRelation,
  createCommitment,
  listIdempotencyRecords,
  openDb,
  pruneExpiredIdempotency,
  runKernelMigrations,
  startCommitment,
  updateCommitment,
} from "@tasq-run/core";

const WORKSPACE = "tq-403-recovery";
const tmpDirs: string[] = [];

afterEach(() => {
  while (tmpDirs.length > 0) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

describe("TQ-403 durable mutation recovery", () => {
  it("lets unknown runtimes retry independently after response loss", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tasq-tq403-"));
    tmpDirs.push(dir);
    const { db, client, close } = await openDb({
      url: `file:${join(dir, "tasq.sqlite")}`,
      wal: false,
    });
    const clock = createMutableClock(1_000);
    try {
      await runKernelMigrations(client, { clock });
      const context = (actor: string, idempotencyKey: string) => ({
        workspaceId: WORKSPACE,
        actor,
        idempotencyKey,
        clock,
      });

      // These runtimes do not coordinate their local key generators. Scope
      // isolation means their identical key cannot conflate their commitments.
      const robot = await createCommitment(db, { title: "Calibrate arm" },
        context("runtime:robot", "request-1"));
      const auditor = await createCommitment(db, { title: "Audit calibration" },
        context("runtime:auditor", "request-1"));
      expect(auditor.id).not.toBe(robot.id);

      clock.set(2_000);
      const accepted = await updateCommitment(db, robot.id, {
        description: "Run the exact calibration sequence",
      }, { ...context("runtime:robot", "edit-1"), expectedRevision: 1 });

      // The client crashes after commit and retries with the stale revision.
      clock.set(50_000);
      const recovered = await updateCommitment(db, robot.id, {
        description: "Run the exact calibration sequence",
      }, { ...context("runtime:robot", "edit-1"), expectedRevision: 1 });
      expect(recovered).toEqual(accepted);

      await expect(updateCommitment(db, robot.id, {
        description: "A different command",
      }, { ...context("runtime:robot", "edit-1"), expectedRevision: 1 }))
        .rejects.toThrow(/different request/);

      // The same client key is independent across operation names.
      const started = await startCommitment(db, robot.id, {
        ...context("runtime:robot", "edit-1"),
        expectedRevision: accepted.revision,
      });
      expect(started.status).toBe("in_progress");

      clock.set(60_000);
      const relation = await addCommitmentRelation(db, {
        tenantId: WORKSPACE,
        fromTaskId: auditor.id,
        relationType: "depends_on",
        toTaskId: robot.id,
      }, {
        tenantId: WORKSPACE,
        actor: "runtime:auditor",
        idempotencyKey: "protocol-relation-1",
        clock,
      });

      clock.set(60_000 + DEFAULT_IDEMPOTENCY_RETENTION_MS);
      await pruneExpiredIdempotency(db, { tenantId: WORKSPACE, clock });
      const durable = await listIdempotencyRecords(db, {
        tenantId: WORKSPACE,
        key: "protocol-relation-1",
      });
      expect(durable).toMatchObject([{
        resultId: relation.id,
        retentionClass: "durable",
        expiresAt: null,
      }]);
    } finally {
      await close();
    }
  });
});

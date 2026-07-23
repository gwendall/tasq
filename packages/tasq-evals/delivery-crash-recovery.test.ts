/**
 * Eval: a coordinator survives the exact commit-before-delivery crash window.
 *
 * The replacement process has no in-memory callback history. It can still see
 * the commitment, immutable event and pending delivery through public service
 * APIs, which is the agent experience TQ-401 is meant to guarantee.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMutableClock } from "@tasq-run/schema";
import {
  createCommitment,
  ensureDeliverySink,
  getCommitment,
  listDeliveryOutbox,
  listEvents,
  openDb,
  runKernelMigrations,
} from "@tasq-run/core";

const tmpDirs: string[] = [];

afterEach(() => {
  while (tmpDirs.length > 0) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

describe("delivery crash recovery", () => {
  it("lets a replacement agent observe committed work that never reached its sink", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tasq-delivery-eval-"));
    tmpDirs.push(dir);
    const url = `file:${join(dir, "db.sqlite")}`;
    const clock = createMutableClock(1_910_000_000_000);
    const first = await openDb({ url, wal: false });
    await runKernelMigrations(first.client, { clock });
    await ensureDeliverySink(first.db, {
      id: "ops:audit-export",
      kind: "urn:example:sink:audit-export:v1",
      configurationDigest: `sha256:${"c".repeat(64)}`,
    }, { clock });

    clock.advance(25);
    const accepted = await createCommitment(first.db, {
      title: "Calibrate robot arm after encoder replacement",
      description: "Run the zero-position calibration routine",
      successCriteria: "Calibration receipt records all six joint offsets",
    }, { workspaceId: "gwendall", actor: "robot-runtime", clock });

    // The process dies immediately after commit: no callback/drain runs.
    await first.close();

    const replacement = await openDb({ url, wal: false });
    try {
      const commitment = await getCommitment(replacement.db, accepted.id, "gwendall");
      const events = await listEvents(replacement.db, {
        tenantId: "gwendall",
        entityId: accepted.id,
        ascending: true,
      });
      const pending = await listDeliveryOutbox(replacement.db, {
        tenantId: "gwendall",
        sinkId: "ops:audit-export",
        status: "pending",
        ascending: true,
      });

      expect(commitment).toMatchObject({
        id: accepted.id,
        status: "open",
        title: "Calibrate robot arm after encoder replacement",
      });
      expect(events).toHaveLength(1);
      expect(pending).toHaveLength(1);
      expect(pending[0]).toMatchObject({
        eventId: events[0]!.id,
        eventSequence: events[0]!.sequence,
        status: "pending",
        createdAt: 1_910_000_000_025,
      });
    } finally {
      await replacement.close();
    }
  });
});

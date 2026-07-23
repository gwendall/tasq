/** TQ-502: cross-domain, cross-agent acceptance for source-bound compaction. */

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendCommitmentSummary,
  completeCommitment,
  createCommitment,
  getCommitmentSummary,
  inspectCommitment,
  listCurrentCommitmentSummaries,
  openDb,
  reopenCommitment,
  runKernelMigrations,
} from "@tasq-run/core";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

async function fixture(name: string) {
  const dir = mkdtempSync(join(tmpdir(), `tasq-compaction-${name}-`));
  dirs.push(dir);
  const opened = await openDb({ url: `file:${join(dir, "db.sqlite")}`, wal: false });
  await runKernelMigrations(opened.client, { now: 1_000 });
  return opened;
}

describe("source-bound compaction acceptance", () => {
  for (const scenario of [
    { name: "robotics", title: "Calibrate left arm", summary: "Calibration passed at 0.02 mm." },
    { name: "software", title: "Roll out API", summary: "Canary reached 100% with no rollback." },
    { name: "research", title: "Freeze dataset", summary: "Dataset v7 was frozen with provenance." },
  ]) {
    it(`hands ${scenario.name} history to an unrelated cold reader without domain coupling`, async () => {
      const { db, close } = await fixture(scenario.name);
      const workspaceId = `${scenario.name}/shared`;
      try {
        const created = await createCommitment(db, { title: scenario.title }, {
          workspaceId, actor: "producer-runtime", now: 2_000,
        });
        const terminal = await completeCommitment(db, created.id, {
          workspaceId, actor: "producer-runtime", expectedRevision: created.revision, now: 3_000,
        });
        const written = await appendCommitmentSummary(db, {
          workspaceId, commitmentId: terminal.id, summary: scenario.summary,
          expectedPreviousSummaryId: null,
        }, { actor: "producer-runtime", idempotencyKey: `${scenario.name}-summary`, now: 4_000 });

        // This reader shares only the store/space contract. It needs neither
        // producer runtime code nor domain vocabulary to verify and drill down.
        const coldView = await listCurrentCommitmentSummaries(db, { workspaceId, limit: 1 });
        expect(coldView).toEqual([written]);
        expect(coldView[0]?.principalId).not.toContain("cold-reader");
        const raw = await inspectCommitment(db, coldView[0]!.commitmentId, {
          workspaceId,
          now: 5_000,
          clock: { now: () => { throw new Error("device clock must not be read"); } },
        });
        expect(raw?.commitment.title).toBe(scenario.title);
        expect(raw?.events.map((item) => item.sequence)).toContain(
          coldView[0]!.source.refs.audit.throughSequence,
        );
        expect(raw?.events.some((item) => item.eventType === "commitment_summary_appended"))
          .toBe(true);
      } finally {
        await close();
      }
    });
  }

  it("has one deterministic winner for concurrent first summaries and exposes later staleness", async () => {
    const { db, close } = await fixture("race");
    const workspaceId = "handoff/race";
    try {
      const created = await createCommitment(db, { title: "Shared result" }, {
        workspaceId, actor: "producer", now: 10_000,
      });
      const terminal = await completeCommitment(db, created.id, {
        workspaceId, actor: "producer", expectedRevision: created.revision, now: 11_000,
      });
      const attempts = await Promise.allSettled(["alpha", "beta"].map((actor, index) =>
        appendCommitmentSummary(db, {
          workspaceId, commitmentId: terminal.id, summary: `Candidate ${actor}`,
          expectedPreviousSummaryId: null,
        }, { actor, idempotencyKey: `race-${actor}`, now: 12_000 + index })));
      expect(attempts.filter((item) => item.status === "fulfilled")).toHaveLength(1);
      expect(attempts.filter((item) => item.status === "rejected")).toHaveLength(1);
      const winner = (attempts.find((item) => item.status === "fulfilled") as
        PromiseFulfilledResult<Awaited<ReturnType<typeof appendCommitmentSummary>>>).value;
      const reopened = await reopenCommitment(db, terminal.id, {
        workspaceId, actor: "reviewer", expectedRevision: terminal.revision, now: 13_000,
      });
      expect(reopened.status).toBe("open");
      expect(await listCurrentCommitmentSummaries(db, { workspaceId })).toEqual([]);
      expect(await getCommitmentSummary(db, winner.id, workspaceId)).toMatchObject({
        state: "stale",
        staleReasons: [
          "commitment_not_terminal", "commitment_revision_changed", "raw_audit_advanced",
        ],
      });
    } finally {
      await close();
    }
  });
});

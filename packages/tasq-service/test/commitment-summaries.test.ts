import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { commitmentSummary } from "@tasq/schema";
import {
  appendCommitmentSummary,
  completeCommitment,
  createCommitment,
  getCommitmentSummary,
  inspectCommitment,
  listCommitmentSummaries,
  listCurrentCommitmentSummaries,
  openDb,
  reopenCommitment,
  runKernelMigrations,
} from "../src/kernel.js";
import { diagnoseStore } from "../src/doctor.js";
import { assertDatabaseInvariantRejected } from "./support/database-invariant.js";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "tasq-summary-"));
  dirs.push(dir);
  const opened = await openDb({ url: `file:${join(dir, "db.sqlite")}`, wal: false });
  await runKernelMigrations(opened.client, { now: 1_000 });
  return opened;
}

describe("source-bound commitment summaries", () => {
  it("compacts terminal work without hiding raw audit and detects stale sources", async () => {
    const { db, client, close } = await fixture();
    const workspaceId = "robotics/lab";
    const actor = "agent:reviewer";
    try {
      const open = await createCommitment(db, { title: "Calibrate arm" }, {
        workspaceId, actor, now: 1_100,
      });
      await expect(appendCommitmentSummary(db, {
        workspaceId, commitmentId: open.id, summary: "Too early",
        expectedPreviousSummaryId: null,
      }, { actor, idempotencyKey: "early", now: 1_150 })).rejects.toThrow(
        "Only terminal commitments",
      );
      const done = await completeCommitment(db, open.id, {
        workspaceId, actor, expectedRevision: open.revision, now: 1_200,
      });
      const first = await appendCommitmentSummary(db, {
        workspaceId,
        commitmentId: done.id,
        summary: "Arm calibrated; raw acceptance event remains inspectable.",
        expectedPreviousSummaryId: null,
      }, { actor, idempotencyKey: "summary-1", now: 1_300 });

      expect(first).toMatchObject({
        state: "current",
        staleReasons: [],
        source: { commitmentRevision: done.revision, terminalStatus: "done" },
      });
      expect(first.source.refs.inspect).toEqual({
        operation: "inspectCommitment", commitmentId: done.id,
      });
      expect(first.source.refs.audit).toMatchObject({
        entityType: "task", entityId: done.id, throughSequence: first.source.rawEventSequence,
      });
      expect(first.source.refs.audit.eventCount).toBeGreaterThan(0);
      expect(first.summaryDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(first.source.digest).toMatch(/^sha256:[0-9a-f]{64}$/);

      const inspection = await inspectCommitment(db, done.id, { workspaceId, now: 1_350 });
      expect(inspection?.events.some((item) => item.eventType === "commitment_summary_appended"))
        .toBe(true);
      expect(await getCommitmentSummary(db, first.id, workspaceId)).toMatchObject({ state: "current" });
      expect((await listCurrentCommitmentSummaries(db, { workspaceId }))[0]?.id).toBe(first.id);
      expect((await diagnoseStore(db, client, workspaceId)).issues
        .filter((item) => item.code.startsWith("summary_"))).toEqual([]);

      const reopened = await reopenCommitment(db, done.id, {
        workspaceId, actor, expectedRevision: done.revision, now: 1_400,
      });
      const stale = await getCommitmentSummary(db, first.id, workspaceId);
      expect(stale).toMatchObject({ state: "stale" });
      expect(stale?.staleReasons).toEqual([
        "commitment_not_terminal", "commitment_revision_changed", "raw_audit_advanced",
      ]);
      expect(await listCurrentCommitmentSummaries(db, { workspaceId })).toEqual([]);
      expect(reopened.status).toBe("open");
    } finally {
      await close();
    }
  });

  it("uses append-only CAS corrections and durable caller-scoped retry identity", async () => {
    const { db, close } = await fixture();
    const workspaceId = "corrections";
    const actor = "agent:a";
    try {
      const open = await createCommitment(db, { title: "Close report" }, {
        workspaceId, actor, now: 2_000,
      });
      const done = await completeCommitment(db, open.id, {
        workspaceId, actor, expectedRevision: open.revision, now: 2_100,
      });
      const request = {
        workspaceId, commitmentId: done.id, summary: "Initial summary",
        expectedPreviousSummaryId: null,
      } as const;
      const first = await appendCommitmentSummary(db, request, {
        actor, idempotencyKey: "same", now: 2_200,
      });
      const retry = await appendCommitmentSummary(db, request, {
        actor, idempotencyKey: "same", now: 9_999,
      });
      expect(retry).toEqual(first);
      await expect(appendCommitmentSummary(db, { ...request, summary: "Different" }, {
        actor, idempotencyKey: "same", now: 2_300,
      })).rejects.toThrow("different request");
      await expect(appendCommitmentSummary(db, {
        ...request, summary: "Fork",
      }, { actor, idempotencyKey: "fork", now: 2_300 })).rejects.toThrow("Stale summary chain");

      const correction = await appendCommitmentSummary(db, {
        workspaceId,
        commitmentId: done.id,
        summary: "Corrected summary",
        expectedPreviousSummaryId: first.id,
      }, { actor, idempotencyKey: "correction", now: 2_400 });
      const chain = await listCommitmentSummaries(db, { workspaceId, commitmentId: done.id });
      expect(chain.map((item) => [item.summary, item.state])).toEqual([
        ["Initial summary", "superseded"],
        ["Corrected summary", "current"],
      ]);
      const firstPage = await listCommitmentSummaries(db, {
        workspaceId, commitmentId: done.id, limit: 1,
      });
      expect(firstPage.map((item) => [item.summary, item.state])).toEqual([
        ["Initial summary", "superseded"],
      ]);
      expect(correction.source.digest).toBe(first.source.digest);
      expect(correction.source.rawEventSequence).toBe(first.source.rawEventSequence);

      await assertDatabaseInvariantRejected(
        Promise.resolve(db.update(commitmentSummary).set({ summary: "rewrite" })
          .where(eq(commitmentSummary.id, first.id))),
        "append-only",
      );
      await assertDatabaseInvariantRejected(
        Promise.resolve(db.delete(commitmentSummary).where(eq(commitmentSummary.id, first.id))),
        "append-only",
      );
    } finally {
      await close();
    }
  });

  it("never consults an injected clock when an explicit snapshot is supplied", async () => {
    const { db, close } = await fixture();
    const forbidden = { now: () => { throw new Error("raw clock read"); } };
    try {
      const open = await createCommitment(db, { title: "Clock safe" }, {
        workspaceId: "clock", actor: "agent", now: 3_000,
      });
      const done = await completeCommitment(db, open.id, {
        workspaceId: "clock", actor: "agent", expectedRevision: open.revision, now: 3_100,
      });
      const summary = await appendCommitmentSummary(db, {
        workspaceId: "clock", commitmentId: done.id, summary: "Deterministic",
        expectedPreviousSummaryId: null,
      }, { actor: "agent", idempotencyKey: "clock", now: 3_200, clock: forbidden });
      expect(summary.createdAt).toBe(3_200);
    } finally {
      await close();
    }
  });

  it("filters stale leaves before applying the current-summary limit", async () => {
    const { db, close } = await fixture();
    const workspaceId = "bounded-current";
    try {
      const olderOpen = await createCommitment(db, { title: "Older current" }, {
        workspaceId, actor: "agent", now: 4_000,
      });
      const olderDone = await completeCommitment(db, olderOpen.id, {
        workspaceId, actor: "agent", expectedRevision: olderOpen.revision, now: 4_100,
      });
      const older = await appendCommitmentSummary(db, {
        workspaceId, commitmentId: olderDone.id, summary: "Still current",
        expectedPreviousSummaryId: null,
      }, { actor: "agent", idempotencyKey: "older", now: 4_200 });
      const newerOpen = await createCommitment(db, { title: "Newer stale" }, {
        workspaceId, actor: "agent", now: 4_300,
      });
      const newerDone = await completeCommitment(db, newerOpen.id, {
        workspaceId, actor: "agent", expectedRevision: newerOpen.revision, now: 4_400,
      });
      await appendCommitmentSummary(db, {
        workspaceId, commitmentId: newerDone.id, summary: "Will become stale",
        expectedPreviousSummaryId: null,
      }, { actor: "agent", idempotencyKey: "newer", now: 4_500 });
      await reopenCommitment(db, newerDone.id, {
        workspaceId, actor: "agent", expectedRevision: newerDone.revision, now: 4_600,
      });
      expect((await listCurrentCommitmentSummaries(db, { workspaceId, limit: 1 }))
        .map((item) => item.id)).toEqual([older.id]);
    } finally {
      await close();
    }
  });
});

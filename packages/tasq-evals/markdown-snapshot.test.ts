/**
 * Eval: markdown projection snapshot.
 *
 * Build a deterministic dataset and snapshot the resulting markdown.
 * Catches accidental format regressions (e.g., status icons, header
 * structure, section ordering) that would silently break the agent's
 * expectations.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  openDb,
  runMigrations,
  createArea,
  createGoal,
  createProject,
  createTask,
  completeTask,
  startTask,
  blockTask,
  renderProjection,
  uuidv7,
} from "@tasq-internal/local-service";

const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length > 0) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

async function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "tasq-snap-"));
  tmpDirs.push(dir);
  const h = await openDb({ url: `file:${join(dir, "db.sqlite")}`, wal: false });
  await runMigrations(h.client);
  return h;
}

const FIXED_NOW = 1_750_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

describe("Markdown projection snapshot", () => {
  it("renders a comprehensive board with stable structure", async () => {
    const { db, close } = await freshDb();
    try {
      // Deterministic IDs to keep the snapshot stable
      const kamiId = uuidv7(FIXED_NOW - 100 * DAY);
      const bodyId = uuidv7(FIXED_NOW - 99 * DAY);
      const seriesAId = uuidv7(FIXED_NOW - 90 * DAY);
      const projId = uuidv7(FIXED_NOW - 50 * DAY);

      await createArea(db, {
        id: kamiId,
        name: "Career — Kami",
        slug: "kami",
        importance: 5,
        cadenceTarget: "daily",
      });
      await createArea(db, {
        id: bodyId,
        name: "Health — Body",
        slug: "body",
        importance: 5,
        cadenceTarget: "3x/week",
      });

      await createGoal(db, {
        id: seriesAId,
        areaId: kamiId,
        title: "Ship Series A",
        horizon: "Q2 2027",
        importance: 5,
      });

      await createProject(db, {
        id: projId,
        title: "Pitch deck v1",
        goalId: seriesAId,
        areaId: kamiId,
      });

      // Tasks
      const t1Id = uuidv7(FIXED_NOW - 30 * DAY);
      await createTask(db, {
        id: t1Id,
        title: "Outline 10 slides",
        nextAction: "Open Keynote",
        projectId: projId,
        goalId: seriesAId,
        areaId: kamiId,
        priority: 5,
      });

      const t2Id = uuidv7(FIXED_NOW - 25 * DAY);
      await createTask(db, {
        id: t2Id,
        title: "Hire 1st engineer",
        nextAction: "Draft outreach",
        goalId: seriesAId,
        areaId: kamiId,
        priority: 5,
      });

      // In-progress task
      const t3Id = uuidv7(FIXED_NOW - 20 * DAY);
      await createTask(db, {
        id: t3Id,
        title: "Section 3 of deck",
        projectId: projId,
        goalId: seriesAId,
        areaId: kamiId,
      });
      await startTask(db, t3Id);

      // Blocked
      const t4Id = uuidv7(FIXED_NOW - 15 * DAY);
      await createTask(db, {
        id: t4Id,
        title: "Wait for legal",
        projectId: projId,
        areaId: kamiId,
      });
      await blockTask(db, t4Id, { reason: "lawyer pending" });

      // Done (recently)
      const t5Id = uuidv7(FIXED_NOW - 10 * DAY);
      await createTask(db, {
        id: t5Id,
        title: "Initial market research",
        projectId: projId,
        areaId: kamiId,
      });
      await completeTask(db, t5Id);

      // Body area task
      const t6Id = uuidv7(FIXED_NOW - 5 * DAY);
      await createTask(db, {
        id: t6Id,
        title: "Book escalade",
        nextAction: "Climbing District app",
        areaId: bodyId,
      });

      // Orphan inbox task
      await createTask(db, {
        title: "Random thought",
        nextAction: "Decide later",
      });

      const md = await renderProjection(db, { now: FIXED_NOW });

      // Structural assertions (insensitive to timestamp/short-id which vary)
      expect(md).toContain("# TASKS.md — Active tasks (projection of tasq)");
      expect(md).toContain("## 🎯 Top priorities");
      expect(md).toContain("## Career — Kami");
      expect(md).toContain("## Health — Body");
      expect(md).toContain("📥 Inbox");
      expect(md).toContain("Closed in last 30 days");

      // Tasks visible
      expect(md).toContain("Outline 10 slides");
      expect(md).toContain("Hire 1st engineer");
      expect(md).toContain("Section 3 of deck");
      expect(md).toContain("Wait for legal");
      expect(md).toContain("Book escalade");
      expect(md).toContain("Random thought");
      expect(md).toContain("Initial market research"); // in closed section

      // Status icons reflect actual states
      expect(md).toContain("[~]"); // in_progress
      expect(md).toContain("[!]"); // blocked
      expect(md).toContain("[x]"); // done (in Closed section)

      // Goal ancestry visible
      expect(md).toContain("🎯 Ship Series A");
      expect(md).toContain("Q2 2027");

      // Project shown
      expect(md).toContain("📂 Pitch deck v1");

      // Inbox section exists for the orphan
      expect(md).toContain("Random thought");
    } finally {
      await close();
    }
  });

  it("empty DB produces a minimal valid markdown (no crash)", async () => {
    const { db, close } = await freshDb();
    try {
      const md = await renderProjection(db, { now: FIXED_NOW });
      expect(md).toContain("AUTO-GENERATED by tasq");
      expect(md).toContain("# TASKS.md");
      expect(md.length).toBeLessThan(1000); // sanity: not a giant blob
    } finally {
      await close();
    }
  });

  it("area with only completed/cancelled tasks is omitted from active section", async () => {
    const { db, close } = await freshDb();
    try {
      const a = await createArea(db, { name: "X", slug: "x", importance: 3 });
      const t = await createTask(db, { title: "old task", areaId: a.id });
      await completeTask(db, t.id);

      const md = await renderProjection(db, { now: FIXED_NOW });
      // The area heading is NOT printed because the only task is done
      expect(md).not.toContain("## X (#x");
      // But the task IS visible in the closed section
      expect(md).toContain("old task");
      expect(md).toContain("Closed in last 30 days");
    } finally {
      await close();
    }
  });

  it("status icon legend stays stable", async () => {
    // Lock in the human projection icon set; agents consume canonical JSON.
    const { db, close } = await freshDb();
    try {
      const a = await createArea(db, { name: "X", slug: "x", importance: 3 });
      await createTask(db, { title: "open task", areaId: a.id });
      const t2 = await createTask(db, { title: "ip task", areaId: a.id });
      await startTask(db, t2.id);
      const t3 = await createTask(db, { title: "blocked task", areaId: a.id });
      await blockTask(db, t3.id);
      const t4 = await createTask(db, { title: "done task", areaId: a.id });
      await completeTask(db, t4.id);

      const md = await renderProjection(db, { now: FIXED_NOW });
      expect(md).toContain("[ ] open task"); // open
      expect(md).toContain("[~] ip task"); // in_progress
      expect(md).toContain("[!] blocked task"); // blocked
      expect(md).toContain("[x] done task"); // done (in Closed section)
    } finally {
      await close();
    }
  });
});

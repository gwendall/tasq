/**
 * Eval: realistic long-running project with sub-tasks.
 *
 * Models a real-world "Renover salon" project that takes weeks, has
 * 3 phases with sub-tasks each, and accumulates real cycle-time data
 * as the user closes things over time.
 *
 * Validates : the agent sees coherent progress (% + ETA) ; the
 * prioritizer surfaces the right sub-tasks (not parents) ; the
 * markdown projection nests them readably.
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
  pickNext,
  getProjectProgress,
  renderProjection,
} from "@tasq-internal/local-service";

const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length > 0) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

async function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "tasq-long-"));
  tmpDirs.push(dir);
  const h = await openDb({ url: `file:${join(dir, "db.sqlite")}`, wal: false });
  await runMigrations(h.client);
  return h;
}

describe("Long project with sub-tasks — full agent journey", () => {
  it("Renover salon: 3 phases with sub-tasks, progress + projection", async () => {
    const { db, close } = await freshDb();
    try {
      // ─── Setup ───
      const home = await createArea(db, {
        name: "Home",
        slug: "home",
        importance: 4,
        cadenceTarget: "ad-hoc",
      });
      const lifeQuality = await createGoal(db, {
        areaId: home.id,
        title: "Vivre dans un espace qui me ressemble",
        horizon: "lifelong",
        importance: 4,
      });
      const reno = await createProject(db, {
        title: "Renover salon",
        areaId: home.id,
        goalId: lifeQuality.id,
      });

      // ─── 3 top-level "phase" tasks under the project ───
      const phase1 = await createTask(db, {
        title: "Phase 1 — Choix matériaux",
        projectId: reno.id,
        areaId: home.id,
        goalId: lifeQuality.id,
      });
      const phase2 = await createTask(db, {
        title: "Phase 2 — Travaux",
        projectId: reno.id,
        areaId: home.id,
        goalId: lifeQuality.id,
      });
      const phase3 = await createTask(db, {
        title: "Phase 3 — Finitions",
        projectId: reno.id,
        areaId: home.id,
        goalId: lifeQuality.id,
      });

      // ─── Sub-tasks under each phase (inherit area/goal/project) ───
      const p1a = await createTask(db, { title: "Visiter Castorama", parentTaskId: phase1.id });
      const p1b = await createTask(db, { title: "Choisir peinture", parentTaskId: phase1.id });
      const p1c = await createTask(db, { title: "Choisir parquet", parentTaskId: phase1.id });

      const p2a = await createTask(db, { title: "Préparer surfaces", parentTaskId: phase2.id });
      const p2b = await createTask(db, { title: "Peinture 1ère couche", parentTaskId: phase2.id });
      const p2c = await createTask(db, { title: "Peinture 2ème couche", parentTaskId: phase2.id });
      await createTask(db, { title: "Pose parquet", parentTaskId: phase2.id });

      await createTask(db, { title: "Plinthes", parentTaskId: phase3.id });
      await createTask(db, { title: "Décoration", parentTaskId: phase3.id });

      // ─── At t=0, what does the agent see ? ───

      // Phase tasks should be EXCLUDED from `next` because they have open sub-tasks
      const earlyNext = await pickNext(db, { limit: 10 });
      const earlyTitles = earlyNext.map((r) => r.task.title);
      expect(earlyTitles).not.toContain("Phase 1 — Choix matériaux");
      expect(earlyTitles).not.toContain("Phase 2 — Travaux");
      expect(earlyTitles).not.toContain("Phase 3 — Finitions");
      // Sub-tasks ARE in next
      expect(earlyTitles).toContain("Visiter Castorama");

      // Project progress at t=0
      const progressT0 = await getProjectProgress(db, reno.id);
      // The 3 phases are planning containers; progress counts 9 executable leaves.
      expect(progressT0.counts.total).toBe(9);
      expect(progressT0.percentDone).toBe(0);

      // ─── User closes Phase 1 sub-tasks one by one ───

      await startTask(db, p1a.id);
      await completeTask(db, p1a.id);
      await completeTask(db, p1b.id);
      await completeTask(db, p1c.id);

      // Now phase1 still has 0 sub-tasks open ; phase1 itself is open
      // → phase1 should reappear in `next` (as the natural close-the-phase action)
      const midNext = await pickNext(db, { limit: 10 });
      const midTitles = midNext.map((r) => r.task.title);
      expect(midTitles).toContain("Phase 1 — Choix matériaux");
      // phase2 + phase3 still hidden (their subs are still open)
      expect(midTitles).not.toContain("Phase 2 — Travaux");

      // ─── Close phase1 itself ───
      await completeTask(db, phase1.id);

      const progressT1 = await getProjectProgress(db, reno.id);
      // The completed phase remains a container; its 3 executable leaves count.
      expect(progressT1.counts.done).toBe(3);
      expect(progressT1.percentDone).toBe(Math.round((3 / 9) * 100));

      // ─── Markdown projection ───
      const md = await renderProjection(db);
      expect(md).toContain("📂 Renover salon");
      expect(md).toContain("Phase 1");
      expect(md).toContain("Phase 2");
      expect(md).toContain("Phase 3");
      // Sub-tasks should be visible too
      expect(md).toContain("Préparer surfaces");
      // Closed section now has phase1 + its subs
      expect(md).toContain("Closed in last 30 days");
    } finally {
      await close();
    }
  });

  it("agent narrative: parent task with all subs done is naturally next", async () => {
    const { db, close } = await freshDb();
    try {
      const area = await createArea(db, { name: "Work", slug: "work", importance: 5 });
      const parent = await createTask(db, {
        title: "Draft pitch deck",
        areaId: area.id,
        priority: 5,
      });
      const c1 = await createTask(db, { title: "Section 1", parentTaskId: parent.id });
      const c2 = await createTask(db, { title: "Section 2", parentTaskId: parent.id });
      const c3 = await createTask(db, { title: "Section 3", parentTaskId: parent.id });

      // Agent's first day: child tasks are the action items
      const day1 = await pickNext(db);
      expect(day1.map((r) => r.task.title)).toContain("Section 1");
      expect(day1.map((r) => r.task.title)).not.toContain("Draft pitch deck");

      // Close them
      await completeTask(db, c1.id);
      await completeTask(db, c2.id);
      await completeTask(db, c3.id);

      // Now agent sees "Draft pitch deck" itself as the next action (e.g., review + finalize)
      const day2 = await pickNext(db);
      expect(day2.map((r) => r.task.title)).toContain("Draft pitch deck");
    } finally {
      await close();
    }
  });
});

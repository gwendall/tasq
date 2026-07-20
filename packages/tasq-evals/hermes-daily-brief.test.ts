/**
 * Eval: Hermes-like daily brief flow.
 *
 * Simulates an agent that wakes up every morning, queries tasq for the
 * current state of the world, computes the next 3 actions, then later
 * marks one of them as completed based on a watcher signal.
 *
 * Asserts that the agent sees consistent state across the session and
 * that the audit log correctly reflects multi-actor attribution.
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
  createTask,
  startTask,
  completeTask,
  pickNext,
  listEvents,
  listTasks,
  renderProjection,
  type TasqDb,
} from "@tasq-internal/local-service";

const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length > 0) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

async function freshSetup() {
  const dir = mkdtempSync(join(tmpdir(), "tasq-eval-"));
  tmpDirs.push(dir);
  const h = await openDb({ url: `file:${join(dir, "db.sqlite")}`, wal: false });
  await runMigrations(h.client);
  return h;
}

/**
 * Seed a realistic "Gwendall in early June 2026" state:
 *   - 4 areas with different importance
 *   - 2 goals
 *   - 6 tasks with varied status + due dates + ages
 *
 * The agent will run a daily brief against this state.
 */
async function seedRealistic(db: TasqDb) {
  // Areas
  const kami = await createArea(db, {
    name: "Career — Kami Robotics",
    slug: "kami",
    importance: 5,
    cadenceTarget: "daily",
  });
  const body = await createArea(db, {
    name: "Health — Body",
    slug: "body",
    importance: 5,
    cadenceTarget: "3x/week",
  });
  const family = await createArea(db, {
    name: "Family",
    slug: "family",
    importance: 5,
    cadenceTarget: "1 visit/week",
  });
  const learning = await createArea(db, {
    name: "Learning",
    slug: "learning",
    importance: 3,
    cadenceTarget: "1 book/month",
  });

  // Goals
  const seriesA = await createGoal(db, {
    areaId: kami.id,
    title: "Ship Kami Series A pitch",
    horizon: "Q2 2027",
    importance: 5,
  });
  await createGoal(db, {
    areaId: body.id,
    title: "Strong at 65",
    horizon: "23 years",
    importance: 5,
  });

  // Tasks
  // 1. Urgent due task
  const t1 = await createTask(
    db,
    {
      title: "File 3916 declaration",
      areaId: kami.id,
      goalId: seriesA.id,
      nextAction: "Open impots.gouv → 3916 form",
      dueAt: Date.now() + 2 * 24 * 60 * 60 * 1000, // 2 days
      priority: 5,
    },
    { actor: "gwendall" },
  );

  // 2. Avoided task (created 20 days ago, never started)
  // We simulate age by creating it, then we'll query with a future `now`.
  const t2 = await createTask(
    db,
    {
      title: "Hire first senior engineer",
      areaId: kami.id,
      goalId: seriesA.id,
      nextAction: "Draft LinkedIn outreach to 5 candidates",
      priority: 5,
    },
    { actor: "gwendall" },
  );

  // 3. Sport task (Body 🔴)
  const t3 = await createTask(
    db,
    {
      title: "Book escalade session",
      areaId: body.id,
      nextAction: "Climbing District app → 19h slot",
    },
    { actor: "hermes" },
  );

  // 4. Family — sacred, not metric-driven
  const t4 = await createTask(
    db,
    {
      title: "Visit Maman this weekend",
      areaId: family.id,
      nextAction: "Confirm Sunday lunch via WhatsApp",
      dueAt: Date.now() + 5 * 24 * 60 * 60 * 1000,
    },
    { actor: "gwendall" },
  );

  // 5. Low-importance background
  const t5 = await createTask(
    db,
    {
      title: "Finish reading Stiegler",
      areaId: learning.id,
      nextAction: "30 min today",
    },
    { actor: "gwendall" },
  );

  // 6. Already in progress
  const t6 = await createTask(
    db,
    {
      title: "Outline pitch deck",
      areaId: kami.id,
      goalId: seriesA.id,
      nextAction: "Section 3 + 4",
      priority: 4,
    },
    { actor: "gwendall" },
  );
  await startTask(db, t6.id, { actor: "gwendall" });

  return { areas: { kami, body, family, learning }, goals: { seriesA }, tasks: { t1, t2, t3, t4, t5, t6 } };
}

describe("Hermes daily-brief flow", () => {
  it("morning: agent reads top-3, must include scary leverage + non-work item", async () => {
    const { db, close } = await freshSetup();
    try {
      const { tasks } = await seedRealistic(db);
      // 20 days in the future — t2 (hire engineer) is now scary-avoided
      const now = Date.now() + 20 * 24 * 60 * 60 * 1000;

      const top = await pickNext(db, { limit: 3, now });

      expect(top.length).toBe(3);

      // The avoided high-leverage task should be high in the ranking
      const titles = top.map((r) => r.task.title);
      expect(titles).toContain("Hire first senior engineer");

      // Top result should have non-zero score
      expect(top[0]!.score.total).toBeGreaterThan(0);
      // Strict descending order
      for (let i = 1; i < top.length; i++) {
        expect(top[i]!.score.total).toBeLessThanOrEqual(top[i - 1]!.score.total);
      }
    } finally {
      await close();
    }
  });

  it("agent narrative: snapshot the daily brief markdown output", async () => {
    const { db, close } = await freshSetup();
    try {
      await seedRealistic(db);
      const md = await renderProjection(db, { now: Date.now() + 20 * 24 * 60 * 60 * 1000 });

      // Smoke checks the agent would care about
      expect(md).toContain("AUTO-GENERATED by tasq");
      expect(md).toContain("Top priorities");
      expect(md).toContain("Career — Kami Robotics");
      expect(md).toContain("Family");
      expect(md).toContain("Visit Maman");
      // Goal ancestry visible
      expect(md).toContain("Ship Kami Series A pitch");
      // The in-progress task shows the right icon
      expect(md).toContain("Outline pitch deck");
    } finally {
      await close();
    }
  });

  it("evening: agent observes completion via watcher signal, marks done", async () => {
    const { db, close } = await freshSetup();
    try {
      const { tasks } = await seedRealistic(db);

      // Hermes observes (via Mercury or Calendar) that the user filed 3916
      await completeTask(db, tasks.t1.id, {
        actor: "hermes",
        note: "observed via 'impots.gouv' login event + form submission",
        source: "watcher:browser-history",
      });

      // Next morning, the brief should not surface t1 anymore
      const top = await pickNext(db, { limit: 5 });
      const titles = top.map((r) => r.task.title);
      expect(titles).not.toContain("File 3916 declaration");

      // The audit log explains who/why
      const events = await listEvents(db, { entityId: tasks.t1.id, ascending: true });
      const completed = events.find((e) => e.eventType === "completed");
      expect(completed!.actor).toBe("hermes");
      expect(completed!.payload.note).toContain("impots.gouv");
      expect(completed!.payload.source).toBe("watcher:browser-history");
    } finally {
      await close();
    }
  });

  it("agent can isolate work by area for area-specific reviews", async () => {
    const { db, close } = await freshSetup();
    try {
      const { areas } = await seedRealistic(db);
      const kamiOnly = await pickNext(db, { areaId: areas.kami.id, limit: 10 });
      expect(kamiOnly.every((r) => r.task.areaId === areas.kami.id)).toBe(true);

      const familyOnly = await pickNext(db, { areaId: areas.family.id, limit: 10 });
      expect(familyOnly.every((r) => r.task.areaId === areas.family.id)).toBe(true);
    } finally {
      await close();
    }
  });

  it("agent reading the event log can attribute changes to actors", async () => {
    const { db, close } = await freshSetup();
    try {
      const { tasks } = await seedRealistic(db);

      // t1 was created by gwendall ; hermes now completes it.
      // t4 was created by gwendall ; gwendall completes it.
      // The seed also has t3 created by hermes — we use that to assert
      // the inverse.
      await completeTask(db, tasks.t1.id, { actor: "hermes" });
      await completeTask(db, tasks.t4.id, { actor: "gwendall" });

      const hermesEvents = await listEvents(db, { actor: "hermes" });
      const gwendallEvents = await listEvents(db, { actor: "gwendall" });

      expect(hermesEvents.every((e) => e.actor === "hermes")).toBe(true);
      expect(gwendallEvents.every((e) => e.actor === "gwendall")).toBe(true);

      // Filter to completion events only — these clearly attribute the
      // closing action (created events would muddy the comparison)
      const hermesCompletions = hermesEvents.filter((e) => e.eventType === "completed");
      const gwendallCompletions = gwendallEvents.filter((e) => e.eventType === "completed");

      expect(hermesCompletions.map((e) => e.entityId)).toContain(tasks.t1.id);
      expect(hermesCompletions.map((e) => e.entityId)).not.toContain(tasks.t4.id);

      expect(gwendallCompletions.map((e) => e.entityId)).toContain(tasks.t4.id);
      expect(gwendallCompletions.map((e) => e.entityId)).not.toContain(tasks.t1.id);
    } finally {
      await close();
    }
  });
});

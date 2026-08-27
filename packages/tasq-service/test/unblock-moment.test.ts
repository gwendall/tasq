/**
 * What a completion just opened.
 *
 * A locked door is half the mechanic; the other half is seeing it open the
 * moment you finish the thing that was holding it. Completing a blocker
 * emitted nothing to its dependents, and `justUnblocked` is recomputed on read
 * over a seven-day window and a bounded event scan - a heuristic, not an answer.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cancelTask,
  completeTask,
  createTask,
  dependTask,
  newlyActionableAfter,
  openDb,
  runMigrations,
} from "../src/index.js";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const NOW = 1_800_000_000_000;

async function chain() {
  const dir = mkdtempSync(join(tmpdir(), "tasq-unblock-"));
  dirs.push(dir);
  const handle = await openDb({ url: `file:${join(dir, "db.sqlite")}`, wal: false });
  await runMigrations(handle.client);
  const reproduce = await createTask(handle.db, { title: "reproduce the bug" });
  const fix = await createTask(handle.db, { title: "ship the fix" });
  const changelog = await createTask(handle.db, { title: "write the changelog" });
  await dependTask(handle.db, { fromTaskId: fix.id, toTaskId: reproduce.id, type: "blocks" });
  await dependTask(handle.db, { fromTaskId: changelog.id, toTaskId: reproduce.id, type: "blocks" });
  await dependTask(handle.db, { fromTaskId: changelog.id, toTaskId: fix.id, type: "blocks" });
  return { ...handle, reproduce, fix, changelog };
}

describe("what a completion opens", () => {
  it("names only what is actionable now, not everything downstream", async () => {
    const f = await chain();
    try {
      await completeTask(f.db, f.reproduce.id, { now: NOW });
      const opened = await newlyActionableAfter(f.db, f.reproduce.id, "gwendall");

      // The changelog still waits on the fix. Reporting it would be the same
      // lie a transitive walk tells: opened is not the same as reachable.
      expect(opened.map((entry) => entry.title)).toEqual(["ship the fix"]);
    } finally {
      await f.close();
    }
  });

  it("opens the rest of the chain only as each blocker resolves", async () => {
    const f = await chain();
    try {
      await completeTask(f.db, f.reproduce.id, { now: NOW });
      await completeTask(f.db, f.fix.id, { now: NOW + 1 });
      const opened = await newlyActionableAfter(f.db, f.fix.id, "gwendall");
      expect(opened.map((entry) => entry.title)).toEqual(["write the changelog"]);
    } finally {
      await f.close();
    }
  });

  it("says nothing when a completion frees nobody", async () => {
    const f = await chain();
    try {
      // The changelog blocks nothing, so finishing it opens nothing.
      await completeTask(f.db, f.changelog.id, { now: NOW });
      expect(await newlyActionableAfter(f.db, f.changelog.id, "gwendall")).toEqual([]);
    } finally {
      await f.close();
    }
  });

  it("counts a cancellation, because a withdrawn blocker stops blocking too", async () => {
    const f = await chain();
    try {
      await cancelTask(f.db, f.reproduce.id, { now: NOW, reason: "not reproducible" });
      const opened = await newlyActionableAfter(f.db, f.reproduce.id, "gwendall");
      expect(opened.map((entry) => entry.title)).toEqual(["ship the fix"]);
    } finally {
      await f.close();
    }
  });

  it("is exact rather than a time window", async () => {
    const f = await chain();
    try {
      // Nothing is complete, so nothing is open - a seven-day heuristic scanning
      // recent events cannot make that distinction reliably.
      expect(await newlyActionableAfter(f.db, f.reproduce.id, "gwendall")).toEqual([]);
    } finally {
      await f.close();
    }
  });
});

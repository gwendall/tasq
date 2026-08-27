/**
 * The fleet view: who holds what, right now.
 *
 * ADR-022 names this as the product. The lease is what makes it possible
 * without owning a process, so these tests pin the two things that matter: it
 * says who when the ledger knows, and it says so honestly when it does not.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireTaskClaim, buildFleetView, createTask, openDb, runMigrations } from "../src/index.js";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const NOW = 1_800_000_000_000;

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "tasq-fleet-"));
  dirs.push(dir);
  const handle = await openDb({ url: `file:${join(dir, "db.sqlite")}`, wal: false });
  await runMigrations(handle.client);
  return handle;
}

const CLAUDE = {
  "tasq.client": { name: "claude-code", version: "2.1.246", source: "mcp.initialize" },
  "tasq.runtime": { pid: 4242, cwd: "/Users/someone/Code/foo" },
};

describe("the fleet view", () => {
  it("names the client and where it runs, when the ledger knows", async () => {
    const f = await fixture();
    try {
      const task = await createTask(f.db, { title: "fix the parser" });
      await acquireTaskClaim(f.db, task.id, {
        actor: "agent:a", now: NOW, leaseMs: 1_800_000,
        metadata: CLAUDE, idempotencyKey: "fleet:a",
      });

      const view = await buildFleetView(f.db, "gwendall", NOW + 30_000);
      expect(view.holders).toHaveLength(1);
      const holder = view.holders[0]!;
      expect(holder.client).toBe("claude-code");
      expect(holder.clientVersion).toBe("2.1.246");
      expect(holder.cwd).toBe("/Users/someone/Code/foo");
      expect(holder.pid).toBe(4242);
      expect(holder.held[0]!.title).toBe("fix the parser");
      expect(holder.held[0]!.sinceHeartbeatMs).toBe(30_000);
    } finally {
      await f.close();
    }
  });

  it("says the actor and nothing more when no client was reported", async () => {
    const f = await fixture();
    try {
      const task = await createTask(f.db, { title: "work from the CLI" });
      await acquireTaskClaim(f.db, task.id, {
        actor: "gwendall", now: NOW, leaseMs: 600_000, idempotencyKey: "fleet:cli",
      });

      const view = await buildFleetView(f.db, "gwendall", NOW);
      const holder = view.holders[0]!;
      // Honest about being all the ledger knows, rather than inventing a name.
      expect(holder.client).toBeNull();
      expect(holder.cwd).toBeNull();
      expect(holder.actor).toBe("gwendall");
    } finally {
      await f.close();
    }
  });

  it("separates the same product running in two projects", async () => {
    const f = await fixture();
    try {
      const here = await createTask(f.db, { title: "in foo" });
      const there = await createTask(f.db, { title: "in bar" });
      await acquireTaskClaim(f.db, here.id, {
        actor: "agent:a", now: NOW, leaseMs: 600_000,
        metadata: CLAUDE, idempotencyKey: "fleet:foo",
      });
      await acquireTaskClaim(f.db, there.id, {
        actor: "agent:b", now: NOW, leaseMs: 600_000,
        metadata: { ...CLAUDE, "tasq.runtime": { pid: 99, cwd: "/Users/someone/Code/bar" } },
        idempotencyKey: "fleet:bar",
      });

      const view = await buildFleetView(f.db, "gwendall", NOW);
      expect(view.holders).toHaveLength(2);
      expect(view.holders.map((holder) => holder.cwd).sort())
        .toEqual(["/Users/someone/Code/bar", "/Users/someone/Code/foo"]);
    } finally {
      await f.close();
    }
  });

  it("drops a holder the moment its lease lapses, with no cleanup", async () => {
    const f = await fixture();
    try {
      const task = await createTask(f.db, { title: "abandoned mid-flight" });
      await acquireTaskClaim(f.db, task.id, {
        actor: "agent:gone", now: NOW, leaseMs: 60_000, idempotencyKey: "fleet:gone",
      });

      expect((await buildFleetView(f.db, "gwendall", NOW + 59_000)).holders).toHaveLength(1);
      // Nothing ran, nothing was written, and the row is gone. That is the
      // whole argument for showing a fleet without owning a process.
      expect((await buildFleetView(f.db, "gwendall", NOW + 61_000)).holders).toEqual([]);
    } finally {
      await f.close();
    }
  });

  it("puts the soonest to lapse first, because that is the row to act on", async () => {
    const f = await fixture();
    try {
      const slow = await createTask(f.db, { title: "plenty of time" });
      const urgent = await createTask(f.db, { title: "about to lapse" });
      await acquireTaskClaim(f.db, slow.id, {
        actor: "agent:a", now: NOW, leaseMs: 1_800_000, metadata: CLAUDE, idempotencyKey: "fleet:slow",
      });
      await acquireTaskClaim(f.db, urgent.id, {
        actor: "agent:a", now: NOW, leaseMs: 30_000, metadata: CLAUDE, idempotencyKey: "fleet:urgent",
      });

      const held = (await buildFleetView(f.db, "gwendall", NOW)).holders[0]!.held;
      expect(held.map((entry) => entry.title)).toEqual(["about to lapse", "plenty of time"]);
    } finally {
      await f.close();
    }
  });
});

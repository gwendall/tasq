/**
 * A blocked commitment must be unclaimable, not merely unlisted.
 *
 * Until 2026-08-27 blocking was enforced in exactly one place: the prioritizer
 * filtered blocked commitments out of `next`. Asking for one directly still
 * worked - claim, start, complete - so the door was off the map rather than
 * locked. Verified on the maintainer's own ledger before this was fixed.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireTaskClaim,
  completeTask,
  createTask,
  dependTask,
  openDb,
  pickNext,
  runMigrations,
  undependTask,
} from "../src/index.js";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const NOW = 1_800_000_000_000;

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "tasq-blocked-"));
  dirs.push(dir);
  const handle = await openDb({ url: `file:${join(dir, "db.sqlite")}`, wal: false });
  await runMigrations(handle.client);
  const blocker = await createTask(handle.db, { title: "the blocker" });
  const dependent = await createTask(handle.db, { title: "the dependent" });
  await dependTask(handle.db, { fromTaskId: dependent.id, toTaskId: blocker.id, type: "blocks" });
  return { ...handle, blocker, dependent };
}

describe("claiming a blocked commitment", () => {
  it("is refused, and names the blocker so the refusal is actionable", async () => {
    const f = await fixture();
    try {
      // Selection already hid it; the point is that asking directly is refused too.
      const next = await pickNext(f.db, { now: NOW });
      expect(next.map((entry) => entry.task.id)).not.toContain(f.dependent.id);

      await expect(acquireTaskClaim(f.db, f.dependent.id, {
        actor: "agent-a", now: NOW, leaseMs: 60_000, idempotencyKey: "claim:blocked",
      })).rejects.toThrow(/blocked by 1 unresolved commitment/);

      await expect(acquireTaskClaim(f.db, f.dependent.id, {
        actor: "agent-a", now: NOW, leaseMs: 60_000, idempotencyKey: "claim:blocked-2",
      })).rejects.toThrow(new RegExp(f.blocker.id));
    } finally {
      await f.close();
    }
  });

  it("lets force take it, because an override must be possible and deliberate", async () => {
    const f = await fixture();
    try {
      const claim = await acquireTaskClaim(f.db, f.dependent.id, {
        actor: "agent-a", now: NOW, leaseMs: 60_000, force: true, idempotencyKey: "claim:forced",
      });
      expect(claim.actor).toBe("agent-a");
    } finally {
      await f.close();
    }
  });

  it("stops refusing once the blocker resolves", async () => {
    const f = await fixture();
    try {
      await completeTask(f.db, f.blocker.id, { now: NOW + 1 });
      const claim = await acquireTaskClaim(f.db, f.dependent.id, {
        actor: "agent-a", now: NOW + 2, leaseMs: 60_000, idempotencyKey: "claim:unblocked",
      });
      expect(claim.actor).toBe("agent-a");
    } finally {
      await f.close();
    }
  });

  it("stops refusing once the edge is dropped", async () => {
    const f = await fixture();
    try {
      // The edge id is optional; the natural key is the ergonomic form.
      await undependTask(f.db, null, { fromTaskId: f.dependent.id, toTaskId: f.blocker.id, type: "blocks" });
      const claim = await acquireTaskClaim(f.db, f.dependent.id, {
        actor: "agent-a", now: NOW + 1, leaseMs: 60_000, idempotencyKey: "claim:undepended",
      });
      expect(claim.actor).toBe("agent-a");
    } finally {
      await f.close();
    }
  });

  it("leaves an unblocked commitment exactly as it was", async () => {
    const f = await fixture();
    try {
      const claim = await acquireTaskClaim(f.db, f.blocker.id, {
        actor: "agent-a", now: NOW, leaseMs: 60_000, idempotencyKey: "claim:plain",
      });
      expect(claim.actor).toBe("agent-a");
    } finally {
      await f.close();
    }
  });
});

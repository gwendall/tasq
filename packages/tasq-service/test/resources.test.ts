import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMutableClock, type MutableClock } from "@tasq-run/schema";
import {
  ResourceLeaseError,
  acquireResourceLease,
  bootstrapCoordinationSpace,
  getResourceLeaseView,
  listResourceEvents,
  listResourceWorld,
  openDb,
  releaseResourceLease,
  renewResourceLease,
  runMigrations,
  sweepExpiredResources,
  verifyResourceFence,
} from "../src/index.js";

const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

async function fresh(workspaceId = "robotics/team-a", actor = "alpha") {
  const dir = mkdtempSync(join(tmpdir(), "tasq-resource-"));
  tmpDirs.push(dir);
  const handle = await openDb({ url: `file:${join(dir, "db.sqlite")}`, wal: false });
  const clock = createMutableClock(10_000);
  await runMigrations(handle.client, { clock, installReferenceExtension: false });
  await bootstrapCoordinationSpace(handle.db, { workspaceId, actor, clock });
  return { ...handle, clock, workspaceId };
}

function acquireOptions(clock: MutableClock, workspaceId: string, actor = "alpha", key = "acquire-1") {
  return { workspaceId, actor, clock, leaseMs: 5_000, idempotencyKey: key };
}

describe("generic resource lease service", () => {
  it("requires an explicit clock, explicit space and durable retry identity", async () => {
    const h = await fresh();
    try {
      await expect(acquireResourceLease(h.db, "arm:left", {
        workspaceId: h.workspaceId, actor: "alpha", idempotencyKey: "x",
      } as any)).rejects.toMatchObject({ code: "invalid_input" });
      await expect(acquireResourceLease(h.db, "arm:left", {
        workspaceId: h.workspaceId, actor: "alpha", clock: h.clock,
      } as any)).rejects.toMatchObject({ code: "invalid_input" });
      await expect(acquireResourceLease(h.db, "arm:left", {
        ...acquireOptions(h.clock, "missing", "alpha", "x"),
      })).rejects.toMatchObject({ code: "space_not_found" });
    } finally {
      await h.close();
    }
  });

  it("acquires once, replays byte-equivalent semantics and rejects conflicting key reuse", async () => {
    const h = await fresh();
    try {
      const first = await acquireResourceLease(h.db, "arm:left", {
        ...acquireOptions(h.clock, h.workspaceId), metadata: { mode: "calibrate" },
      });
      expect(first).toMatchObject({ disposition: "acquired", observedAt: 10_000, lease: { fence: 1, revision: 1 } });
      h.clock.advance(100);
      const replay = await acquireResourceLease(h.db, "arm:left", {
        ...acquireOptions(h.clock, h.workspaceId), metadata: { mode: "calibrate" },
      });
      expect(replay).toEqual(first);
      await expect(acquireResourceLease(h.db, "arm:right", {
        ...acquireOptions(h.clock, h.workspaceId), metadata: { mode: "calibrate" },
      })).rejects.toThrow(/different request/);
      const events = await listResourceEvents(h.db, { workspaceId: h.workspaceId, actor: "reader", clock: h.clock });
      expect(events.events.map((event) => event.eventType)).toEqual(["resource_lease_acquired"]);
    } finally {
      await h.close();
    }
  });

  it("returns the existing authority without extending it to the same holder", async () => {
    const h = await fresh();
    try {
      const first = await acquireResourceLease(h.db, "arm:left", acquireOptions(h.clock, h.workspaceId));
      h.clock.advance(1_000);
      const second = await acquireResourceLease(h.db, "arm:left", acquireOptions(h.clock, h.workspaceId, "alpha", "acquire-2"));
      expect(second.disposition).toBe("already_held");
      expect(second.lease).toEqual(first.lease);
      expect((await listResourceEvents(h.db, { workspaceId: h.workspaceId, actor: "reader", clock: h.clock })).events).toHaveLength(1);
    } finally {
      await h.close();
    }
  });

  it("gives exactly one contender authority and exposes actionable current ownership", async () => {
    const h = await fresh();
    try {
      await bootstrapCoordinationSpace(h.db, { workspaceId: h.workspaceId, actor: "beta", clock: h.clock });
      const [alpha, beta] = await Promise.allSettled([
        acquireResourceLease(h.db, "arm:left", acquireOptions(h.clock, h.workspaceId, "alpha", "alpha-1")),
        acquireResourceLease(h.db, "arm:left", acquireOptions(h.clock, h.workspaceId, "beta", "beta-1")),
      ]);
      expect([alpha.status, beta.status].sort()).toEqual(["fulfilled", "rejected"]);
      const rejection = (alpha.status === "rejected" ? alpha.reason : (beta as PromiseRejectedResult).reason) as ResourceLeaseError;
      expect(rejection).toMatchObject({ code: "contended", currentLease: { status: "active" } });
      expect(rejection.currentLease?.lease.fence).toBe(1);
      expect(rejection.currentLease?.lease.expiresAt).toBe(15_000);
    } finally {
      await h.close();
    }
  });

  it("renews with CAS, releases, reacquires with a higher fence and invalidates stale authority", async () => {
    const h = await fresh();
    try {
      const first = await acquireResourceLease(h.db, "arm:left", acquireOptions(h.clock, h.workspaceId));
      h.clock.advance(1_000);
      const renewed = await renewResourceLease(h.db, "arm:left", {
        workspaceId: h.workspaceId,
        actor: "alpha",
        clock: h.clock,
        idempotencyKey: "renew-1",
        leaseId: first.lease.id,
        fence: first.lease.fence,
        expectedRevision: first.lease.revision,
        leaseMs: 8_000,
      });
      expect(renewed).toMatchObject({ disposition: "renewed", lease: { id: first.lease.id, fence: 1, revision: 2, expiresAt: 19_000 } });
      expect(await verifyResourceFence(h.db, "arm:left", {
        workspaceId: h.workspaceId, actor: "alpha", clock: h.clock,
        leaseId: renewed.lease.id, fence: renewed.lease.fence,
      })).toMatchObject({ status: "valid", fence: 1 });

      h.clock.advance(1_000);
      const released = await releaseResourceLease(h.db, "arm:left", {
        workspaceId: h.workspaceId,
        actor: "alpha",
        clock: h.clock,
        idempotencyKey: "release-1",
        leaseId: renewed.lease.id,
        fence: renewed.lease.fence,
        expectedRevision: renewed.lease.revision,
      });
      expect(released.disposition).toBe("released");
      const next = await acquireResourceLease(h.db, "arm:left", acquireOptions(h.clock, h.workspaceId, "alpha", "acquire-2"));
      expect(next.lease.fence).toBe(2);
      expect(next.lease.id).not.toBe(first.lease.id);
      await expect(verifyResourceFence(h.db, "arm:left", {
        workspaceId: h.workspaceId, actor: "alpha", clock: h.clock,
        leaseId: first.lease.id, fence: first.lease.fence,
      })).rejects.toMatchObject({ code: "stale_fence" });
    } finally {
      await h.close();
    }
  });

  it("treats exact expiry as invalid, reclaims atomically and rejects clock rewind", async () => {
    const h = await fresh();
    try {
      const first = await acquireResourceLease(h.db, "arm:left", acquireOptions(h.clock, h.workspaceId));
      h.clock.set(first.lease.expiresAt);
      await expect(verifyResourceFence(h.db, "arm:left", {
        workspaceId: h.workspaceId, actor: "alpha", clock: h.clock,
        leaseId: first.lease.id, fence: first.lease.fence,
      })).rejects.toMatchObject({ code: "expired" });
      await bootstrapCoordinationSpace(h.db, { workspaceId: h.workspaceId, actor: "beta", clock: h.clock });
      const reclaimed = await acquireResourceLease(h.db, "arm:left", acquireOptions(h.clock, h.workspaceId, "beta", "beta-reclaim"));
      expect(reclaimed).toMatchObject({ disposition: "reclaimed", lease: { fence: 2, holderActor: "beta" } });
      h.clock.set(reclaimed.lease.heartbeatAt - 1);
      await expect(getResourceLeaseView(h.db, "arm:left", {
        workspaceId: h.workspaceId, actor: "reader", clock: h.clock,
      })).rejects.toMatchObject({ code: "clock_regression" });
      await expect(verifyResourceFence(h.db, "arm:left", {
        workspaceId: h.workspaceId, actor: "beta", clock: h.clock,
        leaseId: reclaimed.lease.id, fence: reclaimed.lease.fence,
      })).rejects.toMatchObject({ code: "clock_regression" });
    } finally {
      await h.close();
    }
  });

  it("sweeps expiry, paginates the ordered stream and keeps unrelated resources independent", async () => {
    const h = await fresh();
    try {
      await acquireResourceLease(h.db, "arm:left", acquireOptions(h.clock, h.workspaceId, "alpha", "left"));
      await acquireResourceLease(h.db, "camera:front", acquireOptions(h.clock, h.workspaceId, "alpha", "camera"));
      const before = await listResourceWorld(h.db, { workspaceId: h.workspaceId, actor: "reader", clock: h.clock, activeOnly: true });
      expect(before.leases.map((item) => item.lease.resourceKey)).toEqual(["arm:left", "camera:front"]);
      h.clock.advance(5_000);
      const swept = await sweepExpiredResources(h.db, { workspaceId: h.workspaceId, actor: "sweeper", clock: h.clock, limit: 1 });
      expect(swept.expired).toHaveLength(1);
      expect((await listResourceWorld(h.db, { workspaceId: h.workspaceId, actor: "reader", clock: h.clock, activeOnly: true })).leases).toHaveLength(0);
      const sweptAgain = await sweepExpiredResources(h.db, { workspaceId: h.workspaceId, actor: "sweeper", clock: h.clock });
      expect(sweptAgain.expired).toHaveLength(1);
      const page1 = await listResourceEvents(h.db, { workspaceId: h.workspaceId, actor: "reader", clock: h.clock, limit: 2 });
      const page2 = await listResourceEvents(h.db, {
        workspaceId: h.workspaceId, actor: "reader", clock: h.clock,
        afterSequence: page1.nextCursor.afterSequence, limit: 10,
      });
      expect([...page1.events, ...page2.events].map((event) => event.sequence)).toEqual([1, 2, 3, 4]);
    } finally {
      await h.close();
    }
  });

  it("enforces append history and immutable events at the SQL boundary", async () => {
    const h = await fresh();
    try {
      const acquired = await acquireResourceLease(h.db, "arm:left", acquireOptions(h.clock, h.workspaceId));
      await expect(h.client.execute({
        sql: "UPDATE resource_lease SET fence = 99 WHERE id = ?",
        args: [acquired.lease.id],
      })).rejects.toThrow(/resource_lease/);
      await expect(h.client.execute({
        sql: "DELETE FROM resource_lease WHERE id = ?",
        args: [acquired.lease.id],
      })).rejects.toThrow(/append-history/);
      await expect(h.client.execute("UPDATE resource_event SET payload = '{}' WHERE sequence = 1"))
        .rejects.toThrow(/immutable/);
      await expect(h.client.execute("DELETE FROM resource_event WHERE sequence = 1"))
        .rejects.toThrow(/immutable/);
    } finally {
      await h.close();
    }
  });
});

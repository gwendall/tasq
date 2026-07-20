import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMutableClock } from "@tasq/schema";
import {
  createArea,
  createTask,
  disableDeliverySink,
  ensureDeliverySink,
  getDeliverySink,
  listDeliveryOutbox,
  leaseNextDelivery,
  completeDelivery,
  committedMutationCount,
  failDelivery,
  repairDelivery,
  listEvents,
  listTasks,
  openDb,
  runMigrations,
  setEventListener,
} from "../src/index.js";

const tmpDirs: string[] = [];

afterEach(() => {
  setEventListener(null);
  while (tmpDirs.length > 0) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

async function freshDb(clock = createMutableClock(1_900_000_000_000)) {
  const dir = mkdtempSync(join(tmpdir(), "tasq-delivery-"));
  tmpDirs.push(dir);
  const handle = await openDb({ url: `file:${join(dir, "db.sqlite")}`, wal: false });
  await runMigrations(handle.client, { clock });
  return { ...handle, clock };
}

const sink = {
  id: "test:event-journal",
  kind: "urn:test:sink:event-journal:v1",
  configurationDigest: `sha256:${"a".repeat(64)}`,
};

describe("transactional delivery outbox", () => {
  it("starts a newly registered sink after the existing event cursor", async () => {
    const { db, close, clock } = await freshDb();
    try {
      await createArea(db, { name: "Existing", slug: "existing", importance: 3 }, { clock });
      const registered = await ensureDeliverySink(db, sink, { clock });
      expect(registered.startAfterSequence).toBe(1);
      expect(await listDeliveryOutbox(db, { sinkId: sink.id })).toEqual([]);

      clock.advance(10);
      const task = await createTask(db, { title: "queued" }, { clock });
      const events = await listEvents(db, { entityId: task.id });
      const outbox = await listDeliveryOutbox(db, { sinkId: sink.id });
      expect(outbox).toHaveLength(1);
      expect(outbox[0]).toMatchObject({
        id: `${sink.id}/${events[0]!.id}`,
        eventId: events[0]!.id,
        eventSequence: events[0]!.sequence,
        status: "pending",
        attemptCount: 0,
        availableAt: 1_900_000_000_010,
        createdAt: 1_900_000_000_010,
        updatedAt: 1_900_000_000_010,
      });
    } finally {
      await close();
    }
  });

  it("rolls back the domain mutation when atomic outbox enqueue fails", async () => {
    const { db, client, close, clock } = await freshDb();
    try {
      await ensureDeliverySink(db, sink, { clock });
      await client.execute("DROP TABLE delivery_outbox");

      await expect(createTask(db, { title: "must roll back" }, { clock })).rejects.toThrow();
      expect(await listTasks(db)).toEqual([]);
      expect(await listEvents(db, { entityType: "task" })).toEqual([]);
    } finally {
      await close();
    }
  });

  it("survives the post-commit crash boundary even when no listener runs", async () => {
    const { db, close, clock } = await freshDb();
    await ensureDeliverySink(db, sink, { clock });
    setEventListener(null);
    const task = await createTask(db, { title: "durable after commit" }, { clock });
    await close();

    const dir = tmpDirs[0]!;
    const reopened = await openDb({ url: `file:${join(dir, "db.sqlite")}`, wal: false });
    try {
      const queued = await listDeliveryOutbox(reopened.db, { sinkId: sink.id });
      expect(queued).toHaveLength(1);
      expect(queued[0]).toMatchObject({ eventId: (await listEvents(reopened.db, {
        entityId: task.id,
      }))[0]!.id, status: "pending" });
    } finally {
      await reopened.close();
    }
  });

  it("fails closed on silent retargeting and stops future enqueue when disabled", async () => {
    const { db, close, clock } = await freshDb();
    try {
      await ensureDeliverySink(db, sink, { clock });
      await expect(ensureDeliverySink(db, {
        ...sink,
        configurationDigest: `sha256:${"b".repeat(64)}`,
      }, { clock })).rejects.toThrow(/different kind or configuration/);

      clock.advance(1);
      const disabled = await disableDeliverySink(db, sink.id, { clock });
      expect(disabled?.status).toBe("disabled");
      expect((await getDeliverySink(db, sink.id))?.updatedAt).toBe(1_900_000_000_001);
      await createTask(db, { title: "not queued" }, { clock });
      expect(await listDeliveryOutbox(db, { sinkId: sink.id })).toEqual([]);
    } finally {
      await close();
    }
  });

  it("scopes the same logical sink id independently per tenant", async () => {
    const { db, close, clock } = await freshDb();
    try {
      const first = await ensureDeliverySink(db, sink, { tenantId: "workspace-a", clock });
      const second = await ensureDeliverySink(db, {
        ...sink,
        configurationDigest: `sha256:${"b".repeat(64)}`,
      }, { tenantId: "workspace-b", clock });
      expect(first).toMatchObject({ id: sink.id, tenantId: "workspace-a" });
      expect(second).toMatchObject({ id: sink.id, tenantId: "workspace-b" });
      expect((await getDeliverySink(db, sink.id, "workspace-a"))?.configurationDigest)
        .toBe(sink.configurationDigest);
      expect((await getDeliverySink(db, sink.id, "workspace-b"))?.configurationDigest)
        .toBe(`sha256:${"b".repeat(64)}`);
    } finally {
      await close();
    }
  });

  it("leases exclusively in event order and reclaims only after expiry", async () => {
    const { db, close, clock } = await freshDb();
    try {
      await ensureDeliverySink(db, sink, { clock });
      const firstTask = await createTask(db, { title: "first" }, { clock });
      clock.advance(1);
      const secondTask = await createTask(db, { title: "second" }, { clock });

      const first = await leaseNextDelivery(db, sink.id, {
        leaseOwner: "worker-a",
        leaseMs: 100,
        clock,
      });
      expect(first?.event.entityId).toBe(firstTask.id);
      expect(first?.delivery.attemptCount).toBe(1);
      expect(await leaseNextDelivery(db, sink.id, {
        leaseOwner: "worker-b",
        leaseMs: 100,
        clock,
      })).toBeNull();

      clock.advance(100);
      const reclaimed = await leaseNextDelivery(db, sink.id, {
        leaseOwner: "worker-b",
        leaseMs: 100,
        clock,
      });
      expect(reclaimed?.delivery.id).toBe(first?.delivery.id);
      expect(reclaimed?.delivery.attemptCount).toBe(2);
      await expect(completeDelivery(db, reclaimed!.delivery.id, {
        leaseOwner: "worker-a",
        clock,
      })).rejects.toThrow(/no longer owned/);
      await completeDelivery(db, reclaimed!.delivery.id, {
        leaseOwner: "worker-b",
        clock,
      });

      const second = await leaseNextDelivery(db, sink.id, {
        leaseOwner: "worker-b",
        leaseMs: 100,
        clock,
      });
      expect(second?.event.entityId).toBe(secondTask.id);
    } finally {
      await close();
    }
  });

  it("keeps delivery bookkeeping outside the CLI domain-commit retry guard", async () => {
    const { db, close, clock } = await freshDb();
    try {
      await ensureDeliverySink(db, sink, { clock });
      await createTask(db, { title: "domain commit" }, { clock });
      const afterDomainCommit = committedMutationCount();
      const leased = await leaseNextDelivery(db, sink.id, {
        leaseOwner: "delivery-worker",
        leaseMs: 100,
        clock,
      });
      await completeDelivery(db, leased!.delivery.id, {
        leaseOwner: "delivery-worker",
        clock,
      });
      expect(committedMutationCount()).toBe(afterDomainCommit);
    } finally {
      await close();
    }
  });

  it("backs off deterministically, quarantines poison and requires explicit repair", async () => {
    const { db, close, clock } = await freshDb();
    try {
      await ensureDeliverySink(db, sink, { clock });
      await createTask(db, { title: "poison" }, { clock });
      const first = await leaseNextDelivery(db, sink.id, {
        leaseOwner: "worker",
        leaseMs: 100,
        clock,
      });
      const retrying = await failDelivery(db, first!.delivery.id, {
        leaseOwner: "worker",
        error: "provider unavailable",
        maxAttempts: 2,
        baseBackoffMs: 10,
        maxBackoffMs: 100,
        clock,
      });
      expect(retrying).toMatchObject({
        status: "pending",
        attemptCount: 1,
        availableAt: 1_900_000_000_010,
        lastError: "provider unavailable",
      });
      expect(await leaseNextDelivery(db, sink.id, {
        leaseOwner: "worker",
        leaseMs: 100,
        clock,
      })).toBeNull();

      clock.advance(10);
      const second = await leaseNextDelivery(db, sink.id, {
        leaseOwner: "worker",
        leaseMs: 100,
        clock,
      });
      const quarantined = await failDelivery(db, second!.delivery.id, {
        leaseOwner: "worker",
        error: "invalid downstream record",
        maxAttempts: 2,
        baseBackoffMs: 10,
        maxBackoffMs: 100,
        clock,
      });
      expect(quarantined).toMatchObject({
        status: "quarantined",
        attemptCount: 2,
        quarantinedAt: 1_900_000_000_010,
      });
      expect(await leaseNextDelivery(db, sink.id, {
        leaseOwner: "other",
        leaseMs: 100,
        clock,
      })).toBeNull();

      clock.advance(1);
      const repaired = await repairDelivery(db, quarantined.id, "retry", { clock });
      expect(repaired).toMatchObject({
        status: "pending",
        attemptCount: 0,
        availableAt: 1_900_000_000_011,
        lastError: null,
        quarantinedAt: null,
      });
      expect((await leaseNextDelivery(db, sink.id, {
        leaseOwner: "other",
        leaseMs: 100,
        clock,
      }))?.delivery.attemptCount).toBe(1);
      await expect(repairDelivery(
        db,
        quarantined.id,
        "skip" as "retry",
        { clock },
      )).rejects.toThrow(/Unknown delivery repair action/);
    } finally {
      await close();
    }
  });
});

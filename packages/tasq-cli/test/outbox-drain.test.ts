import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMutableClock } from "@tasq/schema";
import {
  createTask,
  ensureDeliverySink,
  leaseNextDelivery,
  listDeliveryOutbox,
  openDb,
  repairDelivery,
  runMigrations,
} from "@tasq-internal/local-service";
import { appendJournalEvent, checkpointJournal } from "../src/journal.js";
import { drainEventJournal } from "../src/runtime.js";

const tmpDirs: string[] = [];

afterEach(() => {
  while (tmpDirs.length > 0) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), "tasq-outbox-drain-"));
  tmpDirs.push(dir);
  const handle = await openDb({ url: `file:${join(dir, "db.sqlite")}`, wal: false });
  const clock = createMutableClock(1_920_000_000_000);
  await runMigrations(handle.client, { clock });
  const sink = {
    id: "test:journal",
    kind: "urn:tasq:sink:event-journal:v1",
    configurationDigest: `sha256:${"d".repeat(64)}`,
  };
  await ensureDeliverySink(handle.db, sink, { clock });
  return {
    ...handle,
    clock,
    sink,
    path: join(dir, "events.jsonl"),
  };
}

describe("event journal outbox drain", () => {
  it("deduplicates append-before-ack recovery and completes the reclaimed lease", async () => {
    const { db, close, clock, sink, path } = await setup();
    try {
      await createTask(db, { title: "crash after append" }, { clock });
      const crashed = await leaseNextDelivery(db, sink.id, {
        leaseOwner: "crashed-worker",
        leaseMs: 100,
        clock,
      });
      expect(appendJournalEvent(path, crashed!.event, clock)).toBe("appended");
      expect(appendJournalEvent(path, crashed!.event, clock)).toBe("already_present");

      clock.advance(100);
      const report = await drainEventJournal(db, {
        path,
        sinkId: sink.id,
        tenantId: "gwendall",
      }, clock, {
        leaseOwner: "replacement-worker",
        leaseMs: 100,
      });
      expect(report).toMatchObject({
        delivered: 0,
        alreadyPresent: 1,
        failed: 0,
      });
      expect(readFileSync(path, "utf8").trim().split("\n")).toHaveLength(1);
      expect((await listDeliveryOutbox(db, { sinkId: sink.id }))[0]?.status)
        .toBe("delivered");
    } finally {
      await close();
    }
  });

  it("quarantines a malformed sink and resumes only after explicit repair", async () => {
    const { db, close, clock, sink, path } = await setup();
    try {
      await createTask(db, { title: "poison journal" }, { clock });
      writeFileSync(path, "not-json\n", { mode: 0o600 });
      const failed = await drainEventJournal(db, {
        path,
        sinkId: sink.id,
        tenantId: "gwendall",
      }, clock, {
        leaseOwner: "worker",
        maxAttempts: 1,
      });
      expect(failed).toMatchObject({ failed: 1, quarantined: 1 });
      const quarantined = (await listDeliveryOutbox(db, { sinkId: sink.id }))[0]!;
      expect(quarantined.status).toBe("quarantined");
      expect(quarantined.lastError).toMatch(/malformed JSON/);

      writeFileSync(path, "", { mode: 0o600 });
      clock.advance(1);
      await repairDelivery(db, quarantined.id, "retry", { clock });
      const recovered = await drainEventJournal(db, {
        path,
        sinkId: sink.id,
        tenantId: "gwendall",
      }, clock, { leaseOwner: "repair-worker" });
      expect(recovered).toMatchObject({ delivered: 1, failed: 0, quarantined: 0 });
      expect((await listDeliveryOutbox(db, { sinkId: sink.id }))[0]?.status)
        .toBe("delivered");
    } finally {
      await close();
    }
  });

  it("refuses to acknowledge coverage from a checkpoint that mismatches SQLite", async () => {
    const { db, close, clock, sink, path } = await setup();
    try {
      await createTask(db, { title: "must remain externally visible" }, { clock });
      checkpointJournal({
        path,
        tenantId: "gwendall",
        databaseCursor: 1,
        databaseEventId: "01900000-0000-7000-8000-000000000000",
        actor: "test-operator",
        reason: "simulate forged coverage boundary",
        clock,
      });

      const report = await drainEventJournal(db, {
        path,
        sinkId: sink.id,
        tenantId: "gwendall",
      }, clock, {
        leaseOwner: "checkpoint-worker",
        maxAttempts: 1,
      });
      expect(report).toEqual({
        delivered: 0,
        alreadyPresent: 0,
        coveredByCheckpoint: 0,
        failed: 1,
        quarantined: 1,
      });
      expect((await listDeliveryOutbox(db, { sinkId: sink.id }))[0]).toMatchObject({
        status: "quarantined",
        lastError: "Journal checkpoint identity does not match database cursor 1",
      });
    } finally {
      await close();
    }
  });
});
